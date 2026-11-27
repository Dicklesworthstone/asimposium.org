import "server-only";

import { FellowIdSchema, SponsorIdSchema } from "@asimposium/contracts";
import { stoaFetchClaimFace, stoaFetchProblemFace } from "./public-ledger";
import { stoaFetchStatementVersion } from "./public-statements";
import { parseReviewHandoff, statementReviewVersion, type ReviewHandoff } from "./review-handoff";

export type ReviewHandoffRead =
  | { readonly ok: true; readonly context: ReviewHandoff; readonly authorFellowId: string; readonly authorSponsorId?: string }
  | { readonly ok: false; readonly message: string };

/** Fresh canonical read: a query string alone cannot initialize an actionable review request. */
export async function readReviewHandoff(value: unknown): Promise<ReviewHandoffRead> {
  const context = parseReviewHandoff(value);
  if (context === undefined) {
    return { ok: false, message: "This review link is incomplete or invalid. Choose an exact claim or published statement." };
  }
  const statementVersion = statementReviewVersion(context);
  if (statementVersion !== undefined) return readStatementReviewHandoff(context, statementVersion);
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

/** Pin the reviewed publication while separately checking that the current
 * formulation still admits this task. Neither an older public snapshot nor
 * the acting publisher proves the present scientific author or sponsor. */
async function readStatementReviewHandoff(
  context: ReviewHandoff,
  version: number,
): Promise<ReviewHandoffRead> {
  try {
    const [source, current] = await Promise.all([
      stoaFetchStatementVersion(context.problemId, String(version), undefined, { through: context.through }),
      stoaFetchProblemFace(context.problemId),
    ]);
    if (source.state !== "ok" || current.state !== "ok") {
      return {
        ok: false,
        message: source.state === "not_found" || current.state === "not_found"
          ? "This published statement is no longer publicly available. Return to the current problem before requesting a review."
          : "The exact statement and current formulation could not be verified. Reload before requesting a review.",
      };
    }
    const statement = source.data.statement;
    const currentTitles = current.data.items.filter((item) => item.kind === "problem-title");
    if (
      source.data.problem_id !== context.problemId ||
      source.data.cursor !== Number(context.through) ||
      statement.version !== version ||
      statement.publication.seq > source.data.cursor ||
      current.data.problem !== context.problemId ||
      current.data.cursor < source.data.cursor ||
      !["sharpening", "active", "dormant", "under-result-review"].includes(current.data.problem_status) ||
      currentTitles.length !== 1 ||
      currentTitles[0]?.id !== context.target + "-title" ||
      currentTitles[0]?.scope !== "ledger" ||
      currentTitles[0]?.untrusted !== true
    ) {
      return {
        ok: false,
        message: "This statement is no longer the current reviewable formulation, or its exact snapshot could not be verified. Read the current problem and choose its current statement; this request will not switch versions.",
      };
    }
    const author = statement.scientific_author;
    const fellow = FellowIdSchema.safeParse(author?.fellow_id);
    const sponsor = SponsorIdSchema.safeParse(author?.sponsor_id);
    if (!fellow.success || !sponsor.success || fellow.data !== statement.source_fellow_id) {
      return {
        ok: false,
        message: "The statement's scientific author and sponsor could not be verified from its publication. Its publisher or current owner cannot establish independent review.",
      };
    }
    return { ok: true, context, authorFellowId: fellow.data, authorSponsorId: sponsor.data };
  } catch {
    return { ok: false, message: "The exact statement and current formulation could not be verified. Reload before requesting a review." };
  }
}
