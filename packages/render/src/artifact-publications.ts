import {
  EvidenceArtifactDiscoverySchema,
  type EvidenceArtifacts,
  EvidenceArtifactsSchema,
  evidenceArtifactsPath,
  type PublicArtifactManifest,
  PublicArtifactManifestSchema,
  tryBuildEvidenceArtifactDiscovery,
} from "@asimposium/contracts/artifact-publications";
import { safeCodeSpan } from "./discovery.ts";
import { escapeHtml } from "./sanitize.ts";
import { screeningNoticeText } from "./screening-notice.ts";

export const EVIDENCE_ARTIFACTS_BOUNDARY =
  "Current public downloads for one exact evidence publication. Delivery cursors are global file-publication cursors, not this problem's ledger sequence. Files may have been delivered after a historical claim snapshot. Current source visibility and scientific withdrawal still apply.";
export const ARTIFACT_BYTES_VERIFICATION_BOUNDARY =
  "Bytes-only verification checks the file digest and delivery. It does not establish that the computation is correct, that a proof succeeds, or that the scientific claim is independently verified.";
export const CLAIM_ARTIFACT_DISCOVERY_BOUNDARY =
  "Evidence file links follow current delivery availability, which can change after this ledger snapshot. File availability does not establish scientific verification.";

/** A pack body is still untrusted data. Only a canonical discovery value bound
 * to this public item's identity and source may become an active link. */
export function claimEvidenceArtifactDiscovery(
  problem: string,
  item: {
    readonly kind: string;
    readonly id: string;
    readonly scope: string;
    readonly body: string;
  },
) {
  if (item.kind !== "claim-evidence" || item.scope !== "ledger") return undefined;
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(item.body);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    body = value as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const status = body.scientific_status;
  if (
    status !== null &&
    typeof status === "object" &&
    "withdrawal" in status &&
    status.withdrawal === "withdrawn"
  )
    return undefined;
  if (typeof body.artifact_discovery === "string") {
    if (typeof body.event !== "string" || typeof body.content_digest !== "string") return undefined;
    const discovery = tryBuildEvidenceArtifactDiscovery({
      problem_id: problem,
      evidence_id: item.id,
      evidence_event_id: body.event,
      evidence_digest: body.content_digest,
    });
    return discovery?.json_path === body.artifact_discovery ? discovery : undefined;
  }
  const parsed = EvidenceArtifactDiscoverySchema.safeParse(body.artifact_discovery);
  if (!parsed.success) return undefined;
  const discovery = parsed.data;
  return discovery.problem_id === problem &&
    discovery.evidence_id === item.id &&
    discovery.evidence_event_id === body.event &&
    discovery.evidence_digest === body.content_digest
    ? discovery
    : undefined;
}

function manifestMarkdown(face: PublicArtifactManifest): string[] {
  const notice = face.evidence.screening_notice;
  return [
    `### ${safeCodeSpan(face.publication_id)}`,
    "",
    ...(notice === undefined ? [] : [screeningNoticeText(notice), ""]),
    `- [Download ${face.artifact.size_bytes} bytes](${face.artifact.download_url}) · ${safeCodeSpan(face.artifact.content_type)}`,
    `- SHA-256: ${safeCodeSpan(face.artifact.sha256)}`,
    `- Evidence: ${safeCodeSpan(face.evidence.evidence_id)}; event ${safeCodeSpan(face.evidence.event_id)}; digest ${safeCodeSpan(face.evidence.digest)}`,
    `- Published by Fellow ${safeCodeSpan(face.author.fellow_id)} under sponsor ${safeCodeSpan(face.author.sponsor_id)}.`,
    `- License: [${face.license}](https://creativecommons.org/licenses/by/4.0/). Delivery cursor: ${face.delivery_cursor}.`,
    `- [Exact publication metadata](/p/${face.problem_id}/artifacts/${face.publication_id}.json). Request event: ${safeCodeSpan(face.publication_event.event_id)} (problem sequence ${face.publication_event.seq}).`,
    "",
  ];
}

function manifestHtml(face: PublicArtifactManifest): string {
  const notice = face.evidence.screening_notice;
  return [
    `<section class="asimp-artifact" id="${escapeHtml(face.publication_id)}">`,
    `<h3>${escapeHtml(face.publication_id)}</h3>`,
    ...(notice === undefined
      ? []
      : [
          `<aside role="note" data-screening-notice="${escapeHtml(notice.notice)}">${escapeHtml(screeningNoticeText(notice))}</aside>`,
        ]),
    `<p><a href="${escapeHtml(face.artifact.download_url)}" rel="noreferrer">Download ${face.artifact.size_bytes} bytes</a> · ${escapeHtml(face.artifact.content_type)}</p>`,
    `<dl><dt>SHA-256</dt><dd><code>${escapeHtml(face.artifact.sha256)}</code></dd>`,
    `<dt>Evidence source</dt><dd>${escapeHtml(face.evidence.evidence_id)} · ${escapeHtml(face.evidence.event_id)} · <code>${escapeHtml(face.evidence.digest)}</code></dd>`,
    `<dt>Publication attribution</dt><dd>Fellow ${escapeHtml(face.author.fellow_id)} under sponsor ${escapeHtml(face.author.sponsor_id)}</dd>`,
    `<dt>License</dt><dd><a href="https://creativecommons.org/licenses/by/4.0/">${face.license}</a></dd>`,
    `<dt>Delivery cursor</dt><dd>${face.delivery_cursor}</dd>`,
    `<dt>Publication request</dt><dd>${escapeHtml(face.publication_event.event_id)} · problem sequence ${face.publication_event.seq}</dd></dl>`,
    `<p><a href="/p/${face.problem_id}/artifacts/${face.publication_id}.json">Exact publication metadata</a></p>`,
    "</section>",
  ].join("\n");
}

export function renderPublicArtifactMarkdown(input: PublicArtifactManifest): string {
  const face = PublicArtifactManifestSchema.parse(input);
  return [
    `<!-- asimp schema=${face.schema} delivery_cursor=${face.delivery_cursor} -->`,
    "# Published artifact",
    "",
    ARTIFACT_BYTES_VERIFICATION_BOUNDARY,
    "",
    ...manifestMarkdown(face),
    `[Current files for this evidence](${evidenceArtifactsPath(face.problem_id, face.evidence.evidence_id, "md", { evidence_digest: face.evidence.digest })})`,
    "",
  ].join("\n");
}

export function renderPublicArtifactHtml(input: PublicArtifactManifest): string {
  const face = PublicArtifactManifestSchema.parse(input);
  return `<article class="asimp-face asimp-artifact-publication"><h2>Published artifact</h2><p>${escapeHtml(ARTIFACT_BYTES_VERIFICATION_BOUNDARY)}</p>${manifestHtml(face)}</article>`;
}

export function renderEvidenceArtifactsMarkdown(input: EvidenceArtifacts): string {
  const face = EvidenceArtifactsSchema.parse(input);
  const pin = { evidence_digest: face.evidence_digest };
  return [
    `<!-- asimp schema=${face.schema} delivery_cursor=${face.through} -->`,
    `# Published files for ${safeCodeSpan(face.problem_id)} · ${safeCodeSpan(face.evidence_id)}`,
    "",
    EVIDENCE_ARTIFACTS_BOUNDARY,
    "",
    ARTIFACT_BYTES_VERIFICATION_BOUNDARY,
    "",
    `Evidence publication: ${safeCodeSpan(face.evidence_event_id)} · ${safeCodeSpan(face.evidence_digest)}.`,
    `Delivery window: after ${face.after}, through ${face.through}.`,
    "",
    ...(face.artifacts.length === 0
      ? ["No currently available public files occur in this delivery window.", ""]
      : face.artifacts.flatMap(manifestMarkdown)),
    ...(face.next_after === null
      ? []
      : [
          `[Next page at this delivery cutoff](${evidenceArtifactsPath(face.problem_id, face.evidence_id, "md", { after: String(face.next_after), through: String(face.through), ...pin })})`,
          "",
        ]),
    `[Check for later deliveries](${evidenceArtifactsPath(face.problem_id, face.evidence_id, "md", { after: String(face.through), ...pin })})`,
    "",
    `[JSON](${evidenceArtifactsPath(face.problem_id, face.evidence_id, "json", { after: String(face.after), through: String(face.through), ...pin })})`,
    "",
  ].join("\n");
}

export function renderEvidenceArtifactsHtml(input: EvidenceArtifacts): string {
  const face = EvidenceArtifactsSchema.parse(input);
  const pin = { evidence_digest: face.evidence_digest };
  return [
    `<article class="asimp-face asimp-evidence-artifacts" data-evidence-id="${escapeHtml(face.evidence_id)}" data-delivery-cursor="${face.through}">`,
    `<h2>Published files for ${escapeHtml(face.evidence_id)}</h2>`,
    `<p>${escapeHtml(EVIDENCE_ARTIFACTS_BOUNDARY)}</p>`,
    `<p>${escapeHtml(ARTIFACT_BYTES_VERIFICATION_BOUNDARY)}</p>`,
    `<p>Evidence publication: ${escapeHtml(face.evidence_event_id)} · <code>${escapeHtml(face.evidence_digest)}</code>.</p>`,
    `<p>Delivery window: after ${face.after}, through ${face.through}.</p>`,
    ...(face.artifacts.length === 0
      ? ["<p>No currently available public files occur in this delivery window.</p>"]
      : face.artifacts.map(manifestHtml)),
    '<nav aria-label="Artifact delivery pages">',
    ...(face.next_after === null
      ? []
      : [
          `<p><a href="${escapeHtml(evidenceArtifactsPath(face.problem_id, face.evidence_id, "human", { after: String(face.next_after), through: String(face.through), ...pin }))}">Next page at this delivery cutoff</a></p>`,
        ]),
    `<p><a href="${escapeHtml(evidenceArtifactsPath(face.problem_id, face.evidence_id, "human", { after: String(face.through), ...pin }))}">Check for later deliveries</a></p>`,
    "</nav></article>",
  ].join("\n");
}
