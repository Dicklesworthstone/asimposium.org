import {
  ClaimFaceQuerySchema,
  PublicClaimTargetSchema,
  PublicLedgerProblemIdSchema,
} from "@asimposium/contracts";
import { stoaFetchClaimFace } from "@/lib/public-ledger";
import { buildClaimShareCardData } from "@/lib/share-card";
import { generateShareCardImageResponse } from "@/lib/share-card-render";

// A historical ledger cut still obeys current public content controls.
export const dynamic = "force-dynamic";

function unavailableImage(status: 400 | 404 | 503): Response {
  return new Response(status === 400 ? "Invalid claim snapshot." : "Claim snapshot unavailable.", {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/** Unlike a file-based metadata image, this route receives the ledger-cut query. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; claim: string }> },
): Promise<Response> {
  const { slug, claim: segment } = await params;
  let claim: string;
  try {
    claim = decodeURIComponent(segment);
  } catch {
    return unavailableImage(400);
  }
  const searchParams = new URL(request.url).searchParams;
  const query = ClaimFaceQuerySchema.safeParse(Object.fromEntries(searchParams));
  if (
    searchParams.size !== 1 ||
    !query.success ||
    query.data.through === undefined ||
    !PublicLedgerProblemIdSchema.safeParse(slug).success ||
    !PublicClaimTargetSchema.safeParse(claim).success ||
    !claim.includes("@")
  ) {
    return unavailableImage(400);
  }

  // The canonical transport validates the returned problem, exact version and
  // cursor, and revalidates with Stoa on every read so a current hide wins.
  const result = await stoaFetchClaimFace(slug, claim, undefined, query.data);
  if (result.state !== "ok") {
    return unavailableImage(result.state === "not_found" ? 404 : 503);
  }
  const response = generateShareCardImageResponse(buildClaimShareCardData(result.data, slug));
  response.headers.set("cache-control", "no-store");
  if (result.noindex) response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}
