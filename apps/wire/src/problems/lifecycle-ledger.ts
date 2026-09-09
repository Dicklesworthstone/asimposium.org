import {
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
import { normHash } from "../split/policy";

interface ProblemSnapshot {
  id: string;
  sponsor_id: string | null;
  created_by_fellow_id: string | null;
  title: string;
  status: string;
  current_statement_version: number;
}

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
  action: Extract<ProblemLifecycleActionRequest, { action: "publish" | "revise-statement" }>,
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
      receipt.type !==
        (event.action === "publish" ? "problem.admitted" : "problem.statement-revised")
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
  if (
    publishing
      ? problem.status !== "private-draft"
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
  const formulation = publishing
    ? await db
        .prepare(`
    SELECT statement, falsifier, motivation FROM problem_statement_versions
    WHERE problem_id = ? AND version = ?
  `)
        .bind(problem.id, problem.current_statement_version)
        .first<{
          statement: string;
          falsifier: string;
          motivation: string;
        }>()
    : action;
  const parsed = ProblemGovernanceEventSchema.safeParse({
    action: action.action,
    acting_principal: { type: "sponsor", id: sponsorId },
    source_fellow_id: problem.created_by_fellow_id,
    previous_status: problem.status,
    previous_statement_version: problem.current_statement_version,
    problem: {
      id: problem.id,
      title: problem.title,
      status: publishing ? "sharpening" : problem.status,
      current_statement_version: problem.current_statement_version + (publishing ? 0 : 1),
      statement: formulation?.statement,
      falsifier: formulation?.falsifier,
      motivation: formulation?.motivation,
      updated_at: now,
    },
  });
  if (!parsed.success)
    return refusal(
      "STATEMENT_INCOMPLETE",
      422,
      "Publication requires a complete, versioned problem formulation.",
      "Provide a title, statement, falsifier and motivation before publishing.",
    );
  const event = parsed.data;
  const next = event.problem;
  const eventId = `PG-${crypto.randomUUID()}`;
  const statementHash = publishing ? null : `sha256:${await normHash(next.statement)}`;
  try {
    await writeLedgerEvent(
      db,
      {
        problemId: problem.id,
        eventId,
        idempotencyKey: scopedKey,
        requestDigest: digest,
        eventType: publishing ? "problem.admitted" : "problem.statement-revised",
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
        ${publishing ? "AND EXISTS (SELECT 1 FROM enrollment_fellows WHERE fellow_id = ? AND status = 'active')" : ""}`,
        preconditionBindings: [
          sponsorId,
          problem.status,
          problem.current_statement_version,
          problem.created_by_fellow_id,
          problem.title,
          ...(publishing ? [problem.created_by_fellow_id] : []),
        ],
        statementsAfterEvent: () => [
          ...(!publishing
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
            .prepare(`UPDATE problems SET status = ?, current_statement_version = ?, updated_at = ?
          WHERE id = ? AND EXISTS (SELECT 1 FROM events WHERE id = ?)`)
            .bind(next.status, next.current_statement_version, now, problem.id, eventId),
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
