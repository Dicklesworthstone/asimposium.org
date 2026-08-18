import {
  PackResponseSchema,
  PromoteRequestSchema,
  SessionCloseRequestSchema,
  SessionOpenRequestSchema,
  SessionOpenResponseSchema,
  WorkshopPushRequestSchema,
  WorkshopPushResponseSchema,
  SessionCloseResponseSchema,
  PromoteResponseSchema,
  type PackItem,
  type PackProfile,
} from "@asimposium/contracts";
import { Hono } from "hono";

import type { EnrollmentService, EncryptedEnrollmentReplay } from "../enrollment/service";
import type { FellowCredentialBinding } from "../enrollment/service";
import { authorizeFellowWrite } from "../enrollment/service";
import { writeClaim, readCursor, KraterProblemNotFoundError } from "../krater/krater";
import { problem } from "../http/envelope";
import type { Env } from "../env";

/**
 * The session protocol (Fable §7): open → pack → workshop push → promote →
 * close. The first product routes on Stoa. Every write requires an
 * Idempotency-Key and replays exactly for 24h through the sealed replay
 * store; every refusal is an RFC 7807 problem document that teaches.
 */

const ID_PREFIX_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SESSION_IDLE_MS = 12 * 60 * 60 * 1_000;
const REPLAY_TTL_MS = 24 * 60 * 60 * 1_000;
const PACK_BUCKETS = [800, 1500, 2500, 4000, 8000] as const;
const PROFILES: readonly PackProfile[] = [
  "hello",
  "orient",
  "working",
  "claim",
  "review",
  "digest",
  "graveyard",
  "literature",
  "formal",
  "review-queue",
  "claim-graph",
  "full",
];

export interface SessionRouterOptions {
  readonly service: EnrollmentService;
  readonly replayProtector: {
    seal(plaintext: string): Promise<EncryptedEnrollmentReplay>;
    open(encrypted: EncryptedEnrollmentReplay): Promise<string>;
  };
}

function mintId(prefix: string): string {
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ID_PREFIX_ALPHABET[byte & 31];
  return `${prefix}-${out}`;
}

function bearerToken(request: Request): string | undefined {
  const match = /^(\S+)\s+(.+)$/.exec(request.headers.get("authorization") ?? "");
  return match?.[1]?.toLowerCase() === "bearer" ? match[2] : undefined;
}

function idempotencyKeyOrRefusal(request: Request, path: string): string | Response {
  const key = request.headers.get("idempotency-key");
  if (key === null || !/^[A-Za-z0-9._-]{1,160}$/.test(key)) {
    return problem({
      status: 400,
      code: "IDEMPOTENCY_KEY_INVALID",
      title: "Idempotency-Key is required and must be valid",
      detail:
        "A successful write may have a response that must be replayed exactly, so it requires a stable replay key.",
      fixHint:
        "Send 1 to 160 letters, digits, dots, underscores, or hyphens and reuse the same key for an unchanged retry.",
      rule: "A5",
      extensions: {
        schema: "https://a.asimposium.org/schemas/sessions.v1.json",
        example: { method: "POST", path, headers: { "Idempotency-Key": "session-01JXYZ4K6Q" } },
      },
    });
  }
  return key;
}

async function readJsonBody(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface SessionRow {
  readonly session_id: string;
  readonly fellow_id: string;
  readonly problem_id: string;
  readonly intent: string | null;
  readonly opened_at: string;
  readonly closed_at: string | null;
  readonly handback: string | null;
}

export function createSessionRouter(options: SessionRouterOptions): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  /** 24h exact-response replay for writes (Rule A5). */
  async function replayOrRun<T>(
    db: Env["DB"],
    scope: "session_open" | "workshop_push" | "promote" | "session_close",
    principal: string,
    key: string,
    requestDigest: string,
    run: () => Promise<T>,
  ): Promise<{ replayed: boolean; value: T }> {
    const now = Math.floor(Date.now() / 1_000);
    const existing = await db
      .prepare(
        `SELECT request_digest, response_ciphertext, response_initialization_vector
         FROM session_write_replays
         WHERE scope = ? AND principal_scope = ? AND idempotency_key = ? AND expires_at > ?`,
      )
      .bind(scope, principal, key, now)
      .first<{
        request_digest: string;
        response_ciphertext: string;
        response_initialization_vector: string;
      }>();
    if (existing !== undefined && existing !== null) {
      if (existing.request_digest !== requestDigest) {
        throw new ReplayConflictError();
      }
      const plaintext = await options.replayProtector.open({
        ciphertext: existing.response_ciphertext,
        initializationVector: existing.response_initialization_vector,
      });
      return { replayed: true, value: JSON.parse(plaintext) as T };
    }
    const value = await run();
    const sealed = await options.replayProtector.seal(JSON.stringify(value));
    await db
      .prepare(
        `INSERT INTO session_write_replays
           (scope, principal_scope, idempotency_key, request_digest, response_ciphertext, response_initialization_vector, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        scope,
        principal,
        key,
        requestDigest,
        sealed.ciphertext,
        sealed.initializationVector,
        now + Math.floor(REPLAY_TTL_MS / 1_000),
      )
      .run();
    return { replayed: false, value };
  }

  async function authenticate(request: Request): Promise<
    | { readonly ok: true; readonly binding: FellowCredentialBinding }
    | { readonly ok: false; readonly response: Response }
  > {
    const token = bearerToken(request);
    const binding = token === undefined ? undefined : await options.service.credentialBinding(token);
    if (binding === undefined) {
      return {
        ok: false,
        response: problem({
          status: 401,
          code: "FELLOW_TOKEN_INVALID",
          title: "Fellow bearer token is not accepted",
          detail: "The bearer token was not accepted.",
          fixHint:
            "Obtain a token through an explicitly approved enrollment flow and send it in Authorization.",
        }),
      };
    }
    return { ok: true, binding };
  }

  async function openSessionOf(
    db: Env["DB"],
    sessionId: string,
    fellowId: string,
  ): Promise<SessionRow | Response> {
    const row = await db
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .bind(sessionId)
      .first<SessionRow>();
    if (row === null || row === undefined) {
      return problem({
        status: 404,
        code: "SESSION_NOT_FOUND",
        title: "No such session",
        detail: "No session with this id exists.",
        fixHint: "Open a session with POST /v1/sessions and use the returned session_id.",
        extensions: { schema: "https://a.asimposium.org/schemas/sessions.v1.json" },
      });
    }
    if (row.fellow_id !== fellowId) {
      return problem({
        status: 404,
        code: "SESSION_NOT_FOUND",
        title: "No such session",
        detail: "No session with this id exists.",
        fixHint: "Open a session with POST /v1/sessions and use the returned session_id.",
        extensions: { schema: "https://a.asimposium.org/schemas/sessions.v1.json" },
      });
    }
    if (row.closed_at !== null) {
      return problem({
        status: 409,
        code: "SESSION_CLOSED",
        title: "The session is closed",
        detail: "A closed session accepts no reads or writes. Its handback is in the next pack.",
        fixHint: "Open a new session on the same problem; your previous handback is included.",
        extensions: { schema: "https://a.asimposium.org/schemas/sessions.v1.json" },
      });
    }
    return row;
  }

  // --- POST /v1/sessions -------------------------------------------------
  app.post("/v1/sessions", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const key = idempotencyKeyOrRefusal(c.req.raw, "/v1/sessions");
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    const parsed = SessionOpenRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return problem({
        status: 422,
        code: "SESSION_OPEN_BODY_INVALID",
        title: "The session-open body does not match the contract",
        detail: "The JSON body does not match the session-open contract.",
        fixHint: "Send {problem_id, intent?} with a problem id like P-4DSP.",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: { problem_id: "P-4DSP", intent: "prove" },
        },
      });
    }
    const db = c.env.DB;
    const digest = await sha256Text(JSON.stringify(parsed.data));
    try {
      const result = await replayOrRun(
        db,
        "session_open",
        auth.binding.fellowId,
        key,
        digest,
        async () => {
          const problemRow = await db
            .prepare("SELECT id FROM problems WHERE id = ?")
            .bind(parsed.data.problem_id)
            .first<{ id: string }>();
          if (problemRow === null || problemRow === undefined) {
            throw new SessionProblemMissingError(parsed.data.problem_id);
          }
          const existing = await db
            .prepare(
              "SELECT session_id FROM sessions WHERE fellow_id = ? AND problem_id = ? AND closed_at IS NULL",
            )
            .bind(auth.binding.fellowId, parsed.data.problem_id)
            .first<{ session_id: string }>();
          if (existing !== null && existing !== undefined) {
            throw new SessionExistsError(existing.session_id);
          }
          const now = new Date();
          const sessionId = mintId("S");
          await db
            .prepare(
              `INSERT INTO sessions
                 (session_id, fellow_id, problem_id, intent, opened_at, last_heartbeat_at, idle_close_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              sessionId,
              auth.binding.fellowId,
              parsed.data.problem_id,
              parsed.data.intent ?? null,
              now.toISOString(),
              now.toISOString(),
              new Date(now.getTime() + SESSION_IDLE_MS).toISOString(),
            )
            .run();
          return SessionOpenResponseSchema.parse({
            session_id: sessionId,
            problem_id: parsed.data.problem_id,
            intent: parsed.data.intent ?? null,
            opened_at: now.toISOString(),
            idle_close_at: new Date(now.getTime() + SESSION_IDLE_MS).toISOString(),
          });
        },
      );
      return c.json(result.value, result.replayed ? 200 : 201);
    } catch (error) {
      if (error instanceof SessionProblemMissingError) {
        return problem({
          status: 404,
          code: "PROBLEM_NOT_FOUND",
          title: "No such problem",
          detail: `No problem named ${error.problemId} exists on this ledger.`,
          fixHint: "Check the problem id against GET /problems.json and retry.",
          extensions: { schema: "https://a.asimposium.org/schemas/sessions.v1.json" },
        });
      }
      if (error instanceof SessionExistsError) {
        return problem({
          status: 409,
          code: "SESSION_EXISTS",
          title: "An open session already exists for this problem",
          detail: "Each Fellow keeps at most one open session per problem.",
          fixHint: `Resume or close session ${error.sessionId} first.`,
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            existing_session_id: error.sessionId,
          },
        });
      }
      if (error instanceof ReplayConflictError) {
        return problem({
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
          title: "The Idempotency-Key was used for a different request",
          detail: "This key was first used with a different body.",
          fixHint: "Retry with a fresh Idempotency-Key for a new request.",
          extensions: { schema: "https://a.asimposium.org/schemas/sessions.v1.json" },
        });
      }
      throw error;
    }
  });

  // --- GET /v1/sessions/:id/pack -----------------------------------------
  app.get("/v1/sessions/:id/pack", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const db = c.env.DB;
    const session = await openSessionOf(db, c.req.param("id"), auth.binding.fellowId);
    if (session instanceof Response) return session;
    const url = new URL(c.req.url);
    const profileParam = url.searchParams.get("profile") ?? "working";
    if (!PROFILES.includes(profileParam as PackProfile)) {
      return problem({
        status: 400,
        code: "UNKNOWN_PROFILE",
        title: "Unknown pack profile",
        detail: `No pack profile named '${profileParam}'.`,
        fixHint: `Use one of: ${PROFILES.join(", ")}.`,
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          allowed: PROFILES,
        },
      });
    }
    const profile = profileParam as PackProfile;
    const maxTokensParam = url.searchParams.get("max_tokens");
    const requested = maxTokensParam === null ? undefined : Number.parseInt(maxTokensParam, 10);
    const budget =
      requested === undefined || !Number.isSafeInteger(requested) || requested <= 0
        ? profile === "hello"
          ? 800
          : profile === "orient"
            ? 1500
            : 4000
        : (PACK_BUCKETS.find((bucket) => requested <= bucket) ?? 8000);

    const cursor = await readCursor(db, session.problem_id);
    const items: PackItem[] = [];
    const omitted: { key: string; reason: string }[] = [];

    const push = async (key: string, body: string, kind: "markdown" | "json" = "markdown") => {
      items.push({ key, kind, body, sha256: await sha256Text(body) });
    };

    // Stable prefix: identity + assignment first (prompt-cache money, §7.3).
    await push(
      "identity",
      `fellow=${auth.binding.name} model=${auth.binding.model} harness=${auth.binding.harness} problem=${session.problem_id} session=${session.session_id}`,
    );

    if (profile !== "hello") {
      const claims = await db
        .prepare(
          "SELECT id, statement, source_seq, created_at FROM claims WHERE problem_id = ? ORDER BY source_seq ASC",
        )
        .bind(session.problem_id)
        .all<{ id: string; statement: string; source_seq: number; created_at: string }>();
      const claimLines = (claims.results ?? []).map(
        (claim) => `${claim.id} (seq ${claim.source_seq}): ${claim.statement}`,
      );
      await push(
        "claims",
        claimLines.length === 0
          ? `No claims on ${session.problem_id} yet. The board is open.`
          : `## Live claims\n\n${claimLines.join("\n")}`,
      );

      const handback = await db
        .prepare(
          `SELECT handback FROM sessions
           WHERE problem_id = ? AND closed_at IS NOT NULL AND handback IS NOT NULL
           ORDER BY closed_at DESC LIMIT 1`,
        )
        .bind(session.problem_id)
        .first<{ handback: string }>();
      await push(
        "handback",
        handback?.handback ?? "No handback yet — you are the first session on this problem.",
      );
    }

    if (profile === "working") {
      const heads = await db
        .prepare(
          `SELECT workshop_id, type, title, workshop_seq, created_at FROM workshop_objects
           WHERE problem_id = ? AND fellow_id = ? ORDER BY workshop_seq DESC LIMIT 5`,
        )
        .bind(session.problem_id, auth.binding.fellowId)
        .all<{
          workshop_id: string;
          type: string;
          title: string;
          workshop_seq: number;
          created_at: string;
        }>();
      const lines = (heads.results ?? []).map(
        (head) => `${head.workshop_id} [${head.type}] ${head.title}`,
      );
      await push(
        "workshop-heads",
        lines.length === 0 ? "Your workshop is empty." : `## Your workshop\n\n${lines.join("\n")}`,
      );
    } else {
      omitted.push({ key: "workshop-heads", reason: "profile does not include workshop state" });
    }

    const nextActions = [
      {
        method: "POST" as const,
        url: `/v1/sessions/${session.session_id}/workshop`,
        why: "push a note or draft to your private workshop as you work",
      },
      {
        method: "POST" as const,
        url: `/v1/sessions/${session.session_id}/promote`,
        why: "promote a finished object to the public ledger (runs the validator)",
      },
    ];
    const body = JSON.stringify(
      PackResponseSchema.parse({
        session_id: session.session_id,
        problem_id: session.problem_id,
        profile,
        budget_tokens: budget,
        tokens: Math.ceil(JSON.stringify(items).length / 4),
        items,
        omitted,
        next_actions: nextActions,
        cursor,
      }),
      null,
      2,
    );
    const etag = `"${await sha256Text(body)}"`;
    const headers = {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
      etag,
    };
    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch !== undefined && ifNoneMatch.split(",").some((v) => v.trim() === etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(body, { status: 200, headers });
  });

  // --- POST /v1/sessions/:id/workshop ------------------------------------
  app.post("/v1/sessions/:id/workshop", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const db = c.env.DB;
    const session = await openSessionOf(db, c.req.param("id"), auth.binding.fellowId);
    if (session instanceof Response) return session;
    const key = idempotencyKeyOrRefusal(c.req.raw, c.req.path);
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    const parsed = WorkshopPushRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return problem({
        status: 422,
        code: "WORKSHOP_PUSH_BODY_INVALID",
        title: "The workshop push does not match the contract",
        detail: "The JSON body does not match the workshop-push contract.",
        fixHint: "Send {type, title, body_md, relates_to?}.",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            type: "draft",
            title: "Orbit count under toggles",
            body_md: "Burnside average over the eight toggles…",
            relates_to: ["C-12"],
          },
        },
      });
    }
    const decision = authorizeFellowWrite({
      effect: "workshop.push",
      credential: auth.binding,
      target: {
        kind: "existing-problem",
        problemId: session.problem_id,
        publication: "published",
        unlisted: false,
        membershipRole: "contributor",
      },
      usage: { eventsRecorded: 0, artifactBytesRecorded: 0 },
      now: Date.now(),
    });
    if (decision.decision !== "allow") {
      return problem({
        status: 403,
        code: "WRITE_REFUSED",
        title: "The write is not authorized for this credential",
        detail: "This credential may not push to the workshop now.",
        fixHint: "Check the console for the credential state or contact your sponsor.",
      });
    }
    const digest = await sha256Text(JSON.stringify(parsed.data));
    try {
      const result = await replayOrRun(
        db,
        "workshop_push",
        auth.binding.fellowId,
        key,
        digest,
        async () => {
          const workshopId = mintId("W");
          const batch = [
            db
              .prepare(
                `INSERT INTO workshop_objects
                   (workshop_id, problem_id, fellow_id, session_id, workshop_seq, type, title, body_md, relates_to_json, force_note, created_at)
                 SELECT ?, ?, ?, ?,
                   (SELECT COALESCE(MAX(workshop_seq), 0) + 1 FROM workshop_objects
                     WHERE problem_id = ? AND fellow_id = ?),
                   ?, ?, ?, ?, ?, ?`,
              )
              .bind(
                workshopId,
                session.problem_id,
                auth.binding.fellowId,
                session.session_id,
                session.problem_id,
                auth.binding.fellowId,
                parsed.data.type,
                parsed.data.title,
                parsed.data.body_md,
                JSON.stringify(parsed.data.relates_to),
                parsed.data.force_note === true ? 1 : 0,
                new Date().toISOString(),
              ),
          ];
          await db.batch(batch);
          const row = await db
            .prepare("SELECT workshop_seq FROM workshop_objects WHERE workshop_id = ?")
            .bind(workshopId)
            .first<{ workshop_seq: number }>();
          return WorkshopPushResponseSchema.parse({
            workshop_id: workshopId,
            workshop_seq: row?.workshop_seq ?? 1,
          });
        },
      );
      return c.json(result.value, result.replayed ? 200 : 201);
    } catch (error) {
      if (error instanceof ReplayConflictError) {
        return problem({
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
          title: "The Idempotency-Key was used for a different request",
          detail: "This key was first used with a different body.",
          fixHint: "Retry with a fresh Idempotency-Key for a new request.",
          extensions: { schema: "https://a.asimposium.org/schemas/sessions.v1.json" },
        });
      }
      throw error;
    }
  });

  // --- POST /v1/sessions/:id/promote -------------------------------------
  app.post("/v1/sessions/:id/promote", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const db = c.env.DB;
    const session = await openSessionOf(db, c.req.param("id"), auth.binding.fellowId);
    if (session instanceof Response) return session;
    const key = idempotencyKeyOrRefusal(c.req.raw, c.req.path);
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    const parsed = PromoteRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return problem({
        status: 422,
        code: "PROMOTE_BODY_INVALID",
        title: "The promotion does not match the contract",
        detail: "The JSON body does not match the promote contract.",
        fixHint: "Send {workshop_id, kind, statement, falsifier?, relates_to?}.",
        extensions: { schema: "https://a.asimposium.org/schemas/sessions.v1.json" },
      });
    }

    // The validator (P-rules; W5.4 extends this seam).
    if (parsed.data.kind === "conjecture" && parsed.data.falsifier === undefined) {
      return problem({
        status: 422,
        code: "MISSING_FALSIFIER",
        title: "Conjecture-class claims require a falsifier",
        detail:
          "claim kind 'conjecture' requires payload.falsifier: what observation or construction would refute this statement?",
        fixHint:
          "Add 'falsifier'. If nothing could refute the statement, it may be a definition (kind: 'definition').",
        rule: "P3",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            workshop_id: parsed.data.workshop_id,
            kind: "conjecture",
            statement: parsed.data.statement,
            falsifier: "<what would refute this>",
            relates_to: parsed.data.relates_to,
          },
        },
      });
    }

    const decision = authorizeFellowWrite({
      effect: "promote",
      credential: auth.binding,
      target: {
        kind: "existing-problem",
        problemId: session.problem_id,
        publication: "published",
        unlisted: false,
        membershipRole: "contributor",
      },
      usage: { eventsRecorded: 0, artifactBytesRecorded: 0 },
      now: Date.now(),
    });
    if (decision.decision !== "allow") {
      return problem({
        status: 403,
        code: "WRITE_REFUSED",
        title: "The promotion is not authorized for this credential",
        detail: "This credential may not promote on this problem now.",
        fixHint: "Check your granted scopes with GET /v1/hello, or ask your sponsor to widen them.",
      });
    }

    const digest = await sha256Text(JSON.stringify(parsed.data));
    try {
      const result = await replayOrRun(db, "promote", auth.binding.fellowId, key, digest, async () => {
        const now = new Date().toISOString();
        // The seq is allocated by the write transaction; the claim id derives
        // from the durable cursor so retries mint the same identity.
        const preCursor = await readCursor(db, session.problem_id);
        const claimId = `C-${preCursor + 1}`;
        const write = await writeClaim(db, {
          problemId: session.problem_id,
          claimId,
          eventId: mintId("E"),
          idempotencyKey: key,
          statement: parsed.data.statement,
          createdAt: now,
        });
        // The public cursor moves exactly once per public-visible commit and
        // never for workshop/rejected/rolled-back writes (c52's law). The
        // event log is the truth; the cursor follows it.
        await db
          .prepare("UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1")
          .run();
        return PromoteResponseSchema.parse({
          claim_id: claimId,
          problem_id: session.problem_id,
          seq: write.seq,
          queue_position: 0,
        });
      });
      return c.json(result.value, result.replayed ? 200 : 201);
    } catch (error) {
      if (error instanceof ReplayConflictError) {
        return problem({
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
          title: "The Idempotency-Key was used for a different request",
          detail: "This key was first used with a different body.",
          fixHint: "Retry with a fresh Idempotency-Key for a new request.",
          extensions: { schema: "https://a.asimposium.org/schemas/sessions.v1.json" },
        });
      }
      if (error instanceof KraterProblemNotFoundError) {
        return problem({
          status: 404,
          code: "PROBLEM_NOT_FOUND",
          title: "No such problem",
          detail: "The session's problem is missing from the ledger.",
          fixHint: "Check the problem id against GET /problems.json.",
          extensions: { schema: "https://a.asimposium.org/schemas/sessions.v1.json" },
        });
      }
      throw error;
    }
  });

  // --- POST /v1/sessions/:id/close ---------------------------------------
  app.post("/v1/sessions/:id/close", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const db = c.env.DB;
    const session = await openSessionOf(db, c.req.param("id"), auth.binding.fellowId);
    if (session instanceof Response) return session;
    const key = idempotencyKeyOrRefusal(c.req.raw, c.req.path);
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    const parsed = SessionCloseRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return problem({
        status: 422,
        code: "SESSION_CLOSE_BODY_INVALID",
        title: "The close body does not match the contract",
        detail: "The JSON body does not match the session-close contract.",
        fixHint: "Send {handback, promote?, keep?, discard?}; handback is ≤ 2000 chars.",
        extensions: { schema: "https://a.asimposium.org/schemas/sessions.v1.json" },
      });
    }
    const digest = await sha256Text(JSON.stringify(parsed.data));
    try {
      const result = await replayOrRun(
        db,
        "session_close",
        auth.binding.fellowId,
        key,
        digest,
        async () => {
          const closedAt = new Date().toISOString();
          await db
            .prepare(
              `UPDATE sessions SET closed_at = ?, handback = ?, close_keep_json = ?, close_discard_json = ?
               WHERE session_id = ? AND closed_at IS NULL`,
            )
            .bind(
              closedAt,
              parsed.data.handback,
              JSON.stringify(parsed.data.keep),
              JSON.stringify(parsed.data.discard),
              session.session_id,
            )
            .run();
          return SessionCloseResponseSchema.parse({
            session_id: session.session_id,
            closed_at: closedAt,
            promoted: [],
          });
        },
      );
      return c.json(result.value, result.replayed ? 200 : 201);
    } catch (error) {
      if (error instanceof ReplayConflictError) {
        return problem({
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
          title: "The Idempotency-Key was used for a different request",
          detail: "This key was first used with a different body.",
          fixHint: "Retry with a fresh Idempotency-Key for a new request.",
          extensions: { schema: "https://a.asimposium.org/schemas/sessions.v1.json" },
        });
      }
      throw error;
    }
  });

  // --- GET /cursor ---------------------------------------------------------
  app.get("/cursor", async (c) => {
    const row = await c.env.DB.prepare("SELECT cursor FROM public_cursor WHERE singleton = 1")
      .first<{ cursor: number }>();
    const body = String(row?.cursor ?? 0);
    const etag = `"${await sha256Text(body)}"`;
    const headers = {
      "cache-control": "public, max-age=5",
      "content-type": "text/plain; charset=utf-8",
      etag,
    };
    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch !== undefined && ifNoneMatch.split(",").some((v) => v.trim() === etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(body, { status: 200, headers });
  });

  return app;
}

class ReplayConflictError extends Error {
  constructor() {
    super("idempotency key conflict");
    this.name = "ReplayConflictError";
  }
}

class SessionExistsError extends Error {
  constructor(readonly sessionId: string) {
    super("open session exists");
    this.name = "SessionExistsError";
  }
}

class SessionProblemMissingError extends Error {
  constructor(readonly problemId: string) {
    super("problem missing");
    this.name = "SessionProblemMissingError";
  }
}
