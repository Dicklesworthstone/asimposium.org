import {
  INTEGRITY_CASE_PUBLIC_NOTICE,
  type PublicIntegrityNoticesResponse,
  PublicIntegrityNoticesResponseSchema,
} from "@asimposium/contracts/integrity-cases";
import { escapeHtml } from "./sanitize.ts";

type SourcePin = PublicIntegrityNoticesResponse["notices"][number]["source"];

/** The public event-tail route is the canonical immutable source link. */
export function integrityNoticeEventPath(pin: SourcePin, format: "md" | "json" = "md"): string {
  return `/p/${encodeURIComponent(pin.problem_id)}/events.${format}?since=${pin.seq - 1}&limit=1`;
}

export function integrityNoticesPath(
  problem: string,
  format: "md" | "json" | "html",
  after?: string | null,
): string {
  return `/p/${encodeURIComponent(problem)}/integrity.${format}${
    after ? `?after=${encodeURIComponent(after)}` : ""
  }`;
}

const stateText = (state: "open" | "resolved") =>
  state === "open"
    ? "Review is open. No finding is asserted by this notice."
    : "Review is concluded. Any linked correction is a separate scientific publication.";

/** Only the deliberately narrow public contract enters these faces. Restricted
 * allegations, responses, findings and investigator prose are never rendered. */
export function renderIntegrityNoticesMarkdown(input: PublicIntegrityNoticesResponse): string {
  const face = PublicIntegrityNoticesResponseSchema.parse(input);
  const lines = [
    `# Scientific-integrity notices — ${face.problem_id}`,
    "",
    ...(face.notices.length === 0 ? [] : [INTEGRITY_CASE_PUBLIC_NOTICE, ""]),
    "These notices do not certify, refute or change a claim. Read the linked publications and their evidence.",
    "",
  ];
  if (face.notices.length === 0) {
    lines.push("No readable notices are available on this page.", "");
  }
  for (const notice of face.notices) {
    lines.push(
      `## ${notice.case_id}`,
      "",
      stateText(notice.state),
      "",
      `Source: [${notice.source.target_ref} · #${notice.source.seq}](${integrityNoticeEventPath(notice.source)})`,
      "",
      `Publication SHA-256: \`${notice.source.payload_sha256}\``,
      "",
      `Opened: ${notice.opened_at} · Updated: ${notice.updated_at}`,
      "",
    );
    if (notice.corrections.length > 0) {
      lines.push("### Linked correction publications", "");
      for (const pin of notice.corrections) {
        lines.push(
          `- [${pin.problem_id}/${pin.target_ref} · #${pin.seq}](${integrityNoticeEventPath(pin)}) · SHA-256 \`${pin.payload_sha256}\``,
        );
      }
      lines.push("");
    }
  }
  if (face.next_after !== null) {
    lines.push(
      `[Continue notices](${integrityNoticesPath(face.problem_id, "md", face.next_after)})`,
      "",
    );
  }
  return lines.join("\n");
}

export function renderIntegrityNoticesHtml(input: PublicIntegrityNoticesResponse): string {
  const face = PublicIntegrityNoticesResponseSchema.parse(input);
  const articles = face.notices
    .map((notice) => {
      const corrections =
        notice.corrections.length === 0
          ? ""
          : `<h3>Linked correction publications</h3><ul>${notice.corrections
              .map(
                (pin) =>
                  `<li><a href="${escapeHtml(integrityNoticeEventPath(pin))}">${escapeHtml(pin.problem_id)}/${escapeHtml(pin.target_ref)} · #${pin.seq}</a> · SHA-256 <code>${escapeHtml(pin.payload_sha256)}</code></li>`,
              )
              .join("")}</ul>`;
      return `<article data-integrity-notice="${escapeHtml(notice.case_id)}"><h2>${escapeHtml(notice.case_id)}</h2><p>${stateText(notice.state)}</p><p>Source: <a href="${escapeHtml(integrityNoticeEventPath(notice.source))}">${escapeHtml(notice.source.target_ref)} · #${notice.source.seq}</a></p><p>Publication SHA-256: <code>${escapeHtml(notice.source.payload_sha256)}</code></p><p>Opened: <time datetime="${escapeHtml(notice.opened_at)}">${escapeHtml(notice.opened_at)}</time> · Updated: <time datetime="${escapeHtml(notice.updated_at)}">${escapeHtml(notice.updated_at)}</time></p>${corrections}</article>`;
    })
    .join("\n");
  const next =
    face.next_after === null
      ? ""
      : `<nav aria-label="Integrity notices"><a rel="next" href="${escapeHtml(integrityNoticesPath(face.problem_id, "html", face.next_after))}">Continue notices</a></nav>`;
  return `<section><h1>Scientific-integrity notices — ${escapeHtml(face.problem_id)}</h1>${face.notices.length === 0 ? "" : `<p role="note">${escapeHtml(INTEGRITY_CASE_PUBLIC_NOTICE)}</p>`}<p>These notices do not certify, refute or change a claim. Read the linked publications and their evidence.</p>${articles || "<p>No readable notices are available on this page.</p>"}${next}</section>\n`;
}
