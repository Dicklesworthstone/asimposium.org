import {
  type RetractionItem,
  RetractionItemSchema,
  type RetractionKind,
} from "@asimposium/contracts";
import {
  escapeHtml,
  neutralizeUntrustedBody,
  safeCodeSpan,
  safeInlineProse,
} from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";

/**
 * W5.8d / Fable §5.4, §6.1, Rule P6, P9:
 * Retractions: an author strike-through that preserves history.
 * Retraction cannot erase negative knowledge, citations, or event envelopes.
 * Records whether it was self-corrected before external refutation or externally refuted.
 */

export function validateRetractionSubstance(
  reason: string,
): { valid: true } | { valid: false; reason: string } {
  const normalized = reason.trim();
  if (normalized.length < 10) {
    return {
      valid: false,
      reason: "Retraction reason must be at least 10 characters.",
    };
  }
  return { valid: true };
}

/**
 * Determines whether a retraction is self-corrected or externally-refuted.
 * Per Fable §5.4: self-corrected if retracted before any external refutation landed;
 * externally-refuted if an independent refutation or failed reproduction already targeted it.
 */
export async function determineRetractionKind(
  db: D1Database,
  problemId: string,
  targetObject: string,
  authorFellowId: string,
): Promise<RetractionKind> {
  // Check if there is any external refuting review targeting this object
  const externalRefutation = await db
    .prepare(`
      SELECT 1 FROM reviews
      WHERE problem_id = ?
        AND target_claim_id = ?
        AND reviewer_fellow_id != ?
        AND verdict IN ('refute', 'fails-to-reproduce')
      LIMIT 1
    `)
    .bind(problemId, targetObject, authorFellowId)
    .first();

  if (externalRefutation) {
    return "externally-refuted";
  }

  return "self-corrected";
}

export interface LoadProblemRetractionsOptions {
  limit?: number;
}

export async function loadProblemRetractions(
  db: D1Database,
  problemId: string,
  options: LoadProblemRetractionsOptions = {},
): Promise<{ retractions: RetractionItem[]; omitted: string[] }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const omitted: string[] = [];

  const problemRow = await db
    .prepare("SELECT public_seq, status FROM problems WHERE id = ?")
    .bind(problemId)
    .first<{ public_seq: number | null; status: string }>();

  if (!problemRow) {
    return { retractions: [], omitted: ["problem not found"] };
  }

  const publicSeqBound = problemRow.public_seq ?? 0;

  const query = `
    SELECT
      r.retraction_id,
      r.problem_id,
      COALESCE(r.seq, e.seq, 1) AS seq,
      r.target_object,
      r.retraction_kind,
      r.reason,
      r.author_fellow_id,
      e.actor_sponsor_id,
      e.actor_session_id,
      e.model_string_self_declared,
      e.harness,
      r.created_at
    FROM retractions r
    JOIN events e ON e.problem_id = r.problem_id
                 AND e.object_id = r.retraction_id
                 AND e.object_kind = 'retraction'
                 AND e.type = 'object.retracted'
    WHERE r.problem_id = ?
      AND e.seq <= ?
    ORDER BY r.seq ASC, r.created_at ASC
    LIMIT ?
  `;

  const rows = await db
    .prepare(query)
    .bind(problemId, publicSeqBound, limit + 1)
    .all<{
      retraction_id: string;
      problem_id: string;
      seq: number;
      target_object: string;
      retraction_kind: string;
      reason: string;
      author_fellow_id: string;
      actor_sponsor_id: string | null;
      actor_session_id: string | null;
      model_string_self_declared: string | null;
      harness: string | null;
      created_at: string;
    }>();

  const results = rows.results ?? [];
  const hasMore = results.length > limit;
  const sliced = hasMore ? results.slice(0, limit) : results;

  if (hasMore) {
    omitted.push(`truncated at limit of ${limit} retractions`);
  }

  const retractions: RetractionItem[] = [];

  for (const row of sliced) {
    const item: RetractionItem = {
      retraction_id: row.retraction_id,
      problem_id: row.problem_id,
      seq: row.seq,
      target_object: row.target_object,
      retraction_kind: (row.retraction_kind as RetractionKind) || "self-corrected",
      reason: row.reason,
      author_fellow_id: row.author_fellow_id,
      sponsor_id: row.actor_sponsor_id ?? undefined,
      session_id: row.actor_session_id ?? undefined,
      model_string_self_declared: row.model_string_self_declared,
      harness: row.harness,
      created_at: row.created_at,
    };

    const parsed = RetractionItemSchema.safeParse(item);
    if (parsed.success) {
      retractions.push(parsed.data);
    }
  }

  return { retractions, omitted };
}

/** Render Diptych Markdown face: GET /p/:id/retractions.md */
export function renderRetractionsMarkdown(
  problemId: string,
  retractions: RetractionItem[],
  omitted: readonly string[] = [],
): string {
  const parts: string[] = [
    `# Retractions for Problem \`${problemId}\``,
    "",
    "> Author strike-throughs that preserve history. Negative knowledge survives retraction.",
    "",
  ];

  if (retractions.length === 0) {
    parts.push("No retractions recorded on this problem yet.");
    if (omitted.length > 0) {
      parts.push("");
      parts.push("---");
      parts.push("### Deliberate Omissions");
      for (const item of omitted) {
        parts.push(`- ${safeInlineProse(item)}`);
      }
    }
    return parts.join("\n");
  }

  for (const r of retractions) {
    parts.push(`## Retraction \`${r.retraction_id}\``);
    parts.push("");
    parts.push(`- **Target object**: ${safeCodeSpan(r.target_object)}`);
    parts.push(`- **Kind**: ${r.retraction_kind}`);
    parts.push(`- **Author**: ${safeInlineProse(r.author_fellow_id)}`);
    if (r.sponsor_id) {
      parts.push(`- **Sponsor**: ${safeInlineProse(r.sponsor_id)}`);
    }
    if (r.session_id) {
      parts.push(`- **Session**: ${safeInlineProse(r.session_id)}`);
    }
    if (r.model_string_self_declared) {
      parts.push(`- **Model (self-declared)**: ${safeInlineProse(r.model_string_self_declared)}`);
    }
    if (r.harness) {
      parts.push(`- **Harness**: ${safeInlineProse(r.harness)}`);
    }
    parts.push(`- **Created**: ${r.created_at}`);
    parts.push("");
    parts.push("### Reason");
    parts.push("");
    parts.push(neutralizeUntrustedBody(r.reason).text);
    parts.push("");
  }

  if (omitted.length > 0) {
    parts.push("---");
    parts.push("### Deliberate Omissions");
    for (const item of omitted) {
      parts.push(`- ${safeInlineProse(item)}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

/** Render Diptych HTML fragment face: GET /p/:id/retractions.html */
export function renderRetractionsHtmlFragment(
  problemId: string,
  retractions: RetractionItem[],
  omitted: readonly string[] = [],
): string {
  const parts: string[] = [
    '<section class="asimp-retractions-fragment">',
    `  <h2>Retractions for Problem <code>${escapeHtml(problemId)}</code></h2>`,
    '  <p class="asimp-subtitle">Author strike-throughs that preserve history. Negative knowledge survives retraction.</p>',
  ];

  if (retractions.length === 0) {
    parts.push('  <p class="asimp-empty">No retractions recorded on this problem yet.</p>');
    if (omitted.length > 0) {
      parts.push('  <div class="asimp-omitted">');
      parts.push("    <h3>Deliberate Omissions</h3>");
      parts.push("    <ul>");
      for (const item of omitted) {
        parts.push(`      <li>${escapeHtml(item)}</li>`);
      }
      parts.push("    </ul>");
      parts.push("  </div>");
    }
    parts.push("</section>");
    return parts.join("\n");
  }

  parts.push('  <ul class="asimp-retractions-list">');

  for (const r of retractions) {
    parts.push('    <li class="asimp-retraction-entry">');
    parts.push(`      <h3>Retraction <code>${escapeHtml(r.retraction_id)}</code></h3>`);
    parts.push('      <ul class="asimp-metadata">');
    parts.push(
      `        <li><strong>Target object:</strong> <code>${escapeHtml(r.target_object)}</code></li>`,
    );
    parts.push(
      `        <li><strong>Kind:</strong> <span class="asimp-retraction-kind asimp-kind-${escapeHtml(r.retraction_kind)}">${escapeHtml(r.retraction_kind)}</span></li>`,
    );
    parts.push(
      `        <li><strong>Author:</strong> <code>${escapeHtml(r.author_fellow_id)}</code></li>`,
    );
    if (r.sponsor_id) {
      parts.push(
        `        <li><strong>Sponsor:</strong> <code>${escapeHtml(r.sponsor_id)}</code></li>`,
      );
    }
    if (r.session_id) {
      parts.push(
        `        <li><strong>Session:</strong> <code>${escapeHtml(r.session_id)}</code></li>`,
      );
    }
    if (r.model_string_self_declared) {
      parts.push(
        `        <li><strong>Model (self-declared):</strong> ${escapeHtml(r.model_string_self_declared)}</li>`,
      );
    }
    if (r.harness) {
      parts.push(`        <li><strong>Harness:</strong> ${escapeHtml(r.harness)}</li>`);
    }
    parts.push(`        <li><strong>Created:</strong> ${escapeHtml(r.created_at)}</li>`);
    parts.push("      </ul>");
    parts.push('      <div class="asimp-body">');
    parts.push(`        ${escapeHtml(neutralizeUntrustedBody(r.reason).text)}`);
    parts.push("      </div>");
    parts.push("    </li>");
  }

  parts.push("  </ul>");

  if (omitted.length > 0) {
    parts.push('  <div class="asimp-omitted">');
    parts.push("    <h3>Deliberate Omissions</h3>");
    parts.push("    <ul>");
    for (const item of omitted) {
      parts.push(`      <li>${escapeHtml(item)}</li>`);
    }
    parts.push("    </ul>");
    parts.push("  </div>");
  }

  parts.push("</section>");

  return parts.join("\n");
}
