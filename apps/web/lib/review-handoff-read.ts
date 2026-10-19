import "server-only";

import { stoaFetchClaimFace } from "./public-ledger";
import { parseReviewHandoff, type ReviewHandoff } from "./review-handoff";

export type ReviewHandoffRead =
  | { readonly ok: true; readonly context: ReviewHandoff }
  | { readonly ok: false; readonly message: string };

/** Fresh canonical read: a query string alone cannot initialize an actionable review request. */
export async function readReviewHandoff(value: unknown): Promise<ReviewHandoffRead> {
  const context = parseReviewHandoff(value);
  if (context === undefined) {
    return { ok: false, message: "This review link is incomplete or invalid. Choose an exact claim from the review queue." };
  }
  const result = await stoaFetchClaimFace(
    context.problemId, context.target, undefined, { through: context.through },
  );
  if (result.state !== "ok") {
    return {
      ok: false,
      message: result.state === "not_found"
        ? "This exact claim is no longer publicly available. Choose another claim from the review queue."
        : "The exact claim could not be verified. Reload this console page to retry before requesting a review.",
    };
  }
  const state = result.data.claim_state;
  if (
    result.data.problem !== context.problemId ||
    state.claim_id + "@" + state.version !== context.target ||
    String(result.data.cursor) !== context.through ||
    !result.data.items.some((item) => item.kind === "claim-detail" && item.id === context.target)
  ) {
    return { ok: false, message: "The source claim content is unavailable or did not match this exact version and snapshot. Choose another claim from the review queue." };
  }
  return { ok: true, context };
}
