import {
  type ClaimDependencyPin,
  ClaimDependencyPinSchema,
  ProblemGovernanceEventSchema,
  type ProblemNoClaimBoundary,
  type ProblemResolutionDirection,
  type SynthesisItem,
  SynthesisItemSchema,
} from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  directiveDisclosureCompleteSql,
  directiveDisclosureLineageSql,
  directiveDisclosureStatusSql,
} from "../directives/disclosure-store.ts";
import { canonicalJson } from "../krater/krater.ts";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import {
  composeDependencyAssessment,
  DEPENDENCY_SCIENCE_ROW_LIMIT,
  type DependencyScientificRow,
  prepareDependencyAssessment,
} from "../ledger/claim-dependency-assessment.ts";
import {
  composeDependencyClosure,
  DEPENDENCY_CLOSURE_LIMIT,
  DEPENDENCY_CLOSURE_SQL,
  type DependencyClosureRow,
  prepareDependencyClosure,
} from "../ledger/claim-dependency-closure.ts";
import {
  type PublishedProblemFormulation,
  readPublishedProblemFormulation,
} from "../ledger/problem-formulation-read.ts";
import { checkedScientificPayload } from "../ledger/scientific-checks.ts";
import { readSynthesisPage } from "../ledger/synthesis-read.ts";
import type { SynthesisAnchorSource } from "../ledger/synthesis-references.ts";

const MAX_SOURCE_BYTES = 65_536;
// A single bounded binding avoids D1's parameter limit. Count the serialized
// UTF-8 bytes, including escaping, rather than only the original source text.
export const RESOLUTION_GUARD_MAX_BYTES = 524_288;

export interface ResolutionProblem {
  readonly id: string;
  readonly status: string;
  readonly current_statement_version: number;
  readonly famous_guardrail?: string | null;
}

export interface ResolutionAction {
  readonly action: "resolve";
  readonly direction: ProblemResolutionDirection;
  readonly closing_synthesis: {
    readonly synthesis_id?: string;
    readonly summary: string;
    readonly no_claim_boundary: ProblemNoClaimBoundary;
  };
  readonly external_expert_review_proof?: string;
}

export type ResolutionAdmissionReason =
  | "not-under-result-review"
  | "famous-problem"
  | "external-review-unsupported"
  | "formulation-unavailable"
  | "result-review-unavailable"
  | "result-not-current"
  | "scientific-support-incomplete"
  | "disclosure-incomplete"
  | "closing-synthesis-unavailable"
  | "closing-synthesis-mismatch"
  | "snapshot-changed"
  | "source-limit"
  | "unavailable";

export interface ProblemResolutionSnapshot {
  readonly resultClaim: ClaimDependencyPin;
  readonly formulation: PublishedProblemFormulation["problem"];
  readonly disclosureLineage: string;
  readonly closingSynthesis: {
    readonly synthesis: SynthesisItem;
    readonly source: SynthesisAnchorSource;
  };
  readonly through: number;
  /** Ephemeral admission witnesses. Never include bindings in an event,
   * response, error or log: they contain the checked source bodies. */
  readonly guard: { readonly sql: string; readonly bindings: readonly (string | number)[] };
}

export type ProblemResolutionAdmission =
  | { readonly ok: true; readonly snapshot: ProblemResolutionSnapshot }
  | { readonly ok: false; readonly reason: ResolutionAdmissionReason };

interface ReviewHead {
  id: string;
  status: string;
  public_seq: number;
  current_statement_version: number;
  famous_guardrail: string | null;
  event_id: string | null;
  seq: number | null;
  object_kind: string | null;
  object_id: string | null;
  object_version: number | null;
  actor_fellow_id: string | null;
  actor_sponsor_id: string | null;
  actor_session_id: string | null;
  payload_sha256: string | null;
  payload_json: string | null;
}

interface CurrentClaim {
  claim_id: string;
  version: number;
  event_id: string;
  seq: number;
  payload_sha256: string;
  content_digest: string | null;
  current_source_seq: number | null;
  current_payload_sha256: string | null;
  statement_version: number | null;
  statement_drift: number | null;
  latest_version: number | null;
  current_content_digest: string | null;
}

interface Disclosure {
  status: string;
  lineage_digest: string | null;
}

interface SourceWitness {
  event_id: string;
  seq: number;
  payload_sha256: string;
  payload_json: string | null;
}

const refuse = (reason: ResolutionAdmissionReason): ProblemResolutionAdmission => ({
  ok: false,
  reason,
});
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

/** Select the latest review initiation BEFORE checking its body. An invalid,
 * hidden or old-statement latest record must never fall back to an older one. */
const REVIEW_HEAD_SQL = `WITH scope AS (
  SELECT id,status,public_seq,current_statement_version,famous_guardrail FROM problems WHERE id = ?
), latest AS (
  SELECT e.* FROM events e JOIN scope p ON p.id = e.problem_id
  WHERE e.type = 'problem.result-review-started' AND e.seq <= p.public_seq
  ORDER BY e.seq DESC LIMIT 1
)
SELECT p.*, e.id AS event_id,e.seq,e.object_kind,e.object_id,e.object_version,
  e.actor_fellow_id,e.actor_sponsor_id,e.actor_session_id,e.payload_sha256,
  CASE WHEN c.redacted_at IS NULL AND NOT ${eventContentHiddenSql("e")}
    AND length(CAST(c.payload_json AS BLOB)) <= ${MAX_SOURCE_BYTES}
    THEN c.payload_json END AS payload_json
FROM scope p LEFT JOIN latest e ON 1 LEFT JOIN event_content c
  ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256`;

function prepareCurrentClaims(
  db: D1Database,
  problem: string,
  through: number,
  pin: ClaimDependencyPin,
): D1PreparedStatement {
  return db
    .prepare(`WITH nodes AS MATERIALIZED (${DEPENDENCY_CLOSURE_SQL})
    SELECT n.claim_id,n.version,n.event_id,n.seq,n.payload_sha256,n.content_digest,
      c.source_seq AS current_source_seq,c.payload_sha256 AS current_payload_sha256,
      c.statement_version,c.statement_drift,
      (SELECT MAX(v.version) FROM claim_versions v
        WHERE v.problem_id = n.problem_id AND v.claim_id = n.claim_id) AS latest_version,
      cv.content_digest AS current_content_digest
    FROM nodes n LEFT JOIN claims c ON c.problem_id = n.problem_id AND c.id = n.claim_id
    LEFT JOIN claim_versions cv ON cv.problem_id = n.problem_id
      AND cv.claim_id = n.claim_id AND cv.version = n.version
    ORDER BY n.ordinal`)
    .bind(
      JSON.stringify({
        problem,
        cursor: through,
        claim: pin.claim_id,
        version: pin.version,
      }),
    );
}

function makeGuard(
  problem: ResolutionProblem,
  through: number,
  resultClaim: ClaimDependencyPin,
  lineage: string,
  publications: readonly DependencyClosureRow[],
  sources: readonly SourceWitness[],
): ProblemResolutionSnapshot["guard"] | null {
  const unique = new Map<string, SourceWitness>();
  for (const source of sources) {
    if (
      source.payload_json === null ||
      !Number.isSafeInteger(source.seq) ||
      source.seq < 1 ||
      source.seq > through ||
      bytes(source.payload_json) > MAX_SOURCE_BYTES
    )
      return null;
    const prior = unique.get(source.event_id);
    if (
      prior &&
      (prior.seq !== source.seq ||
        prior.payload_sha256 !== source.payload_sha256 ||
        prior.payload_json !== source.payload_json)
    )
      return null;
    unique.set(source.event_id, source);
  }
  if (unique.size > DEPENDENCY_SCIENCE_ROW_LIMIT + DEPENDENCY_CLOSURE_LIMIT + 3) return null;
  const sourceJson = JSON.stringify(
    [...unique.values()].map((source) => [
      source.event_id,
      source.seq,
      source.payload_sha256,
      source.payload_json,
    ]),
  );
  const claimJson = JSON.stringify(
    publications.map((row) => [
      row.claim_id,
      row.version,
      row.seq,
      row.payload_sha256,
      row.content_digest,
    ]),
  );
  if (bytes(sourceJson) + bytes(claimJson) > RESOLUTION_GUARD_MAX_BYTES) return null;
  return {
    // Krater repeats this predicate after electing through+1, before inserting
    // the event. MAX(events.seq) is unchanged in both phases; public_seq alone
    // would either reject the second phase or permit an intervening event.
    // Bind disclosure predicates directly so nested wrapper SELECTs cannot
    // exceed D1's expression depth; all controls remain in the same guard.
    sql: ` AND (SELECT COALESCE(MAX(head.seq),0) FROM events head WHERE head.problem_id = ?) = ?
      AND EXISTS (SELECT 1 FROM problems current_problem
        WHERE current_problem.id = ? AND current_problem.status = 'under-result-review'
          AND current_problem.current_statement_version = ? AND current_problem.famous_guardrail IS NULL
          AND current_problem.public_seq IN (?,?))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS (
        SELECT 1 FROM events source JOIN event_content content ON content.event_id = source.id
          AND content.payload_sha256 = source.payload_sha256 AND content.redacted_at IS NULL
        WHERE source.problem_id = ? AND source.id = json_extract(expected.value,'$[0]')
          AND source.seq = json_extract(expected.value,'$[1]')
          AND source.payload_sha256 = json_extract(expected.value,'$[2]')
          AND content.payload_json = json_extract(expected.value,'$[3]')
          AND NOT ${eventContentHiddenSql("source")}
      ))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS (
        SELECT 1 FROM claims c JOIN claim_versions cv ON cv.problem_id = c.problem_id AND cv.claim_id = c.id
        WHERE c.problem_id = ? AND c.id = json_extract(expected.value,'$[0]')
          AND cv.version = json_extract(expected.value,'$[1]')
          AND c.source_seq = json_extract(expected.value,'$[2]')
          AND c.payload_sha256 = json_extract(expected.value,'$[3]')
          AND cv.content_digest = json_extract(expected.value,'$[4]')
          AND c.statement_version = ? AND c.statement_drift = 0
          AND cv.version = (SELECT MAX(v.version) FROM claim_versions v
            WHERE v.problem_id = c.problem_id AND v.claim_id = c.id)
      ))
      AND ${directiveDisclosureCompleteSql("?", "?", "?")}
      AND ${directiveDisclosureLineageSql("?", "?", "?")} = ?`,
    bindings: [
      problem.id,
      through,
      problem.id,
      problem.current_statement_version,
      through,
      through + 1,
      sourceJson,
      problem.id,
      claimJson,
      problem.id,
      problem.current_statement_version,
      problem.id,
      resultClaim.claim_id,
      resultClaim.version,
      problem.id,
      resultClaim.claim_id,
      resultClaim.version,
      lineage,
    ],
  };
}

/** Ordinary resolution is a live eligibility decision, not an author-writable
 * disposition. Canonical bounded readers verify the science; the returned
 * predicate certifies those same inputs atomically with terminal publication.
 * Historical withdrawn rows remain admissible inputs to the scientific fold.
 */
export async function prepareProblemResolution(
  db: D1Database,
  problem: ResolutionProblem,
  action: ResolutionAction,
): Promise<ProblemResolutionAdmission> {
  if (problem.status !== "under-result-review") return refuse("not-under-result-review");
  if (problem.famous_guardrail != null) return refuse("famous-problem");
  if (action.external_expert_review_proof !== undefined)
    return refuse("external-review-unsupported");
  if (!action.closing_synthesis.synthesis_id) return refuse("closing-synthesis-unavailable");
  try {
    const head = await db.prepare(REVIEW_HEAD_SQL).bind(problem.id).first<ReviewHead>();
    if (
      !head ||
      head.status !== problem.status ||
      head.current_statement_version !== problem.current_statement_version
    )
      return refuse("snapshot-changed");
    if (head.famous_guardrail !== null) return refuse("famous-problem");
    if (
      !Number.isSafeInteger(head.public_seq) ||
      head.public_seq < 1 ||
      head.public_seq >= Number.MAX_SAFE_INTEGER ||
      head.event_id === null ||
      head.seq === null ||
      head.object_kind !== "problem" ||
      head.object_id !== problem.id ||
      head.object_version !== problem.current_statement_version ||
      head.actor_fellow_id !== null ||
      head.actor_session_id !== null ||
      head.payload_sha256 === null ||
      head.payload_json === null
    )
      return refuse("result-review-unavailable");
    const parsedReview = ProblemGovernanceEventSchema.safeParse(
      await checkedScientificPayload({
        payload_json: head.payload_json,
        payload_sha256: head.payload_sha256,
      }),
    );
    if (
      !parsedReview.success ||
      parsedReview.data.action !== "enter-result-review" ||
      parsedReview.data.problem.id !== problem.id ||
      parsedReview.data.problem.current_statement_version !== problem.current_statement_version ||
      parsedReview.data.acting_principal.id !== head.actor_sponsor_id
    )
      return refuse("result-review-unavailable");
    const pin = ClaimDependencyPinSchema.safeParse(parsedReview.data.problem.result_claim);
    if (!pin.success) return refuse("result-review-unavailable");
    const resultClaim = pin.data;
    const through = head.public_seq;
    const target = `${resultClaim.claim_id}@${resultClaim.version}`;
    const formulation = await readPublishedProblemFormulation(db, problem.id, through);
    if (
      !formulation ||
      formulation.problem.current_statement_version !== problem.current_statement_version
    )
      return refuse("formulation-unavailable");
    const formulationSource = await db
      .prepare(`SELECT e.id AS event_id,e.seq,e.payload_sha256,
      CASE WHEN length(CAST(c.payload_json AS BLOB)) <= ${MAX_SOURCE_BYTES} THEN c.payload_json END AS payload_json
      FROM events e JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      WHERE e.problem_id = ? AND e.id = ? AND e.seq = ? AND e.payload_sha256 = ?
        AND c.redacted_at IS NULL AND NOT ${eventContentHiddenSql("e")}`)
      .bind(
        problem.id,
        formulation.publication.event_id,
        formulation.publication.seq,
        formulation.publication.payload_sha256,
      )
      .first<SourceWitness>();
    if (!formulationSource || formulationSource.payload_json === null)
      return refuse("formulation-unavailable");
    await checkedScientificPayload({
      ...formulationSource,
      payload_json: formulationSource.payload_json,
    });
    const results = await db.batch([
      prepareDependencyClosure(db, problem.id, through, target),
      prepareDependencyAssessment(db, problem.id, through, target),
      prepareCurrentClaims(db, problem.id, through, resultClaim),
      db
        .prepare(`SELECT
        ${directiveDisclosureStatusSql("selected.problem_id", "selected.claim_id", "selected.version")} AS status,
        ${directiveDisclosureLineageSql("selected.problem_id", "selected.claim_id", "selected.version")} AS lineage_digest
        FROM (SELECT ? AS problem_id,? AS claim_id,? AS version) selected`)
        .bind(problem.id, resultClaim.claim_id, resultClaim.version),
      db
        .prepare(
          "SELECT public_seq,status,current_statement_version,famous_guardrail FROM problems WHERE id = ?",
        )
        .bind(problem.id),
    ]);
    if (results.length !== 5 || results.some((r) => !r.success || !Array.isArray(r.results)))
      return refuse("unavailable");
    const observed = results[4]!.results[0] as ReviewHead | undefined;
    if (
      !observed ||
      observed.public_seq !== through ||
      observed.status !== problem.status ||
      observed.current_statement_version !== problem.current_statement_version ||
      observed.famous_guardrail !== null
    )
      return refuse("snapshot-changed");
    const publications = results[0]!.results as unknown as DependencyClosureRow[];
    const sources = results[1]!.results as unknown as DependencyScientificRow[];
    const currentClaims = results[2]!.results as unknown as CurrentClaim[];
    const disclosure = results[3]!.results[0] as Disclosure | undefined;
    if (
      publications.length > DEPENDENCY_CLOSURE_LIMIT ||
      sources.length > DEPENDENCY_SCIENCE_ROW_LIMIT
    )
      return refuse("source-limit");
    const closure = await composeDependencyClosure(publications, problem.id, target);
    const root = publications[0];
    if (
      !closure.root_available ||
      !closure.complete ||
      !root ||
      root.event_id !== resultClaim.event_id ||
      root.payload_sha256 !== resultClaim.payload_digest ||
      root.content_digest !== resultClaim.content_digest ||
      root.seq >= head.seq
    )
      return refuse("result-review-unavailable");
    if (
      currentClaims.length !== publications.length ||
      currentClaims.some((row, index) => {
        const expected = publications[index];
        return (
          !expected ||
          row.event_id !== expected.event_id ||
          row.current_source_seq !== expected.seq ||
          row.current_payload_sha256 !== expected.payload_sha256 ||
          row.current_content_digest !== expected.content_digest ||
          row.latest_version !== expected.version ||
          row.statement_version !== problem.current_statement_version ||
          row.statement_drift !== 0
        );
      })
    )
      return refuse("result-not-current");
    if (
      disclosure?.status !== "satisfied" ||
      typeof disclosure.lineage_digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(disclosure.lineage_digest)
    )
      return refuse("disclosure-incomplete");
    const assessments = await composeDependencyAssessment(
      publications,
      closure,
      sources,
      problem.id,
      target,
      through,
    );
    const assessment = assessments.get(target);
    if (
      !assessment ||
      !assessment.standing.complete ||
      assessment.standing.stale ||
      assessment.standing.latest_version !== resultClaim.version ||
      assessment.standing.disposition !== "strongly-supported" ||
      !assessment.chain.complete
    )
      return refuse("scientific-support-incomplete");
    const page = await readSynthesisPage(
      db,
      problem.id,
      {
        through,
        synthesisId: action.closing_synthesis.synthesis_id,
      },
      (value) => {
        const parsed = SynthesisItemSchema.safeParse(value);
        return parsed.success ? parsed.data : null;
      },
    );
    const closing = page.items[0];
    if (!page.found || page.omitted.length > 0 || page.items.length !== 1 || !closing)
      return refuse("closing-synthesis-unavailable");
    const declaration = closing.synthesis.closing_resolution;
    if (
      !declaration ||
      declaration.result_claim.claim_id !== resultClaim.claim_id ||
      declaration.result_claim.version !== resultClaim.version ||
      declaration.direction !== action.direction ||
      closing.synthesis.body_md !== action.closing_synthesis.summary ||
      canonicalJson(declaration.no_claim_boundary) !==
        canonicalJson(action.closing_synthesis.no_claim_boundary) ||
      closing.synthesis.covers_through < head.seq ||
      sources.some((source) => source.seq > closing.synthesis.covers_through) ||
      !closing.synthesis.anchors.some(
        (anchor) =>
          anchor.target_kind === "claim" &&
          anchor.target_id === resultClaim.claim_id &&
          anchor.target_version === resultClaim.version &&
          anchor.target_seq !== undefined &&
          anchor.target_seq <= closing.synthesis.covers_through,
      )
    )
      return refuse("closing-synthesis-mismatch");
    const guard = makeGuard(
      problem,
      through,
      resultClaim,
      disclosure.lineage_digest,
      publications,
      [
        ...publications,
        ...sources,
        formulationSource,
        {
          event_id: head.event_id,
          seq: head.seq,
          payload_sha256: head.payload_sha256,
          payload_json: head.payload_json,
        },
        {
          event_id: closing.source.eventId,
          seq: closing.source.seq,
          payload_sha256: closing.source.payloadDigest,
          payload_json: closing.source.payloadJson,
        },
      ],
    );
    if (guard === null) return refuse("source-limit");
    const stable = await db
      .prepare(`SELECT 1 AS stable WHERE 1 ${guard.sql}`)
      .bind(...guard.bindings)
      .first();
    if (!stable) return refuse("snapshot-changed");
    return {
      ok: true,
      snapshot: {
        resultClaim,
        formulation: formulation.problem,
        disclosureLineage: disclosure.lineage_digest,
        closingSynthesis: { synthesis: closing.synthesis, source: closing.source },
        through,
        guard,
      },
    };
  } catch {
    // Storage, malformed source and byte-verification failures cannot be
    // converted to an empty graph or favorable standing. No source is logged.
    return refuse("unavailable");
  }
}
