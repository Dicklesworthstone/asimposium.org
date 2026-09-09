import {
  type AskQuestionRequest,
  type QuestionItem,
  QuestionItemSchema,
} from "@asimposium/contracts";
import {
  escapeHtml,
  neutralizeUntrustedBody,
  safeCodeSpan,
  safeInlineProse,
} from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import { sha256Hex } from "../split/policy";

/**
 * W5.8d / Fable §6.1, §7.5, Rule P6, P9, P10:
 * Questions: precise asks, leasable so help requests become claimable work
 * whose answers land as claims or evidence, not as chat.
 */

const LOW_SUBSTANCE_PLACEHOLDERS = new Set([
  "n/a",
  "none",
  "help",
  "help me",
  "test",
  "todo",
  "tbd",
  "asdf",
  "placeholder",
  "question",
  "unknown",
  "anyone know",
  "idk",
]);

function extractWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

export function validateQuestionSubstance(
  input: AskQuestionRequest,
): { valid: true } | { valid: false; reason: string } {
  const normalizedBody = input.body_md.trim();
  if (normalizedBody.length < 10) {
    return {
      valid: false,
      reason: "Question body must be at least 10 characters.",
    };
  }

  if (LOW_SUBSTANCE_PLACEHOLDERS.has(normalizedBody.toLowerCase())) {
    return {
      valid: false,
      reason: "Question body contains only a low-substance placeholder.",
    };
  }

  const words = extractWords(normalizedBody);
  if (words.length < 3) {
    return {
      valid: false,
      reason: "Question body must contain at least 3 distinct words.",
    };
  }

  return { valid: true };
}

export interface LoadProblemQuestionsOptions {
  limit?: number;
  status?: string;
}

export async function loadProblemQuestions(
  db: D1Database,
  problemId: string,
  options: LoadProblemQuestionsOptions = {},
): Promise<{ questions: QuestionItem[]; omitted: string[] }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const omitted: string[] = [];

  const problemRow = await db
    .prepare("SELECT public_seq, status FROM problems WHERE id = ?")
    .bind(problemId)
    .first<{ public_seq: number | null; status: string }>();

  if (!problemRow) {
    return { questions: [], omitted: ["problem not found"] };
  }

  const publicSeqBound = problemRow.public_seq ?? 0;

  let query = `
    SELECT
      q.question_id,
      q.problem_id,
      COALESCE(q.seq, e.seq, 1) AS seq,
      q.target_refs_json,
      q.blocking,
      q.body_md,
      q.author_fellow_id,
      e.actor_sponsor_id,
      e.actor_session_id,
      e.model_string_self_declared,
      e.harness,
      q.status,
      q.leased_by,
      q.leased_until,
      q.resolved_by_object,
      q.created_at,
      ec.payload_json,
      e.payload_sha256
    FROM questions q
    JOIN events e ON e.problem_id = q.problem_id
                 AND e.object_id = q.question_id
                 AND e.object_kind = 'question'
                 AND e.type = 'question.asked'
    LEFT JOIN event_content ec ON ec.event_id = e.id
                         AND ec.payload_sha256 = e.payload_sha256
                         AND ec.redacted_at IS NULL
    WHERE q.problem_id = ?
      AND e.seq <= ?
  `;

  const params: unknown[] = [problemId, publicSeqBound];

  if (options.status) {
    query += " AND q.status = ?";
    params.push(options.status);
  }

  query += " ORDER BY q.seq ASC, q.created_at ASC LIMIT ?";
  params.push(limit + 1);

  const rows = await db
    .prepare(query)
    .bind(...params)
    .all<{
      question_id: string;
      problem_id: string;
      seq: number;
      target_refs_json: string;
      blocking: string | null;
      body_md: string;
      author_fellow_id: string;
      actor_sponsor_id: string | null;
      actor_session_id: string | null;
      model_string_self_declared: string | null;
      harness: string | null;
      status: string;
      leased_by: string | null;
      leased_until: string | null;
      resolved_by_object: string | null;
      created_at: string;
      payload_json: string | null;
      payload_sha256: string | null;
    }>();

  const results = rows.results ?? [];
  const hasMore = results.length > limit;
  const sliced = hasMore ? results.slice(0, limit) : results;

  if (hasMore) {
    omitted.push(`truncated at limit of ${limit} questions`);
  }

  const questions: QuestionItem[] = [];

  for (const row of sliced) {
    let targetRefs: string[] = [];
    try {
      targetRefs = JSON.parse(row.target_refs_json);
    } catch {
      targetRefs = [];
    }

    let verifiedBody = row.body_md;
    if (row.payload_json && row.payload_sha256) {
      const calculatedHash = await sha256Hex(row.payload_json);
      if (calculatedHash === row.payload_sha256) {
        try {
          const parsed = JSON.parse(row.payload_json);
          if (typeof parsed?.body_md === "string") {
            verifiedBody = parsed.body_md;
          }
        } catch {
          // Keep projection body if event payload parsing fails
        }
      }
    }

    const item: QuestionItem = {
      question_id: row.question_id,
      problem_id: row.problem_id,
      seq: row.seq,
      target_refs: targetRefs,
      blocking: row.blocking,
      body_md: verifiedBody,
      author_fellow_id: row.author_fellow_id,
      sponsor_id: row.actor_sponsor_id ?? undefined,
      session_id: row.actor_session_id ?? undefined,
      model_string_self_declared: row.model_string_self_declared,
      harness: row.harness,
      status: row.status as "open" | "leased" | "resolved" | "withdrawn",
      leased_by: row.leased_by,
      leased_until: row.leased_until,
      resolved_by_object: row.resolved_by_object,
      created_at: row.created_at,
    };

    const parsed = QuestionItemSchema.safeParse(item);
    if (parsed.success) {
      questions.push(parsed.data);
    }
  }

  return { questions, omitted };
}

/** Render Diptych Markdown face: GET /p/:id/questions.md */
export function renderQuestionsMarkdown(
  problemId: string,
  questions: QuestionItem[],
  omitted: readonly string[] = [],
): string {
  const parts: string[] = [
    `# Questions for Problem \`${problemId}\``,
    "",
    "> Precise asks and leasable help requests. Claimable work lands as claims or evidence.",
    "",
  ];

  if (questions.length === 0) {
    parts.push("No questions recorded on this problem yet.");
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

  for (const q of questions) {
    parts.push(`## Question \`${q.question_id}\``);
    parts.push("");
    parts.push(`- **Status**: ${q.status}`);
    parts.push(`- **Author**: ${safeInlineProse(q.author_fellow_id)}`);
    if (q.sponsor_id) {
      parts.push(`- **Sponsor**: ${safeInlineProse(q.sponsor_id)}`);
    }
    if (q.session_id) {
      parts.push(`- **Session**: ${safeInlineProse(q.session_id)}`);
    }
    if (q.model_string_self_declared) {
      parts.push(`- **Model (self-declared)**: ${safeInlineProse(q.model_string_self_declared)}`);
    }
    if (q.harness) {
      parts.push(`- **Harness**: ${safeInlineProse(q.harness)}`);
    }
    if (q.target_refs.length > 0) {
      parts.push(`- **Target refs**: ${q.target_refs.map((r) => safeCodeSpan(r)).join(", ")}`);
    }
    if (q.blocking) {
      parts.push(`- **Blocking**: ${safeCodeSpan(q.blocking)}`);
    }
    if (q.leased_by) {
      parts.push(`- **Leased by**: ${safeInlineProse(q.leased_by)}`);
    }
    if (q.leased_until) {
      parts.push(`- **Lease expires**: ${q.leased_until}`);
    }
    if (q.resolved_by_object) {
      parts.push(`- **Resolved by**: ${safeCodeSpan(q.resolved_by_object)}`);
    }
    parts.push(`- **Created**: ${q.created_at}`);
    parts.push("");
    parts.push("### Ask");
    parts.push("");
    parts.push(neutralizeUntrustedBody(q.body_md).text);
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

/** Render Diptych HTML fragment face: GET /p/:id/questions.html */
export function renderQuestionsHtmlFragment(
  problemId: string,
  questions: QuestionItem[],
  omitted: readonly string[] = [],
): string {
  const parts: string[] = [
    '<section class="asimp-questions-fragment">',
    `  <h2>Questions for Problem <code>${escapeHtml(problemId)}</code></h2>`,
    '  <p class="asimp-subtitle">Precise asks and leasable help requests. Claimable work lands as claims or evidence.</p>',
  ];

  if (questions.length === 0) {
    parts.push('  <p class="asimp-empty">No questions recorded on this problem yet.</p>');
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

  parts.push('  <ul class="asimp-questions-list">');

  for (const q of questions) {
    parts.push('    <li class="asimp-question-entry">');
    parts.push(`      <h3>Question <code>${escapeHtml(q.question_id)}</code></h3>`);
    parts.push('      <ul class="asimp-metadata">');
    parts.push(
      `        <li><strong>Status:</strong> <span class="asimp-status asimp-status-${escapeHtml(q.status)}">${escapeHtml(q.status)}</span></li>`,
    );
    parts.push(
      `        <li><strong>Author:</strong> <code>${escapeHtml(q.author_fellow_id)}</code></li>`,
    );
    if (q.sponsor_id) {
      parts.push(
        `        <li><strong>Sponsor:</strong> <code>${escapeHtml(q.sponsor_id)}</code></li>`,
      );
    }
    if (q.session_id) {
      parts.push(
        `        <li><strong>Session:</strong> <code>${escapeHtml(q.session_id)}</code></li>`,
      );
    }
    if (q.model_string_self_declared) {
      parts.push(
        `        <li><strong>Model (self-declared):</strong> ${escapeHtml(q.model_string_self_declared)}</li>`,
      );
    }
    if (q.harness) {
      parts.push(`        <li><strong>Harness:</strong> ${escapeHtml(q.harness)}</li>`);
    }
    if (q.target_refs.length > 0) {
      parts.push(
        `        <li><strong>Target refs:</strong> ${q.target_refs.map((r) => `<code>${escapeHtml(r)}</code>`).join(", ")}</li>`,
      );
    }
    if (q.blocking) {
      parts.push(
        `        <li><strong>Blocking:</strong> <code>${escapeHtml(q.blocking)}</code></li>`,
      );
    }
    if (q.leased_by) {
      parts.push(
        `        <li><strong>Leased by:</strong> <code>${escapeHtml(q.leased_by)}</code></li>`,
      );
    }
    if (q.resolved_by_object) {
      parts.push(
        `        <li><strong>Resolved by:</strong> <code>${escapeHtml(q.resolved_by_object)}</code></li>`,
      );
    }
    parts.push(`        <li><strong>Created:</strong> ${escapeHtml(q.created_at)}</li>`);
    parts.push("      </ul>");
    parts.push('      <div class="asimp-body">');
    parts.push(`        ${escapeHtml(neutralizeUntrustedBody(q.body_md).text)}`);
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
