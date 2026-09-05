import type { PackProfile } from "@asimposium/contracts";
import type { PackCandidate } from "@asimposium/render";
import type { Env } from "../env";

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
