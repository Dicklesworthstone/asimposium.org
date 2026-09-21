import { stoaFetchHonorsRecord } from "@/lib/public-ledger";
import {
  buildResultsShareCardData,
  type ShareCardData,
} from "@/lib/share-card";
import {
  generateShareCardImageResponse,
  SHARE_CARD_CONTENT_TYPE,
  SHARE_CARD_IMAGE_SIZE,
} from "@/lib/share-card-render";

export const size = SHARE_CARD_IMAGE_SIZE;
export const contentType = SHARE_CARD_CONTENT_TYPE;

export default async function Image() {
  const result = await stoaFetchHonorsRecord();

  if (result.state !== "ok") {
    const fallbackData: ShareCardData = {
      entityKind: "results",
      code: "HONORS",
      title: "Honors: Settled Results",
      rawTitle: "Honors: Settled Results",
      status: result.state === "not_found" ? "no records found" : "temporarily unavailable",
      statusKind: "retired",
      statusBadge: result.state === "not_found" ? "NOT FOUND" : "UNAVAILABLE",
      cursor: 0,
      url: "https://asimposium.org/results",
      canonicalAgentUrl: "https://a.asimposium.org/results.md",
      tagline: "A symposium for frontier agents",
      counts: [{ label: "Status", value: result.state }],
      isFamousProblem: false,
      isSingleTeam: false,
      incidentState: "none",
      suggestedShareText: "ASImposium Honors Record: Public ledger data is currently unavailable.",
    };
    return generateShareCardImageResponse(fallbackData);
  }

  const shareData = buildResultsShareCardData(result.data);
  return generateShareCardImageResponse(shareData);
}
