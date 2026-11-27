import {
  AuthorConcessionPublicationSchema,
  ClaimDependencyPinsSchema,
  GroundedFalsificationCheckSchema,
  type PublicClaimState,
  PublicClaimTargetSchema,
  type ReviewRequest,
  ReviewRequestSchema,
  ScientificVerificationSchema,
} from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { directiveDisclosureStatusSql } from "../directives/disclosure-store.ts";
import { claimContentDigest } from "../krater/claim-version.ts";
import { sha256Hex } from "../krater/krater.ts";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import {
  type CurrentClaimDispositionFold,
  computeCurrentClaimDisposition,
  type VersionedClaimTimelineEvent,
} from "./disposition-read.ts";
import { hasStatementDefect, type IndependenceTier } from "./dispositions.ts";
import {
  type ScientificEvidenceUse,
  scientificEvidenceClassEligible,
} from "./evidence-grounding.ts";
import {
  reviewCarriesWeight,
  reviewCarriesWeightSql,
  statementDefectSql,
} from "./review-weight.ts";
import {
  assessScientificVerification,
  checkedScientificClaimContent,
  inspectFormalArtifact,
  readScientificProvenance,
  recordedReviewIndependence,
  type ScientificClaim,
  type ScientificEvidence,
  ScientificInputError,
  validateSupportingVerification,
} from "./scientific-checks.ts";
import { readPremiseAwareDisposition } from "./scientific-dependencies.ts";
import { isNegativeReview, scientificInputEffects } from "./scientific-withdrawal-effects.ts";

export interface ScientificRow {
  claim_id: string;
  event_id: string;
  seq: number;
  type: string;
  object_id: string;
  object_version: number;
  target_version: number;
  payload_sha256: string;
  payload_json: string | null;
  /** Server publication time from the immutable event envelope. Legacy or
   * incomplete inputs without it cannot settle a timed refutation. */
  created_at?: string;
  fellow_id: string;
  sponsor_id: string;
  content_digest: string | null;
  statement: string | null;
  direction: string | null;
  /** A completed objection remains contested even without verification weight. */
  negative_review?: number;
  weighted_refutation?: number;
  statement_defect?: number;
  /** Immutable review rubric/weight survives withholding its public body. */
  weighted_statement_defect?: number;
  withdrawn_event_id?: string | null;
  withdrawn_kind?: string | null;
  withdrawn_sha256?: string | null;
  /** Immutable classification survives removal of the concession payload. */
  concession_event_id?: string | null;
  retraction_target?: string | null;
  /** Server-derived disclosure coverage for this immutable claim version.
   * It is selected in the same database snapshot as the scientific timeline. */
  directive_disclosure?: string | null;
  /** Explicitly bounded readers must reject the whole history on overflow.
   * Missing bodies caused by this budget are not scientific withdrawals. */
  scientific_budget_exceeded?: number;
  /** A projection cannot reroute or erase an immutable scientific event.
   * Repeated on every selected row so filtering to an exact version cannot
   * discard the disagreement along with the misrouted objection. */
  source_projection_mismatch?: number;
}

export interface ScientificReadBudget {
  readonly maxRows: number;
  readonly maxPayloadBytes: number;
  /** Counts both event payloads and returned claim-version statement copies. */
  readonly maxTotalPayloadBytes: number;
}

/** Scientific standing needs the complete selected history. Bound the read
 * before transferring bodies from D1, not after a pack has spent its token
 * budget. A 512 KiB admitted write can grow with server provenance, so the
 * body ceiling leaves that headroom; collections may supply tighter limits.
 * These are read limits, never evidence or a partial-history approximation. */
export const DEFAULT_SCIENTIFIC_READ_BUDGET: ScientificReadBudget = Object.freeze({
  maxRows: 1024,
  maxPayloadBytes: 1024 * 1024,
  maxTotalPayloadBytes: 4 * 1024 * 1024,
});

export class ScientificReadBudgetExceededError extends ScientificInputError {
  constructor() {
    super("Scientific history exceeds the read budget.");
    this.name = "ScientificReadBudgetExceededError";
  }
}

/** One recorded review as the review-state facet sees it (Fable §6.6). */
export interface RecordedReviewFacet {
  readonly targetVersion: number;
  readonly verdict: string;
  readonly statementDefect?: boolean;
  readonly carriesWeight: boolean;
  readonly tier: IndependenceTier;
}

export type ScientificDisposition = CurrentClaimDispositionFold & {
  stale: boolean;
  legacyReviews: number;
  /** Every recorded review in this fold, for the computed review-state facet. */
  reviewFacets: readonly RecordedReviewFacet[];
  directiveDisclosure: PublicClaimState["directive_disclosure"];
  /** Exact-version novelty from the complete verified timeline, never a page
   * of display candidates. Correctness reviews cannot establish this facet. */
  novelty?: PublicClaimState["novelty"];
};

type NoveltyVerdict = NonNullable<ReviewRequest["novelty"]>["verdict"];
const noveltyReviewSchema = ReviewRequestSchema.shape.novelty.unwrap();
const NOT_NEW: ReadonlySet<NoveltyVerdict> = new Set([
  "reformulation",
  "special-case",
  "rediscovery",
]);

/** The latest publication of each claim at a captured ledger cursor. A later
 * revision moves the mutable claims row, but cannot remove or replace a claim
 * in an already captured read. Pack bodies and their scientific folds must use
 * this same ordering and limit. Bind problem, cursor and candidate limit. */
export const CLAIM_HEADS_AT_CURSOR_SQL = `SELECT publication.problem_id,
    publication.object_id AS id, MAX(publication.seq) AS source_seq
  FROM events publication
  WHERE publication.problem_id = ? AND publication.seq <= ?
    AND publication.object_kind = 'claim'
    AND publication.type IN ('claim.created', 'claim.revised')
  GROUP BY publication.object_id
  ORDER BY source_seq ASC, id ASC LIMIT ?`;

/** A bounded claim selection with canonical premise health at the same cursor.
 * Referenced evidence and immutable dependency pins use public ledger reads;
 * no author workshop read or mutable dependency-head substitution is needed. */
export async function readScientificDispositions(
  db: D1Database,
  problemId: string,
  cursor: number,
  claimLimit: number,
  target?: { claimId: string; version: number },
  budget: ScientificReadBudget = DEFAULT_SCIENTIFIC_READ_BUDGET,
  onInvalidClaim?: (claimId: string) => void,
): Promise<Map<string, ScientificDisposition>> {
  const result = await prepareScientificDispositions(
    db,
    problemId,
    cursor,
    claimLimit,
    target,
    budget,
  ).all<ScientificRow>();
  if (!result.success) throw new ScientificInputError("Scientific history is unavailable.");
  const groups = new Map<string, ScientificRow[]>();
  for (const row of result.results) {
    if (target !== undefined && row.target_version > target.version) continue;
    const rows = groups.get(row.claim_id) ?? [];
    rows.push(row);
    groups.set(row.claim_id, rows);
  }
  const output = new Map<string, ScientificDisposition>();
  for (const [claimId, rows] of groups) {
    let fold: ScientificDisposition;
    try {
      fold = await foldScientificRows(rows);
    } catch (error) {
      // Collections that expose partial coverage may omit one invalid claim.
      // The budget covers the entire selection. Overflow invalidates every row.
      if (
        !onInvalidClaim ||
        !(error instanceof ScientificInputError) ||
        error instanceof ScientificReadBudgetExceededError
      )
        throw error;
      onInvalidClaim(claimId);
      continue;
    }
    output.set(
      claimId,
      await readPremiseAwareDisposition(db, problemId, cursor, claimId, rows, fold),
    );
  }
  return output;
}

/** The public face batches this query with its bodies so content withdrawal
 * cannot split the visible records from their computed standing. Current
 * controls null the content at every historical cut, but retain envelopes:
 * missing support loses weight, while a hidden objection is not a resolution
 * and a hidden withdrawal cannot resurrect its withdrawn positive input. */
export function prepareScientificDispositions(
  db: D1Database,
  problemId: string,
  cursor: number,
  claimLimit: number,
  target?: { claimId: string; version: number },
  budget: ScientificReadBudget = DEFAULT_SCIENTIFIC_READ_BUDGET,
): D1PreparedStatement {
  if (
    [budget.maxRows, budget.maxPayloadBytes, budget.maxTotalPayloadBytes].some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    ) ||
    budget.maxRows === Number.MAX_SAFE_INTEGER
  )
    throw new RangeError(
      "Scientific read budget requires positive safe integers and row lookahead.",
    );
  // Both targeted and list reads select immutable events so a later mutable
  // head cannot erase a claim from the requested cursor.
  const selection =
    target === undefined
      ? CLAIM_HEADS_AT_CURSOR_SQL
      : "SELECT object_id AS id FROM events WHERE problem_id = ? AND seq <= ? AND object_id = ? AND type = 'claim.created' AND object_kind = 'claim' LIMIT 1";
  const targetVersion = `CASE WHEN e.object_kind = 'claim' THEN e.object_version
    WHEN e.object_kind = 'review' THEN r.target_version
    WHEN e.object_kind = 'retraction' AND w.source_event_id IS NOT NULL THEN w.claim_version
    WHEN e.object_kind = 'retraction' THEN (
      CASE WHEN instr(ret.target_object, '@') > 0
        THEN CAST(substr(ret.target_object, instr(ret.target_object, '@') + 1) AS INTEGER)
        ELSE COALESCE(
          (
            SELECT MAX(cv.version)
            FROM claim_versions cv
            JOIN events ce ON ce.problem_id = cv.problem_id
              AND ce.object_id = cv.claim_id
              AND ce.object_version = cv.version
              AND ce.type IN ('claim.created', 'claim.revised')
            WHERE cv.problem_id = e.problem_id
              AND cv.claim_id = s.id
              AND ce.seq <= e.seq
          ),
          1
        )
      END
    )
    ELSE x.bears_on_version
  END`;
  // Check routing before selecting claim histories. A check over returned rows
  // alone cannot find an objection whose projection points at another claim or
  // version. One census at this problem/cursor detects both missing sources and
  // disagreement with available event bytes; it never releases those bytes.
  // Either recorded target can establish relevance. Unknown routing with no
  // projection fails the whole snapshot; known unrelated claims remain usable.
  // Withholding/redaction is not a mismatch: existing adverse metadata remains
  // usable when the body is absent, and the fold retains its staleness rules.
  const query = `
    WITH disclosure_cut(cursor) AS (VALUES (?)),
    scientific_scope(problem_id, target_version) AS (VALUES (?, ?)),
    selected_claims AS (
      ${selection}
    ),
    projection_mismatches AS MATERIALIZED (
      SELECT source.id
      FROM scientific_scope scope CROSS JOIN disclosure_cut cut CROSS JOIN events source
      LEFT JOIN reviews review ON review.source_event_id = source.id
        AND review.problem_id = source.problem_id AND review.review_id = source.object_id
        AND review.source_seq = source.seq AND source.object_kind = 'review'
        AND source.type = 'review.created'
      LEFT JOIN evidence material ON material.source_event_id = source.id
        AND material.problem_id = source.problem_id AND material.evidence_id = source.object_id
        AND material.source_seq = source.seq AND source.object_kind = 'evidence'
        AND source.type = 'evidence.created'
      LEFT JOIN event_content body ON body.event_id = source.id
        AND body.payload_sha256 = source.payload_sha256 AND body.redacted_at IS NULL
      WHERE source.problem_id = scope.problem_id AND source.seq <= cut.cursor
        AND source.type IN ('review.created', 'evidence.created')
        AND (
          (source.type = 'review.created' AND (
            (review.target_claim_id IN (SELECT id FROM selected_claims)
              AND (scope.target_version IS NULL OR review.target_version <= scope.target_version))
            OR (json_extract(CASE WHEN json_valid(body.payload_json) THEN body.payload_json ELSE '{}' END,
                '$.target_claim_id') IN (SELECT id FROM selected_claims)
              AND (scope.target_version IS NULL
                OR json_type(CASE WHEN json_valid(body.payload_json) THEN body.payload_json ELSE '{}' END,
                  '$.target_version') IS NOT 'integer'
                OR json_extract(CASE WHEN json_valid(body.payload_json) THEN body.payload_json ELSE '{}' END,
                  '$.target_version') <= scope.target_version))
            OR (review.review_id IS NULL AND
              json_type(CASE WHEN json_valid(body.payload_json) THEN body.payload_json ELSE '{}' END,
                '$.target_claim_id') IS NOT 'text')
          )) OR
          (source.type = 'evidence.created' AND (
            (material.bears_on_kind = 'claim' AND material.bears_on_id IN (SELECT id FROM selected_claims)
              AND (scope.target_version IS NULL OR material.bears_on_version <= scope.target_version))
            OR (json_extract(CASE WHEN json_valid(body.payload_json) THEN body.payload_json ELSE '{}' END,
                '$.bears_on_kind') = 'claim'
              AND json_extract(CASE WHEN json_valid(body.payload_json) THEN body.payload_json ELSE '{}' END,
                '$.bears_on_id') IN (SELECT id FROM selected_claims)
              AND (scope.target_version IS NULL
                OR json_type(CASE WHEN json_valid(body.payload_json) THEN body.payload_json ELSE '{}' END,
                  '$.bears_on_version') IS NOT 'integer'
                OR json_extract(CASE WHEN json_valid(body.payload_json) THEN body.payload_json ELSE '{}' END,
                  '$.bears_on_version') <= scope.target_version))
            OR (material.evidence_id IS NULL AND
              (json_type(CASE WHEN json_valid(body.payload_json) THEN body.payload_json ELSE '{}' END,
                '$.bears_on_id') IS NOT 'text'
                OR COALESCE(json_extract(CASE WHEN json_valid(body.payload_json) THEN body.payload_json ELSE '{}' END,
                  '$.bears_on_kind'), '') NOT IN ('claim', 'hypothesis')))
          ))
        )
        AND (
          (source.type = 'review.created' AND (
            review.review_id IS NULL OR
            CASE WHEN json_valid(body.payload_json) THEN
              (json_type(body.payload_json, '$.target_claim_id') = 'text'
                AND json_extract(body.payload_json, '$.target_claim_id') IS NOT review.target_claim_id)
              OR (json_type(body.payload_json, '$.target_version') = 'integer'
                AND json_extract(body.payload_json, '$.target_version') IS NOT review.target_version)
              OR (json_type(body.payload_json, '$.verdict') = 'text'
                AND json_extract(body.payload_json, '$.verdict') IS NOT review.verdict)
            ELSE 0 END
          )) OR
          (source.type = 'evidence.created' AND (
            material.evidence_id IS NULL OR
            CASE WHEN json_valid(body.payload_json) THEN
              (json_type(body.payload_json, '$.bears_on_kind') = 'text'
                AND json_extract(body.payload_json, '$.bears_on_kind') IS NOT material.bears_on_kind)
              OR (json_type(body.payload_json, '$.bears_on_id') = 'text'
                AND json_extract(body.payload_json, '$.bears_on_id') IS NOT material.bears_on_id)
              OR (json_type(body.payload_json, '$.bears_on_version') = 'integer'
                AND json_extract(body.payload_json, '$.bears_on_version') IS NOT material.bears_on_version)
              OR (json_type(body.payload_json, '$.direction') = 'text'
                AND json_extract(body.payload_json, '$.direction') IS NOT material.direction)
            ELSE 0 END
          ))
        )
      LIMIT 1
    )
    SELECT s.id AS claim_id, e.id AS event_id, e.seq, e.type, e.object_id, e.object_version,
      EXISTS (SELECT 1 FROM projection_mismatches) AS source_projection_mismatch,
      ${targetVersion} AS target_version,
      (SELECT cc.event_id FROM claim_concessions cc WHERE cc.event_id = e.id
        AND cc.event_sha256 = e.payload_sha256 AND cc.problem_id = e.problem_id
        AND cc.claim_id = s.id) AS concession_event_id,
      ret.target_object AS retraction_target,
      e.payload_sha256, e.problem_id AS scientific_problem_id,
      length(CAST(c.payload_json AS BLOB)) AS scientific_payload_bytes,
      e.created_at, e.actor_fellow_id AS fellow_id,
      e.actor_sponsor_id AS sponsor_id, v.content_digest,
      CASE WHEN c.event_id IS NOT NULL THEN length(CAST(v.statement AS BLOB)) END
        AS scientific_statement_bytes, x.direction,
      w.source_event_id AS withdrawn_event_id,
      CASE WHEN e.object_kind = 'claim' THEN ${directiveDisclosureStatusSql(
        "e.problem_id",
        "e.object_id",
        "e.object_version",
        "disclosure_cut.cursor",
      )} ELSE NULL END AS directive_disclosure,
      w.target_kind AS withdrawn_kind, w.source_sha256 AS withdrawn_sha256,
      CASE WHEN r.verdict IN ('refute', 'fails-to-reproduce') THEN 1 ELSE 0 END AS negative_review,
      CASE WHEN r.verdict IN ('refute', 'fails-to-reproduce')
        AND ${reviewCarriesWeightSql({ basis: "r.basis", capableOfFailure: "r.capable_of_failure", bodyMd: "r.body_md" })}
        THEN 1 ELSE 0 END AS weighted_refutation,
      CASE WHEN ${statementDefectSql("r.rubric_json")} THEN 1 ELSE 0 END AS statement_defect,
      CASE WHEN ${statementDefectSql("r.rubric_json")}
        AND ${reviewCarriesWeightSql({ basis: "r.basis", capableOfFailure: "r.capable_of_failure", bodyMd: "r.body_md" })}
        THEN 1 ELSE 0 END AS weighted_statement_defect
    FROM events e CROSS JOIN disclosure_cut CROSS JOIN scientific_scope
    LEFT JOIN reviews r ON r.source_event_id = e.id AND r.problem_id = e.problem_id
      AND r.review_id = e.object_id AND r.source_seq = e.seq AND e.type = 'review.created'
    LEFT JOIN evidence x ON x.source_event_id = e.id AND x.problem_id = e.problem_id
      AND x.evidence_id = e.object_id AND x.source_seq = e.seq
      AND x.bears_on_kind = 'claim' AND e.type = 'evidence.created'
    LEFT JOIN retractions ret ON ret.problem_id = e.problem_id
      AND ret.retraction_id = e.object_id
      AND ret.seq = e.seq AND ret.author_fellow_id = e.actor_fellow_id
      AND e.object_kind = 'retraction' AND e.type = 'object.retracted'
    LEFT JOIN scientific_withdrawals w ON w.event_id = e.id
      AND w.event_sha256 = e.payload_sha256 AND w.problem_id = e.problem_id
      AND w.retraction_id = ret.retraction_id AND w.target_object = ret.target_object
      AND w.fellow_id = e.actor_fellow_id AND w.seq = e.seq
    JOIN selected_claims s ON s.id = CASE
      WHEN e.object_kind = 'claim' THEN e.object_id
      WHEN e.object_kind = 'review' THEN r.target_claim_id
      WHEN e.object_kind = 'retraction' AND w.source_event_id IS NOT NULL THEN w.claim_id
      WHEN e.object_kind = 'retraction' THEN (
        CASE WHEN instr(ret.target_object, '@') > 0
          THEN substr(ret.target_object, 1, instr(ret.target_object, '@') - 1)
          ELSE ret.target_object
        END
      )
      ELSE x.bears_on_id
    END
    LEFT JOIN claim_versions v ON v.problem_id = e.problem_id AND v.claim_id = s.id
      AND v.version = e.object_version AND e.object_kind = 'claim'
    LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      AND c.redacted_at IS NULL
      AND NOT ${eventContentHiddenSql("e")}
    WHERE e.problem_id = ? AND e.seq <= ?
      AND e.type IN ('claim.created', 'claim.revised', 'review.created', 'evidence.created', 'object.retracted')
      AND (scientific_scope.target_version IS NULL OR (${targetVersion}) <= scientific_scope.target_version)
    ORDER BY e.seq ASC
    LIMIT ${budget.maxRows + 1}
  `;
  // Select only bounded envelope/byte metadata first. No scientific body
  // crosses D1 unless the complete selected history fits every limit. The
  // lookahead row invalidates the whole history instead of hiding a late
  // objection behind an apparently complete prefix. Exact-version admission
  // precedes this budget: future revisions cannot exhaust an older statement's
  // read. The projection census still detects an objection rerouted away from it.
  const boundedQuery = `WITH scientific_sources AS MATERIALIZED (${query}),
    scientific_budget AS MATERIALIZED (
      SELECT CASE WHEN COUNT(*) > ${budget.maxRows}
        OR COALESCE(MAX(scientific_payload_bytes), 0) > ${budget.maxPayloadBytes}
        OR COALESCE(MAX(scientific_statement_bytes), 0) > ${budget.maxPayloadBytes}
        OR COALESCE(SUM(COALESCE(scientific_payload_bytes, 0)
          + COALESCE(scientific_statement_bytes, 0)), 0) > ${budget.maxTotalPayloadBytes}
        THEN 1 ELSE 0 END AS exceeded FROM scientific_sources
    )
    SELECT b.*, limits.exceeded AS scientific_budget_exceeded,
      c.payload_json, v.statement
    FROM scientific_sources b CROSS JOIN scientific_budget limits
    LEFT JOIN event_content c ON c.event_id = b.event_id AND c.payload_sha256 = b.payload_sha256
      AND c.redacted_at IS NULL AND b.scientific_payload_bytes IS NOT NULL AND limits.exceeded = 0
    LEFT JOIN claim_versions v ON v.problem_id = b.scientific_problem_id
      AND v.claim_id = b.claim_id AND v.version = b.object_version
      AND b.scientific_statement_bytes IS NOT NULL AND limits.exceeded = 0
    ORDER BY b.seq ASC`;
  return db
    .prepare(boundedQuery)
    .bind(
      cursor,
      problemId,
      target?.version ?? null,
      problemId,
      cursor,
      target?.claimId ?? claimLimit,
      problemId,
      cursor,
    );
}

export async function foldScientificRows(
  rows: readonly ScientificRow[],
): Promise<ScientificDisposition> {
  if (
    rows.some(
      (row) => row.source_projection_mismatch !== undefined && row.source_projection_mismatch !== 0,
    )
  )
    throw new ScientificInputError(
      "Scientific projections disagree with the public event history.",
    );
  if (
    rows.some(
      (row) => row.scientific_budget_exceeded !== undefined && row.scientific_budget_exceeded !== 0,
    )
  )
    throw new ScientificReadBudgetExceededError();
  const contents = new Map<string, Record<string, unknown>>();
  const claims = new Map<number, ScientificClaim>();
  // Withdrawal needs immutable creation authorship even if the claim text is
  // unavailable. Such an envelope must never become readable scientific input.
  const originalAuthor = rows.find(
    (row) => row.type === "claim.created" && row.object_version === 1,
  )?.fellow_id;
  const evidence = new Map<string, ScientificEvidence & { sequence: number }>();
  let stale = false;
  let legacyReviews = 0;
  const headPublication = rows
    .filter((row) => row.type === "claim.created" || row.type === "claim.revised")
    .at(-1);
  const head = headPublication?.object_version;
  const markStale = (row: ScientificRow): void => {
    if (row.target_version === head) stale = true;
  };
  const timeline: VersionedClaimTimelineEvent[] = [];
  const reviewFacets: RecordedReviewFacet[] = [];
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
      if (row.content_digest === null || row.statement === null) {
        markStale(row);
        continue;
      }
      await checkedScientificClaimContent(payload, {
        claimId: row.claim_id,
        version: row.object_version,
        statement: row.statement,
        contentDigest: row.content_digest,
      });
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
      (row.type === "review.created" &&
        (payload.target_claim_id !== row.claim_id ||
          payload.target_version !== row.target_version)) ||
      (row.type === "evidence.created" &&
        (payload.bears_on_kind !== "claim" ||
          payload.bears_on_id !== row.claim_id ||
          payload.bears_on_version !== row.target_version ||
          payload.direction !== row.direction))
    ) {
      // Treat a misbound input as unavailable source content. In particular,
      // discarding its positive weight must not erase a recorded objection or
      // allow a mismatched review to resolve counterevidence on this claim.
      contents.delete(row.event_id);
      markStale(row);
      continue;
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
  const withdrawn = scientificInputEffects(rows, contents);
  const noveltyClaim =
    headPublication !== undefined &&
    contents.get(headPublication.event_id)?.kind === "novelty-claim"
      ? claims.get(headPublication.object_version)
      : undefined;
  const noveltyVerdicts = new Set<NoveltyVerdict>();
  let noveltyUnavailable = false;
  for (const id of withdrawn.invalidatedEvidence) evidence.delete(id);
  const resolve = (
    reference: { evidence_id: string; digest: string },
    row: ScientificRow,
    use: ScientificEvidenceUse = "grounding",
  ) => {
    const item = evidence.get(reference.evidence_id);
    return item &&
      item.sequence < row.seq &&
      reference.digest === `sha256:${item.payloadDigest}` &&
      item.payload.bears_on_id === row.claim_id &&
      item.payload.bears_on_kind === "claim" &&
      item.payload.bears_on_version === row.target_version &&
      item.payload.mode === "confirmatory" &&
      scientificEvidenceClassEligible(item.payload, use) &&
      (item.payload.selected_hypothesis_id === null ||
        item.payload.selected_hypothesis_id === undefined)
      ? item
      : undefined;
  };
  const concessionIsGrounded = async (row: ScientificRow, payload: Record<string, unknown>) => {
    const parsed = AuthorConcessionPublicationSchema.safeParse(payload.concession);
    if (!parsed.success || row.concession_event_id !== row.event_id) return false;
    const pin = parsed.data,
      claim = claims.get(row.target_version);
    const material = resolve(pin.evidence, row);
    const source = rows.find((item) => item.event_id === claim?.eventId);
    const statement = source && contents.get(source.event_id);
    const priorHead = rows
      .filter(
        (item) =>
          item.seq < row.seq && (item.type === "claim.created" || item.type === "claim.revised"),
      )
      .at(-1);
    const matches = (
      expected: typeof pin.claim_source,
      actual: ScientificClaim | ScientificEvidence,
    ) =>
      expected.event_id === actual.eventId &&
      expected.digest === `sha256:${actual.payloadDigest}` &&
      expected.fellow_id === actual.fellowId &&
      expected.sponsor_id === actual.sponsorId;
    if (
      !claim ||
      !source ||
      !statement ||
      !material ||
      priorHead?.object_version !== row.target_version ||
      pin.target_version !== row.target_version ||
      payload.target_object !== `${row.claim_id}@${row.target_version}` ||
      pin.target_digest !== claim.contentDigest ||
      !matches(pin.claim_source, claim) ||
      !matches(pin.evidence_source, material) ||
      source.seq >= material.sequence ||
      (material.direction !== "refutes" && material.direction !== "fails-to-reproduce")
    )
      return false;
    if (
      (await claimContentDigest(
        {
          kind: String(statement.kind),
          statement: claim.statement,
          falsifier: typeof statement.falsifier === "string" ? statement.falsifier : null,
        },
        sha256Hex,
      )) !== pin.target_digest
    )
      return false;
    // Re-resolve the whole immutable evidence graph at this read. Losing an
    // ancestor cannot leave a dependent concession cosmetically settled.
    const visited = new Set<string>();
    const grounded = (item: typeof material): boolean => {
      if (visited.has(item.eventId)) return true;
      visited.add(item.eventId);
      if (visited.size > 64) return false;
      const refs: { evidence_id: string; digest: string }[] = [];
      if (item.payload.falsification_check != null) {
        const check = GroundedFalsificationCheckSchema.safeParse(item.payload.falsification_check);
        if (!check.success || check.data.target_digest !== claim.contentDigest) return false;
        refs.push(...check.data.evidence);
      }
      if (item.payload.scientific_provenance != null) {
        const provenance = readScientificProvenance(item.payload.scientific_provenance);
        if (!provenance) return false;
        refs.push(...(provenance.method?.evidence ?? []));
      }
      return refs.every((ref) => {
        const ancestor = resolve(ref, row);
        return ancestor !== undefined && ancestor.sequence < item.sequence && grounded(ancestor);
      });
    };
    return grounded(material);
  };
  const confirmedRefutation = (
    review: ScientificRow,
    material: ScientificEvidence & { sequence: number },
  ): { evidenceId: string; unansweredHours: number } | undefined => {
    // Wall-clock reads would change the same cursor's standing over time.
    // An explicit verifying review instead supplies a new immutable time cut.
    // Until another such review lands, an old dispute stays a dispute.
    const source = rows.find((item) => item.event_id === material.eventId);
    const claimSource = rows.find(
      (item) =>
        (item.type === "claim.created" || item.type === "claim.revised") &&
        item.object_version === review.target_version,
    );
    const time = (item: ScientificRow | undefined): number => {
      if (typeof item?.created_at !== "string") return Number.NaN;
      const parsed = Date.parse(item.created_at);
      return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === item.created_at
        ? parsed
        : Number.NaN;
    };
    const sourceTime = time(source);
    const reviewTime = time(review);
    const claimTime = time(claimSource);
    if (
      !Number.isSafeInteger(sourceTime) ||
      !Number.isSafeInteger(reviewTime) ||
      !Number.isSafeInteger(claimTime) ||
      sourceTime < claimTime ||
      reviewTime < sourceTime ||
      withdrawn.withdrawnEvents.has(review.event_id)
    )
      return undefined;
    // There is no structured rebuttal-resolution contract yet. Any intervening
    // non-adverse scientific response prevents the unattended-clock inference;
    // a later confirmation cannot erase it by merely repeating its verdict.
    for (const item of rows) {
      if (
        item.seq <= material.sequence ||
        item.seq >= review.seq ||
        item.target_version !== review.target_version
      )
        continue;
      const payload = contents.get(item.event_id);
      const itemTime = time(item);
      if (!Number.isSafeInteger(itemTime) || itemTime < sourceTime || itemTime > reviewTime)
        return undefined;
      if (item.type === "evidence.created") {
        if (
          !payload ||
          (payload.direction !== "refutes" && payload.direction !== "fails-to-reproduce")
        )
          return undefined;
      } else if (item.type === "review.created") {
        if (!payload || !isNegativeReview(payload)) return undefined;
        if (payload.verification !== undefined && payload.verification !== null) {
          const check = ScientificVerificationSchema.safeParse(payload.verification);
          if (
            !check.success ||
            (check.data.kind === "refutation" && check.data.result !== "verified")
          )
            return undefined;
        }
      } else {
        // Revisions, withdrawals and unknown changes cannot manufacture an
        // unanswered refutation. Their ordinary state-machine effects remain.
        return undefined;
      }
    }
    return {
      evidenceId: material.evidenceId,
      unansweredHours: (reviewTime - sourceTime) / 3_600_000,
    };
  };
  for (const row of rows) {
    const payload = contents.get(row.event_id);
    let noveltyVerdict: NoveltyVerdict | undefined;
    if (
      noveltyClaim &&
      row.type === "review.created" &&
      row.target_version === head &&
      row.fellow_id !== noveltyClaim.fellowId &&
      row.sponsor_id !== noveltyClaim.sponsorId
    ) {
      const novelty = noveltyReviewSchema.safeParse(payload?.novelty);
      if (
        !novelty.success ||
        payload?.verdict !== "inform" ||
        payload.target_claim_id !== row.claim_id ||
        payload.target_version !== row.target_version
      ) {
        // A hidden, corrupt or mismatched review may contain an objection.
        // Omitting its body from a display page cannot establish novelty.
        noveltyUnavailable = true;
        markStale(row);
      } else {
        noveltyVerdict = novelty.data.verdict;
      }
    }
    const adverseNovelty = noveltyVerdict !== undefined && NOT_NEW.has(noveltyVerdict);
    if (row.withdrawn_event_id) {
      markStale(row);
      // This is a withdrawal of an input, never of its author's target claim.
      continue;
    }
    if (
      withdrawn.withdrawnEvents.has(row.event_id) ||
      (row.type === "evidence.created" && withdrawn.invalidatedEvidence.has(row.object_id))
    ) {
      markStale(row);
      const adverseEvidence =
        row.type === "evidence.created" &&
        (row.direction === "refutes" || row.direction === "fails-to-reproduce");
      const adverseReview =
        row.type === "review.created" &&
        (isNegativeReview(payload) ||
          adverseNovelty ||
          (!payload &&
            (row.negative_review === 1 ||
              row.statement_defect === 1 ||
              row.weighted_refutation === 1 ||
              row.weighted_statement_defect === 1)));
      if (!adverseEvidence && !adverseReview) continue;
    }
    if (row.type === "claim.created" || row.type === "claim.revised") {
      let targetClaimId: string | undefined;
      if (payload?.kind === "reduction") {
        // claim_deps accumulates edges across revisions. Only this verified
        // publication's pins can establish its reduction, including an empty
        // list that deliberately removes the previous version's premises.
        if (payload.dependency_pins !== undefined) {
          const pins = ClaimDependencyPinsSchema.safeParse(payload.dependency_pins);
          if (!pins.success || pins.data.some((pin) => pin.claim_id === row.claim_id)) {
            markStale(row);
          } else {
            targetClaimId = pins.data[0]?.claim_id;
          }
        } else if (Array.isArray(payload.relates_to) && payload.relates_to.length > 0) {
          // Legacy publications predate dependency pins. Their own recorded
          // relation may establish bookkeeping, never a present-day graph edge.
          const target = PublicClaimTargetSchema.safeParse(payload.relates_to[0]);
          if (target.success && target.data.split("@")[0] !== row.claim_id)
            targetClaimId = target.data;
          else markStale(row);
        }
      }
      timeline.push({
        kind: row.type === "claim.created" ? "claim-created" : "claim-revised",
        sequence: row.seq,
        version: row.object_version,
        targetClaimId,
      });
      continue;
    }
    if (row.type === "object.retracted") {
      if (!originalAuthor || originalAuthor !== row.fellow_id) {
        continue;
      }
      if (payload) {
        const targetObject = payload.target_object;
        if (
          typeof targetObject !== "string" ||
          (targetObject !== row.claim_id &&
            targetObject !== `${row.claim_id}@${row.target_version}`)
        ) {
          markStale(row);
          continue;
        }
      }
      if (row.concession_event_id || payload?.concession !== undefined) {
        if (payload && (await concessionIsGrounded(row, payload))) {
          timeline.push({
            kind: "author-concession",
            sequence: row.seq,
            targetVersion: row.target_version,
          });
        } else {
          markStale(row);
          timeline.push({
            kind: "refuting-evidence",
            sequence: row.seq,
            targetVersion: row.target_version,
            evidenceId: row.object_id,
          });
        }
      } else {
        timeline.push({
          kind: "claim-retracted",
          sequence: row.seq,
          targetVersion: row.target_version,
          retractionId: row.object_id,
          wholeIdentity:
            (payload?.target_object ?? row.retraction_target ?? row.claim_id) === row.claim_id,
        });
      }
      continue;
    }
    // Retain a known refutation as disputed when its body is redacted. Missing
    // counterevidence is not an independent resolution; expose staleness.
    if (
      row.type === "evidence.created" &&
      (row.direction === "refutes" || row.direction === "fails-to-reproduce")
    ) {
      // Neither a self-declared concession nor payload-supplied independence
      // and elapsed-time flags are authority. Settlement needs the explicit
      // independently verified review below; evidence alone opens a dispute.
      timeline.push({
        kind: "refuting-evidence",
        sequence: row.seq,
        targetVersion: row.target_version,
        evidenceId: row.object_id,
      });
      continue;
    }
    const claim = claims.get(row.target_version);
    if (
      row.type === "review.created" &&
      (row.negative_review === 1 ||
        row.statement_defect === 1 ||
        row.weighted_refutation === 1 ||
        row.weighted_statement_defect === 1) &&
      (!payload || !claim)
    ) {
      // Withholding an adverse review cannot resolve its recorded finding.
      // A statement defect clears only through a new version, not redaction.
      const carriesWeight = row.weighted_refutation === 1 || row.weighted_statement_defect === 1;
      const verdict =
        row.negative_review === 1 || row.weighted_refutation === 1 ? "refute" : "cannot-verify";
      reviewFacets.push({
        targetVersion: row.target_version,
        verdict,
        carriesWeight,
        tier: "T0",
        statementDefect: row.statement_defect === 1 || row.weighted_statement_defect === 1,
      });
      timeline.push({
        kind: "review-created",
        sequence: row.seq,
        targetVersion: row.target_version,
        carriesWeight,
        verdict,
        rubric: row.weighted_statement_defect === 1 ? ["statement-defect"] : undefined,
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
        (payload.selected_hypothesis_id !== undefined && payload.selected_hypothesis_id !== null) ||
        !scientificEvidenceClassEligible(payload)
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
    let carriesWeight = reviewCarriesWeight({
      basis: payload.basis,
      capableOfFailure: payload.capable_of_failure,
      bodyMd: payload.body_md,
    });
    const { tier, legacy } = recordedReviewIndependence(payload, claim.sponsorId, row.sponsor_id);
    if (legacy) legacyReviews++;
    let fullWriteUp = false;
    let artifactEvidenceId: string | undefined;
    let settledRefutation: { evidenceId: string; unansweredHours: number } | undefined;
    let resolvedRefutationEvidenceId: string | undefined;
    let refutationCheck = false;
    if (payload.verification !== undefined && payload.verification !== null) {
      const verification = ScientificVerificationSchema.safeParse(payload.verification);
      const material = verification.success
        ? resolve(
            verification.data.evidence,
            row,
            verification.data.kind === "full-write-up" ? "full-write-up" : "grounding",
          )
        : undefined;
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
        refutationCheck = verification.data.kind === "refutation";
        if (
          verification.data.kind === "refutation" &&
          verification.data.result === "verified" &&
          payload.verdict !== "refute" &&
          payload.verdict !== "fails-to-reproduce"
        )
          throw new ScientificInputError("A refutation check cannot establish positive support.");
        // A historical counterevidence mismatch can discharge that objection;
        // it is excluded from affirmative claim weight below regardless of label.
        if (!refutationCheck) validateSupportingVerification(payload.verdict, assessed);
        fullWriteUp = assessed.fullWriteUp;
        if (assessed.certifiedArtifact) artifactEvidenceId = material.evidenceId;
        if (
          assessed.refutationConfirmed &&
          carriesWeight &&
          !stale &&
          (tier === "T1" || tier === "T2" || tier === "T3") &&
          (payload.verdict === "refute" || payload.verdict === "fails-to-reproduce")
        )
          settledRefutation = confirmedRefutation(row, material);
        if (
          verification.data.kind === "refutation" &&
          verification.data.result === "mismatch" &&
          payload.target_claim_id === row.claim_id &&
          payload.target_version === row.target_version &&
          !withdrawn.withdrawnEvents.has(row.event_id) &&
          carriesWeight &&
          tier !== "T0" &&
          !isNegativeReview(payload)
        )
          resolvedRefutationEvidenceId = material.evidenceId;
      } catch (error) {
        if (!(error instanceof ScientificInputError)) throw error;
        if (!isNegativeReview(payload) && !adverseNovelty) carriesWeight = false;
        markStale(row);
      }
    }
    const provenance = readScientificProvenance(payload.scientific_provenance);
    if (provenance?.method?.evidence.some((reference) => !resolve(reference, row))) {
      if (!isNegativeReview(payload) && !adverseNovelty) carriesWeight = false;
      settledRefutation = undefined;
      resolvedRefutationEvidenceId = undefined;
      markStale(row);
    }
    if (noveltyVerdict !== undefined && carriesWeight && tier !== "T0")
      noveltyVerdicts.add(noveltyVerdict);
    const rubric = Array.isArray(payload.rubric)
      ? (payload.rubric.filter((r) => typeof r === "string") as string[])
      : undefined;
    reviewFacets.push({
      targetVersion: row.target_version,
      verdict: typeof payload.verdict === "string" ? payload.verdict : "cannot-verify",
      statementDefect: hasStatementDefect(rubric),
      // Disproving one counterexample is not independent confirmation of the
      // claim. The same boundary governs the disposition fold below.
      carriesWeight: carriesWeight && !(refutationCheck && !isNegativeReview(payload)),
      tier,
    });
    timeline.push({
      kind: "review-created",
      sequence: row.seq,
      targetVersion: row.target_version,
      carriesWeight:
        resolvedRefutationEvidenceId !== undefined ||
        (carriesWeight && !(refutationCheck && !isNegativeReview(payload))),
      verdict: typeof payload.verdict === "string" ? payload.verdict : "cannot-verify",
      rubric,
      review: {
        review_id: row.object_id,
        reviewer_id: row.fellow_id,
        tier,
        cross_family: tier === "T2" || tier === "T3",
        full_write_up: fullWriteUp,
      },
      artifactEvidenceId,
      confirmedRefutation: settledRefutation,
      resolvedRefutationEvidenceId,
    });
  }
  const folded = computeCurrentClaimDisposition(timeline);
  const transition = folded.lastTransition;
  const transitionSource = transition && rows.find((row) => row.seq === transition.sequence);
  // Current withholding wins over a historical cursor. Never attach an event
  // identity from an envelope whose scientific body was not verified above.
  const verifiedTransition =
    transition && transitionSource && contents.has(transitionSource.event_id)
      ? { ...transition, eventId: transitionSource.event_id }
      : transition;
  const publication = rows
    .filter(
      (row) =>
        (row.type === "claim.created" || row.type === "claim.revised") &&
        row.object_version === folded.currentVersion,
    )
    .at(-1);
  const recordedDisclosure = publication?.directive_disclosure;
  const directiveDisclosure: PublicClaimState["directive_disclosure"] =
    recordedDisclosure === "satisfied" ||
    recordedDisclosure === "missing" ||
    recordedDisclosure === "unresolved"
      ? recordedDisclosure
      : "unavailable";
  // Evidence can establish corroboration independently of sponsor disclosure.
  // The strongest public standing additionally requires complete, current
  // coverage of the exact result lineage. Missing metadata never qualifies.
  const newFinding = noveltyVerdicts.has("new");
  const notNewFinding = [...noveltyVerdicts].some((verdict) => NOT_NEW.has(verdict));
  const novelty: PublicClaimState["novelty"] =
    newFinding && notNewFinding
      ? "contested"
      : notNewFinding
        ? "not-new"
        : noveltyUnavailable
          ? "unresolved"
          : newFinding
            ? "new"
            : noveltyVerdicts.size > 0
              ? "unresolved"
              : "unreviewed";
  return {
    ...folded,
    lastTransition: verifiedTransition,
    disposition:
      folded.disposition === "strongly-supported" && directiveDisclosure !== "satisfied"
        ? "corroborated"
        : folded.disposition,
    stale,
    legacyReviews,
    reviewFacets,
    directiveDisclosure,
    ...(noveltyClaim ? { novelty } : {}),
  };
}
