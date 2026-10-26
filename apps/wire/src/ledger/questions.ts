import {
  AnswerQuestionRequestSchema,
  type AskQuestionRequest,
  AskQuestionRequestSchema,
  LeaseQuestionRequestSchema,
  type QuestionItem,
  QuestionItemSchema,
  WithdrawQuestionRequestSchema,
} from "@asimposium/contracts";
import {
  escapeHtml,
  neutralizeUntrustedBody,
  safeCodeSpan,
  safeInlineProse,
} from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content";
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

const QUESTION_CONTENT_BYTES = 65_536;
const QUESTION_UNAVAILABLE = "Some question content or lifecycle history is unavailable.";
const publicProblemSql = `status <> 'private-draft'
  AND NOT ${hiddenByContentControlSql("problems.id", "'problem'")}`;

/** The projection is allowed to renew a lease without appending scientific
 * history. Every public work product and terminal state comes from the log. */
interface QuestionReadRow {
  question_id: string;
  problem_id: string;
  seq: number;
  creations: number;
  event_id: string;
  actor_fellow_id: string | null;
  actor_sponsor_id: string | null;
  actor_session_id: string | null;
  model_string_self_declared: string | null;
  harness: string | null;
  created_at: string;
  payload_json: string | null;
  payload_sha256: string;
  last_event_id: string;
  last_type: string;
  last_actor_fellow_id: string | null;
  last_payload_json: string | null;
  last_payload_sha256: string;
  lease_holder: string | null;
  lease_deadline: string | null;
}

async function questionPayload(raw: string | null, digest: string) {
  if (raw === null || !/^[a-f0-9]{64}$/.test(digest) || (await sha256Hex(raw)) !== digest)
    return null;
  try {
    const payload: unknown = JSON.parse(raw);
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function loadProblemQuestions(
  db: D1Database,
  problemId: string,
  options: LoadProblemQuestionsOptions = {},
): Promise<{
  questions: QuestionItem[];
  omitted: string[];
  problem: { id: string; unlisted: number } | null;
}> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const omitted: string[] = [];

  const query = `
    WITH scope AS (
      SELECT id, public_seq FROM problems WHERE id = ? AND ${publicProblemSql}
    ), admissions AS (
      SELECT e.object_id, MIN(e.seq) AS first_seq, COUNT(*) AS creations
      FROM events e JOIN scope p ON p.id = e.problem_id
      WHERE e.object_kind = 'question' AND e.type = 'question.asked'
        AND e.seq <= p.public_seq
      GROUP BY e.object_id
    ), page AS (
      SELECT a.* FROM admissions a ORDER BY a.first_seq LIMIT ?
    )
    SELECT
      e.object_id AS question_id,
      e.problem_id,
      e.seq,
      a.creations,
      e.id AS event_id,
      e.actor_fellow_id,
      e.actor_sponsor_id,
      e.actor_session_id,
      e.model_string_self_declared,
      e.harness,
      e.created_at,
      CASE WHEN ec.redacted_at IS NULL AND NOT ${eventContentHiddenSql("e")}
        AND length(CAST(ec.payload_json AS BLOB)) <= ${QUESTION_CONTENT_BYTES}
        THEN ec.payload_json END AS payload_json,
      e.payload_sha256,
      h.id AS last_event_id,
      h.type AS last_type,
      h.actor_fellow_id AS last_actor_fellow_id,
      CASE WHEN hc.redacted_at IS NULL AND NOT ${eventContentHiddenSql("h")}
        AND length(CAST(hc.payload_json AS BLOB)) <= ${QUESTION_CONTENT_BYTES}
        THEN hc.payload_json END AS last_payload_json,
      h.payload_sha256 AS last_payload_sha256,
      q.leased_by AS lease_holder,
      q.leased_until AS lease_deadline
    FROM page a JOIN scope p
    JOIN events e ON e.problem_id = p.id AND e.seq = a.first_seq
    JOIN events h ON h.problem_id = p.id AND h.seq = (
      SELECT MAX(latest.seq) FROM events latest
      WHERE latest.problem_id = p.id AND latest.object_kind = 'question'
        AND latest.object_id = a.object_id AND latest.seq <= p.public_seq
    )
    LEFT JOIN event_content ec ON ec.event_id = e.id
                         AND ec.payload_sha256 = e.payload_sha256
    LEFT JOIN event_content hc ON hc.event_id = h.id
                         AND hc.payload_sha256 = h.payload_sha256
    LEFT JOIN questions q ON q.problem_id = p.id AND q.question_id = a.object_id
    ORDER BY e.seq
  `;
  // D1 batch gives the scope check and content selection one read snapshot.
  // In particular, a problem control is evaluated before any 304 decision.
  const [head, rows] = await db.batch([
    db
      .prepare(`SELECT id, unlisted FROM problems WHERE id = ? AND ${publicProblemSql}`)
      .bind(problemId),
    db.prepare(query).bind(problemId, limit + 1),
  ]);
  if (!head?.success || !rows?.success) throw new Error("Question read failed.");
  const problem = (head.results[0] ?? null) as { id: string; unlisted: number } | null;
  if (problem === null) return { questions: [], omitted: [], problem: null };
  const results = rows.results as unknown as QuestionReadRow[];
  const hasMore = results.length > limit;
  const sliced = hasMore ? results.slice(0, limit) : results;

  if (hasMore) {
    omitted.push(`truncated at limit of ${limit} questions`);
  }

  const questions: QuestionItem[] = [];
  const unavailable = () => {
    if (!omitted.includes(QUESTION_UNAVAILABLE)) omitted.push(QUESTION_UNAVAILABLE);
  };

  for (const row of sliced) {
    const publication = await questionPayload(row.payload_json, row.payload_sha256);
    const latest =
      row.last_event_id === row.event_id
        ? publication
        : await questionPayload(row.last_payload_json, row.last_payload_sha256);
    if (
      row.creations !== 1 ||
      publication?.question_id !== row.question_id ||
      publication.problem_id !== row.problem_id ||
      latest?.question_id !== row.question_id
    ) {
      unavailable();
      continue;
    }
    const source = AskQuestionRequestSchema.safeParse({
      problem_id: publication.problem_id,
      body_md: publication.body_md,
      target_refs: publication.target_refs,
      blocking: publication.blocking,
    });
    if (!source.success) {
      unavailable();
      continue;
    }
    let status: QuestionItem["status"] = "open";
    let leasedBy: string | null = null,
      leasedUntil: string | null = null;
    let resolvedBy: string | null = null;
    if (row.last_type === "question.answered") {
      const answer = AnswerQuestionRequestSchema.safeParse({
        resolved_by_object: latest.resolved_by_object,
      });
      if (!answer.success) {
        unavailable();
        continue;
      }
      status = "resolved";
      resolvedBy = answer.data.resolved_by_object;
    } else if (row.last_type === "question.withdrawn") {
      if (!WithdrawQuestionRequestSchema.safeParse({ reason: latest.reason }).success) {
        unavailable();
        continue;
      }
      status = "withdrawn";
    } else if (row.last_type === "question.leased") {
      if (
        !LeaseQuestionRequestSchema.safeParse({
          objective: latest.objective,
          deliverable: latest.deliverable,
        }).success ||
        typeof latest.leased_by !== "string" ||
        latest.leased_by !== row.last_actor_fellow_id ||
        typeof latest.leased_until !== "string" ||
        !Number.isFinite(Date.parse(latest.leased_until))
      ) {
        unavailable();
        continue;
      }
      // Heartbeat renewal is operational, not scientific publication. It may
      // extend this verified holder's term; it cannot invent another holder.
      const renewed =
        row.lease_holder === latest.leased_by &&
        row.lease_deadline !== null &&
        Number.isFinite(Date.parse(row.lease_deadline)) &&
        Date.parse(row.lease_deadline) >= Date.parse(latest.leased_until);
      leasedUntil = renewed ? row.lease_deadline : latest.leased_until;
      leasedBy = latest.leased_by;
      status = "leased";
    } else if (row.last_type !== "question.asked" || row.last_event_id !== row.event_id) {
      unavailable();
      continue;
    }
    const item = {
      question_id: row.question_id,
      problem_id: row.problem_id,
      seq: row.seq,
      target_refs: source.data.target_refs,
      blocking: source.data.blocking ?? null,
      body_md: source.data.body_md,
      author_fellow_id: row.actor_fellow_id,
      sponsor_id: row.actor_sponsor_id ?? undefined,
      session_id: row.actor_session_id ?? undefined,
      model_string_self_declared: row.model_string_self_declared,
      harness: row.harness,
      status,
      leased_by: leasedBy,
      leased_until: leasedUntil,
      resolved_by_object: resolvedBy,
      created_at: row.created_at,
    };

    const parsed = QuestionItemSchema.safeParse(item);
    if (parsed.success && (options.status === undefined || options.status === parsed.data.status)) {
      questions.push(parsed.data);
    } else if (!parsed.success) unavailable();
  }

  return { questions, omitted, problem };
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
    parts.push(
      omitted.length > 0
        ? "No readable questions are available in this bounded view."
        : "No questions recorded on this problem yet.",
    );
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
    parts.push(
      `  <p class="asimp-empty">${
        omitted.length > 0
          ? "No readable questions are available in this bounded view."
          : "No questions recorded on this problem yet."
      }</p>`,
    );
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
