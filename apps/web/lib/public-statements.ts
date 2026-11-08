import "server-only";

import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import {
  StatementHistoryQuerySchema,
  type StatementHistoryResponse,
  StatementHistoryResponseSchema,
  type StatementResponse,
  StatementResponseSchema,
  StatementVersionQuerySchema,
  StatementVersionSelectorSchema,
  statementHistoryMatchesQuery,
  statementHistoryPath,
  statementVersionMatchesQuery,
  statementVersionPath,
} from "@asimposium/contracts/statements";
import { type PublicRead, readPublic } from "./public-ledger";
import { configuredStoaOrigin } from "./stoa";

/** Read the complete published formulations at one public cut. Current
 * visibility still wins over historical cursors, so no persistent cache is used. */
export async function stoaFetchStatementHistory(
  problemId: string,
  origin: string | undefined = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<StatementHistoryResponse>> {
  const parsed = StatementHistoryQuerySchema.safeParse(query);
  if (!PublicLedgerProblemIdSchema.safeParse(problemId).success || !parsed.success)
    return { state: "unavailable", reason: "invalid_response" };
  const result = await readPublic(
    statementHistoryPath(problemId, "json", parsed.data),
    origin,
    StatementHistoryResponseSchema,
    0,
    "PROBLEM_NOT_FOUND",
  );
  if (result.state !== "ok") return result;
  return statementHistoryMatchesQuery(problemId, parsed.data, result.data)
    ? result
    : { state: "unavailable", reason: "invalid_response" };
}

/** Exact lookup never substitutes the current statement or a neighboring
 * version when an old publication is unavailable or was never public. */
export async function stoaFetchStatementVersion(
  problemId: string,
  version: string,
  origin: string | undefined = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<StatementResponse>> {
  const parsedVersion = StatementVersionSelectorSchema.safeParse(version);
  const parsedQuery = StatementVersionQuerySchema.safeParse(query);
  if (
    !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
    !parsedVersion.success ||
    !parsedQuery.success
  )
    return { state: "unavailable", reason: "invalid_response" };
  const result = await readPublic(
    statementVersionPath(problemId, parsedVersion.data, "json", parsedQuery.data),
    origin,
    StatementResponseSchema,
    0,
    "PROBLEM_NOT_FOUND",
  );
  if (result.state !== "ok") return result;
  return statementVersionMatchesQuery(problemId, parsedVersion.data, parsedQuery.data, result.data)
    ? result
    : { state: "unavailable", reason: "invalid_response" };
}
