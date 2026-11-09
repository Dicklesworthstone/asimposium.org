import { PublicClaimTargetSchema, PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import { ConflictIdSchema, conflictsListPath } from "@asimposium/contracts/conflicts";
import { citationPath, PublicCitationTargetSchema } from "@asimposium/contracts/citations";
import { PublicHypothesisIdSchema } from "@asimposium/contracts/hypotheses";
import { ProofGapIdSchema } from "@asimposium/contracts/proof-gaps";
import { QuestionIdSchema, questionsListPath } from "@asimposium/contracts/questions";

/** References are authored data. Only known public record grammars become
 * links; arbitrary strings and external URLs remain literal reference labels. */
export function questionReferenceLink(problem: string, reference: string, cursor: number): {
  readonly href: string;
  readonly currentOnly: boolean;
} | null {
  if (!PublicLedgerProblemIdSchema.safeParse(problem).success ||
      !Number.isSafeInteger(cursor) || cursor < 0 || reference.trim() !== reference) return null;
  const base = `/p/${encodeURIComponent(problem)}`;
  if (PublicClaimTargetSchema.safeParse(reference).success)
    return { href: `${base}/claims/${encodeURIComponent(reference)}?through=${cursor}`, currentOnly: false };
  if (PublicCitationTargetSchema.safeParse(reference).success)
    return { href: citationPath(problem, reference, "human", { through: cursor }), currentOnly: false };
  const evidence = /^(E-[0-9A-HJKMNP-TV-Z]{1,78})(?:@1)?$/.exec(reference);
  if (evidence) return { href: `/r${base}/evidence/${encodeURIComponent(evidence[1] as string)}`, currentOnly: true };
  const review = /^(R-[0-9A-HJKMNP-TV-Z]{1,78})(?:@1)?$/.exec(reference);
  if (review) return { href: `/r${base}/reviews/${encodeURIComponent(review[1] as string)}`, currentOnly: true };
  if (ProofGapIdSchema.safeParse(reference).success)
    return { href: `${base}/gaps?through=${cursor}&target=${encodeURIComponent(reference)}`, currentOnly: false };
  if (ConflictIdSchema.safeParse(reference).success)
    return { href: conflictsListPath(problem, "human", { through: cursor, target: reference }), currentOnly: false };
  if (QuestionIdSchema.safeParse(reference).success)
    return { href: questionsListPath(problem, "human", { through: cursor, target: reference }), currentOnly: false };
  if (PublicHypothesisIdSchema.safeParse(reference).success)
    return { href: `${base}/hypotheses/${encodeURIComponent(reference)}?through=${cursor}`, currentOnly: false };
  return null;
}
