import {
  type ClaimDependencyPin,
  OPAQUE_PROBLEM_CODES,
  type ProblemCode,
  ProblemGovernanceEventSchema,
  ProblemGovernanceKeySchema,
  type ProblemLifecycleActionRequest,
} from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";
import { notifyProblemFollowersOfStatementRevision } from "../inbox/store";
import {
  genesisChainDigest,
  KraterIdempotencyConflictError,
  KraterLedgerPreconditionError,
  sha256Hex,
  writeLedgerEvent,
} from "../krater/krater";
import { PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL } from "../krater/public-content";
import { prepareDeadEndTriggers } from "../ledger/dead-ends";
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
  admission_mode?: string;
  writer_cap?: number | null;
  canonical_problem_id?: string | null;
  forked_from_problem_id?: string | null;
}

const governanceEventTypes = {
  publish: "problem.admitted",
  "revise-statement": "problem.statement-revised",
  "enter-result-review": "problem.result-review-started",
  retire: "problem.retired",
  "set-admission-mode": "problem.admission-mode-changed",
  "manage-steward": "problem.steward-updated",
  "manage-member": "problem.member-updated",
  "set-writer-cap": "problem.writer-cap-changed",
  merge: "problem.merged",
  fork: "problem.forked",
} as const;

function refusal(code: ProblemCode, status: number, detail: string, fixHint: string): Response {
  const isOpaque = (OPAQUE_PROBLEM_CODES as readonly string[]).includes(code);
  return validatedProblem({
    code,
    status,
    title: "Problem governance write could not be applied",
    detail,
    fixHint,
    ...(isOpaque
      ? {}
      : {
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problems.v1.json",
            example: { action: "publish", headers: { "Idempotency-Key": "publication-1" } },
          },
        }),
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
      {
        problem: event.problem,
        ...(event.action === "fork" ? { forked_problem_id: event.forked_problem_id } : {}),
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  }

  const previous = await replay();
  if (previous) return previous;
  const publishing = action.action === "publish";
  const revising = action.action === "revise-statement";

  // Check lifecycle status transitions
  if (publishing) {
    if (problem.status !== "private-draft") {
      return refusal(
        "OBJECT_VERSION_CONFLICT",
        409,
        "The current problem state does not permit this transition.",
        "Read the current problem before choosing a new lifecycle action.",
      );
    }
  } else if (action.action === "enter-result-review") {
    if (!["active", "dormant"].includes(problem.status)) {
      return refusal(
        "OBJECT_VERSION_CONFLICT",
        409,
        "The current problem state does not permit this transition.",
        "Read the current problem before choosing a new lifecycle action.",
      );
    }
  } else if (action.action === "retire" || revising || action.action === "merge") {
    if (!["sharpening", "active", "dormant", "under-result-review"].includes(problem.status)) {
      return refusal(
        "OBJECT_VERSION_CONFLICT",
        409,
        "The current problem state does not permit this transition.",
        "Read the current problem before choosing a new lifecycle action.",
      );
    }
  } else if (
    ["set-admission-mode", "manage-steward", "manage-member", "set-writer-cap"].includes(
      action.action,
    )
  ) {
    if (problem.status === "retired" || problem.status === "resolved") {
      return refusal(
        "WRITE_REFUSED",
        422,
        "Cannot modify a closed problem.",
        "Fork the problem if you want to explore an alternate formulation.",
      );
    }
  }

  // Steward authority check: creator sponsor or active steward in problem_stewards
  const steward = await db
    .prepare("SELECT 1 FROM problem_stewards WHERE problem_id = ? AND sponsor_id = ?")
    .bind(problem.id, sponsorId)
    .first();
  if (!steward && problem.sponsor_id !== sponsorId) {
    return problemGovernanceRefused();
  }

  if (publishing) {
    if (!problem.created_by_fellow_id) return problemGovernanceRefused();
    const fellow = await db
      .prepare("SELECT status FROM enrollment_fellows WHERE fellow_id = ?")
      .bind(problem.created_by_fellow_id)
      .first<{ status: string }>();
    if (fellow?.status !== "active") return problemGovernanceRefused();
  }

  if (action.action === "merge") {
    if (action.canonical_problem_id === problem.id) {
      return refusal(
        "WRITE_REFUSED",
        422,
        "Cannot merge a problem into itself.",
        "Provide a different canonical problem ID.",
      );
    }
    const canonical = await db
      .prepare("SELECT id, status FROM problems WHERE id = ?")
      .bind(action.canonical_problem_id)
      .first<{ id: string; status: string }>();
    if (!canonical || canonical.status === "retired") {
      return refusal(
        "OBJECT_VERSION_CONFLICT",
        409,
        "Canonical problem does not exist or is retired.",
        "Merge only into an existing active, sharpening, or dormant problem.",
      );
    }
  }

  if (action.action === "manage-steward" && action.operation === "remove") {
    const stewardCount = await db
      .prepare("SELECT COUNT(*) as count FROM problem_stewards WHERE problem_id = ?")
      .bind(problem.id)
      .first<{ count: number }>();
    if (
      (stewardCount?.count ?? 1) <= 1 &&
      (action.target_sponsor_id === sponsorId || action.target_sponsor_id === problem.sponsor_id)
    ) {
      return refusal(
        "WRITE_REFUSED",
        422,
        "Cannot remove the sole steward of a problem.",
        "Add another steward before removing this one.",
      );
    }
  }

  let parentCursor = 0;
  let forkedProblemId = "";
  if (action.action === "fork") {
    const cursorRow = await db
      .prepare("SELECT cursor FROM public_cursor WHERE singleton = 1")
      .first<{ cursor: number }>();
    parentCursor = cursorRow?.cursor ?? 0;
    forkedProblemId = `P-${crypto.randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase()}`;
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

  const rawEventPayload: Record<string, unknown> = {
    action: action.action,
    acting_principal: { type: "sponsor", id: sponsorId },
    source_fellow_id: problem.created_by_fellow_id ?? "fellow-sponsor",
    previous_status: problem.status,
    previous_statement_version: problem.current_statement_version,
    problem: {
      id: problem.id,
      title: problem.title,
      status: publishing
        ? "sharpening"
        : action.action === "enter-result-review"
          ? "under-result-review"
          : action.action === "retire" || action.action === "merge"
            ? "retired"
            : problem.status,
      current_statement_version: problem.current_statement_version + (revising ? 1 : 0),
      statement: formulation?.statement,
      falsifier: formulation?.falsifier,
      motivation: formulation?.motivation,
      ...(action.action === "retire" ? { resolution_summary: action.reason } : {}),
      ...(action.action === "merge"
        ? {
            resolution_summary: `Merged into ${action.canonical_problem_id}`,
            canonical_problem_id: action.canonical_problem_id,
          }
        : {}),
      ...(action.action === "set-admission-mode" ? { admission_mode: action.mode } : {}),
      ...(action.action === "set-writer-cap" ? { writer_cap: action.writer_cap } : {}),
      ...(resultClaim ? { result_claim: resultClaim } : {}),
      updated_at: now,
    },
  };

  if (action.action === "manage-steward") {
    rawEventPayload.operation = action.operation;
    rawEventPayload.target_sponsor_id = action.target_sponsor_id;
  } else if (action.action === "manage-member") {
    rawEventPayload.operation = action.operation;
    rawEventPayload.target_fellow_id = action.target_fellow_id;
    if (action.role) rawEventPayload.role = action.role;
  } else if (action.action === "merge") {
    rawEventPayload.canonical_problem_id = action.canonical_problem_id;
    if (action.claim_mapping) rawEventPayload.claim_mapping = action.claim_mapping;
  } else if (action.action === "fork") {
    rawEventPayload.forked_problem_id = forkedProblemId;
    rawEventPayload.parent_problem_id = problem.id;
    rawEventPayload.parent_cursor = parentCursor;
  }

  const parsed = ProblemGovernanceEventSchema.safeParse(rawEventPayload);
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
        preconditionSql: ` AND (sponsor_id = ? OR EXISTS (SELECT 1 FROM problem_stewards WHERE problem_id = ? AND sponsor_id = ?))
        AND status = ? AND current_statement_version = ? AND title = ?
        AND EXISTS (SELECT 1 FROM public_cursor WHERE singleton = 1 AND cursor < 9007199254740991)
        ${publishing ? "AND created_by_fellow_id = ? AND EXISTS (SELECT 1 FROM enrollment_fellows WHERE fellow_id = ? AND status = 'active')" : ""}
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
          problem.id,
          sponsorId,
          problem.status,
          problem.current_statement_version,
          problem.title,
          ...(publishing && problem.created_by_fellow_id
            ? [problem.created_by_fellow_id, problem.created_by_fellow_id]
            : []),
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
        statementsAfterEvent: async ({ sequence, payloadSha256 }) => {
          const stmts: D1PreparedStatement[] = [
            ...(await prepareDeadEndTriggers(db, problem.id, {
              sequence,
              claimId: problem.id,
              eventId,
              event: {
                type: governanceEventTypes[event.action],
                objectId: problem.id,
                objectVersion: next.current_statement_version,
                payloadJson: JSON.stringify(event),
                payloadSha256,
                createdAt: now,
                fellowId: null,
                sponsorId,
              },
            })),
          ];

          if (revising) {
            stmts.push(
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
            );
          }

          if (publishing) {
            stmts.push(
              db
                .prepare(`
                  INSERT OR IGNORE INTO problem_stewards (problem_id, sponsor_id, is_founding, created_at)
                  VALUES (?, ?, 1, ?)
                `)
                .bind(problem.id, sponsorId, now),
              db
                .prepare(`
                  UPDATE problems SET admission_mode = 'open'
                  WHERE id = ? AND admission_mode = 'approval-required' AND unlisted = 0
                `)
                .bind(problem.id),
            );
          }

          if (action.action === "set-admission-mode") {
            stmts.push(
              db
                .prepare(
                  `UPDATE problems SET admission_mode = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM events WHERE id = ?)`,
                )
                .bind(action.mode, now, problem.id, eventId),
            );
          }

          if (action.action === "set-writer-cap") {
            stmts.push(
              db
                .prepare(
                  `UPDATE problems SET writer_cap = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM events WHERE id = ?)`,
                )
                .bind(action.writer_cap, now, problem.id, eventId),
            );
          }

          if (action.action === "manage-steward") {
            if (action.operation === "add") {
              stmts.push(
                db
                  .prepare(`
                    INSERT INTO problem_stewards (problem_id, sponsor_id, is_founding, created_at)
                    VALUES (?, ?, 0, ?)
                    ON CONFLICT(problem_id, sponsor_id) DO NOTHING
                  `)
                  .bind(problem.id, action.target_sponsor_id, now),
              );
            } else if (action.operation === "transfer") {
              stmts.push(
                db
                  .prepare(`
                    INSERT INTO problem_stewards (problem_id, sponsor_id, is_founding, created_at)
                    VALUES (?, ?, 0, ?)
                    ON CONFLICT(problem_id, sponsor_id) DO NOTHING
                  `)
                  .bind(problem.id, action.target_sponsor_id, now),
                db
                  .prepare("DELETE FROM problem_stewards WHERE problem_id = ? AND sponsor_id = ?")
                  .bind(problem.id, sponsorId),
                db
                  .prepare("UPDATE problems SET sponsor_id = ? WHERE id = ? AND sponsor_id = ?")
                  .bind(action.target_sponsor_id, problem.id, sponsorId),
              );
            } else if (action.operation === "remove") {
              stmts.push(
                db
                  .prepare("DELETE FROM problem_stewards WHERE problem_id = ? AND sponsor_id = ?")
                  .bind(problem.id, action.target_sponsor_id),
                db
                  .prepare(`
                    UPDATE problems SET sponsor_id = (SELECT sponsor_id FROM problem_stewards WHERE problem_id = ? LIMIT 1)
                    WHERE id = ? AND sponsor_id = ?
                  `)
                  .bind(problem.id, problem.id, action.target_sponsor_id),
              );
            }
          }

          if (action.action === "manage-member") {
            if (action.operation === "set-role") {
              stmts.push(
                db
                  .prepare(`
                    INSERT INTO problem_memberships (problem_id, fellow_id, role, joined_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(problem_id, fellow_id) DO UPDATE SET role = excluded.role
                  `)
                  .bind(problem.id, action.target_fellow_id, action.role ?? "contributor", now),
              );
            } else if (action.operation === "remove") {
              // ADR-22: remove a fellow from the problem but NEVER touch global identity or tokens
              stmts.push(
                db
                  .prepare("DELETE FROM problem_memberships WHERE problem_id = ? AND fellow_id = ?")
                  .bind(problem.id, action.target_fellow_id),
              );
            }
          }

          if (action.action === "merge") {
            stmts.push(
              db
                .prepare(`
                  INSERT INTO problem_merges (problem_id, canonical_problem_id, claim_mapping_json, merged_by_sponsor_id, event_id, created_at)
                  VALUES (?, ?, ?, ?, ?, ?)
                `)
                .bind(
                  problem.id,
                  action.canonical_problem_id,
                  action.claim_mapping ? JSON.stringify(action.claim_mapping) : "{}",
                  sponsorId,
                  eventId,
                  now,
                ),
            );
          }

          if (action.action === "fork") {
            const forkStatement = action.statement ?? formulation?.statement ?? "";
            const forkFalsifier = action.falsifier ?? formulation?.falsifier ?? "";
            const forkMotivation = action.motivation ?? formulation?.motivation ?? "";
            const forkHash = `sha256:${await normHash(forkStatement)}`;
            const genesis = await genesisChainDigest(forkedProblemId);

            stmts.push(
              db
                .prepare(`
                  INSERT INTO problems (
                    id, public_seq, status, unlisted, sponsor_id, created_by_fellow_id,
                    title, current_statement_version, chain_version, chain_digest,
                    admission_mode, forked_from_problem_id, forked_from_cursor,
                    created_at, updated_at, areas
                  ) VALUES (?, 0, 'private-draft', 0, ?, ?, ?, 1, 2, ?, 'approval-required', ?, ?, ?, ?, ?)
                `)
                .bind(
                  forkedProblemId,
                  sponsorId,
                  problem.created_by_fellow_id,
                  action.title,
                  genesis,
                  problem.id,
                  parentCursor,
                  now,
                  now,
                  "[]",
                ),
              db
                .prepare(`
                  INSERT INTO problem_statement_versions (
                    problem_id, version, statement, norm_hash, falsifier, motivation,
                    steward_accepted_by, created_at
                  ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)
                `)
                .bind(
                  forkedProblemId,
                  forkStatement,
                  forkHash,
                  forkFalsifier,
                  forkMotivation,
                  sponsorId,
                  now,
                ),
              db
                .prepare(`
                  INSERT INTO problem_stewards (problem_id, sponsor_id, is_founding, created_at)
                  VALUES (?, ?, 1, ?)
                `)
                .bind(forkedProblemId, sponsorId, now),
              db
                .prepare(`
                  INSERT INTO problem_forks (problem_id, parent_problem_id, parent_cursor, forked_by_sponsor_id, event_id, created_at)
                  VALUES (?, ?, ?, ?, ?, ?)
                `)
                .bind(forkedProblemId, problem.id, parentCursor, sponsorId, eventId, now),
              db
                .prepare(`
                  INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version)
                  VALUES (?, 'complete', 0, ?, 2)
                `)
                .bind(forkedProblemId, now),
            );
          }

          // Main problems table update
          stmts.push(
            db
              .prepare(`UPDATE problems SET status = ?, current_statement_version = ?, updated_at = ?,
                resolution_summary = CASE
                  WHEN ? = 'retire' THEN ?
                  WHEN ? = 'merge' THEN ?
                  ELSE resolution_summary
                END,
                canonical_problem_id = CASE WHEN ? = 'merge' THEN ? ELSE canonical_problem_id END
                WHERE id = ? AND EXISTS (SELECT 1 FROM events WHERE id = ?)`)
              .bind(
                next.status,
                next.current_statement_version,
                now,
                event.action,
                "resolution_summary" in next ? next.resolution_summary : null,
                event.action,
                action.action === "merge" ? `Merged into ${action.canonical_problem_id}` : null,
                event.action,
                action.action === "merge" ? action.canonical_problem_id : null,
                problem.id,
                eventId,
              ),
            db
              .prepare(`UPDATE public_cursor SET cursor = cursor + 1
                WHERE singleton = 1 AND EXISTS (SELECT 1 FROM events WHERE id = ?)`)
              .bind(eventId),
          );

          return stmts;
        },
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

  if (revising) {
    try {
      await notifyProblemFollowersOfStatementRevision(
        db,
        problem.id,
        next.current_statement_version,
        eventId,
      );
    } catch (e) {
      console.warn("Failed to notify problem followers of statement revision:", e);
    }
  }

  // OPS.2a structured diagnostic log (secret-safe)
  console.info(
    JSON.stringify({
      facility: "OPS.2a",
      stage: "problem-governance",
      problem_id: problem.id,
      actor_sponsor_id: sponsorId,
      action: action.action,
      previous_statement_version: problem.current_statement_version,
      new_statement_version: next.current_statement_version,
      event_id: eventId,
      timestamp: now,
    }),
  );

  return settled;
}
