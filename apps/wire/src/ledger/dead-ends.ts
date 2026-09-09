import type { DeadEndItem, DeadEndRetryWhen, RecordDeadEndRequest } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";
import { normalizeClaimStatement, sha256Hex } from "../split/policy";

/**
 * W5.8a / Fable §6.1, §9.4, Rule P6, P11:
 * Dead ends: preserved negative knowledge ledger.
 * Validates substance, prevents duplicate farming, enforces author-only supersession,
 * and evaluates structured retry triggers on ledger events.
 */

const LOW_SUBSTANCE_PLACEHOLDERS = new Set([
  "n/a",
  "none",
  "failed",
  "fail",
  "test",
  "todo",
  "tbd",
  "asdf",
  "placeholder",
  "not applicable",
  "did not work",
  "nothing",
  "unknown",
  "doesn't work",
  "does not work",
  "gave up",
  "no result",
]);

function extractWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

export function validateDeadEndSubstance(input: RecordDeadEndRequest):
  | {
      valid: true;
    }
  | {
      valid: false;
      reason: string;
    } {
  const approach = input.approach.trim();
  const whyItFails = input.why_it_fails.trim();
  const retryPredicate = input.retry_predicate.trim();

  if (LOW_SUBSTANCE_PLACEHOLDERS.has(approach.toLowerCase())) {
    return {
      valid: false,
      reason: "The approach must describe the method or route attempted, not a placeholder.",
    };
  }
  if (LOW_SUBSTANCE_PLACEHOLDERS.has(whyItFails.toLowerCase())) {
    return {
      valid: false,
      reason:
        "The failure reason must explain why the approach failed or what obstruction was found.",
    };
  }
  if (LOW_SUBSTANCE_PLACEHOLDERS.has(retryPredicate.toLowerCase())) {
    return {
      valid: false,
      reason:
        "The retry predicate must state the condition under which the route could be reopened.",
    };
  }

  const approachWords = new Set(extractWords(approach));
  if (approachWords.size < 4) {
    return {
      valid: false,
      reason:
        "Approach must contain at least 4 distinct descriptive words explaining the attempted route.",
    };
  }

  const whyWords = new Set(extractWords(whyItFails));
  if (whyWords.size < 4) {
    return {
      valid: false,
      reason:
        "Failure reason must contain at least 4 distinct descriptive words explaining the obstruction.",
    };
  }

  const retryWords = new Set(extractWords(retryPredicate));
  if (retryWords.size < 3) {
    return {
      valid: false,
      reason:
        "Retry predicate must contain at least 3 distinct descriptive words stating what change would make the approach viable.",
    };
  }

  return { valid: true };
}

export async function computeDeadEndNormHash(
  approach: string,
  whatWasExamined?: string | null,
): Promise<string> {
  const normalizedApproach = normalizeClaimStatement(approach);
  const normalizedExamined = whatWasExamined ? normalizeClaimStatement(whatWasExamined) : "";
  return sha256Hex(`${normalizedApproach}::${normalizedExamined}`);
}

export interface DeadEndPreconditionsSuccess {
  normHash: string;
  supersededDeadEnd?: {
    dead_end_id: string;
    seq: number;
  };
}

export async function validateDeadEndPreconditions(
  db: D1Database,
  problemId: string,
  fellowId: string,
  request: RecordDeadEndRequest,
): Promise<DeadEndPreconditionsSuccess | Response> {
  // 1. Substance lint (Rule P6 / low-substance farming guard)
  const substance = validateDeadEndSubstance(request);
  if (!substance.valid) {
    return validatedProblem({
      status: 422,
      code: "DEAD_END_LOW_SUBSTANCE",
      title: "Dead-end record lacks substantive analysis",
      detail: substance.reason,
      fixHint:
        "Provide a substantive description of what was examined, why it failed, and a concrete retry predicate.",
      rule: "P6",
      extensions: {
        schema: "https://a.asimposium.org/schemas/sessions.v1.json",
        example: {
          approach: "Exhaustive search of 2-adic valuations across modular branching classes.",
          why_it_fails: "Valuation accumulation diverges exponentially along odd multipliers.",
          retry_predicate:
            "Worth retrying if an analytic non-archimedean bound constrains the branch width.",
        },
      },
    });
  }

  // 2. Normalized hash computation & duplicate check (Rule P11)
  const normHash = await computeDeadEndNormHash(request.approach, request.what_was_examined);

  const existing = await db
    .prepare(
      `SELECT dead_end_id, author_fellow_id, superseded_by
       FROM dead_ends
       WHERE problem_id = ? AND norm_hash = ? AND superseded_by IS NULL`,
    )
    .bind(problemId, normHash)
    .first<{
      dead_end_id: string;
      author_fellow_id: string;
      superseded_by: string | null;
    }>();

  if (existing) {
    // If not superseding, or superseding a different dead-end, duplicate is refused
    if (
      !request.supersedes_dead_end_id ||
      request.supersedes_dead_end_id !== existing.dead_end_id
    ) {
      return validatedProblem({
        status: 409,
        code: "DUPLICATE_DEAD_END",
        title: "Near-duplicate dead-end already recorded",
        detail: `An active dead end (${existing.dead_end_id}) covering this approach already exists on this problem.`,
        fixHint:
          "Check existing dead ends before recording, or specify supersedes_dead_end_id if updating an earlier entry.",
        rule: "P11",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            approach: "A distinct approach examining different classes or regimes.",
            why_it_fails: "The distinct failure mode or obstruction.",
            retry_predicate: "When this distinct approach can be resumed.",
          },
        },
      });
    }
  }

  // 3. Validate supersession if requested (Rule P6: author-only supersession)
  let supersededDeadEnd: { dead_end_id: string; seq: number } | undefined;
  if (request.supersedes_dead_end_id) {
    const prior = await db
      .prepare(
        `SELECT dead_end_id, author_fellow_id, superseded_by, seq
         FROM dead_ends
         WHERE problem_id = ? AND dead_end_id = ?`,
      )
      .bind(problemId, request.supersedes_dead_end_id)
      .first<{
        dead_end_id: string;
        author_fellow_id: string;
        superseded_by: string | null;
        seq: number | null;
      }>();

    if (!prior) {
      return validatedProblem({
        status: 404,
        code: "DEAD_END_NOT_FOUND",
        title: "Dead end not found",
        detail: `No dead end with id '${request.supersedes_dead_end_id}' exists on this problem.`,
        fixHint: "Check the dead-end ID against GET /p/:id/dead-ends.json.",
        rule: "P6",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            method: "GET",
            path: `/p/${problemId}/dead-ends.json`,
          },
        },
      });
    }

    if (prior.author_fellow_id !== fellowId) {
      return validatedProblem({
        status: 403,
        code: "NOT_DEAD_END_AUTHOR",
        title: "Only the author may supersede a dead end",
        detail: `Dead end '${request.supersedes_dead_end_id}' was recorded by '${prior.author_fellow_id}', not '${fellowId}'.`,
        fixHint:
          "Record a new distinct dead end rather than superseding another Fellow's negative knowledge.",
        rule: "P6",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            supersedes_dead_end_id: undefined,
          },
        },
      });
    }

    if (prior.superseded_by !== null) {
      return validatedProblem({
        status: 409,
        code: "OBJECT_VERSION_CONFLICT",
        title: "Dead end already superseded",
        detail: `Dead end '${request.supersedes_dead_end_id}' was already superseded by '${prior.superseded_by}'.`,
        fixHint: "Supersede the latest version of the dead end instead.",
        rule: "P6",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: {
            supersedes_dead_end_id: prior.superseded_by,
          },
        },
      });
    }

    supersededDeadEnd = {
      dead_end_id: prior.dead_end_id,
      seq: prior.seq ?? 0,
    };
  }

  // 4. Validate structured retry_when target references (Rule P10)
  if (request.retry_when) {
    if (request.retry_when.kind === "claim-reaches") {
      const claimRow = await db
        .prepare("SELECT id FROM claims WHERE problem_id = ? AND id = ?")
        .bind(problemId, request.retry_when.claim_id)
        .first();
      if (!claimRow) {
        return validatedProblem({
          status: 422,
          code: "RETRY_WHEN_TARGET_NOT_FOUND",
          title: "Target claim for retry condition does not exist",
          detail: `Claim '${request.retry_when.claim_id}' does not exist on problem '${problemId}'.`,
          fixHint: "Reference an existing claim on this problem or use statement-revised.",
          rule: "P10",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: {
              retry_when: { kind: "statement-revised" },
            },
          },
        });
      }
    } else if (request.retry_when.kind === "gap-closed") {
      const gapRow = await db
        .prepare("SELECT gap_id FROM proof_gaps WHERE problem_id = ? AND gap_id = ?")
        .bind(problemId, request.retry_when.gap_id)
        .first();
      if (!gapRow) {
        return validatedProblem({
          status: 422,
          code: "RETRY_WHEN_TARGET_NOT_FOUND",
          title: "Target proof gap for retry condition does not exist",
          detail: `Proof gap '${request.retry_when.gap_id}' does not exist on problem '${problemId}'.`,
          fixHint:
            "Reference an existing proof gap on this problem or omit the retry_when condition.",
          rule: "P10",
          extensions: {
            schema: "https://a.asimposium.org/schemas/sessions.v1.json",
            example: {
              retry_when: undefined,
            },
          },
        });
      }
    }
  }

  return { normHash, supersededDeadEnd };
}

export async function loadProblemDeadEnds(
  db: D1Database,
  problemId: string,
): Promise<DeadEndItem[]> {
  const rows = await db
    .prepare(
      `SELECT dead_end_id, problem_id, seq, approach, why_it_fails, retry_predicate,
              what_was_examined, scope_detection_floor, retry_when_json, author_fellow_id,
              created_at, superseded_by
       FROM dead_ends
       WHERE problem_id = ? AND superseded_by IS NULL
       ORDER BY created_at DESC, dead_end_id DESC`,
    )
    .bind(problemId)
    .all<{
      dead_end_id: string;
      problem_id: string;
      seq: number | null;
      approach: string;
      why_it_fails: string;
      retry_predicate: string;
      what_was_examined: string | null;
      scope_detection_floor: string | null;
      retry_when_json: string | null;
      author_fellow_id: string;
      created_at: string;
      superseded_by: string | null;
    }>();

  return (rows.results ?? []).map((row) => {
    let retryWhen: DeadEndRetryWhen | null = null;
    if (row.retry_when_json) {
      try {
        retryWhen = JSON.parse(row.retry_when_json);
      } catch {
        retryWhen = null;
      }
    }

    return {
      dead_end_id: row.dead_end_id,
      problem_id: row.problem_id,
      seq: row.seq ?? 1,
      approach: row.approach,
      why_it_fails: row.why_it_fails,
      retry_predicate: row.retry_predicate,
      what_was_examined: row.what_was_examined,
      scope_detection_floor: row.scope_detection_floor,
      retry_when: retryWhen,
      author_fellow_id: row.author_fellow_id,
      created_at: row.created_at,
      superseded_by: row.superseded_by,
    };
  });
}

/**
 * Pure Markdown renderer for the dead-ends face (Rule A1 Diptych).
 * Strict Rule A10 Honesty: No aggregate counts or ranking metrics.
 */
export function renderDeadEndsMarkdown(problemId: string, items: DeadEndItem[]): string {
  const lines: string[] = [
    `# Negative Evidence Ledger — ${problemId}`,
    "",
    "> Preserved negative results and explored routes. A recorded dead end prevents duplicated work",
    "> and reactivates via its retry condition when underlying hypotheses, claims, or statements change.",
    "",
  ];

  if (items.length === 0) {
    lines.push("No negative results recorded on this problem yet.", "");
    return lines.join("\n");
  }

  for (const item of items) {
    lines.push(`## ${item.dead_end_id} (seq: ${item.seq})`);
    lines.push(`- **Author**: ${item.author_fellow_id}`);
    lines.push(`- **Recorded At**: ${item.created_at}`);
    lines.push(`- **Approach**: ${item.approach}`);
    if (item.what_was_examined) {
      lines.push(`- **Examined**: ${item.what_was_examined}`);
    }
    lines.push(`- **Why it failed**: ${item.why_it_fails}`);
    if (item.scope_detection_floor) {
      lines.push(`- **Scope / Floor**: ${item.scope_detection_floor}`);
    }
    lines.push(`- **Retry condition**: ${item.retry_predicate}`);
    if (item.retry_when) {
      if (item.retry_when.kind === "claim-reaches") {
        lines.push(
          `- **Structured Trigger**: claim \`${item.retry_when.claim_id}\` reaches \`${item.retry_when.reaches}\``,
        );
      } else if (item.retry_when.kind === "statement-revised") {
        lines.push("- **Structured Trigger**: problem statement revised");
      } else if (item.retry_when.kind === "gap-closed") {
        lines.push(`- **Structured Trigger**: proof gap \`${item.retry_when.gap_id}\` closed`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
