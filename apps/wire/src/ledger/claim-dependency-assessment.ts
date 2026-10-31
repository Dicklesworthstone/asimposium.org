import { ClaimDependencyPinsSchema, ScientificVerificationSchema } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import {
  DEPENDENCY_CLOSURE_SQL,
  type DependencyClosure,
  type DependencyClosureRow,
} from "./claim-dependency-closure.ts";
import {
  type CeilingNode,
  computeDependencyCeilings,
  type DependencyCeiling,
  type PremiseStanding,
} from "./dependency-ceiling.ts";
import { reviewStateFromRecordedReviews } from "./dispositions.ts";
import type { EvidenceClass } from "./evidence-class.ts";
import {
  assessScientificVerification,
  checkedScientificPayload,
  readScientificProvenance,
  ScientificInputError,
} from "./scientific-checks.ts";
import { foldScientificRows, type ScientificRow } from "./scientific-disposition.ts";
import { directiveDisclosureStatusSql } from "../directives/disclosure-store.ts";
import { scientificWithdrawalEffects } from "./scientific-withdrawal-effects.ts";

export const DEPENDENCY_SCIENCE_ROW_LIMIT = 1024;
export const DEPENDENCY_SCIENCE_ITEM_BYTES = 65_536;
export const DEPENDENCY_SCIENCE_TOTAL_BYTES = 262_144;

/** Metadata is admitted before bodies are fetched. One extra envelope proves
 * truncation; no partial timeline is ever presented as complete standing.
 * All reads belong in the same D1 batch as the claim and dependency bodies.
 */
export function prepareDependencyAssessment(
  db: D1Database,
  problem: string,
  cursor: number,
  target: string,
): D1PreparedStatement {
  const [claim, version] = target.split("@");
  if (
    !/^C-[0-9]+@[1-9][0-9]*$/.test(target) ||
    target.length > 64 ||
    !Number.isSafeInteger(Number(version)) ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0
  )
    throw new Error("An exact claim version and published cursor are required.");
  const input = JSON.stringify({ problem, cursor, claim, version: Number(version) });
  return db.prepare(DEPENDENCY_SCIENCE_SQL).bind(input, input);
}

export const DEPENDENCY_SCIENCE_SQL = `
WITH input(j) AS (VALUES (?)),
dependency_nodes AS MATERIALIZED (${DEPENDENCY_CLOSURE_SQL}),
selected_claims AS MATERIALIZED (
  SELECT claim_id, MAX(version) AS max_version FROM dependency_nodes
  WHERE ordinal <= 64 AND payload_json IS NOT NULL GROUP BY claim_id
),
projection_gaps AS MATERIALIZED (
  SELECT e.id FROM events e JOIN problems p ON p.id = e.problem_id, input
  LEFT JOIN evidence x ON x.source_event_id = e.id AND x.problem_id = e.problem_id
    AND x.evidence_id = e.object_id AND x.source_seq = e.seq
  LEFT JOIN reviews r ON r.source_event_id = e.id AND r.problem_id = e.problem_id
    AND r.review_id = e.object_id AND r.source_seq = e.seq
  WHERE e.problem_id = json_extract(j, '$.problem') AND e.seq <= p.public_seq
    AND e.seq <= json_extract(j, '$.cursor')
    AND ((e.type = 'evidence.created' AND x.evidence_id IS NULL)
      OR (e.type = 'review.created' AND r.review_id IS NULL))
  LIMIT 1
),
source_rows AS (
  SELECT e.problem_id, s.claim_id, e.id AS event_id, e.seq, e.type, e.object_id,
    e.object_version, e.payload_sha256, e.created_at, ret.target_object AS retraction_target,
    (SELECT cc.event_id FROM claim_concessions cc WHERE cc.event_id = e.id
      AND cc.event_sha256 = e.payload_sha256 AND cc.problem_id = e.problem_id
      AND cc.claim_id = s.claim_id) AS concession_event_id,
    e.actor_fellow_id AS fellow_id, e.actor_sponsor_id AS sponsor_id,
    v.content_digest, v.kind AS claim_kind, x.direction, s.max_version,
    CASE WHEN e.object_kind = 'claim' THEN ${directiveDisclosureStatusSql(
      "e.problem_id",
      "e.object_id",
      "e.object_version",
      "json_extract(input.j, '$.cursor')",
    )} ELSE NULL END AS directive_disclosure,
    w.source_event_id AS withdrawn_event_id, w.target_kind AS withdrawn_kind,
    w.source_sha256 AS withdrawn_sha256,
    CASE WHEN r.verdict IN ('refute', 'fails-to-reproduce')
      AND length(trim(coalesce(r.capable_of_failure, ''))) > 0 THEN 1 ELSE 0 END AS weighted_refutation,
    CASE WHEN e.object_kind = 'claim' THEN e.object_version
      WHEN e.object_kind = 'review' THEN r.target_version
      WHEN w.source_event_id IS NOT NULL THEN w.claim_version
      WHEN e.object_kind = 'retraction' THEN
        CASE WHEN instr(ret.target_object, '@') > 0
          THEN CAST(substr(ret.target_object, instr(ret.target_object, '@') + 1) AS INTEGER)
          ELSE (SELECT MAX(prior.object_version) FROM events prior
            WHERE prior.problem_id = e.problem_id AND prior.object_id = s.claim_id
              AND prior.object_kind = 'claim' AND prior.type IN ('claim.created', 'claim.revised')
              AND prior.seq < e.seq) END
      ELSE x.bears_on_version END AS target_version
  FROM events e JOIN problems p ON p.id = e.problem_id, input
  LEFT JOIN reviews r ON r.source_event_id = e.id AND r.problem_id = e.problem_id
    AND r.review_id = e.object_id AND r.source_seq = e.seq
    AND e.object_kind = 'review' AND e.type = 'review.created'
  LEFT JOIN evidence x ON x.source_event_id = e.id AND x.problem_id = e.problem_id
    AND x.evidence_id = e.object_id AND x.source_seq = e.seq AND x.bears_on_kind = 'claim'
    AND e.object_kind = 'evidence' AND e.type = 'evidence.created'
  LEFT JOIN retractions ret ON ret.problem_id = e.problem_id AND ret.retraction_id = e.object_id
    AND ret.seq = e.seq AND ret.author_fellow_id = e.actor_fellow_id
    AND e.object_kind = 'retraction' AND e.type = 'object.retracted'
  LEFT JOIN scientific_withdrawals w ON w.event_id = e.id AND w.event_sha256 = e.payload_sha256
    AND w.problem_id = e.problem_id AND w.retraction_id = ret.retraction_id
    AND w.target_object = ret.target_object AND w.fellow_id = e.actor_fellow_id AND w.seq = e.seq
  JOIN selected_claims s ON s.claim_id = CASE
    WHEN e.object_kind = 'claim' THEN e.object_id
    WHEN e.object_kind = 'review' THEN r.target_claim_id
    WHEN w.source_event_id IS NOT NULL THEN w.claim_id
    WHEN e.object_kind = 'retraction' THEN CASE WHEN instr(ret.target_object, '@') > 0
      THEN substr(ret.target_object, 1, instr(ret.target_object, '@') - 1) ELSE ret.target_object END
    ELSE x.bears_on_id END
  LEFT JOIN claim_versions v ON v.problem_id = e.problem_id AND v.claim_id = s.claim_id
    AND v.version = e.object_version AND e.object_kind = 'claim'
  WHERE e.problem_id = json_extract(j, '$.problem') AND p.status <> 'private-draft'
    AND e.seq <= p.public_seq AND e.seq <= json_extract(j, '$.cursor')
    AND e.type IN ('claim.created', 'claim.revised', 'review.created', 'evidence.created', 'object.retracted')
),
admitted AS MATERIALIZED (
  SELECT * FROM source_rows WHERE target_version <= max_version
  ORDER BY seq, event_id LIMIT ${DEPENDENCY_SCIENCE_ROW_LIMIT + 1}
),
heads AS MATERIALIZED (
  SELECT e.object_id AS claim_id, MAX(e.object_version) AS latest_version
  FROM events e JOIN selected_claims s ON s.claim_id = e.object_id
  JOIN problems p ON p.id = e.problem_id, input
  WHERE e.problem_id = json_extract(j, '$.problem') AND e.object_kind = 'claim'
    AND e.type IN ('claim.created', 'claim.revised')
    AND e.seq <= p.public_seq AND e.seq <= json_extract(j, '$.cursor')
  GROUP BY e.object_id
),
sized AS MATERIALIZED (
  SELECT a.*, h.latest_version, row_number() OVER (ORDER BY a.seq, a.event_id) AS ordinal,
    CASE WHEN c.event_id IS NOT NULL AND c.redacted_at IS NULL
      AND NOT ${hiddenByContentControlSql("a.problem_id", "a.claim_id")}
      AND NOT ${eventContentHiddenSql("a")}
      THEN length(CAST(c.payload_json AS BLOB)) END AS source_bytes
  FROM admitted a JOIN heads h ON h.claim_id = a.claim_id
  LEFT JOIN event_content c ON c.event_id = a.event_id AND c.payload_sha256 = a.payload_sha256
),
budgeted AS MATERIALIZED (
  SELECT *, SUM(CASE WHEN ordinal <= ${DEPENDENCY_SCIENCE_ROW_LIMIT}
    AND source_bytes <= ${DEPENDENCY_SCIENCE_ITEM_BYTES} THEN source_bytes ELSE 0 END)
    OVER (ORDER BY ordinal) AS cumulative_bytes FROM sized
)
SELECT b.*, ((SELECT COUNT(*) FROM admitted) <= ${DEPENDENCY_SCIENCE_ROW_LIMIT}
  AND NOT EXISTS (SELECT 1 FROM projection_gaps)) AS scan_complete,
  CASE WHEN b.ordinal <= ${DEPENDENCY_SCIENCE_ROW_LIMIT}
    AND b.source_bytes <= ${DEPENDENCY_SCIENCE_ITEM_BYTES}
    AND b.cumulative_bytes <= ${DEPENDENCY_SCIENCE_TOTAL_BYTES} THEN c.payload_json END AS payload_json,
  NULL AS statement
FROM budgeted b LEFT JOIN event_content c ON c.event_id = b.event_id
  AND c.payload_sha256 = b.payload_sha256 AND c.redacted_at IS NULL
  AND b.ordinal <= ${DEPENDENCY_SCIENCE_ROW_LIMIT}
  AND b.source_bytes <= ${DEPENDENCY_SCIENCE_ITEM_BYTES}
  AND b.cumulative_bytes <= ${DEPENDENCY_SCIENCE_TOTAL_BYTES}
ORDER BY b.seq, b.event_id`;

export interface DependencyScientificRow extends ScientificRow {
  readonly problem_id: string;
  readonly latest_version: number;
  readonly scan_complete: number;
}

export interface PremiseAssessment {
  readonly scope: "publication-pins";
  readonly problem: string;
  readonly target: string;
  readonly through: number;
  readonly standing: PremiseStanding;
  readonly chain: DependencyCeiling;
}

const CLASSES: readonly EvidenceClass[] = [
  "assertion",
  "heuristic",
  "citation",
  "computation",
  "certified",
];
const unavailable = (): PremiseStanding => ({
  complete: false,
  disposition: null,
  review_state: null,
  stale: true,
  latest_version: null,
  own_ceiling: null,
});

/** Uses the same scientific fold as the public claim face, not an alternative
 * status machine. Only verified reachable publication nodes may get a result;
 * raw SQL candidates behind an unavailable parent cannot leak their standing.
 */
export async function composeDependencyAssessment(
  publications: readonly DependencyClosureRow[],
  closure: DependencyClosure,
  sources: readonly DependencyScientificRow[],
  problem: string,
  target: string,
  cursor: number,
): Promise<ReadonlyMap<string, PremiseAssessment>> {
  const root = publications[0];
  if (!closure.root_available || !root || `${root.claim_id}@${root.version}` !== target)
    return new Map();
  const rootPayload = await checkedScientificPayload({
    ...root,
    payload_json: root.payload_json ?? "",
  });
  const rootPins = ClaimDependencyPinsSchema.safeParse(rootPayload.dependency_pins);
  const nodes = [
    { target, row: root, pins: rootPins.success ? rootPins.data : null },
    ...closure.nodes,
  ];
  const inputs: CeilingNode[] = [];
  const groups = new Map<string, DependencyScientificRow[]>();
  for (const row of sources) {
    const group = groups.get(row.claim_id) ?? [];
    group.push(row);
    groups.set(row.claim_id, group);
  }
  for (const node of nodes) {
    let standing = unavailable();
    const rows = (groups.get(node.row.claim_id) ?? []).filter(
      (row) => row.target_version <= node.row.version,
    );
    try {
      if (
        sources.length > DEPENDENCY_SCIENCE_ROW_LIMIT ||
        rows.length === 0 ||
        sources.some((row) => row.scan_complete !== 1)
      )
        throw new ScientificInputError("The scientific timeline is incomplete.");
      const contents = new Map<string, Record<string, unknown>>();
      let previous = 0;
      let bytes = 0;
      for (const row of rows) {
        if (
          row.problem_id !== problem ||
          !Number.isSafeInteger(row.seq) ||
          row.seq <= previous ||
          row.seq > cursor ||
          row.payload_json === null ||
          contents.has(row.event_id)
        )
          throw new ScientificInputError("Scientific input does not match the snapshot.");
        previous = row.seq;
        const size = new TextEncoder().encode(row.payload_json).length;
        bytes += size;
        if (size > DEPENDENCY_SCIENCE_ITEM_BYTES || bytes > DEPENDENCY_SCIENCE_TOTAL_BYTES)
          throw new ScientificInputError("Scientific input exceeds the read budget.");
        const payload = await checkedScientificPayload({ ...row, payload_json: row.payload_json });
        if (row.type === "claim.created" || row.type === "claim.revised") {
          if (
            payload.claim_id !== node.row.claim_id ||
            typeof payload.statement !== "string" ||
            (row.object_version > 1 && payload.base_version !== row.object_version - 1)
          )
            throw new ScientificInputError("Claim input does not match its version.");
        } else if (row.type === "review.created") {
          if (
            payload.target_claim_id !== node.row.claim_id ||
            payload.target_version !== row.target_version
          )
            throw new ScientificInputError("Review input does not match its version.");
        } else if (row.type === "evidence.created") {
          if (
            payload.bears_on_kind !== "claim" ||
            payload.bears_on_id !== node.row.claim_id ||
            payload.bears_on_version !== row.target_version ||
            payload.direction !== row.direction
          )
            throw new ScientificInputError("Evidence input does not match its version.");
        }
        contents.set(row.event_id, payload);
      }
      const publication = rows.find((row) => row.event_id === node.row.event_id);
      if (
        !publication ||
        publication.payload_sha256 !== node.row.payload_sha256 ||
        publication.content_digest !== node.row.content_digest ||
        rows.some((row) => row.latest_version !== publication.latest_version)
      )
        throw new ScientificInputError("Scientific input does not match the publication pin.");
      // Content bytes, not a mutable statement/dependency projection, feed the fold.
      const timeline = rows.map((row) => {
        const payload = contents.get(row.event_id)!;
        const pins = ClaimDependencyPinsSchema.safeParse(payload.dependency_pins);
        return {
          ...row,
          statement: typeof payload.statement === "string" ? payload.statement : null,
          claim_kind: typeof payload.kind === "string" ? payload.kind : null,
          reduced_to_claim_id:
            payload.kind === "reduction" && pins.success ? (pins.data[0]?.claim_id ?? null) : null,
        };
      });
      const fold = await foldScientificRows(timeline);
      if (fold.stale || fold.currentVersion !== node.row.version)
        throw new ScientificInputError("Scientific standing is incomplete or stale.");
      const withdrawn = scientificWithdrawalEffects(timeline, contents);
      const evidence = rows.filter(
        (row) =>
          row.type === "evidence.created" &&
          row.target_version === node.row.version &&
          !withdrawn.invalidatedEvidence.has(row.object_id) &&
          !withdrawn.withdrawnEvents.has(row.event_id),
      );
      const certified = new Set<string>();
      const claimPayload = contents.get(publication.event_id)!;
      if (fold.context.has_certified_artifact) {
        for (const support of fold.context.verified_reviews) {
          if (support.finding !== "support" || support.tier === "T0") continue;
          const review = rows.find(
            (row) => row.type === "review.created" && row.object_id === support.review_id,
          );
          if (!review) continue;
          const payload = contents.get(review.event_id)!;
          const verification = ScientificVerificationSchema.safeParse(payload.verification);
          if (!verification.success) continue;
          const material = evidence.find(
            (row) =>
              row.object_id === verification.data.evidence.evidence_id &&
              `sha256:${row.payload_sha256}` === verification.data.evidence.digest &&
              row.seq < review.seq,
          );
          if (!material) continue;
          const body = contents.get(material.event_id)!;
          const assessment = await assessScientificVerification(
            {
              eventId: publication.event_id,
              payloadDigest: publication.payload_sha256,
              claimId: node.row.claim_id,
              version: node.row.version,
              contentDigest: node.row.content_digest!,
              statement: String(claimPayload.statement),
              fellowId: publication.fellow_id,
              sponsorId: publication.sponsor_id,
              provenance: readScientificProvenance(claimPayload.scientific_provenance),
            },
            {
              eventId: material.event_id,
              payloadDigest: material.payload_sha256,
              evidenceId: material.object_id,
              fellowId: material.fellow_id,
              sponsorId: material.sponsor_id,
              kind: String(body.kind),
              direction: String(body.direction),
              body: String(body.body_md),
              payload: body,
            },
            verification.data,
            review.fellow_id,
            review.sponsor_id,
          );
          if (assessment.certifiedArtifact) certified.add(material.object_id);
        }
      }
      const grades: EvidenceClass[] = [];
      for (const row of evidence) {
        const payload = contents.get(row.event_id)!;
        if (
          payload.mode !== "confirmatory" ||
          payload.selected_hypothesis_id != null ||
          (!certified.has(row.object_id) &&
            payload.direction !== "supports" &&
            payload.direction !== "reproduces" &&
            payload.direction !== "bounds")
        )
          continue;
        const recorded = payload.computed_class;
        if (typeof recorded !== "string" || !CLASSES.includes(recorded as EvidenceClass))
          throw new ScientificInputError("Evidence class is unavailable.");
        // A recorded certificate-shaped label alone never establishes certification.
        grades.push(
          certified.has(row.object_id)
            ? "certified"
            : recorded === "certified"
              ? "computation"
              : (recorded as EvidenceClass),
        );
      }
      const own =
        grades.length === 0
          ? "assertion"
          : grades.reduce((a, b) => (CLASSES.indexOf(a) <= CLASSES.indexOf(b) ? a : b));
      standing = {
        complete: true,
        disposition: fold.disposition,
        review_state: reviewStateFromRecordedReviews(
          fold.reviewFacets.filter((r) => r.targetVersion === node.row.version),
        ),
        stale: false,
        latest_version: publication.latest_version,
        own_ceiling: own,
      };
    } catch (error) {
      if (!(error instanceof ScientificInputError)) throw error;
    }
    const brokenEdge = closure.edges.some((edge) => edge.from === node.target && !edge.available);
    inputs.push({
      target: node.target,
      standing,
      dependencies:
        node.pins === null || brokenEdge || (node.target === target && !closure.complete)
          ? null
          : node.pins.map((pin) => `${pin.claim_id}@${pin.version}`),
    });
  }
  const ceilings = computeDependencyCeilings(inputs);
  return new Map(
    inputs.map((node) => [
      node.target,
      {
        scope: "publication-pins" as const,
        problem,
        target: node.target,
        through: cursor,
        standing: node.standing,
        chain: ceilings.get(node.target)!,
      },
    ]),
  );
}
