import {
  CursorResponseSchema,
  type PackProfile,
  PackResponseSchema,
  PromoteRequestSchema,
  PromoteResponseSchema,
  EvidenceRequestSchema,
  EvidenceResponseSchema,
  ReviewRequestSchema,
  ReviewResponseSchema,
  SessionCloseRequestSchema,
  SessionCloseResponseSchema,
  SessionOpenRequestSchema,
  SessionOpenResponseSchema,
  SponsorIdSchema,
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
  PackComposerError,
  renderProjection,
} from "@asimposium/render";
import { type Context, Hono } from "hono";
import { cancelUnconsumedRequestBody, readBoundedRequestBody } from "../auth/http";
import type {
  EncryptedEnrollmentReplay,
  EnrollmentService,
  FellowCredentialBinding,
} from "../enrollment/service";
import { authorizeFellowWrite } from "../enrollment/service";
import type { Env } from "../env";
import { problem, validatedProblem } from "../http/envelope";
import { storeWorkshopBody } from "../krater/cas";
import { assessNoteIntent, suggestedClaimFromNote } from "../krater/intent";
import {
  KraterIdempotencyConflictError,
  KraterProblemNotFoundError,
  readCursor,
  writeClaim,
} from "../krater/krater";
import { KRATER_OUTBOX_NUDGE_DEADLINE_MS, requestKraterOutbox } from "../krater/outbox-do";
import { computeClaimDisposition } from "../ledger/disposition-read";
import { gateReviewSubmission } from "../ledger/review-gate";
import { assessEvidenceClass, canDrivePromotion } from "../ledger/evidence-class";
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

function verifiedSponsorSnapshot(value: unknown):
  | {
      readonly sponsorId: string;
      readonly rawBody: Uint8Array;
    }
  | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as {
    readonly principal?: { readonly type?: unknown; readonly sponsorId?: unknown };
    readonly rawBody?: unknown;
  };
  // Read each verifier-owned property exactly once, while the caller's catch
  // still encloses hostile Proxy/getter behavior. Returning immutable scalar
  // authority plus a byte copy prevents a later business-path reread from
  // invoking the untrusted adapter again or observing a mutated buffer.
  const principal = candidate.principal;
  const rawBody = candidate.rawBody;
  if (typeof principal !== "object" || principal === null) return undefined;
  const type = principal.type;
  const sponsorId = principal.sponsorId;
  if (
    type !== "sponsor" ||
    typeof sponsorId !== "string" ||
    !SponsorIdSchema.safeParse(sponsorId).success ||
    !(rawBody instanceof Uint8Array)
  ) {
    return undefined;
  }
  return { sponsorId, rawBody: new Uint8Array(rawBody) };
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
    cancelUnconsumedRequestBody(request);
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

async function promoteKraterIdempotencyKey(claimToken: string): Promise<string> {
  return `session-promote-v2:${await sha256Text(`session-promote-v2\0${claimToken}`)}`;
}

/**
 * Best-effort wake for the durable outbox drainer after a committed promotion.
 *
 * Delivery authority does not live here. The five-minute scheduled
 * reconciliation still owns correctness and is deliberately unchanged; this only
 * shortens the common-case latency between a durable claim and its search.index
 * handoff. Because the promotion has already committed by the time this runs,
 * the response is owed to the caller no matter what happens next, so every
 * failure mode is swallowed:
 *
 *   - no ExecutionContext on the context (Hono's getter throws synchronously),
 *   - `waitUntil` itself throwing synchronously,
 *   - the bounded deadline aborting the handoff,
 *   - the Durable Object rejecting, or the binding being absent.
 *
 * A duplicate or replayed wake is harmless by construction: /nudge only sets an
 * alarm, and the drain it schedules is itself idempotent.
 */
function scheduleCommittedPromotionNudge(c: Context<{ Bindings: Env }>): void {
  try {
    c.executionCtx.waitUntil(
      requestKraterOutbox(
        c.env,
        "/nudge",
        { faultMode: "none" },
        KRATER_OUTBOX_NUDGE_DEADLINE_MS,
      ).then(
        () => undefined,
        () => undefined,
      ),
    );
  } catch {
    // Swallowed on purpose: see the contract above. The promotion is durable and
    // the scheduled reconciliation still covers this row.
  }
}

function idempotencyConflictProblem(): Response {
  return validatedProblem({
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    title: "The Idempotency-Key was used for a different request",
    detail: "This key was first used with a different body or target resource.",
    fixHint: "Retry with a fresh Idempotency-Key for a new request.",
    rule: "A5",
    extensions: {
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example: { headers: { "Idempotency-Key": "session-new-request-01" } },
    },
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

interface PackSessionRow {
  readonly session_id: string;
  readonly problem_id: string;
  readonly closed_at: string | null;
}

export function createSessionRouter(options: SessionRouterOptions): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  const privateNoStore = (response: Response): Response => {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "private, no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

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
      : privateNoStore(
          new Response(replay.plaintext, {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          }),
        );
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

  /**
   * The one coarse face for every route-reachable authorization refusal.
   *
   * 403, not 401, and deliberately NOT the enrollment module's
   * `fellowAuthorizationResponse`. By the time a handler runs, `authenticate`
   * below has already turned every credential-liveness failure — revoked,
   * expired, not-yet-valid, paused, archived, compromised, sponsor-panicked,
   * family-revoked, grant-expired — into 401 FELLOW_TOKEN_INVALID. What can
   * still reach `authorizeFellowWrite` here is only the policy set:
   * suspicious-review quarantine, scope, problem binding, membership, role.
   * Those are all "the credential is valid and the answer is still no", which
   * is 403. Returning the enrollment helper's 401 would tell an agent to
   * obtain a fresh token for a scope problem no token can fix, and would make
   * the refusal byte-identical to the auth step's own 401.
   *
   * Byte-identical across every route and every reason, per ADR-18 / Fable
   * §7.7: a refusal that varies by cause is an iteration oracle for the caller
   * it just refused. The operator reason stays on the operator channel.
   */
  const writeRefusedProblem = (): Response =>
    problem({
      status: 403,
      code: "WRITE_REFUSED",
      title: "The write is not authorized for this credential",
      detail: "This credential may not perform this write now.",
      fixHint: "Check the console for the credential state or contact your sponsor.",
    });

  const fellowTokenInvalidProblem = (): Response =>
    problem({
      status: 401,
      code: "FELLOW_TOKEN_INVALID",
      title: "Fellow bearer token is not accepted",
      detail: "The bearer token was not accepted.",
      fixHint:
        "Obtain a token through an explicitly approved enrollment flow and send it in Authorization.",
    });

  async function credentialIsLiveAtCommit(db: Env["DB"], credentialId: string): Promise<boolean> {
    const row = await db
      .prepare(
        `SELECT 1 AS live FROM fellow_tokens
         WHERE credential_id = ? AND revoked_at IS NULL`,
      )
      .bind(credentialId)
      .first<{ live: number }>();
    return row !== null && row !== undefined;
  }

  async function authenticate(
    request: Request,
  ): Promise<
    | { readonly ok: true; readonly binding: FellowCredentialBinding }
    | { readonly ok: false; readonly response: Response }
  > {
    const token = bearerToken(request);
    let binding: FellowCredentialBinding | undefined;
    try {
      binding = token === undefined ? undefined : await options.service.credentialBinding(token);
    } catch {
      // Credential-store availability must not distinguish a known token from
      // an unknown one, and the unread request stream still belongs to us.
      cancelUnconsumedRequestBody(request);
      return { ok: false, response: fellowTokenInvalidProblem() };
    }
    if (binding === undefined) {
      cancelUnconsumedRequestBody(request);
      return { ok: false, response: fellowTokenInvalidProblem() };
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

  async function packSessionOf(
    db: Env["DB"],
    sessionId: string,
    fellowId: string,
  ): Promise<PackSessionRow | Response> {
    const row = await db
      .prepare(
        "SELECT session_id, problem_id, closed_at FROM sessions WHERE session_id = ? AND fellow_id = ?",
      )
      .bind(sessionId, fellowId)
      .first<PackSessionRow>();
    if (row === null || row === undefined) {
      const response = problem({
        status: 404,
        code: "SESSION_NOT_FOUND",
        title: "No such session",
        detail: "No session with this id exists.",
        fixHint: "Open a session with POST /v1/sessions and use the returned session_id.",
        extensions: { schema: "https://a.asimposium.org/schemas/sessions.v1.json" },
      });
      response.headers.set("cache-control", "private, no-store");
      return response;
    }
    if (row.closed_at !== null) {
      const response = problem({
        status: 409,
        code: "SESSION_CLOSED",
        title: "The session is closed",
        detail: "A closed session accepts no reads or writes. Its handback is in the next pack.",
        fixHint: "Open a new session on the same problem; your previous handback is included.",
        extensions: { schema: "https://a.asimposium.org/schemas/sessions.v1.json" },
      });
      response.headers.set("cache-control", "private, no-store");
      return response;
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
      return validatedProblem({
        status: 422,
        code: "SESSION_OPEN_BODY_INVALID",
        title: "The session-open body does not match the contract",
        detail: "The JSON body does not match the session-open contract.",
        fixHint: "Send {problem_id, intent?} with a problem id like P-4DSP.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: { problem_id: "P-4DSP", intent: "prove" },
        },
      });
    }
    const db = c.env.DB;
    const digest = await writeRequestDigest("POST /v1/sessions", parsed.data);
    try {
      // Exact replay is a fact about a prior active operation, not a new
      // admission. It stays ahead of the fresh-write policy check.
      const replay = await replayResponseBeforeMutablePreconditions(
        db,
        "session_open",
        auth.binding.fellowId,
        key,
        digest,
      );
      if (replay !== undefined) return replay;
      const decision = authorizeFellowWrite({
        effect: "session.open",
        credential: auth.binding,
        target: { kind: "session-admission", problemId: parsed.data.problem_id },
        // Durable credential-attributed accounting belongs to wqlf. This
        // route only supplies the existing synthetic evaluator input.
        usage: { eventsRecorded: 0, artifactBytesRecorded: 0 },
        now: Date.now(),
      });
      if (decision.decision !== "allow") return writeRefusedProblem();
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
                     AND EXISTS (
                       SELECT 1 FROM fellow_tokens
                       WHERE credential_id = ? AND revoked_at IS NULL
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
                  auth.binding.credentialId,
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
      return privateNoStore(c.json(result.value, result.replayed ? 200 : 201));
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
        // Every contract-shaped cause is excluded above, so the election was
        // lost to the commit-time credential liveness clause: a revoke landed
        // between this request's authentication and its batch. It answers with
        // the one coarse policy face, never a cause the caller could probe.
        return writeRefusedProblem();
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
    const session = await packSessionOf(db, c.req.param("id"), auth.binding.fellowId);
    if (session instanceof Response) return session;
    const url = new URL(c.req.url);
    const profileParam = url.searchParams.get("profile") ?? "working";
    if (!PROFILES.includes(profileParam as PackProfile)) {
      return privateNoStore(
        validatedProblem({
          status: 400,
          code: "UNKNOWN_PROFILE",
          title: "Unknown pack profile",
          detail: "The ?profile= value is not one this route serves.",
          fixHint: `Use one of: ${PROFILES.join(", ")}.`,
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: {
              method: "GET",
              path: "/v1/sessions/<id>/pack?profile=working",
            },
            allowed: PROFILES,
          },
        }),
      );
    }
    const profile = profileParam as PackProfile;
    const requestedMaxTokens = packBudgetOrRefusal(url.searchParams.get("max_tokens"), profile);
    if (requestedMaxTokens instanceof Response) return privateNoStore(requestedMaxTokens);

    const membership = await membershipRoleOf(db, session.problem_id, auth.binding.fellowId);
    const cursor = await readCursor(db, session.problem_id);
    const packResponse = async (composed: ReturnType<typeof composePack>): Promise<Response> => {
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
    };
    const composePackResponse = async (
      input: Parameters<typeof composePack>[0],
    ): Promise<Response> => {
      try {
        return await packResponse(composePack(input));
      } catch (error) {
        if (error instanceof PackComposerError) {
          return privateNoStore(
            validatedProblem({
              status: 500,
              code: "INTERNAL_ERROR",
              title: "The session pack is unavailable",
              detail: "The session pack could not be composed safely.",
              fixHint:
                "Retry the request. If it persists, report the route and the time of the attempt.",
            }),
          );
        }
        throw error;
      }
    };
    if (membership === undefined) {
      return composePackResponse({
        schema: "asimposium.pack.v1",
        session: session.session_id,
        problem: session.problem_id,
        profile,
        cursor,
        requested_max_tokens: requestedMaxTokens,
        viewer: {
          audience: "session",
          membership: "none",
          effective_permissions: [],
        },
        candidates: [],
        action_candidates: [],
        omitted: [{ reason: "no_membership" }],
      });
    }
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
           WHERE problem_id = ? AND source_seq <= ? ORDER BY source_seq ASC
           LIMIT ?`,
        )
        .bind(session.problem_id, cursor, PACK_CLAIM_CANDIDATE_LIMIT + 1)
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
        // W5.4 read side: each claim's honest standing is computed from its
        // ledger events (never a stored field) and displayed with the claim.
        for (const [index, claim] of claimRows.slice(0, PACK_CLAIM_CANDIDATE_LIMIT).entries()) {
          const claimEvents = await db
            .prepare(
              `SELECT type FROM events
               WHERE problem_id = ? AND object_kind = 'claim' AND object_id = ? AND seq <= ?
               ORDER BY seq ASC`,
            )
            .bind(session.problem_id, claim.id, cursor)
            .all<{ type: string }>();
          const eventKinds = (claimEvents.results ?? []).map((row) =>
            row.type === "claim.created" ? ({ kind: "promote" } as const) : null,
          );
          const disposition = computeClaimDisposition(
            eventKinds.filter((event): event is { readonly kind: "promote" } => event !== null),
          );
          candidates.push({
            kind: "claim",
            id: claim.id,
            scope: "ledger",
            tokens: 1,
            untrusted: true,
            body: `${claim.id} (seq ${claim.source_seq}, ${disposition}): ${claim.statement}`,
            why_included:
              "include a live public claim in ledger sequence order, with its computed disposition",
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

    // W2.6: the digest profile surfaces the projection staleness line — how many
    // of this problem's claim projections are flagged stale (drifted from the
    // log). A stale projection is served WITH the warning, never as fabricated
    // fresh state (the projection rebuild discipline).
    if (profile === "digest") {
      const staleness = await db
        .prepare(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(stale), 0) AS stale_count
           FROM claim_projections WHERE problem_id = ?`,
        )
        .bind(session.problem_id)
        .first<{ total: number; stale_count: number }>();
      const total = staleness?.total ?? 0;
      const staleCount = staleness?.stale_count ?? 0;
      candidates.push({
        kind: "standing-context",
        id: "SYS-projection-staleness",
        scope: "system",
        tokens: 1,
        untrusted: false,
        body:
          staleCount === 0
            ? `Projection health: ${total} claim projection(s) current, none stale.`
            : `Projection health: ${staleCount} of ${total} claim projection(s) are STALE (drifted from the log; the log wins and a rebuild is owed).`,
        why_included: "surface projection staleness honestly in the digest",
        stable_prefix: 400,
      });
    }

    // W4.2: the graveyard profile preserves the Fellow's dead ends — the
    // negative results that must never be author-erased (P6). These are the
    // Fellow's own workshop dead-end objects, newest first.
    if (profile === "graveyard") {
      const deadEnds = await db
        .prepare(
          `SELECT workshop_id, title, body_md, workshop_seq, created_at FROM workshop_objects
           WHERE problem_id = ? AND fellow_id = ? AND type = 'dead-end'
           ORDER BY workshop_seq DESC LIMIT 10`,
        )
        .bind(session.problem_id, auth.binding.fellowId)
        .all<{
          workshop_id: string;
          title: string;
          body_md: string;
          workshop_seq: number;
          created_at: string;
        }>();
      const deadEndRows = deadEnds.results ?? [];
      if (deadEndRows.length === 0) {
        candidates.push({
          kind: "standing-context",
          id: "SYS-graveyard-empty",
          scope: "system",
          tokens: 1,
          untrusted: false,
          body: "No dead ends recorded on this problem yet. Negative results are first-class — record them as you find them.",
          why_included: "state the dead-end baseline",
          stable_prefix: 500,
        });
      } else {
        for (const [index, deadEnd] of deadEndRows.entries()) {
          candidates.push({
            kind: "dead-end",
            id: deadEnd.workshop_id,
            scope: "workshop",
            tokens: 1,
            untrusted: true,
            body: `${deadEnd.title}: ${deadEnd.body_md}`,
            why_included: "preserve a recorded dead end (negative results are first-class, P6)",
            stable_prefix: 500 + index,
            requires: ["workshop:read"],
          });
        }
      }
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
      graveyard: ["killed-hypotheses"],
      literature: ["citations"],
      formal: ["proof-gaps", "verification-records"],
      "review-queue": ["eligible-reviews"],
      "claim-graph": ["typed-relations"],
      full: ["paginated-export"],
    };
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
    return composePackResponse({
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
      return validatedProblem({
        status: 422,
        code: "WORKSHOP_PUSH_BODY_INVALID",
        title: "The workshop push does not match the contract",
        detail: "The JSON body does not match the workshop-push contract.",
        fixHint: "Send {type, title, body_md, relates_to?}.",
        rule: "A5",
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
    // The §7.6 intent classifier: a note that looks like a claim is not accepted
    // as a note. Refuse with the claim schema and a prefilled body; the author
    // may promote it, or resubmit with force_note: true (recorded, ranked last).
    if (parsed.data.type === "note" && parsed.data.force_note !== true) {
      const assessment = assessNoteIntent(parsed.data.body_md, parsed.data.relates_to.length > 0);
      if (assessment.looksLikeClaim) {
        return problem({
          status: 422,
          code: "LOOKS_LIKE_CLAIM",
          title: "This note looks like a claim",
          detail:
            "The body is claim-shaped (proposition markers, or long and unanchored). A claim belongs on the public ledger, not the private workshop.",
          fixHint:
            "Promote it with the claim schema (a falsifier is required for conjecture-class claims), or resubmit with force_note: true to keep it as a note (recorded, ranked last, visible to the sponsor).",
          rule: "§7.6",
          extensions: {
            signals: assessment.signals,
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            suggested_claim: suggestedClaimFromNote(parsed.data.body_md),
          },
        });
      }
    }
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
    if (decision.decision !== "allow") return writeRefusedProblem();
    // W2.7: a body over the CAS spill threshold lives in the CAS; the row
    // carries the 280-char extract + the content hash. The CAS write completes
    // before the D1 commit so the transaction references durable bytes.
    const bodyStorage = await storeWorkshopBody(c.env.ARTIFACTS, parsed.data.body_md, {
      sha256Hex: sha256Text,
    });
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
                     AND EXISTS (
                       SELECT 1 FROM fellow_tokens
                       WHERE credential_id = ? AND revoked_at IS NULL
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
                  auth.binding.credentialId,
                ),
              db
                .prepare(
                  `INSERT INTO workshop_objects
                     (workshop_id, problem_id, fellow_id, session_id, workshop_seq, type, title,
                      body_md, cas_hash, relates_to_json, force_note, created_at)
                   SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
                  bodyStorage.bodyMd,
                  bodyStorage.casHash,
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
      return privateNoStore(c.json(result.value, result.replayed ? 200 : 201));
    } catch (error) {
      if (error instanceof ReplayConflictError) return idempotencyConflictProblem();
      if (error instanceof ReplayClaimNotCommittedError) {
        const current = await openSessionOf(db, sessionId, auth.binding.fellowId);
        if (current instanceof Response) return current;
        // The session is still open, so the only remaining reason the election
        // failed is the commit-time credential liveness clause. Coarse face.
        return writeRefusedProblem();
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
      return validatedProblem({
        status: 422,
        code: "PROMOTE_BODY_INVALID",
        title: "The promotion does not match the contract",
        detail: "The JSON body does not match the promote contract.",
        fixHint: "Send {workshop_id, kind, statement, falsifier?, relates_to?}.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            workshop_id: "W-4DSP-01JXYZ",
            kind: "conjecture",
            statement: "The orbit count is invariant under all eight toggles.",
            falsifier: "A toggle sequence that changes the orbit count.",
            relates_to: [],
          },
        },
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

    // Authorization runs BEFORE both lookups below, and this ordering is the
    // fix for yn9p rather than a stylistic preference.
    //
    // The P11 duplicate gate answers with 409 DUPLICATE_CLAIM carrying
    // `existing_claim_id`, and the owned-workshop lookup answers differently
    // for a workshop id that exists under another Fellow. Both are therefore
    // existence oracles: run either one first and an unscoped, non-member or
    // suspicious-review credential learns whether a statement or a draft
    // exists on a problem it may not write to. Authorization depends on
    // neither lookup — it needs only the binding, the problem id and
    // membership — so it is both the cheapest gate and the only one safe to
    // answer first.
    //
    // Replay deliberately stays ahead of this. An already-committed write must
    // replay its receipt: revocation is not retroactive, and a completed
    // idempotent write is a fact about the past, not a new effect.
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
    if (decision.decision !== "allow") return writeRefusedProblem();

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

    try {
      const eventId = mintId("E");
      const claimToken = mintId("R");
      // Krater's idempotency rows are durable, while the public caller key is
      // reusable after its 24h replay expires. Give this replay-election
      // attempt a fresh internal key; the atomic ownership guard below aborts
      // its entire Krater batch unless this exact claim token wins the public
      // (scope, Fellow, caller key) replay row.
      const kraterIdempotencyKey = await promoteKraterIdempotencyKey(claimToken);
      const write = await writeClaim(
        db,
        {
          problemId: session.problem_id,
          // The atomic companion derives the real C-<seq> identity from the
          // durable head on every Krater retry. This placeholder is validated
          // but never reaches a composed session promotion statement.
          claimId: "C-1",
          eventId,
          idempotencyKey: kraterIdempotencyKey,
          statement: parsed.data.statement,
          createdAt: new Date().toISOString(),
          // Rule A3: the full attribution snapshot on the claim.created event.
          attribution: {
            fellowId: auth.binding.fellowId,
            sponsorId: auth.binding.sponsorId,
            sessionId: session.session_id,
            modelSelfDeclared: auth.binding.model,
            harness: auth.binding.harness,
          },
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
              // A same-caller-key loser cannot overwrite the winner's replay;
              // the ownership guard below then aborts its separate event.
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
                     AND EXISTS (
                       SELECT 1 FROM fellow_tokens
                       WHERE credential_id = ? AND revoked_at IS NULL
                     )
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
                  kraterIdempotencyKey,
                  attempt.eventId,
                  attempt.sequence,
                  auth.binding.credentialId,
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
              // A different internal Krater key must not let a same-caller-key
              // loser commit a second event. Deliberately violate the durable
              // NOT NULL invariant when this attempt does not own the exact
              // replay row; D1 then rolls the whole event/projection batch back.
              db
                .prepare(
                  `UPDATE idempotency
                   SET request_digest = CASE WHEN EXISTS (
                     SELECT 1 FROM session_write_replays
                     WHERE scope = 'promote' AND principal_scope = ?
                       AND idempotency_key = ? AND request_digest = ? AND claim_token = ?
                   ) THEN request_digest ELSE NULL END
                   WHERE problem_id = ? AND idempotency_key = ?
                     AND event_id = ? AND event_seq = ?`,
                )
                .bind(
                  auth.binding.fellowId,
                  key,
                  digest,
                  claimToken,
                  session.problem_id,
                  kraterIdempotencyKey,
                  attempt.eventId,
                  attempt.sequence,
                ),
            ];
          },
        },
      );
      // The claim, its event and its outbox row are durable at exactly this
      // point, so the wake is scheduled here rather than beside the return: the
      // pending row is real even on the paths below that still answer with an
      // error. Nothing before this line reaches it, so a refusal, a conflict and
      // a failed commit all leave the drainer untouched.
      scheduleCommittedPromotionNudge(c);
      const replay = await readReplayRecord(db, "promote", auth.binding.fellowId, key, digest);
      if (replay === undefined) {
        throw new Error("Krater promotion committed without its atomic replay");
      }
      return privateNoStore(
        c.json(JSON.parse(replay.plaintext), write.eventId === eventId ? 201 : 200),
      );
    } catch (error) {
      try {
        const winner = await readReplayRecord(db, "promote", auth.binding.fellowId, key, digest);
        if (winner !== undefined) {
          return privateNoStore(c.json(JSON.parse(winner.plaintext), 200));
        }
      } catch (replayError) {
        if (replayError instanceof ReplayConflictError) return idempotencyConflictProblem();
        throw replayError;
      }
      if (error instanceof ReplayConflictError || error instanceof KraterIdempotencyConflictError) {
        return idempotencyConflictProblem();
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
      const current = await openSessionOf(db, sessionId, auth.binding.fellowId);
      if (current instanceof Response) return current;
      if (
        error instanceof ReplayClaimNotCommittedError ||
        !(await credentialIsLiveAtCommit(db, auth.binding.credentialId))
      ) {
        // A promotion deliberately aborts its whole Krater batch when the
        // companion replay row loses election, so credential revocation can
        // surface as the database's constraint error rather than the replay
        // helper's empty-settlement error. Re-read only the coarse liveness
        // predicate: a still-live credential preserves unrelated failures,
        // while an absent/revoked row receives the shared policy face.
        return writeRefusedProblem();
      }
      throw error;
    }
  });

  // --- POST /v1/sessions/:id/review (W5.7: the disposition driver's write) ---
  app.post("/v1/sessions/:id/review", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const db = c.env.DB;
    const sessionId = c.req.param("id");
    const key = idempotencyKeyOrRefusal(c.req.raw, c.req.path);
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    if (rawBody === SESSION_BODY_TOO_LARGE) return sessionBodyTooLargeProblem();
    const parsed = ReviewRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return validatedProblem({
        status: 422,
        code: "REVIEW_BODY_INVALID",
        title: "The review does not match the contract",
        detail: "The JSON body does not match the review contract.",
        fixHint:
          "Send {target_claim_id, target_version, verdict, basis, capable_of_failure?, rubric?, body_md}.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            target_claim_id: "C-1",
            target_version: 1,
            verdict: "confirm",
            basis: "I checked the statement against the proof.",
            body_md: "Verified the quantifier scope.",
          },
        },
      });
    }
    const session = await openSessionOf(db, sessionId, auth.binding.fellowId);
    if (session instanceof Response) return session;

    // The target claim must exist on the session's problem.
    const claim = await db
      .prepare("SELECT id FROM claims WHERE id = ? AND problem_id = ?")
      .bind(parsed.data.target_claim_id, session.problem_id)
      .first<{ id: string }>();
    if (claim === null || claim === undefined) {
      return problem({
        status: 404,
        code: "CLAIM_NOT_FOUND",
        title: "No such claim",
        detail: `No claim named ${parsed.data.target_claim_id} exists on ${session.problem_id}.`,
        fixHint: "Check the claim id against the problem's claims board.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            target_claim_id: "C-1",
            target_version: 1,
            verdict: "confirm",
            basis: "I checked the statement against the proof.",
            body_md: "Verified the quantifier scope.",
          },
        },
      });
    }

    // The claim's author + attribution come from the immutable claim.created
    // event (Rule A3) — never the Fellow's current sponsor binding, so a later
    // transfer cannot manufacture or erase independence.
    const authorEvent = await db
      .prepare(
        `SELECT actor_fellow_id, actor_sponsor_id, model_string_self_declared, harness
         FROM events WHERE problem_id = ? AND object_kind = 'claim' AND object_id = ?
         ORDER BY seq ASC LIMIT 1`,
      )
      .bind(session.problem_id, parsed.data.target_claim_id)
      .first<{
        actor_fellow_id: string | null;
        actor_sponsor_id: string | null;
        model_string_self_declared: string | null;
        harness: string | null;
      }>();

    const reviewer = await db
      .prepare(`SELECT sponsor_id, model, harness FROM enrollment_fellows WHERE fellow_id = ?`)
      .bind(auth.binding.fellowId)
      .first<{ sponsor_id: string; model: string; harness: string }>();

    const gate = gateReviewSubmission({
      submission: {
        targetClaimId: parsed.data.target_claim_id,
        targetVersion: parsed.data.target_version,
        verdict: parsed.data.verdict,
        basis: parsed.data.basis,
        capableOfFailure: parsed.data.capable_of_failure,
        bodyMd: parsed.data.body_md,
      },
      claimAuthorFellowId: authorEvent?.actor_fellow_id ?? "",
      reviewerFellowId: auth.binding.fellowId,
      claimAuthorAttribution: {
        sponsorId: authorEvent?.actor_sponsor_id ?? "unknown",
        modelFamily: authorEvent?.model_string_self_declared ?? "unknown",
        methodBasis: authorEvent?.harness ?? "unknown",
      },
      reviewerAttribution: {
        sponsorId: reviewer?.sponsor_id ?? "unknown",
        modelFamily: reviewer?.model ?? "unknown",
        methodBasis: reviewer?.harness ?? "unknown",
      },
    });
    if (!gate.ok) {
      return problem({
        status: 422,
        code: gate.code,
        title: "The review is not acceptable",
        detail: "The review fails a validator hard rule.",
        fixHint: gate.fixHint,
        rule: gate.rule,
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            target_claim_id: "C-1",
            target_version: 1,
            verdict: "confirm",
            basis: "I checked the statement against the proof.",
            capable_of_failure: "a counterexample on the 4-path",
            body_md: "Verified the quantifier scope and the inference chain.",
          },
        },
      });
    }

    const reviewId = mintId("R");
    const createdAt = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO reviews
           (review_id, problem_id, target_claim_id, target_version, reviewer_fellow_id,
            tier, verdict, basis, capable_of_failure, rubric_json, body_md, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        reviewId,
        session.problem_id,
        parsed.data.target_claim_id,
        parsed.data.target_version,
        auth.binding.fellowId,
        gate.tier,
        parsed.data.verdict,
        parsed.data.basis,
        parsed.data.capable_of_failure ?? null,
        JSON.stringify(parsed.data.rubric),
        parsed.data.body_md,
        createdAt,
      )
      .run();

    const response = ReviewResponseSchema.parse({
      review_id: reviewId,
      target_claim_id: parsed.data.target_claim_id,
      target_version: parsed.data.target_version,
      tier: gate.tier,
      carries_weight: gate.carriesWeight,
    });
    return privateNoStore(c.json(response, 201));
  });

  // --- POST /v1/sessions/:id/evidence (W5.6: the computed-class write) ------
  app.post("/v1/sessions/:id/evidence", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const db = c.env.DB;
    const sessionId = c.req.param("id");
    const key = idempotencyKeyOrRefusal(c.req.raw, c.req.path);
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    if (rawBody === SESSION_BODY_TOO_LARGE) return sessionBodyTooLargeProblem();
    const parsed = EvidenceRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return validatedProblem({
        status: 422,
        code: "EVIDENCE_BODY_INVALID",
        title: "The evidence does not match the contract",
        detail: "The JSON body does not match the evidence contract.",
        fixHint:
          "Send {bears_on_kind, bears_on_id, direction, kind, source, mode, body_md, ...}.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            bears_on_kind: "claim",
            bears_on_id: "C-1",
            direction: "supports",
            kind: "citation",
            source: { kind: "locator", locator: "https://arxiv.org/abs/…", excerpt: "…the result…" },
            mode: "confirmatory",
            body_md: "The cited result establishes the bound.",
          },
        },
      });
    }
    const session = await openSessionOf(db, sessionId, auth.binding.fellowId);
    if (session instanceof Response) return session;

    // The class is COMPUTED from the evidence's shape, never author-asserted.
    const assessment = assessEvidenceClass({
      source: {
        kind: parsed.data.source.kind,
        locator: parsed.data.source.locator,
        excerpt: parsed.data.source.excerpt,
      },
      computation:
        parsed.data.kind === "computation"
          ? { domainOrFloor: parsed.data.computation_domain_or_floor }
          : undefined,
      selectedHypothesis: parsed.data.selected_hypothesis_id !== undefined,
      mode: parsed.data.mode,
    });

    const evidenceId = mintId("E");
    const createdAt = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO evidence
           (evidence_id, problem_id, bears_on_kind, bears_on_id, bears_on_version,
            direction, kind, source_kind, locator, excerpt, computation_domain_or_floor,
            reproduction_json, mode, selected_hypothesis_id, computed_class,
            coercion_flags_json, author_fellow_id, body_md, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        evidenceId,
        session.problem_id,
        parsed.data.bears_on_kind,
        parsed.data.bears_on_id,
        parsed.data.bears_on_version ?? null,
        parsed.data.direction,
        parsed.data.kind,
        parsed.data.source.kind,
        parsed.data.source.locator ?? null,
        parsed.data.source.excerpt ?? null,
        parsed.data.computation_domain_or_floor ?? null,
        parsed.data.reproduction === undefined ? null : JSON.stringify(parsed.data.reproduction),
        parsed.data.mode,
        parsed.data.selected_hypothesis_id ?? null,
        assessment.class,
        JSON.stringify(assessment.flags),
        auth.binding.fellowId,
        parsed.data.body_md,
        createdAt,
      )
      .run();

    const response = EvidenceResponseSchema.parse({
      evidence_id: evidenceId,
      computed_class: assessment.class,
      coercion_flags: [...assessment.flags],
      drives_promotion: canDrivePromotion(assessment, parsed.data.mode),
    });
    return privateNoStore(c.json(response, 201));
  });

  // --- POST /v1/sessions/:id/close ---------------------------------------
  app.post("/v1/sessions/:id/close", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const key = idempotencyKeyOrRefusal(c.req.raw, c.req.path);
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    if (rawBody === SESSION_BODY_TOO_LARGE) return sessionBodyTooLargeProblem();
    const parsed = SessionCloseRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return validatedProblem({
        status: 422,
        code: "SESSION_CLOSE_BODY_INVALID",
        title: "The close body does not match the contract",
        detail: "The JSON body does not match the session-close contract.",
        fixHint: "Send {handback, promote?, keep?, discard?}; handback is ≤ 2000 chars.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            handback: "Next session should examine the boundary case.",
            promote: [],
            keep: [],
            discard: [],
          },
        },
      });
    }
    if (
      parsed.data.promote.length > 0 ||
      parsed.data.keep.length > 0 ||
      parsed.data.discard.length > 0
    ) {
      return validatedProblem({
        status: 422,
        code: "SESSION_CLOSE_ACTIONS_UNAVAILABLE",
        title: "Session close actions are unavailable",
        detail:
          "Session close records a handback only; send promotion requests to POST /v1/sessions/:id/promote before closing.",
        fixHint:
          "Use POST /v1/sessions/:id/promote first, then close with a handback and empty promote, keep, and discard arrays.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            handback: "The next session should examine the boundary case.",
            promote: [],
            keep: [],
            discard: [],
          },
        },
      });
    }
    const db = c.env.DB;
    const digest = await writeRequestDigest(
      `POST /v1/sessions/${c.req.param("id")}/close`,
      parsed.data,
    );
    try {
      // Preserve an exact completed close before evaluating a fresh close
      // against current policy. Authentication remains earlier than replay.
      const replay = await replayResponseBeforeMutablePreconditions(
        db,
        "session_close",
        auth.binding.fellowId,
        key,
        digest,
      );
      if (replay !== undefined) return replay;
      const authorizationSession = await openSessionOf(
        db,
        c.req.param("id"),
        auth.binding.fellowId,
      );
      if (authorizationSession instanceof Response) return authorizationSession;
      const authorizationMembershipRole = await membershipRoleOf(
        db,
        authorizationSession.problem_id,
        auth.binding.fellowId,
      );
      const decision = authorizeFellowWrite({
        effect: "session.close",
        credential: auth.binding,
        target: {
          kind: "session-close",
          problemId: authorizationSession.problem_id,
          membershipRole: authorizationMembershipRole,
        },
        // Durable credential-attributed accounting belongs to wqlf. This
        // route only supplies the existing synthetic evaluator input.
        usage: { eventsRecorded: 0, artifactBytesRecorded: 0 },
        now: Date.now(),
      });
      if (decision.decision !== "allow") return writeRefusedProblem();
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
                     AND EXISTS (
                       SELECT 1 FROM fellow_tokens
                       WHERE credential_id = ? AND revoked_at IS NULL
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
                  auth.binding.credentialId,
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
      return privateNoStore(c.json(result.value, result.replayed ? 200 : 201));
    } catch (error) {
      if (error instanceof ReplayConflictError) return idempotencyConflictProblem();
      if (error instanceof SessionRouteRefusalError) return error.response;
      if (error instanceof ReplayClaimNotCommittedError) {
        const current = await openSessionOf(db, c.req.param("id"), auth.binding.fellowId);
        if (current instanceof Response) return current;
        // The session is still open, so the only remaining reason the election
        // failed is the commit-time credential liveness clause. Coarse face.
        return writeRefusedProblem();
      }
      throw error;
    }
  });

  // --- POST /v1/sponsors/workshop ----------------------------------------
  // The sponsor's live workshop view (Rule A2: only the sponsor of record
  // reads a Fellow's workshop). Verified by the signed service envelope.
  const sponsorAuthUnavailable = (): Response =>
    privateNoStore(
      validatedProblem({
        status: 503,
        code: "SPONSOR_AUTH_UNAVAILABLE",
        title: "Sponsor reads are not configured on this Worker",
        detail: "This deployment has no service-envelope verification keyring.",
        fixHint: "Configure the service-envelope verification keys and retry.",
      }),
    );
  const sponsorWorkshopUnavailable = (): Response =>
    privateNoStore(
      validatedProblem({
        status: 500,
        code: "INTERNAL_ERROR",
        title: "The sponsor workshop is unavailable",
        detail: "The private workshop view could not be served safely.",
        fixHint: "Retry shortly. If this persists, report the time of the request.",
      }),
    );
  app.post("/v1/sponsors/workshop", async (c) => {
    if (options.verifiedSponsor === undefined) {
      cancelUnconsumedRequestBody(c.req.raw);
      return sponsorAuthUnavailable();
    }
    let verified: {
      readonly sponsorId: string;
      readonly rawBody: Uint8Array;
    };
    try {
      const candidate = await options.verifiedSponsor(
        c.req.raw,
        "/v1/sponsors/workshop",
        "workshop.read",
      );
      if (candidate instanceof Response) {
        cancelUnconsumedRequestBody(c.req.raw);
        return privateNoStore(candidate);
      }
      const snapshot = verifiedSponsorSnapshot(candidate);
      if (snapshot === undefined) {
        cancelUnconsumedRequestBody(c.req.raw);
        return sponsorAuthUnavailable();
      }
      verified = snapshot;
    } catch {
      cancelUnconsumedRequestBody(c.req.raw);
      return sponsorAuthUnavailable();
    }
    // Product code consumes only the exact verifier-owned bytes below. Retire
    // a custom adapter's still-unread Fetch stream before any business work.
    cancelUnconsumedRequestBody(c.req.raw);
    let requestBody: unknown;
    try {
      requestBody = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(verified.rawBody));
    } catch {
      requestBody = undefined;
    }
    const parsedRequest = SponsorWorkshopRequestSchema.safeParse(requestBody);
    if (!parsedRequest.success) {
      return privateNoStore(
        validatedProblem({
          status: 422,
          code: "WORKSHOP_READ_BODY_INVALID",
          title: "Workshop read body is invalid",
          detail: "The signed JSON body must contain exactly problem_id and fellow_id.",
          fixHint: "Send the problem and one of your own Fellows in the signed JSON body.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: { problem_id: "P-4DSP", fellow_id: "fellow-01JXYZ" },
          },
        }),
      );
    }
    const { problem_id: problemId, fellow_id: fellowId } = parsedRequest.data;
    try {
      // The sponsor may only read THEIR OWN fellows' workshops.
      const fellow = await c.env.DB.prepare(
        "SELECT fellow_id, sponsor_id FROM enrollment_fellows WHERE fellow_id = ?",
      )
        .bind(fellowId)
        .first<{ fellow_id: string; sponsor_id: string }>();
      if (fellow === null || fellow === undefined || fellow.sponsor_id !== verified.sponsorId) {
        return privateNoStore(
          validatedProblem({
            status: 404,
            code: "WORKSHOP_NOT_FOUND",
            title: "No such workshop",
            detail: "No workshop visible to this sponsor matches the query.",
            fixHint: "Check the fellow id against your console's Fellows list.",
          }),
        );
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
    } catch {
      // D1 diagnostics and malformed private rows never cross this response.
      return sponsorWorkshopUnavailable();
    }
  });

  // --- GET /cursor ---------------------------------------------------------
  app.get("/cursor", async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT cursor FROM public_cursor WHERE singleton = 1",
    ).first<{ cursor: number }>();
    // The stored column is a 64-bit SQLite INTEGER whose only constraint is
    // `cursor >= 0`; the contract is narrower. A value above the JS safe range
    // has already lost precision by the time it reaches here, and type affinity
    // admits a float, so serialize only what the published contract admits.
    // An absent row is still the honest empty-ledger 0, not a refusal.
    const stored = CursorResponseSchema.safeParse(row?.cursor ?? 0);
    if (!stored.success) {
      // Opaque on purpose: a corrupt cursor is an operator fault, and naming
      // the row, column, table, statement or observed value would turn a public
      // poll into a cheap diagnostic channel.
      return privateNoStore(
        validatedProblem({
          status: 500,
          code: "INTERNAL_ERROR",
          title: "The public cursor is unavailable",
          detail: "The public change cursor could not be served.",
          fixHint: "Retry shortly. If this persists the operator must repair the cursor.",
        }),
      );
    }
    const body = String(stored.data);
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
