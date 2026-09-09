import {
  type ClaimDependencyPin,
  type ProblemCode,
  ProblemGovernanceEventSchema,
  ProblemGovernanceKeySchema,
  type ProblemLifecycleActionRequest,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";
import {
  KraterIdempotencyConflictError,
  KraterLedgerPreconditionError,
  sha256Hex,
  writeLedgerEvent,
} from "../krater/krater";
import { PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL } from "../krater/public-content";
import {
  findScientificClaim,
  type ScientificClaim,
  ScientificInputError,
} from "../ledger/scientific-checks";
import { normHash } from "../split/policy";

interface ProblemSnapshot {
  id: string;
  sponsor_id: string | null;
  created_by_fellow_id: string | null;
  title: string;
  status: string;
  current_statement_version: number;
}

const governanceEventTypes = {
  publish: "problem.admitted",
  "revise-statement": "problem.statement-revised",
  "enter-result-review": "problem.result-review-started",
  retire: "problem.retired",
} as const;

function refusal(code: ProblemCode, status: number, detail: string, fixHint: string): Response {
  return validatedProblem({
    code,
    status,
    title: "Problem governance write could not be applied",
    detail,
    fixHint,
    rule: "A5",
    extensions: {
      schema: "https://a.asimposium.org/schemas/problems.v1.json",
      example: { action: "publish", headers: { "Idempotency-Key": "publication-1" } },
    },
  });
}

export const problemGovernanceRefused = (): Response =>
  validatedProblem({
    status: 403,
    code: "WRITE_REFUSED",
    title: "The write is not authorized for this credential",
    detail: "This credential may not perform this write now.",
    fixHint: "Check the console for the credential state or contact your sponsor.",
  });

/** Sponsor governance has its own attribution; it never borrows a Fellow session. */
export async function applyPublicProblemGovernance(
  db: D1Database,
  problem: ProblemSnapshot,
  sponsorId: string,
  action: Extract<ProblemLifecycleActionRequest, { action: keyof typeof governanceEventTypes }>,
  request: Request,
): Promise<Response> {
  const key = ProblemGovernanceKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!key.success)
    return refusal(
      "IDEMPOTENCY_KEY_INVALID",
      400,
      "A stable Idempotency-Key is required for exact retries.",
      "Send 1–160 letters, digits, dots, underscores or hyphens; retain the key on retries.",
    );
  const now = new Date().toISOString();
  const cutoff = new Date(Date.parse(now) - 86_400_000).toISOString();
  const scopedKey = `problem-governance:${await sha256Hex(JSON.stringify([sponsorId, key.data]))}`;
  const digest = await sha256Hex(JSON.stringify([problem.id, sponsorId, action]));
  const conflict = () =>
    refusal(
      "IDEMPOTENCY_CONFLICT",
      409,
      "This key already identifies another request.",
      "Retry the original body or use a new key.",
    );

  // Replay the immutable outcome, even if later actions changed the current projection.
  async function replay(): Promise<Response | undefined> {
    const receipt = await db
      .prepare(`
      SELECT i.request_digest, e.type, e.object_id, e.object_kind, e.actor_sponsor_id,
             e.created_at, e.payload_sha256, c.payload_json
      FROM idempotency i LEFT JOIN events e ON e.id = i.event_id
      LEFT JOIN event_content c ON c.event_id = e.id
      WHERE i.problem_id = ? AND i.idempotency_key = ? AND i.created_at > ?
    `)
      .bind(problem.id, scopedKey, cutoff)
      .first<{
        request_digest: string;
        type: string;
        object_id: string;
        object_kind: string;
        actor_sponsor_id: string;
        created_at: string;
        payload_sha256: string;
        payload_json: string | null;
      }>();
    if (!receipt) return undefined;
    if (receipt.request_digest !== digest) return conflict();
    if (
      receipt.payload_json === null ||
      (await sha256Hex(receipt.payload_json)) !== receipt.payload_sha256
    )
      throw new Error("Problem governance receipt content is unavailable or corrupt.");
    const event = ProblemGovernanceEventSchema.parse(JSON.parse(receipt.payload_json));
    if (
      receipt.object_kind !== "problem" ||
      receipt.object_id !== problem.id ||
      receipt.actor_sponsor_id !== sponsorId ||
      event.acting_principal.id !== sponsorId ||
      event.problem.id !== problem.id ||
      event.action !== action.action ||
      event.problem.updated_at !== receipt.created_at ||
      receipt.type !== governanceEventTypes[event.action]
    )
      throw new Error("Problem governance receipt does not match its event envelope.");
    return Response.json(
      { problem: event.problem },
      { headers: { "cache-control": "private, no-store" } },
    );
  }

  const previous = await replay();
  if (previous) return previous;
  const publishing = action.action === "publish";
  const revising = action.action === "revise-statement";
  if (
    publishing
      ? problem.status !== "private-draft"
      : action.action === "enter-result-review"
        ? !["active", "dormant"].includes(problem.status)
        : !["sharpening", "active", "dormant", "under-result-review"].includes(problem.status)
  )
    return refusal(
      "OBJECT_VERSION_CONFLICT",
      409,
      "The current problem state does not permit this transition.",
      "Read the current problem before choosing a new lifecycle action.",
    );
  if (problem.sponsor_id !== sponsorId || !problem.created_by_fellow_id)
    return problemGovernanceRefused();
  if (publishing) {
    const fellow = await db
      .prepare("SELECT status FROM enrollment_fellows WHERE fellow_id = ?")
      .bind(problem.created_by_fellow_id)
      .first<{ status: string }>();
    if (fellow?.status !== "active") return problemGovernanceRefused();
  }
  let resultClaim: ClaimDependencyPin | undefined;
  if (action.action === "enter-result-review") {
    const reference = action.result_claim;
    const current = await db
      .prepare(`SELECT claims.id FROM claims
      WHERE claims.problem_id = ? AND claims.id = ? AND claims.statement_drift = 0
        AND claims.statement_version = ? AND ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}
        AND (SELECT MAX(version) FROM claim_versions WHERE problem_id = claims.problem_id
          AND claim_id = claims.id) = ?`)
      .bind(problem.id, reference.claim_id, problem.current_statement_version, reference.version)
      .first();
    let claim: ScientificClaim | null;
    try {
      claim = current
        ? await findScientificClaim(db, problem.id, reference.claim_id, reference.version)
        : null;
    } catch (error) {
      if (!(error instanceof ScientificInputError)) throw error;
      claim = null;
    }
    if (!claim)
      return refusal(
        "OBJECT_VERSION_CONFLICT",
        409,
        "Result review requires an available current claim version anchored to the current problem statement.",
        "Read the claim and problem, re-anchor any statement drift, and select the exact current claim version.",
      );
    resultClaim = {
      claim_id: claim.claimId,
      version: claim.version,
      content_digest: claim.contentDigest,
      event_id: claim.eventId,
      payload_digest: claim.payloadDigest,
    };
  }
  const formulation = revising
    ? action
    : await db
        .prepare(`
    SELECT statement, falsifier, motivation FROM problem_statement_versions
    WHERE problem_id = ? AND version = ?
  `)
        .bind(problem.id, problem.current_statement_version)
        .first<{
          statement: string;
          falsifier: string;
          motivation: string;
        }>();
  const parsed = ProblemGovernanceEventSchema.safeParse({
    action: action.action,
    acting_principal: { type: "sponsor", id: sponsorId },
    source_fellow_id: problem.created_by_fellow_id,
    previous_status: problem.status,
    previous_statement_version: problem.current_statement_version,
    problem: {
      id: problem.id,
      title: problem.title,
      status: publishing
        ? "sharpening"
        : action.action === "enter-result-review"
          ? "under-result-review"
          : action.action === "retire"
            ? "retired"
            : problem.status,
      current_statement_version: problem.current_statement_version + (revising ? 1 : 0),
      statement: formulation?.statement,
      falsifier: formulation?.falsifier,
      motivation: formulation?.motivation,
      ...(action.action === "retire" ? { resolution_summary: action.reason } : {}),
      ...(resultClaim ? { result_claim: resultClaim } : {}),
      updated_at: now,
    },
  });
  if (!parsed.success)
    return refusal(
      "STATEMENT_INCOMPLETE",
      422,
      "This governance action requires a complete, versioned problem formulation.",
      "Provide a title, statement, falsifier and motivation before changing the public lifecycle.",
    );
  const event = parsed.data;
  const next = event.problem;
  const eventId = `PG-${crypto.randomUUID()}`;
  const statementHash = revising ? `sha256:${await normHash(next.statement)}` : null;
  try {
    await writeLedgerEvent(
      db,
      {
        problemId: problem.id,
        eventId,
        idempotencyKey: scopedKey,
        requestDigest: digest,
        eventType: governanceEventTypes[event.action],
        objectKind: "problem",
        objectId: problem.id,
        objectVersion: next.current_statement_version,
        payloadJson: JSON.stringify(event),
        createdAt: now,
        attribution: {
          principalType: "sponsor",
          sponsorId,
          fellowId: null,
          sessionId: null,
          modelSelfDeclared: null,
          harness: null,
        },
      },
      {
        preconditionSql: ` AND sponsor_id = ? AND status = ? AND current_statement_version = ?
        AND created_by_fellow_id = ? AND title = ?
        AND EXISTS (SELECT 1 FROM public_cursor WHERE singleton = 1 AND cursor < 9007199254740991)
        ${publishing ? "AND EXISTS (SELECT 1 FROM enrollment_fellows WHERE fellow_id = ? AND status = 'active')" : ""}
        ${
          resultClaim
            ? `AND EXISTS (
          SELECT 1 FROM claims JOIN claim_versions cv
            ON cv.problem_id = claims.problem_id AND cv.claim_id = claims.id
          JOIN events ce ON ce.id = ? AND ce.problem_id = claims.problem_id
            AND ce.object_id = claims.id AND ce.object_kind = 'claim'
            AND ce.object_version = cv.version AND ce.payload_sha256 = ?
          JOIN event_content cc ON cc.event_id = ce.id AND cc.payload_sha256 = ce.payload_sha256
            AND cc.redacted_at IS NULL
          WHERE claims.problem_id = ? AND claims.id = ? AND cv.version = ?
            AND cv.content_digest = ? AND claims.statement_version = ? AND claims.statement_drift = 0
            AND ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}
            AND cv.version = (SELECT MAX(version) FROM claim_versions
              WHERE problem_id = claims.problem_id AND claim_id = claims.id)
        )`
            : ""
        }`,
        preconditionBindings: [
          sponsorId,
          problem.status,
          problem.current_statement_version,
          problem.created_by_fellow_id,
          problem.title,
          ...(publishing ? [problem.created_by_fellow_id] : []),
          ...(resultClaim
            ? [
                resultClaim.event_id,
                resultClaim.payload_digest,
                problem.id,
                resultClaim.claim_id,
                resultClaim.version,
                resultClaim.content_digest,
                problem.current_statement_version,
              ]
            : []),
        ],
        statementsAfterEvent: () => [
          ...(revising
            ? [
                db
                  .prepare(`
          INSERT INTO problem_statement_versions
            (problem_id, version, statement, norm_hash, falsifier, motivation, steward_accepted_by, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM events WHERE id = ?)
        `)
                  .bind(
                    problem.id,
                    next.current_statement_version,
                    next.statement,
                    statementHash,
                    next.falsifier,
                    next.motivation,
                    sponsorId,
                    now,
                    eventId,
                  ),
                db
                  .prepare(`UPDATE claims SET statement_drift = 1
          WHERE problem_id = ? AND statement_version < ? AND EXISTS (SELECT 1 FROM events WHERE id = ?)`)
                  .bind(problem.id, next.current_statement_version, eventId),
              ]
            : []),
          db
            .prepare(`UPDATE problems SET status = ?, current_statement_version = ?, updated_at = ?,
          resolution_summary = CASE WHEN ? = 'retire' THEN ? ELSE resolution_summary END
          WHERE id = ? AND EXISTS (SELECT 1 FROM events WHERE id = ?)`)
            .bind(
              next.status,
              next.current_statement_version,
              now,
              event.action,
              "resolution_summary" in next ? next.resolution_summary : null,
              problem.id,
              eventId,
            ),
          db
            .prepare(`UPDATE public_cursor SET cursor = cursor + 1
          WHERE singleton = 1 AND EXISTS (SELECT 1 FROM events WHERE id = ?)`)
            .bind(eventId),
        ],
      },
    );
  } catch (error) {
    if (error instanceof KraterIdempotencyConflictError) return conflict();
    if (error instanceof KraterLedgerPreconditionError)
      return refusal(
        "OBJECT_VERSION_CONFLICT",
        409,
        "The problem or publishing authority changed while applying this action.",
        "Read the current problem and retry the appropriate action with a new key.",
      );
    throw error;
  }
  const settled = await replay();
  if (!settled) throw new Error("Problem governance write has no retained outcome.");
  return settled;
}
