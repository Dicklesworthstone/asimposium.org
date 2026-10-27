import { ProblemDormancyEventSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import {
  canonicalJson,
  KraterLedgerPreconditionError,
  type KraterWriteHooks,
  sha256Hex,
  writeLedgerEvent,
} from "../krater/krater.ts";

export const PROBLEM_DORMANCY_QUIET_DAYS = 45;
export const PROBLEM_DORMANCY_QUIET_MS = PROBLEM_DORMANCY_QUIET_DAYS * 86_400_000;
export const PROBLEM_DORMANCY_SWEEP_LIMIT = 16;

interface QuietProblem {
  id: string;
  public_seq: number;
  current_statement_version: number;
  last_material_at: string;
  last_material_event_id: string | null;
}

/** One finite pass of the indexed material-activity clock. Every transition
 * records the platform principal explicitly; no sponsor or Fellow is invented.
 * Any concurrent event invalidates the captured head, and a future tick can
 * reconsider it from fresh authoritative state. */
export async function markDormantProblems(
  db: D1Database,
  options: { readonly now?: number; readonly limit?: number } = {},
  hooks: KraterWriteHooks = {},
): Promise<{ examined: number; dormant: number; raced: number; failed: number; hasMore: boolean }> {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? PROBLEM_DORMANCY_SWEEP_LIMIT;
  if (
    !Number.isSafeInteger(now) ||
    now < PROBLEM_DORMANCY_QUIET_MS ||
    now > 8_640_000_000_000_000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > PROBLEM_DORMANCY_SWEEP_LIMIT
  )
    throw new TypeError("Invalid problem dormancy sweep bounds.");
  const changedAt = new Date(now).toISOString();
  const cutoff = new Date(now - PROBLEM_DORMANCY_QUIET_MS).toISOString();
  const candidates = await db
    .prepare(`SELECT id, public_seq, current_statement_version,
      last_material_at, last_material_event_id FROM problems
    WHERE status = 'active' AND last_material_at <= ?
    ORDER BY last_material_at, id LIMIT ?`)
    .bind(cutoff, limit + 1)
    .all<QuietProblem>();
  const result = {
    examined: 0,
    dormant: 0,
    raced: 0,
    failed: 0,
    hasMore: candidates.results.length > limit,
  };
  for (const problem of candidates.results.slice(0, limit)) {
    result.examined++;
    try {
      const payload = ProblemDormancyEventSchema.parse({
        problem_id: problem.id,
        previous_status: "active",
        status: "dormant",
        observed_through: problem.public_seq,
        last_material_event_id: problem.last_material_event_id,
        quiet_since: problem.last_material_at,
        quiet_days: PROBLEM_DORMANCY_QUIET_DAYS,
        changed_at: changedAt,
        acting_principal: { kind: "platform", id: "dormancy-scheduler" },
      });
      const payloadJson = canonicalJson(payload);
      const requestDigest = await sha256Hex(payloadJson);
      // A unique attempt key avoids a changed wall clock conflicting with a
      // losing concurrent attempt; the head precondition is the dedupe law.
      const eventId = `E-DORMANT-${crypto.randomUUID()}`;
      await writeLedgerEvent(
        db,
        {
          problemId: problem.id,
          eventId,
          idempotencyKey: eventId,
          requestDigest,
          eventType: "problem.dormant",
          objectKind: "problem",
          objectId: problem.id,
          objectVersion: problem.current_statement_version,
          payloadJson,
          createdAt: changedAt,
          attribution: {
            principalType: "platform",
            sponsorId: null,
            fellowId: null,
            sessionId: null,
            modelSelfDeclared: null,
            harness: null,
          },
        },
        {
          // MAX(events.seq) is unchanged between Krater's election and append;
          // problems.public_seq changes during election and cannot pin both.
          preconditionSql: ` AND status = 'active' AND current_statement_version = ?
          AND last_material_at = ? AND last_material_at <= ?
          AND last_material_event_id IS ?
          AND EXISTS (SELECT 1 FROM public_cursor WHERE singleton = 1 AND cursor < 9007199254740991)
          AND (SELECT COALESCE(MAX(e.seq), 0) FROM events e WHERE e.problem_id = ?) = ?`,
          preconditionBindings: [
            problem.current_statement_version,
            problem.last_material_at,
            cutoff,
            problem.last_material_event_id,
            problem.id,
            problem.public_seq,
          ],
          statementsAfterEvent: ({ eventId, sequence }) => [
            db
              .prepare(`UPDATE problems SET status = 'dormant' WHERE id = ?
            AND EXISTS (SELECT 1 FROM events WHERE id = ? AND problem_id = ? AND seq = ?)`)
              .bind(problem.id, eventId, problem.id, sequence),
            db
              .prepare(`UPDATE public_cursor SET cursor = cursor + 1 WHERE singleton = 1
            AND EXISTS (SELECT 1 FROM events WHERE id = ? AND problem_id = ? AND seq = ?)`)
              .bind(eventId, problem.id, sequence),
          ],
        },
        hooks,
      );
      result.dormant++;
      console.info(
        JSON.stringify({
          facility: "OPS.2a",
          stage: "problem-dormancy",
          problem_id: problem.id,
          event_id: eventId,
          state: "dormant",
          observed_through: problem.public_seq,
        }),
      );
    } catch (error) {
      if (error instanceof KraterLedgerPreconditionError) result.raced++;
      else result.failed++;
      console.info(
        JSON.stringify({
          facility: "OPS.2a",
          stage: "problem-dormancy",
          problem_id: problem.id,
          state: error instanceof KraterLedgerPreconditionError ? "raced" : "retry",
        }),
      );
    }
  }
  return result;
}
