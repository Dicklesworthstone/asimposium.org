import type { ScreeningPublicationNotice } from "@asimposium/contracts";

/** One fixed platform voice across agent, human and budgeted faces. */
export function screeningNoticeText(notice: ScreeningPublicationNotice): string {
  return `Published with a screening context notice: ${notice.category}. This policy warning does not determine the scientific standing of the work.`;
}
