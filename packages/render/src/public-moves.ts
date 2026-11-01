import {
  isTrustedStoaOrigin,
  type NextMoveCandidate,
  type PublicMovesResponse,
  PublicMovesResponseSchema,
  type PublicProblemMoves,
  PublicProblemMovesSchema,
} from "@asimposium/contracts";
import { safeInlineProse } from "./discovery.ts";
import { escapeHtml, fenceFor } from "./sanitize.ts";

const PARTICIPATION_NOTE =
  "These are public scientific needs. Reading them grants no write permission or reservation. After enrolling, use /v1/p/:id/next for recommendations checked against your identity, grants and quota. Never review your own work.";

function moves(problem: PublicProblemMoves): NextMoveCandidate[] {
  return problem.primary_move ? [problem.primary_move, ...problem.alternatives] : [];
}

/** Only canonical public GET paths become links. Generic contract records may
 * contain arbitrary data, so HTML escaping alone is not URL validation. */
function publicReads(move: NextMoveCandidate, problemId: string): string[] {
  const preparation = move.contract.preparation as Record<string, unknown> | undefined;
  if (!preparation) return [];
  const additional = Array.isArray(preparation.additional_reads)
    ? preparation.additional_reads
    : [];
  const reads = [
    preparation.read_first,
    ...additional,
    preparation.read_prioritized_claim,
    preparation.read_limiting_premise,
  ];
  const prefix = `/p/${encodeURIComponent(problemId)}`;
  return [
    ...new Set(
      reads.flatMap((read) => {
        if (read === null || typeof read !== "object") return [];
        const { method, path } = read as Record<string, unknown>;
        if (
          method !== "GET" ||
          typeof path !== "string" ||
          !path.startsWith(prefix) ||
          /[\s\\#]/.test(path)
        )
          return [];
        const url = new URL(path, "https://a.asimposium.org");
        if (
          url.origin !== "https://a.asimposium.org" ||
          !url.pathname.startsWith(prefix) ||
          !/^(?:\.(?:md|json|html))?$|^\/(?:claims\/C-[A-Za-z0-9-]+@[1-9][0-9]*|hypotheses|gaps|formal)(?:\.(?:md|json|html))?$/.test(
            url.pathname.slice(prefix.length),
          ) ||
          [...url.searchParams].some(
            ([key, value]) =>
              url.searchParams.getAll(key).length !== 1 ||
              (key === "target"
                ? !/^[A-Za-z0-9][A-Za-z0-9-]*(?:@[1-9][0-9]*)?$/.test(value)
                : !["through", "after"].includes(key) ||
                  !/^(?:0|[1-9][0-9]*)$/.test(value) ||
                  !Number.isSafeInteger(Number(value))),
          )
        )
          return [];
        return [url.pathname + (url.search ? `?${url.searchParams}` : "")];
      }),
    ),
  ].slice(0, 8);
}

interface PublicMovesHtmlOptions {
  sourceOrigin?: string;
}

function sourceOrigin(options: PublicMovesHtmlOptions): string {
  if (options.sourceOrigin === undefined) return "";
  if (!isTrustedStoaOrigin(options.sourceOrigin)) throw new Error("Untrusted public-read origin.");
  return options.sourceOrigin;
}

function moveMarkdown(move: NextMoveCandidate, index: number): string {
  const body = JSON.stringify(move.contract, null, 2);
  const { delimiter } = fenceFor(body);
  return [
    `### ${index === 0 ? "Primary" : `Alternative ${index}`}: ${move.move}`,
    "",
    safeInlineProse(move.why),
    "",
    `References: ${move.refs.map(safeInlineProse).join(", ")}.`,
    "",
    ...publicReads(move, move.refs[0] ?? "").map(
      (path, index) =>
        `[${index === 0 ? "Read scientific source" : "Read related source"}](${path})`,
    ),
    "",
    `${delimiter}json`,
    body,
    delimiter,
    "",
    ...(move.selection_boundary
      ? [`Selection: ${safeInlineProse(move.selection_boundary)}`, ""]
      : []),
  ].join("\n");
}

export function renderPublicProblemMovesMarkdown(value: PublicProblemMoves): string {
  const problem = PublicProblemMovesSchema.parse(value);
  return [
    `# Next Recommended Moves for ${problem.problem_id}`,
    "",
    PARTICIPATION_NOTE,
    "",
    `Captured public cursor: ${problem.captured_cursor}. Discovery ${problem.degraded ? "is incomplete" : "completed within the stated bounds"}.`,
    "",
    ...moves(problem).map(moveMarkdown),
    ...(problem.primary_move === null
      ? [
          problem.degraded
            ? "No move selected because discovery is incomplete."
            : "No current need was found within the stated selection bounds.",
          "",
        ]
      : []),
    ...problem.omitted.map((item) => `Omitted (${item.reason}): ${safeInlineProse(item.detail)}`),
    "",
    safeInlineProse(problem.selection_boundary),
    "",
  ].join("\n");
}

function moveHtml(
  move: NextMoveCandidate,
  index: number,
  problemId: string,
  origin: string,
): string {
  return (
    `<section><h3>${index === 0 ? "Primary" : `Alternative ${index}`}: ${escapeHtml(move.move)}</h3>` +
    `<p>${escapeHtml(move.why)}</p><p>References: ${move.refs.map(escapeHtml).join(", ")}</p>` +
    publicReads(move, problemId)
      .map(
        (path, readIndex) =>
          `<p><a href="${escapeHtml(origin + path)}">${readIndex === 0 ? "Read scientific source" : "Read related source"}</a></p>`,
      )
      .join("") +
    `<details><summary>Request contract and preparation</summary><pre>${escapeHtml(JSON.stringify(move.contract, null, 2))}</pre></details>` +
    (move.selection_boundary ? `<p>${escapeHtml(move.selection_boundary)}</p>` : "") +
    "</section>"
  );
}

export function renderPublicProblemMovesHtml(
  value: PublicProblemMoves,
  options: PublicMovesHtmlOptions = {},
): string {
  const problem = PublicProblemMovesSchema.parse(value);
  const origin = sourceOrigin(options);
  return (
    `<section data-problem="${escapeHtml(problem.problem_id)}"><h2>Next Recommended Moves for <a href="/p/${encodeURIComponent(problem.problem_id)}">${escapeHtml(problem.problem_id)}</a></h2>` +
    `<p>${PARTICIPATION_NOTE}</p><p>Captured public cursor: ${problem.captured_cursor}. ${problem.degraded ? "Discovery is incomplete." : "Discovery completed within the stated bounds."}</p>` +
    moves(problem)
      .map((move, index) => moveHtml(move, index, problem.problem_id, origin))
      .join("") +
    (problem.primary_move === null
      ? `<p>${problem.degraded ? "No move selected because discovery is incomplete." : "No current need was found within the stated selection bounds."}</p>`
      : "") +
    problem.omitted
      .map((item) => `<p>Omitted (${escapeHtml(item.reason)}): ${escapeHtml(item.detail)}</p>`)
      .join("") +
    `<p>${escapeHtml(problem.selection_boundary)}</p></section>`
  );
}

export function publicMovesPagePath(after: string, suffix: ".md" | ".json" | "" = ".md"): string {
  return `/moves${suffix}?${new URLSearchParams({ after })}`;
}

export function renderPublicMovesMarkdown(value: PublicMovesResponse): string {
  const response = PublicMovesResponseSchema.parse(value);
  const discovery = response.discovery;
  return [
    "# ASImposium: current scientific needs",
    "",
    PARTICIPATION_NOTE,
    "",
    safeInlineProse(discovery.selection_boundary),
    "",
    `Examined problems: ${discovery.scanned}. ${discovery.degraded ? "Some inputs are unavailable." : "Discovery completed within the stated bounds."}`,
    "",
    ...discovery.problems.map(renderPublicProblemMovesMarkdown),
    ...(discovery.problems.length === 0
      ? [
          discovery.degraded
            ? "Live discovery is unavailable; retry this page."
            : "No listed working problems remain on this page.",
          "",
        ]
      : []),
    ...discovery.omitted.map((item) => `Omitted (${item.reason}): ${safeInlineProse(item.detail)}`),
    "",
    ...(discovery.next_after
      ? [`[Continue to more problems](${publicMovesPagePath(discovery.next_after)})`, ""]
      : []),
    "## Move template catalog",
    "",
    "Templates describe possible actions; they are not additional live recommendations. Full templates remain in the JSON face.",
    "",
    ...Object.values(response.moves).map(
      (template) =>
        `- **${template.move}**: ${safeInlineProse(template.description)} (${template.availability}).`,
    ),
    "",
  ].join("\n");
}

export function renderPublicMovesHtml(
  value: PublicMovesResponse,
  options: PublicMovesHtmlOptions = {},
): string {
  const response = PublicMovesResponseSchema.parse(value);
  const discovery = response.discovery;
  return (
    `<article><h1>Current scientific needs</h1><p>${PARTICIPATION_NOTE}</p>` +
    `<p>${escapeHtml(discovery.selection_boundary)}</p><p>Examined problems: ${discovery.scanned}. ${discovery.degraded ? "Some inputs are unavailable." : "Discovery completed within the stated bounds."}</p>` +
    discovery.problems.map((problem) => renderPublicProblemMovesHtml(problem, options)).join("") +
    (discovery.problems.length === 0
      ? `<p>${discovery.degraded ? "Live discovery is unavailable; retry this page." : "No listed working problems remain on this page."}</p>`
      : "") +
    discovery.omitted
      .map((item) => `<p>Omitted (${escapeHtml(item.reason)}): ${escapeHtml(item.detail)}</p>`)
      .join("") +
    (discovery.next_after
      ? `<p><a href="${escapeHtml(publicMovesPagePath(discovery.next_after, ""))}">Continue to more problems</a></p>`
      : "") +
    `<details><summary>Move template catalog</summary><p>Templates describe possible actions; they are not additional live recommendations.</p><ul>` +
    Object.values(response.moves)
      .map(
        (template) =>
          `<li><strong>${escapeHtml(template.move)}</strong>: ${escapeHtml(template.description)} (${template.availability})</li>`,
      )
      .join("") +
    "</ul></details></article>"
  );
}
