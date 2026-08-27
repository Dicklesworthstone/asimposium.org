import {
  CursorResponseSchema,
  EvidenceRequestSchema,
  EvidenceResponseSchema,
  GapClosedResponseSchema,
  GapFiledResponseSchema,
  GapFileRequestSchema,
  GapTransitionRequestSchema,
  HypothesisKillRequestSchema,
  HypothesisKillResponseSchema,
  HypothesisRequestSchema,
  HypothesisResponseSchema,
  type PackProfile,
  PackResponseSchema,
  PromoteRequestSchema,
  PromoteResponseSchema,
  RelationFiledResponseSchema,
  RelationFileRequestSchema,
  ReviewRequestSchema,
  ReviewResponseSchema,
  ReviseRequestSchema,
  ReviseResponseSchema,
  SCREENING_APPEAL_CODE,
  type ScreeningCoarseCategory,
  ScreeningCoarseCategorySchema,
  type ScreeningOutcome,
  ScreeningOutcomeSchema,
  ScreeningPromotionDeniedResponseSchema,
  ScreeningPromotionHoldResponseSchema,
  type ScreeningProviderStatus,
  ScreeningProviderStatusSchema,
  ScreeningPublicActionSchema,
  SessionCloseRequestSchema,
  SessionCloseResponseSchema,
  SessionOpenRequestSchema,
  SessionOpenResponseSchema,
  SPONSOR_WORKSHOP_MAX_RESPONSE_BYTES,
  SPONSOR_WORKSHOP_PAGE_LIMIT,
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
import { mintClaimVersion } from "../krater/claim-version";
import { assessNoteIntent, suggestedClaimFromNote } from "../krater/intent";
import {
  canonicalJson,
  KraterIdempotencyConflictError,
  KraterLedgerPreconditionError,
  KraterProblemNotFoundError,
  readCursor,
  writeClaim,
  writeClaimRevision,
  writeGapEvent,
  writeLedgerEvent,
  writeRelationEvent,
} from "../krater/krater";
import { KRATER_OUTBOX_NUDGE_DEADLINE_MS, requestKraterOutbox } from "../krater/outbox-do";
import { computeCurrentClaimDisposition } from "../ledger/disposition-read";
import { displayClaimDisposition } from "../ledger/dispositions";
import { assessEvidenceClass, canDrivePromotion } from "../ledger/evidence-class";
import { parseRelationTarget } from "../ledger/relations";
import { gateReviewSubmission } from "../ledger/review-gate";
import { screenPromotionWithWorkersAI, type WorkersAiBinding } from "../screening/workers-ai";
import {
  duplicateClaimRefusal,
  normHash,
  rejectAuthoritativeFields,
  sha256Hex,
} from "../split/policy";

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
    seal(plaintext: string, context?: string): Promise<EncryptedEnrollmentReplay>;
    open(encrypted: EncryptedEnrollmentReplay, context?: string): Promise<string>;
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
  /**
   * Promotion-time policy seam. Production omits this override and uses the
   * Worker's AI binding; local tests inject a deterministic decision.
   */
  readonly screenPromotion?: PromotionScreener;
}

export interface PromotionScreeningInput {
  readonly problemId: string;
  readonly fellowId: string;
  readonly kind: string;
  readonly statement: string;
  readonly falsifier: string | null;
}

export interface PromotionScreeningDecision {
  readonly decision: ScreeningOutcome;
  readonly coarse_category: ScreeningCoarseCategory;
  readonly provider_status: ScreeningProviderStatus;
}

export type PromotionScreener = (
  input: PromotionScreeningInput,
  env: Env,
) => Promise<PromotionScreeningDecision>;

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

async function ledgerKraterIdempotencyKey(scope: string, claimToken: string): Promise<string> {
  return `session-ledger-v1:${await sha256Text(`session-ledger-v1\0${scope}\0${claimToken}`)}`;
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
    return validatedProblem({
      status: 400,
      code: "INVALID_PACK_BUDGET",
      title: "The pack token budget is invalid",
      detail: "max_tokens must be a positive base-10 safe integer.",
      fixHint: `Request at most ${PACK_BUDGET_BUCKETS.at(-1)} tokens; the server rounds upward to a fixed cache bucket.`,
      rule: "A5",
      extensions: {
        schema: "https://a.asimposium.org/schemas/sessions.v1.json",
        example: { max_tokens: PACK_BUDGET_BUCKETS.at(-1) },
      },
    });
  }
  const requested = Number(raw);
  const maximum = PACK_BUDGET_BUCKETS.at(-1);
  if (!Number.isSafeInteger(requested) || maximum === undefined || requested > maximum) {
    return validatedProblem({
      status: 400,
      code: "INVALID_PACK_BUDGET",
      title: "The pack token budget is invalid",
      detail: `max_tokens must be no greater than ${maximum ?? 8000}.`,
      fixHint: `Use one of the fixed buckets directly, or request a positive value that rounds up to one: ${PACK_BUDGET_BUCKETS.join(", ")}.`,
      rule: "A5",
      extensions: {
        schema: "https://a.asimposium.org/schemas/sessions.v1.json",
        example: { max_tokens: PACK_BUDGET_BUCKETS.at(-1) },
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

interface PackClaimEventRow {
  readonly claim_id: string;
  readonly seq: number;
  readonly type: string;
  readonly object_version: number;
}

interface PackReviewRow {
  readonly claim_id: string;
  readonly review_id: string;
  readonly reviewer_fellow_id: string;
  readonly tier: "T0" | "T1" | "T2" | "T3";
  readonly verdict: string;
  readonly target_version: number;
  readonly capable_of_failure: string | null;
  readonly source_seq: number;
}

interface PackRefutingEvidenceRow {
  readonly claim_id: string;
  readonly evidence_id: string;
  readonly bears_on_version: number;
  readonly source_seq: number;
}

function groupPackRows<Row>(
  rows: readonly Row[],
  claimIdOf: (row: Row) => string,
): ReadonlyMap<string, readonly Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const claimId = claimIdOf(row);
    const existing = grouped.get(claimId);
    if (existing === undefined) grouped.set(claimId, [row]);
    else existing.push(row);
  }
  return grouped;
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
  type SessionPreparedStatement = ReturnType<Env["DB"]["prepare"]>;

  const screenPromotion: PromotionScreener =
    options.screenPromotion ??
    ((input, env) =>
      screenPromotionWithWorkersAI(env.AI as unknown as WorkersAiBinding | undefined, input));

  const promotionScreeningHold = (category: ScreeningCoarseCategory): Response =>
    privateNoStore(
      new Response(
        JSON.stringify(
          ScreeningPromotionHoldResponseSchema.parse({
            code: "SCREENING_HOLD",
            coarse_category: category,
            appeal: SCREENING_APPEAL_CODE,
          }),
        ),
        {
          status: 202,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      ),
    );

  const promotionScreeningDenied = (category: ScreeningCoarseCategory): Response | undefined => {
    const parsed = ScreeningPromotionDeniedResponseSchema.safeParse({
      code: "POLICY_DENIED",
      coarse_category: category,
      appeal: SCREENING_APPEAL_CODE,
    });
    if (!parsed.success) return undefined;
    return privateNoStore(
      new Response(JSON.stringify(parsed.data), {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
  };

  type ReplayScope =
    | "session_open"
    | "workshop_push"
    | "promote"
    | "revise"
    | "gaps"
    | "relations"
    | "review"
    | "hypotheses"
    | "hypothesis-kill"
    | "evidence"
    | "session_close";

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

  /**
   * asimposiumorg-zdz.8: the versioned AEAD context binding every sealed
   * session replay to exactly one replay identity. A ciphertext copied to any
   * other row (other scope, principal, route, key, or body) fails GCM
   * authentication under this additional data instead of replaying.
   */
  const sessionReplayContext = (
    scope: ReplayScope,
    principal: string,
    target: string,
    key: string,
    requestDigest: string,
  ): string =>
    JSON.stringify({
      v: 1,
      scope,
      principal,
      target,
      idempotency_key: key,
      request_digest: requestDigest,
    });

  async function readReplayRecord(
    db: Env["DB"],
    scope: ReplayScope,
    principal: string,
    key: string,
    requestDigest: string,
    target: string,
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
    const openContext = sessionReplayContext(scope, principal, target, key, requestDigest);
    return {
      plaintext: await options.replayProtector.open(
        {
          ciphertext: existing.response_ciphertext,
          initializationVector: existing.response_initialization_vector,
        },
        openContext,
      ),
      claimToken: existing.claim_token,
    };
  }

  async function replayResponseBeforeMutablePreconditions(
    db: Env["DB"],
    scope: ReplayScope,
    principal: string,
    key: string,
    requestDigest: string,
    target: string,
    parse: (raw: string) => unknown,
  ): Promise<Response | undefined> {
    const replay = await readReplayRecord(db, scope, principal, key, requestDigest, target);
    if (replay === undefined) return undefined;
    // The exact route response schema is the replayed bytes' exit gate: a row
    // that authenticates but does not satisfy the contract this route serves
    // is refused here, before any 200 is built from it.
    parse(replay.plaintext);
    return privateNoStore(
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
    target: string,
    parse: (raw: string) => T,
    prepare: (claimToken: string) => Promise<ReplayMutation<T>>,
    retryAfterRollback?: (error: unknown) => boolean,
  ): Promise<{ replayed: boolean; value: T }> {
    for (let attempt = 0; attempt <= 16; attempt += 1) {
      const existing = await readReplayRecord(db, scope, principal, key, requestDigest, target);
      if (existing !== undefined) {
        return { replayed: true, value: parse(existing.plaintext) };
      }
      const claimToken = mintId("R");
      const mutation = await prepare(claimToken);
      const sealed = await options.replayProtector.seal(
        JSON.stringify(mutation.value),
        sessionReplayContext(scope, principal, target, key, requestDigest),
      );
      try {
        await db.batch([...mutation.statements(sealed, claimToken)]);
      } catch (error) {
        const winner = await readReplayRecord(db, scope, principal, key, requestDigest, target);
        if (winner !== undefined) {
          return { replayed: true, value: parse(winner.plaintext) };
        }
        if (attempt < 16 && retryAfterRollback?.(error) === true) continue;
        throw error;
      }
      const settled = await readReplayRecord(db, scope, principal, key, requestDigest, target);
      if (settled === undefined) throw new ReplayClaimNotCommittedError();
      return {
        replayed: settled.claimToken !== claimToken,
        value: parse(settled.plaintext),
      };
    }
    throw new Error("session replay retry budget exhausted");
  }

  function atomicLedgerReplayCompanion<T>(input: {
    readonly db: Env["DB"];
    readonly scope: Extract<ReplayScope, "review" | "hypotheses" | "hypothesis-kill" | "evidence">;
    readonly principal: string;
    readonly target: string;
    readonly callerKey: string;
    readonly requestDigest: string;
    readonly claimToken: string;
    readonly kraterIdempotencyKey: string;
    readonly credentialId: string;
    readonly session: SessionRow;
    readonly responseFor: (settlement: {
      readonly sequence: number;
      readonly objectId: string;
      readonly eventId: string;
    }) => T;
  }) {
    return {
      requestDigest: input.requestDigest,
      statementsAfterIdempotencySettlement: async (settlement: {
        readonly sequence: number;
        readonly claimId: string;
        readonly eventId: string;
      }) => {
        const value = input.responseFor({
          sequence: settlement.sequence,
          objectId: settlement.claimId,
          eventId: settlement.eventId,
        });
        const sealed = await options.replayProtector.seal(
          JSON.stringify(value),
          sessionReplayContext(
            input.scope,
            input.principal,
            input.target,
            input.callerKey,
            input.requestDigest,
          ),
        );
        const expiresAt = Math.floor(Date.now() / 1_000) + Math.floor(REPLAY_TTL_MS / 1_000);
        return [
          input.db
            .prepare(
              `INSERT INTO session_write_replays
                 (scope, principal_scope, idempotency_key, request_digest,
                  response_ciphertext, response_initialization_vector, expires_at, claim_token)
               SELECT ?, ?, ?,
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
              input.scope,
              input.principal,
              input.callerKey,
              input.session.session_id,
              input.principal,
              input.requestDigest,
              sealed.ciphertext,
              sealed.initializationVector,
              expiresAt,
              input.claimToken,
              input.session.problem_id,
              input.kraterIdempotencyKey,
              settlement.eventId,
              settlement.sequence,
              input.credentialId,
            ),
          input.db
            .prepare(
              `UPDATE public_cursor SET cursor = cursor + 1
               WHERE singleton = 1 AND EXISTS (
                 SELECT 1 FROM session_write_replays
                 WHERE scope = ? AND principal_scope = ?
                   AND idempotency_key = ? AND request_digest = ? AND claim_token = ?
               )`,
            )
            .bind(
              input.scope,
              input.principal,
              input.callerKey,
              input.requestDigest,
              input.claimToken,
            ),
          // Two concurrent requests can both pass the replay preflight. Only
          // the exact replay-row owner may keep its separate Krater event; a
          // loser deliberately violates idempotency.request_digest NOT NULL,
          // rolling its entire event/projection batch back.
          input.db
            .prepare(
              `UPDATE idempotency
               SET request_digest = CASE WHEN EXISTS (
                 SELECT 1 FROM session_write_replays
                 WHERE scope = ? AND principal_scope = ?
                   AND idempotency_key = ? AND request_digest = ? AND claim_token = ?
               ) THEN request_digest ELSE NULL END
               WHERE problem_id = ? AND idempotency_key = ?
                 AND event_id = ? AND event_seq = ?`,
            )
            .bind(
              input.scope,
              input.principal,
              input.callerKey,
              input.requestDigest,
              input.claimToken,
              input.session.problem_id,
              input.kraterIdempotencyKey,
              settlement.eventId,
              settlement.sequence,
            ),
        ];
      },
    };
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
    validatedProblem({
      status: 403,
      code: "WRITE_REFUSED",
      title: "The write is not authorized for this credential",
      detail: "This credential may not perform this write now.",
      fixHint: "Check the console for the credential state or contact your sponsor.",
    });

  // Fable §5.5: the global two-open-session cap (asimposiumorg-zdz.6). A
  // teaching refusal: it names the open sessions to close so the caller can
  // free a slot without a second round trip.
  const sessionCapReachedProblem = (openSessionIds: readonly string[]): Response =>
    validatedProblem({
      status: 409,
      code: "SESSION_CAP_REACHED",
      title: "The Fellow open-session cap is reached",
      detail: "A Fellow keeps at most two open sessions across all problems.",
      fixHint: "Close one of the open sessions with POST /v1/sessions/:id/close, then reopen.",
      rule: "A5",
      extensions: {
        schema: "https://a.asimposium.org/schemas/sessions.v1.json",
        open_session_ids: [...openSessionIds].slice(0, 2),
        example: {
          method: "POST",
          path: `/v1/sessions/${openSessionIds[0] ?? "<session_id>"}/close`,
          body: { handback: "Freeing a slot for the next session." },
        },
      },
    });

  async function openSessionIdsOf(db: Env["DB"], fellowId: string): Promise<string[]> {
    const rows = await db
      .prepare(
        `SELECT session_id FROM sessions
         WHERE fellow_id = ? AND closed_at IS NULL
         ORDER BY opened_at, session_id`,
      )
      .bind(fellowId)
      .all<{ session_id: string }>();
    return (rows.results ?? []).map((row) => row.session_id);
  }

  /** The 0037 trigger aborts the batch with this message at commit time. */
  const isSessionCapAbort = (error: unknown): boolean =>
    error instanceof Error && error.message.includes("SESSION_OPEN_CAP_EXCEEDED");

  /**
   * Durable grant-wide usage for the calling credential (wqlf). The count is
   * the pre-check input to authorizeFellowWrite; the 0038 trigger makes the
   * final check atomic with each event append.
   */
  async function credentialEventsRecorded(db: Env["DB"], credentialId: string): Promise<number> {
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE writer_credential_id = ?")
      .bind(credentialId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** The 0038 trigger aborts the batch with this message at commit time. */
  const isEventBudgetAbort = (error: unknown): boolean =>
    error instanceof Error && error.message.includes("EVENT_BUDGET_EXHAUSTED");

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
      return validatedProblem({
        status: 404,
        code: "SESSION_NOT_FOUND",
        title: "No such session",
        detail: "No session with this id exists.",
        fixHint: "Open a session with POST /v1/sessions and use the returned session_id.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            method: "POST",
            path: "/v1/sessions",
            body: { problem_id: "P-4DSP", intent: "work" },
          },
        },
      });
    }
    if (row.fellow_id !== fellowId) {
      return validatedProblem({
        status: 404,
        code: "SESSION_NOT_FOUND",
        title: "No such session",
        detail: "No session with this id exists.",
        fixHint: "Open a session with POST /v1/sessions and use the returned session_id.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            method: "POST",
            path: "/v1/sessions",
            body: { problem_id: "P-4DSP", intent: "work" },
          },
        },
      });
    }
    if (row.closed_at !== null) {
      return validatedProblem({
        status: 409,
        code: "SESSION_CLOSED",
        title: "The session is closed",
        detail: "A closed session accepts no reads or writes. Its handback is in the next pack.",
        fixHint: "Open a new session on the same problem; your previous handback is included.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            method: "POST",
            path: "/v1/sessions",
            body: { problem_id: "P-4DSP", intent: "work" },
          },
        },
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
      const response = validatedProblem({
        status: 404,
        code: "SESSION_NOT_FOUND",
        title: "No such session",
        detail: "No session with this id exists.",
        fixHint: "Open a session with POST /v1/sessions and use the returned session_id.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            method: "POST",
            path: "/v1/sessions",
            body: { problem_id: "P-4DSP", intent: "work" },
          },
        },
      });
      response.headers.set("cache-control", "private, no-store");
      return response;
    }
    if (row.closed_at !== null) {
      const response = validatedProblem({
        status: 409,
        code: "SESSION_CLOSED",
        title: "The session is closed",
        detail: "A closed session accepts no reads or writes. Its handback is in the next pack.",
        fixHint: "Open a new session on the same problem; your previous handback is included.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            method: "POST",
            path: "/v1/sessions",
            body: { problem_id: "P-4DSP", intent: "work" },
          },
        },
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

  // ebts: one exact-path response policy for every mounted Fellow POST
  // routes. Every response class they can emit — fresh success, exact replay,
  // auth refusal, contract refusal, policy refusal, idempotency conflict,
  // typed exceptional refusal — carries session/workshop identifiers or error
  // context, so no receipt may omit a retention prohibition. Setting the
  // header here (after the handler resolves) keeps each handler's exact
  // bytes, status, and content-type untouched, and the path list deliberately
  // excludes the public /cursor and the sponsor-owned workshop route.
  const FELLOW_WRITE_RECEIPT_PATHS = [
    "/v1/sessions",
    "/v1/sessions/:id/workshop",
    "/v1/sessions/:id/promote",
    "/v1/sessions/:id/revise",
    "/v1/sessions/:id/gaps",
    "/v1/sessions/:id/gaps/close",
    "/v1/sessions/:id/relations",
    "/v1/sessions/:id/review",
    "/v1/sessions/:id/hypotheses",
    "/v1/sessions/:id/hypotheses/:hid/kill",
    "/v1/sessions/:id/evidence",
    "/v1/sessions/:id/close",
  ] as const;
  for (const path of FELLOW_WRITE_RECEIPT_PATHS) {
    app.use(path, async (c, next) => {
      await next();
      if (c.req.method === "POST") {
        c.res.headers.set("cache-control", "private, no-store");
      }
    });
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
        c.req.path,
        (raw) => SessionOpenResponseSchema.parse(JSON.parse(raw)),
      );
      if (replay !== undefined) return replay;
      const decision = authorizeFellowWrite({
        effect: "session.open",
        credential: auth.binding,
        target: { kind: "session-admission", problemId: parsed.data.problem_id },
        // Durable credential-attributed accounting belongs to wqlf. This
        // route only supplies the existing synthetic evaluator input.
        usage: {
          eventsRecorded: await credentialEventsRecorded(db, auth.binding.credentialId),
          artifactBytesRecorded: 0,
        },
        now: Date.now(),
      });
      if (decision.decision !== "allow") return writeRefusedProblem();
      const result = await replayOrCommit(
        db,
        "session_open",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
        (raw) => SessionOpenResponseSchema.parse(JSON.parse(raw)),
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
          // Fable §5.5: at most two open sessions per Fellow across ALL
          // problems. This pre-check only picks the friendly refusal payload;
          // the commit-time trigger (0037) makes the cap binding under races.
          const openElsewhere = await db
            .prepare(
              `SELECT session_id FROM sessions
               WHERE fellow_id = ? AND closed_at IS NULL
               ORDER BY opened_at, session_id`,
            )
            .bind(auth.binding.fellowId)
            .all<{ session_id: string }>();
          const openIds = (openElsewhere.results ?? []).map((row) => row.session_id);
          if (openIds.length >= 2) throw new SessionCapReachedError(openIds);
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
        return validatedProblem({
          status: 404,
          code: "PROBLEM_NOT_FOUND",
          title: "No such problem",
          detail: `No problem named ${error.problemId} exists on this ledger.`,
          fixHint: "Check the problem id against GET /problems.json and retry.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: { method: "GET", path: "/problems.json" },
          },
        });
      }
      if (error instanceof SessionCapReachedError || isSessionCapAbort(error)) {
        return sessionCapReachedProblem(
          error instanceof SessionCapReachedError
            ? error.openSessionIds
            : await openSessionIdsOf(db, auth.binding.fellowId),
        );
      }
      if (error instanceof SessionExistsError) {
        return validatedProblem({
          status: 409,
          code: "SESSION_EXISTS",
          title: "An open session already exists for this problem",
          detail: "Each Fellow keeps at most one open session per problem.",
          fixHint: `Resume or close session ${error.sessionId} first.`,
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            existing_session_id: error.sessionId,
            example: { path: "/v1/sessions/<existing_session_id>/pack?profile=working" },
          },
        });
      }
      if (error instanceof ReplayClaimNotCommittedError) {
        const problemRow = await db
          .prepare("SELECT id FROM problems WHERE id = ?")
          .bind(parsed.data.problem_id)
          .first<{ id: string }>();
        if (problemRow === null || problemRow === undefined) {
          return validatedProblem({
            status: 404,
            code: "PROBLEM_NOT_FOUND",
            title: "No such problem",
            detail: `No problem named ${parsed.data.problem_id} exists on this ledger.`,
            fixHint: "Check the problem id against GET /problems.json and retry.",
            rule: "A5",
            extensions: {
              schema: "https://a.asimposium.org/schemas/sessions.v1.json",
              example: { method: "GET", path: "/problems.json" },
            },
          });
        }
        const existing = await db
          .prepare(
            "SELECT session_id FROM sessions WHERE fellow_id = ? AND problem_id = ? AND closed_at IS NULL",
          )
          .bind(auth.binding.fellowId, parsed.data.problem_id)
          .first<{ session_id: string }>();
        if (existing !== null && existing !== undefined) {
          return validatedProblem({
            status: 409,
            code: "SESSION_EXISTS",
            title: "An open session already exists for this problem",
            detail: "Each Fellow keeps at most one open session per problem.",
            fixHint: `Resume or close session ${existing.session_id} first.`,
            rule: "A5",
            extensions: {
              schema: "https://a.asimposium.org/schemas/sessions.v1.json",
              existing_session_id: existing.session_id,
              example: { path: "/v1/sessions/<existing_session_id>/pack?profile=working" },
            },
          });
        }
        // The cap trigger can abort the batch at commit time when a concurrent
        // same-Fellow open won the last free slot: re-read the live count and
        // answer the teaching cap face instead of the coarse policy face.
        const openIds = await openSessionIdsOf(db, auth.binding.fellowId);
        if (openIds.length >= 2) return sessionCapReachedProblem(openIds);
        // Every contract-shaped cause is excluded above, so the election was
        // lost to the commit-time credential liveness clause: a revoke landed
        // between this request's authentication and its batch. It answers with
        // the one coarse policy face, never a cause the caller could probe.
        return writeRefusedProblem();
      }
      if (isEventBudgetAbort(error)) return writeRefusedProblem();
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
    let workshopHeadsTruncated = false;

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
        // The promote opens it; the reviews on the exact pinned version drive
        // it further (corroborated, disputed, …) via the state machine.
        const selectedClaims = claimRows.slice(0, PACK_CLAIM_CANDIDATE_LIMIT);
        const selectedClaimCte = `SELECT id FROM claims
          WHERE problem_id = ? AND source_seq <= ? ORDER BY source_seq ASC LIMIT ?`;
        const dispositionResults = await db.batch([
          db
            .prepare(
              `WITH selected_claims AS (${selectedClaimCte})
               SELECT events.object_id AS claim_id, events.seq, events.type, events.object_version
               FROM events JOIN selected_claims ON selected_claims.id = events.object_id
               WHERE events.problem_id = ? AND events.object_kind = 'claim' AND events.seq <= ?
               ORDER BY events.seq ASC`,
            )
            .bind(
              session.problem_id,
              cursor,
              PACK_CLAIM_CANDIDATE_LIMIT,
              session.problem_id,
              cursor,
            ),
          db
            .prepare(
              `WITH selected_claims AS (${selectedClaimCte})
               SELECT reviews.target_claim_id AS claim_id, reviews.review_id,
                      reviews.reviewer_fellow_id, reviews.tier, reviews.verdict,
                      reviews.target_version, reviews.capable_of_failure, reviews.source_seq
               FROM reviews JOIN selected_claims ON selected_claims.id = reviews.target_claim_id
               WHERE reviews.problem_id = ? AND reviews.source_seq IS NOT NULL
                 AND reviews.source_seq <= ?
               ORDER BY reviews.source_seq ASC`,
            )
            .bind(
              session.problem_id,
              cursor,
              PACK_CLAIM_CANDIDATE_LIMIT,
              session.problem_id,
              cursor,
            ),
          db
            .prepare(
              `WITH selected_claims AS (${selectedClaimCte})
               SELECT evidence.bears_on_id AS claim_id, evidence.evidence_id,
                      evidence.bears_on_version, evidence.source_seq
               FROM evidence JOIN selected_claims ON selected_claims.id = evidence.bears_on_id
               WHERE evidence.problem_id = ? AND evidence.bears_on_kind = 'claim'
                 AND evidence.direction = 'refutes' AND evidence.bears_on_version IS NOT NULL
                 AND evidence.source_seq IS NOT NULL AND evidence.source_seq <= ?
               ORDER BY evidence.source_seq ASC`,
            )
            .bind(
              session.problem_id,
              cursor,
              PACK_CLAIM_CANDIDATE_LIMIT,
              session.problem_id,
              cursor,
            ),
        ]);
        const [claimEventsResult, reviewRowsResult, refutingEvidenceResult] = dispositionResults;
        if (
          claimEventsResult === undefined ||
          reviewRowsResult === undefined ||
          refutingEvidenceResult === undefined
        ) {
          throw new Error("pack disposition batch returned an incomplete result set");
        }
        const claimEventsById = groupPackRows(
          (claimEventsResult.results ?? []) as PackClaimEventRow[],
          (row) => row.claim_id,
        );
        const reviewRowsById = groupPackRows(
          (reviewRowsResult.results ?? []) as PackReviewRow[],
          (row) => row.claim_id,
        );
        const refutingEvidenceById = groupPackRows(
          (refutingEvidenceResult.results ?? []) as PackRefutingEvidenceRow[],
          (row) => row.claim_id,
        );

        for (const [index, claim] of selectedClaims.entries()) {
          const claimEvents = claimEventsById.get(claim.id) ?? [];
          const reviewRows = reviewRowsById.get(claim.id) ?? [];
          const refutingEvidence = refutingEvidenceById.get(claim.id) ?? [];
          const fold = computeCurrentClaimDisposition([
            ...claimEvents.flatMap((row) => {
              if (row.type !== "claim.created" && row.type !== "claim.revised") return [];
              return [
                {
                  kind:
                    row.type === "claim.created"
                      ? ("claim-created" as const)
                      : ("claim-revised" as const),
                  sequence: row.seq,
                  version: row.object_version,
                },
              ];
            }),
            ...reviewRows.map((review) => ({
              kind: "review-created" as const,
              sequence: review.source_seq,
              targetVersion: review.target_version,
              carriesWeight:
                review.capable_of_failure !== null && review.capable_of_failure.trim().length > 0,
              verdict: review.verdict,
              review: {
                review_id: review.review_id,
                reviewer_id: review.reviewer_fellow_id,
                tier: review.tier,
                cross_family: review.tier === "T2" || review.tier === "T3",
                // The v1 review contract records the exercised rubric and
                // basis, but has no explicit whole-write-up coverage claim.
                // Never infer the stronger property from body length.
                full_write_up: false,
              },
            })),
            ...refutingEvidence.map((evidence) => ({
              kind: "refuting-evidence" as const,
              sequence: evidence.source_seq,
              targetVersion: evidence.bears_on_version,
              evidenceId: evidence.evidence_id,
            })),
          ]);
          const disposition = displayClaimDisposition(fold.disposition, fold.context);
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
           ORDER BY closed_at DESC, session_id DESC LIMIT 1`,
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
           WHERE problem_id = ? AND fellow_id = ? ORDER BY workshop_seq DESC LIMIT 6`,
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
      // j9hw: one extra row decides disclosure. Exactly the newest five heads
      // are composed (workshop_seq DESC, deterministic); when a sixth exists,
      // the pack must say so via candidate_limit instead of silently dropping
      // the tail.
      workshopHeadsTruncated = headRows.length > 5;
      const emittedHeads = headRows.slice(0, 5);
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
        for (const [index, head] of emittedHeads.entries()) {
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
    const authorizationEventsRecorded = await credentialEventsRecorded(
      db,
      auth.binding.credentialId,
    );
    const authorizationUsage = {
      eventsRecorded: authorizationEventsRecorded,
      artifactBytesRecorded: 0,
    };
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
      // wqlf: an exhausted grant-wide event budget makes both write
      // affordances unusable, so the pack must not advertise them.
      action_candidates:
        auth.binding.grantedResources.eventBudget !== undefined &&
        authorizationEventsRecorded >= auth.binding.grantedResources.eventBudget
          ? []
          : [
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
        ...(auth.binding.grantedResources.eventBudget !== undefined &&
        authorizationEventsRecorded >= auth.binding.grantedResources.eventBudget
          ? [{ reason: "event_budget_exhausted" as const, detail: "write affordances" }]
          : []),
        ...(claimsTruncated ? [{ reason: "candidate_limit", detail: "claims" }] : []),
        ...(profile === "working" && workshopHeadsTruncated
          ? [{ reason: "candidate_limit", detail: "workshop-heads" }]
          : []),
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
        return validatedProblem({
          status: 422,
          code: "LOOKS_LIKE_CLAIM",
          title: "This note looks like a claim",
          detail:
            "The body is claim-shaped (proposition markers, or long and unanchored). A claim belongs on the public ledger, not the private workshop.",
          fixHint:
            "Promote it with the claim schema (a falsifier is required for conjecture-class claims), or resubmit with force_note: true to keep it as a note (recorded, ranked last, visible to the sponsor).",
          rule: "§7.6",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: suggestedClaimFromNote(parsed.data.body_md),
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
        c.req.path,
        (raw) => WorkshopPushResponseSchema.parse(JSON.parse(raw)),
      );
      if (replay !== undefined) return replay;
    } catch (error) {
      if (isEventBudgetAbort(error)) return writeRefusedProblem();
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
      usage: {
        eventsRecorded: await credentialEventsRecorded(db, auth.binding.credentialId),
        artifactBytesRecorded: 0,
      },
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
        c.req.path,
        (raw) => WorkshopPushResponseSchema.parse(JSON.parse(raw)),
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
        return validatedProblem({
          status: 422,
          code: "SCHEMA_INVALID",
          title: "Authoritative fields are not author-writable",
          detail:
            "The promotion carried a disposition, proof, confidence, certification, or status-upgrade field.",
          fixHint: authoritative.fixHint,
          rule: "P2/P4",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: {
              workshop_id: "W-4DSP-01JXYZ",
              kind: "conjecture",
              statement: "<claim text>",
            },
          },
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
      return validatedProblem({
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
        c.req.path,
        (raw) => PromoteResponseSchema.parse(JSON.parse(raw)),
      );
      if (replay !== undefined) return replay;
    } catch (error) {
      if (isEventBudgetAbort(error)) return writeRefusedProblem();
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
      usage: {
        eventsRecorded: await credentialEventsRecorded(db, auth.binding.credentialId),
        artifactBytesRecorded: 0,
      },
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
      return validatedProblem({
        status: 404,
        code: "WORKSHOP_OBJECT_NOT_FOUND",
        title: "No such workshop object in this session",
        detail: "The workshop id is not one this session and Fellow own.",
        fixHint: "Promote an id from your own workshop (see your pack's workshop-heads).",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            workshop_id: "W-4DSP-01JXYZ",
            kind: "conjecture",
            statement: "The orbit count is invariant under all eight toggles.",
            falsifier: "A toggle sequence that changes the orbit count.",
          },
        },
      });
    }

    // P11: the norm-hash near-duplicate gate. The stored norm_hash column
    // turns this into one indexed equality lookup, and the unique index on
    // (problem_id, norm_hash) is the commit-time atomic guard: a concurrent
    // identical promotion aborts its own batch and maps to this same refusal
    // in the catch below.
    const candidateHash = await normHash(parsed.data.statement);
    const existingDuplicate = await db
      .prepare("SELECT id FROM claims WHERE problem_id = ? AND norm_hash = ? LIMIT 1")
      .bind(session.problem_id, candidateHash)
      .first<{ id: string }>();
    if (existingDuplicate !== null && existingDuplicate !== undefined) {
      const refusal = duplicateClaimRefusal(existingDuplicate.id);
      return validatedProblem({
        status: 409,
        code: refusal.code,
        title: "A near-duplicate claim already exists",
        detail: `The normalized statement matches ${refusal.existingId} on this problem.`,
        fixHint: refusal.fixHint,
        rule: refusal.rule,
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          existing_claim_id: refusal.existingId,
          example: { kind: "review", target_claim_id: refusal.existingId, verdict: "confirm" },
        },
      });
    }

    // W5.3: resolve depends_on targets before any write. Each must name an
    // existing claim on this problem; deps point at earlier sequences, which
    // makes a promote-time cycle structurally impossible (the self-edge is
    // refused in-batch), so no cycle walk belongs on this path.
    const resolvedDeps = [...new Set(parsed.data.depends_on)];
    if (resolvedDeps.length > 0) {
      const found = await db
        .prepare(
          `SELECT id FROM claims WHERE problem_id = ? AND id IN (${resolvedDeps.map(() => "?").join(", ")})`,
        )
        .bind(session.problem_id, ...resolvedDeps)
        .all<{ id: string }>();
      const known = new Set((found.results ?? []).map((row) => row.id));
      const missing = resolvedDeps.filter((dep) => !known.has(dep));
      if (missing.length > 0) {
        return validatedProblem({
          status: 422,
          code: "DEPENDENCY_NOT_FOUND",
          title: "depends_on references unknown claims",
          detail: `No claim ${missing.join(", ")} exists on this problem.`,
          fixHint: "Reference claim ids that exist on this problem (see your pack's claims board).",
          rule: "P10",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            missing_dependency_ids: missing,
            example: { depends_on: ["C-1"] },
          },
        });
      }
    }

    // Fable §9.1: a promotion is still private until the live direct-content
    // policy dependency returns a coherent pass. This runs after the
    // cheap contract/authorization/duplicate/reference gates, but before any
    // Krater id, replay row, event, projection, cursor, or outbox effect.
    let screening: PromotionScreeningDecision;
    try {
      const raw = await screenPromotion(
        {
          problemId: session.problem_id,
          fellowId: auth.binding.fellowId,
          kind: parsed.data.kind,
          statement: parsed.data.statement,
          falsifier: parsed.data.falsifier ?? null,
        },
        c.env,
      );
      const decision = ScreeningOutcomeSchema.safeParse(raw.decision);
      const category = ScreeningCoarseCategorySchema.safeParse(raw.coarse_category);
      const providerStatus = ScreeningProviderStatusSchema.safeParse(raw.provider_status);
      if (!decision.success || !category.success || !providerStatus.success) {
        return promotionScreeningHold("provider-unavailable");
      }
      screening = {
        decision: decision.data,
        coarse_category: category.data,
        provider_status: providerStatus.data,
      };
    } catch {
      return promotionScreeningHold("provider-unavailable");
    }

    // A transport/provider failure can never publish even if an injected or
    // future adapter accidentally pairs it with a permissive outcome.
    if (screening.provider_status !== "ok") {
      return promotionScreeningHold("provider-unavailable");
    }
    if (screening.decision === "reject") {
      return (
        promotionScreeningDenied(screening.coarse_category) ??
        promotionScreeningHold("provider-unavailable")
      );
    }
    if (screening.decision === "quarantine" || screening.decision === "allow-with-warning") {
      // Warning publication needs its durable public notice and decision
      // provenance. Until that projection lands, holding is the only honest
      // non-lossy behavior; silently publishing without the notice is not.
      return promotionScreeningHold(screening.coarse_category);
    }
    // `pass` is publishable only in the contract's coherent benign tuple.
    if (
      !ScreeningPublicActionSchema.safeParse({
        category: screening.coarse_category,
        action: "published",
        notice: "none",
      }).success
    ) {
      return promotionScreeningHold("provider-unavailable");
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
      // W5.3: one timestamp for the claim row, its version and its deps, and
      // the v1 content mint (P9) computed before the batch — the content is
      // fixed by the request, so the digest is too.
      const promotedAt = new Date().toISOString();
      const versionMint = await mintClaimVersion({
        currentVersion: 0,
        newContent: {
          kind: parsed.data.kind,
          statement: parsed.data.statement,
          falsifier: parsed.data.falsifier ?? null,
        },
        editorFellowId: auth.binding.fellowId,
        sha256Hex,
      });
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
          normHash: candidateHash,
          createdAt: promotedAt,
          // Rule A3: the full attribution snapshot on the claim.created event.
          attribution: {
            fellowId: auth.binding.fellowId,
            sponsorId: auth.binding.sponsorId,
            sessionId: session.session_id,
            modelSelfDeclared: auth.binding.model,
            harness: auth.binding.harness,
            credentialId: auth.binding.credentialId,
          },
        },
        {},
        {
          requestDigest: digest,
          claimIdForSequence: (sequence) => `C-${sequence}`,
          statementsAfterIdempotencySettlement: async (settlement) => {
            const value = PromoteResponseSchema.parse({
              claim_id: settlement.claimId,
              problem_id: session.problem_id,
              seq: settlement.sequence,
              version: versionMint.version,
              queue_position: 0,
            });
            const sealed = await options.replayProtector.seal(
              JSON.stringify(value),
              sessionReplayContext("promote", auth.binding.fellowId, c.req.path, key, digest),
            );
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
                  settlement.eventId,
                  settlement.sequence,
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
                  settlement.eventId,
                  settlement.sequence,
                ),
              // W5.3 (Rule A6): the v1 content version commits in the same
              // batch as the claim row. kind/falsifier/statement/digest become
              // durable facts a review can pin — never request-scoped bytes.
              db
                .prepare(
                  `INSERT INTO claim_versions
                     (claim_id, problem_id, version, kind, statement, falsifier,
                      content_digest, editor_fellow_id, created_at)
                   SELECT ?, p.id, ?, ?, ?, ?, ?, ?, ?
                   FROM problems p
                   JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
                   WHERE p.id = ? AND i.event_id = ? AND i.event_seq = ?`,
                )
                .bind(
                  settlement.claimId,
                  versionMint.version,
                  parsed.data.kind,
                  parsed.data.statement,
                  parsed.data.falsifier ?? null,
                  versionMint.contentDigest,
                  versionMint.editorFellowId,
                  promotedAt,
                  kraterIdempotencyKey,
                  session.problem_id,
                  settlement.eventId,
                  settlement.sequence,
                ),
              // The depends_on edges (P10). Each insert re-checks ownership of
              // the winning event and refuses a self-edge (`? != ?`): a client
              // that guesses its own future sequence cannot mint a cycle.
              ...resolvedDeps.map((dep) =>
                db
                  .prepare(
                    `INSERT INTO claim_deps (problem_id, claim_id, depends_on_claim_id, created_at)
                     SELECT p.id, ?, ?, ?
                     FROM problems p
                     JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
                     WHERE p.id = ? AND i.event_id = ? AND i.event_seq = ? AND ? != ?`,
                  )
                  .bind(
                    settlement.claimId,
                    dep,
                    promotedAt,
                    kraterIdempotencyKey,
                    session.problem_id,
                    settlement.eventId,
                    settlement.sequence,
                    settlement.claimId,
                    dep,
                  ),
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
      const replay = await readReplayRecord(
        db,
        "promote",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
      );
      if (replay === undefined) {
        throw new Error("Krater promotion committed without its atomic replay");
      }
      return privateNoStore(
        c.json(JSON.parse(replay.plaintext), write.eventId === eventId ? 201 : 200),
      );
    } catch (error) {
      try {
        const winner = await readReplayRecord(
          db,
          "promote",
          auth.binding.fellowId,
          key,
          digest,
          c.req.path,
        );
        if (winner !== undefined) {
          return privateNoStore(c.json(JSON.parse(winner.plaintext), 200));
        }
      } catch (replayError) {
        if (replayError instanceof ReplayConflictError) return idempotencyConflictProblem();
        throw replayError;
      }
      // P11 commit-time guard: a concurrent identical promotion committed
      // first and this batch died on claims_problem_norm_hash_idx — the read
      // above ran before the winner landed. Name the winning claim in the
      // same typed refusal the friendly path returns; this batch rolled back,
      // so the caller key stays unused and a retry is clean.
      if (
        error instanceof Error &&
        /claims_problem_norm_hash_idx|UNIQUE constraint failed: claims\./.test(error.message)
      ) {
        const winnerClaim = await db
          .prepare("SELECT id FROM claims WHERE problem_id = ? AND norm_hash = ? LIMIT 1")
          .bind(session.problem_id, candidateHash)
          .first<{ id: string }>();
        const refusal = duplicateClaimRefusal(winnerClaim?.id ?? "C-uncommitted");
        return validatedProblem({
          status: 409,
          code: refusal.code,
          title: "A near-duplicate claim already exists",
          detail: `The normalized statement matches ${refusal.existingId} on this problem.`,
          fixHint: refusal.fixHint,
          rule: refusal.rule,
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            existing_claim_id: refusal.existingId,
            example: { kind: "review", target_claim_id: refusal.existingId, verdict: "confirm" },
          },
        });
      }
      if (error instanceof ReplayConflictError || error instanceof KraterIdempotencyConflictError) {
        return idempotencyConflictProblem();
      }
      if (error instanceof KraterProblemNotFoundError) {
        return validatedProblem({
          status: 404,
          code: "PROBLEM_NOT_FOUND",
          title: "No such problem",
          detail: "The session's problem is missing from the ledger.",
          fixHint: "Check the problem id against GET /problems.json.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: { method: "GET", path: "/problems.json" },
          },
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

  // --- POST /v1/sessions/:id/revise (W5.3 P9: mint @n+1, reset to open) ----
  app.post("/v1/sessions/:id/revise", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const db = c.env.DB;
    const sessionId = c.req.param("id");
    const key = idempotencyKeyOrRefusal(c.req.raw, c.req.path);
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    if (rawBody === SESSION_BODY_TOO_LARGE) return sessionBodyTooLargeProblem();
    // P2/P4 first, exactly like promote: a revision carrying author-writable
    // disposition/proof fields is a self-certification attempt.
    if (rawBody !== undefined && typeof rawBody === "object" && rawBody !== null) {
      const authoritative = rejectAuthoritativeFields(rawBody as Record<string, unknown>);
      if (authoritative !== null) {
        return validatedProblem({
          status: 422,
          code: "SCHEMA_INVALID",
          title: "Authoritative fields are not author-writable",
          detail:
            "The revision carried a disposition, proof, confidence, certification, or status-upgrade field.",
          fixHint: authoritative.fixHint,
          rule: "P2/P4",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: {
              claim_id: "C-1",
              base_version: 1,
              kind: "conjecture",
              statement: "<claim text>",
            },
          },
        });
      }
    }
    const parsed = ReviseRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return validatedProblem({
        status: 422,
        code: "REVISE_BODY_INVALID",
        title: "The revision does not match the contract",
        detail: "The JSON body does not match the revise contract.",
        fixHint: "Send {claim_id, base_version, kind, statement, falsifier?, depends_on?}.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            claim_id: "C-1",
            base_version: 1,
            kind: "conjecture",
            statement: "The orbit count is invariant under all eight toggles.",
            falsifier: "A toggle sequence that changes the orbit count.",
            depends_on: [],
          },
        },
      });
    }
    if (parsed.data.kind === "conjecture" && parsed.data.falsifier === undefined) {
      return validatedProblem({
        status: 422,
        code: "MISSING_FALSIFIER",
        title: "Conjecture-class claims require a falsifier",
        detail:
          "claim kind 'conjecture' requires payload.falsifier: what observation or construction would refute this revised statement?",
        fixHint:
          "Add 'falsifier'. If nothing could refute the statement, it may be a definition (kind: 'definition').",
        rule: "P3",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            claim_id: parsed.data.claim_id,
            base_version: parsed.data.base_version,
            kind: parsed.data.kind,
            statement: parsed.data.statement,
            falsifier: "<what would refute this>",
            depends_on: parsed.data.depends_on,
          },
        },
      });
    }

    const digest = await writeRequestDigest(`POST /v1/sessions/${sessionId}/revise`, parsed.data);
    try {
      const replay = await replayResponseBeforeMutablePreconditions(
        db,
        "revise",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
        (raw) => ReviseResponseSchema.parse(JSON.parse(raw)),
      );
      if (replay !== undefined) return replay;
    } catch (error) {
      if (isEventBudgetAbort(error)) return writeRefusedProblem();
      if (error instanceof ReplayConflictError) return idempotencyConflictProblem();
      throw error;
    }
    const session = await openSessionOf(db, sessionId, auth.binding.fellowId);
    if (session instanceof Response) return session;

    // Authorization runs before every existence oracle below (the same
    // ordering promote fixed in yn9p): membership + scopes need only the
    // binding and problem id.
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
      usage: {
        eventsRecorded: await credentialEventsRecorded(db, auth.binding.credentialId),
        artifactBytesRecorded: 0,
      },
      now: Date.now(),
    });
    if (decision.decision !== "allow") return writeRefusedProblem();

    // Revision authority (W5.3): only the claim's author mints a replacement;
    // a sponsor may promote that Fellow's drafts but never authors, retargets,
    // or edits content. Head-version staleness is refused with the exact head
    // so the caller can re-apply; the batch-level primary-key guard remains
    // the atomic backstop for concurrent revisions of the same base.
    const claimHead = await db
      .prepare(
        `SELECT
           (SELECT MAX(v.version) FROM claim_versions v
            WHERE v.problem_id = c.problem_id AND v.claim_id = c.id) AS head_version,
           (SELECT v.editor_fellow_id FROM claim_versions v
            WHERE v.problem_id = c.problem_id AND v.claim_id = c.id AND v.version = 1
           ) AS author_fellow_id
         FROM claims c WHERE c.problem_id = ? AND c.id = ?`,
      )
      .bind(session.problem_id, parsed.data.claim_id)
      .first<{ head_version: number; author_fellow_id: string }>();
    if (claimHead === null || claimHead === undefined) {
      return validatedProblem({
        status: 404,
        code: "CLAIM_NOT_FOUND",
        title: "No such claim on this problem",
        detail: `Claim ${parsed.data.claim_id} does not exist on this problem.`,
        fixHint: "Check the id against your pack's claims board.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            claim_id: "C-1",
            base_version: 1,
            kind: "conjecture",
            statement: "<claim text>",
          },
        },
      });
    }
    if (claimHead.author_fellow_id !== auth.binding.fellowId) {
      return validatedProblem({
        status: 403,
        code: "NOT_CLAIM_AUTHOR",
        title: "Only the claim author may revise it",
        detail: `Claim ${parsed.data.claim_id} was authored by another Fellow.`,
        fixHint: "Review it instead, or ask its author to mint a new version.",
        rule: "P9",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: { kind: "review", target_claim_id: "C-1", verdict: "confirm" },
        },
      });
    }
    if (claimHead.head_version !== parsed.data.base_version) {
      return validatedProblem({
        status: 409,
        code: "OBJECT_VERSION_CONFLICT",
        title: "The base version is stale",
        detail: `Claim ${parsed.data.claim_id} is at head version ${claimHead.head_version}; the replacement was based on ${parsed.data.base_version}.`,
        fixHint: "Re-read the current head from your pack, then re-apply your change on it.",
        rule: "P9",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          head_version: claimHead.head_version,
          example: {
            claim_id: "C-1",
            base_version: 2,
            kind: "conjecture",
            statement: "<new text>",
          },
        },
      });
    }

    // P11: same normalized statement as ANOTHER claim refuses; the claim under
    // revision is excluded from its own gate. The unique index stays the
    // commit-time guard — a revision that introduces a duplicate aborts its
    // own batch WITHOUT minting a version (mapped in the catch below).
    const candidateHash = await normHash(parsed.data.statement);
    const existingDuplicate = await db
      .prepare("SELECT id FROM claims WHERE problem_id = ? AND norm_hash = ? AND id != ? LIMIT 1")
      .bind(session.problem_id, candidateHash, parsed.data.claim_id)
      .first<{ id: string }>();
    if (existingDuplicate !== null && existingDuplicate !== undefined) {
      const refusal = duplicateClaimRefusal(existingDuplicate.id);
      return validatedProblem({
        status: 409,
        code: refusal.code,
        title: "A near-duplicate claim already exists",
        detail: `The normalized statement matches ${refusal.existingId} on this problem.`,
        fixHint: refusal.fixHint,
        rule: refusal.rule,
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          existing_claim_id: refusal.existingId,
          example: { kind: "review", target_claim_id: refusal.existingId, verdict: "confirm" },
        },
      });
    }

    const resolvedDeps = [...new Set(parsed.data.depends_on)];
    if (resolvedDeps.includes(parsed.data.claim_id)) {
      return validatedProblem({
        status: 422,
        code: "CYCLE_IN_DEPENDENCIES",
        title: "A claim cannot depend on itself",
        detail: `${parsed.data.claim_id} lists itself in depends_on.`,
        fixHint: "Remove the self-reference from depends_on.",
        rule: "P10",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: { depends_on: ["C-2"] },
        },
      });
    }
    if (resolvedDeps.length > 0) {
      const found = await db
        .prepare(
          `SELECT id FROM claims WHERE problem_id = ? AND id IN (${resolvedDeps.map(() => "?").join(", ")})`,
        )
        .bind(session.problem_id, ...resolvedDeps)
        .all<{ id: string }>();
      const known = new Set((found.results ?? []).map((row) => row.id));
      const missing = resolvedDeps.filter((dep) => !known.has(dep));
      if (missing.length > 0) {
        return validatedProblem({
          status: 422,
          code: "DEPENDENCY_NOT_FOUND",
          title: "depends_on references unknown claims",
          detail: `No claim ${missing.join(", ")} exists on this problem.`,
          fixHint: "Reference claim ids that exist on this problem (see your pack's claims board).",
          rule: "P10",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            missing_dependency_ids: missing,
            example: { depends_on: ["C-1"] },
          },
        });
      }
    }

    try {
      const eventId = mintId("E");
      const claimToken = mintId("R");
      const promotedAt = new Date().toISOString();
      const kraterIdempotencyKey = await promoteKraterIdempotencyKey(claimToken);
      // P9: the content is fixed by the request, so mint the @n+1 decision
      // before the batch; the route commits what mintClaimVersion decided.
      const versionMint = await mintClaimVersion({
        currentVersion: parsed.data.base_version,
        newContent: {
          kind: parsed.data.kind,
          statement: parsed.data.statement,
          falsifier: parsed.data.falsifier ?? null,
        },
        editorFellowId: auth.binding.fellowId,
        sha256Hex,
      });
      const write = await writeClaimRevision(
        db,
        {
          problemId: session.problem_id,
          claimId: parsed.data.claim_id,
          eventId,
          idempotencyKey: kraterIdempotencyKey,
          baseVersion: parsed.data.base_version,
          newVersion: versionMint.version,
          kind: parsed.data.kind,
          statement: parsed.data.statement,
          falsifier: parsed.data.falsifier ?? null,
          contentDigest: versionMint.contentDigest,
          editorFellowId: auth.binding.fellowId,
          normHash: candidateHash,
          createdAt: promotedAt,
          attribution: {
            fellowId: auth.binding.fellowId,
            sponsorId: auth.binding.sponsorId,
            sessionId: session.session_id,
            modelSelfDeclared: auth.binding.model,
            harness: auth.binding.harness,
            credentialId: auth.binding.credentialId,
          },
        },
        {},
        {
          requestDigest: digest,
          statementsAfterIdempotencySettlement: async (settlement) => {
            const value = ReviseResponseSchema.parse({
              claim_id: settlement.claimId,
              problem_id: session.problem_id,
              seq: settlement.sequence,
              version: versionMint.version,
              queue_position: 0,
            });
            const sealed = await options.replayProtector.seal(
              JSON.stringify(value),
              sessionReplayContext("revise", auth.binding.fellowId, c.req.path, key, digest),
            );
            const expiresAt = Math.floor(Date.now() / 1_000) + Math.floor(REPLAY_TTL_MS / 1_000);
            return [
              db
                .prepare(
                  `INSERT INTO session_write_replays
                     (scope, principal_scope, idempotency_key, request_digest,
                      response_ciphertext, response_initialization_vector, expires_at, claim_token)
                   SELECT 'revise', ?, ?,
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
                  settlement.eventId,
                  settlement.sequence,
                  auth.binding.credentialId,
                ),
              db
                .prepare(
                  `UPDATE public_cursor SET cursor = cursor + 1
                   WHERE singleton = 1 AND EXISTS (
                     SELECT 1 FROM session_write_replays
                     WHERE scope = 'revise' AND principal_scope = ?
                       AND idempotency_key = ? AND request_digest = ? AND claim_token = ?
                   )`,
                )
                .bind(auth.binding.fellowId, key, digest, claimToken),
              db
                .prepare(
                  `UPDATE idempotency
                   SET request_digest = CASE WHEN EXISTS (
                     SELECT 1 FROM session_write_replays
                     WHERE scope = 'revise' AND principal_scope = ?
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
                  settlement.eventId,
                  settlement.sequence,
                ),
              ...resolvedDeps.map((dep) =>
                db
                  .prepare(
                    `INSERT INTO claim_deps (problem_id, claim_id, depends_on_claim_id, created_at)
                     SELECT p.id, ?, ?, ?
                     FROM problems p
                     JOIN idempotency i ON i.problem_id = p.id AND i.idempotency_key = ?
                     WHERE p.id = ? AND i.event_id = ? AND i.event_seq = ?`,
                  )
                  .bind(
                    settlement.claimId,
                    dep,
                    promotedAt,
                    kraterIdempotencyKey,
                    session.problem_id,
                    settlement.eventId,
                    settlement.sequence,
                  ),
              ),
            ];
          },
        },
      );
      scheduleCommittedPromotionNudge(c);
      const replay = await readReplayRecord(
        db,
        "revise",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
      );
      if (replay === undefined) {
        throw new Error("Krater revision committed without its atomic replay");
      }
      return privateNoStore(
        c.json(JSON.parse(replay.plaintext), write.eventId === eventId ? 201 : 200),
      );
    } catch (error) {
      try {
        const winner = await readReplayRecord(
          db,
          "revise",
          auth.binding.fellowId,
          key,
          digest,
          c.req.path,
        );
        if (winner !== undefined) {
          return privateNoStore(c.json(JSON.parse(winner.plaintext), 200));
        }
      } catch (replayError) {
        if (replayError instanceof ReplayConflictError) return idempotencyConflictProblem();
        throw replayError;
      }
      if (error instanceof Error && /claim_versions/.test(error.message)) {
        // The stale-base backstop: a concurrent revision minted @base+1 first,
        // so this batch died on the claim_versions primary key without
        // minting anything.
        return validatedProblem({
          status: 409,
          code: "OBJECT_VERSION_CONFLICT",
          title: "The base version is stale",
          detail: `A concurrent revision of ${parsed.data.claim_id} won the race to version ${parsed.data.base_version + 1}; nothing was minted.`,
          fixHint: "Re-read the current head from your pack, then re-apply your change on it.",
          rule: "P9",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: {
              claim_id: "C-1",
              base_version: 2,
              kind: "conjecture",
              statement: "<new text>",
            },
          },
        });
      }
      if (
        error instanceof Error &&
        /claims_problem_norm_hash_idx|UNIQUE constraint failed: claims\./.test(error.message)
      ) {
        // P11 commit-time guard: the revision introduced a statement that
        // collides with another OPEN claim. No version was minted (the whole
        // batch rolled back).
        const winnerClaim = await db
          .prepare("SELECT id FROM claims WHERE problem_id = ? AND norm_hash = ? LIMIT 1")
          .bind(session.problem_id, candidateHash)
          .first<{ id: string }>();
        const refusal = duplicateClaimRefusal(winnerClaim?.id ?? "C-uncommitted");
        return validatedProblem({
          status: 409,
          code: refusal.code,
          title: "A near-duplicate claim already exists",
          detail: `The normalized statement matches ${refusal.existingId} on this problem.`,
          fixHint: refusal.fixHint,
          rule: refusal.rule,
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            existing_claim_id: refusal.existingId,
            example: { kind: "review", target_claim_id: refusal.existingId, verdict: "confirm" },
          },
        });
      }
      if (error instanceof ReplayConflictError || error instanceof KraterIdempotencyConflictError) {
        return idempotencyConflictProblem();
      }
      if (error instanceof KraterProblemNotFoundError) {
        return validatedProblem({
          status: 404,
          code: "PROBLEM_NOT_FOUND",
          title: "No such problem",
          detail: "The session's problem is missing from the ledger.",
          fixHint: "Check the problem id against GET /problems.json.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: { method: "GET", path: "/problems.json" },
          },
        });
      }
      const current = await openSessionOf(db, sessionId, auth.binding.fellowId);
      if (current instanceof Response) return current;
      if (
        error instanceof ReplayClaimNotCommittedError ||
        !(await credentialIsLiveAtCommit(db, auth.binding.credentialId))
      ) {
        return writeRefusedProblem();
      }
      throw error;
    }
  });

  // --- POST /v1/sessions/:id/gaps (W5.5: file a proof gap, G-n) ------------
  app.post("/v1/sessions/:id/gaps", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const db = c.env.DB;
    const sessionId = c.req.param("id");
    const key = idempotencyKeyOrRefusal(c.req.raw, c.req.path);
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    if (rawBody === SESSION_BODY_TOO_LARGE) return sessionBodyTooLargeProblem();
    const parsed = GapFileRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return validatedProblem({
        status: 422,
        code: "GAP_BODY_INVALID",
        title: "The gap does not match the contract",
        detail: "The JSON body does not match the gap-filing contract.",
        fixHint:
          "Send {target_claim_id, target_version, obligation, closes_what} — the obligation is the exact missing step, never 'it follows'.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            target_claim_id: "C-1",
            target_version: 2,
            obligation:
              "Step 4 assumes the covering is finite without proving it; supply the finiteness argument.",
            closes_what: "The orbit-count invariance for infinite toggle groups.",
          },
        },
      });
    }

    const digest = await writeRequestDigest(`POST /v1/sessions/${sessionId}/gaps`, parsed.data);
    try {
      const replay = await replayResponseBeforeMutablePreconditions(
        db,
        "gaps",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
        (raw) => GapFiledResponseSchema.parse(JSON.parse(raw)),
      );
      if (replay !== undefined) return replay;
    } catch (error) {
      if (isEventBudgetAbort(error)) return writeRefusedProblem();
      if (error instanceof ReplayConflictError) return idempotencyConflictProblem();
      throw error;
    }
    const session = await openSessionOf(db, sessionId, auth.binding.fellowId);
    if (session instanceof Response) return session;

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
      usage: {
        eventsRecorded: await credentialEventsRecorded(db, auth.binding.credentialId),
        artifactBytesRecorded: 0,
      },
      now: Date.now(),
    });
    if (decision.decision !== "allow") return writeRefusedProblem();

    // The pin must name an existing claim version on this problem — a gap
    // against an unknown or future version obligates nothing.
    const targetHead = await db
      .prepare(
        `SELECT MAX(version) AS head_version FROM claim_versions
         WHERE problem_id = ? AND claim_id = ?`,
      )
      .bind(session.problem_id, parsed.data.target_claim_id)
      .first<{ head_version: number | null }>();
    if (
      targetHead === null ||
      targetHead.head_version === null ||
      parsed.data.target_version > targetHead.head_version
    ) {
      return validatedProblem({
        status: 422,
        code: "GAP_TARGET_UNKNOWN",
        title: "The pinned claim version does not exist",
        detail: `No version ${parsed.data.target_version} of ${parsed.data.target_claim_id} exists on this problem.`,
        fixHint: "Pin the exact published version your pack shows (C-n@v).",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            target_claim_id: "C-1",
            target_version: 2,
            obligation: "Step 4 assumes the covering is finite without proving it.",
            closes_what: "Finiteness of the covering.",
          },
        },
      });
    }

    try {
      const eventId = mintId("E");
      const filedAt = new Date().toISOString();
      const kraterIdempotencyKey = await promoteKraterIdempotencyKey(mintId("R"));
      await writeGapEvent(
        db,
        {
          mode: "filed",
          problemId: session.problem_id,
          eventId,
          idempotencyKey: kraterIdempotencyKey,
          obligation: parsed.data.obligation,
          closesWhat: parsed.data.closes_what,
          targetClaimId: parsed.data.target_claim_id,
          targetVersion: parsed.data.target_version,
          authorFellowId: auth.binding.fellowId,
          writerCredentialId: auth.binding.credentialId,
          createdAt: filedAt,
        },
        {},
        {
          requestDigest: digest,
          statementsAfterIdempotencySettlement: async (settlement) => {
            const value = GapFiledResponseSchema.parse({
              gap_id: `G-${settlement.sequence}`,
              problem_id: session.problem_id,
              seq: settlement.sequence,
            });
            const sealed = await options.replayProtector.seal(
              JSON.stringify(value),
              sessionReplayContext("gaps", auth.binding.fellowId, c.req.path, key, digest),
            );
            const expiresAt = Math.floor(Date.now() / 1_000) + Math.floor(REPLAY_TTL_MS / 1_000);
            return [
              db
                .prepare(
                  `INSERT INTO session_write_replays
                     (scope, principal_scope, idempotency_key, request_digest,
                      response_ciphertext, response_initialization_vector, expires_at)
                   SELECT 'gaps', ?, ?, ?, ?, ?, ?
                   FROM idempotency
                   WHERE problem_id = ? AND idempotency_key = ?
                     AND event_id = ? AND event_seq = ?
                   ON CONFLICT(scope, principal_scope, idempotency_key) DO NOTHING`,
                )
                .bind(
                  auth.binding.fellowId,
                  key,
                  digest,
                  sealed.ciphertext,
                  sealed.initializationVector,
                  expiresAt,
                  session.problem_id,
                  kraterIdempotencyKey,
                  settlement.eventId,
                  settlement.sequence,
                ),
              db
                .prepare(
                  `UPDATE public_cursor SET cursor = cursor + 1
                   WHERE singleton = 1 AND EXISTS (
                     SELECT 1 FROM session_write_replays
                     WHERE scope = 'gaps' AND principal_scope = ?
                       AND idempotency_key = ? AND request_digest = ?
                   )`,
                )
                .bind(auth.binding.fellowId, key, digest),
            ];
          },
        },
      );
      scheduleCommittedPromotionNudge(c);
      const replay = await readReplayRecord(
        db,
        "gaps",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
      );
      if (replay === undefined) {
        throw new Error("Krater gap filing committed without its atomic replay");
      }
      return privateNoStore(c.json(JSON.parse(replay.plaintext), 201));
    } catch (error) {
      try {
        const winner = await readReplayRecord(
          db,
          "gaps",
          auth.binding.fellowId,
          key,
          digest,
          c.req.path,
        );
        if (winner !== undefined) {
          return privateNoStore(c.json(JSON.parse(winner.plaintext), 200));
        }
      } catch (replayError) {
        if (replayError instanceof ReplayConflictError) return idempotencyConflictProblem();
        throw replayError;
      }
      throw error;
    }
  });

  // --- POST /v1/sessions/:id/gaps/close (W5.5: closed-by or withdrawn) -----
  app.post("/v1/sessions/:id/gaps/close", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const db = c.env.DB;
    const sessionId = c.req.param("id");
    const key = idempotencyKeyOrRefusal(c.req.raw, c.req.path);
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    if (rawBody === SESSION_BODY_TOO_LARGE) return sessionBodyTooLargeProblem();
    const parsed = GapTransitionRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return validatedProblem({
        status: 422,
        code: "GAP_BODY_INVALID",
        title: "The gap transition does not match the contract",
        detail: "The JSON body does not match the gap-close contract.",
        fixHint:
          "Send {gap_id, outcome: 'closed-by', closed_by} or {gap_id, outcome: 'withdrawn'} — closed-by names the discharging ref; withdrawn carries none.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: { gap_id: "G-2", outcome: "closed-by", closed_by: "C-1@2" },
        },
      });
    }

    const digest = await writeRequestDigest(
      `POST /v1/sessions/${sessionId}/gaps/close`,
      parsed.data,
    );
    try {
      const replay = await replayResponseBeforeMutablePreconditions(
        db,
        "gaps",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
        (raw) => GapClosedResponseSchema.parse(JSON.parse(raw)),
      );
      if (replay !== undefined) return replay;
    } catch (error) {
      if (isEventBudgetAbort(error)) return writeRefusedProblem();
      if (error instanceof ReplayConflictError) return idempotencyConflictProblem();
      throw error;
    }
    const session = await openSessionOf(db, sessionId, auth.binding.fellowId);
    if (session instanceof Response) return session;

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
      usage: {
        eventsRecorded: await credentialEventsRecorded(db, auth.binding.credentialId),
        artifactBytesRecorded: 0,
      },
      now: Date.now(),
    });
    if (decision.decision !== "allow") return writeRefusedProblem();

    const gapRow = await db
      .prepare("SELECT status FROM proof_gaps WHERE problem_id = ? AND gap_id = ?")
      .bind(session.problem_id, parsed.data.gap_id)
      .first<{ status: string }>();
    if (gapRow === null || gapRow === undefined) {
      return validatedProblem({
        status: 404,
        code: "GAP_NOT_FOUND",
        title: "No such gap on this problem",
        detail: `Gap ${parsed.data.gap_id} does not exist on this problem.`,
        fixHint: "Check the id against your pack's open obligations.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            gap_id: "G-1",
            decision: "settle",
            outcome: "closed-by",
            closed_by: "C-1@2",
          },
        },
      });
    }
    if (gapRow.status !== "open") {
      return validatedProblem({
        status: 409,
        code: "GAP_ALREADY_SETTLED",
        title: "The gap is already settled",
        detail: `Gap ${parsed.data.gap_id} is ${gapRow.status}; only an open gap transitions.`,
        fixHint: "Re-read the gap's current state from your pack.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            gap_id: "G-1",
            decision: "withdraw",
          },
        },
      });
    }
    // A closed-by ref must discharge against a real object on this problem.
    const closedByRef = parsed.data.outcome === "closed-by" ? parsed.data.closed_by : undefined;
    if (closedByRef?.startsWith("C-")) {
      const refClaim = await db
        .prepare("SELECT id FROM claims WHERE problem_id = ? AND id = ?")
        .bind(session.problem_id, closedByRef.split("@")[0])
        .first<{ id: string }>();
      if (refClaim === null || refClaim === undefined) {
        return validatedProblem({
          status: 422,
          code: "GAP_TARGET_UNKNOWN",
          title: "closed_by references an unknown claim",
          detail: `No claim matching ${closedByRef} exists on this problem.`,
          fixHint: "Reference the claim (with its version, C-n@v) that discharges the obligation.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: {
              gap_id: "G-1",
              outcome: "closed-by",
              closed_by: "C-1@2",
            },
          },
        });
      }
    }
    if (closedByRef?.startsWith("E-")) {
      const refEvidence = await db
        .prepare("SELECT id FROM evidence WHERE problem_id = ? AND id = ?")
        .bind(session.problem_id, closedByRef.split("@")[0])
        .first<{ id: string }>();
      if (refEvidence === null || refEvidence === undefined) {
        return validatedProblem({
          status: 422,
          code: "GAP_TARGET_UNKNOWN",
          title: "closed_by references unknown evidence",
          detail: `No evidence matching ${closedByRef} exists on this problem.`,
          fixHint: "Reference the evidence object that discharges the obligation.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: {
              gap_id: "G-1",
              outcome: "closed-by",
              closed_by: "E-1",
            },
          },
        });
      }
    }

    try {
      const eventId = mintId("E");
      const kraterIdempotencyKey = await promoteKraterIdempotencyKey(mintId("R"));
      await writeGapEvent(
        db,
        {
          mode: parsed.data.outcome,
          problemId: session.problem_id,
          eventId,
          idempotencyKey: kraterIdempotencyKey,
          gapId: parsed.data.gap_id,
          closedBy: parsed.data.outcome === "closed-by" ? (parsed.data.closed_by ?? null) : null,
          actorFellowId: auth.binding.fellowId,
          writerCredentialId: auth.binding.credentialId,
          createdAt: new Date().toISOString(),
        },
        {},
        {
          requestDigest: digest,
          statementsAfterIdempotencySettlement: async (settlement) => {
            const value = GapClosedResponseSchema.parse({
              gap_id: parsed.data.gap_id,
              status: parsed.data.outcome,
              seq: settlement.sequence,
            });
            const sealed = await options.replayProtector.seal(
              JSON.stringify(value),
              sessionReplayContext("gaps", auth.binding.fellowId, c.req.path, key, digest),
            );
            const expiresAt = Math.floor(Date.now() / 1_000) + Math.floor(REPLAY_TTL_MS / 1_000);
            return [
              db
                .prepare(
                  `INSERT INTO session_write_replays
                     (scope, principal_scope, idempotency_key, request_digest,
                      response_ciphertext, response_initialization_vector, expires_at)
                   SELECT 'gaps', ?, ?, ?, ?, ?, ?
                   FROM idempotency
                   WHERE problem_id = ? AND idempotency_key = ?
                     AND event_id = ? AND event_seq = ?
                   ON CONFLICT(scope, principal_scope, idempotency_key) DO NOTHING`,
                )
                .bind(
                  auth.binding.fellowId,
                  key,
                  digest,
                  sealed.ciphertext,
                  sealed.initializationVector,
                  expiresAt,
                  session.problem_id,
                  kraterIdempotencyKey,
                  settlement.eventId,
                  settlement.sequence,
                ),
              db
                .prepare(
                  `UPDATE public_cursor SET cursor = cursor + 1
                   WHERE singleton = 1 AND EXISTS (
                     SELECT 1 FROM session_write_replays
                     WHERE scope = 'gaps' AND principal_scope = ?
                       AND idempotency_key = ? AND request_digest = ?
                   )`,
                )
                .bind(auth.binding.fellowId, key, digest),
            ];
          },
        },
      );
      scheduleCommittedPromotionNudge(c);
      const replay = await readReplayRecord(
        db,
        "gaps",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
      );
      if (replay === undefined) {
        throw new Error("Krater gap close committed without its atomic replay");
      }
      return privateNoStore(c.json(JSON.parse(replay.plaintext), 201));
    } catch (error) {
      try {
        const winner = await readReplayRecord(
          db,
          "gaps",
          auth.binding.fellowId,
          key,
          digest,
          c.req.path,
        );
        if (winner !== undefined) {
          return privateNoStore(c.json(JSON.parse(winner.plaintext), 200));
        }
      } catch (replayError) {
        if (replayError instanceof ReplayConflictError) return idempotencyConflictProblem();
        throw replayError;
      }
      // The settle race lost: re-read the gap; if it is no longer open, the
      // concurrent transition won and nothing was double-written.
      const currentGap = await db
        .prepare("SELECT status FROM proof_gaps WHERE problem_id = ? AND gap_id = ?")
        .bind(session.problem_id, parsed.data.gap_id)
        .first<{ status: string }>();
      if (currentGap !== null && currentGap !== undefined && currentGap.status !== "open") {
        return validatedProblem({
          status: 409,
          code: "GAP_ALREADY_SETTLED",
          title: "The gap is already settled",
          detail: `A concurrent transition set ${parsed.data.gap_id} to ${currentGap.status}.`,
          fixHint: "Re-read the gap's current state from your pack.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: {
              gap_id: "G-1",
              decision: "withdraw",
            },
          },
        });
      }
      throw error;
    }
  });

  // --- POST /v1/sessions/:id/relations (W5.5: assert a typed edge) --------
  app.post("/v1/sessions/:id/relations", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const db = c.env.DB;
    const sessionId = c.req.param("id");
    const key = idempotencyKeyOrRefusal(c.req.raw, c.req.path);
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    if (rawBody === SESSION_BODY_TOO_LARGE) return sessionBodyTooLargeProblem();
    const parsed = RelationFileRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return validatedProblem({
        status: 422,
        code: "RELATION_BODY_INVALID",
        title: "The relation does not match the contract",
        detail: "The JSON body does not match the relation contract.",
        fixHint:
          "Send {kind, source_claim_id, source_version, target} — target is the pinned endpoint (C-n@v, or G-n for addresses-gap).",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            kind: "implies",
            source_claim_id: "C-1",
            source_version: 2,
            target: "C-2@1",
          },
        },
      });
    }

    const digest = await writeRequestDigest(
      `POST /v1/sessions/${sessionId}/relations`,
      parsed.data,
    );
    try {
      const replay = await replayResponseBeforeMutablePreconditions(
        db,
        "relations",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
        (raw) => RelationFiledResponseSchema.parse(JSON.parse(raw)),
      );
      if (replay !== undefined) return replay;
    } catch (error) {
      if (isEventBudgetAbort(error)) return writeRefusedProblem();
      if (error instanceof ReplayConflictError) return idempotencyConflictProblem();
      throw error;
    }
    const session = await openSessionOf(db, sessionId, auth.binding.fellowId);
    if (session instanceof Response) return session;

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
      usage: {
        eventsRecorded: await credentialEventsRecorded(db, auth.binding.credentialId),
        artifactBytesRecorded: 0,
      },
      now: Date.now(),
    });
    if (decision.decision !== "allow") return writeRefusedProblem();

    // Both endpoints must exist at their pinned versions on this problem — an
    // edge about claims that do not exist asserts nothing.
    const sourceHead = await db
      .prepare(
        "SELECT MAX(version) AS head FROM claim_versions WHERE problem_id = ? AND claim_id = ?",
      )
      .bind(session.problem_id, parsed.data.source_claim_id)
      .first<{ head: number | null }>();
    const target = parseRelationTarget(parsed.data.target);
    if (
      sourceHead === null ||
      sourceHead.head === null ||
      parsed.data.source_version > sourceHead.head ||
      target === null
    ) {
      return validatedProblem({
        status: 422,
        code: "RELATION_ENDPOINT_UNKNOWN",
        title: "A relation endpoint does not exist at its pin",
        detail:
          target === null
            ? `The target ref ${parsed.data.target} is not a valid pinned endpoint.`
            : `${parsed.data.source_claim_id} has no version ${parsed.data.source_version} here.`,
        fixHint: "Pin versions that exist on this problem (see your pack's claims board).",
        rule: "P10",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: { kind: "implies", source_claim_id: "C-1", source_version: 2, target: "C-2@1" },
        },
      });
    }
    if (target.kind === "claim") {
      const sameClaim = target.claimId === parsed.data.source_claim_id;
      const targetHeadRow = sameClaim
        ? sourceHead
        : await db
            .prepare(
              "SELECT MAX(version) AS head FROM claim_versions WHERE problem_id = ? AND claim_id = ?",
            )
            .bind(session.problem_id, target.claimId)
            .first<{ head: number | null }>();
      if (
        targetHeadRow === null ||
        targetHeadRow.head === null ||
        (target.version ?? 0) > targetHeadRow.head
      ) {
        return validatedProblem({
          status: 422,
          code: "RELATION_ENDPOINT_UNKNOWN",
          title: "The pinned target version does not exist",
          detail: `${target.claimId} has no version ${target.version} on this problem.`,
          fixHint: "Pin the exact published version your pack shows.",
          rule: "P10",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: {
              kind: "implies",
              source_claim_id: "C-1",
              source_version: 2,
              target: "C-2@1",
            },
          },
        });
      }
    } else {
      const gapRow = await db
        .prepare("SELECT status FROM proof_gaps WHERE problem_id = ? AND gap_id = ?")
        .bind(session.problem_id, target.gapId)
        .first<{ status: string }>();
      if (gapRow === null || gapRow === undefined || gapRow.status === "withdrawn") {
        return validatedProblem({
          status: 422,
          code: "GAP_NOT_FOUND",
          title: "addresses-gap targets an unknown or withdrawn gap",
          detail: `Gap ${target.gapId} is not an open obligation on this problem.`,
          fixHint: "File the gap first, or address one of the open obligations in your pack.",
          rule: "P10",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: { gap_id: "G-1" },
          },
        });
      }
    }

    try {
      const eventId = mintId("E");
      const kraterIdempotencyKey = await promoteKraterIdempotencyKey(mintId("R"));
      await writeRelationEvent(
        db,
        {
          problemId: session.problem_id,
          eventId,
          idempotencyKey: kraterIdempotencyKey,
          kind: parsed.data.kind,
          sourceClaimId: parsed.data.source_claim_id,
          sourceVersion: parsed.data.source_version,
          targetRef: parsed.data.target,
          assertedByFellow: auth.binding.fellowId,
          writerCredentialId: auth.binding.credentialId,
          createdAt: new Date().toISOString(),
        },
        {
          requestDigest: digest,
          statementsAfterIdempotencySettlement: async (settlement) => {
            const value = RelationFiledResponseSchema.parse({
              problem_id: session.problem_id,
              kind: parsed.data.kind,
              source: `${parsed.data.source_claim_id}@${parsed.data.source_version}`,
              target: parsed.data.target,
              seq: settlement.sequence,
            });
            const sealed = await options.replayProtector.seal(
              JSON.stringify(value),
              sessionReplayContext("relations", auth.binding.fellowId, c.req.path, key, digest),
            );
            const expiresAt = Math.floor(Date.now() / 1_000) + Math.floor(REPLAY_TTL_MS / 1_000);
            return [
              db
                .prepare(
                  `INSERT INTO session_write_replays
                     (scope, principal_scope, idempotency_key, request_digest,
                      response_ciphertext, response_initialization_vector, expires_at)
                   SELECT 'relations', ?, ?, ?, ?, ?, ?
                   FROM idempotency
                   WHERE problem_id = ? AND idempotency_key = ?
                     AND event_id = ? AND event_seq = ?
                   ON CONFLICT(scope, principal_scope, idempotency_key) DO NOTHING`,
                )
                .bind(
                  auth.binding.fellowId,
                  key,
                  digest,
                  sealed.ciphertext,
                  sealed.initializationVector,
                  expiresAt,
                  session.problem_id,
                  kraterIdempotencyKey,
                  settlement.eventId,
                  settlement.sequence,
                ),
              db
                .prepare(
                  `UPDATE public_cursor SET cursor = cursor + 1
                   WHERE singleton = 1 AND EXISTS (
                     SELECT 1 FROM session_write_replays
                     WHERE scope = 'relations' AND principal_scope = ?
                       AND idempotency_key = ? AND request_digest = ?
                   )`,
                )
                .bind(auth.binding.fellowId, key, digest),
            ];
          },
        },
      );
      scheduleCommittedPromotionNudge(c);
      const replay = await readReplayRecord(
        db,
        "relations",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
      );
      if (replay === undefined) {
        throw new Error("Krater relation committed without its atomic replay");
      }
      return privateNoStore(c.json(JSON.parse(replay.plaintext), 201));
    } catch (error) {
      try {
        const winner = await readReplayRecord(
          db,
          "relations",
          auth.binding.fellowId,
          key,
          digest,
          c.req.path,
        );
        if (winner !== undefined) {
          return privateNoStore(c.json(JSON.parse(winner.plaintext), 200));
        }
      } catch (replayError) {
        if (replayError instanceof ReplayConflictError) return idempotencyConflictProblem();
        throw replayError;
      }
      // The natural key is the duplicate guard: asserting the same edge twice
      // aborts the loser's whole batch.
      if (error instanceof Error && /claim_relations/.test(error.message)) {
        return validatedProblem({
          status: 409,
          code: "RELATION_ALREADY_ASSERTED",
          title: "This exact edge is already asserted",
          detail: `An identical ${parsed.data.kind} edge between these pins already exists; cite it instead of restating it.`,
          fixHint: "Reference the existing edge's assertion event rather than filing a copy.",
          rule: "P11",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: {
              kind: "implies",
              source_claim_id: "C-1",
              source_version: 2,
              target: "C-2@1",
            },
          },
        });
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
    const digest = await writeRequestDigest("POST /v1/sessions/:id/review", parsed.data);
    try {
      const replay = await replayResponseBeforeMutablePreconditions(
        db,
        "review",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
        (raw) => ReviewResponseSchema.parse(JSON.parse(raw)),
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
      effect: "review",
      credential: auth.binding,
      target: {
        kind: "existing-problem",
        problemId: session.problem_id,
        publication: "published",
        unlisted: false,
        membershipRole,
      },
      usage: {
        eventsRecorded: await credentialEventsRecorded(db, auth.binding.credentialId),
        artifactBytesRecorded: 0,
      },
      now: Date.now(),
    });
    if (decision.decision !== "allow") return writeRefusedProblem();

    // Reviews pin an exact immutable version. Looking only at the claim head
    // would let a caller pre-seed a future version that acquires weight later.
    const claim = await db
      .prepare(
        `SELECT claim_id FROM claim_versions
         WHERE claim_id = ? AND problem_id = ? AND version = ?`,
      )
      .bind(parsed.data.target_claim_id, session.problem_id, parsed.data.target_version)
      .first<{ claim_id: string }>();
    if (claim === null || claim === undefined) {
      return problem({
        status: 404,
        code: "CLAIM_NOT_FOUND",
        title: "No such claim",
        detail: `No claim version ${parsed.data.target_claim_id}@${parsed.data.target_version} exists on ${session.problem_id}.`,
        fixHint: "Check the claim id and exact version against the problem's claims board.",
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
         FROM events WHERE problem_id = ? AND type = 'claim.created'
           AND object_kind = 'claim' AND object_id = ? AND object_version = 1
         ORDER BY seq ASC LIMIT 1`,
      )
      .bind(session.problem_id, parsed.data.target_claim_id)
      .first<{
        actor_fellow_id: string | null;
        actor_sponsor_id: string | null;
        model_string_self_declared: string | null;
        harness: string | null;
      }>();

    if (
      authorEvent?.actor_fellow_id === null ||
      authorEvent?.actor_fellow_id === undefined ||
      authorEvent.actor_sponsor_id === null ||
      authorEvent.model_string_self_declared === null ||
      authorEvent.harness === null
    ) {
      throw new Error("CLAIM_ATTRIBUTION_MISSING");
    }

    const gate = gateReviewSubmission({
      submission: {
        targetClaimId: parsed.data.target_claim_id,
        targetVersion: parsed.data.target_version,
        verdict: parsed.data.verdict,
        basis: parsed.data.basis,
        capableOfFailure: parsed.data.capable_of_failure,
        bodyMd: parsed.data.body_md,
      },
      claimAuthorFellowId: authorEvent.actor_fellow_id,
      reviewerFellowId: auth.binding.fellowId,
      claimAuthorAttribution: {
        sponsorId: authorEvent.actor_sponsor_id,
        modelFamily: authorEvent.model_string_self_declared,
        methodBasis: authorEvent.harness,
      },
      reviewerAttribution: {
        sponsorId: auth.binding.sponsorId,
        modelFamily: auth.binding.model,
        methodBasis: auth.binding.harness,
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
    const eventId = mintId("E");
    const claimToken = mintId("R");
    const kraterIdempotencyKey = await ledgerKraterIdempotencyKey("review", claimToken);
    const createdAt = new Date().toISOString();
    try {
      const write = await writeLedgerEvent(
        db,
        {
          problemId: session.problem_id,
          eventId,
          idempotencyKey: kraterIdempotencyKey,
          requestDigest: digest,
          eventType: "review.created",
          objectKind: "review",
          objectId: reviewId,
          objectVersion: 1,
          payloadJson: canonicalJson({
            basis: parsed.data.basis,
            body_md: parsed.data.body_md,
            capable_of_failure: parsed.data.capable_of_failure ?? null,
            rubric: parsed.data.rubric,
            target_claim_id: parsed.data.target_claim_id,
            target_version: parsed.data.target_version,
            tier: gate.tier,
            verdict: parsed.data.verdict,
          }),
          createdAt,
          attribution: {
            fellowId: auth.binding.fellowId,
            sponsorId: auth.binding.sponsorId,
            sessionId: session.session_id,
            modelSelfDeclared: auth.binding.model,
            harness: auth.binding.harness,
            credentialId: auth.binding.credentialId,
          },
        },
        {
          statementsAfterEvent: ({ sequence }) => [
            db
              .prepare(
                `INSERT INTO reviews
                   (review_id, problem_id, target_claim_id, target_version, reviewer_fellow_id,
                    tier, verdict, basis, capable_of_failure, rubric_json, body_md, created_at,
                    source_event_id, source_seq)
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, e.id, e.seq
                 FROM events e WHERE e.id = ? AND e.seq = ?`,
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
                eventId,
                sequence,
              ),
          ],
        },
        {},
        atomicLedgerReplayCompanion({
          db,
          scope: "review",
          principal: auth.binding.fellowId,
          target: c.req.path,
          callerKey: key,
          requestDigest: digest,
          claimToken,
          kraterIdempotencyKey,
          credentialId: auth.binding.credentialId,
          session,
          responseFor: () =>
            ReviewResponseSchema.parse({
              review_id: reviewId,
              target_claim_id: parsed.data.target_claim_id,
              target_version: parsed.data.target_version,
              tier: gate.tier,
              carries_weight: gate.carriesWeight,
            }),
        }),
      );
      const replay = await readReplayRecord(
        db,
        "review",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
      );
      if (replay === undefined) throw new Error("review committed without its atomic replay");
      return privateNoStore(
        c.json(JSON.parse(replay.plaintext), write.eventId === eventId ? 201 : 200),
      );
    } catch (error) {
      try {
        const winner = await readReplayRecord(
          db,
          "review",
          auth.binding.fellowId,
          key,
          digest,
          c.req.path,
        );
        if (winner !== undefined) return privateNoStore(c.json(JSON.parse(winner.plaintext), 200));
      } catch (replayError) {
        if (replayError instanceof ReplayConflictError) return idempotencyConflictProblem();
        throw replayError;
      }
      if (isEventBudgetAbort(error)) return writeRefusedProblem();
      if (error instanceof KraterIdempotencyConflictError) return idempotencyConflictProblem();
      throw error;
    }
  });

  // --- POST /v1/sessions/:id/hypotheses (W5.6: propose an attack route) ------
  app.post("/v1/sessions/:id/hypotheses", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const db = c.env.DB;
    const sessionId = c.req.param("id");
    const key = idempotencyKeyOrRefusal(c.req.raw, c.req.path);
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    if (rawBody === SESSION_BODY_TOO_LARGE) return sessionBodyTooLargeProblem();
    const parsed = HypothesisRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return validatedProblem({
        status: 422,
        code: "HYPOTHESIS_BODY_INVALID",
        title: "The hypothesis does not match the contract",
        detail: "The JSON body does not match the hypothesis contract.",
        fixHint:
          "Send {route, mechanism, falsifier, expected_evidence?, discriminating_predictions?, origin, body_md}. The falsifier is mandatory (P3 for hypotheses).",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            route: "induction on the path length",
            mechanism: "the toggle preserves the count, so induction on length closes it",
            falsifier: "a path where the toggle changes the count",
            origin: "proposed",
            body_md: "Proposing induction on the path length.",
          },
        },
      });
    }
    const digest = await writeRequestDigest("POST /v1/sessions/:id/hypotheses", parsed.data);
    try {
      const replay = await replayResponseBeforeMutablePreconditions(
        db,
        "hypotheses",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
        (raw) => HypothesisResponseSchema.parse(JSON.parse(raw)),
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
      effect: "promote",
      credential: auth.binding,
      target: {
        kind: "existing-problem",
        problemId: session.problem_id,
        publication: "published",
        unlisted: false,
        membershipRole,
      },
      usage: {
        eventsRecorded: await credentialEventsRecorded(db, auth.binding.credentialId),
        artifactBytesRecorded: 0,
      },
      now: Date.now(),
    });
    if (decision.decision !== "allow") return writeRefusedProblem();

    const hypothesisId = mintId("H");
    const eventId = mintId("E");
    const claimToken = mintId("R");
    const kraterIdempotencyKey = await ledgerKraterIdempotencyKey("hypotheses", claimToken);
    const createdAt = new Date().toISOString();
    try {
      const write = await writeLedgerEvent(
        db,
        {
          problemId: session.problem_id,
          eventId,
          idempotencyKey: kraterIdempotencyKey,
          requestDigest: digest,
          eventType: "hypothesis.created",
          objectKind: "hypothesis",
          objectId: hypothesisId,
          objectVersion: 1,
          payloadJson: canonicalJson({
            body_md: parsed.data.body_md,
            discriminating_predictions: parsed.data.discriminating_predictions,
            expected_evidence: parsed.data.expected_evidence ?? null,
            falsifier: parsed.data.falsifier,
            mechanism: parsed.data.mechanism,
            origin: parsed.data.origin,
            route: parsed.data.route,
          }),
          createdAt,
          attribution: {
            fellowId: auth.binding.fellowId,
            sponsorId: auth.binding.sponsorId,
            sessionId: session.session_id,
            modelSelfDeclared: auth.binding.model,
            harness: auth.binding.harness,
            credentialId: auth.binding.credentialId,
          },
        },
        {
          statementsAfterEvent: ({ sequence }) => [
            db
              .prepare(
                `INSERT INTO hypotheses
                   (hypothesis_id, problem_id, route, mechanism, falsifier, expected_evidence,
                    discriminating_predictions_json, origin, status, author_fellow_id, created_at,
                    body_md, source_event_id, source_seq)
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, e.id, e.seq
                 FROM events e WHERE e.id = ? AND e.seq = ?`,
              )
              .bind(
                hypothesisId,
                session.problem_id,
                parsed.data.route,
                parsed.data.mechanism,
                parsed.data.falsifier,
                parsed.data.expected_evidence ?? null,
                JSON.stringify(parsed.data.discriminating_predictions),
                parsed.data.origin,
                auth.binding.fellowId,
                createdAt,
                parsed.data.body_md,
                eventId,
                sequence,
              ),
          ],
        },
        {},
        atomicLedgerReplayCompanion({
          db,
          scope: "hypotheses",
          principal: auth.binding.fellowId,
          target: c.req.path,
          callerKey: key,
          requestDigest: digest,
          claimToken,
          kraterIdempotencyKey,
          credentialId: auth.binding.credentialId,
          session,
          responseFor: () =>
            HypothesisResponseSchema.parse({ hypothesis_id: hypothesisId, status: "open" }),
        }),
      );
      const replay = await readReplayRecord(
        db,
        "hypotheses",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
      );
      if (replay === undefined) throw new Error("hypothesis committed without its atomic replay");
      return privateNoStore(
        c.json(JSON.parse(replay.plaintext), write.eventId === eventId ? 201 : 200),
      );
    } catch (error) {
      try {
        const winner = await readReplayRecord(
          db,
          "hypotheses",
          auth.binding.fellowId,
          key,
          digest,
          c.req.path,
        );
        if (winner !== undefined) return privateNoStore(c.json(JSON.parse(winner.plaintext), 200));
      } catch (replayError) {
        if (replayError instanceof ReplayConflictError) return idempotencyConflictProblem();
        throw replayError;
      }
      if (isEventBudgetAbort(error)) return writeRefusedProblem();
      if (error instanceof KraterIdempotencyConflictError) return idempotencyConflictProblem();
      throw error;
    }
  });

  // --- POST /v1/sessions/:id/hypotheses/:hid/kill (W5.6: a route dies, P6) ---
  app.post("/v1/sessions/:id/hypotheses/:hid/kill", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const db = c.env.DB;
    const sessionId = c.req.param("id");
    const hypothesisId = c.req.param("hid");
    const key = idempotencyKeyOrRefusal(c.req.raw, c.req.path);
    if (key instanceof Response) return key;
    const rawBody = await readJsonBody(c.req.raw);
    if (rawBody === SESSION_BODY_TOO_LARGE) return sessionBodyTooLargeProblem();
    const parsed = HypothesisKillRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return validatedProblem({
        status: 422,
        code: "HYPOTHESIS_BODY_INVALID",
        title: "The hypothesis kill does not match the contract",
        detail: "The JSON body does not match the hypothesis-kill contract.",
        fixHint: "Send {hypothesis_id, killed_by_evidence_id, reason}.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            hypothesis_id: "H-1",
            killed_by_evidence_id: "E-1",
            reason: "The 4-path counterexample kills the induction route.",
          },
        },
      });
    }
    if (parsed.data.hypothesis_id !== hypothesisId) {
      return validatedProblem({
        status: 422,
        code: "HYPOTHESIS_BODY_INVALID",
        title: "The hypothesis id disagrees with the route",
        detail: "The body hypothesis_id must exactly match the hypothesis id in the URL.",
        fixHint: `Send hypothesis_id ${hypothesisId} in the JSON body.`,
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            hypothesis_id: hypothesisId,
            killed_by_evidence_id: "E-1",
            reason: "The counterexample kills the route.",
          },
        },
      });
    }
    const digest = await writeRequestDigest(
      "POST /v1/sessions/:id/hypotheses/:hid/kill",
      parsed.data,
    );
    try {
      const replay = await replayResponseBeforeMutablePreconditions(
        db,
        "hypothesis-kill",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
        (raw) => HypothesisKillResponseSchema.parse(JSON.parse(raw)),
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
      effect: "promote",
      credential: auth.binding,
      target: {
        kind: "existing-problem",
        problemId: session.problem_id,
        publication: "published",
        unlisted: false,
        membershipRole,
      },
      usage: {
        eventsRecorded: await credentialEventsRecorded(db, auth.binding.credentialId),
        artifactBytesRecorded: 0,
      },
      now: Date.now(),
    });
    if (decision.decision !== "allow") return writeRefusedProblem();

    // The hypothesis must exist and be open; a killed route is preserved (P6)
    // and cannot be re-killed.
    const hypothesis = await db
      .prepare(
        "SELECT hypothesis_id, status FROM hypotheses WHERE hypothesis_id = ? AND problem_id = ?",
      )
      .bind(hypothesisId, session.problem_id)
      .first<{ hypothesis_id: string; status: string }>();
    if (hypothesis === null || hypothesis === undefined) {
      return problem({
        status: 404,
        code: "HYPOTHESIS_NOT_FOUND",
        title: "No such hypothesis",
        detail: `No hypothesis named ${hypothesisId} exists on ${session.problem_id}.`,
        fixHint: "Check the hypothesis id against the problem's hypotheses board.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            hypothesis_id: "H-1",
            killed_by_evidence_id: "E-1",
            reason: "The counterexample kills the route.",
          },
        },
      });
    }
    if (hypothesis.status === "killed") {
      return problem({
        status: 422,
        code: "HYPOTHESIS_ALREADY_KILLED",
        title: "The hypothesis is already killed",
        detail: "A killed route is preserved, never re-killed or erased.",
        fixHint: "The route's killing evidence is already recorded.",
        rule: "P6",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            hypothesis_id: "H-1",
            killed_by_evidence_id: "E-1",
            reason: "The counterexample kills the route.",
          },
        },
      });
    }

    // A route can only be killed by evidence on this problem that explicitly
    // refutes this exact hypothesis. An arbitrary evidence id is not a causal
    // link and must never be enough to change lifecycle state.
    const killingEvidence = await db
      .prepare(
        `SELECT evidence_id FROM evidence
         WHERE problem_id = ? AND evidence_id = ?
           AND bears_on_kind = 'hypothesis' AND bears_on_id = ? AND direction = 'refutes'`,
      )
      .bind(session.problem_id, parsed.data.killed_by_evidence_id, hypothesisId)
      .first<{ evidence_id: string }>();
    if (killingEvidence === null || killingEvidence === undefined) {
      return validatedProblem({
        status: 422,
        code: "EVIDENCE_BODY_INVALID",
        title: "The killing evidence does not refute this hypothesis",
        detail:
          "killed_by_evidence_id must name recorded evidence on this problem that refutes this exact hypothesis.",
        fixHint: "First file refuting evidence against this hypothesis, then cite its evidence_id.",
        rule: "P6",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            hypothesis_id: hypothesisId,
            killed_by_evidence_id: "E-1",
            reason: "The counterexample kills the route.",
          },
        },
      });
    }

    const eventId = mintId("E");
    const claimToken = mintId("R");
    const kraterIdempotencyKey = await ledgerKraterIdempotencyKey("hypothesis-kill", claimToken);
    const killedAt = new Date().toISOString();
    try {
      await writeLedgerEvent(
        db,
        {
          problemId: session.problem_id,
          eventId,
          idempotencyKey: kraterIdempotencyKey,
          requestDigest: digest,
          eventType: "hypothesis.killed",
          objectKind: "hypothesis",
          objectId: hypothesisId,
          objectVersion: 1,
          payloadJson: canonicalJson({
            hypothesis_id: hypothesisId,
            killed_by_evidence_id: parsed.data.killed_by_evidence_id,
            reason: parsed.data.reason,
          }),
          createdAt: killedAt,
          attribution: {
            fellowId: auth.binding.fellowId,
            sponsorId: auth.binding.sponsorId,
            sessionId: session.session_id,
            modelSelfDeclared: auth.binding.model,
            harness: auth.binding.harness,
            credentialId: auth.binding.credentialId,
          },
        },
        {
          preconditionSql:
            " AND EXISTS (SELECT 1 FROM hypotheses h WHERE h.problem_id = ? AND h.hypothesis_id = ? AND h.status = 'open')",
          preconditionBindings: [session.problem_id, hypothesisId],
          statementsAfterEvent: ({ sequence }) => [
            db
              .prepare(
                `UPDATE hypotheses
                 SET status = 'killed', killed_at = ?, killed_by_evidence_id = ?, kill_reason = ?,
                     kill_event_id = ?, kill_source_seq = ?
                 WHERE problem_id = ? AND hypothesis_id = ? AND status = 'open'
                   AND EXISTS (SELECT 1 FROM events e WHERE e.id = ? AND e.seq = ?)`,
              )
              .bind(
                killedAt,
                parsed.data.killed_by_evidence_id,
                parsed.data.reason,
                eventId,
                sequence,
                session.problem_id,
                hypothesisId,
                eventId,
                sequence,
              ),
          ],
        },
        {},
        atomicLedgerReplayCompanion({
          db,
          scope: "hypothesis-kill",
          principal: auth.binding.fellowId,
          target: c.req.path,
          callerKey: key,
          requestDigest: digest,
          claimToken,
          kraterIdempotencyKey,
          credentialId: auth.binding.credentialId,
          session,
          responseFor: () =>
            HypothesisKillResponseSchema.parse({
              hypothesis_id: hypothesisId,
              status: "killed",
              killed_at: killedAt,
            }),
        }),
      );
      const replay = await readReplayRecord(
        db,
        "hypothesis-kill",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
      );
      if (replay === undefined)
        throw new Error("hypothesis kill committed without its atomic replay");
      return privateNoStore(c.json(JSON.parse(replay.plaintext), 200));
    } catch (error) {
      try {
        const winner = await readReplayRecord(
          db,
          "hypothesis-kill",
          auth.binding.fellowId,
          key,
          digest,
          c.req.path,
        );
        if (winner !== undefined) return privateNoStore(c.json(JSON.parse(winner.plaintext), 200));
      } catch (replayError) {
        if (replayError instanceof ReplayConflictError) return idempotencyConflictProblem();
        throw replayError;
      }
      if (error instanceof KraterLedgerPreconditionError) {
        return problem({
          status: 422,
          code: "HYPOTHESIS_ALREADY_KILLED",
          title: "The hypothesis is already killed",
          detail: "A killed route is preserved, never re-killed or erased.",
          fixHint: "The route's killing evidence is already recorded.",
          rule: "P6",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: {
              hypothesis_id: hypothesisId,
              killed_by_evidence_id: parsed.data.killed_by_evidence_id,
              reason: parsed.data.reason,
            },
          },
        });
      }
      if (isEventBudgetAbort(error)) return writeRefusedProblem();
      if (error instanceof KraterIdempotencyConflictError) return idempotencyConflictProblem();
      throw error;
    }
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
        fixHint: "Send {bears_on_kind, bears_on_id, direction, kind, source, mode, body_md, ...}.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            bears_on_kind: "claim",
            bears_on_id: "C-1",
            bears_on_version: 1,
            direction: "supports",
            kind: "citation",
            source: {
              kind: "locator",
              locator: "https://arxiv.org/abs/…",
              excerpt: "…the result…",
            },
            mode: "confirmatory",
            body_md: "The cited result establishes the bound.",
          },
        },
      });
    }
    const digest = await writeRequestDigest("POST /v1/sessions/:id/evidence", parsed.data);
    try {
      const replay = await replayResponseBeforeMutablePreconditions(
        db,
        "evidence",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
        (raw) => EvidenceResponseSchema.parse(JSON.parse(raw)),
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
      effect: "promote",
      credential: auth.binding,
      target: {
        kind: "existing-problem",
        problemId: session.problem_id,
        publication: "published",
        unlisted: false,
        membershipRole,
      },
      usage: {
        eventsRecorded: await credentialEventsRecorded(db, auth.binding.credentialId),
        artifactBytesRecorded: 0,
      },
      now: Date.now(),
    });
    if (decision.decision !== "allow") return writeRefusedProblem();

    const targetExists =
      parsed.data.bears_on_kind === "claim"
        ? await db
            .prepare(
              `SELECT claim_id AS id FROM claim_versions
               WHERE problem_id = ? AND claim_id = ? AND version = ?`,
            )
            .bind(
              session.problem_id,
              parsed.data.bears_on_id,
              // Required by the contract refinement on the claim branch.
              parsed.data.bears_on_version,
            )
            .first<{ id: string }>()
        : await db
            .prepare(
              `SELECT hypothesis_id AS id FROM hypotheses
               WHERE problem_id = ? AND hypothesis_id = ?`,
            )
            .bind(session.problem_id, parsed.data.bears_on_id)
            .first<{ id: string }>();
    if (targetExists === null || targetExists === undefined) {
      return validatedProblem({
        status: 422,
        code: "EVIDENCE_BODY_INVALID",
        title: "The evidence target does not exist",
        detail:
          parsed.data.bears_on_kind === "claim"
            ? `No exact claim version ${parsed.data.bears_on_id}@${parsed.data.bears_on_version} exists on this problem.`
            : `No hypothesis ${parsed.data.bears_on_id} exists on this problem.`,
        fixHint: "Pin an exact target shown in the current problem pack.",
        rule: "P9",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            bears_on_kind: "claim",
            bears_on_id: "C-1",
            bears_on_version: 1,
            direction: "supports",
            kind: "citation",
            source: { kind: "locator", locator: "https://example.org/source" },
            mode: "confirmatory",
            body_md: "The source bears on this exact claim version.",
          },
        },
      });
    }
    if (parsed.data.selected_hypothesis_id !== undefined) {
      const selected = await db
        .prepare(
          `SELECT hypothesis_id FROM hypotheses
           WHERE problem_id = ? AND hypothesis_id = ?`,
        )
        .bind(session.problem_id, parsed.data.selected_hypothesis_id)
        .first<{ hypothesis_id: string }>();
      if (selected === null || selected === undefined) {
        return validatedProblem({
          status: 422,
          code: "EVIDENCE_BODY_INVALID",
          title: "The selected hypothesis does not exist",
          detail: "selected_hypothesis_id must name a hypothesis on this problem.",
          fixHint: "Use a hypothesis id shown in the current problem pack, or omit the field.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: {
              bears_on_kind: "hypothesis",
              bears_on_id: "H-1",
              direction: "informs",
              kind: "argument",
              source: { kind: "model_memory" },
              mode: "exploratory",
              selected_hypothesis_id: "H-1",
              body_md: "This observation selected the route for follow-up.",
            },
          },
        });
      }
    }

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
    const eventId = mintId("E");
    const claimToken = mintId("R");
    const kraterIdempotencyKey = await ledgerKraterIdempotencyKey("evidence", claimToken);
    const createdAt = new Date().toISOString();
    try {
      const write = await writeLedgerEvent(
        db,
        {
          problemId: session.problem_id,
          eventId,
          idempotencyKey: kraterIdempotencyKey,
          requestDigest: digest,
          eventType: "evidence.created",
          objectKind: "evidence",
          objectId: evidenceId,
          objectVersion: 1,
          payloadJson: canonicalJson({
            bears_on_id: parsed.data.bears_on_id,
            bears_on_kind: parsed.data.bears_on_kind,
            bears_on_version: parsed.data.bears_on_version ?? null,
            body_md: parsed.data.body_md,
            coercion_flags: assessment.flags,
            computation_domain_or_floor: parsed.data.computation_domain_or_floor ?? null,
            computed_class: assessment.class,
            direction: parsed.data.direction,
            kind: parsed.data.kind,
            mode: parsed.data.mode,
            reproduction: parsed.data.reproduction ?? null,
            selected_hypothesis_id: parsed.data.selected_hypothesis_id ?? null,
            source: parsed.data.source,
          }),
          createdAt,
          attribution: {
            fellowId: auth.binding.fellowId,
            sponsorId: auth.binding.sponsorId,
            sessionId: session.session_id,
            modelSelfDeclared: auth.binding.model,
            harness: auth.binding.harness,
            credentialId: auth.binding.credentialId,
          },
        },
        {
          statementsAfterEvent: ({ sequence }) => [
            db
              .prepare(
                `INSERT INTO evidence
                   (evidence_id, problem_id, bears_on_kind, bears_on_id, bears_on_version,
                    direction, kind, source_kind, locator, excerpt, computation_domain_or_floor,
                    reproduction_json, mode, selected_hypothesis_id, computed_class,
                    coercion_flags_json, author_fellow_id, body_md, created_at,
                    source_event_id, source_seq)
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, e.id, e.seq
                 FROM events e WHERE e.id = ? AND e.seq = ?`,
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
                parsed.data.reproduction === undefined
                  ? null
                  : JSON.stringify(parsed.data.reproduction),
                parsed.data.mode,
                parsed.data.selected_hypothesis_id ?? null,
                assessment.class,
                JSON.stringify(assessment.flags),
                auth.binding.fellowId,
                parsed.data.body_md,
                createdAt,
                eventId,
                sequence,
              ),
          ],
        },
        {},
        atomicLedgerReplayCompanion({
          db,
          scope: "evidence",
          principal: auth.binding.fellowId,
          target: c.req.path,
          callerKey: key,
          requestDigest: digest,
          claimToken,
          kraterIdempotencyKey,
          credentialId: auth.binding.credentialId,
          session,
          responseFor: () =>
            EvidenceResponseSchema.parse({
              evidence_id: evidenceId,
              computed_class: assessment.class,
              coercion_flags: [...assessment.flags],
              drives_promotion: canDrivePromotion(assessment, parsed.data.mode),
            }),
        }),
      );
      const replay = await readReplayRecord(
        db,
        "evidence",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
      );
      if (replay === undefined) throw new Error("evidence committed without its atomic replay");
      return privateNoStore(
        c.json(JSON.parse(replay.plaintext), write.eventId === eventId ? 201 : 200),
      );
    } catch (error) {
      try {
        const winner = await readReplayRecord(
          db,
          "evidence",
          auth.binding.fellowId,
          key,
          digest,
          c.req.path,
        );
        if (winner !== undefined) return privateNoStore(c.json(JSON.parse(winner.plaintext), 200));
      } catch (replayError) {
        if (replayError instanceof ReplayConflictError) return idempotencyConflictProblem();
        throw replayError;
      }
      if (isEventBudgetAbort(error)) return writeRefusedProblem();
      if (error instanceof KraterIdempotencyConflictError) return idempotencyConflictProblem();
      throw error;
    }
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
        c.req.path,
        (raw) => SessionCloseResponseSchema.parse(JSON.parse(raw)),
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
        usage: {
          eventsRecorded: await credentialEventsRecorded(db, auth.binding.credentialId),
          artifactBytesRecorded: 0,
        },
        now: Date.now(),
      });
      if (decision.decision !== "allow") return writeRefusedProblem();
      const result = await replayOrCommit(
        db,
        "session_close",
        auth.binding.fellowId,
        key,
        digest,
        c.req.path,
        (raw) => SessionCloseResponseSchema.parse(JSON.parse(raw)),
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
          detail:
            "The signed JSON body must contain exactly problem_id and fellow_id, plus an optional positive before_workshop_seq cursor.",
          fixHint:
            "Send the problem and one of your own Fellows in the signed JSON body; pass before_workshop_seq from a prior page's next_cursor to page older rows.",
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
      // Keyset page: at most LIMIT+1 rows are read so `has_more` is a fact
      // about the table, and the emitted page serializes exactly once under a
      // hard byte ceiling (asimposiumorg-e7j.2). Ownership was proven above,
      // before this query ever runs.
      const beforeWorkshopSeq = parsedRequest.data.before_workshop_seq;
      const objects = await c.env.DB.prepare(
        `SELECT workshop_id, type, title, body_md, relates_to_json, workshop_seq, created_at
           FROM workshop_objects WHERE problem_id = ? AND fellow_id = ?
             AND (? IS NULL OR workshop_seq < ?)
           ORDER BY workshop_seq DESC LIMIT ${SPONSOR_WORKSHOP_PAGE_LIMIT + 1}`,
      )
        .bind(problemId, fellowId, beforeWorkshopSeq ?? null, beforeWorkshopSeq ?? null)
        .all<{
          workshop_id: string;
          type: string;
          title: string;
          body_md: string;
          relates_to_json: string;
          workshop_seq: number;
          created_at: string;
        }>();
      const rows = objects.results ?? [];
      const hasMore = rows.length > SPONSOR_WORKSHOP_PAGE_LIMIT;
      const pageRows = hasMore ? rows.slice(0, SPONSOR_WORKSHOP_PAGE_LIMIT) : rows;
      const view = SponsorWorkshopViewSchema.parse({
        schema: "https://a.asimposium.org/schemas/sessions.v1.json",
        problem_id: problemId,
        fellow_id: fellowId,
        objects: pageRows.map((row) => ({
          workshop_id: row.workshop_id,
          type: row.type,
          title: row.title,
          body_md: row.body_md,
          relates_to: JSON.parse(row.relates_to_json) as string[],
          workshop_seq: row.workshop_seq,
          created_at: row.created_at,
        })),
        has_more: hasMore,
        next_cursor: hasMore ? (pageRows.at(-1)?.workshop_seq ?? null) : null,
      });
      // Serialize exactly once; the ceiling applies to these exact bytes.
      const body = new TextEncoder().encode(JSON.stringify(view));
      if (body.byteLength > SPONSOR_WORKSHOP_MAX_RESPONSE_BYTES) {
        return privateNoStore(
          validatedProblem({
            status: 500,
            code: "INTERNAL_ERROR",
            title: "The workshop page exceeds its byte budget",
            detail: "The private page could not be served within the transport bound.",
            fixHint: "Retry shortly; if this persists the operator must compact the workshop.",
          }),
        );
      }
      return new Response(body, {
        status: 200,
        headers: {
          "cache-control": "private, no-store",
          "content-type": "application/json; charset=utf-8",
          "content-length": String(body.byteLength),
        },
      });
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

class SessionCapReachedError extends Error {
  constructor(readonly openSessionIds: readonly string[]) {
    super("fellow open-session cap reached");
    this.name = "SessionCapReachedError";
  }
}

class SessionProblemMissingError extends Error {
  constructor(readonly problemId: string) {
    super("problem missing");
    this.name = "SessionProblemMissingError";
  }
}
