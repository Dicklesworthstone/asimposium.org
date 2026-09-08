import type { PackProfile } from "@asimposium/contracts";
import { neutralizeUntrustedBody, type PackCandidate } from "@asimposium/render";
import type { Env } from "../env";
import {
  independenceTier,
  type ReviewAttribution,
  resolveClaimMethodBasis,
} from "../ledger/review-independence";

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

/** Candidate selection, not permission to submit or a claim of review quality.
 * Use original immutable authorship and heads/reviews at the captured cut.
 * Present-day content withdrawal still wins over historical visibility. */
export async function readReviewQueuePack(
  db: Env["DB"],
  problemId: string,
  cursor: number,
  reviewer: (
    | ReviewAttribution
    | { sponsorId: string; modelFamily: string; methodBasis?: string }
  ) & {
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
      a.harness, a.id AS author_event_id,
      (c.event_id IS NOT NULL AND c.redacted_at IS NULL
       AND ac.event_id IS NOT NULL AND ac.redacted_at IS NULL) AS content_available
    FROM claim_heads pins JOIN events h ON h.problem_id = ? AND h.seq = pins.head_seq
    JOIN claim_versions v
      ON v.problem_id = h.problem_id AND v.claim_id = h.object_id AND v.version = h.object_version
    JOIN events a ON a.problem_id = h.problem_id AND a.seq = pins.author_seq
    LEFT JOIN event_content c ON c.event_id = h.id AND c.payload_sha256 = h.payload_sha256
    LEFT JOIN event_content ac ON ac.event_id = a.id AND ac.payload_sha256 = a.payload_sha256
    WHERE a.actor_fellow_id <> ?
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
      row.sponsor_id === null ||
      row.model === null ||
      row.harness === null
    ) {
      section.omitted.push({ reason: "content_unavailable", detail: `eligible-reviews:${row.id}` });
      continue;
    }
    const body = JSON.stringify({
      problem: problemId,
      target: row.id,
      kind: row.kind,
      statement: row.statement,
      falsifier: row.falsifier,
      prospective_independence_tier: independenceTier(
        {
          sponsorId: row.sponsor_id,
          modelFamily: row.model,
          methodBasis: resolveClaimMethodBasis(row.kind, row.statement),
        },
        {
          sponsorId: reviewer.sponsorId,
          modelFamily: reviewer.modelFamily,
          methodBasis: reviewer.methodBasis ?? "",
        },
      ),
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

/** Exact-version read, exclusively from the public ledger. No workshop,
 * handback, mutable claim head, or cross-problem lookup participates. */
export async function readTargetClaimPack(
  db: Env["DB"],
  problemId: string,
  cursor: number,
  target: string,
): Promise<LedgerPackSection> {
  const [claimId, versionText] = target.split("@");
  const version = Number(versionText);
  type TargetRow = { id: string; body: string | null };
  const results = await db.batch([
    db
      .prepare(`
      SELECT v.claim_id || '@' || v.version AS id,
        CASE WHEN c.event_id IS NOT NULL AND c.redacted_at IS NULL THEN json_object(
          'problem', v.problem_id, 'claim_id', v.claim_id, 'version', v.version,
          'kind', v.kind, 'statement', v.statement, 'falsifier', v.falsifier,
          'content_digest', v.content_digest, 'event', e.id, 'seq', e.seq,
          'fellow', e.actor_fellow_id, 'sponsor', e.actor_sponsor_id,
          'session', e.actor_session_id, 'model_self_declared', e.model_string_self_declared,
          'harness_self_declared', e.harness) END AS body
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
      SELECT x.evidence_id AS id,
        CASE WHEN c.event_id IS NOT NULL AND c.redacted_at IS NULL THEN json_object(
          'problem', x.problem_id, 'target', x.bears_on_id || '@' || x.bears_on_version,
          'kind', x.kind, 'direction', x.direction, 'computed_class', x.computed_class,
          'coercion_flags', json(x.coercion_flags_json), 'mode', x.mode,
          'source_kind', x.source_kind, 'locator', x.locator, 'excerpt', x.excerpt,
          'computation_domain_or_floor', x.computation_domain_or_floor,
          'reproduction', json(x.reproduction_json), 'selected_hypothesis_id', x.selected_hypothesis_id,
          'body_md', x.body_md, 'cas_hash', x.cas_hash,
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
      SELECT x.review_id AS id,
        CASE WHEN c.event_id IS NOT NULL AND c.redacted_at IS NULL THEN json_object(
          'problem', x.problem_id, 'target', x.target_claim_id || '@' || x.target_version,
          'tier', x.tier, 'verdict', x.verdict, 'basis', x.basis,
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
  ]);
  const section: LedgerPackSection = {
    candidates: [],
    omitted: [{ reason: "profile_section_not_composed", detail: "version-pinned-dependencies" }],
  };
  const claim = results[0]?.results[0] as TargetRow | undefined;
  if (claim?.body === null || claim?.body === undefined) {
    section.omitted.push({ reason: "content_unavailable", detail: target });
    return section;
  }
  for (const [index, kind] of ["claim-detail", "claim-evidence", "claim-review"].entries()) {
    const rows = (results[index]?.results ?? []) as TargetRow[];
    if (rows.length > LEDGER_PACK_CANDIDATE_LIMIT)
      section.omitted.push({ reason: "candidate_limit", detail: `${target}:${kind}` });
    for (const [position, row] of rows.slice(0, LEDGER_PACK_CANDIDATE_LIMIT).entries()) {
      if (row.body === null) {
        section.omitted.push({ reason: "content_unavailable", detail: row.id });
      } else if (row.body.length > 18000 || neutralizeUntrustedBody(row.body).text.length > 18000) {
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
          body: row.body,
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
