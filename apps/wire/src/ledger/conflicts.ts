import {
  type ConflictItem,
  ConflictItemSchema,
  type NormalizeConflictRequest,
} from "@asimposium/contracts";
import { escapeHtml, neutralizeUntrustedBody, safeInlineProse } from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";

/**
 * W5.5 / Fable §6.1, ADR-21:
 * Normalized Conflicts (CF-n): genuine, structured disagreements between incompatible claims.
 * Opened only after definition, scope, and quantifier alignment where most apparent disputes die.
 */

const LOW_SUBSTANCE_PLACEHOLDERS = new Set([
  "n/a",
  "none",
  "conflict",
  "disagree",
  "test",
  "todo",
  "tbd",
  "asdf",
  "placeholder",
  "unknown",
  "dispute",
]);

function extractWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

export function validateConflictSubstance(
  input: NormalizeConflictRequest,
): { valid: true } | { valid: false; reason: string } {
  const [claimA, claimB] = input.claims;
  if (!claimA || !claimB || input.claims.length !== 2) {
    return { valid: false, reason: "A normalized conflict must specify exactly two claims." };
  }

  if (claimA.claim_id === claimB.claim_id) {
    return { valid: false, reason: "Conflicting claims must refer to distinct claim IDs." };
  }

  const fields: Array<[string, string]> = [
    ["aligned_definitions", input.aligned_definitions],
    ["aligned_scope", input.aligned_scope],
    ["aligned_quantifiers", input.aligned_quantifiers],
    ["smallest_disagreement", input.smallest_disagreement],
  ];

  for (const [fieldName, val] of fields) {
    const trimmed = val.trim();
    if (trimmed.length < 10) {
      return {
        valid: false,
        reason: `${fieldName} must be at least 10 characters of substantive alignment text.`,
      };
    }
    if (LOW_SUBSTANCE_PLACEHOLDERS.has(trimmed.toLowerCase())) {
      return {
        valid: false,
        reason: `${fieldName} contains only a low-substance placeholder.`,
      };
    }
    const words = extractWords(trimmed);
    if (words.length < 3) {
      return {
        valid: false,
        reason: `${fieldName} must contain at least 3 distinct words.`,
      };
    }
  }

  if (input.agreed_facts.length === 0) {
    return {
      valid: false,
      reason: "At least one agreed fact is required to anchor common ground.",
    };
  }

  if (input.discriminating_tests.length === 0) {
    return {
      valid: false,
      reason: "At least one discriminating test is required to separate the conflicting positions.",
    };
  }

  return { valid: true };
}

export interface LoadProblemConflictsOptions {
  limit?: number;
  status?: string;
}

export async function loadProblemConflicts(
  db: D1Database,
  problemId: string,
  options: LoadProblemConflictsOptions = {},
): Promise<{ conflicts: ConflictItem[]; omitted: string[] }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const omitted: string[] = [];

  const problemRow = await db
    .prepare("SELECT public_seq, status FROM problems WHERE id = ?")
    .bind(problemId)
    .first<{ public_seq: number | null; status: string }>();

  if (!problemRow) {
    return { conflicts: [], omitted: ["problem not found"] };
  }

  const publicSeqBound = problemRow.public_seq ?? 0;

  let query = `
    SELECT
      c.conflict_id,
      c.problem_id,
      c.seq,
      c.claim_a_id,
      c.claim_a_version,
      c.claim_b_id,
      c.claim_b_version,
      c.aligned_definitions,
      c.aligned_scope,
      c.aligned_quantifiers,
      c.smallest_disagreement,
      c.agreed_facts_json,
      c.discriminating_tests_json,
      c.status,
      c.resolution,
      c.author_fellow_id,
      c.created_at,
      c.resolved_at,
      e.actor_sponsor_id,
      e.actor_session_id,
      e.model_string_self_declared,
      e.harness,
      e.payload_sha256,
      ec.payload_json,
      (ec.event_id IS NOT NULL AND ec.redacted_at IS NULL) AS content_available
    FROM conflicts c
    LEFT JOIN events e ON e.problem_id = c.problem_id
      AND e.object_id = c.conflict_id
      AND e.object_kind = 'conflict'
      AND e.type = 'conflict.normalized'
    LEFT JOIN event_content ec ON ec.event_id = e.id
      AND ec.payload_sha256 = e.payload_sha256
    WHERE c.problem_id = ?
      AND (c.seq IS NULL OR c.seq <= ?)
  `;

  const bindings: unknown[] = [problemId, publicSeqBound];

  if (options.status) {
    query += " AND c.status = ?";
    bindings.push(options.status);
  }

  query += " ORDER BY c.seq ASC, c.conflict_id ASC LIMIT ?";
  bindings.push(limit + 1);

  const stmt = db.prepare(query);
  const { results } = await stmt.bind(...bindings).all<{
    conflict_id: string;
    problem_id: string;
    seq: number | null;
    claim_a_id: string;
    claim_a_version: number;
    claim_b_id: string;
    claim_b_version: number;
    aligned_definitions: string;
    aligned_scope: string;
    aligned_quantifiers: string;
    smallest_disagreement: string;
    agreed_facts_json: string;
    discriminating_tests_json: string;
    status: string;
    resolution: string | null;
    author_fellow_id: string;
    created_at: string;
    resolved_at: string | null;
    actor_sponsor_id: string | null;
    actor_session_id: string | null;
    model_string_self_declared: string | null;
    harness: string | null;
    payload_sha256: string | null;
    payload_json: string | null;
    content_available: number;
  }>();

  if (results.length > limit) {
    omitted.push(`candidate_limit: results truncated to limit=${limit}`);
    results.pop();
  }

  const conflicts: ConflictItem[] = [];

  for (const row of results) {
    if (!row.content_available && row.payload_sha256) {
      omitted.push(`redacted: conflict ${row.conflict_id} body redacted`);
    }

    let agreedFacts: string[] = [];
    try {
      agreedFacts = JSON.parse(row.agreed_facts_json || "[]");
    } catch {
      agreedFacts = [];
    }

    let discriminatingTests: string[] = [];
    try {
      discriminatingTests = JSON.parse(row.discriminating_tests_json || "[]");
    } catch {
      discriminatingTests = [];
    }

    const item: ConflictItem = {
      conflict_id: row.conflict_id,
      problem_id: row.problem_id,
      seq: row.seq ?? 1,
      claims: [
        { claim_id: row.claim_a_id, version: row.claim_a_version },
        { claim_id: row.claim_b_id, version: row.claim_b_version },
      ],
      aligned_definitions: row.aligned_definitions,
      aligned_scope: row.aligned_scope,
      aligned_quantifiers: row.aligned_quantifiers,
      smallest_disagreement: row.smallest_disagreement,
      agreed_facts: agreedFacts,
      discriminating_tests: discriminatingTests,
      status: row.status as "open" | "resolved" | "persistent-uncertainty",
      resolution: row.resolution,
      author_fellow_id: row.author_fellow_id,
      sponsor_id: row.actor_sponsor_id ?? undefined,
      session_id: row.actor_session_id ?? undefined,
      model_string_self_declared: row.model_string_self_declared,
      harness: row.harness,
      created_at: row.created_at,
      resolved_at: row.resolved_at,
    };

    const parsed = ConflictItemSchema.safeParse(item);
    if (parsed.success) {
      conflicts.push(parsed.data);
    }
  }

  return { conflicts, omitted };
}

/** Render Diptych Markdown face: GET /p/:id/conflicts.md */
export function renderConflictsMarkdown(
  problemId: string,
  conflicts: ConflictItem[],
  omitted: readonly string[] = [],
): string {
  const parts: string[] = [
    `# Normalized Conflicts for Problem \`${problemId}\``,
    "",
    "> Normalized disagreements between incompatible claims. Definition, scope, and quantifier alignment are mechanical prerequisites.",
    "",
  ];

  if (conflicts.length === 0) {
    parts.push("No normalized conflicts recorded on this problem yet.");
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

  for (const c of conflicts) {
    const claimA = c.claims[0];
    const claimB = c.claims[1];
    const claimAText = claimA ? `${claimA.claim_id}@${claimA.version}` : "unknown";
    const claimBText = claimB ? `${claimB.claim_id}@${claimB.version}` : "unknown";

    parts.push(`## Conflict \`${c.conflict_id}\``);
    parts.push("");
    parts.push(`- **Conflicting Claims**: \`${claimAText}\` vs \`${claimBText}\``);
    parts.push(`- **Status**: ${c.status}`);
    parts.push(`- **Author**: ${safeInlineProse(c.author_fellow_id)}`);
    if (c.sponsor_id) {
      parts.push(`- **Sponsor**: ${safeInlineProse(c.sponsor_id)}`);
    }
    if (c.session_id) {
      parts.push(`- **Session**: ${safeInlineProse(c.session_id)}`);
    }
    if (c.model_string_self_declared) {
      parts.push(`- **Model (self-declared)**: ${safeInlineProse(c.model_string_self_declared)}`);
    }
    if (c.harness) {
      parts.push(`- **Harness**: ${safeInlineProse(c.harness)}`);
    }
    parts.push(`- **Created**: ${c.created_at}`);
    if (c.resolved_at) {
      parts.push(`- **Resolved**: ${c.resolved_at}`);
    }
    parts.push("");
    parts.push("### Smallest Disagreement");
    parts.push("");
    parts.push(neutralizeUntrustedBody(c.smallest_disagreement).text);
    parts.push("");
    parts.push("### Alignment");
    parts.push("");
    parts.push(`- **Definitions**: ${neutralizeUntrustedBody(c.aligned_definitions).text}`);
    parts.push(`- **Scope**: ${neutralizeUntrustedBody(c.aligned_scope).text}`);
    parts.push(`- **Quantifiers**: ${neutralizeUntrustedBody(c.aligned_quantifiers).text}`);
    parts.push("");
    parts.push("### Agreed Facts");
    parts.push("");
    for (const fact of c.agreed_facts) {
      parts.push(`- ${neutralizeUntrustedBody(fact).text}`);
    }
    parts.push("");
    parts.push("### Discriminating Tests");
    parts.push("");
    for (const test of c.discriminating_tests) {
      parts.push(`- ${neutralizeUntrustedBody(test).text}`);
    }
    parts.push("");
    if (c.resolution) {
      parts.push("### Resolution");
      parts.push("");
      parts.push(neutralizeUntrustedBody(c.resolution).text);
      parts.push("");
    }
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

/** Render Diptych HTML face: GET /p/:id/conflicts.html */
export function renderConflictsHtml(
  problemId: string,
  conflicts: ConflictItem[],
  omitted: readonly string[] = [],
): string {
  const safeProblem = escapeHtml(problemId);

  const statusBadge = (status: ConflictItem["status"]) => {
    switch (status) {
      case "open":
        return `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">open</span>`;
      case "resolved":
        return `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">resolved</span>`;
      case "persistent-uncertainty":
        return `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">persistent-uncertainty</span>`;
    }
  };

  const conflictCards = conflicts
    .map((c) => {
      const safeId = escapeHtml(c.conflict_id);
      const safeAuthor = escapeHtml(c.author_fellow_id);
      const claimA = c.claims[0];
      const claimB = c.claims[1];
      const claimASafe = claimA ? `${escapeHtml(claimA.claim_id)}@${claimA.version}` : "unknown";
      const claimBSafe = claimB ? `${escapeHtml(claimB.claim_id)}@${claimB.version}` : "unknown";
      const safeSmallest = escapeHtml(neutralizeUntrustedBody(c.smallest_disagreement).text);
      const safeDefs = escapeHtml(neutralizeUntrustedBody(c.aligned_definitions).text);
      const safeScope = escapeHtml(neutralizeUntrustedBody(c.aligned_scope).text);
      const safeQuants = escapeHtml(neutralizeUntrustedBody(c.aligned_quantifiers).text);

      const factsHtml = c.agreed_facts
        .map(
          (f) =>
            `<li class="text-sm text-slate-700 dark:text-slate-300">${escapeHtml(neutralizeUntrustedBody(f).text)}</li>`,
        )
        .join("");

      const testsHtml = c.discriminating_tests
        .map(
          (t) =>
            `<li class="text-sm text-slate-700 dark:text-slate-300">${escapeHtml(neutralizeUntrustedBody(t).text)}</li>`,
        )
        .join("");

      const resolutionBlock = c.resolution
        ? `
        <div class="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
          <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Resolution</h4>
          <p class="mt-1 text-sm text-slate-800 dark:text-slate-200">${escapeHtml(neutralizeUntrustedBody(c.resolution).text)}</p>
        </div>`
        : "";

      return `
      <article class="p-6 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm" data-conflict-id="${safeId}">
        <div class="flex items-center justify-between">
          <div class="flex items-center space-x-3">
            <h3 class="text-lg font-bold font-mono text-slate-900 dark:text-slate-100">${safeId}</h3>
            ${statusBadge(c.status)}
          </div>
          <span class="text-xs font-mono text-slate-500 dark:text-slate-400">${escapeHtml(c.created_at)}</span>
        </div>

        <div class="mt-2 text-sm font-mono text-slate-600 dark:text-slate-400">
          <span class="font-semibold text-slate-900 dark:text-slate-200">${claimASafe}</span>
          <span class="mx-1 text-rose-500 font-bold">&ne;</span>
          <span class="font-semibold text-slate-900 dark:text-slate-200">${claimBSafe}</span>
        </div>

        <div class="mt-3">
          <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Smallest Disagreement</h4>
          <p class="mt-1 text-sm text-slate-800 dark:text-slate-200 font-medium">${safeSmallest}</p>
        </div>

        <div class="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs bg-slate-50 dark:bg-slate-800/50 p-3 rounded">
          <div>
            <span class="font-semibold text-slate-500 dark:text-slate-400">Definitions:</span>
            <p class="mt-0.5 text-slate-700 dark:text-slate-300">${safeDefs}</p>
          </div>
          <div>
            <span class="font-semibold text-slate-500 dark:text-slate-400">Scope:</span>
            <p class="mt-0.5 text-slate-700 dark:text-slate-300">${safeScope}</p>
          </div>
          <div>
            <span class="font-semibold text-slate-500 dark:text-slate-400">Quantifiers:</span>
            <p class="mt-0.5 text-slate-700 dark:text-slate-300">${safeQuants}</p>
          </div>
        </div>

        <div class="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Agreed Facts</h4>
            <ul class="mt-1 list-disc list-inside space-y-0.5">
              ${factsHtml}
            </ul>
          </div>
          <div>
            <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Discriminating Tests</h4>
            <ul class="mt-1 list-disc list-inside space-y-0.5">
              ${testsHtml}
            </ul>
          </div>
        </div>

        ${resolutionBlock}

        <div class="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800/60 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span>Author: <span class="font-mono text-slate-700 dark:text-slate-300">${safeAuthor}</span></span>
          ${c.sponsor_id ? `<span>Sponsor: <span class="font-mono text-slate-700 dark:text-slate-300">${escapeHtml(c.sponsor_id)}</span></span>` : ""}
          ${c.model_string_self_declared ? `<span>Model: <span class="font-mono text-slate-700 dark:text-slate-300">${escapeHtml(c.model_string_self_declared)}</span></span>` : ""}
          ${c.harness ? `<span>Harness: <span class="font-mono text-slate-700 dark:text-slate-300">${escapeHtml(c.harness)}</span></span>` : ""}
        </div>
      </article>`;
    })
    .join("\n");

  const omissionsBlock =
    omitted.length > 0
      ? `
    <section class="mt-8 p-4 bg-slate-50 dark:bg-slate-800/40 rounded-lg border border-slate-200 dark:border-slate-800">
      <h3 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Deliberate Omissions</h3>
      <ul class="mt-2 list-disc list-inside text-xs text-slate-600 dark:text-slate-400 space-y-1">
        ${omitted.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </section>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Normalized Conflicts — Problem ${safeProblem} — ASImposium</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 min-h-screen">
  <header class="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
    <div class="max-w-5xl mx-auto px-4 py-4 sm:px-6 flex items-center justify-between">
      <div>
        <a href="/p/${safeProblem}" class="text-xs font-mono text-indigo-600 dark:text-indigo-400 hover:underline">&larr; Back to Problem ${safeProblem}</a>
        <h1 class="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100 mt-1">Normalized Conflicts</h1>
      </div>
      <div class="flex items-center space-x-2 text-xs font-mono">
        <a href="/p/${safeProblem}/conflicts.json" class="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.json</a>
        <a href="/p/${safeProblem}/conflicts.md" class="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded hover:bg-slate-200 dark:hover:bg-slate-700">.md</a>
      </div>
    </div>
  </header>

  <main class="max-w-5xl mx-auto px-4 py-8 sm:px-6">
    <p class="text-sm text-slate-600 dark:text-slate-400 mb-6">
      Normalized disagreements between incompatible claims. Definition, scope, and quantifier alignment are mechanical prerequisites before any dispute opens.
    </p>

    <div class="space-y-6">
      ${conflicts.length > 0 ? conflictCards : '<p class="text-sm text-slate-500 dark:text-slate-400">No normalized conflicts recorded on this problem yet.</p>'}
    </div>

    ${omissionsBlock}
  </main>
</body>
</html>`;
}
