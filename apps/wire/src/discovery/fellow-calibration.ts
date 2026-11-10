import { RetractionKindSchema } from "@asimposium/contracts";
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
import { foldScientificRows } from "../ledger/scientific-disposition.ts";

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

interface ReleaseCheck {
  statement: D1PreparedStatement;
  expected: number;
}

export interface FellowCalibrationOutcomes {
  readonly selfCorrected: number | null;
  readonly externallyRefuted: number | null;
  readonly survivingReviews: number | null;
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
): ReleaseCheck {
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

async function reviewSurvival(db: D1Database, rows: readonly Source[], fellow: string) {
  if (rows.length === 0) return null;
  if (rows.length > SOURCE_LIMIT) throw new ScientificInputError("Review history is bounded.");
  const groups = new Map<string, { source: Source; reviews: Set<string> }>();
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
    if (payload.verdict !== "confirm" && payload.verdict !== "reproduces") continue;
    const key = `${row.problem_id}/${row.target_claim_id}@${row.target_version}`;
    let group = groups.get(key);
    if (!group) {
      group = { source: row, reviews: new Set() };
      groups.set(key, group);
    }
    group.reviews.add(row.object_id);
  }
  if (groups.size === 0) return null;
  if (groups.size > TARGET_LIMIT)
    throw new ScientificInputError("Review targets exceed the budget.");

  let surviving = 0;
  const checks: ReleaseCheck[] = [];
  for (const { source, reviews } of groups.values()) {
    const version = source.target_version;
    if (version === null) throw new ScientificInputError("Review version is unavailable.");
    const target = `${source.target_claim_id}@${version}`;
    const batch = await db.batch([
      prepareDependencyClosure(db, source.problem_id, source.cursor, target),
      prepareDependencyAssessment(db, source.problem_id, source.cursor, target),
    ]);
    if (batch.length !== 2 || !batch[0]?.success || !batch[1]?.success)
      throw new Error("Calibration scientific snapshot failed.");
    const publications = batch[0].results as DependencyClosureRow[];
    const science = batch[1].results as DependencyScientificRow[];
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
    if (!closure.complete || !root?.standing.complete)
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
    checks.push({
      statement: recheck(db, witnesses),
      expected: new Set(witnesses.map((item) => item.event)).size,
    });
    // An old version, inactive or contested premise cannot earn current support.
    // This is the same dependency policy used by claim faces and honors.
    if (!root.chain.complete) continue;
    const timeline = science
      .filter((row) => row.claim_id === source.target_claim_id && row.target_version <= version)
      .map((row) => {
        const statement = contents.get(row.event_id)?.statement;
        return { ...row, statement: typeof statement === "string" ? statement : null };
      });
    const fold = await foldScientificRows(timeline);
    if (fold.stale || fold.currentVersion !== source.target_version)
      throw new ScientificInputError("Review scientific standing is stale.");
    surviving += distinctSupportingReviews(fold.context.verified_reviews).filter(
      (review) =>
        review.reviewer_id === fellow && review.tier !== "T0" && reviews.has(review.review_id),
    ).length;
  }
  // Recheck admission sources too, including non-confirming reviews whose
  // availability determines whether this is a complete calibration record.
  checks.push({ statement: recheck(db, rows.map(witness)), expected: rows.length });
  return { surviving, checks };
}

/** Fable §9.5: calibration is scientific readback, not a count of verdict labels.
 * The immutable log supplies correction credit; the canonical exact-version
 * scientific/dependency fold supplies surviving independent confirmation.
 */
export async function loadFellowCalibration(
  db: D1Database,
  fellow: string,
): Promise<FellowCalibrationOutcomes> {
  const batch = await db.batch([sources(db, fellow, "retraction"), sources(db, fellow, "review")]);
  if (batch.length !== 2 || !batch[0]?.success || !batch[1]?.success)
    throw new Error("Calibration admissions failed.");
  let corrections: Awaited<ReturnType<typeof correctionOutcomes>> = null;
  let reviews: Awaited<ReturnType<typeof reviewSurvival>> = null;
  const omitted: string[] = [];
  try {
    corrections = await correctionOutcomes(db, batch[0].results as Source[]);
  } catch (error) {
    if (!(error instanceof ScientificInputError)) throw error;
    omitted.push(
      "correction calibration unavailable: complete attributed public event history was not established within the read budget",
    );
  }
  try {
    reviews = await reviewSurvival(db, batch[1].results as Source[], fellow);
  } catch (error) {
    if (!(error instanceof ScientificInputError)) throw error;
    omitted.push(
      "review survival unavailable: complete current scientific support was not established within the read budget",
    );
  }
  const checks = [
    ...(corrections
      ? [
          ...corrections.checks,
          admissionCheck(db, fellow, "retraction", batch[0].results.length),
        ].map((check) => ({ ...check, outcome: "corrections" as const }))
      : []),
    ...(reviews
      ? [...reviews.checks, admissionCheck(db, fellow, "review", batch[1].results.length)].map(
          (check) => ({ ...check, outcome: "reviews" as const }),
        )
      : []),
  ];
  if (checks.length > 0) {
    // Both outcomes share the final transaction. In particular, correction
    // credit cannot escape a hide while scientific review histories are read.
    const released = await db.batch(checks.map((check) => check.statement));
    if (released.length !== checks.length || released.some((result) => !result.success))
      throw new Error("Calibration release check failed.");
    for (const [index, check] of checks.entries()) {
      if (
        (released[index]?.results[0] as { matched?: number } | undefined)?.matched ===
        check.expected
      )
        continue;
      if (check.outcome === "corrections") corrections = null;
      else reviews = null;
    }
    if (
      (corrections === null && checks.some((check) => check.outcome === "corrections")) ||
      (reviews === null && checks.some((check) => check.outcome === "reviews"))
    )
      omitted.push(
        "calibration outcomes affected by changed public sources are unavailable; retry the current Fellow card",
      );
  }
  return {
    selfCorrected: corrections?.selfCorrected ?? null,
    externallyRefuted: corrections?.externallyRefuted ?? null,
    survivingReviews: reviews?.surviving ?? null,
    omitted,
  };
}
