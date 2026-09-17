import { ProblemGovernanceEventSchema, RecordDeadEndRequestSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { loadProofGaps } from "./proof-gaps-service.ts";
import { foldScientificRows, prepareScientificDispositions } from "./scientific-disposition.ts";
import { readDeadEndRetries, type RetryCursor, type RetryReadDependencies } from "./dead-end-retries.ts";
import { verifyRetryClaimTransition } from "./dead-end-retry-science.ts";

const science = { prepare: prepareScientificDispositions, fold: foldScientificRows };
const dependencies: RetryReadDependencies = {
  decodeSource(payload) {
    // Dead-end events wrap the request with an allocated identity. Project only
    // the existing write fields; neither envelope metadata nor extra prose is
    // executable. Older nullable optional fields mean absent, not invented text.
    const value = Object.fromEntries([
      "approach", "why_it_fails", "retry_predicate", "what_was_examined",
      "scope_detection_floor", "retry_when", "supersedes_dead_end_id",
    ].filter(key => payload[key] !== null && payload[key] !== undefined)
      .map(key => [key, payload[key]]));
    const parsed = RecordDeadEndRequestSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  async condition(db, row, trigger, payload, through) {
    if (trigger.kind === "statement-revised") {
      const parsed = ProblemGovernanceEventSchema.safeParse(payload);
      if (!parsed.success) return "unavailable";
      const event = parsed.data;
      return event.action === "revise-statement" && event.problem.id === row.problem_id &&
        event.problem.current_statement_version === row.object_version &&
        event.acting_principal.id === row.sponsor_id ? "holds" : "unavailable";
    }
    if (trigger.kind === "gap-closed") {
      const result = await loadProofGaps(db, row.problem_id, { through, target: trigger.gap_id });
      const gap = result.face.gaps[0];
      if (result.unlisted || result.face.problem_id !== row.problem_id || result.face.cursor !== through ||
          result.face.target !== trigger.gap_id || result.face.gaps.length !== 1 ||
          result.face.omitted.length > 0 || !gap || !gap.content || gap.status === "unavailable")
        return "unavailable";
      // A recorded closed-by reference is not a verified proof. Read its actual
      // canonical settlement, including present-day withdrawal, before retrying.
      return gap.status === "closed-by" && gap.closed_by !== null &&
        gap.last_event.event_id === row.event_id && gap.last_event.seq === row.seq &&
        gap.last_event.payload_sha256 === row.payload_sha256 ? "holds" : "not-held";
    }
    return verifyRetryClaimTransition(db, row, trigger.claim_id, trigger.reaches, through, science);
  },
};

/** Canonical schemas and evaluator are fixed here, never injectable by HTTP. */
export function loadDeadEndRetryPage(db: D1Database, problem: string, through: number, after?: RetryCursor) {
  return readDeadEndRetries(db, problem, through, dependencies, after);
}
