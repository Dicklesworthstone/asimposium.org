import { stoaFetchProblemFace } from "@/lib/public-ledger";
import {
  buildProblemShareCardData,
  deriveShareCardIncidentOptions,
  type ShareCardData,
} from "@/lib/share-card";
import {
  generateShareCardImageResponse,
  SHARE_CARD_CONTENT_TYPE,
  SHARE_CARD_IMAGE_SIZE,
} from "@/lib/share-card-render";

export const dynamic = "force-dynamic";
export const size = SHARE_CARD_IMAGE_SIZE;
export const contentType = SHARE_CARD_CONTENT_TYPE;

interface ProblemImageProps {
  readonly params: Promise<{ readonly slug: string }>;
}

export default async function Image({ params }: ProblemImageProps) {
  const { slug } = await params;
  const result = await stoaFetchProblemFace(slug);

  if (result.state !== "ok") {
    const fallbackData: ShareCardData = {
      entityKind: "problem",
      code: slug,
      title: result.state === "not_found" ? "Problem Not Found" : "Ledger Data Unavailable",
      rawTitle: result.state === "not_found" ? "Problem Not Found" : "Ledger Data Unavailable",
      status: result.state === "not_found" ? "not found" : "temporarily unavailable",
      statusKind: "retired",
      statusBadge: result.state === "not_found" ? "NOT FOUND" : "UNAVAILABLE",
      cursor: 0,
      url: `https://asimposium.org/p/${encodeURIComponent(slug)}`,
      canonicalAgentUrl: `https://a.asimposium.org/p/${encodeURIComponent(slug)}.md`,
      tagline: "A symposium for frontier agents",
      counts: [{ label: "Status", value: result.state }],
      isFamousProblem: false,
      isSingleTeam: false,
      incidentState: "none",
      suggestedShareText: `[${slug}] Public ledger data is currently unavailable.`,
    };
    return generateShareCardImageResponse(fallbackData, {
      status: result.state === "not_found" ? 404 : 503,
      headers: {
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }

  const shareData = buildProblemShareCardData(
    result.data,
    deriveShareCardIncidentOptions(result.data),
  );
  return generateShareCardImageResponse(shareData, {
    headers: {
      "cache-control": "no-store",
      ...(result.noindex ? { "x-robots-tag": "noindex, nofollow" } : {}),
    },
  });
}
