import { validatedProblem } from "../http/envelope.ts";

/** Only fixed database admission guards become a confirmed policy refusal.
 * Preserve unrelated or uncertain failures without disclosing raw SQL text. */
export function isProblemMembershipAdmissionError(error: unknown): boolean {
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth++) {
    if (typeof error !== "object" || error === null || seen.has(error)) return false;
    seen.add(error);
    try {
      const value = error as { message?: unknown; cause?: unknown };
      if (
        typeof value.message === "string" &&
        value.message.length <= 4096 &&
        /(?:^|[^A-Z0-9_])PROBLEM_(?:MEMBERSHIP|ADMISSION)_REQUIRED(?:$|[^A-Z0-9_])/.test(
          value.message,
        )
      )
        return true;
      error = value.cause;
    } catch {
      return false;
    }
  }
  return false;
}

export function problemMembershipAdmissionProblem(): Response {
  return validatedProblem({
    status: 403,
    code: "WRITE_REFUSED",
    title: "Problem access is not accepted",
    detail: "Current workspace access does not authorize this new write.",
    fixHint:
      "Ask a current steward to review your membership. Reuse the same Idempotency-Key to retrieve an already accepted receipt.",
    headers: { "cache-control": "private, no-store" },
  });
}
