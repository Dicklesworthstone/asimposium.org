import { validatedProblem } from "../http/envelope.ts";

/** Classify only the fixed transaction guard, without disclosing database
 * messages or confusing an uncertain write with a confirmed refusal. */
export function isArchivedProblemWriteError(error: unknown): boolean {
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth++) {
    if (typeof error !== "object" || error === null || seen.has(error)) return false;
    seen.add(error);
    try {
      const value = error as { message?: unknown; cause?: unknown };
      if (
        typeof value.message === "string" &&
        value.message.length <= 4096 &&
        /(?:^|[^A-Z0-9_])PROBLEM_ARCHIVED_READ_ONLY(?:$|[^A-Z0-9_])/.test(value.message)
      )
        return true;
      error = value.cause;
    } catch {
      return false;
    }
  }
  return false;
}

export function archivedProblemWriteProblem(): Response {
  return validatedProblem({
    status: 403,
    code: "WRITE_REFUSED",
    title: "The problem is read-only",
    detail: "The current problem admission mode does not accept new scientific publications.",
    fixHint:
      "Read the current problem access settings or contact a steward. Reuse the same Idempotency-Key to retrieve an already accepted receipt.",
    headers: { "cache-control": "private, no-store" },
  });
}
