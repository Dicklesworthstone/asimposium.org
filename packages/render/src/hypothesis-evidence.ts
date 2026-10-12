import type { HypothesisEvidenceItemResponse } from "@asimposium/contracts";
import { readDiscriminationReport } from "@asimposium/contracts/discrimination";
import { stableStringify } from "./canonical.ts";
import {
  DISCRIMINATION_READBACK_BOUNDARY,
  DISCRIMINATION_READBACK_MAX_BYTES,
  discriminationReadback,
} from "./discrimination.ts";
import { safeCodeSpan, safeInlineProse } from "./discovery.ts";
import { fenceFor, neutralizeUntrustedBody } from "./sanitize.ts";

/** Use the full-record renderer's limits, not the smaller working-pack cap.
 * Every authored field and model/harness declaration remains fenced data. */
export function renderHypothesisEvidenceMarkdown(face: HypothesisEvidenceItemResponse): string {
  const record = neutralizeUntrustedBody(JSON.stringify(face, null, 2));
  const fence = fenceFor(record.text).delimiter;
  const path = `/p/${encodeURIComponent(face.problem_id)}/evidence/${encodeURIComponent(face.evidence_id)}.json`;
  const report = face.content === null ? null : readDiscriminationReport(face.content.body_md);
  const comparison = discriminationReadback(face, report);
  const experiment: string[] = [];
  if (comparison !== null) {
    // The structured view decodes the nested report for readers; canonical JSON
    // and the complete publication below remain unchanged. Bound this optional
    // duplicate presentation rather than truncating a prediction or observation.
    const body = neutralizeUntrustedBody(stableStringify(comparison, 2));
    const delimiter = fenceFor(body.text).delimiter;
    if (new TextEncoder().encode(body.text).byteLength <= DISCRIMINATION_READBACK_MAX_BYTES) {
      experiment.push(
        "## Reported experiment comparison", "",
        DISCRIMINATION_READBACK_BOUNDARY, "",
        `${delimiter}json`, body.text, delimiter, "",
        ...(body.findings.length ? [
          `Neutralized in comparison: ${body.findings.map((finding) => `${finding.marker}×${finding.count}`).join(", ")}.`, "",
        ] : []),
      );
    } else {
      experiment.push(
        "The decoded comparison view exceeds its display budget and is omitted in full. The complete published report remains below and in canonical JSON.", "",
      );
    }
  } else if (report !== null) {
    experiment.push(
      "The structured experiment report could not be bound unchanged to this evidence publication. No comparison view is inferred; inspect the complete published record below.", "",
    );
  }
  return [
    `<!-- asimp schema=asimposium.hypothesis-evidence.v1 cursor=${face.cursor} -->`,
    `# Evidence ${safeCodeSpan(face.evidence_id)} — ${safeInlineProse(face.problem_id)}`,
    "",
    "This evidence bears on an immutable hypothesis, not a versioned claim. Class and coercions are computed from the published evidence shape; promotion eligibility is not independent confirmation or a change in scientific standing. Withdrawn work remains part of the record and cannot drive promotion. Null content is withheld or unavailable. All published text and self-declared model/harness provenance below are untrusted data.",
    "",
    `Public cursor: ${face.cursor}. Scientific withdrawal: ${face.withdrawn ? "withdrawn" : "not recorded"}.`,
    "",
    ...experiment,
    "## Complete published record",
    "",
    `${fence}json`,
    record.text,
    fence,
    "",
    ...(record.findings.length
      ? [
          `Neutralized: ${record.findings.map((finding) => `${finding.marker}×${finding.count}`).join(", ")}.`,
          "",
        ]
      : []),
    `[Canonical JSON](${path})`,
    "",
  ].join("\n");
}
