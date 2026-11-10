import {
  EvidenceRequestSchema,
  getMoveTemplate,
  type NextMoveCandidate,
  PublicLedgerProblemIdSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import { assessEvidenceClass } from "../ledger/evidence-class.ts";
import { checkedScientificPayload } from "../ledger/scientific-checks.ts";
import { normalizeClaimStatement } from "../split/policy.ts";

export const DEAD_END_MOVES_BOUNDARY =
  "record-dead-end-v2: inspect at most 128 scientific publications and 256 KiB of source bytes at the current public cursor. Three distinct supporting assertion-class reports on one current claim are a prompt to examine an unproductive approach, not evidence that the claim is false or the route is exhausted. Stronger evidence, counterevidence, verified reviews, withdrawals and unavailable or incomplete history suppress this suggestion. The Fellow must supply an actual examined approach, failure and retry condition; no findings are prefilled.";

export const DEAD_END_MOVE_SOURCE_LIMIT = 128;
const SOURCE_BYTES = 32_768;
const TOTAL_BYTES = 262_144;

/** A bounded complete source history, rather than COUNT(*) over mutable
 * evidence projections. The absence of a stronger class cannot be inferred
 * from a truncated or withheld prefix. A lookahead invalidates selection and
 * never sends its body across D1. Present-day controls apply at every cut. */
const SOURCES_SQL = `WITH scope AS (
  SELECT p.id, p.public_seq FROM problems p WHERE p.id = ? AND p.public_seq = ?
    AND p.status IN ('active', 'dormant', 'under-result-review')
    AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
), sources AS MATERIALIZED (
  SELECT e.*, c.payload_json, c.redacted_at,
    length(CAST(c.payload_json AS BLOB)) AS source_bytes,
    ${eventContentHiddenSql("e")} AS hidden
  FROM scope p JOIN events e ON e.problem_id = p.id AND e.seq <= p.public_seq
  LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
  WHERE (e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised'))
    OR (e.object_kind = 'evidence' AND e.type = 'evidence.created')
    OR (e.object_kind = 'review' AND e.type = 'review.created')
    OR (e.object_kind = 'retraction' AND e.type = 'object.retracted')
  ORDER BY e.seq LIMIT ${DEAD_END_MOVE_SOURCE_LIMIT + 1}
), budget AS (
  SELECT COUNT(*) AS source_count, COALESCE(SUM(source_bytes), 0) AS total_bytes FROM sources
)
SELECT p.id AS problem_id, p.public_seq AS cursor, b.source_count, b.total_bytes,
  e.id AS event_id, e.seq, e.type, e.object_id, e.object_version, e.payload_sha256,
  CASE WHEN b.source_count <= ${DEAD_END_MOVE_SOURCE_LIMIT} AND b.total_bytes <= ${TOTAL_BYTES}
    AND e.source_bytes BETWEEN 1 AND ${SOURCE_BYTES} AND e.redacted_at IS NULL AND e.hidden = 0
    THEN e.payload_json END AS payload_json
FROM scope p CROSS JOIN budget b LEFT JOIN sources e ON e.problem_id = p.id
ORDER BY e.seq`;

interface Source {
  problem_id: string;
  cursor: number;
  source_count: number;
  total_bytes: number;
  event_id: string | null;
  seq: number;
  type: string;
  object_id: string;
  object_version: number;
  payload_sha256: string;
  payload_json: string | null;
}

interface Publication {
  source: Source;
  payload: Record<string, unknown>;
}

function exactClaim(id: unknown, version: unknown): string | null {
  return typeof id === "string" &&
    /^C-[1-9][0-9]*$/.test(id) &&
    Number.isSafeInteger(Number(id.slice(2))) &&
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version > 0
    ? `${id}@${version}`
    : null;
}

function evidenceContent(payload: Record<string, unknown>) {
  const candidate = { ...payload };
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
  if (!parsed.success) throw new Error("DEAD_END_MOVE_EVIDENCE_UNAVAILABLE");
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
    payload.computed_class !== assessment.class ||
    JSON.stringify(payload.coercion_flags) !== JSON.stringify(assessment.flags)
  )
    throw new Error("DEAD_END_MOVE_EVIDENCE_CLASS_UNAVAILABLE");
  return { data, assessment };
}

export interface DeadEndMoveResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
}

export async function selectRecordDeadEndMove(
  db: D1Database,
  problemId: string,
  cursor: number,
): Promise<DeadEndMoveResult> {
  const unavailable = { move: null, degraded: true } as const;
  try {
    if (
      !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0
    )
      return unavailable;
    const read = () => db.prepare(SOURCES_SQL).bind(problemId, cursor).all<Source>();
    const snapshot = await read();
    const rows = snapshot.results;
    const head = rows[0];
    if (
      !head ||
      rows.length > DEAD_END_MOVE_SOURCE_LIMIT ||
      head.source_count > DEAD_END_MOVE_SOURCE_LIMIT ||
      head.total_bytes > TOTAL_BYTES ||
      rows.some((row) => row.problem_id !== problemId || row.cursor !== cursor)
    )
      return unavailable;
    if (head.source_count === 0 && head.event_id === null) return { move: null, degraded: false };
    if (head.source_count !== rows.length) return unavailable;

    const publications: Publication[] = [];
    const claims = new Map<string, Publication>();
    const retired = new Set<string>();
    let sequence = 0;
    const identities = new Set<string>();
    const objects = new Set<string>();
    for (const source of rows) {
      const object = JSON.stringify([source.type, source.object_id, source.object_version]);
      if (
        !source.event_id ||
        identities.has(source.event_id) ||
        objects.has(object) ||
        !Number.isSafeInteger(source.seq) ||
        source.seq <= sequence ||
        source.seq > cursor ||
        source.payload_json === null
      )
        return unavailable;
      sequence = source.seq;
      identities.add(source.event_id);
      objects.add(object);
      const payload = await checkedScientificPayload({
        ...source,
        payload_json: source.payload_json,
      });
      const publication = { source, payload };
      publications.push(publication);
      if (source.type === "claim.created" || source.type === "claim.revised") {
        const prior = claims.get(source.object_id);
        if (
          exactClaim(source.object_id, source.object_version) === null ||
          payload.claim_id !== source.object_id ||
          typeof payload.statement !== "string" ||
          !payload.statement.trim() ||
          (source.type === "claim.created"
            ? prior !== undefined || source.object_version !== 1
            : prior === undefined ||
              source.object_version !== prior.source.object_version + 1 ||
              payload.base_version !== prior.source.object_version)
        )
          return unavailable;
        claims.set(source.object_id, publication);
      } else if (source.type === "object.retracted") {
        if (typeof payload.target_object !== "string") return unavailable;
        retired.add(payload.target_object);
      }
    }

    const candidates = new Map<
      string,
      { claim: Publication; evidence: Publication[]; seen: Set<string>; blocked: boolean }
    >();
    for (const [id, claim] of claims) {
      const target = `${id}@${claim.source.object_version}`;
      if (!retired.has(id) && !retired.has(target))
        candidates.set(target, { claim, evidence: [], seen: new Set(), blocked: false });
    }
    for (const publication of publications) {
      const { source, payload } = publication;
      if (retired.has(source.object_id) || retired.has(`${source.object_id}@1`)) continue;
      if (source.type === "review.created") {
        const target = exactClaim(payload.target_claim_id, payload.target_version);
        const candidate = target ? candidates.get(target) : undefined;
        // A checked review or an objection warrants its own scientific path,
        // not an invitation to manufacture a negative result.
        if (
          candidate &&
          (payload.verification != null ||
            payload.verdict === "refute" ||
            payload.verdict === "fails-to-reproduce")
        )
          candidate.blocked = true;
      }
      if (source.type !== "evidence.created") continue;
      if (source.object_version !== 1 || !/^E-[0-9A-HJKMNP-TV-Z]{1,78}$/.test(source.object_id))
        return unavailable;
      const { data, assessment } = evidenceContent(payload);
      const target =
        data.bears_on_kind === "claim" ? exactClaim(data.bears_on_id, data.bears_on_version) : null;
      const candidate = target ? candidates.get(target) : undefined;
      if (!candidate) continue;
      if (source.seq <= candidate.claim.source.seq) return unavailable;
      if (
        assessment.class !== "assertion" ||
        data.direction === "refutes" ||
        data.direction === "fails-to-reproduce" ||
        data.falsification_check !== undefined
      )
        candidate.blocked = true;
      if (assessment.class !== "assertion" || data.direction !== "supports") continue;
      const identity = normalizeClaimStatement(data.body_md);
      if (!identity || candidate.seen.has(identity)) continue;
      candidate.seen.add(identity);
      candidate.evidence.push(publication);
    }
    const candidate = [...candidates.values()]
      .filter((item) => !item.blocked && item.evidence.length >= 3)
      .sort(
        (left, right) => (left.evidence[2]?.source.seq ?? 0) - (right.evidence[2]?.source.seq ?? 0),
      )[0];
    if (!candidate) return { move: null, degraded: false };
    // Hashing source bodies awaits WebCrypto. Recheck the complete bounded
    // input, including controls and the public head, before emitting advice.
    if (JSON.stringify((await read()).results) !== JSON.stringify(rows)) return unavailable;
    const target = `${candidate.claim.source.object_id}@${candidate.claim.source.object_version}`;
    const evidence = candidate.evidence.slice(0, 3).map((item) => item.source.object_id);
    const template = getMoveTemplate("record-dead-end");
    if (template.availability !== "available") {
      return { move: null, degraded: true };
    }

    return {
      move: {
        move: "record-dead-end",
        why: `${target} has three distinct supporting assertion-class reports without a stronger surviving evidence class. Inspect the approach before repeating it. This does not establish a failure or refute the claim; record a dead end only if your examination actually found an obstruction.`,
        refs: [problemId, target, ...evidence],
        contract: {
          ...template,
          prefilled_hints: {},
          preparation: {
            problem_id: problemId,
            captured_cursor: cursor,
            claim: target,
            evidence,
            read_first: {
              method: "GET",
              path: `/p/${encodeURIComponent(problemId)}/claims/${encodeURIComponent(target)}.md?through=${cursor}`,
            },
            additional_reads: evidence.map((id) => ({
              method: "GET",
              path: `/p/${encodeURIComponent(problemId)}/evidence/${encodeURIComponent(id)}.md`,
            })),
            open_session: {
              method: "POST",
              path: "/v1/sessions",
              idempotency_key_required: true,
              body: { problem_id: problemId, intent: "explore" },
            },
            note: "Reuse an owned session or open one, then replace {id}. Read the pinned claim and exact evidence first. Supply only your own actual approach, what_was_examined, why_it_fails and retry_predicate; no failure is implied by repeated assertions. If the approach remains productive, continue the investigation instead. A checked null is success, never a quota. Add retry_when only when its real structured condition is known.",
          },
        },
        selection_boundary: DEAD_END_MOVES_BOUNDARY,
      },
      degraded: false,
    };
  } catch {
    return { move: null, degraded: true };
  }
}
