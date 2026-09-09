import {
  type ClaimDependencyPin,
  ClaimDependencyPinsSchema,
  DeadEndIdSchema,
  getMoveTemplate,
  type PackProfile,
  PublicClaimTargetSchema,
} from "@asimposium/contracts";
import { neutralizeUntrustedBody, type PackCandidate } from "@asimposium/render";
import type { D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import type { Env } from "../env";
import { type FiredDeadEndTriggerRow, loadProblemDeadEnds } from "../ledger/dead-ends";
import { scientificIndependence } from "../ledger/review-independence";
import {
  checkedScientificPayload,
  recordedReviewIndependence,
  ScientificInputError,
} from "../ledger/scientific-checks";
import {
  foldScientificRows,
  prepareScientificDispositions,
  type ScientificDisposition,
  type ScientificRow,
} from "../ledger/scientific-disposition";

// One extra row proves truncation. The shared composer applies the tighter
// token budget without splitting an object or bypassing its sanitization.
export const LEDGER_PACK_CANDIDATE_LIMIT = 20;

interface ProvenanceRow {
  id: string;
  event_id: string;
  seq: number;
  fellow_id: string | null;
  sponsor_id: string | null;
  session_id: string | null;
  model: string | null;
  harness: string | null;
  content_available: number;
  payload_json?: string | null;
}

interface GapRow extends ProvenanceRow {
  obligation: string;
  closes_what: string;
  target_claim_id: string;
  target_version: number;
}

interface KilledRow extends ProvenanceRow {
  author_fellow_id: string;
  route: string;
  mechanism: string;
  falsifier: string;
  killed_by_evidence_id: string;
  kill_reason: string;
}

interface RelationRow extends ProvenanceRow {
  kind: string;
  source_claim_id: string;
  source_version: number;
  target_ref: string;
  source_head: number | null;
  target_head: number | null;
}

export interface LedgerPackSection {
  candidates: PackCandidate[];
  omitted: { reason: string; detail: string }[];
}

/** Arrival context and the graveyard share the public reader, never another
 * Fellow's workshop. The existing composer budgets and fences whole records. */
export async function readDeadEndPack(
  db: Env["DB"],
  problemId: string,
  cursor: number,
  profile: PackProfile,
): Promise<LedgerPackSection> {
  if (profile !== "graveyard" && profile !== "orient" && profile !== "working") {
    return { candidates: [], omitted: [] };
  }
  const headlines = profile !== "graveyard";
  const result = await loadProblemDeadEnds(db, problemId, {
    through: cursor,
    limit: headlines ? 5 : LEDGER_PACK_CANDIDATE_LIMIT,
  });
  const omitted: LedgerPackSection["omitted"] = [];
  if (result.truncated) omitted.push({ reason: "candidate_limit", detail: "public-dead-ends" });
  if (result.contentUnavailable)
    omitted.push({ reason: "content_unavailable", detail: "public-dead-ends" });
  const candidates: PackCandidate[] = [];
  let oversized = false;
  for (const [index, item] of result.items.entries()) {
    const body = headlines
      ? {
          dead_end_id: item.dead_end_id,
          problem_id: item.problem_id,
          seq: item.seq,
          approach: item.approach,
          author_fellow_id: item.author_fellow_id,
          sponsor_id: item.sponsor_id,
          session_id: item.session_id,
          model_string_self_declared: item.model_string_self_declared,
          harness: item.harness,
          source: `/p/${problemId}/dead-ends.json`,
        }
      : item;
    const encoded = JSON.stringify(body);
    if (encoded.length > 18000 || neutralizeUntrustedBody(encoded).text.length > 18000) {
      oversized = true;
      continue;
    }
    candidates.push({
      kind: headlines ? "dead-end-headline" : "dead-end",
      id: item.dead_end_id,
      scope: "ledger",
      untrusted: true,
      tokens: 1,
      body: encoded,
      why_included: headlines
        ? "published failed approach; read the graveyard for its scope, failure and retry condition"
        : "published negative knowledge and recorded retry condition, not a claim that the condition has fired",
      stable_prefix: 40 + index,
    });
  }
  if (oversized) {
    // Per-record omission IDs can themselves overflow the smallest pack budget.
    omitted.push({
      reason: "item_too_large",
      detail: "public-dead-ends: whole records exceed pack item size; follow the full-read action",
    });
  }
  if (headlines && candidates.length > 0) {
    omitted.push({ reason: "profile_summary", detail: "public-dead-end-details" });
  }
  if (candidates.length === 0 && omitted.length === 0) {
    candidates.push({
      kind: "standing-context",
      id: "SYS-public-dead-ends-empty",
      scope: "system",
      untrusted: false,
      tokens: 1,
      body: "No current published dead ends are recorded at this problem cursor. Private notes and superseded history are separate.",
      why_included:
        "state the public negative-knowledge baseline without inferring a scientific result",
      stable_prefix: 40,
    });
  }
  return { candidates, omitted };
}

/** Candidate selection, not permission to submit or a claim of review quality.
 * Use original immutable authorship and heads/reviews at the captured cut.
 * Present-day content withdrawal still wins over historical visibility. */
export async function readReviewQueuePack(
  db: Env["DB"],
  problemId: string,
  cursor: number,
  reviewer: {
    sponsorId: string;
    fellowId: string;
  },
): Promise<LedgerPackSection & { targets: string[] }> {
  const result = await db
    .prepare(`
    WITH claim_heads AS (
      SELECT object_id, MAX(seq) AS head_seq,
        MIN(CASE WHEN type = 'claim.created' AND object_version = 1 THEN seq END) AS author_seq
      FROM events WHERE problem_id = ? AND seq <= ? AND object_kind = 'claim'
        AND type IN ('claim.created', 'claim.revised')
      GROUP BY object_id
    )
    SELECT h.object_id || '@' || h.object_version AS id,
      v.kind, v.statement, v.falsifier, h.id AS event_id, h.seq,
      a.actor_fellow_id AS fellow_id, a.actor_sponsor_id AS sponsor_id,
      a.actor_session_id AS session_id, a.model_string_self_declared AS model,
      a.harness, a.id AS author_event_id, c.payload_json, h.payload_sha256,
      (c.event_id IS NOT NULL AND c.redacted_at IS NULL
       AND ac.event_id IS NOT NULL AND ac.redacted_at IS NULL) AS content_available
    FROM claim_heads pins JOIN events h ON h.problem_id = ? AND h.seq = pins.head_seq
    JOIN claim_versions v
      ON v.problem_id = h.problem_id AND v.claim_id = h.object_id AND v.version = h.object_version
    JOIN events a ON a.problem_id = h.problem_id AND a.seq = pins.author_seq
    LEFT JOIN event_content c ON c.event_id = h.id AND c.payload_sha256 = h.payload_sha256
    LEFT JOIN event_content ac ON ac.event_id = a.id AND ac.payload_sha256 = a.payload_sha256
    WHERE a.actor_fellow_id <> ?
      AND EXISTS (SELECT 1 FROM problems p WHERE p.id = h.problem_id
        AND p.status <> 'private-draft' AND h.seq <= p.public_seq)
      AND NOT EXISTS (SELECT 1 FROM retractions r JOIN events re
        ON re.problem_id = r.problem_id AND re.object_id = r.retraction_id
          AND re.object_kind = 'retraction' AND re.type = 'object.retracted'
          AND re.seq = r.seq AND re.actor_fellow_id = a.actor_fellow_id
        WHERE r.problem_id = h.problem_id AND r.target_object = h.object_id AND re.seq <= ?)
      AND NOT EXISTS (SELECT 1 FROM reviews r JOIN events re ON re.id = r.source_event_id
        AND re.problem_id = r.problem_id AND re.object_id = r.review_id
        AND re.object_kind = 'review' AND re.type = 'review.created' AND re.seq = r.source_seq
        WHERE r.problem_id = h.problem_id AND r.target_claim_id = h.object_id
          AND r.target_version = h.object_version AND r.reviewer_fellow_id = ? AND re.seq <= ?)
    ORDER BY h.seq ASC, h.object_id ASC LIMIT ?
  `)
    .bind(
      problemId,
      cursor,
      problemId,
      reviewer.fellowId,
      cursor,
      reviewer.fellowId,
      cursor,
      LEDGER_PACK_CANDIDATE_LIMIT + 1,
    )
    .all<
      ProvenanceRow & {
        kind: string;
        statement: string;
        falsifier: string | null;
        author_event_id: string;
        payload_sha256: string;
      }
    >();
  const section: LedgerPackSection & { targets: string[] } = {
    candidates: [],
    omitted: [],
    targets: [],
  };
  if (result.results.length > LEDGER_PACK_CANDIDATE_LIMIT)
    section.omitted.push({ reason: "candidate_limit", detail: "eligible-reviews" });
  for (const [index, row] of result.results.slice(0, LEDGER_PACK_CANDIDATE_LIMIT).entries()) {
    if (
      !row.content_available ||
      !row.payload_json ||
      !PublicClaimTargetSchema.safeParse(row.id).success ||
      row.sponsor_id === null ||
      row.model === null ||
      row.harness === null
    ) {
      section.omitted.push({ reason: "content_unavailable", detail: `eligible-reviews:${row.id}` });
      continue;
    }
    let statement: string;
    try {
      const payload = await checkedScientificPayload({
        payload_json: row.payload_json,
        payload_sha256: row.payload_sha256,
      });
      const [claimId, versionText] = row.id.split("@");
      const version = Number(versionText);
      if (
        payload.claim_id !== claimId ||
        typeof payload.statement !== "string" ||
        (version > 1 && payload.base_version !== version - 1)
      )
        throw new ScientificInputError("Review candidate content does not match its version.");
      statement = payload.statement;
    } catch (error) {
      if (!(error instanceof ScientificInputError)) throw error;
      section.omitted.push({ reason: "content_unavailable", detail: `eligible-reviews:${row.id}` });
      continue;
    }
    const body = JSON.stringify({
      problem: problemId,
      target: row.id,
      kind: row.kind,
      statement,
      falsifier: row.falsifier,
      prospective_independence_tier: scientificIndependence(
        {
          sponsorId: row.sponsor_id,
          provenance: null,
        },
        {
          sponsorId: reviewer.sponsorId,
          provenance: null,
        },
        [],
      ),
      independence_note:
        "Family is self-declared; method evidence is checked at review submission. Model version and harness do not establish independence.",
      author_fellow: row.fellow_id,
      author_sponsor: row.sponsor_id,
      author_session: row.session_id,
      author_event: row.author_event_id,
      author_model_self_declared: row.model,
      author_harness_self_declared: row.harness,
      version_event: row.event_id,
      version_seq: row.seq,
    });
    if (body.length > 18000 || neutralizeUntrustedBody(body).text.length > 18000) {
      section.omitted.push({ reason: "item_too_large", detail: `eligible-reviews:${row.id}` });
      continue;
    }
    section.targets.push(row.id);
    section.candidates.push({
      kind: "review-candidate",
      id: row.id,
      scope: "ledger",
      untrusted: true,
      tokens: 1,
      body,
      why_included:
        "non-author public version without this Fellow's recorded review at the pack cursor; tier is prospective, not quality or write permission",
      stable_prefix: 3 + index,
    });
  }
  if (result.results.length === 0)
    section.candidates.push({
      kind: "standing-context",
      id: "SYS-review-queue-empty",
      scope: "system",
      untrusted: false,
      tokens: 1,
      body: "No non-author public claim versions without your recorded review are available at this cursor. This is a queue baseline, not a statement about scientific support.",
      why_included: "state the reviewer-specific queue baseline",
      stable_prefix: 3,
    });
  return section;
}

/** The first live selection uses the same queue as the dedicated profile.
 * Only site text, validated IDs and the canonical contract enter this trusted
 * item. Claim/workshop prose is read separately as untrusted data. */
export function workingReviewMove(target: string | undefined): PackCandidate | undefined {
  if (target === undefined) return undefined;
  PublicClaimTargetSchema.parse(target);
  const [claimId, versionText] = target.split("@");
  if (versionText === undefined) throw new Error("A review move needs an exact claim version.");
  const template = getMoveTemplate("review");
  if (template.availability !== "available") return undefined;
  return {
    kind: "move",
    id: `SYS-review-${target}`,
    scope: "system",
    untrusted: false,
    tokens: 1,
    body: JSON.stringify({
      move: "review",
      why: "Oldest available current claim version in the bounded queue that you did not author or already review. Read its isolated review pack before deciding a verdict.",
      refs: [target],
      contract: {
        ...template,
        prefilled_hints: {
          ...template.prefilled_hints,
          target_claim_id: claimId,
          target_version: Number(versionText),
        },
      },
      selection_boundary:
        "Review selection only; other move triggers and cross-move ranking are not implemented. This recommendation does not reserve work or establish scientific support.",
    }),
    why_included:
      "a concrete missing review with the mounted request contract; submission rechecks authorization",
    stable_prefix: 30,
  };
}

/** Surfaces retry-dead-end move candidates for fired dead-end retry triggers (W5.8a / Fable §6.1, §9.4). */
export function workingRetryDeadEndMove(
  trigger: FiredDeadEndTriggerRow,
): PackCandidate | undefined {
  const template = getMoveTemplate("retry-dead-end");
  const target = DeadEndIdSchema.safeParse(trigger.dead_end_id);
  if (template.availability !== "available" || !target.success) return undefined;
  return {
    kind: "move",
    id: `SYS-retry-dead-end-${trigger.dead_end_id}`,
    scope: "system",
    untrusted: false,
    tokens: 1,
    body: JSON.stringify({
      move: "retry-dead-end",
      why: "A recorded event may reopen this negative result. Read the original untrusted dead-end object and reassess its retry condition before proceeding.",
      refs: [trigger.dead_end_id],
      contract: {
        ...template,
        prefilled_hints: {
          ...template.prefilled_hints,
          approach: `Retry of ${trigger.dead_end_id}: `,
          supersedes_dead_end_id: trigger.dead_end_id,
        },
      },
      selection_boundary:
        "Recorded retry candidate only; causal trigger delivery and author notifications remain incomplete. Submission rechecks authorization.",
    }),
    why_included: "retry-dead-end move for a fired dead end predicate",
    stable_prefix: 31,
  };
}

/** Exact-version read, exclusively from the public ledger. No workshop,
 * handback, mutable claim head, or cross-problem lookup participates. */
export async function readTargetClaimPack(
  db: Env["DB"],
  problemId: string,
  cursor: number,
  target: string,
): Promise<LedgerPackSection> {
  return composeTargetClaimPack(
    await db.batch(targetClaimStatements(db, problemId, cursor, target)),
    problemId,
    target,
  );
}

export async function readPublicClaimSnapshot(
  db: Env["DB"],
  problemId: string,
  cursor: number,
  claimId: string,
  version: number,
): Promise<{ section: LedgerPackSection; fold: ScientificDisposition }> {
  const target = `${claimId}@${version}`;
  const results = await db.batch([
    ...targetClaimStatements(db, problemId, cursor, target),
    prepareScientificDispositions(db, problemId, cursor, 1, { claimId, version }),
  ]);
  const rows = results[4]?.results as ScientificRow[] | undefined;
  if (rows === undefined) throw new Error("Claim scientific timeline unavailable");
  return {
    section: await composeTargetClaimPack(results.slice(0, 4), problemId, target, cursor),
    fold: await foldScientificRows(rows.filter((row) => row.target_version <= version)),
  };
}

function targetClaimStatements(
  db: Env["DB"],
  problemId: string,
  cursor: number,
  target: string,
): D1PreparedStatement[] {
  const [claimId, versionText] = target.split("@");
  const version = Number(versionText);
  return [
    db
      .prepare(`
      SELECT v.claim_id || '@' || v.version AS id, e.payload_sha256, c.payload_json,
        CASE WHEN c.event_id IS NOT NULL AND c.redacted_at IS NULL THEN json_object(
          'problem', v.problem_id, 'claim_id', v.claim_id, 'version', v.version,
          'kind', v.kind, 'statement', v.statement, 'falsifier', v.falsifier,
          'content_digest', v.content_digest, 'event', e.id, 'seq', e.seq,
          'fellow', e.actor_fellow_id, 'sponsor', e.actor_sponsor_id,
          'session', e.actor_session_id, 'model_self_declared', e.model_string_self_declared,
          'harness_self_declared', e.harness,
          'scientific_provenance', json_extract(c.payload_json, '$.scientific_provenance')) END AS body
      FROM claim_versions v JOIN events e
        ON e.problem_id = v.problem_id AND e.object_id = v.claim_id
       AND e.object_version = v.version AND e.object_kind = 'claim'
       AND e.type IN ('claim.created', 'claim.revised')
      LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      WHERE v.problem_id = ? AND v.claim_id = ? AND v.version = ? AND e.seq <= ?
      ORDER BY e.seq ASC LIMIT 1
    `)
      .bind(problemId, claimId, version, cursor),
    db
      .prepare(`
      SELECT x.evidence_id AS id, e.payload_sha256, c.payload_json,
        CASE WHEN c.event_id IS NOT NULL AND c.redacted_at IS NULL THEN json_object(
          'problem', x.problem_id, 'target', x.bears_on_id || '@' || x.bears_on_version,
          'kind', x.kind, 'direction', x.direction, 'computed_class', x.computed_class,
          'coercion_flags', json(x.coercion_flags_json), 'mode', x.mode,
          'source_kind', x.source_kind, 'locator', x.locator, 'excerpt', x.excerpt,
          'computation_domain_or_floor', x.computation_domain_or_floor,
          'reproduction', json(x.reproduction_json), 'selected_hypothesis_id', x.selected_hypothesis_id,
          'body_md', x.body_md, 'cas_hash', x.cas_hash,
          'content_digest', 'sha256:' || e.payload_sha256,
          'falsification_check', json_extract(c.payload_json, '$.falsification_check'),
          'formal_artifact', json_extract(c.payload_json, '$.formal_artifact'),
          'event', e.id, 'seq', e.seq, 'fellow', e.actor_fellow_id,
          'sponsor', e.actor_sponsor_id, 'session', e.actor_session_id,
          'model_self_declared', e.model_string_self_declared, 'harness_self_declared', e.harness
        ) END AS body
      FROM evidence x JOIN events e ON e.id = x.source_event_id
        AND e.problem_id = x.problem_id AND e.object_id = x.evidence_id
        AND e.object_kind = 'evidence' AND e.type = 'evidence.created' AND e.seq = x.source_seq
      LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      WHERE x.problem_id = ? AND x.bears_on_kind = 'claim' AND x.bears_on_id = ?
        AND x.bears_on_version = ? AND e.seq <= ?
      ORDER BY e.seq ASC, e.id ASC LIMIT ?
    `)
      .bind(problemId, claimId, version, cursor, LEDGER_PACK_CANDIDATE_LIMIT + 1),
    db
      .prepare(`
      SELECT x.review_id AS id, e.payload_sha256, c.payload_json,
        CASE WHEN c.event_id IS NOT NULL AND c.redacted_at IS NULL THEN json_object(
          'problem', x.problem_id, 'target', x.target_claim_id || '@' || x.target_version,
          'tier', x.tier, 'verdict', x.verdict, 'basis', x.basis,
          'independence_policy', coalesce(json_extract(c.payload_json, '$.independence_policy'), 'legacy-unverified'),
          'scientific_provenance', json_extract(c.payload_json, '$.scientific_provenance'),
          'verification', json_extract(c.payload_json, '$.verification'),
          'capable_of_failure', x.capable_of_failure, 'rubric', json(x.rubric_json),
          'body_md', x.body_md, 'cas_hash', x.cas_hash,
          'event', e.id, 'seq', e.seq, 'fellow', e.actor_fellow_id,
          'sponsor', e.actor_sponsor_id, 'session', e.actor_session_id,
          'model_self_declared', e.model_string_self_declared, 'harness_self_declared', e.harness
        ) END AS body
      FROM reviews x JOIN events e ON e.id = x.source_event_id
        AND e.problem_id = x.problem_id AND e.object_id = x.review_id
        AND e.object_kind = 'review' AND e.type = 'review.created' AND e.seq = x.source_seq
      LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      WHERE x.problem_id = ? AND x.target_claim_id = ? AND x.target_version = ? AND e.seq <= ?
      ORDER BY e.seq ASC, e.id ASC LIMIT ?
    `)
      .bind(problemId, claimId, version, cursor, LEDGER_PACK_CANDIDATE_LIMIT + 1),
    db
      .prepare(`
      SELECT json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.claim_id') || '@' || json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.version') AS id,
        e.payload_sha256, c.payload_json,
        CASE WHEN c.event_id IS NOT NULL AND c.redacted_at IS NULL THEN json_object(
          'problem', v.problem_id, 'claim_id', v.claim_id, 'version', v.version,
          'kind', v.kind, 'statement', v.statement, 'falsifier', v.falsifier,
          'content_digest', v.content_digest, 'event', e.id, 'seq', e.seq,
          'fellow', e.actor_fellow_id, 'sponsor', e.actor_sponsor_id,
          'session', e.actor_session_id, 'model_self_declared', e.model_string_self_declared,
          'harness_self_declared', e.harness,
          'scientific_provenance', json_extract(c.payload_json, '$.scientific_provenance')) END AS body
      FROM events parent JOIN event_content pc ON pc.event_id = parent.id
        AND pc.payload_sha256 = parent.payload_sha256 AND pc.redacted_at IS NULL
      JOIN json_each(CASE WHEN json_valid(pc.payload_json) THEN pc.payload_json ELSE '{}' END, '$.dependency_pins') pin
      LEFT JOIN events e ON e.id = json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.event_id')
        AND e.problem_id = parent.problem_id AND e.object_kind = 'claim'
        AND e.type IN ('claim.created', 'claim.revised') AND e.seq < parent.seq
        AND e.object_id = json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.claim_id')
        AND e.object_version = json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.version')
        AND e.payload_sha256 = json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.payload_digest')
      LEFT JOIN claim_versions v ON v.problem_id = e.problem_id AND v.claim_id = e.object_id
        AND v.version = e.object_version AND v.content_digest = json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.content_digest')
      LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
        AND v.claim_id IS NOT NULL
      WHERE parent.problem_id = ? AND parent.object_id = ? AND parent.object_version = ?
        AND parent.object_kind = 'claim' AND parent.type IN ('claim.created', 'claim.revised')
        AND parent.seq <= ?
      ORDER BY CAST(pin.key AS INTEGER) ASC LIMIT 17
    `)
      .bind(problemId, claimId, version, cursor),
  ];
}

async function composeTargetClaimPack(
  results: D1Result[],
  problemId: string,
  target: string,
  through?: number,
): Promise<LedgerPackSection> {
  type TargetRow = {
    id: string;
    body: string | null;
    payload_sha256: string;
    payload_json: string | null;
  };
  const section: LedgerPackSection = {
    candidates: [],
    omitted: [],
  };
  const claim = results[0]?.results[0] as TargetRow | undefined;
  if (claim?.body === null || claim?.body === undefined) {
    section.omitted.push({ reason: "content_unavailable", detail: target });
    return section;
  }
  const [claimId, versionText] = target.split("@");
  const version = Number(versionText);
  const claimBody = JSON.parse(claim.body) as Record<string, unknown>;
  let dependencyPins: ClaimDependencyPin[] | null = null;
  try {
    if (claim.payload_json === null) throw new ScientificInputError("Claim content unavailable.");
    const payload = await checkedScientificPayload({ ...claim, payload_json: claim.payload_json });
    const pins = ClaimDependencyPinsSchema.safeParse(payload.dependency_pins);
    if (pins.success && !pins.data.some((pin) => pin.claim_id === claimId))
      dependencyPins = pins.data;
  } catch (error) {
    if (!(error instanceof ScientificInputError)) throw error;
    section.omitted.push({ reason: "content_unavailable", detail: target });
    return section;
  }
  if (dependencyPins === null)
    section.omitted.push({ reason: "dependency_history_unavailable", detail: target });
  else if (dependencyPins.length > 0)
    section.omitted.push({
      reason: "profile_section_not_composed",
      detail: "transitive-dependency-closure-and-evidence-ceiling",
    });
  const groups = [
    [0, "claim-detail"],
    [3, "claim-dependency"],
    [1, "claim-evidence"],
    [2, "claim-review"],
  ] as const;
  for (const [index, [resultIndex, kind]] of groups.entries()) {
    if (kind === "claim-dependency" && dependencyPins === null) continue;
    const rows = (results[resultIndex]?.results ?? []) as TargetRow[];
    if (kind === "claim-dependency" && rows.length !== dependencyPins?.length) {
      section.omitted.push({ reason: "dependency_history_unavailable", detail: target });
      continue;
    }
    if (rows.length > LEDGER_PACK_CANDIDATE_LIMIT)
      section.omitted.push({ reason: "candidate_limit", detail: `${target}:${kind}` });
    for (const [position, row] of rows.slice(0, LEDGER_PACK_CANDIDATE_LIMIT).entries()) {
      let body: string | null = null;
      if (row.body !== null && row.payload_json !== null) {
        try {
          const payload = await checkedScientificPayload({
            ...row,
            payload_json: row.payload_json,
          });
          const projected = JSON.parse(row.body) as Record<string, unknown>;
          if (kind === "claim-detail") {
            if (
              payload.claim_id !== claimId ||
              typeof payload.statement !== "string" ||
              (version > 1 && payload.base_version !== version - 1)
            )
              throw new ScientificInputError(
                "Claim content does not match the requested identity.",
              );
            projected.statement = payload.statement;
            projected.dependency_pins = dependencyPins;
          } else if (kind === "claim-dependency") {
            const pin = dependencyPins?.[position];
            if (
              !pin ||
              row.id !== `${pin.claim_id}@${pin.version}` ||
              projected.event !== pin.event_id ||
              row.payload_sha256 !== pin.payload_digest ||
              projected.content_digest !== pin.content_digest ||
              projected.version !== pin.version ||
              payload.claim_id !== pin.claim_id ||
              typeof payload.statement !== "string" ||
              (pin.version > 1 && payload.base_version !== pin.version - 1)
            )
              throw new ScientificInputError(
                "Dependency content does not match its publication pin.",
              );
            projected.statement = payload.statement;
            projected.parent_target = target;
            projected.read_url = `/p/${problemId}/claims/${row.id}.md${through === undefined ? "" : `?through=${through}`}`;
          } else if (kind === "claim-review") {
            if (
              payload.target_claim_id !== claimId ||
              payload.target_version !== version ||
              typeof claimBody.sponsor !== "string" ||
              typeof projected.sponsor !== "string"
            )
              throw new ScientificInputError("Review content does not match its version pin.");
            projected.tier = recordedReviewIndependence(
              payload,
              claimBody.sponsor,
              projected.sponsor,
            ).tier;
            for (const key of [
              "verdict",
              "basis",
              "capable_of_failure",
              "rubric",
              "body_md",
              "scientific_provenance",
              "verification",
            ])
              projected[key] = payload[key] ?? null;
          } else {
            if (
              payload.bears_on_kind !== "claim" ||
              payload.bears_on_id !== claimId ||
              payload.bears_on_version !== version
            )
              throw new ScientificInputError("Evidence content does not match its version pin.");
            for (const key of [
              "kind",
              "direction",
              "computed_class",
              "coercion_flags",
              "mode",
              "computation_domain_or_floor",
              "reproduction",
              "selected_hypothesis_id",
              "body_md",
            ])
              projected[key] = payload[key] ?? null;
            const source = payload.source;
            if (source === null || typeof source !== "object" || Array.isArray(source))
              throw new ScientificInputError("Evidence source provenance is unavailable.");
            const provenance = source as Record<string, unknown>;
            projected.source_kind = provenance.kind;
            projected.locator = provenance.locator ?? null;
            projected.excerpt = provenance.excerpt ?? null;
          }
          body = JSON.stringify(projected);
        } catch (error) {
          if (!(error instanceof ScientificInputError)) throw error;
        }
      }
      if (body === null) {
        section.omitted.push({ reason: "content_unavailable", detail: row.id });
        if (kind === "claim-detail") return section;
      } else if (body.length > 18000 || neutralizeUntrustedBody(body).text.length > 18000) {
        // Check both original and neutralized size; escaping can expand hostile
        // markers. Never let one record break the pack or truncate the object.
        section.omitted.push({ reason: "item_too_large", detail: row.id });
      } else {
        section.candidates.push({
          kind,
          id: row.id,
          scope: "ledger",
          untrusted: true,
          tokens: 1,
          body,
          why_included: `public record for ${problemId}#${target} at the pack cursor`,
          stable_prefix: 3 + index * LEDGER_PACK_CANDIDATE_LIMIT + position,
        });
      }
    }
    if (rows.length === 0)
      section.candidates.push({
        kind: "standing-context",
        id: `SYS-${kind}-empty`,
        scope: "system",
        untrusted: false,
        tokens: 1,
        body: `No recorded ${kind} for ${target} at this cursor.`,
        why_included: "state the exact-version baseline without inventing support",
        stable_prefix: 3 + index * LEDGER_PACK_CANDIDATE_LIMIT,
      });
  }
  return section;
}

/** Public ledger only. Call after session ownership and membership checks.
 * Every mutable head/lifecycle is reconstructed at the caller's captured cut;
 * no later revision or settlement may be borrowed from a projection's head.
 * Current redaction still wins over an older cursor.
 */
export async function readLedgerPackSection(
  db: Env["DB"],
  problemId: string,
  cursor: number,
  profile: PackProfile,
): Promise<LedgerPackSection> {
  let rows: ProvenanceRow[];
  let kind: string;
  let section: string;
  let describeRow: (row: ProvenanceRow) => string;
  if (profile === "formal") {
    kind = "proof-gap";
    section = "proof-gaps";
    const result = await db
      .prepare(`
      SELECT g.gap_id AS id, g.obligation, g.closes_what,
             g.target_claim_id, g.target_version,
             e.id AS event_id, e.seq, e.actor_fellow_id AS fellow_id,
             e.actor_sponsor_id AS sponsor_id, e.actor_session_id AS session_id,
             e.model_string_self_declared AS model, e.harness,
             (c.event_id IS NOT NULL AND c.redacted_at IS NULL) AS content_available
      FROM proof_gaps g JOIN events e
        ON e.problem_id = g.problem_id AND e.object_id = g.gap_id
       AND e.object_kind = 'gap' AND e.type = 'gap.filed'
      LEFT JOIN event_content c ON c.event_id = e.id
      WHERE g.problem_id = ? AND e.seq <= ?
        AND NOT EXISTS (
          SELECT 1 FROM events closed
          WHERE closed.problem_id = e.problem_id AND closed.object_id = e.object_id
            AND closed.object_kind = 'gap' AND closed.type IN ('gap.closed-by', 'gap.withdrawn')
            AND closed.seq > e.seq AND closed.seq <= ?
        )
      ORDER BY e.seq ASC, e.id ASC LIMIT ?
    `)
      .bind(problemId, cursor, cursor, LEDGER_PACK_CANDIDATE_LIMIT + 1)
      .all<GapRow>();
    rows = result.results;
    describeRow = (value) => {
      const row = value as GapRow;
      return `Open gap ${row.id} in ${row.target_claim_id}@${row.target_version}\nObligation: ${row.obligation}\nCloses: ${row.closes_what}`;
    };
  } else if (profile === "graveyard") {
    kind = "killed-hypothesis";
    section = "killed-hypotheses";
    const result = await db
      .prepare(`
      SELECT h.hypothesis_id AS id, h.route, h.mechanism, h.falsifier,
             h.killed_by_evidence_id, h.kill_reason,
             killed.id AS event_id, killed.seq, killed.actor_fellow_id AS fellow_id,
             h.author_fellow_id,
             killed.actor_sponsor_id AS sponsor_id, killed.actor_session_id AS session_id,
             killed.model_string_self_declared AS model, killed.harness,
             (created_content.event_id IS NOT NULL AND created_content.redacted_at IS NULL
              AND killed_content.event_id IS NOT NULL AND killed_content.redacted_at IS NULL)
               AS content_available
      FROM hypotheses h JOIN events created
        ON created.id = h.source_event_id AND created.problem_id = h.problem_id
       AND created.object_id = h.hypothesis_id AND created.object_kind = 'hypothesis'
       AND created.type = 'hypothesis.created' AND created.seq = h.source_seq
      JOIN events killed
        ON killed.id = h.kill_event_id AND killed.problem_id = h.problem_id
       AND killed.object_id = h.hypothesis_id AND killed.object_kind = 'hypothesis'
       AND killed.type = 'hypothesis.killed' AND killed.seq = h.kill_source_seq
      LEFT JOIN event_content created_content ON created_content.event_id = created.id
      LEFT JOIN event_content killed_content ON killed_content.event_id = killed.id
      WHERE h.problem_id = ? AND created.seq <= ? AND killed.seq <= ?
      ORDER BY killed.seq ASC, killed.id ASC LIMIT ?
    `)
      .bind(problemId, cursor, cursor, LEDGER_PACK_CANDIDATE_LIMIT + 1)
      .all<KilledRow>();
    rows = result.results;
    describeRow = (value) => {
      const row = value as KilledRow;
      return `Killed hypothesis ${row.id}\nRoute author: ${row.author_fellow_id}\nRoute: ${row.route}\nMechanism: ${row.mechanism}\nFalsifier: ${row.falsifier}\nKilling evidence: ${row.killed_by_evidence_id}\nReason: ${row.kill_reason}`;
    };
  } else if (profile === "claim-graph") {
    kind = "claim-relation";
    section = "typed-relations";
    const result = await db
      .prepare(`
      SELECT e.id AS id, e.id AS event_id, e.seq, e.actor_fellow_id AS fellow_id,
             e.actor_sponsor_id AS sponsor_id, e.actor_session_id AS session_id,
             e.model_string_self_declared AS model, e.harness,
             r.kind, r.source_claim_id, r.source_version, r.target_ref,
             (c.event_id IS NOT NULL AND c.redacted_at IS NULL) AS content_available,
             (SELECT MAX(head.object_version) FROM events head
              WHERE head.problem_id = r.problem_id AND head.object_id = r.source_claim_id
                AND head.object_kind = 'claim' AND head.type IN ('claim.created', 'claim.revised')
                AND head.seq <= ?) AS source_head,
             (SELECT MAX(head.object_version) FROM events head
              WHERE head.problem_id = r.problem_id
                AND head.object_id = substr(r.target_ref, 1, instr(r.target_ref, '@') - 1)
                AND head.object_kind = 'claim' AND head.type IN ('claim.created', 'claim.revised')
                AND head.seq <= ?) AS target_head
      FROM claim_relations r JOIN events e
        ON e.id = r.asserted_by_event AND e.problem_id = r.problem_id
       AND e.object_kind = 'relation' AND e.type = 'relation.asserted'
      LEFT JOIN event_content c ON c.event_id = e.id
      WHERE r.problem_id = ? AND e.seq <= ?
      ORDER BY e.seq ASC, e.id ASC LIMIT ?
    `)
      .bind(cursor, cursor, problemId, cursor, LEDGER_PACK_CANDIDATE_LIMIT + 1)
      .all<RelationRow>();
    rows = result.results;
    describeRow = (value) => {
      const row = value as RelationRow;
      const targetVersion = row.target_ref.includes("@")
        ? Number(row.target_ref.slice(row.target_ref.lastIndexOf("@") + 1))
        : null;
      const pins =
        row.source_head === null || (targetVersion !== null && row.target_head === null)
          ? "unavailable"
          : row.source_head !== row.source_version ||
              (targetVersion !== null && row.target_head !== targetVersion)
            ? "superseded"
            : "current";
      return `Asserted relation: ${row.source_claim_id}@${row.source_version} ${row.kind} ${row.target_ref}\nVersion pins: ${pins}. This edge is an assertion, not an established implication.`;
    };
  } else {
    return { candidates: [], omitted: [] };
  }
  const omitted: LedgerPackSection["omitted"] =
    rows.length > LEDGER_PACK_CANDIDATE_LIMIT
      ? [{ reason: "candidate_limit", detail: section }]
      : [];
  const candidates: PackCandidate[] = [];
  for (const [index, row] of rows.slice(0, LEDGER_PACK_CANDIDATE_LIMIT).entries()) {
    if (!row.content_available) {
      omitted.push({ reason: "content_unavailable", detail: `${section}:${row.id}` });
      continue;
    }
    candidates.push({
      kind,
      id: row.id,
      scope: "ledger",
      untrusted: true,
      tokens: 1,
      body: `${describeRow(row)}\nProvenance: ${problemId}#${row.seq}; event=${row.event_id}; fellow=${row.fellow_id ?? "unavailable"}; sponsor=${row.sponsor_id ?? "unavailable"}; session=${row.session_id ?? "unavailable"}\nSelf-declared model: ${row.model ?? "unavailable"}\nSelf-declared harness: ${row.harness ?? "unavailable"}`,
      why_included: `read the recorded ${section} for this profile at the pack cursor`,
      stable_prefix: 20 + index,
    });
  }
  if (rows.length === 0) {
    candidates.push({
      kind: "standing-context",
      id: `SYS-${section}-empty`,
      scope: "system",
      untrusted: false,
      tokens: 1,
      body: `No recorded ${section} are available at this problem cursor.`,
      why_included: `state the ${section} baseline without inventing a scientific result`,
      stable_prefix: 20,
    });
  }
  return { candidates, omitted };
}
