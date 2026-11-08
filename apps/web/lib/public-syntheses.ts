import "server-only";

import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import {
  type SingleSynthesisResponse,
  SingleSynthesisResponseSchema,
  SynthesesListQuerySchema,
  type SynthesesListResponse,
  SynthesesListResponseSchema,
  synthesesListMatchesQuery,
  synthesesListPath,
} from "@asimposium/contracts/syntheses";
import { readPublic, type PublicRead } from "./public-ledger";
import { parseSynthesisTarget } from "./synthesis-view";
import { configuredStoaOrigin } from "./stoa";

/** Canonical source budgets are six MiB. Allow its serialized envelope while
 * retaining a hard bound on both advertised and streamed response bodies. */
export const PUBLIC_SYNTHESES_MAX_BYTES = 8 * 1024 * 1024;

function validProblem(problem: string): boolean {
  return typeof problem === "string" && problem.trim() === problem &&
    PublicLedgerProblemIdSchema.safeParse(problem).success;
}

export async function stoaFetchSyntheses(
  problem: string,
  origin = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<SynthesesListResponse>> {
  const parsed = SynthesesListQuerySchema.safeParse(query);
  if (!validProblem(problem) || !parsed.success)
    return { state: "unavailable", reason: "invalid_response" };
  const result = await readPublic(
    synthesesListPath(problem, "json", parsed.data), origin, SynthesesListResponseSchema,
    0, "PROBLEM_NOT_FOUND", "CURSOR_INVALID", PUBLIC_SYNTHESES_MAX_BYTES,
  );
  if (result.state !== "ok") return result;
  return synthesesListMatchesQuery(problem, parsed.data, result.data)
    ? result : { state: "unavailable", reason: "invalid_response" };
}

/** The exact publication is immutable. Freshness and current visibility are
 * read again; an old list response never supplies either on this page. */
export async function stoaFetchSynthesis(
  problem: string,
  target: string,
  origin = configuredStoaOrigin(),
): Promise<PublicRead<SingleSynthesisResponse>> {
  const id = parseSynthesisTarget(target);
  if (!validProblem(problem) || id === null)
    return { state: "unavailable", reason: "invalid_response" };
  const result = await readPublic(
    `/p/${encodeURIComponent(problem)}/syntheses/${encodeURIComponent(target)}.json`,
    origin, SingleSynthesisResponseSchema, 0, "PROBLEM_NOT_FOUND", undefined,
    PUBLIC_SYNTHESES_MAX_BYTES,
  );
  if (result.state !== "ok") return result;
  const { synthesis, staleness } = result.data;
  if (synthesis.problem_id !== problem || synthesis.synthesis_id !== id ||
      !Number.isSafeInteger(synthesis.seq) || !Number.isSafeInteger(synthesis.covers_through) ||
      synthesis.covers_through >= synthesis.seq ||
      !Number.isSafeInteger(staleness.material_events_since) ||
      staleness.stale !== (staleness.material_events_since > 0) ||
      synthesis.anchors.some((anchor) =>
        (anchor.target_seq !== undefined && (!Number.isSafeInteger(anchor.target_seq) ||
          anchor.target_seq > synthesis.covers_through)) ||
        (anchor.target_version !== undefined && !Number.isSafeInteger(anchor.target_version))))
    return { state: "unavailable", reason: "invalid_response" };
  return result;
}
