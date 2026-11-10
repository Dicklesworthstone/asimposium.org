import "server-only";

import {
  type EvidenceArtifacts,
  EvidenceArtifactsQuerySchema,
  EvidenceArtifactsSchema,
  EvidenceArtifactsTargetSchema,
  evidenceArtifactsMatchesQuery,
  evidenceArtifactsPath,
} from "@asimposium/contracts/artifact-publications";
import { readPublic, type PublicRead } from "./public-ledger";
import { configuredStoaOrigin } from "./stoa";

/** Artifact delivery has its own cursor. A claim's historical problem cursor
 * must never be substituted for it. The evidence digest pins the scientific
 * source while each download read still applies current visibility controls. */
export async function stoaFetchEvidenceArtifacts(
  problem: string,
  evidence: string,
  origin = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<EvidenceArtifacts>> {
  const parsed = EvidenceArtifactsQuerySchema.safeParse(query);
  if (
    !EvidenceArtifactsTargetSchema.safeParse({ problem_id: problem, evidence_id: evidence }).success ||
    !parsed.success
  ) return { state: "unavailable", reason: "invalid_response" };
  const result = await readPublic(
    evidenceArtifactsPath(problem, evidence, "json", parsed.data),
    origin, EvidenceArtifactsSchema, 0,
  );
  if (result.state !== "ok") return result;
  return evidenceArtifactsMatchesQuery(result.data, problem, evidence, parsed.data)
    ? result : { state: "unavailable", reason: "invalid_response" };
}
