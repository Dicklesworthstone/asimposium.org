import {
  GroundedFalsificationCheckSchema,
  ScientificVerificationSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { sha256Hex } from "../krater/krater.ts";
import {
  type CurrentClaimDispositionFold,
  computeCurrentClaimDisposition,
  type VersionedClaimTimelineEvent,
} from "./disposition-read.ts";
import {
  assessScientificVerification,
  inspectFormalArtifact,
  readScientificProvenance,
  SCIENTIFIC_INDEPENDENCE_POLICY,
  type ScientificClaim,
  type ScientificEvidence,
  ScientificInputError,
} from "./scientific-checks.ts";

interface ScientificRow {
  claim_id: string;
  event_id: string;
  seq: number;
  type: string;
  object_id: string;
  object_version: number;
  target_version: number;
  payload_sha256: string;
  payload_json: string | null;
  fellow_id: string;
  sponsor_id: string;
  content_digest: string | null;
  statement: string | null;
  direction: string | null;
  weighted_refutation?: number;
}

export type ScientificDisposition = CurrentClaimDispositionFold & {
  stale: boolean;
  legacyReviews: number;
};

/** One bounded claim selection and one ledger query for every status-bearing
 * working pack. Referenced evidence is resolved against this same cursor cut;
 * no per-review database lookup or author workshop read is needed. */
export async function readScientificDispositions(
  db: D1Database,
  problemId: string,
  cursor: number,
  claimLimit: number,
): Promise<Map<string, ScientificDisposition>> {
  const result = await db
    .prepare(`
    WITH selected_claims AS (
      SELECT id FROM claims WHERE problem_id = ? AND source_seq <= ? ORDER BY source_seq ASC LIMIT ?
    )
    SELECT s.id AS claim_id, e.id AS event_id, e.seq, e.type, e.object_id, e.object_version,
      CASE WHEN e.object_kind = 'claim' THEN e.object_version
        WHEN e.object_kind = 'review' THEN r.target_version ELSE x.bears_on_version END AS target_version,
      e.payload_sha256, c.payload_json, e.actor_fellow_id AS fellow_id,
      e.actor_sponsor_id AS sponsor_id, v.content_digest, v.statement, x.direction,
      CASE WHEN r.verdict IN ('refute', 'fails-to-reproduce')
        AND length(trim(coalesce(r.capable_of_failure, ''))) > 0 THEN 1 ELSE 0 END AS weighted_refutation
    FROM events e
    LEFT JOIN reviews r ON r.source_event_id = e.id AND r.problem_id = e.problem_id
      AND r.review_id = e.object_id AND r.source_seq = e.seq AND e.type = 'review.created'
    LEFT JOIN evidence x ON x.source_event_id = e.id AND x.problem_id = e.problem_id
      AND x.evidence_id = e.object_id AND x.source_seq = e.seq
      AND x.bears_on_kind = 'claim' AND e.type = 'evidence.created'
    JOIN selected_claims s ON s.id = CASE WHEN e.object_kind = 'claim' THEN e.object_id
      WHEN e.object_kind = 'review' THEN r.target_claim_id ELSE x.bears_on_id END
    LEFT JOIN claim_versions v ON v.problem_id = e.problem_id AND v.claim_id = s.id
      AND v.version = e.object_version AND e.object_kind = 'claim'
    LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      AND c.redacted_at IS NULL
    WHERE e.problem_id = ? AND e.seq <= ?
      AND e.type IN ('claim.created', 'claim.revised', 'review.created', 'evidence.created')
    ORDER BY e.seq ASC
  `)
    .bind(problemId, cursor, claimLimit, problemId, cursor)
    .all<ScientificRow>();
  const groups = new Map<string, ScientificRow[]>();
  for (const row of result.results) {
    const rows = groups.get(row.claim_id) ?? [];
    rows.push(row);
    groups.set(row.claim_id, rows);
  }
  const output = new Map<string, ScientificDisposition>();
  for (const [claimId, rows] of groups) output.set(claimId, await foldScientificRows(rows));
  return output;
}

export async function foldScientificRows(
  rows: readonly ScientificRow[],
): Promise<ScientificDisposition> {
  const contents = new Map<string, Record<string, unknown>>();
  const claims = new Map<number, ScientificClaim>();
  const evidence = new Map<string, ScientificEvidence & { sequence: number }>();
  let stale = false;
  let legacyReviews = 0;
  const head = rows
    .filter((row) => row.type === "claim.created" || row.type === "claim.revised")
    .at(-1)?.object_version;
  const markStale = (row: ScientificRow): void => {
    if (row.target_version === head) stale = true;
  };
  const timeline: VersionedClaimTimelineEvent[] = [];
  for (const row of rows) {
    if (row.payload_json === null || (await sha256Hex(row.payload_json)) !== row.payload_sha256) {
      markStale(row);
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(row.payload_json);
    } catch {
      markStale(row);
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      markStale(row);
      continue;
    }
    const payload = value as Record<string, unknown>;
    contents.set(row.event_id, payload);
    if (row.type === "claim.created" || row.type === "claim.revised") {
      if (row.content_digest === null || row.statement === null) continue;
      claims.set(row.object_version, {
        eventId: row.event_id,
        payloadDigest: row.payload_sha256,
        claimId: row.claim_id,
        version: row.object_version,
        contentDigest: row.content_digest,
        statement: row.statement,
        fellowId: row.fellow_id,
        sponsorId: row.sponsor_id,
        provenance: readScientificProvenance(payload.scientific_provenance),
      });
    }
    if (
      row.type === "evidence.created" &&
      typeof payload.kind === "string" &&
      typeof payload.direction === "string" &&
      typeof payload.body_md === "string"
    ) {
      evidence.set(row.object_id, {
        eventId: row.event_id,
        payloadDigest: row.payload_sha256,
        evidenceId: row.object_id,
        fellowId: row.fellow_id,
        sponsorId: row.sponsor_id,
        kind: payload.kind,
        direction: payload.direction,
        body: payload.body_md,
        payload,
        sequence: row.seq,
      });
    }
  }
  const resolve = (reference: { evidence_id: string; digest: string }, row: ScientificRow) => {
    const item = evidence.get(reference.evidence_id);
    return item &&
      item.sequence < row.seq &&
      reference.digest === `sha256:${item.payloadDigest}` &&
      item.payload.bears_on_id === row.claim_id &&
      item.payload.bears_on_kind === "claim" &&
      item.payload.bears_on_version === row.target_version &&
      item.payload.mode === "confirmatory" &&
      item.payload.computed_class !== "assertion" &&
      item.payload.computed_class !== "heuristic" &&
      item.payload.selected_hypothesis_id == null
      ? item
      : undefined;
  };
  for (const row of rows) {
    const payload = contents.get(row.event_id);
    if (row.type === "claim.created" || row.type === "claim.revised") {
      timeline.push({
        kind: row.type === "claim.created" ? "claim-created" : "claim-revised",
        sequence: row.seq,
        version: row.object_version,
      });
      continue;
    }
    // Retain a known refutation as disputed when its body is redacted. Missing
    // counterevidence is not an independent resolution; expose staleness.
    if (
      row.type === "evidence.created" &&
      (row.direction === "refutes" || row.direction === "fails-to-reproduce")
    ) {
      timeline.push({
        kind: "refuting-evidence",
        sequence: row.seq,
        targetVersion: row.target_version,
        evidenceId: row.object_id,
      });
      continue;
    }
    const claim = claims.get(row.target_version);
    if (row.type === "review.created" && row.weighted_refutation === 1 && (!payload || !claim)) {
      // Unavailable counterevidence does not constitute a recorded resolution.
      // Keep the contest visible without republishing the withdrawn body.
      timeline.push({
        kind: "review-created",
        sequence: row.seq,
        targetVersion: row.target_version,
        carriesWeight: true,
        verdict: "refute",
        review: {
          review_id: row.object_id,
          reviewer_id: row.fellow_id,
          tier: "T0",
          cross_family: false,
          full_write_up: false,
        },
      });
      continue;
    }
    if (!payload || !claim) continue;
    if (row.type === "evidence.created") {
      if (
        payload.mode !== "confirmatory" ||
        payload.selected_hypothesis_id != null ||
        payload.computed_class === "assertion" ||
        payload.computed_class === "heuristic"
      )
        continue;
      const check = GroundedFalsificationCheckSchema.safeParse(payload.falsification_check);
      if (
        check.success &&
        check.data.result === "survived" &&
        check.data.target_digest === claim.contentDigest
      ) {
        if (
          new Set(check.data.evidence.map((ref) => ref.evidence_id)).size !==
            check.data.evidence.length ||
          !check.data.evidence.every((reference) => resolve(reference, row))
        ) {
          markStale(row);
          continue;
        }
        timeline.push({
          kind: "falsification-attempt",
          sequence: row.seq,
          targetVersion: row.target_version,
          attemptId: row.object_id,
          checkFingerprint: await sha256Hex(
            JSON.stringify({
              ...check.data,
              evidence: [...check.data.evidence].sort((left, right) =>
                left.evidence_id.localeCompare(right.evidence_id),
              ),
            }),
          ),
          attemptedFalsifier: check.data.attempted_falsifier,
          capableOfFailure: check.data.capable_of_failure,
          result: "survived",
          evidenceReferences: check.data.evidence.map((reference) => reference.evidence_id),
          qualifyingArtifactId:
            payload.kind === "certificate" && (await inspectFormalArtifact(payload.formal_artifact))
              ? row.object_id
              : undefined,
        });
      } else if (
        payload.kind === "certificate" &&
        (await inspectFormalArtifact(payload.formal_artifact))
      ) {
        timeline.push({
          kind: "certified-artifact",
          sequence: row.seq,
          targetVersion: row.target_version,
          evidenceId: row.object_id,
        });
      }
      continue;
    }
    if (row.type !== "review.created") continue;
    let carriesWeight =
      typeof payload.capable_of_failure === "string" &&
      payload.capable_of_failure.trim().length > 0;
    let tier: "T0" | "T1" | "T2" | "T3" = row.sponsor_id === claim.sponsorId ? "T0" : "T1";
    if (
      payload.independence_policy === SCIENTIFIC_INDEPENDENCE_POLICY &&
      (payload.tier === "T0" ||
        payload.tier === "T1" ||
        payload.tier === "T2" ||
        payload.tier === "T3")
    ) {
      tier = payload.tier;
    } else legacyReviews++;
    let fullWriteUp = false;
    let artifactEvidenceId: string | undefined;
    if (payload.verification != null) {
      const verification = ScientificVerificationSchema.safeParse(payload.verification);
      const material = verification.success ? resolve(verification.data.evidence, row) : undefined;
      try {
        if (!verification.success || !material)
          throw new ScientificInputError("Verification material is unavailable.");
        const assessed = await assessScientificVerification(
          claim,
          material,
          verification.data,
          row.fellow_id,
          row.sponsor_id,
        );
        fullWriteUp = assessed.fullWriteUp;
        if (assessed.certifiedArtifact) artifactEvidenceId = material.evidenceId;
      } catch (error) {
        if (!(error instanceof ScientificInputError)) throw error;
        if (payload.verdict !== "refute" && payload.verdict !== "fails-to-reproduce")
          carriesWeight = false;
        markStale(row);
      }
    }
    const provenance = readScientificProvenance(payload.scientific_provenance);
    if (provenance?.method?.evidence.some((reference) => !resolve(reference, row))) {
      if (payload.verdict !== "refute" && payload.verdict !== "fails-to-reproduce")
        carriesWeight = false;
      markStale(row);
    }
    timeline.push({
      kind: "review-created",
      sequence: row.seq,
      targetVersion: row.target_version,
      carriesWeight,
      verdict: typeof payload.verdict === "string" ? payload.verdict : "cannot-verify",
      review: {
        review_id: row.object_id,
        reviewer_id: row.fellow_id,
        tier,
        cross_family: tier === "T2" || tier === "T3",
        full_write_up: fullWriteUp,
      },
      artifactEvidenceId,
    });
  }
  return { ...computeCurrentClaimDisposition(timeline), stale, legacyReviews };
}
