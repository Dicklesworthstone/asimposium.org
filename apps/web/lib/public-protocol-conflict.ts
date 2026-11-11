import "server-only";

import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import {
  ProtocolConflictIdSchema,
  type ProtocolConflictRecord,
  ProtocolConflictRecordSchema,
} from "@asimposium/contracts/directives";
import { type PublicRead, readPublic } from "./public-ledger";
import { configuredStoaOrigin } from "./stoa";

export function publicProtocolConflictTarget(problemId: unknown, conflictId: unknown) {
  if (
    typeof problemId !== "string" ||
    typeof conflictId !== "string" ||
    !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
    !ProtocolConflictIdSchema.safeParse(conflictId).success ||
    /^PC-[a-f0-9]{32}$/.exec(conflictId)?.[0] !== conflictId
  )
    return null;
  const humanPath = `/p/${encodeURIComponent(problemId)}/protocol-conflicts/${conflictId}`;
  return {
    problemId,
    conflictId,
    humanPath,
    jsonPath: `${humanPath}.json`,
    markdownPath: `${humanPath}.md`,
  };
}

/** Public bytes are fetched without human credentials on every render.
 * A schema-valid but unrelated refusal cannot be substituted for this URL. */
export async function stoaFetchPublicProtocolConflict(
  problemId: string,
  conflictId: string,
  origin: string | undefined = configuredStoaOrigin(),
): Promise<PublicRead<ProtocolConflictRecord>> {
  const target = publicProtocolConflictTarget(problemId, conflictId);
  if (target === null) return { state: "unavailable", reason: "invalid_response" };
  const result = await readPublic(
    target.jsonPath,
    origin,
    ProtocolConflictRecordSchema,
    0,
    "PROBLEM_NOT_FOUND",
    undefined,
    32768,
  );
  if (result.state !== "ok") return result;
  return result.data.problem_id === target.problemId &&
    result.data.conflict_id === target.conflictId
    ? result
    : { state: "unavailable", reason: "invalid_response" };
}
