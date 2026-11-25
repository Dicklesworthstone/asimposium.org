import {
  ClaimDependencyPinsSchema,
  type FellowClaimsByKindAndDisposition,
  type FellowDispositionCounts,
  type FellowReviewOutcome,
  RetractionKindSchema,
} from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import {
  composeDependencyAssessment,
  type DependencyScientificRow,
  prepareDependencyAssessment,
} from "../ledger/claim-dependency-assessment.ts";
import {
  composeDependencyClosure,
  type DependencyClosureRow,
  prepareDependencyClosure,
} from "../ledger/claim-dependency-closure.ts";
import { distinctSupportingReviews } from "../ledger/dispositions.ts";
import { checkedScientificPayload, ScientificInputError } from "../ledger/scientific-checks.ts";
import { withPremiseStaleness } from "../ledger/scientific-dependencies.ts";
import { foldScientificRows } from "../ledger/scientific-disposition.ts";
import {
  isNegativeReview,
  scientificInputEffects,
} from "../ledger/scientific-withdrawal-effects.ts";
import { claimInputStatuses } from "../sessions/claim-input-status.ts";

// These are whole-record budgets, not silently truncated lifetime totals.
// Large or unverifiable histories leave their calibration outcome unavailable.
const SOURCE_LIMIT = 100;
const TARGET_LIMIT = 16;
const ITEM_BYTES = 65_536;
const SOURCE_BYTES = 262_144;

interface Source {
  event_id: string;
  problem_id: string;
  cursor: number;
  seq: number;
  object_id: string;
  payload_sha256: string;
  payload_json: string | null;
  fellow_id: string;
  sponsor_id: string | null;
  session_id: string | null;
  target_claim_id: string | null;
  target_version: number | null;
}

interface Witness {
  event: string;
  problem: string;
  cursor: number;
  seq: number;
  digest: string;
  body: string;
}

export interface FellowCalibrationReleaseCheck {
  readonly statement: D1PreparedStatement;
  readonly expected: number;
}

export interface FellowCalibrationOutcomes {
  readonly selfCorrected: number | null;
  readonly externallyRefuted: number | null;
  readonly survivingReviews: number | null;
  readonly claimsByKindAndDisposition: FellowClaimsByKindAndDisposition | null;
  readonly reviewOutcomes: ReadonlyMap<string, FellowReviewOutcome>;
  readonly omitted: readonly string[];
}

const publicProblem = (alias: string) => `${alias}.status <> 'private-draft'
  AND ${alias}.unlisted = 0
  AND NOT ${hiddenByContentControlSql(`${alias}.id`, "'problem'")}
  AND NOT ${hiddenByContentControlSql(`${alias}.id`, `${alias}.id`)}`;

function sources(db: D1Database, fellow: string, kind: "review" | "retraction") {
  return db
    .prepare(`WITH admitted AS MATERIALIZED (
      SELECT e.id AS event_id,e.problem_id,p.public_seq AS cursor,e.seq,e.object_id,e.object_version,
        e.payload_sha256,e.actor_fellow_id AS fellow_id,e.actor_sponsor_id AS sponsor_id,
        e.actor_session_id AS session_id,r.target_claim_id,r.target_version
      FROM events e JOIN problems p ON p.id=e.problem_id
      LEFT JOIN reviews r ON r.source_event_id=e.id AND r.problem_id=e.problem_id
        AND r.review_id=e.object_id AND r.source_seq=e.seq
        AND r.reviewer_fellow_id=e.actor_fellow_id
      WHERE e.actor_fellow_id=? AND e.object_kind=? AND e.type=? AND e.seq<=p.public_seq
        AND ${publicProblem("p")}
      ORDER BY e.problem_id,e.seq,e.id LIMIT ${SOURCE_LIMIT + 1}
    ), candidates AS MATERIALIZED (
      SELECT a.*,CASE WHEN c.redacted_at IS NULL AND NOT ${eventContentHiddenSql("a")}
        THEN length(CAST(c.payload_json AS BLOB)) END AS bytes
      FROM admitted a LEFT JOIN event_content c
        ON c.event_id=a.event_id AND c.payload_sha256=a.payload_sha256
    ), bounded AS MATERIALIZED (
      SELECT *,SUM(COALESCE(bytes,0)) OVER (ORDER BY problem_id,seq,event_id) AS total_bytes
      FROM candidates
    ) SELECT b.*,CASE WHEN b.bytes<=${ITEM_BYTES} AND b.total_bytes<=${SOURCE_BYTES}
      THEN c.payload_json END AS payload_json
    FROM bounded b LEFT JOIN event_content c ON c.event_id=b.event_id
      AND c.payload_sha256=b.payload_sha256 AND c.redacted_at IS NULL
    ORDER BY b.problem_id,b.seq,b.event_id`)
    .bind(fellow, kind, kind === "review" ? "review.created" : "object.retracted");
}

function witness(row: Source): Witness {
  if (row.payload_json === null) throw new ScientificInputError("Calibration source unavailable.");
  return {
    event: row.event_id,
    problem: row.problem_id,
    cursor: row.cursor,
    seq: row.seq,
    digest: row.payload_sha256,
    body: row.payload_json,
  };
}

/** The final transaction rechecks the exact scientific bytes and public cuts.
 * A concurrent withdrawal, correction or hide cannot leave favorable credit
 * on a response computed just before it. No body is returned by this check. */
function recheck(db: D1Database, witnesses: readonly Witness[]): D1PreparedStatement {
  const unique = new Map(witnesses.map((item) => [item.event, item]));
  const encoded = JSON.stringify([...unique.values()]);
  if (new TextEncoder().encode(encoded).byteLength > 1024 * 1024)
    throw new ScientificInputError("Calibration source check exceeds its budget.");
  return db
    .prepare(`WITH pins(j) AS (VALUES (?))
    SELECT COUNT(*) AS matched FROM pins,json_each(pins.j) pin
    JOIN events e ON e.id=json_extract(pin.value,'$.event')
      AND e.problem_id=json_extract(pin.value,'$.problem')
      AND e.seq=json_extract(pin.value,'$.seq')
      AND e.payload_sha256=json_extract(pin.value,'$.digest')
    JOIN problems p ON p.id=e.problem_id AND p.public_seq=json_extract(pin.value,'$.cursor')
    JOIN event_content c ON c.event_id=e.id AND c.payload_sha256=e.payload_sha256
      AND c.payload_json=json_extract(pin.value,'$.body') AND c.redacted_at IS NULL
    WHERE ${publicProblem("p")} AND NOT ${eventContentHiddenSql("e")}`)
    .bind(encoded);
}

function admissionCheck(
  db: D1Database,
  fellow: string,
  kind: "review" | "retraction",
  expected: number,
): FellowCalibrationReleaseCheck {
  // A new publication on a different problem must invalidate the aggregate,
  // too. The per-problem cursor witnesses alone cannot detect that insertion.
  return {
    statement: db
      .prepare(`SELECT COUNT(*) AS matched FROM (
        SELECT e.id FROM events e JOIN problems p ON p.id=e.problem_id
        WHERE e.actor_fellow_id=? AND e.object_kind=? AND e.type=?
          AND e.seq<=p.public_seq AND ${publicProblem("p")}
        LIMIT ${SOURCE_LIMIT + 1})`)
      .bind(fellow, kind, kind === "review" ? "review.created" : "object.retracted"),
    expected,
  };
}

async function correctionOutcomes(db: D1Database, rows: readonly Source[]) {
  if (rows.length === 0) return null;
  if (rows.length > SOURCE_LIMIT) throw new ScientificInputError("Correction history is bounded.");
  let selfCorrected = 0;
  let externallyRefuted = 0;
  for (const row of rows) {
    if (row.payload_json === null || !row.sponsor_id || !row.session_id)
      throw new ScientificInputError("Correction attribution is unavailable.");
    const payload = await checkedScientificPayload({ ...row, payload_json: row.payload_json });
    const kind = RetractionKindSchema.safeParse(payload.retraction_kind);
    if (
      payload.retraction_id !== row.object_id ||
      typeof payload.target_object !== "string" ||
      !kind.success
    )
      throw new ScientificInputError("Correction source is inconsistent.");
    if (kind.data === "self-corrected") selfCorrected++;
    else externallyRefuted++;
  }
  return {
    selfCorrected,
    externallyRefuted,
    checks: [{ statement: recheck(db, rows.map(witness)), expected: rows.length }],
  };
}

interface TargetSnapshot {
  readonly publications: DependencyClosureRow[];
  readonly science: DependencyScientificRow[];
}

interface ReviewTargetSpec {
  readonly key: string;
  readonly source: Source;
  readonly reviews: Map<string, Source>;
  confirming: boolean;
}

/** Confirming targets keep the aggregate budget. Other verdicts fill the
 * remaining slots for per-review readback inside the same snapshot batch. */
async function prepareReviewTargets(
  rows: readonly Source[],
): Promise<Map<string, ReviewTargetSpec> | null> {
  if (rows.length === 0) return null;
  if (rows.length > SOURCE_LIMIT) throw new ScientificInputError("Review history is bounded.");
  const groups = new Map<string, ReviewTargetSpec>();
  for (const row of rows) {
    if (row.payload_json === null || !row.sponsor_id || !row.session_id)
      throw new ScientificInputError("Review attribution is unavailable.");
    const payload = await checkedScientificPayload({ ...row, payload_json: row.payload_json });
    if (
      payload.target_claim_id !== row.target_claim_id ||
      payload.target_version !== row.target_version ||
      row.target_claim_id === null ||
      row.target_version === null
    )
      throw new ScientificInputError("Review target is unavailable.");
    const key = `${row.problem_id}/${row.target_claim_id}@${row.target_version}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, source: row, reviews: new Map(), confirming: false };
      groups.set(key, group);
    }
    if (group.reviews.has(row.object_id))
      throw new ScientificInputError("Review source is duplicated.");
    group.reviews.set(row.object_id, row);
    if (payload.verdict === "confirm" || payload.verdict === "reproduces") group.confirming = true;
  }
  const confirming = [...groups.values()].filter((group) => group.confirming);
  if (confirming.length > TARGET_LIMIT)
    throw new ScientificInputError("Review targets exceed the budget.");
  // Preserve the aggregate's existing target budget. Other verdicts fill the
  // remaining slots for per-review readback, without extra per-item queries.
  const selected = [
    ...confirming,
    ...[...groups.values()].filter((group) => !group.confirming),
  ].slice(0, TARGET_LIMIT);
  if (selected.length === 0) return null;
  return new Map(selected.map((group) => [group.key, group]));
}

async function evaluateReviewSurvival(
  db: D1Database,
  rows: readonly Source[],
  groups: Map<string, ReviewTargetSpec>,
  snapshots: Map<string, TargetSnapshot>,
  fellow: string,
) {
  let surviving = 0;
  let survivalUnavailable = false;
  const outcomes = new Map<string, FellowReviewOutcome>();
  const checks: FellowCalibrationReleaseCheck[] = [];
  const confirmingCount = [...groups.values()].filter((group) => group.confirming).length;
  for (const group of groups.values()) {
    const { key, source, reviews } = group;
    const fencedWithdrawals = new Set<string>();
    try {
      const version = source.target_version;
      if (version === null) throw new ScientificInputError("Review version is unavailable.");
      const target = `${source.target_claim_id}@${version}`;
      const snap = snapshots.get(key);
      if (!snap) throw new Error("Calibration scientific snapshot failed.");
      const { publications, science } = snap;
      const inputStatuses = await claimInputStatuses(
        science,
        source.problem_id,
        target,
        source.cursor,
      );
      const withdrawalWitnesses: Witness[] = [];
      const withdrawnReviews: string[] = [];
      for (const review of reviews.values()) {
        const status = inputStatuses.forRecord(
          review.event_id,
          review.object_id,
          "review",
          review.payload_sha256,
        );
        if (status.withdrawal !== "withdrawn" || !status.withdrawal_event) continue;
        const withdrawal = science.find((row) => row.event_id === status.withdrawal_event?.id);
        if (!withdrawal?.payload_json) continue;
        await checkedScientificPayload({ ...withdrawal, payload_json: withdrawal.payload_json });
        withdrawalWitnesses.push({
          event: withdrawal.event_id,
          problem: source.problem_id,
          cursor: source.cursor,
          seq: withdrawal.seq,
          digest: withdrawal.payload_sha256,
          body: withdrawal.payload_json,
        });
        withdrawnReviews.push(`${review.problem_id}/${review.object_id}`);
      }
      // A stale target may prevent the full scientific check below. Register
      // each withdrawal's exact source fence before retaining any display fact.
      // Withheld explanations remove this display fact, never restore support.
      if (withdrawalWitnesses.length > 0) {
        checks.push({
          statement: recheck(db, withdrawalWitnesses),
          expected: new Set(withdrawalWitnesses.map((item) => item.event)).size,
        });
        for (const withdrawnKey of withdrawnReviews) {
          fencedWithdrawals.add(withdrawnKey);
          outcomes.set(withdrawnKey, { status: "unavailable", withdrawn: true });
        }
      }
      const closure = await composeDependencyClosure(publications, source.problem_id, target);
      const assessments = await composeDependencyAssessment(
        publications,
        closure,
        science,
        source.problem_id,
        target,
        source.cursor,
      );
      const root = assessments.get(target);
      if (
        !closure.complete ||
        !root?.standing.complete ||
        root.standing.disposition === null ||
        root.standing.disposition === "draft" ||
        root.standing.review_state === null ||
        root.standing.latest_version === null
      )
        throw new ScientificInputError("Review outcome history is unavailable.");
      const contents = new Map<string, Record<string, unknown>>();
      const witnesses: Witness[] = [];
      for (const row of science) {
        if (row.payload_json === null)
          throw new ScientificInputError("Review scientific source is unavailable.");
        const payload = await checkedScientificPayload({ ...row, payload_json: row.payload_json });
        contents.set(row.event_id, payload);
        witnesses.push({
          event: row.event_id,
          problem: source.problem_id,
          cursor: source.cursor,
          seq: row.seq,
          digest: row.payload_sha256,
          body: row.payload_json,
        });
      }
      const timeline = science
        .filter((row) => row.claim_id === source.target_claim_id && row.target_version <= version)
        .map((row) => {
          const statement = contents.get(row.event_id)?.statement;
          return { ...row, statement: typeof statement === "string" ? statement : null };
        });
      const fold = await foldScientificRows(timeline);
      if (fold.stale || fold.currentVersion !== version)
        throw new ScientificInputError("Review scientific standing is stale.");
      const publication = publications[0];
      const pins = ClaimDependencyPinsSchema.safeParse(
        publication && contents.get(publication.event_id)?.dependency_pins,
      );
      if (!pins.success) throw new ScientificInputError("Review premise history is unavailable.");
      const state = withPremiseStaleness(fold, pins.data, assessments, closure.complete);
      const effects = scientificInputEffects(timeline, contents);
      // An old version, inactive or contested premise cannot earn current
      // support. Exact historical standing still remains readable below.
      const retained = new Set(
        (root.chain.complete ? distinctSupportingReviews(fold.context.verified_reviews) : [])
          .filter((review) => {
            const original = reviews.get(review.review_id);
            const verdict = original && contents.get(original.event_id)?.verdict;
            return (
              review.reviewer_id === fellow &&
              review.tier !== "T0" &&
              (verdict === "confirm" || verdict === "reproduces")
            );
          })
          .map((review) => review.review_id),
      );
      surviving += retained.size;
      for (const review of reviews.values()) {
        const original = timeline.find((row) => row.event_id === review.event_id);
        const payload = contents.get(review.event_id);
        if (
          original?.type !== "review.created" ||
          !payload ||
          original.object_id !== review.object_id ||
          original.seq !== review.seq ||
          original.payload_sha256 !== review.payload_sha256 ||
          original.payload_json !== review.payload_json ||
          original.fellow_id !== review.fellow_id ||
          original.sponsor_id !== review.sponsor_id
        )
          throw new ScientificInputError("Review outcome does not match its source.");
        outcomes.set(`${review.problem_id}/${review.object_id}`, {
          status: "available",
          through: source.cursor,
          disposition: root.standing.disposition,
          review_state: root.standing.review_state,
          latest_version: root.standing.latest_version,
          stale: state.stale,
          withdrawn: effects.withdrawnEvents.has(review.event_id),
          contribution: isNegativeReview(payload)
            ? "adverse-finding"
            : retained.has(review.object_id)
              ? "independent-support"
              : payload.verdict === "confirm" || payload.verdict === "reproduces"
                ? "no-current-support"
                : "recorded",
        });
      }
      checks.push({
        statement: recheck(db, witnesses),
        expected: new Set(witnesses.map((item) => item.event)).size,
      });
    } catch (error) {
      if (!(error instanceof ScientificInputError)) throw error;
      if (group.confirming) survivalUnavailable = true;
      // A known withdrawal survives a stale target only when its exact
      // publication is covered by the final release transaction.
      for (const review of reviews.values()) {
        const outcomeKey = `${review.problem_id}/${review.object_id}`;
        if (fencedWithdrawals.has(outcomeKey))
          outcomes.set(outcomeKey, { status: "unavailable", withdrawn: true });
        else outcomes.delete(outcomeKey);
      }
    }
  }
  // Recheck admission sources too, including non-confirming reviews whose
  // availability determines whether this is a complete calibration record.
  checks.push({ statement: recheck(db, rows.map(witness)), expected: rows.length });
  return {
    surviving: survivalUnavailable || confirmingCount === 0 ? null : surviving,
    unavailable: survivalUnavailable,
    outcomes,
    checks,
  };
}

interface AuthoredClaimSource {
  problem_id: string;
  claim_id: string;
  kind: string;
  cursor: number;
  latest_version: number | null;
}

function emptyDispositionCounts(): FellowDispositionCounts {
  return {
    open: 0,
    corroborated: 0,
    "strongly-supported": 0,
    disputed: 0,
    refuted: 0,
    "reduced-to": 0,
    withdrawn: 0,
    malformed: 0,
    superseded: 0,
  };
}

function emptyClaimsByKindAndDisposition(): FellowClaimsByKindAndDisposition {
  return {
    conjecture: emptyDispositionCounts(),
    theorem_attempt: emptyDispositionCounts(),
    other: emptyDispositionCounts(),
  };
}

function claimKindBucket(kind: string): keyof FellowClaimsByKindAndDisposition {
  if (kind === "conjecture") return "conjecture";
  if (kind === "theorem" || kind === "theorem-attempt" || kind === "lemma") {
    return "theorem_attempt";
  }
  return "other";
}

function authoredClaimSources(db: D1Database, fellow: string) {
  return db
    .prepare(`SELECT cv.problem_id, cv.claim_id,
      COALESCE(
        (SELECT lv.kind FROM claim_versions lv
          JOIN events lev ON lev.problem_id = lv.problem_id AND lev.object_id = lv.claim_id
            AND lev.object_version = lv.version AND lev.object_kind = 'claim'
            AND lev.type IN ('claim.created', 'claim.revised') AND lev.seq <= p.public_seq
            AND NOT ${eventContentHiddenSql("lev")}
            AND EXISTS (SELECT 1 FROM event_content lec WHERE lec.event_id = lev.id
              AND lec.payload_sha256 = lev.payload_sha256 AND lec.redacted_at IS NULL)
          WHERE lv.problem_id = cv.problem_id AND lv.claim_id = cv.claim_id
          ORDER BY lv.version DESC LIMIT 1),
        cv.kind
      ) AS kind,
      p.public_seq AS cursor,
      (SELECT MAX(v.version) FROM claim_versions v
        JOIN events ev ON ev.problem_id = v.problem_id AND ev.object_id = v.claim_id
          AND ev.object_version = v.version AND ev.object_kind = 'claim'
          AND ev.type IN ('claim.created', 'claim.revised') AND ev.seq <= p.public_seq
          AND NOT ${eventContentHiddenSql("ev")}
          AND EXISTS (SELECT 1 FROM event_content ec WHERE ec.event_id = ev.id
            AND ec.payload_sha256 = ev.payload_sha256 AND ec.redacted_at IS NULL)
        WHERE v.problem_id = cv.problem_id AND v.claim_id = cv.claim_id) AS latest_version
      FROM claim_versions cv
      JOIN problems p ON p.id = cv.problem_id AND ${publicProblem("p")}
      WHERE cv.editor_fellow_id = ? AND cv.version = 1
        AND EXISTS (SELECT 1 FROM events e
          WHERE e.problem_id = cv.problem_id AND e.object_id = cv.claim_id
            AND e.object_version = 1 AND e.object_kind = 'claim'
            AND e.type = 'claim.created' AND e.actor_fellow_id = cv.editor_fellow_id
            AND e.actor_sponsor_id IS NOT NULL AND e.seq <= p.public_seq
            AND NOT ${eventContentHiddenSql("e")}
            AND EXISTS (SELECT 1 FROM event_content c WHERE c.event_id = e.id
              AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL))
      ORDER BY cv.problem_id, cv.claim_id
      LIMIT ${TARGET_LIMIT + 1}`)
    .bind(fellow);
}

function authoredClaimsAdmissionCheck(
  db: D1Database,
  fellow: string,
  expected: number,
): FellowCalibrationReleaseCheck {
  return {
    statement: db
      .prepare(`SELECT COUNT(*) AS matched FROM (
        SELECT cv.claim_id FROM claim_versions cv
        JOIN problems p ON p.id = cv.problem_id AND ${publicProblem("p")}
        WHERE cv.editor_fellow_id = ? AND cv.version = 1
          AND EXISTS (SELECT 1 FROM events e
            WHERE e.problem_id = cv.problem_id AND e.object_id = cv.claim_id
              AND e.object_version = 1 AND e.object_kind = 'claim'
              AND e.type = 'claim.created' AND e.actor_fellow_id = cv.editor_fellow_id
              AND e.actor_sponsor_id IS NOT NULL AND e.seq <= p.public_seq
              AND NOT ${eventContentHiddenSql("e")}
              AND EXISTS (SELECT 1 FROM event_content c WHERE c.event_id = e.id
                AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL))
        LIMIT ${TARGET_LIMIT + 1})`)
      .bind(fellow),
    expected,
  };
}

async function evaluateClaimDispositionsByKind(
  db: D1Database,
  rows: readonly AuthoredClaimSource[],
  snapshots: Map<string, TargetSnapshot>,
): Promise<{
  readonly counts: FellowClaimsByKindAndDisposition;
  readonly checks: readonly FellowCalibrationReleaseCheck[];
}> {
  const counts = emptyClaimsByKindAndDisposition();
  if (rows.length === 0) return { counts, checks: [] };
  if (rows.length > TARGET_LIMIT) {
    throw new ScientificInputError("Authored claims exceed the bounded calibration budget.");
  }
  const checks: FellowCalibrationReleaseCheck[] = [];
  for (const row of rows) {
    if (row.latest_version === null || !Number.isSafeInteger(row.latest_version)) {
      throw new ScientificInputError("Claim head version is unavailable.");
    }
    const target = `${row.claim_id}@${row.latest_version}`;
    const key = `${row.problem_id}/${target}`;
    const snap = snapshots.get(key);
    if (!snap) {
      throw new Error("Calibration claim disposition snapshot failed.");
    }
    const { publications, science } = snap;
    const closure = await composeDependencyClosure(publications, row.problem_id, target);
    const assessments = await composeDependencyAssessment(
      publications,
      closure,
      science,
      row.problem_id,
      target,
      row.cursor,
    );
    const root = assessments.get(target);
    if (!closure.complete || !root?.standing.complete) {
      throw new ScientificInputError("Claim disposition history is unavailable.");
    }
    const contents = new Map<string, Record<string, unknown>>();
    const witnesses: Witness[] = [];
    for (const item of science) {
      if (item.payload_json === null) {
        throw new ScientificInputError("Claim scientific source is unavailable.");
      }
      const payload = await checkedScientificPayload({ ...item, payload_json: item.payload_json });
      contents.set(item.event_id, payload);
      witnesses.push({
        event: item.event_id,
        problem: row.problem_id,
        cursor: row.cursor,
        seq: item.seq,
        digest: item.payload_sha256,
        body: item.payload_json,
      });
    }
    checks.push({
      statement: recheck(db, witnesses),
      expected: new Set(witnesses.map((item) => item.event)).size,
    });
    const timeline = science
      .filter(
        (item) => item.claim_id === row.claim_id && item.target_version <= row.latest_version!,
      )
      .map((item) => {
        const statement = contents.get(item.event_id)?.statement;
        return { ...item, statement: typeof statement === "string" ? statement : null };
      });
    const fold = await foldScientificRows(timeline);
    if (fold.stale || fold.currentVersion !== row.latest_version) {
      throw new ScientificInputError("Claim scientific standing is stale.");
    }
    const bucket = claimKindBucket(row.kind);
    const disp = fold.disposition;
    if (disp !== "draft" && disp in counts[bucket]) {
      counts[bucket][disp as keyof FellowDispositionCounts] += 1;
    }
  }
  return { counts, checks };
}

/** Fable §9.5: calibration is scientific readback, not a count of verdict labels.
 * The immutable log supplies correction credit; the canonical exact-version
 * scientific/dependency fold supplies surviving independent confirmation and
 * claim dispositions separated by kind (conjectures vs theorem-attempts).
 */
export async function loadFellowCalibration(
  db: D1Database,
  fellow: string,
  cardReleaseChecks: readonly FellowCalibrationReleaseCheck[] = [],
): Promise<FellowCalibrationOutcomes> {
  // Batch 1: read all three bounded admission lists together.
  const batch = await db.batch([
    sources(db, fellow, "retraction"),
    sources(db, fellow, "review"),
    authoredClaimSources(db, fellow),
  ]);
  if (batch.length !== 3 || !batch[0]?.success || !batch[1]?.success || !batch[2]?.success)
    throw new Error("Calibration admissions failed.");
  const retractionRows = batch[0].results as Source[];
  const reviewRows = batch[1].results as Source[];
  const authoredRows = batch[2].results as AuthoredClaimSource[];

  let corrections: Awaited<ReturnType<typeof correctionOutcomes>> = null;
  let reviews: Awaited<ReturnType<typeof evaluateReviewSurvival>> | null = null;
  let claimDispositions: Awaited<ReturnType<typeof evaluateClaimDispositionsByKind>> | null = null;
  const omitted: string[] = [];

  try {
    corrections = await correctionOutcomes(db, retractionRows);
  } catch (error) {
    if (!(error instanceof ScientificInputError)) throw error;
    omitted.push(
      "correction calibration unavailable: complete attributed public event history was not established within the read budget",
    );
  }

  let reviewGroups: Map<string, ReviewTargetSpec> | null = null;
  let reviewBudgetFailed = false;
  try {
    reviewGroups = await prepareReviewTargets(reviewRows);
  } catch (error) {
    if (!(error instanceof ScientificInputError)) throw error;
    reviewBudgetFailed = true;
    omitted.push(
      "review survival unavailable: complete current scientific support was not established within the read budget",
    );
  }

  let claimsBudgetFailed = false;
  const validAuthoredTargets: {
    key: string;
    problemId: string;
    cursor: number;
    target: string;
  }[] = [];
  if (authoredRows.length > TARGET_LIMIT) {
    claimsBudgetFailed = true;
    omitted.push(
      "claim disposition breakdown unavailable: authored claim history exceeded the bounded calibration budget or lacked complete public sources",
    );
  } else {
    for (const row of authoredRows) {
      if (row.latest_version === null || !Number.isSafeInteger(row.latest_version)) {
        claimsBudgetFailed = true;
        omitted.push(
          "claim disposition breakdown unavailable: authored claim history exceeded the bounded calibration budget or lacked complete public sources",
        );
        break;
      }
      const target = `${row.claim_id}@${row.latest_version}`;
      validAuthoredTargets.push({
        key: `${row.problem_id}/${target}`,
        problemId: row.problem_id,
        cursor: row.cursor,
        target,
      });
    }
  }

  // Batch 2: fetch every unique review and authored-claim dependency snapshot in ONE round-trip.
  const targetRequests = new Map<string, { problemId: string; cursor: number; target: string }>();
  if (reviewGroups) {
    for (const { key, source } of reviewGroups.values()) {
      if (source.target_version !== null && source.target_claim_id !== null) {
        targetRequests.set(key, {
          problemId: source.problem_id,
          cursor: source.cursor,
          target: `${source.target_claim_id}@${source.target_version}`,
        });
      }
    }
  }
  if (!claimsBudgetFailed) {
    for (const item of validAuthoredTargets) {
      if (!targetRequests.has(item.key)) {
        targetRequests.set(item.key, {
          problemId: item.problemId,
          cursor: item.cursor,
          target: item.target,
        });
      }
    }
  }

  const snapshots = new Map<string, TargetSnapshot>();
  if (targetRequests.size > 0) {
    const entries = [...targetRequests.entries()];
    const statements = entries.flatMap(([, req]) => [
      prepareDependencyClosure(db, req.problemId, req.cursor, req.target),
      prepareDependencyAssessment(db, req.problemId, req.cursor, req.target),
    ]);
    const results = await db.batch(statements);
    if (results.length !== statements.length || results.some((r) => !r.success)) {
      throw new Error("Calibration scientific snapshot failed.");
    }
    for (const [index, [key]] of entries.entries()) {
      snapshots.set(key, {
        publications: results[index * 2]!.results as DependencyClosureRow[],
        science: results[index * 2 + 1]!.results as DependencyScientificRow[],
      });
    }
  }

  if (reviewGroups && !reviewBudgetFailed) {
    try {
      reviews = await evaluateReviewSurvival(db, reviewRows, reviewGroups, snapshots, fellow);
      if (reviews.unavailable)
        omitted.push(
          "review survival unavailable: complete current scientific support was not established within the read budget",
        );
    } catch (error) {
      if (!(error instanceof ScientificInputError)) throw error;
      omitted.push(
        "review survival unavailable: complete current scientific support was not established within the read budget",
      );
    }
  }

  if (!claimsBudgetFailed) {
    try {
      claimDispositions = await evaluateClaimDispositionsByKind(db, authoredRows, snapshots);
    } catch (error) {
      if (!(error instanceof ScientificInputError)) throw error;
      omitted.push(
        "claim disposition breakdown unavailable: authored claim history exceeded the bounded calibration budget or lacked complete public sources",
      );
    }
  }

  const checks = [
    ...(corrections
      ? [
          ...corrections.checks,
          admissionCheck(db, fellow, "retraction", retractionRows.length),
        ].map((check) => ({ ...check, outcome: "corrections" as const }))
      : []),
    ...(reviews
      ? [...reviews.checks, admissionCheck(db, fellow, "review", reviewRows.length)].map(
          (check) => ({ ...check, outcome: "reviews" as const }),
        )
      : []),
    ...(claimDispositions
      ? [
          ...claimDispositions.checks,
          authoredClaimsAdmissionCheck(db, fellow, authoredRows.length),
        ].map((check) => ({ ...check, outcome: "claims" as const }))
      : []),
  ];
  if (checks.length > 0 || cardReleaseChecks.length > 0) {
    // All outcomes share the final release transaction. In particular, correction
    // credit cannot escape a hide while scientific review histories are read.
    // A containing Fellow card releases its captured history and identity in
    // this same snapshot; a later card-only check would reopen that race.
    const released = await db.batch(
      [...checks, ...cardReleaseChecks].map((check) => check.statement),
    );
    if (
      released.length !== checks.length + cardReleaseChecks.length ||
      released.some((result) => !result.success)
    )
      throw new Error("Calibration release check failed.");
    for (const [index, check] of cardReleaseChecks.entries()) {
      if (
        (released[checks.length + index]?.results[0] as { matched?: number } | undefined)
          ?.matched !== check.expected
      )
        throw new Error("Fellow card sources changed before release.");
    }
    for (const [index, check] of checks.entries()) {
      if (
        (released[index]?.results[0] as { matched?: number } | undefined)?.matched ===
        check.expected
      )
        continue;
      if (check.outcome === "corrections") corrections = null;
      else if (check.outcome === "reviews") reviews = null;
      else claimDispositions = null;
    }
    if (
      (corrections === null && checks.some((check) => check.outcome === "corrections")) ||
      (reviews === null && checks.some((check) => check.outcome === "reviews")) ||
      (claimDispositions === null && checks.some((check) => check.outcome === "claims"))
    )
      omitted.push(
        "calibration outcomes affected by changed public sources are unavailable; retry the current Fellow card",
      );
  }
  return {
    selfCorrected: corrections?.selfCorrected ?? null,
    externallyRefuted: corrections?.externallyRefuted ?? null,
    survivingReviews: reviews?.surviving ?? null,
    claimsByKindAndDisposition: claimDispositions?.counts ?? null,
    reviewOutcomes: reviews?.outcomes ?? new Map(),
    omitted,
  };
}
