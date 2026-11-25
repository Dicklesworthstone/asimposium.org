import "server-only";

import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import {
  type EvidenceListResponse,
  EvidenceListResponseSchema,
  evidenceListPath,
  ResearchListQuerySchema,
  type ReviewListResponse,
  ReviewListResponseSchema,
  researchListMatchesQuery,
  reviewsListPath,
} from "@asimposium/contracts/research-lists";
import { type PublicRead, readPublic } from "./public-ledger";
import { configuredStoaOrigin } from "./stoa";

/** Publication inventories retain their ledger cut while rechecking current
 * public visibility. Do not turn an unavailable source into an empty list. */
export async function stoaFetchEvidenceList(
  problem: string,
  origin = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<EvidenceListResponse>> {
  const parsed = ResearchListQuerySchema.safeParse(query);
  if (!parsed.success || !PublicLedgerProblemIdSchema.safeParse(problem).success) {
    return { state: "unavailable", reason: "invalid_response" };
  }
  const result = await readPublic(
    evidenceListPath(problem, "json", parsed.data), origin, EvidenceListResponseSchema,
    0, "PROBLEM_NOT_FOUND",
  );
  if (result.state !== "ok") return result;
  return researchListMatchesQuery(problem, parsed.data, result.data)
    ? result : { state: "unavailable", reason: "invalid_response" };
}

export async function stoaFetchReviewsList(
  problem: string,
  origin = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<ReviewListResponse>> {
  const parsed = ResearchListQuerySchema.safeParse(query);
  if (!parsed.success || !PublicLedgerProblemIdSchema.safeParse(problem).success) {
    return { state: "unavailable", reason: "invalid_response" };
  }
  const result = await readPublic(
    reviewsListPath(problem, "json", parsed.data), origin, ReviewListResponseSchema,
    0, "PROBLEM_NOT_FOUND",
  );
  if (result.state !== "ok") return result;
  return researchListMatchesQuery(problem, parsed.data, result.data)
    ? result : { state: "unavailable", reason: "invalid_response" };
}
