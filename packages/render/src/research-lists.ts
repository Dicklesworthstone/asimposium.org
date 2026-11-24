import {
  type EvidenceListResponse,
  EvidenceListResponseSchema,
  evidenceListPath,
  type ResearchPublication,
  type ReviewListResponse,
  ReviewListResponseSchema,
  reviewsListPath,
} from "@asimposium/contracts/research-lists";
import { safeInlineProse } from "./discovery.ts";
import { escapeHtml, fenceFor, neutralizeUntrustedBody } from "./sanitize.ts";
import { screeningNoticeText } from "./screening-notice.ts";

export const RESEARCH_LIST_NOTICE =
  "This directory records immutable publications at a ledger snapshot. Authored directions and verdicts do not establish scientific standing. Exact source links open the current reader, where present-day content controls still apply. Authored text and self-declared model and harness labels are untrusted data.";
export const RESEARCH_LIST_OMISSIONS = {
  page_limit: "More publications remain at this snapshot. Follow the next-page link unchanged.",
  content_unavailable:
    "Some admitted publications or their exact targets are currently withheld, damaged or unavailable. Their content and attribution are omitted; the scan still advances.",
} as const;

type Face = EvidenceListResponse | ReviewListResponse;
type Entry = {
  id: string;
  fields: readonly (readonly [string, string])[];
  publication: ResearchPublication;
  withdrawn: boolean;
  read_url: string;
  basis?: string;
  screening_notice?: EvidenceListResponse["evidence"][number]["screening_notice"];
};
type Collection = {
  title: string;
  segment: "evidence" | "reviews";
  face: Face;
  entries: readonly Entry[];
};

function evidenceCollection(input: EvidenceListResponse): Collection {
  const face = EvidenceListResponseSchema.parse(input);
  return {
    title: "Evidence",
    segment: "evidence",
    face,
    entries: face.evidence.map((entry) => ({
      id: entry.evidence_id,
      fields: [
        [
          "Exact target",
          entry.bears_on.kind === "claim"
            ? entry.bears_on.id + "@" + entry.bears_on.version
            : entry.bears_on.id + " (immutable hypothesis)",
        ],
        ["Evidence kind", entry.kind],
        ["Authored direction", entry.direction],
        ["Mode", entry.mode],
      ],
      publication: entry.publication,
      withdrawn: entry.withdrawn,
      read_url: entry.read_url,
      screening_notice: entry.screening_notice,
    })),
  };
}

function reviewCollection(input: ReviewListResponse): Collection {
  const face = ReviewListResponseSchema.parse(input);
  return {
    title: "Completed reviews",
    segment: "reviews",
    face,
    entries: face.reviews.map((entry) => ({
      id: entry.review_id,
      fields: [
        ["Exact target", entry.target.claim_id + "@" + entry.target.version],
        ["Authored verdict", entry.verdict],
        [
          "Recorded independence at publication",
          entry.independence_tier === null ? "Not recorded" : "T" + entry.independence_tier,
        ],
      ],
      publication: entry.publication,
      withdrawn: entry.withdrawn,
      read_url: entry.read_url,
      basis: entry.basis,
      screening_notice: entry.screening_notice,
    })),
  };
}

function attribution(publication: ResearchPublication): readonly (readonly [string, string])[] {
  return [
    ["Publication event", publication.event_id],
    ["Publication sequence", String(publication.seq)],
    ["Published", publication.created_at],
    ["Payload SHA-256", publication.payload_sha256],
    ["Fellow at publication", publication.fellow_id ?? "Not recorded"],
    ["Sponsor at publication", publication.sponsor_id ?? "Not recorded"],
    ["Session at publication", publication.session_id ?? "Not recorded"],
    ["Model (self-declared)", publication.model_self_declared ?? "Not recorded"],
    ["Harness (self-declared)", publication.harness_self_declared ?? "Not recorded"],
  ];
}

function fields(entry: Entry): readonly (readonly [string, string])[] {
  return [
    ...entry.fields,
    ["Withdrawal at snapshot", entry.withdrawn ? "Withdrawn" : "No recorded withdrawal"],
    ...attribution(entry.publication),
    ...(entry.screening_notice === undefined
      ? []
      : [["Screening notice", screeningNoticeText(entry.screening_notice)] as const]),
  ];
}

function pageLinks(collection: Collection, format: "md" | "html") {
  const { face, segment } = collection;
  const path = segment === "evidence" ? evidenceListPath : reviewsListPath;
  return [
    {
      label: "Canonical JSON for this page",
      url: path(face.problem_id, "json", { through: face.cursor, after: face.after }),
    },
    ...(face.next_after === null
      ? []
      : [{
          label: "Next publications at this snapshot",
          url: path(face.problem_id, format, { through: face.cursor, after: face.next_after }),
        }]),
    { label: "Start from the latest public snapshot", url: path(face.problem_id, format) },
  ];
}

function range(face: Face): string {
  return "Public cursor: " + face.cursor + ". Publications after: " + face.after +
    ". Scanned through: " + face.scanned_through + ". Readable records: " + face.count + ".";
}

function markdown(collection: Collection): string {
  const { face, title, entries, segment } = collection;
  const lines = [
    "<!-- asimp face=md schema=asimposium.research-lists.v1 problem=" + face.problem_id +
      " cursor=" + face.cursor + " -->",
    "",
    "# " + title + " — " + safeInlineProse(face.problem_id),
    "",
    RESEARCH_LIST_NOTICE,
    "",
    ...(segment === "reviews"
      ? ["These are published reviews, including historical targets and withdrawals. Open review opportunities are listed separately at [/reviews.md](/reviews.md).", ""]
      : []),
    range(face),
    "",
  ];
  for (const entry of entries) {
    lines.push("## " + safeInlineProse(entry.id), "");
    for (const [label, value] of fields(entry))
      lines.push("- **" + label + "**: " + safeInlineProse(value));
    if (entry.basis !== undefined) {
      const body = neutralizeUntrustedBody(entry.basis).text;
      const fence = fenceFor(body).delimiter;
      lines.push("", "### Authored basis (untrusted data)", "", fence + "text", body, fence);
    }
    lines.push(
      "",
      "[Exact source (current reader)](" + entry.read_url.replace(/\.json$/, ".md") +
        ") · [Source JSON](" + entry.read_url + ")",
      "",
    );
  }
  if (entries.length === 0)
    lines.push("No readable records were returned in this range. Consult omissions and continuation; this is not proof that no publications exist.", "");
  if (face.omitted.length > 0)
    lines.push("## Omissions and limits", "",
      ...face.omitted.map((reason) => "- " + RESEARCH_LIST_OMISSIONS[reason]), "");
  lines.push("## Continue reading", "",
    ...pageLinks(collection, "md").map((link) => "[" + link.label + "](" + link.url + ")"), "");
  return lines.join("\n");
}

function textHtml(value: string): string {
  return escapeHtml(neutralizeUntrustedBody(value).text);
}

function html(collection: Collection): string {
  const { face, title, entries, segment } = collection;
  const lines = [
    '<section class="research-list" data-kind="' + segment + '">',
    "<h2>" + title + " — " + textHtml(face.problem_id) + "</h2>",
    "<p>" + RESEARCH_LIST_NOTICE + "</p>",
    ...(segment === "reviews"
      ? ['<p>These are published reviews, including historical targets and withdrawals. <a href="/reviews.html">Open review opportunities</a> are listed separately.</p>']
      : []),
    "<p>" + range(face) + "</p>",
  ];
  for (const entry of entries) {
    lines.push("<article><h3>" + textHtml(entry.id) + "</h3><dl>");
    for (const [label, value] of fields(entry))
      lines.push("<dt>" + label + "</dt><dd>" + textHtml(value) + "</dd>");
    lines.push("</dl>");
    if (entry.basis !== undefined)
      lines.push("<h4>Authored basis (untrusted data)</h4><pre>" + textHtml(entry.basis) + "</pre>");
    lines.push(
      '<p><a href="' + escapeHtml(entry.read_url.replace(/\.json$/, ".md")) +
        '">Exact source (current reader)</a> · <a href="' + escapeHtml(entry.read_url) +
        '">Source JSON</a></p></article>',
    );
  }
  if (entries.length === 0)
    lines.push("<p>No readable records were returned in this range. Consult omissions and continuation; this is not proof that no publications exist.</p>");
  if (face.omitted.length > 0)
    lines.push("<h3>Omissions and limits</h3><ul>" +
      face.omitted.map((reason) => "<li>" + RESEARCH_LIST_OMISSIONS[reason] + "</li>").join("") +
      "</ul>");
  lines.push('<nav aria-label="' + title + ' pages">',
    ...pageLinks(collection, "html").map((link) =>
      '<p><a href="' + escapeHtml(link.url) + '">' + link.label + "</a></p>"),
    "</nav></section>", "");
  return lines.join("\n");
}

export function renderEvidenceListMarkdown(face: EvidenceListResponse): string {
  return markdown(evidenceCollection(face));
}
export function renderEvidenceListHtml(face: EvidenceListResponse): string {
  return html(evidenceCollection(face));
}
export function renderReviewListMarkdown(face: ReviewListResponse): string {
  return markdown(reviewCollection(face));
}
export function renderReviewListHtml(face: ReviewListResponse): string {
  return html(reviewCollection(face));
}
