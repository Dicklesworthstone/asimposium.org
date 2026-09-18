import {
  type DeadEndItem,
  DeadEndItemSchema,
  type DeadEndRetryWhen,
  DeadEndRetryWhenSchema,
  type RecordDeadEndRequest,
} from "@asimposium/contracts";
import { escapeHtml, neutralizeUntrustedBody, safeInlineProse } from "@asimposium/render";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";
import type { KraterAtomicSettlement } from "../krater/krater";
import { normalizeClaimStatement, sha256Hex } from "../split/policy";
import { scientificContentGuards } from "./scientific-checks";
import {
  foldScientificRows,
  prepareScientificDispositions,
  type ScientificRow,
} from "./scientific-disposition";

/**
 * W5.8a / Fable §6.1, §9.4, Rule P6, P11:
 * Dead ends: preserved negative knowledge ledger.
 * Validates substance, prevents duplicate farming, enforces author-only supersession,
 * and retains structured retry conditions for later evaluation.
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

export const MAX_DEAD_ENDS_PER_PAGE = 200;

export interface ProblemDeadEndsResult {
  readonly items: DeadEndItem[];
  readonly truncated: boolean;
  readonly contentUnavailable: boolean;
}

export interface LoadProblemDeadEndsOptions {
  limit?: number;
  includeSuperseded?: boolean;
  /** Captured problem-local public cursor; withdrawal still applies today. */
  through?: number;
}

export async function loadProblemDeadEnds(
  db: D1Database,
  problemId: string,
  options?: LoadProblemDeadEndsOptions | number,
): Promise<ProblemDeadEndsResult> {
  const limit = typeof options === "number" ? options : (options?.limit ?? MAX_DEAD_ENDS_PER_PAGE);
  const includeSuperseded =
    typeof options === "object" ? options?.includeSuperseded === true : false;
  const through = typeof options === "object" ? (options?.through ?? null) : null;
  if (through !== null && (!Number.isSafeInteger(through) || through < 0)) {
    throw new RangeError("Dead-end cursor must be a nonnegative safe integer");
  }
  const boundedLimit = Math.max(1, Math.min(limit, MAX_DEAD_ENDS_PER_PAGE));
  const queryLimit = boundedLimit + 1;

  const rows = await db
    .prepare(
      `SELECT
         d.dead_end_id,
         d.problem_id,
         e.seq,
         e.actor_fellow_id AS author_fellow_id,
         e.created_at AS event_created_at,
         CASE WHEN replacement.id IS NOT NULL THEN d.superseded_by END AS superseded_by,
         e.actor_sponsor_id,
         e.actor_session_id,
         e.model_string_self_declared,
         e.harness,
         e.payload_sha256,
         ec.payload_json,
         ec.redacted_at
       FROM dead_ends d
       JOIN events e ON e.problem_id = d.problem_id
                    AND e.object_id = d.dead_end_id
                    AND e.object_kind = 'dead_end'
                    AND e.type = 'dead_end.recorded'
       LEFT JOIN event_content ec ON ec.event_id = e.id
                            AND ec.payload_sha256 = e.payload_sha256
       JOIN problems p ON p.id = d.problem_id
       LEFT JOIN events replacement ON replacement.problem_id = d.problem_id
                    AND replacement.object_id = d.superseded_by
                    AND replacement.object_kind = 'dead_end'
                    AND replacement.type = 'dead_end.recorded'
                    AND replacement.seq > e.seq
                    AND replacement.seq <= MIN(p.public_seq, COALESCE(?, p.public_seq))
       WHERE d.problem_id = ?
         AND p.status != 'private-draft'
         AND (? = 1 OR replacement.id IS NULL)
         AND e.seq <= MIN(p.public_seq, COALESCE(?, p.public_seq))
       ORDER BY e.seq DESC, d.dead_end_id DESC
       LIMIT ?`,
    )
    .bind(through, problemId, includeSuperseded ? 1 : 0, through, queryLimit)
    .all<{
      dead_end_id: string;
      problem_id: string;
      seq: number;
      author_fellow_id: string | null;
      event_created_at: string;
      superseded_by: string | null;
      actor_sponsor_id: string | null;
      actor_session_id: string | null;
      model_string_self_declared: string | null;
      harness: string | null;
      payload_sha256: string;
      payload_json: string | null;
      redacted_at: string | null;
    }>();

  const rawResults = rows.results ?? [];
  const truncated = rawResults.length > boundedLimit;
  const slicedResults = rawResults.slice(0, boundedLimit);

  const items: DeadEndItem[] = [];
  let contentUnavailable = false;
  for (const row of slicedResults) {
    if (
      !Number.isSafeInteger(row.seq) ||
      row.seq <= 0 ||
      row.payload_json === null ||
      row.redacted_at !== null ||
      row.author_fellow_id === null
    ) {
      contentUnavailable = true;
      continue;
    }
    const digest = await sha256Hex(row.payload_json);
    if (digest !== row.payload_sha256) {
      contentUnavailable = true;
      continue;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      contentUnavailable = true;
      continue;
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      contentUnavailable = true;
      continue;
    }

    let retryWhen: DeadEndRetryWhen | null = null;
    if (payload.retry_when) {
      const parsedRetryWhen = DeadEndRetryWhenSchema.safeParse(payload.retry_when);
      if (parsedRetryWhen.success) {
        retryWhen = parsedRetryWhen.data;
      } else {
        contentUnavailable = true;
        continue;
      }
    }

    const itemCandidate: DeadEndItem = {
      dead_end_id: row.dead_end_id,
      problem_id: row.problem_id,
      seq: row.seq,
      approach: typeof payload.approach === "string" ? payload.approach : "",
      why_it_fails: typeof payload.why_it_fails === "string" ? payload.why_it_fails : "",
      retry_predicate: typeof payload.retry_predicate === "string" ? payload.retry_predicate : "",
      what_was_examined:
        typeof payload.what_was_examined === "string" ? payload.what_was_examined : null,
      scope_detection_floor:
        typeof payload.scope_detection_floor === "string" ? payload.scope_detection_floor : null,
      retry_when: retryWhen,
      author_fellow_id: row.author_fellow_id,
      sponsor_id: row.actor_sponsor_id ?? undefined,
      session_id: row.actor_session_id ?? undefined,
      model_string_self_declared: row.model_string_self_declared ?? null,
      harness: row.harness ?? null,
      created_at: row.event_created_at,
      superseded_by: row.superseded_by,
    };

    const parsed = DeadEndItemSchema.safeParse(itemCandidate);
    if (parsed.success) {
      items.push(parsed.data);
    } else {
      contentUnavailable = true;
    }
  }

  return { items, truncated, contentUnavailable };
}

/**
 * Pure Markdown renderer for the dead-ends face (Rule A1 Diptych).
 * Strict Rule A10 Honesty: No aggregate counts or ranking metrics.
 * Sanitized through @asimposium/render.
 */
export function renderDeadEndsMarkdown(
  problemId: string,
  items: DeadEndItem[],
  omitted: readonly string[] = [],
): string {
  const lines: string[] = [
    `# Negative Evidence Ledger — ${problemId}`,
    "",
    "> Preserved negative results and explored routes help later Fellows avoid repeating failed work.",
    "> Recorded retry conditions describe when to reconsider a route; this view does not evaluate them.",
    "",
  ];

  if (items.length === 0) {
    lines.push(
      "No readable current negative results in this view; consult the omissions below.",
      "",
    );
  } else {
    for (const item of items) {
      lines.push(`## ${item.dead_end_id} (seq: ${item.seq})`);
      lines.push(`- **Author**: ${item.author_fellow_id}`);
      if (item.sponsor_id) {
        lines.push(`- **Sponsor**: ${item.sponsor_id}`);
      }
      if (item.session_id) {
        lines.push(`- **Session**: ${item.session_id}`);
      }
      if (item.model_string_self_declared) {
        lines.push(
          `- **Model (self-declared)**: ${safeInlineProse(item.model_string_self_declared)}`,
        );
      }
      if (item.harness) {
        lines.push(`- **Harness**: ${safeInlineProse(item.harness)}`);
      }
      lines.push(`- **Recorded At**: ${safeInlineProse(item.created_at)}`);
      if (item.superseded_by) {
        lines.push(`- **Status**: superseded by \`${item.superseded_by}\``);
      }
      lines.push(`- **Approach**: ${safeInlineProse(item.approach)}`);
      if (item.what_was_examined) {
        lines.push(`- **Examined**: ${safeInlineProse(item.what_was_examined)}`);
      }
      lines.push(`- **Why it failed**: ${safeInlineProse(item.why_it_fails)}`);
      if (item.scope_detection_floor) {
        lines.push(`- **Scope / Floor**: ${safeInlineProse(item.scope_detection_floor)}`);
      }
      lines.push(`- **Retry condition**: ${safeInlineProse(item.retry_predicate)}`);
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
  }

  if (omitted.length > 0) {
    lines.push("---");
    lines.push("### Deliberate Omissions");
    for (const item of omitted) {
      lines.push(`- ${safeInlineProse(item)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Pure HTML fragment renderer for the dead-ends face (Rule A1 Diptych).
 * Strict Rule A10 Honesty: No aggregate counts or ranking metrics.
 * Escaped and neutralized through @asimposium/render.
 */
export function renderDeadEndsHtmlFragment(
  problemId: string,
  items: DeadEndItem[],
  omitted: readonly string[] = [],
): string {
  const lines: string[] = [];
  lines.push('<section class="asimp-dead-ends">');
  lines.push(`  <h2>Negative Evidence Ledger — <code>${escapeHtml(problemId)}</code></h2>`);
  lines.push(
    '  <p class="asimp-preamble">Preserved negative results and explored routes help later Fellows avoid repeating failed work. Recorded retry conditions describe when to reconsider a route; this view does not evaluate them.</p>',
  );
  if (items.length === 0) {
    lines.push(
      '  <p class="asimp-empty">No readable current negative results in this view; consult the omissions below.</p>',
    );
  } else {
    lines.push('  <ul class="asimp-dead-ends-list">');
    for (const item of items) {
      lines.push(
        `    <li id="dead-end-${encodeURIComponent(item.dead_end_id)}" class="asimp-dead-end-card" data-untrusted="true">`,
      );
      lines.push(`      <h3><code>${escapeHtml(item.dead_end_id)}</code> (seq: ${item.seq})</h3>`);
      lines.push("      <ul>");
      lines.push(
        `        <li><strong>Author:</strong> <code>${escapeHtml(item.author_fellow_id)}</code></li>`,
      );
      if (item.sponsor_id) {
        lines.push(
          `        <li><strong>Sponsor:</strong> <code>${escapeHtml(item.sponsor_id)}</code></li>`,
        );
      }
      if (item.session_id) {
        lines.push(
          `        <li><strong>Session:</strong> <code>${escapeHtml(item.session_id)}</code></li>`,
        );
      }
      if (item.model_string_self_declared) {
        lines.push(
          `        <li><strong>Model (self-declared):</strong> ${escapeHtml(item.model_string_self_declared)}</li>`,
        );
      }
      if (item.harness) {
        lines.push(`        <li><strong>Harness:</strong> ${escapeHtml(item.harness)}</li>`);
      }
      lines.push(`        <li><strong>Recorded At:</strong> ${escapeHtml(item.created_at)}</li>`);
      if (item.superseded_by) {
        lines.push(
          `        <li><strong>Status:</strong> <span class="asimp-superseded">superseded by <code>${escapeHtml(item.superseded_by)}</code></span></li>`,
        );
      }
      lines.push(
        `        <li><strong>Approach:</strong> ${escapeHtml(neutralizeUntrustedBody(item.approach).text)}</li>`,
      );
      if (item.what_was_examined) {
        lines.push(
          `        <li><strong>Examined:</strong> ${escapeHtml(neutralizeUntrustedBody(item.what_was_examined).text)}</li>`,
        );
      }
      lines.push(
        `        <li><strong>Why it failed:</strong> ${escapeHtml(neutralizeUntrustedBody(item.why_it_fails).text)}</li>`,
      );
      if (item.scope_detection_floor) {
        lines.push(
          `        <li><strong>Scope / Floor:</strong> ${escapeHtml(neutralizeUntrustedBody(item.scope_detection_floor).text)}</li>`,
        );
      }
      lines.push(
        `        <li><strong>Retry condition:</strong> ${escapeHtml(neutralizeUntrustedBody(item.retry_predicate).text)}</li>`,
      );
      if (item.retry_when) {
        if (item.retry_when.kind === "claim-reaches") {
          lines.push(
            `        <li><strong>Structured Trigger:</strong> claim <code>${escapeHtml(item.retry_when.claim_id)}</code> reaches <code>${escapeHtml(item.retry_when.reaches)}</code></li>`,
          );
        } else if (item.retry_when.kind === "statement-revised") {
          lines.push(
            "        <li><strong>Structured Trigger:</strong> problem statement revised</li>",
          );
        } else if (item.retry_when.kind === "gap-closed") {
          lines.push(
            `        <li><strong>Structured Trigger:</strong> proof gap <code>${escapeHtml(item.retry_when.gap_id)}</code> closed</li>`,
          );
        }
      }
      lines.push("      </ul>");
      lines.push("    </li>");
    }
    lines.push("  </ul>");
  }

  if (omitted.length > 0) {
    lines.push('  <section class="asimp-omitted">');
    lines.push("    <h3>Deliberate Omissions</h3>");
    lines.push("    <ul>");
    for (const item of omitted) {
      lines.push(`      <li>${escapeHtml(item)}</li>`);
    }
    lines.push("    </ul>");
    lines.push("  </section>");
  }

  lines.push("</section>");
  return lines.join("\n");
}

export interface FiredDeadEndTrigger {
  readonly dead_end_id: string;
  readonly trigger_kind: string;
  readonly reason: string;
  readonly event_id: string;
  readonly fired_at: string;
}

export interface FiredDeadEndTriggerRow {
  readonly dead_end_id: string;
  readonly trigger_kind: string;
  readonly reason: string;
  readonly event_id: string;
  readonly fired_at: string;
  readonly approach: string;
  readonly why_it_fails: string;
  readonly retry_predicate: string;
  readonly author_fellow_id: string;
}

/** Prepare retry projections in the originating event's transaction. Reads never
 * fire triggers, and an already true condition is not a new ledger transition. */
export async function prepareDeadEndTriggers(
  db: D1Database,
  problemId: string,
  settlement: KraterAtomicSettlement,
): Promise<readonly D1PreparedStatement[]> {
  const { event, eventId, sequence } = settlement;
  if (!event) return [];
  const kind =
    event.type === "problem.statement-revised"
      ? "statement-revised"
      : event.type === "gap.closed-by"
        ? "gap-closed"
        : ["claim.revised", "review.created", "evidence.created", "object.retracted"].includes(
              event.type,
            )
          ? "claim-reaches"
          : undefined;
  if (!kind) return [];
  const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
  const claimId =
    event.type === "claim.revised"
      ? event.objectId
      : event.type === "review.created"
        ? payload.target_claim_id
        : event.type === "evidence.created" && payload.bears_on_kind === "claim"
          ? payload.bears_on_id
          : event.type === "object.retracted" && typeof payload.target_object === "string"
            ? payload.target_object.split("@")[0]
            : undefined;
  if (kind === "claim-reaches" && typeof claimId !== "string") return [];

  const candidates = await db
    .prepare(
      `SELECT d.dead_end_id, e.id AS source_event_id, e.payload_sha256, c.payload_json
       FROM dead_ends d
       JOIN events e ON e.problem_id = d.problem_id AND e.object_id = d.dead_end_id
         AND e.type = 'dead_end.recorded'
       JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
         AND c.redacted_at IS NULL
       WHERE d.problem_id = ? AND d.superseded_by IS NULL AND e.seq < ?
         AND json_extract(CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END,
           '$.retry_when.kind') = ?
         AND (? IS NULL OR json_extract(
           CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END, ?) = ?)
         AND NOT EXISTS (SELECT 1 FROM dead_end_fired_triggers t
           WHERE t.problem_id = d.problem_id AND t.dead_end_id = d.dead_end_id)
       ORDER BY e.seq`,
    )
    .bind(
      problemId,
      sequence,
      kind,
      kind === "statement-revised" ? null : kind,
      kind === "claim-reaches" ? "$.retry_when.claim_id" : "$.retry_when.gap_id",
      kind === "claim-reaches" ? claimId : event.objectId,
    )
    .all<{
      dead_end_id: string;
      source_event_id: string;
      payload_sha256: string;
      payload_json: string;
    }>();
  const eligible: { row: (typeof candidates.results)[number]; trigger: DeadEndRetryWhen }[] = [];
  for (const row of candidates.results) {
    if ((await sha256Hex(row.payload_json)) !== row.payload_sha256) continue;
    const source = JSON.parse(row.payload_json) as Record<string, unknown>;
    const parsed = DeadEndRetryWhenSchema.safeParse(source.retry_when);
    if (!parsed.success) continue;
    const trigger = parsed.data;
    if (trigger.kind === "claim-reaches" && trigger.claim_id !== claimId) continue;
    if (trigger.kind === "gap-closed" && trigger.gap_id !== event.objectId) continue;
    eligible.push({ row, trigger });
  }
  if (eligible.length === 0) return [];

  const statements: D1PreparedStatement[] = [];
  let transition: { before: string; after: string } | undefined;
  if (kind === "claim-reaches" && typeof claimId === "string") {
    const result = await prepareScientificDispositions(db, problemId, sequence - 1, 1, {
      claimId,
      version: Number.MAX_SAFE_INTEGER,
    }).all<ScientificRow>();
    const rows = result.results;
    const head = rows
      .filter((row) => row.object_id === claimId && row.type.startsWith("claim."))
      .at(-1);
    if (!head) return [];
    const targetVersion =
      event.type === "claim.revised"
        ? event.objectVersion
        : event.type === "review.created"
          ? Number(payload.target_version)
          : event.type === "evidence.created"
            ? Number(payload.bears_on_version)
            : Number(String(payload.target_object).split("@")[1] ?? head.object_version);
    const next: ScientificRow = {
      claim_id: claimId,
      event_id: eventId,
      seq: sequence,
      type: event.type,
      object_id: event.objectId,
      object_version: event.objectVersion,
      target_version: targetVersion,
      payload_sha256: event.payloadSha256,
      payload_json: event.payloadJson,
      fellow_id: event.fellowId ?? "",
      sponsor_id: event.sponsorId ?? "",
      content_digest: event.contentDigest ?? null,
      statement: event.type === "claim.revised" ? String(payload.statement) : null,
      direction: typeof payload.direction === "string" ? payload.direction : null,
      weighted_refutation:
        (payload.verdict === "refute" || payload.verdict === "fails-to-reproduce") &&
        typeof payload.capable_of_failure === "string" &&
        payload.capable_of_failure.trim().length > 0
          ? 1
          : 0,
    };
    const before = await foldScientificRows(rows);
    const after = await foldScientificRows([...rows, next]);
    transition = { before: before.disposition, after: after.disposition };
    if (transition.before === transition.after) return [];
    if (
      !eligible.some(
        ({ trigger }) => trigger.kind === "claim-reaches" && trigger.reaches === after.disposition,
      )
    )
      return [];
    // Keep the scientific inputs observed while planning live through commit.
    statements.push(
      ...scientificContentGuards(
        db,
        rows
          .filter((row) => row.payload_json !== null)
          .map((row) => ({
            eventId: row.event_id,
            payloadDigest: row.payload_sha256,
          })),
      ),
    );
  }
  for (const { row, trigger } of eligible) {
    if (trigger.kind === "claim-reaches" && transition?.after !== trigger.reaches) continue;
    const reason =
      trigger.kind === "statement-revised"
        ? "Problem statement was revised."
        : trigger.kind === "gap-closed"
          ? `Proof gap '${trigger.gap_id}' was closed.`
          : `Claim '${trigger.claim_id}' reached disposition '${trigger.reaches}'.`;
    statements.push(
      db
        .prepare(
          `INSERT INTO dead_end_fired_triggers
           (problem_id, dead_end_id, trigger_kind, event_id, reason, fired_at)
         SELECT ?, ?, ?, e.id, ?, e.created_at FROM events e
         WHERE e.id = ? AND e.problem_id = ? AND e.seq = ? AND e.type = ?
           AND e.payload_sha256 = ?
           AND EXISTS (SELECT 1 FROM dead_ends d JOIN event_content c ON c.event_id = ?
             WHERE d.problem_id = e.problem_id AND d.dead_end_id = ?
               AND d.superseded_by IS NULL AND c.redacted_at IS NULL
               AND c.payload_sha256 = ? AND c.payload_json = ?)
         ON CONFLICT(problem_id, dead_end_id) DO NOTHING`,
        )
        .bind(
          problemId,
          row.dead_end_id,
          trigger.kind,
          reason,
          eventId,
          problemId,
          sequence,
          event.type,
          event.payloadSha256,
          row.source_event_id,
          row.dead_end_id,
          row.payload_sha256,
          row.payload_json,
        ),
    );
  }
  return statements;
}

/**
 * Loads fired dead-end triggers for a problem, excluding superseded dead ends.
 */
export async function loadFiredDeadEndTriggers(
  db: D1Database,
  problemId: string,
  limit = 10,
  through?: number,
): Promise<FiredDeadEndTriggerRow[]> {
  const boundedLimit = Math.max(1, Math.min(limit, MAX_DEAD_ENDS_PER_PAGE));
  // Use the same verified, withdrawal-aware public source as the quoted pack
  // objects. A mutable projection or old trigger row cannot restore its body.
  const readable = await loadProblemDeadEnds(db, problemId, {
    limit: MAX_DEAD_ENDS_PER_PAGE,
    through,
  });
  const sourceById = new Map(readable.items.map((item) => [item.dead_end_id, item]));
  if (sourceById.size === 0) return [];
  const rows = await db
    .prepare(
      `SELECT t.dead_end_id, t.trigger_kind, t.reason, e.id AS event_id,
              e.created_at AS fired_at
       FROM dead_end_fired_triggers t
       JOIN dead_ends d ON d.problem_id = t.problem_id AND d.dead_end_id = t.dead_end_id
       JOIN events source ON source.problem_id = d.problem_id AND source.object_id = d.dead_end_id
         AND source.type = 'dead_end.recorded' AND source.object_kind = 'dead_end'
       JOIN event_content content ON content.event_id = source.id
         AND content.payload_sha256 = source.payload_sha256
         AND content.redacted_at IS NULL AND content.payload_json IS NOT NULL
       JOIN events e ON e.problem_id = t.problem_id AND e.id = t.event_id AND e.seq > source.seq
       JOIN problems p ON p.id = t.problem_id
       WHERE t.problem_id = ?
         AND p.status != 'private-draft'
         AND e.seq <= MIN(p.public_seq, COALESCE(?, p.public_seq))
       ORDER BY e.seq ASC, t.dead_end_id ASC
       LIMIT ?`,
    )
    .bind(problemId, through ?? null, MAX_DEAD_ENDS_PER_PAGE)
    .all<FiredDeadEndTrigger>();

  return (rows.results ?? [])
    .flatMap((row) => {
      const source = sourceById.get(row.dead_end_id);
      if (!source || source.retry_when?.kind !== row.trigger_kind) return [];
      return [
        {
          ...row,
          approach: source.approach,
          why_it_fails: source.why_it_fails,
          retry_predicate: source.retry_predicate,
          author_fellow_id: source.author_fellow_id,
        },
      ];
    })
    .slice(0, boundedLimit);
}
