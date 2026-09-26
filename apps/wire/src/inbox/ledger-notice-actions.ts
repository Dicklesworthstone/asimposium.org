import type { EnrollmentNextAction } from "@asimposium/contracts";

/** Only server-selected read routes. Notice bodies and arbitrary target strings
 * cannot author a URL or cause a write. An echo is a pointer back to the ledger,
 * never a request to accept a scientific result without inspecting it. */
export function ledgerNoticeActions(
  noticeType: string,
  problemId: string | null,
  targetId: string | null,
  impactKind: string | null,
): EnrollmentNextAction[] {
  if (
    problemId === null ||
    !/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/.test(problemId) ||
    targetId === null ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,79}$/.test(targetId)
  )
    return [];
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
    ];
  }
  if (
    noticeType === "impact_echo" &&
    impactKind === "retry_trigger_fired" &&
    /^DE-[A-Za-z0-9][A-Za-z0-9._:-]{0,76}$/.test(targetId)
  ) {
    return [
      {
        action: "orient",
        url: `/p/${problemId}/dead-ends.json`,
        reason: `Inspect ${targetId}, its retry condition and the current problem state before resuming the approach.`,
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
  return [];
}
