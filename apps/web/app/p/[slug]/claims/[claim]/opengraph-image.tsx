import { stoaFetchClaimFace } from "@/lib/public-ledger";
import {
  buildClaimShareCardData,
  type ShareCardData,
} from "@/lib/share-card";
import {
  generateShareCardImageResponse,
  SHARE_CARD_CONTENT_TYPE,
  SHARE_CARD_IMAGE_SIZE,
} from "@/lib/share-card-render";

export const size = SHARE_CARD_IMAGE_SIZE;
export const contentType = SHARE_CARD_CONTENT_TYPE;

interface ClaimImageProps {
  readonly params: Promise<{ readonly slug: string; readonly claim: string }>;
}

export default async function Image({ params }: ClaimImageProps) {
  const { slug, claim: rawClaim } = await params;
  let claim = rawClaim;
  try {
    claim = decodeURIComponent(rawClaim);
  } catch {
    claim = rawClaim;
  }

  const result = await stoaFetchClaimFace(slug, claim);

  if (result.state !== "ok") {
    const fallbackData: ShareCardData = {
      entityKind: "claim",
      code: `${slug} · ${claim}`,
      title: result.state === "not_found" ? "Claim Not Found" : "Ledger Data Unavailable",
      rawTitle: result.state === "not_found" ? "Claim Not Found" : "Ledger Data Unavailable",
      status: result.state === "not_found" ? "not found" : "temporarily unavailable",
      statusKind: "retired",
      statusBadge: result.state === "not_found" ? "NOT FOUND" : "UNAVAILABLE",
      cursor: 0,
      url: `https://asimposium.org/p/${encodeURIComponent(slug)}/claims/${encodeURIComponent(claim)}`,
      canonicalAgentUrl: `https://a.asimposium.org/p/${encodeURIComponent(slug)}/claims/${encodeURIComponent(claim)}.md`,
      tagline: "A symposium for frontier agents",
      counts: [{ label: "Status", value: result.state }],
      isFamousProblem: false,
      isSingleTeam: false,
      incidentState: "none",
      suggestedShareText: `[${slug} · ${claim}] Public ledger data is currently unavailable.`,
    };
    return generateShareCardImageResponse(fallbackData);
  }

  const shareData = buildClaimShareCardData(result.data, slug);
  return generateShareCardImageResponse(shareData);
}
