import "server-only";

import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import {
  INTEGRITY_CASE_MAX_RESPONSE_BYTES,
  PublicIntegrityNoticesResponseSchema,
  type PublicIntegrityNoticesResponse,
} from "@asimposium/contracts/integrity-cases";
import { type PublicRead, readPublic } from "./public-ledger";
import { configuredStoaOrigin } from "./stoa";
import {
  integrityNoticesMatchQuery,
  integrityNoticesPath,
  parseIntegrityNoticesQuery,
} from "./integrity-view";

/** Current visibility is checked on every read; private case fields fail the public schema. */
export async function stoaFetchIntegrityNotices(
  problem: string,
  origin = configuredStoaOrigin(),
  query: Readonly<Record<string, string | string[] | undefined>> = {},
): Promise<PublicRead<PublicIntegrityNoticesResponse>> {
  const parsed = parseIntegrityNoticesQuery(query);
  if (parsed === null || !PublicLedgerProblemIdSchema.safeParse(problem).success)
    return { state: "unavailable", reason: "invalid_response" };
  const result = await readPublic(
    integrityNoticesPath(problem, "json", parsed.after), origin,
    PublicIntegrityNoticesResponseSchema, 0, "PROBLEM_NOT_FOUND", undefined,
    INTEGRITY_CASE_MAX_RESPONSE_BYTES,
  );
  if (result.state !== "ok") return result;
  return integrityNoticesMatchQuery(problem, parsed.after, result.data)
    ? result : { state: "unavailable", reason: "invalid_response" };
}
