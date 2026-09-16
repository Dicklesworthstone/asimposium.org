/** Only a typed private invitation ID and canonical problem ID can make an
 * inbox action. Never derive a destination from a notice title or detail. */
export function reviewInvitationLink(problemId: string | null | undefined, targetId: string | null | undefined): string | null {
  if (typeof problemId !== "string" || typeof targetId !== "string" ||
      !/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/.test(problemId) ||
      !/^RR-[0-9a-f]{32}$/.test(targetId)) return null;
  return `/v1/p/${problemId}/review-requests/${targetId}`;
}
