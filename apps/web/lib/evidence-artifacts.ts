import type { EvidenceArtifactDiscovery } from "@asimposium/contracts/artifact-publications";
import { claimEvidenceArtifactDiscovery } from "@asimposium/render/artifact-publications";

/** A link is authorized by a readable evidence item and its exact publication,
 * never by an author's URL or by an unrelated item in the same claim face. */
export function evidenceArtifactDiscovery(
  problem: string,
  item: { readonly kind: string; readonly id: string; readonly scope: string; readonly body: string },
): EvidenceArtifactDiscovery | null {
  return claimEvidenceArtifactDiscovery(problem, item) ?? null;
}
