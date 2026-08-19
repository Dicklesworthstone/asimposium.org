import {
  type PackProfile,
  PackResponseSchema,
  PromoteRequestSchema,
  PromoteResponseSchema,
  SessionCloseRequestSchema,
  SessionCloseResponseSchema,
  SessionOpenRequestSchema,
  SessionOpenResponseSchema,
  SponsorWorkshopRequestSchema,
  SponsorWorkshopViewSchema,
  WorkshopPushRequestSchema,
  WorkshopPushResponseSchema,
} from "@asimposium/contracts";
import {
  composedPackToProjection,
  composePack,
  PACK_BUDGET_BUCKETS,
  type PackCandidate,
  renderProjection,
} from "@asimposium/render";
import { Hono } from "hono";
import { readBoundedRequestBody } from "../auth/http";
import type {
  EncryptedEnrollmentReplay,
  EnrollmentService,
  FellowCredentialBinding,
} from "../enrollment/service";
import { authorizeFellowWrite } from "../enrollment/service";
import type { Env } from "../env";
import { problem, validatedProblem } from "../http/envelope";
import { KraterProblemNotFoundError, readCursor, writeClaim } from "../krater/krater";
import { duplicateClaimRefusal, normHash, rejectAuthoritativeFields } from "../split/policy";

/**
 * The session protocol (Fable §7): open → pack → workshop push → promote →
 * close. The first product routes on Stoa. Every write requires an
 * Idempotency-Key and replays exactly for 24h through the sealed replay
 * store; every refusal is an RFC 7807 problem document that teaches.
 */

const ID_PREFIX_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SESSION_IDLE_MS = 12 * 60 * 60 * 1_000;
const REPLAY_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_SESSION_REQUEST_BODY_BYTES = 512 * 1024;
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
const DEFAULT_PACK_TOKENS: Readonly<Record<PackProfile, number>> = {
  hello: 400,
  orient: 1500,
  working: 4000,
  claim: 2500,
  review: 2500,
  digest: 800,
  graveyard: 2000,
  literature: 2000,
  formal: 2000,
  "review-queue": 1500,
  "claim-graph": 2000,
  full: 8000,
};
/** One extra row distinguishes a complete candidate set from a bounded prefix. */
const PACK_CLAIM_CANDIDATE_LIMIT = 128;

export interface SessionRouterOptions {
  readonly service: EnrollmentService;
  readonly replayProtector: {
    seal(plaintext: string): Promise<EncryptedEnrollmentReplay>;
    open(encrypted: EncryptedEnrollmentReplay): Promise<string>;
  };
  /** The same signed-envelope sponsor seam the enrollment router uses. */
  readonly verifiedSponsor?: (
    request: Request,
    route: string,
    action: string,
  ) => Promise<
    | {
        readonly principal: { readonly type: "sponsor"; readonly sponsorId: string };
        readonly rawBody: Uint8Array;
      }
    | Response
  >;
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

const SESSION_BODY_TOO_LARGE = Symbol("session-body-too-large");

async function readJsonBody(
  request: Request,
): Promise<unknown | undefined | typeof SESSION_BODY_TOO_LARGE> {
  const body = await readBoundedRequestBody(request, MAX_SESSION_REQUEST_BODY_BYTES);
  if (!body.ok) return body.reason === "too-large" ? SESSION_BODY_TOO_LARGE : undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes));
  } catch {
    return undefined;
  }
}

function sessionBodyTooLargeProblem(): Response {
  return validatedProblem({
    status: 413,
    code: "REQUEST_BODY_TOO_LARGE",
    title: "The session request body is too large",
    detail: `Session write bodies are bounded at ${MAX_SESSION_REQUEST_BODY_BYTES} bytes.`,
    fixHint: "Send only the contracted fields and keep large artifacts in the artifact store.",
  });
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function writeRequestDigest(target: string, value: unknown): Promise<string> {
  const body = JSON.stringify(value);
  return sha256Text(`${target.length}:${target}${body.length}:${body}`);
}

function idempotencyConflictProblem(): Response {
  return problem({
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    title: "The Idempotency-Key was used for a different request",
    detail: "This key was first used with a different body or target resource.",
    fixHint: "Retry with a fresh Idempotency-Key for a new request.",
    extensions: { schema: "https://a.asimposium.org/schemas/sessions.v1.json" },
  });
}

function packBudgetOrRefusal(raw: string | null, profile: PackProfile): number | Response {
  if (raw === null) return DEFAULT_PACK_TOKENS[profile];
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return problem({
      status: 400,
      code: "INVALID_PACK_BUDGET",
      title: "The pack token budget is invalid",
      detail: "max_tokens must be a positive base-10 safe integer.",
      fixHint: `Request at most ${PACK_BUDGET_BUCKETS.at(-1)} tokens; the server rounds upward to a fixed cache bucket.`,
      extensions: {
        schema: "https://a.asimposium.org/schemas/sessions.v1.json",
        allowed_buckets: PACK_BUDGET_BUCKETS,
      },
    });
  }
  const requested = Number(raw);
  const maximum = PACK_BUDGET_BUCKETS.at(-1);
  if (!Number.isSafeInteger(requested) || maximum === undefined || requested > maximum) {
    return problem({
      status: 400,
      code: "INVALID_PACK_BUDGET",
      title: "The pack token budget is invalid",
      detail: `max_tokens must be no greater than ${maximum ?? 8000}.`,
      fixHint: `Use one of the fixed buckets directly, or request a positive value that rounds up to one: ${PACK_BUDGET_BUCKETS.join(", ")}.`,
      extensions: {
        schema: "https://a.asimposium.org/schemas/sessions.v1.json",
        allowed_buckets: PACK_BUDGET_BUCKETS,
      },
    });
  }
  return requested;
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

  type ReplayScope = "session_open" | "workshop_push" | "promote" | "session_close";

  type SessionPreparedStatement = ReturnType<Env["DB"]["prepare"]>;

  interface ReplayRecord {
    readonly plaintext: string;
    readonly claimToken: string | null;
  }

  interface ReplayMutation<T> {
    readonly value: T;
    readonly statements: (
      sealed: EncryptedEnrollmentReplay,
      claimToken: string,
    ) => readonly SessionPreparedStatement[];
  }

  async function readReplayRecord(
    db: Env["DB"],
    scope: ReplayScope,
    principal: string,
    key: string,
    requestDigest: string,
  ): Promise<ReplayRecord | undefined> {
    const existing = await db
      .prepare(
        `SELECT request_digest, response_ciphertext, response_initialization_vector, expires_at,
                claim_token
         FROM session_write_replays
         WHERE scope = ? AND principal_scope = ? AND idempotency_key = ?`,
      )
      .bind(scope, principal, key)
      .first<{
        request_digest: string;
        response_ciphertext: string;
        response_initialization_vector: string;
        expires_at: number;
        claim_token: string | null;
      }>();
    if (existing === undefined || existing === null) return undefined;
    const now = Math.floor(Date.now() / 1_000);
    if (existing.expires_at <= now) {
      // An expired row still owns the table's primary key. Remove exactly the
      // version we observed so the key can satisfy its documented 24h reuse
      // boundary without deleting a concurrently refreshed row.
      await db
        .prepare(
          `DELETE FROM session_write_replays
           WHERE scope = ? AND principal_scope = ? AND idempotency_key = ? AND expires_at = ?`,
        )
        .bind(scope, principal, key, existing.expires_at)
        .run();
      return undefined;
    }
    if (existing.request_digest !== requestDigest) throw new ReplayConflictError();
    return {
      plaintext: await options.replayProtector.open({
        ciphertext: existing.response_ciphertext,
        initializationVector: existing.response_initialization_vector,
      }),
      claimToken: existing.claim_token,
    };
  }

  async function replayResponseBeforeMutablePreconditions(
    db: Env["DB"],
    scope: ReplayScope,
    principal: string,
    key: string,
    requestDigest: string,
  ): Promise<Response | undefined> {
    const replay = await readReplayRecord(db, scope, principal, key, requestDigest);
    return replay === undefined
      ? undefined
      : new Response(replay.plaintext, {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
  }

  /**
   * 24h exact-response replay whose row also owns the mutation transaction.
   *
   * The first statement supplied by every caller inserts the replay row with
   * `claimToken`; every side effect is conditional on that exact token. D1's
   * batch is the transaction boundary. A same-key loser therefore decrypts
   * the winner's bytes but cannot execute a second mutation.
   */
  async function replayOrCommit<T>(
    db: Env["DB"],
    scope: ReplayScope,
    principal: string,
    key: string,
    requestDigest: string,
    prepare: (claimToken: string) => Promise<ReplayMutation<T>>,
    retryAfterRollback?: (error: unknown) => boolean,
  ): Promise<{ replayed: boolean; value: T }> {
    for (let attempt = 0; attempt <= 16; attempt += 1) {
      const existing = await readReplayRecord(db, scope, principal, key, requestDigest);
      if (existing !== undefined) {
        return { replayed: true, value: JSON.parse(existing.plaintext) as T };
      }
      const claimToken = mintId("R");
      const mutation = await prepare(claimToken);
      const sealed = await options.replayProtector.seal(JSON.stringify(mutation.value));
      try {
        await db.batch([...mutation.statements(sealed, claimToken)]);
      } catch (error) {
        const winner = await readReplayRecord(db, scope, principal, key, requestDigest);
        if (winner !== undefined) {
          return { replayed: true, value: JSON.parse(winner.plaintext) as T };
        }
        if (attempt < 16 && retryAfterRollback?.(error) === true) continue;
        throw error;
      }
      const settled = await readReplayRecord(db, scope, principal, key, requestDigest);
      if (settled === undefined) throw new ReplayClaimNotCommittedError();
      return {
        replayed: settled.claimToken !== claimToken,
        value: JSON.parse(settled.plaintext) as T,
      };
    }
    throw new Error("session replay retry budget exhausted");
  }

  async function authenticate(
    request: Request,
  ): Promise<
    | { readonly ok: true; readonly binding: FellowCredentialBinding }
    | { readonly ok: false; readonly response: Response }
  > {
    const token = bearerToken(request);
    const binding =
      token === undefined ? undefined : await options.service.credentialBinding(token);
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

  async function membershipRoleOf(
    db: Env["DB"],
    problemId: string,
    fellowId: string,
  ): Promise<"observer" | "contributor" | "steward" | undefined> {
    const row = await db
      .prepare("SELECT role FROM problem_memberships WHERE problem_id = ? AND fellow_id = ?")
      .bind(problemId, fellowId)
      .first<{ role: "observer" | "contributor" | "steward" }>();
    return row?.role;
  }

  // --- POST /v1/sessions -------------------------------------------------
  app.post("/v1/sessions", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const key = idempotencyKeyOrRefusal(c.req.raw, "/v1/sessions");
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    if (rawBody === SESSION_BODY_TOO_LARGE) return sessionBodyTooLargeProblem();
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
    const digest = await writeRequestDigest("POST /v1/sessions", parsed.data);
    try {
      const result = await replayOrCommit(
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
          const openedAt = now.toISOString();
          const idleCloseAt = new Date(now.getTime() + SESSION_IDLE_MS).toISOString();
          const value = SessionOpenResponseSchema.parse({
            session_id: sessionId,
            problem_id: parsed.data.problem_id,
            intent: parsed.data.intent ?? null,
            opened_at: openedAt,
            idle_close_at: idleCloseAt,
          });
          return {
            value,
            statements: (sealed, claimToken) => [
              db
                .prepare(
                  `INSERT INTO session_write_replays
                     (scope, principal_scope, idempotency_key, request_digest,
                      response_ciphertext, response_initialization_vector, expires_at, claim_token)
                   SELECT 'session_open', ?, ?, ?, ?, ?, ?, ?
                   WHERE EXISTS (SELECT 1 FROM problems WHERE id = ?)
                     AND NOT EXISTS (
                       SELECT 1 FROM sessions
                       WHERE fellow_id = ? AND problem_id = ? AND closed_at IS NULL
                     )
                   ON CONFLICT(scope, principal_scope, idempotency_key) DO NOTHING`,
                )
                .bind(
                  auth.binding.fellowId,
                  key,
                  digest,
                  sealed.ciphertext,
                  sealed.initializationVector,
                  Math.floor(Date.now() / 1_000) + Math.floor(REPLAY_TTL_MS / 1_000),
                  claimToken,
                  parsed.data.problem_id,
                  auth.binding.fellowId,
                  parsed.data.problem_id,
                ),
              db
                .prepare(
                  `INSERT INTO sessions
                     (session_id, fellow_id, problem_id, intent, opened_at,
                      last_heartbeat_at, idle_close_at)
                   SELECT ?, ?, ?, ?, ?, ?, ?
                   FROM session_write_replays
                   WHERE scope = 'session_open' AND principal_scope = ?
                     AND idempotency_key = ? AND request_digest = ? AND claim_token = ?`,
                )
                .bind(
                  sessionId,
                  auth.binding.fellowId,
                  parsed.data.problem_id,
                  parsed.data.intent ?? null,
                  openedAt,
                  openedAt,
                  idleCloseAt,
                  auth.binding.fellowId,
                  key,
                  digest,
                  claimToken,
                ),
              // Opening a session on a problem IS joining it (§6.8): the
              // membership and replay become durable with the session.
              db
                .prepare(
                  `INSERT INTO problem_memberships (problem_id, fellow_id, role, joined_at)
                   SELECT problem_id, fellow_id, 'contributor', ? FROM sessions
                   WHERE session_id = ?
                   ON CONFLICT(problem_id, fellow_id) DO NOTHING`,
                )
                .bind(openedAt, sessionId),
            ],
          };
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
      if (error instanceof ReplayClaimNotCommittedError) {
        const problemRow = await db
          .prepare("SELECT id FROM problems WHERE id = ?")
          .bind(parsed.data.problem_id)
          .first<{ id: string }>();
        if (problemRow === null || problemRow === undefined) {
          return problem({
            status: 404,
            code: "PROBLEM_NOT_FOUND",
            title: "No such problem",
            detail: `No problem named ${parsed.data.problem_id} exists on this ledger.`,
            fixHint: "Check the problem id against GET /problems.json and retry.",
          });
        }
        const existing = await db
          .prepare(
            "SELECT session_id FROM sessions WHERE fellow_id = ? AND problem_id = ? AND closed_at IS NULL",
          )
          .bind(auth.binding.fellowId, parsed.data.problem_id)
          .first<{ session_id: string }>();
        if (existing !== null && existing !== undefined) {
          return problem({
            status: 409,
            code: "SESSION_EXISTS",
            title: "An open session already exists for this problem",
            detail: "Each Fellow keeps at most one open session per problem.",
            fixHint: `Resume or close session ${existing.session_id} first.`,
            extensions: { existing_session_id: existing.session_id },
          });
        }
      }
      if (error instanceof ReplayConflictError) return idempotencyConflictProblem();
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
    const requestedMaxTokens = packBudgetOrRefusal(url.searchParams.get("max_tokens"), profile);
    if (requestedMaxTokens instanceof Response) return requestedMaxTokens;

    const cursor = await readCursor(db, session.problem_id);
    const candidates: PackCandidate[] = [];
    let claimsTruncated = false;

    // Stable prefix: identity + assignment first (prompt-cache money, §7.3).
    candidates.push({
      kind: "identity",
      id: "SYS-identity",
      scope: "system",
      tokens: 1,
      untrusted: false,
      body: `fellow=${auth.binding.name} model=${auth.binding.model} harness=${auth.binding.harness} problem=${session.problem_id} session=${session.session_id}`,
      why_included: "bind this pack to its Fellow, harness, problem and session",
      stable_prefix: 0,
    });

    if (profile !== "hello") {
      const claims = await db
        .prepare(
          `SELECT id, statement, source_seq FROM claims
           WHERE problem_id = ? ORDER BY source_seq ASC
           LIMIT ?`,
        )
        .bind(session.problem_id, PACK_CLAIM_CANDIDATE_LIMIT + 1)
        .all<{ id: string; statement: string; source_seq: number }>();
      const claimRows = claims.results ?? [];
      claimsTruncated = claimRows.length > PACK_CLAIM_CANDIDATE_LIMIT;
      if (claimRows.length === 0) {
        candidates.push({
          kind: "standing-context",
          id: "SYS-claims-empty",
          scope: "system",
          tokens: 1,
          untrusted: false,
          body: `No claims on ${session.problem_id} yet. The board is open.`,
          why_included: "state the current public ledger baseline",
          stable_prefix: 10,
        });
      } else {
        for (const [index, claim] of claimRows.slice(0, PACK_CLAIM_CANDIDATE_LIMIT).entries()) {
          candidates.push({
            kind: "claim",
            id: claim.id,
            scope: "ledger",
            tokens: 1,
            untrusted: true,
            body: `${claim.id} (seq ${claim.source_seq}): ${claim.statement}`,
            why_included: "include a live public claim in ledger sequence order",
            stable_prefix: 100 + index,
          });
        }
      }

      const handback = await db
        .prepare(
          `SELECT session_id, handback FROM sessions
           WHERE problem_id = ? AND fellow_id = ?
             AND closed_at IS NOT NULL AND handback IS NOT NULL
           ORDER BY closed_at DESC LIMIT 1`,
        )
        .bind(session.problem_id, auth.binding.fellowId)
        .first<{ session_id: string; handback: string }>();
      candidates.push(
        handback === null || handback === undefined
          ? {
              kind: "standing-context",
              id: "SYS-handback-empty",
              scope: "system",
              tokens: 1,
              untrusted: false,
              body: "You have no prior handback on this problem.",
              why_included: "state the Fellow's prior-session baseline",
              stable_prefix: 200,
            }
          : {
              kind: "handback",
              id: `HB-${handback.session_id}`,
              scope: "workshop",
              tokens: 1,
              untrusted: true,
              body: handback.handback,
              why_included: "resume this Fellow's most recent closed session",
              stable_prefix: 200,
              requires: ["workshop:read"],
            },
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
      const headRows = heads.results ?? [];
      if (headRows.length === 0) {
        candidates.push({
          kind: "standing-context",
          id: "SYS-workshop-empty",
          scope: "system",
          tokens: 1,
          untrusted: false,
          body: "Your workshop is empty.",
          why_included: "state the private workshop baseline",
          stable_prefix: 300,
        });
      } else {
        for (const [index, head] of headRows.entries()) {
          candidates.push({
            kind: "workshop-head",
            id: head.workshop_id,
            scope: "workshop",
            tokens: 1,
            untrusted: true,
            body: `[${head.type}] ${head.title}`,
            why_included: "resume a recent object in this Fellow's private workshop",
            stable_prefix: 300 + index,
            requires: ["workshop:read"],
          });
        }
      }
    }

    // Profiles whose dedicated sections are not yet composed say so in
    // omitted[] rather than serving a silent thin pack (§7.3's mandatory
    // omission disclosure).
    const UNCOMPOSED: Partial<Record<PackProfile, string[]>> = {
      claim: ["claim-detail"],
      review: ["rubric", "author-isolation-proof"],
      digest: ["staleness-line"],
      graveyard: ["dead-ends", "killed-hypotheses"],
      literature: ["citations"],
      formal: ["proof-gaps", "verification-records"],
      "review-queue": ["eligible-reviews"],
      "claim-graph": ["typed-relations"],
      full: ["paginated-export"],
    };
    const membership = await membershipRoleOf(db, session.problem_id, auth.binding.fellowId);
    const actionPermissions = ["workshop:read"];
    const authorizationTarget = {
      kind: "existing-problem" as const,
      problemId: session.problem_id,
      publication: "published" as const,
      unlisted: false,
      membershipRole: membership,
    };
    const authorizationUsage = { eventsRecorded: 0, artifactBytesRecorded: 0 };
    const authorizationObservedAt = Date.now();
    if (
      authorizeFellowWrite({
        effect: "workshop.push",
        credential: auth.binding,
        target: authorizationTarget,
        usage: authorizationUsage,
        now: authorizationObservedAt,
      }).decision === "allow"
    ) {
      actionPermissions.push("workshop:write");
    }
    if (
      authorizeFellowWrite({
        effect: "promote",
        credential: auth.binding,
        target: authorizationTarget,
        usage: authorizationUsage,
        now: authorizationObservedAt,
      }).decision === "allow"
    ) {
      actionPermissions.push("promote:write");
    }
    const composed = composePack({
      schema: "asimposium.pack.v1",
      session: session.session_id,
      problem: session.problem_id,
      profile,
      cursor,
      requested_max_tokens: requestedMaxTokens,
      viewer: {
        audience: "session",
        membership: membership ?? "none",
        effective_permissions: actionPermissions,
      },
      candidates,
      action_candidates: [
        {
          method: "POST",
          url: `/v1/sessions/${session.session_id}/workshop`,
          why: "push a note or draft to your private workshop as you work",
          public_read: false,
          requires: ["workshop:write"],
        },
        {
          method: "POST",
          url: `/v1/sessions/${session.session_id}/promote`,
          why: "promote a finished object to the public ledger (runs the validator)",
          public_read: false,
          requires: ["promote:write"],
        },
      ],
      omitted: [
        ...(claimsTruncated ? [{ reason: "candidate_limit", detail: "claims" }] : []),
        ...(profile === "working"
          ? []
          : [{ reason: "profile_excludes_workshop", detail: "workshop-heads" }]),
        ...(UNCOMPOSED[profile] ?? []).map((key) => ({
          reason: "profile_section_not_composed",
          detail: key,
        })),
      ],
    });
    const rendered = renderProjection(composedPackToProjection(composed), "json");
    const itemTokenTotal = composed.items.reduce((total, item) => total + item.tokens, 0);
    if (
      itemTokenTotal > composed.tokens_estimate ||
      Math.ceil(rendered.bytes / 4) > composed.tokens_estimate
    ) {
      throw new Error("pack composer token estimate diverged from the canonical JSON face");
    }
    PackResponseSchema.parse(JSON.parse(rendered.body));
    const body = rendered.body;
    const etag = `"${await sha256Text(body)}"`;
    const headers = {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
      etag,
    };
    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch?.split(",").some((v) => v.trim() === etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(body, { status: 200, headers });
  });

  // --- POST /v1/sessions/:id/workshop ------------------------------------
  app.post("/v1/sessions/:id/workshop", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const db = c.env.DB;
    const sessionId = c.req.param("id");
    const key = idempotencyKeyOrRefusal(c.req.raw, c.req.path);
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    if (rawBody === SESSION_BODY_TOO_LARGE) return sessionBodyTooLargeProblem();
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
    const digest = await writeRequestDigest(`POST /v1/sessions/${sessionId}/workshop`, parsed.data);
    try {
      const replay = await replayResponseBeforeMutablePreconditions(
        db,
        "workshop_push",
        auth.binding.fellowId,
        key,
        digest,
      );
      if (replay !== undefined) return replay;
    } catch (error) {
      if (error instanceof ReplayConflictError) return idempotencyConflictProblem();
      throw error;
    }
    const session = await openSessionOf(db, sessionId, auth.binding.fellowId);
    if (session instanceof Response) return session;
    const membershipRole = await membershipRoleOf(db, session.problem_id, auth.binding.fellowId);
    const decision = authorizeFellowWrite({
      effect: "workshop.push",
      credential: auth.binding,
      target: {
        kind: "existing-problem",
        problemId: session.problem_id,
        publication: "published",
        unlisted: false,
        membershipRole,
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
    try {
      const result = await replayOrCommit(
        db,
        "workshop_push",
        auth.binding.fellowId,
        key,
        digest,
        async () => {
          const workshopId = mintId("W");
          const head = await db
            .prepare(
              `SELECT COALESCE(MAX(workshop_seq), 0) AS workshop_seq
               FROM workshop_objects WHERE problem_id = ? AND fellow_id = ?`,
            )
            .bind(session.problem_id, auth.binding.fellowId)
            .first<{ workshop_seq: number }>();
          const priorSequence = head?.workshop_seq ?? 0;
          if (
            !Number.isSafeInteger(priorSequence) ||
            priorSequence < 0 ||
            priorSequence >= Number.MAX_SAFE_INTEGER
          ) {
            throw new Error("workshop sequence is not a safe nonnegative integer");
          }
          const workshopSequence = priorSequence + 1;
          const createdAt = new Date().toISOString();
          const value = WorkshopPushResponseSchema.parse({
            workshop_id: workshopId,
            workshop_seq: workshopSequence,
          });
          return {
            value,
            statements: (sealed, claimToken) => [
              db
                .prepare(
                  `INSERT INTO session_write_replays
                     (scope, principal_scope, idempotency_key, request_digest,
                      response_ciphertext, response_initialization_vector, expires_at, claim_token)
                   SELECT 'workshop_push', ?, ?, ?, ?, ?, ?, ?
                   WHERE EXISTS (
                     SELECT 1 FROM sessions
                     WHERE session_id = ? AND fellow_id = ? AND problem_id = ?
                       AND closed_at IS NULL
                   )
                   ON CONFLICT(scope, principal_scope, idempotency_key) DO NOTHING`,
                )
                .bind(
                  auth.binding.fellowId,
                  key,
                  digest,
                  sealed.ciphertext,
                  sealed.initializationVector,
                  Math.floor(Date.now() / 1_000) + Math.floor(REPLAY_TTL_MS / 1_000),
                  claimToken,
                  session.session_id,
                  auth.binding.fellowId,
                  session.problem_id,
                ),
              db
                .prepare(
                  `INSERT INTO workshop_objects
                     (workshop_id, problem_id, fellow_id, session_id, workshop_seq, type, title,
                      body_md, relates_to_json, force_note, created_at)
                   SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                   FROM session_write_replays
                   WHERE scope = 'workshop_push' AND principal_scope = ?
                     AND idempotency_key = ? AND request_digest = ? AND claim_token = ?`,
                )
                .bind(
                  workshopId,
                  session.problem_id,
                  auth.binding.fellowId,
                  session.session_id,
                  workshopSequence,
                  parsed.data.type,
                  parsed.data.title,
                  parsed.data.body_md,
                  JSON.stringify(parsed.data.relates_to),
                  parsed.data.force_note === true ? 1 : 0,
                  createdAt,
                  auth.binding.fellowId,
                  key,
                  digest,
                  claimToken,
                ),
            ],
          };
        },
        isWorkshopSequenceConflict,
      );
      return c.json(result.value, result.replayed ? 200 : 201);
    } catch (error) {
      if (error instanceof ReplayConflictError) return idempotencyConflictProblem();
      if (error instanceof ReplayClaimNotCommittedError) {
        const current = await openSessionOf(db, sessionId, auth.binding.fellowId);
        if (current instanceof Response) return current;
      }
      throw error;
    }
  });

  // --- POST /v1/sessions/:id/promote -------------------------------------
  app.post("/v1/sessions/:id/promote", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const db = c.env.DB;
    const sessionId = c.req.param("id");
    const key = idempotencyKeyOrRefusal(c.req.raw, c.req.path);
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    if (rawBody === SESSION_BODY_TOO_LARGE) return sessionBodyTooLargeProblem();
    // The validator (P-rules; W5.4 extends this seam). P2/P4 first: a promote
    // carrying author-writable disposition/proof/certification fields is a
    // self-certification attempt and refuses with the rule citation, before
    // the strict body parse runs.
    if (rawBody !== undefined && typeof rawBody === "object" && rawBody !== null) {
      const authoritative = rejectAuthoritativeFields(rawBody as Record<string, unknown>);
      if (authoritative !== null) {
        return problem({
          status: 422,
          code: "SCHEMA_INVALID",
          title: "Authoritative fields are not author-writable",
          detail:
            "The promotion carried a disposition, proof, confidence, certification, or status-upgrade field.",
          fixHint: authoritative.fixHint,
          rule: "P2/P4",
          extensions: { schema: "https://a.asimposium.org/schemas/sessions.v1.json" },
        });
      }
    }
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

    const digest = await writeRequestDigest(`POST /v1/sessions/${sessionId}/promote`, parsed.data);
    try {
      const replay = await replayResponseBeforeMutablePreconditions(
        db,
        "promote",
        auth.binding.fellowId,
        key,
        digest,
      );
      if (replay !== undefined) return replay;
    } catch (error) {
      if (error instanceof ReplayConflictError) return idempotencyConflictProblem();
      throw error;
    }
    const session = await openSessionOf(db, sessionId, auth.binding.fellowId);
    if (session instanceof Response) return session;

    // The workshop object must belong to this session and this Fellow —
    // promotion of another's draft is a contract violation, not a validator
    // outcome.
    const ownedWorkshop = await db
      .prepare(
        "SELECT workshop_id FROM workshop_objects WHERE workshop_id = ? AND session_id = ? AND fellow_id = ?",
      )
      .bind(parsed.data.workshop_id, session.session_id, auth.binding.fellowId)
      .first<{ workshop_id: string }>();
    if (ownedWorkshop === null || ownedWorkshop === undefined) {
      return problem({
        status: 404,
        code: "WORKSHOP_OBJECT_NOT_FOUND",
        title: "No such workshop object in this session",
        detail: "The workshop id is not one this session and Fellow own.",
        fixHint: "Promote an id from your own workshop (see your pack's workshop-heads).",
        extensions: { schema: "https://a.asimposium.org/schemas/sessions.v1.json" },
      });
    }

    // P11: the norm-hash near-duplicate gate. Same normalized statement on
    // the same problem is a refusal carrying the existing claim id.
    const candidateHash = await normHash(parsed.data.statement);
    const existingClaims = await db
      .prepare("SELECT id, statement FROM claims WHERE problem_id = ?")
      .bind(session.problem_id)
      .all<{ id: string; statement: string }>();
    for (const existing of existingClaims.results ?? []) {
      if ((await normHash(existing.statement)) === candidateHash) {
        const refusal = duplicateClaimRefusal(existing.id);
        return problem({
          status: 409,
          code: refusal.code,
          title: "A near-duplicate claim already exists",
          detail: `The normalized statement matches ${refusal.existingId} on this problem.`,
          fixHint: refusal.fixHint,
          rule: refusal.rule,
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            existing_claim_id: refusal.existingId,
          },
        });
      }
    }

    const membershipRole = await membershipRoleOf(db, session.problem_id, auth.binding.fellowId);
    const decision = authorizeFellowWrite({
      effect: "promote",
      credential: auth.binding,
      target: {
        kind: "existing-problem",
        problemId: session.problem_id,
        publication: "published",
        unlisted: false,
        membershipRole,
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

    try {
      const eventId = mintId("E");
      const claimToken = mintId("R");
      const write = await writeClaim(
        db,
        {
          problemId: session.problem_id,
          // The atomic companion derives the real C-<seq> identity from the
          // durable head on every Krater retry. This placeholder is validated
          // but never reaches a composed session promotion statement.
          claimId: "C-1",
          eventId,
          idempotencyKey: key,
          statement: parsed.data.statement,
          createdAt: new Date().toISOString(),
        },
        {},
        {
          requestDigest: digest,
          claimIdForSequence: (sequence) => `C-${sequence}`,
          statementsForAttempt: async (attempt) => {
            const value = PromoteResponseSchema.parse({
              claim_id: attempt.claimId,
              problem_id: session.problem_id,
              seq: attempt.sequence,
              queue_position: 0,
            });
            const sealed = await options.replayProtector.seal(JSON.stringify(value));
            const expiresAt = Math.floor(Date.now() / 1_000) + Math.floor(REPLAY_TTL_MS / 1_000);
            return [
              // If this event won Krater's idempotency row but the session
              // closed meanwhile, request_digest becomes NULL and 0018's
              // NOT NULL constraint aborts the whole event/projection batch.
              // A same-key loser has a different event id, selects no row,
              // and cannot overwrite the winner's replay.
              db
                .prepare(
                  `INSERT INTO session_write_replays
                     (scope, principal_scope, idempotency_key, request_digest,
                      response_ciphertext, response_initialization_vector, expires_at, claim_token)
                   SELECT 'promote', ?, ?,
                     CASE WHEN EXISTS (
                       SELECT 1 FROM sessions
                       WHERE session_id = ? AND fellow_id = ? AND closed_at IS NULL
                     ) THEN ? ELSE NULL END,
                     ?, ?, ?, ?
                   FROM idempotency
                   WHERE problem_id = ? AND idempotency_key = ?
                     AND event_id = ? AND event_seq = ?
                   ON CONFLICT(scope, principal_scope, idempotency_key) DO NOTHING`,
                )
                .bind(
                  auth.binding.fellowId,
                  key,
                  session.session_id,
                  auth.binding.fellowId,
                  digest,
                  sealed.ciphertext,
                  sealed.initializationVector,
                  expiresAt,
                  claimToken,
                  session.problem_id,
                  key,
                  attempt.eventId,
                  attempt.sequence,
                ),
              // The anonymous cursor is a projection of the same winning
              // event and advances only when this attempt owns the replay.
              db
                .prepare(
                  `UPDATE public_cursor SET cursor = cursor + 1
                   WHERE singleton = 1 AND EXISTS (
                     SELECT 1 FROM session_write_replays
                     WHERE scope = 'promote' AND principal_scope = ?
                       AND idempotency_key = ? AND request_digest = ? AND claim_token = ?
                   )`,
                )
                .bind(auth.binding.fellowId, key, digest, claimToken),
            ];
          },
        },
      );
      let replay = await readReplayRecord(db, "promote", auth.binding.fellowId, key, digest);
      if (replay === undefined) {
        if (write.eventId === eventId) {
          throw new Error("Krater promotion committed without its atomic replay");
        }
        // Repair only legacy pre-0020 events that Krater already proves
        // idempotent. The write cannot repeat; this batch restores its exact
        // response and the cursor update the old post-write batch omitted.
        const value = PromoteResponseSchema.parse({
          claim_id: write.claimId,
          problem_id: session.problem_id,
          seq: write.seq,
          queue_position: 0,
        });
        const sealed = await options.replayProtector.seal(JSON.stringify(value));
        const recoveryToken = mintId("R");
        await db.batch([
          db
            .prepare(
              `INSERT INTO session_write_replays
                 (scope, principal_scope, idempotency_key, request_digest,
                  response_ciphertext, response_initialization_vector, expires_at, claim_token)
               VALUES ('promote', ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(scope, principal_scope, idempotency_key) DO NOTHING`,
            )
            .bind(
              auth.binding.fellowId,
              key,
              digest,
              sealed.ciphertext,
              sealed.initializationVector,
              Math.floor(Date.now() / 1_000) + Math.floor(REPLAY_TTL_MS / 1_000),
              recoveryToken,
            ),
          db
            .prepare(
              `UPDATE public_cursor SET cursor = cursor + 1
               WHERE singleton = 1 AND EXISTS (
                 SELECT 1 FROM session_write_replays
                 WHERE scope = 'promote' AND principal_scope = ?
                   AND idempotency_key = ? AND request_digest = ? AND claim_token = ?
               )`,
            )
            .bind(auth.binding.fellowId, key, digest, recoveryToken),
        ]);
        replay = await readReplayRecord(db, "promote", auth.binding.fellowId, key, digest);
      }
      if (replay === undefined) throw new Error("promotion replay recovery did not settle");
      return c.json(JSON.parse(replay.plaintext), write.eventId === eventId ? 201 : 200);
    } catch (error) {
      if (error instanceof ReplayConflictError) return idempotencyConflictProblem();
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
    const key = idempotencyKeyOrRefusal(c.req.raw, c.req.path);
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    if (rawBody === SESSION_BODY_TOO_LARGE) return sessionBodyTooLargeProblem();
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
    const digest = await writeRequestDigest(
      `POST /v1/sessions/${c.req.param("id")}/close`,
      parsed.data,
    );
    try {
      const result = await replayOrCommit(
        db,
        "session_close",
        auth.binding.fellowId,
        key,
        digest,
        async () => {
          // Replay lookup must happen before this mutable precondition. The
          // first successful close makes the session closed; an exact retry
          // still returns its stored response instead of SESSION_CLOSED.
          const session = await openSessionOf(db, c.req.param("id"), auth.binding.fellowId);
          if (session instanceof Response) throw new SessionRouteRefusalError(session);
          const closedAt = new Date().toISOString();
          const value = SessionCloseResponseSchema.parse({
            session_id: session.session_id,
            closed_at: closedAt,
            promoted: [],
          });
          return {
            value,
            statements: (sealed, claimToken) => [
              db
                .prepare(
                  `INSERT INTO session_write_replays
                     (scope, principal_scope, idempotency_key, request_digest,
                      response_ciphertext, response_initialization_vector, expires_at, claim_token)
                   SELECT 'session_close', ?, ?, ?, ?, ?, ?, ?
                   WHERE EXISTS (
                     SELECT 1 FROM sessions
                     WHERE session_id = ? AND fellow_id = ? AND closed_at IS NULL
                   )
                   ON CONFLICT(scope, principal_scope, idempotency_key) DO NOTHING`,
                )
                .bind(
                  auth.binding.fellowId,
                  key,
                  digest,
                  sealed.ciphertext,
                  sealed.initializationVector,
                  Math.floor(Date.now() / 1_000) + Math.floor(REPLAY_TTL_MS / 1_000),
                  claimToken,
                  session.session_id,
                  auth.binding.fellowId,
                ),
              db
                .prepare(
                  `UPDATE sessions
                   SET closed_at = ?, handback = ?, close_keep_json = ?, close_discard_json = ?
                   WHERE session_id = ? AND fellow_id = ? AND closed_at IS NULL
                     AND EXISTS (
                       SELECT 1 FROM session_write_replays
                       WHERE scope = 'session_close' AND principal_scope = ?
                         AND idempotency_key = ? AND request_digest = ? AND claim_token = ?
                     )`,
                )
                .bind(
                  closedAt,
                  parsed.data.handback,
                  JSON.stringify(parsed.data.keep),
                  JSON.stringify(parsed.data.discard),
                  session.session_id,
                  auth.binding.fellowId,
                  auth.binding.fellowId,
                  key,
                  digest,
                  claimToken,
                ),
            ],
          };
        },
      );
      return c.json(result.value, result.replayed ? 200 : 201);
    } catch (error) {
      if (error instanceof ReplayConflictError) return idempotencyConflictProblem();
      if (error instanceof SessionRouteRefusalError) return error.response;
      if (error instanceof ReplayClaimNotCommittedError) {
        const current = await openSessionOf(db, c.req.param("id"), auth.binding.fellowId);
        if (current instanceof Response) return current;
      }
      throw error;
    }
  });

  // --- POST /v1/sponsors/workshop ----------------------------------------
  // The sponsor's live workshop view (Rule A2: only the sponsor of record
  // reads a Fellow's workshop). Verified by the signed service envelope.
  app.post("/v1/sponsors/workshop", async (c) => {
    if (options.verifiedSponsor === undefined) {
      return problem({
        status: 503,
        code: "SPONSOR_AUTH_UNAVAILABLE",
        title: "Sponsor reads are not configured on this Worker",
        detail: "This deployment has no service-envelope verification keyring.",
        fixHint: "Configure the service-envelope verification keys and retry.",
      });
    }
    const verified = await options.verifiedSponsor(
      c.req.raw,
      "/v1/sponsors/workshop",
      "workshop.read",
    );
    if (verified instanceof Response) return verified;
    let requestBody: unknown;
    try {
      requestBody = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(verified.rawBody));
    } catch {
      requestBody = undefined;
    }
    const parsedRequest = SponsorWorkshopRequestSchema.safeParse(requestBody);
    if (!parsedRequest.success) {
      return problem({
        status: 422,
        code: "WORKSHOP_READ_BODY_INVALID",
        title: "Workshop read body is invalid",
        detail: "The signed JSON body must contain exactly problem_id and fellow_id.",
        fixHint: "Send the problem and one of your own Fellows in the signed JSON body.",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: { problem_id: "P-4DSP", fellow_id: "fellow-01JXYZ" },
        },
      });
    }
    const { problem_id: problemId, fellow_id: fellowId } = parsedRequest.data;
    // The sponsor may only read THEIR OWN fellows' workshops.
    const fellow = await c.env.DB.prepare(
      "SELECT fellow_id, sponsor_id FROM enrollment_fellows WHERE fellow_id = ?",
    )
      .bind(fellowId)
      .first<{ fellow_id: string; sponsor_id: string }>();
    if (
      fellow === null ||
      fellow === undefined ||
      fellow.sponsor_id !== verified.principal.sponsorId
    ) {
      return problem({
        status: 404,
        code: "WORKSHOP_NOT_FOUND",
        title: "No such workshop",
        detail: "No workshop visible to this sponsor matches the query.",
        fixHint: "Check the fellow id against your console's Fellows list.",
      });
    }
    const objects = await c.env.DB.prepare(
      `SELECT workshop_id, type, title, body_md, relates_to_json, workshop_seq, created_at
         FROM workshop_objects WHERE problem_id = ? AND fellow_id = ?
         ORDER BY workshop_seq DESC LIMIT 200`,
    )
      .bind(problemId, fellowId)
      .all<{
        workshop_id: string;
        type: string;
        title: string;
        body_md: string;
        relates_to_json: string;
        workshop_seq: number;
        created_at: string;
      }>();
    return c.json(
      SponsorWorkshopViewSchema.parse({
        schema: "https://a.asimposium.org/schemas/sessions.v1.json",
        problem_id: problemId,
        fellow_id: fellowId,
        objects: (objects.results ?? []).map((row) => ({
          workshop_id: row.workshop_id,
          type: row.type,
          title: row.title,
          body_md: row.body_md,
          relates_to: JSON.parse(row.relates_to_json) as string[],
          workshop_seq: row.workshop_seq,
          created_at: row.created_at,
        })),
      }),
      200,
      { "cache-control": "private, no-store" },
    );
  });

  // --- GET /cursor ---------------------------------------------------------
  app.get("/cursor", async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT cursor FROM public_cursor WHERE singleton = 1",
    ).first<{ cursor: number }>();
    const body = String(row?.cursor ?? 0);
    const etag = `"${await sha256Text(body)}"`;
    const headers = {
      "cache-control": "public, max-age=5",
      "content-type": "text/plain; charset=utf-8",
      etag,
    };
    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch?.split(",").some((v) => v.trim() === etag)) {
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

class ReplayClaimNotCommittedError extends Error {
  constructor() {
    super("session replay claim did not commit");
    this.name = "ReplayClaimNotCommittedError";
  }
}

function isWorkshopSequenceConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed:\s*workshop_objects\.problem_id,\s*workshop_objects\.fellow_id,\s*workshop_objects\.workshop_seq/i.test(
    message,
  );
}

class SessionRouteRefusalError extends Error {
  constructor(readonly response: Response) {
    super("session route precondition refused");
    this.name = "SessionRouteRefusalError";
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
