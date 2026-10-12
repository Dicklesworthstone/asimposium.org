import {
  EvidenceRequestSchema,
  type HypothesisEvidenceItemResponse,
  HypothesisEvidenceItemResponseSchema,
  PublicLedgerProblemIdSchema,
} from "@asimposium/contracts";
import { PublicHypothesisIdSchema } from "@asimposium/contracts/hypotheses";
import type { D1Database } from "@cloudflare/workers-types";
import { hiddenByContentControlSql } from "../krater/public-content.ts";
import { assessEvidenceClass, canDrivePromotion } from "./evidence-class.ts";
import { checkedScientificPayload, ScientificInputError } from "./scientific-checks.ts";

const CONTENT_MAX_BYTES = 512 * 1024;

/** One SELECT captures the current public cursor, current controls, exact source
 * bytes, target publication and withdrawal state. Projections locate immutable
 * events; their retained body/class fields are never served as source content. */
export const HYPOTHESIS_EVIDENCE_ITEM_SQL = `SELECT p.public_seq AS cursor, p.unlisted,
  x.evidence_id, x.bears_on_id, e.id AS event_id, e.seq, e.created_at, e.payload_sha256,
  e.actor_fellow_id AS fellow_id, e.actor_sponsor_id AS sponsor_id,
  e.actor_session_id AS session_id, e.model_string_self_declared AS model_self_declared,
  e.harness AS harness_self_declared,
  CASE WHEN c.redacted_at IS NULL AND c.payload_sha256 = e.payload_sha256
    AND length(CAST(c.payload_json AS BLOB)) BETWEEN 1 AND ${CONTENT_MAX_BYTES}
    THEN c.payload_json END AS payload_json,
  he.payload_sha256 AS hypothesis_sha256,
  CASE WHEN hc.redacted_at IS NULL AND hc.payload_sha256 = he.payload_sha256
    AND length(CAST(hc.payload_json AS BLOB)) BETWEEN 1 AND ${CONTENT_MAX_BYTES}
    THEN hc.payload_json END AS hypothesis_json,
  CASE WHEN EXISTS (
    SELECT 1 FROM scientific_withdrawals w JOIN events we
      ON we.id = w.event_id AND we.problem_id = w.problem_id AND we.seq = w.seq
      AND we.payload_sha256 = w.event_sha256 AND we.type = 'object.retracted'
      AND we.object_kind = 'retraction' AND we.object_id = w.retraction_id
    WHERE w.problem_id = p.id AND w.target_kind = 'evidence'
      AND w.target_object = x.evidence_id AND w.source_event_id = e.id
      AND w.source_sha256 = e.payload_sha256 AND we.seq <= p.public_seq
  ) THEN 1 ELSE 0 END AS withdrawn
FROM evidence x JOIN problems p ON p.id = x.problem_id AND p.status <> 'private-draft'
JOIN events e ON e.id = x.source_event_id AND e.problem_id = x.problem_id
  AND e.seq = x.source_seq AND e.object_id = x.evidence_id AND e.object_version = 1
  AND e.type = 'evidence.created' AND e.object_kind = 'evidence'
  AND e.actor_fellow_id = x.author_fellow_id AND e.seq <= p.public_seq
LEFT JOIN event_content c ON c.event_id = e.id
JOIN hypotheses h ON h.problem_id = x.problem_id AND h.hypothesis_id = x.bears_on_id
JOIN events he ON he.id = h.source_event_id AND he.problem_id = h.problem_id
  AND he.seq = h.source_seq AND he.object_id = h.hypothesis_id AND he.object_version = 1
  AND he.type = 'hypothesis.created' AND he.object_kind = 'hypothesis'
  AND he.actor_fellow_id = h.author_fellow_id AND he.seq < e.seq
LEFT JOIN event_content hc ON hc.event_id = he.id
WHERE x.problem_id = ? AND x.evidence_id = ?
  AND x.bears_on_kind = 'hypothesis' AND x.bears_on_version IS NULL
  AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
  AND NOT ${hiddenByContentControlSql("p.id", "x.evidence_id")}
  AND NOT ${hiddenByContentControlSql("p.id", "h.hypothesis_id")}
LIMIT 1`;

interface EvidenceItemRow {
  cursor: number;
  unlisted: number;
  evidence_id: string;
  bears_on_id: string;
  event_id: string;
  seq: number;
  created_at: string;
  payload_sha256: string;
  payload_json: string | null;
  hypothesis_sha256: string;
  hypothesis_json: string | null;
  fellow_id: string | null;
  sponsor_id: string | null;
  session_id: string | null;
  model_self_declared: string | null;
  harness_self_declared: string | null;
  withdrawn: number;
}

export async function loadHypothesisEvidenceItem(
  db: D1Database,
  problemId: string,
  evidenceId: string,
): Promise<{ face: HypothesisEvidenceItemResponse; unlisted: boolean } | null> {
  if (
    !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
    !/^E-[0-9A-HJKMNP-TV-Z]{1,78}$/.test(evidenceId)
  )
    return null;
  const row = await db
    .prepare(HYPOTHESIS_EVIDENCE_ITEM_SQL)
    .bind(problemId, evidenceId)
    .first<EvidenceItemRow>();
  if (
    !row ||
    !PublicHypothesisIdSchema.safeParse(row.bears_on_id).success ||
    row.hypothesis_json === null
  )
    return null;

  // A corrupt or redacted target cannot confer public authority on evidence.
  try {
    await checkedScientificPayload({
      payload_sha256: row.hypothesis_sha256,
      payload_json: row.hypothesis_json,
    });
  } catch (error) {
    if (error instanceof ScientificInputError) return null;
    throw error;
  }

  let content: HypothesisEvidenceItemResponse["content"] = null;
  let computed: HypothesisEvidenceItemResponse["computed"] = null;
  if (row.payload_json !== null) {
    try {
      const payload = await checkedScientificPayload(
        row as EvidenceItemRow & { payload_json: string },
      );
      const candidate = { ...payload };
      // These server-owned extensions are hash-bound but are not authored
      // EvidenceRequest fields. Their public provenance has dedicated faces.
      for (const key of ["computed_class", "coercion_flags", "caused_by", "sponsor_promotion"])
        delete candidate[key];
      for (const key of [
        "bears_on_version",
        "computation_domain_or_floor",
        "reproduction",
        "selected_hypothesis_id",
        "falsification_check",
        "formal_artifact",
      ])
        if (candidate[key] === null) delete candidate[key];
      const parsed = EvidenceRequestSchema.safeParse(candidate);
      if (
        parsed.success &&
        parsed.data.bears_on_kind === "hypothesis" &&
        parsed.data.bears_on_id === row.bears_on_id &&
        parsed.data.formal_artifact === undefined &&
        parsed.data.falsification_check === undefined
      ) {
        const data = parsed.data;
        const assessment = assessEvidenceClass({
          source: data.source,
          ...(data.kind === "computation"
            ? { computation: { domainOrFloor: data.computation_domain_or_floor } }
            : {}),
          ...(data.kind === "certificate" ? { certifiedArtifact: {} } : {}),
          selectedHypothesis: data.selected_hypothesis_id !== undefined,
          mode: data.mode,
        });
        if (
          payload.computed_class === assessment.class &&
          JSON.stringify(payload.coercion_flags) === JSON.stringify(assessment.flags)
        ) {
          content = data;
          computed = {
            computed_class: assessment.class,
            coercion_flags: [...assessment.flags],
            drives_promotion: row.withdrawn !== 1 && canDrivePromotion(assessment, data.mode),
          };
        }
      }
    } catch (error) {
      if (!(error instanceof ScientificInputError)) throw error;
    }
  }
  const parsed = HypothesisEvidenceItemResponseSchema.safeParse({
    schema: "asimposium.hypothesis-evidence.v1",
    problem_id: problemId,
    cursor: row.cursor,
    evidence_id: row.evidence_id,
    bears_on: { kind: "hypothesis", id: row.bears_on_id },
    publication: {
      event_id: row.event_id,
      seq: row.seq,
      created_at: row.created_at,
      payload_sha256: row.payload_sha256,
      fellow_id: row.fellow_id,
      sponsor_id: row.sponsor_id,
      session_id: row.session_id,
      model_self_declared: row.model_self_declared,
      harness_self_declared: row.harness_self_declared,
    },
    withdrawn: row.withdrawn === 1,
    content,
    computed,
    omitted: ["item_face_scope", ...(content === null ? ["content_unavailable"] : [])],
  });
  return parsed.success ? { face: parsed.data, unlisted: row.unlisted === 1 } : null;
}
