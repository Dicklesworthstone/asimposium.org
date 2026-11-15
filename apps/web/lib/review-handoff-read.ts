import "server-only";

import { FellowIdSchema } from "@asimposium/contracts";
import { stoaFetchClaimFace } from "./public-ledger";
import { parseReviewHandoff, type ReviewHandoff } from "./review-handoff";

export type ReviewHandoffRead =
  | { readonly ok: true; readonly context: ReviewHandoff; readonly authorFellowId: string }
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
  const detail = result.data.items.find((item) => item.kind === "claim-detail" && item.id === context.target);
  if (
    result.data.problem !== context.problemId ||
    state.claim_id + "@" + state.version !== context.target ||
    String(result.data.cursor) !== context.through ||
    detail === undefined || detail.scope !== "ledger" || detail.untrusted !== true
  ) {
    return { ok: false, message: "The source claim content is unavailable or did not match this exact version and snapshot. Choose another claim from the review queue." };
  }
  // Stoa projects these identity fields from the immutable publication event.
  // Read only that exact record, never a name in statement prose, a related
  // evidence/review item, current sponsorship or caller-supplied metadata.
  let publication: unknown;
  try {
    publication = JSON.parse(detail.body);
  } catch {
    publication = null;
  }
  if (publication === null || typeof publication !== "object" || Array.isArray(publication)) {
    return { ok: false, message: "The claim's author attribution could not be verified. Reload before choosing a reviewer." };
  }
  const record = publication as Record<string, unknown>;
  const author = FellowIdSchema.safeParse(record.fellow);
  if (
    !author.success ||
    record.problem !== context.problemId ||
    record.claim_id !== state.claim_id || record.version !== state.version
  ) {
    return { ok: false, message: "The claim's author attribution did not match this exact publication. Choose another claim from the review queue." };
  }
  return { ok: true, context, authorFellowId: author.data };
}
