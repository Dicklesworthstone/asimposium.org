import "server-only";

import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import {
  type ConflictsListQuery,
  ConflictsListQuerySchema,
  type ConflictsListResponse,
  ConflictsListResponseSchema,
  conflictsListMatchesQuery,
  conflictsListPath,
} from "@asimposium/contracts/conflicts";
import { type PublicRead, readPublic } from "./public-ledger";
import { configuredStoaOrigin } from "./stoa";

export const CONFLICTS_PAGE_SIZE = 8;
const MAX_CONFLICT_RESPONSE_BYTES = 8 * 1024 * 1024;

export function parseConflictViewQuery(value: unknown): ConflictsListQuery | null {
  const parsed = ConflictsListQuerySchema.safeParse(value);
  return parsed.success ? { ...parsed.data, limit: parsed.data.limit ?? CONFLICTS_PAGE_SIZE } : null;
}

/** Current content controls apply even to an old ledger cut. Keep this read
 * uncached and bind every returned page to the requested problem and snapshot. */
export async function stoaFetchConflicts(
  problem: string,
  origin = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<ConflictsListResponse>> {
  const parsed = parseConflictViewQuery(query);
  if (
    typeof problem !== "string" || problem.trim() !== problem ||
    !PublicLedgerProblemIdSchema.safeParse(problem).success || parsed === null
  ) return { state: "unavailable", reason: "invalid_response" };
  const result = await readPublic(
    conflictsListPath(problem, "json", parsed), origin, ConflictsListResponseSchema,
    0, "CONFLICT_NOT_FOUND", "CURSOR_INVALID", MAX_CONFLICT_RESPONSE_BYTES,
  );
  if (result.state !== "ok") return result;
  return conflictsListMatchesQuery(problem, parsed, result.data)
    ? result : { state: "unavailable", reason: "invalid_response" };
}
