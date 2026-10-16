/** Only the fixed database invariant marker is classified. Never return/log
 * the database error, which may contain SQL or restricted source details. */
export function isHypothesisKillSourceError(error: unknown): boolean {
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth++) {
    if (typeof error !== "object" || error === null || seen.has(error)) return false;
    seen.add(error);
    try {
      const value = error as { message?: unknown; cause?: unknown };
      if (
        typeof value.message === "string" && value.message.length <= 4096 &&
        /(?:^|[^A-Z0-9_])HYPOTHESIS_KILL_SOURCE_INVALID(?:$|[^A-Z0-9_])/.test(value.message)
      ) return true;
      error = value.cause;
    } catch { return false; }
  }
  return false;
}

/** Map only the final uncaught database abort, after the original writer has
 * attempted replay recovery. Never infer an abort from response bytes, an
 * earlier retry failure, or a new preflight read. A recovered success and an
 * uncertain transport/storage failure keep their original response intact. */
export function hypothesisKillAdmissionResponse(
  error: unknown,
  response: Response,
  refusal: () => Response,
): Response {
  return response.status >= 500 && isHypothesisKillSourceError(error) ? refusal() : response;
}
