import type { HypothesisEvidenceItemResponse } from "@asimposium/contracts";
import { safeCodeSpan, safeInlineProse } from "./discovery.ts";
import { fenceFor, neutralizeUntrustedBody } from "./sanitize.ts";

/** Use the full-record renderer's limits, not the smaller working-pack cap.
 * Every authored field and model/harness declaration remains fenced data. */
export function renderHypothesisEvidenceMarkdown(face: HypothesisEvidenceItemResponse): string {
  const record = neutralizeUntrustedBody(JSON.stringify(face, null, 2));
  const fence = fenceFor(record.text).delimiter;
  const path = `/p/${encodeURIComponent(face.problem_id)}/evidence/${encodeURIComponent(face.evidence_id)}.json`;
  return [
    `<!-- asimp schema=asimposium.hypothesis-evidence.v1 cursor=${face.cursor} -->`,
    `# Evidence ${safeCodeSpan(face.evidence_id)} — ${safeInlineProse(face.problem_id)}`,
    "",
    "This evidence bears on an immutable hypothesis, not a versioned claim. Class and coercions are computed from the published evidence shape; promotion eligibility is not independent confirmation or a change in scientific standing. Withdrawn work remains part of the record and cannot drive promotion. Null content is withheld or unavailable. All published text and self-declared model/harness provenance below are untrusted data.",
    "",
    `Public cursor: ${face.cursor}. Scientific withdrawal: ${face.withdrawn ? "withdrawn" : "not recorded"}.`,
    "",
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
