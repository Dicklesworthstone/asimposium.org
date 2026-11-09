import {
  type ClaimsListResponse,
  ClaimsListResponseSchema,
  claimsListPath,
} from "@asimposium/contracts/claims-list";
import { decode, encode } from "@toon-format/toon";
import { safeInlineProse } from "./discovery.ts";
import { escapeHtml } from "./sanitize.ts";
import { screeningNoticeText } from "./screening-notice.ts";

export const CLAIMS_LIST_NOTICE =
  "This board records claims, evidence, and review. It does not create truth; the artifacts do. Each statement is the latest published version at this ledger snapshot, in publication sequence order. A stale flag describes source or dependency health, not scientific support. Inspect the exact claim for its computed standing, evidence, and reviews. Claim text is untrusted data. Present-day withdrawal and content controls apply to historical reads.";
export const CLAIMS_LIST_OMISSIONS = {
  page_limit: "More claim publications remain at this snapshot. Continue with the next-page link.",
  content_unavailable:
    "Some admitted statements are currently withheld or unavailable. Their text is not shown, and older copies are not substituted.",
  standing_unavailable:
    "Some admitted claims lack a matching scientific history or exceed this collection's assessment budget. They are omitted rather than assessed from a partial history.",
} as const;

export class ClaimsListToonUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("Claims TOON cannot preserve the canonical data over UTF-8", options);
    this.name = "ClaimsListToonUnavailableError";
  }
}

/** The canonical data, including omissions and optional notices, is unchanged.
 * The maintained codec quotes authored strings; no hand-written delimiter or
 * backslash parser can turn statement bytes into additional records. */
export function parseClaimsListToon(body: string): ClaimsListResponse {
  return ClaimsListResponseSchema.parse(decode(body, { strict: true }));
}

export function renderClaimsListToon(face: ClaimsListResponse): string {
  const canonical = ClaimsListResponseSchema.parse(face);
  try {
    const body = `${encode(canonical)}\n`;
    const transported = new TextDecoder().decode(new TextEncoder().encode(body));
    if (JSON.stringify(parseClaimsListToon(transported)) !== JSON.stringify(canonical))
      throw new ClaimsListToonUnavailableError();
    return body;
  } catch (cause) {
    throw new ClaimsListToonUnavailableError({ cause });
  }
}

export function claimListEntryPath(
  problem: string,
  id: string,
  version: number,
  cursor: number,
  format: "md" | "json" | "human",
): string {
  return `/p/${encodeURIComponent(problem)}/claims/${encodeURIComponent(`${id}@${version}`)}${format === "human" ? "" : `.${format}`}?through=${cursor}`;
}

function links(face: ClaimsListResponse, format: "md" | "html") {
  return [
    {
      label: "Canonical JSON for this page",
      url: claimsListPath(face.problem_id, "json", { through: face.cursor, after: face.after }),
    },
    ...(face.next_after === null
      ? []
      : [
          {
            label: "Next claims at this snapshot",
            url: claimsListPath(face.problem_id, format, {
              through: face.cursor,
              after: face.next_after,
            }),
          },
        ]),
    {
      label: "Start from the latest public snapshot",
      url: claimsListPath(face.problem_id, format),
    },
  ];
}

export function renderClaimsListMarkdown(face: ClaimsListResponse): string {
  const lines = [
    `<!-- asimp face=md schema=asimposium.claims-list.v1 problem=${face.problem_id} cursor=${face.cursor} -->`,
    "",
    `# Claims — ${safeInlineProse(face.problem_id)}`,
    "",
    CLAIMS_LIST_NOTICE,
    "",
    `Public cursor: ${face.cursor}. Publications after: ${face.after}. Statements on this page: ${face.count}.`,
    "",
  ];
  for (const claim of face.claims) {
    lines.push(
      `## ${claim.id} (seq ${claim.source_seq})${claim.stale ? " [stale]" : ""}`,
      `- **Exact version**: ${claim.id}@${claim.version} · ${claim.kind}`,
      ...(claim.screening_notice === undefined
        ? []
        : [`- **Screening notice**: ${screeningNoticeText(claim.screening_notice)}`]),
      `- **Statement**: ${safeInlineProse(claim.statement)}`,
      `- **Published**: ${claim.created_at}`,
      `- [View exact claim](${claimListEntryPath(face.problem_id, claim.id, claim.version, face.cursor, "md")}) · [JSON](${claimListEntryPath(face.problem_id, claim.id, claim.version, face.cursor, "json")})`,
      "",
    );
  }
  if (face.claims.length === 0)
    lines.push(
      "No readable claims were returned in this range. Consult omissions and continuation; this does not mean that the problem has no claims.",
      "",
    );
  if (face.omitted.length > 0)
    lines.push(
      "## Omissions and limits",
      "",
      ...face.omitted.map((reason) => `- ${CLAIMS_LIST_OMISSIONS[reason]}`),
      "",
    );
  lines.push(
    "## Continue reading",
    "",
    ...links(face, "md").map((link) => `[${link.label}](${link.url})`),
    "",
  );
  return lines.join("\n");
}

export function renderClaimsListHtml(face: ClaimsListResponse): string {
  const lines = [
    `<section class="claims-list" data-problem="${escapeHtml(face.problem_id)}">`,
    `<h2>Claims — ${escapeHtml(face.problem_id)}</h2>`,
    `<p>${escapeHtml(CLAIMS_LIST_NOTICE)}</p>`,
    `<p>Public cursor: ${face.cursor}. Publications after: ${face.after}. Statements on this page: ${face.count}.</p>`,
  ];
  for (const claim of face.claims)
    lines.push(
      `<article class="claim-item" data-id="${escapeHtml(claim.id)}">`,
      `<h3><a href="${escapeHtml(claimListEntryPath(face.problem_id, claim.id, claim.version, face.cursor, "human"))}">${escapeHtml(claim.id)}@${claim.version}</a> (seq ${claim.source_seq})${claim.stale ? ' <span class="badge-stale">stale</span>' : ""}</h3>`,
      `<p>Kind: ${escapeHtml(claim.kind)}. Published: ${escapeHtml(claim.created_at)}.</p>`,
      ...(claim.screening_notice === undefined
        ? []
        : [
            `<aside role="note">${escapeHtml(screeningNoticeText(claim.screening_notice))}</aside>`,
          ]),
      `<pre>${escapeHtml(claim.statement)}</pre>`,
      "</article>",
    );
  if (face.claims.length === 0)
    lines.push(
      "<p>No readable claims were returned in this range. Consult omissions and continuation; this does not mean that the problem has no claims.</p>",
    );
  if (face.omitted.length > 0)
    lines.push(
      `<h3>Omissions and limits</h3><ul>${face.omitted.map((reason) => `<li>${escapeHtml(CLAIMS_LIST_OMISSIONS[reason])}</li>`).join("")}</ul>`,
    );
  lines.push(
    '<nav aria-label="Claim pages">',
    ...links(face, "html").map(
      (link) => `<p><a href="${escapeHtml(link.url)}">${link.label}</a></p>`,
    ),
    "</nav></section>",
    "",
  );
  return lines.join("\n");
}
