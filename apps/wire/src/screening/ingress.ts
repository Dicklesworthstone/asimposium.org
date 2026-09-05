import {
  type ScreeningPublicationProvenance,
  ScreeningPublicationProvenanceSchema,
} from "@asimposium/contracts";
import type { Env } from "../env";
import {
  type PublicationScreeningObservation,
  promotionScreeningBinding,
  type WorkersAIPromotionInput,
} from "./workers-ai";

export interface ScreenedPublication {
  readonly problemId: string;
  readonly fellowId: string;
  readonly provenance: ScreeningPublicationProvenance;
}

/** Called before Krater. No body, raw model output or private pattern survives. */
export async function publicationProvenance(
  input: WorkersAIPromotionInput,
  observation: PublicationScreeningObservation,
): Promise<ScreenedPublication> {
  const binding = await promotionScreeningBinding(input);
  if (
    observation.evaluated_body_digest !== binding.bodyDigest ||
    observation.evaluated_context_digest !== binding.contextDigest ||
    observation.status_code !== "SCREENED"
  ) {
    throw new TypeError("Screening attestation does not match the publication candidate.");
  }
  const provenance = ScreeningPublicationProvenanceSchema.parse({
    version: "ledger-publication-screening.v1",
    scope: "candidate-and-actor-only",
    principal: "platform:symposiarch",
    input_digest: binding.bodyDigest.slice(7),
    context_digest: binding.contextDigest.slice(7),
    model_version: observation.model_version,
    policy_version: observation.policy_version,
    configuration_digest: observation.configuration_digest.startsWith("sha256:")
      ? observation.configuration_digest.slice(7)
      : observation.configuration_digest,
    decided_at: new Date().toISOString(),
    latency_ms: observation.latency_ms,
    retry_count: observation.retry_count,
    outcome: observation.decision,
    provider_status: observation.provider_status,
    decision_path: observation.decision_path,
    public_action: { category: observation.coarse_category, action: "published", notice: "none" },
  });
  return Object.freeze({ problemId: input.problemId, fellowId: input.fellowId, provenance });
}

/**
 * In the same D1 batch as the event and replay election. A missing/mismatched
 * event produces NULL and aborts the batch, rather than silently omitting the
 * evidence. Retry losers roll this row back with their event.
 */
export function screeningPublicationStatement(
  db: Env["DB"],
  screened: ScreenedPublication,
  eventId: string,
  sessionId: string,
  requestDigest: string,
) {
  return db
    .prepare(
      `INSERT INTO screening_publications (event_id, request_digest, provenance_json)
     VALUES ((SELECT id FROM events WHERE id = ? AND problem_id = ?
       AND actor_fellow_id = ? AND actor_session_id = ?), ?, ?)`,
    )
    .bind(
      eventId,
      screened.problemId,
      screened.fellowId,
      sessionId,
      requestDigest,
      JSON.stringify(screened.provenance),
    );
}
