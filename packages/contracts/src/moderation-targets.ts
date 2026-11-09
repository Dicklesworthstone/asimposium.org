import { z } from "zod";
import { CitationIdSchema } from "./citations.ts";
import { ConflictIdSchema } from "./conflicts.ts";
import { DeadEndIdSchema } from "./dead-ends.ts";
import { PublicHypothesisIdSchema } from "./hypotheses.ts";
import { PublicLedgerProblemIdSchema } from "./ledger.ts";
import { ProofGapIdSchema } from "./proof-gaps.ts";
import { QuestionIdSchema } from "./questions.ts";
import { RetractionIdSchema } from "./retractions.ts";
import { ClaimIdSchema } from "./scientific-provenance.ts";
import { SynthesisIdSchema } from "./syntheses.ts";

/** These publications have complete current-control enforcement on their
 * canonical readers. Identity validation is shared by the human form and
 * Worker admission; database publication authority remains Worker-only.
 * Relations cite events rather than their composite storage IDs. Sponsor,
 * commentary and standalone artifact controls have separate authority paths. */
export const MODERATION_LEDGER_TARGETS = [
  { kind: "claim", label: "Claim (all versions)", id: ClaimIdSchema, created: "claim.created" },
  { kind: "hypothesis", label: "Hypothesis", id: PublicHypothesisIdSchema, created: "hypothesis.created" },
  { kind: "evidence", label: "Evidence", id: z.string().regex(/^E-[A-Za-z0-9]{1,78}$/), created: "evidence.created" },
  { kind: "review", label: "Review", id: z.string().max(128).regex(/^R-[A-Za-z0-9][A-Za-z0-9._:-]{0,125}$/), created: "review.created" },
  { kind: "dead_end", label: "Dead end", id: DeadEndIdSchema, created: "dead_end.recorded" },
  { kind: "gap", label: "Proof gap", id: ProofGapIdSchema, created: "gap.filed" },
  { kind: "citation", label: "Citation (all versions)", id: CitationIdSchema, created: "citation.recorded" },
  { kind: "question", label: "Question", id: QuestionIdSchema, created: "question.asked" },
  { kind: "conflict", label: "Conflict", id: ConflictIdSchema, created: "conflict.normalized" },
  { kind: "synthesis", label: "Synthesis", id: SynthesisIdSchema, created: "synthesis.created" },
  { kind: "retraction", label: "Retraction", id: RetractionIdSchema, created: "object.retracted" },
] as const;

export type ModerationLedgerTargetKind = (typeof MODERATION_LEDGER_TARGETS)[number]["kind"];
export type ModerationControlTargetKind = "problem" | ModerationLedgerTargetKind;
export const MODERATION_CONTROL_TARGETS = [
  { kind: "problem", label: "Problem" },
  ...MODERATION_LEDGER_TARGETS.map(({ kind, label }) => ({ kind, label })),
] as const;
export const MODERATION_CONTROL_KINDS: ReadonlySet<string> = new Set(
  MODERATION_CONTROL_TARGETS.map(({ kind }) => kind),
);

export function moderationLedgerTarget(kind: string) {
  return MODERATION_LEDGER_TARGETS.find((target) => target.kind === kind);
}

export function moderationObjectIdIsValid(kind: string, value: string): boolean {
  // Some legacy ID schemas use $, which also matches before a final newline.
  // Exact moderation selectors never trim, decode, or silently widen an ID.
  return !/[\s/@]/.test(value) && moderationLedgerTarget(kind)?.id.safeParse(value).success === true;
}

export interface ModerationControlTarget {
  readonly problemId: string;
  readonly targetKind: ModerationControlTargetKind;
  readonly targetRef: string;
}

/** Whole-object commands only. In particular C-n@v is not a lineage control. */
export function parseModerationControlTarget(
  kind: string,
  targetId: string,
): ModerationControlTarget | undefined {
  const [problemId, objectId, extra] = targetId.split("/");
  if (extra !== undefined || !problemId || /\s/.test(problemId) ||
      !PublicLedgerProblemIdSchema.safeParse(problemId).success) return undefined;
  if (kind === "problem")
    return objectId === undefined ? { problemId, targetKind: "problem", targetRef: "problem" } : undefined;
  const descriptor = moderationLedgerTarget(kind);
  if (!descriptor || objectId === undefined || !moderationObjectIdIsValid(kind, objectId)) return undefined;
  return { problemId, targetKind: descriptor.kind, targetRef: objectId };
}
