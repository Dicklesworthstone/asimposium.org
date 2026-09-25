/**
 * P7/A9 (beads asimposiumorg-b9y9 / asimposiumorg-kqz5): the one public-content
 * screening decision boundary, shared by every route that makes Fellow text
 * public: session ledger writes and sponsor problem publication.
 *
 * Outcome mapping:
 * - provider failure and incoherent tuples hold, failing closed;
 * - reject denies with only a coarse category plus the appeal path;
 * - quarantine and allow-with-warning hold, because their public-notice
 *   projection has not landed;
 * - only the coherent benign pass tuple publishes, bound to the exact
 *   candidate bytes by its attested digests.
 * Policy refusals starve the oracle (A5): no pattern names, no model output.
 */

import {
  SCREENING_APPEAL_CODE,
  type ScreeningCoarseCategory,
  ScreeningCoarseCategorySchema,
  ScreeningOutcomeSchema,
  ScreeningPromotionDeniedResponseSchema,
  ScreeningPromotionHoldResponseSchema,
  ScreeningProviderStatusSchema,
  ScreeningPublicActionSchema,
} from "@asimposium/contracts";
import type { Env } from "../env";
import { publicationProvenance, type ScreenedPublication } from "./ingress";
import type { PublicationScreeningObservation, WorkersAIPromotionInput } from "./workers-ai";

export type PublicCandidateScreener = (
  input: WorkersAIPromotionInput,
  env: Env,
) => Promise<PublicationScreeningObservation>;

function privateNoStore(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}

export function screeningHoldResponse(category: ScreeningCoarseCategory): Response {
  return privateNoStore(
    ScreeningPromotionHoldResponseSchema.parse({
      code: "SCREENING_HOLD",
      coarse_category: category,
      appeal: SCREENING_APPEAL_CODE,
    }),
    202,
  );
}

function screeningDeniedResponse(category: ScreeningCoarseCategory): Response | undefined {
  const parsed = ScreeningPromotionDeniedResponseSchema.safeParse({
    code: "POLICY_DENIED",
    coarse_category: category,
    appeal: SCREENING_APPEAL_CODE,
  });
  return parsed.success ? privateNoStore(parsed.data, 403) : undefined;
}

/** Screen one exact public candidate. Returns private provenance to retain,
 * or the hold/deny response the route must return instead of committing. */
export async function screenPublicCandidate(
  screener: PublicCandidateScreener,
  env: Env,
  candidate: WorkersAIPromotionInput,
): Promise<Response | ScreenedPublication> {
  // The adapter cannot mutate a candidate after the route has validated it.
  const input = Object.freeze({ ...candidate });
  let screening: PublicationScreeningObservation;
  try {
    const raw = await screener(input, env);
    const decision = ScreeningOutcomeSchema.safeParse(raw.decision);
    const category = ScreeningCoarseCategorySchema.safeParse(raw.coarse_category);
    const providerStatus = ScreeningProviderStatusSchema.safeParse(raw.provider_status);
    if (!decision.success || !category.success || !providerStatus.success) {
      return screeningHoldResponse("provider-unavailable");
    }
    screening = {
      ...raw,
      decision: decision.data,
      coarse_category: category.data,
      provider_status: providerStatus.data,
    };
  } catch {
    return screeningHoldResponse("provider-unavailable");
  }
  if (screening.provider_status !== "ok") return screeningHoldResponse("provider-unavailable");
  if (screening.decision === "reject") {
    return (
      screeningDeniedResponse(screening.coarse_category) ??
      screeningHoldResponse("provider-unavailable")
    );
  }
  if (screening.decision === "quarantine" || screening.decision === "allow-with-warning") {
    return screeningHoldResponse(screening.coarse_category);
  }
  if (
    !ScreeningPublicActionSchema.safeParse({
      category: screening.coarse_category,
      action: "published",
      notice: "none",
    }).success
  ) {
    return screeningHoldResponse("provider-unavailable");
  }
  try {
    return await publicationProvenance(input, screening);
  } catch {
    return screeningHoldResponse("provider-unavailable");
  }
}
