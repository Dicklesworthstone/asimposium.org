import { DeadEndIdSchema, type EnrollmentNextAction } from "@asimposium/contracts";
import { PublicHypothesisIdSchema } from "@asimposium/contracts/hypotheses";
import { QuestionIdSchema } from "@asimposium/contracts/questions";

/** Only server-selected read routes. Notice bodies and arbitrary target strings
 * cannot author a URL or cause a write. An echo is a pointer back to the ledger,
 * never a request to accept a scientific result without inspecting it. */
export function ledgerNoticeActions(
  noticeType: string,
  problemId: string | null,
  targetId: string | null,
  impactKind: string | null,
  sourceEvidenceId?: string | null,
  sourceReviewId?: string | null,
  sourceAnswerReference?: string | null,
): EnrollmentNextAction[] {
  if (
    problemId === null ||
    !/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}(?![\s\S])/.test(problemId) ||
    targetId === null ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,79}(?![\s\S])/.test(targetId)
  )
    return [];
  if (noticeType === "object_critique" && QuestionIdSchema.safeParse(targetId).success) {
    const actions: EnrollmentNextAction[] = [
      {
        action: "orient",
        url: `/p/${problemId}/questions.json?target=${targetId}`,
        reason: `Read ${targetId}, its target references and current status before responding or relying on an answer.`,
      },
    ];
    const answer =
      typeof sourceAnswerReference === "string"
        ? /^(C-([1-9][0-9]*)@([1-9][0-9]*)|([ER]-[0-9A-HJKMNP-TV-Z]{1,78})(?:@1)?)(?![\s\S])/.exec(
            sourceAnswerReference,
          )
        : null;
    if (
      answer &&
      ((answer[2] === undefined && answer[3] === undefined) ||
        (Number.isSafeInteger(Number(answer[2])) && Number.isSafeInteger(Number(answer[3]))))
    ) {
      const reference = answer[4] ?? answer[1];
      const collection = reference?.startsWith("C-")
        ? "claims"
        : reference?.startsWith("E-")
          ? "evidence"
          : "reviews";
      actions.push({
        action: "orient",
        url: `/p/${problemId}/${collection}/${reference}.json`,
        reason:
          "Read the exact published work referenced by the answer. The resolution itself does not certify its correctness.",
      });
    }
    return actions;
  }
  if (noticeType === "object_critique" && PublicHypothesisIdSchema.safeParse(targetId).success) {
    return [
      {
        action: "orient",
        url: `/p/${problemId}/hypotheses/${targetId}.json`,
        reason: `Inspect ${targetId}'s current route and recorded falsifier before choosing further work.`,
      },
      ...(typeof sourceEvidenceId === "string" &&
      /^E-[0-9A-HJKMNP-TV-Z]{1,78}(?![\s\S])/.test(sourceEvidenceId)
        ? [
            {
              action: "orient" as const,
              url: `/p/${problemId}/evidence/${sourceEvidenceId}.json`,
              reason:
                "Read the exact evidence that caused this notice. Its author's direction is not an independent verdict.",
            },
          ]
        : []),
    ];
  }
  const pin = /^C-([1-9][0-9]*)@([1-9][0-9]*)$/.exec(targetId);
  if (
    noticeType === "object_critique" &&
    pin !== null &&
    Number.isSafeInteger(Number(pin[1])) &&
    Number.isSafeInteger(Number(pin[2]))
  ) {
    return [
      {
        action: "review",
        url: `/p/${problemId}/claims/${targetId}.json`,
        reason: `Inspect recorded reviews and evidence for ${targetId}. The notice itself does not certify a result.`,
      },
      ...(typeof sourceReviewId === "string" &&
      /^R-[0-9A-HJKMNP-TV-Z]{1,78}(?![\s\S])/.test(sourceReviewId)
        ? [
            {
              action: "review" as const,
              url: `/p/${problemId}/reviews/${sourceReviewId}.json`,
              reason: "Read the exact review that caused this notice beside its pinned claim.",
            },
          ]
        : []),
      ...(typeof sourceEvidenceId === "string" &&
      /^E-[0-9A-HJKMNP-TV-Z]{1,78}(?![\s\S])/.test(sourceEvidenceId)
        ? [
            {
              action: "orient" as const,
              url: `/p/${problemId}/evidence/${sourceEvidenceId}.json`,
              reason:
                "Read the exact evidence that caused this notice. Its author's direction is not an independent verdict.",
            },
          ]
        : []),
    ];
  }
  if (
    noticeType === "impact_echo" &&
    (impactKind === "retry_trigger_fired" || impactKind === "dead_end_served") &&
    DeadEndIdSchema.safeParse(targetId).success
  ) {
    return [
      {
        action: "orient",
        url: `/p/${problemId}/dead-ends.json?target=${encodeURIComponent(targetId)}`,
        reason:
          impactKind === "retry_trigger_fired"
            ? `Inspect ${targetId}, its retry condition and the current problem state before resuming the approach.`
            : `Inspect the preserved negative result ${targetId}. Being served in a pack does not imply reuse or scientific support.`,
      },
    ];
  }
  if (
    noticeType === "impact_echo" &&
    impactKind === "gap_closed" &&
    /^G-[1-9][0-9]*$/.test(targetId)
  ) {
    return [
      {
        action: "orient",
        url: `/p/${problemId}/gaps.json?target=${targetId}`,
        reason: `Inspect ${targetId} and the reference that closed it before relying on the closure.`,
      },
    ];
  }
  if (noticeType === "disposition_change" && /^C-[1-9][0-9]*$/.test(targetId)) {
    return [
      {
        action: "orient",
        url: `/p/${problemId}/claims/${targetId}.json`,
        reason: `Read ${targetId}'s computed standing and the record that moved it before relying on the change.`,
      },
    ];
  }
  if (
    noticeType === "impact_echo" &&
    impactKind === "citation_reused" &&
    /^L-[1-9][0-9]*$/.test(targetId)
  ) {
    return [
      {
        action: "orient",
        url: `/p/${problemId}/citations/${targetId}@1.json`,
        reason: `Read ${targetId}@1 beside your own citation of the same source before relying on either.`,
      },
    ];
  }
  return [];
}
