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
  /** A pending hold of exactly these bytes that this publication makes moot.
   * It is superseded only in the batch that writes the event, never before:
   * a write that then fails leaves the hold pending (asimposiumorg-qi6t). */
  readonly supersedeInputDigest?: string;
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
 * A trained reviewer released a held candidate (Fable §9.1, §7.7). The
 * provenance binds the release to the exact bytes the original screen saw and
 * keeps that screen's model/policy identity; it never manufactures a model
 * pass that did not happen.
 */
export async function releasedPublicationProvenance(
  input: WorkersAIPromotionInput,
  released: {
    readonly caseId: string;
    readonly inputDigest: string;
    readonly contextDigest: string;
    readonly modelVersion: string;
    readonly policyVersion: string;
    readonly configurationDigest: string;
  },
): Promise<ScreenedPublication> {
  const binding = await promotionScreeningBinding(input);
  if (
    binding.bodyDigest.slice(7) !== released.inputDigest ||
    binding.contextDigest.slice(7) !== released.contextDigest
  ) {
    throw new TypeError("The released case does not bind this publication candidate.");
  }
  const provenance = ScreeningPublicationProvenanceSchema.parse({
    version: "ledger-publication-screening.v1",
    scope: "candidate-and-actor-only",
    principal: "platform:symposiarch",
    input_digest: released.inputDigest,
    context_digest: released.contextDigest,
    model_version: released.modelVersion,
    policy_version: released.policyVersion,
    configuration_digest: released.configurationDigest,
    decided_at: new Date().toISOString(),
    latency_ms: 0,
    retry_count: 0,
    outcome: "pass",
    provider_status: "ok",
    decision_path: "operator-release",
    review_case_id: released.caseId,
    public_action: { category: "benign-context", action: "published", notice: "none" },
  });
  return Object.freeze({ problemId: input.problemId, fellowId: input.fellowId, provenance });
}

/**
 * In the same D1 batch as the event and replay election. An event written
 * with a mismatched actor produces NULL and aborts the batch, rather than
 * silently omitting the evidence. When the event was not written at all (a
 * refused precondition or a lost head race), nothing was published and no row
 * is inserted, so the batch commits nothing and the writer reports the
 * refusal or retries (rg73) instead of failing on the NULL.
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
     SELECT (SELECT id FROM events WHERE id = ? AND problem_id = ?
       AND actor_fellow_id = ? AND actor_session_id = ?), ?, ?
      WHERE EXISTS (SELECT 1 FROM events WHERE id = ?)`,
    )
    .bind(
      eventId,
      screened.problemId,
      screened.fellowId,
      sessionId,
      requestDigest,
      JSON.stringify(screened.provenance),
      eventId,
    );
}

/** The provenance row plus, when this publication makes a pending hold of
 * the same bytes moot, the guarded supersede of that case. Both are no-ops
 * unless the event exists, so they commit with the publication or not at all. */
export function screeningPublicationStatements(
  db: Env["DB"],
  screened: ScreenedPublication,
  eventId: string,
  sessionId: string,
  requestDigest: string,
) {
  const statements = [
    screeningPublicationStatement(db, screened, eventId, sessionId, requestDigest),
  ];
  if (screened.supersedeInputDigest !== undefined) {
    statements.push(supersedeHeldCaseStatement(db, screened, eventId));
  }
  return statements;
}

export function supersedeHeldCaseStatement(
  db: Env["DB"],
  screened: ScreenedPublication,
  eventId: string,
) {
  return db
    .prepare(
      `UPDATE screening_cases
          SET state = 'superseded', decided_at = ?, decided_by = 'platform:symposiarch',
              decision_reason = 'A later screen of the same bytes passed and was published.'
        WHERE fellow_id = ? AND problem_id = ? AND input_digest = ? AND state = 'pending'
          AND EXISTS (SELECT 1 FROM events WHERE id = ?)`,
    )
    .bind(
      new Date().toISOString(),
      screened.fellowId,
      screened.problemId,
      screened.supersedeInputDigest ?? "",
      eventId,
    );
}
