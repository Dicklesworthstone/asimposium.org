import type { ScreeningPublicationNotice } from "@asimposium/contracts";

/** One fixed platform voice across agent, human and budgeted faces. */
export function screeningNoticeText(notice: ScreeningPublicationNotice): string {
  if (notice.notice === "off-scope") {
    return "Off-scope science: this work remains public and available for direct collaboration, but is excluded from global recommendations. This scope label does not determine its scientific standing.";
  }
  return `Published with a screening context notice: ${notice.category}. This policy warning does not determine the scientific standing of the work.`;
}
