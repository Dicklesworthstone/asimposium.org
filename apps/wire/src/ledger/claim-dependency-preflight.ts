import type { ClaimDependencyPin } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import {
  composeDependencyClosure,
  DEPENDENCY_CLOSURE_LIMIT,
  DEPENDENCY_CLOSURE_SQL,
  DEPENDENCY_TOTAL_BYTES,
  type DependencyClosureRow,
} from "./claim-dependency-closure.ts";

export class ClaimDependencyAdmissionError extends Error {}

interface AdmissionRow extends DependencyClosureRow {
  newer_version: number;
  withdrawn: number;
}

/** This is current publication admission, not a historical review read. Keep
 * the public reader's exact-pin and redaction rules, then check closure events
 * at the same cut. Migration 0098 repeats the admission guard at settlement to
 * close races after this preflight. SQL supplies candidates; the shared
 * composer verifies the actual bytes before any ancestor is accepted.
 */
export const CLAIM_DEPENDENCY_PREFLIGHT_SQL = `
WITH closure AS MATERIALIZED (${DEPENDENCY_CLOSURE_SQL})
SELECT n.*,
  EXISTS (
    SELECT 1 FROM events later
    WHERE later.problem_id = n.problem_id AND later.object_id = n.claim_id
      AND later.object_kind = 'claim' AND later.type IN ('claim.created', 'claim.revised')
      AND later.object_version > n.version AND later.seq <= ?
  ) AS newer_version,
  EXISTS (
    SELECT 1 FROM retractions r
    JOIN events author ON author.problem_id = n.problem_id AND author.object_id = n.claim_id
      AND author.object_kind = 'claim' AND author.type = 'claim.created'
      AND author.object_version = 1 AND author.actor_fellow_id = r.author_fellow_id
    WHERE r.problem_id = n.problem_id AND r.seq <= ?
      AND r.target_object IN (n.claim_id, n.claim_id || '@' || n.version)
  ) AS withdrawn
FROM closure n ORDER BY n.ordinal`;

/** Refuse before paid screening when a direct premise's published ancestry is
 * already closed, unavailable or incomplete. Return no extra pins: publication
 * still records its direct premises, not a flattened graph that changes their
 * scientific meaning. Historical reviewers never call this admission helper.
 */
export async function requireLiveClaimDependencyClosure(
  db: D1Database,
  problemId: string,
  pins: readonly ClaimDependencyPin[],
): Promise<void> {
  if (pins.length === 0) return;
  if (pins.length > 16 || new Set(pins.map((pin) => pin.claim_id)).size !== pins.length)
    throw new ClaimDependencyAdmissionError("A publication may name at most 16 distinct direct premises.");
  const head = await db.prepare("SELECT public_seq FROM problems WHERE id = ?")
    .bind(problemId).first<{ public_seq: number }>();
  if (!head || !Number.isSafeInteger(head.public_seq) || head.public_seq < 0)
    throw new ClaimDependencyAdmissionError("The dependency publication cursor is unavailable.");
  const cursor = head.public_seq;
  const results = await db.batch(pins.map((pin) =>
    db.prepare(CLAIM_DEPENDENCY_PREFLIGHT_SQL).bind(
      JSON.stringify({ problem: problemId, claim: pin.claim_id, version: pin.version, cursor }),
      cursor, cursor,
    ),
  ));
  if (results.length !== pins.length)
    throw new ClaimDependencyAdmissionError("The dependency publication snapshot is incomplete.");
  // The incoming publication occupies one of migration 0098's 64 nodes. The
  // shared reader bounds each root; this merged budget also bounds the forest
  // of distinct roots rather than allowing 16 separately-small graphs through.
  const seen = new Map<string, string>();
  let sourceBytes = 0;
  for (const [index, pin] of pins.entries()) {
    const rows = results[index]?.results as AdmissionRow[] | undefined;
    if (!rows) throw new ClaimDependencyAdmissionError("The dependency publication snapshot is incomplete.");
    const target = `${pin.claim_id}@${pin.version}`;
    const closure = await composeDependencyClosure(rows, problemId, target);
    const root = rows[0];
    if (!closure.root_available || !closure.complete || !root ||
        root.event_id !== pin.event_id || root.payload_sha256 !== pin.payload_digest ||
        root.content_digest !== pin.content_digest)
      throw new ClaimDependencyAdmissionError("A dependency's published ancestry is unavailable, invalid or exceeds the bounded read. Reorient before publishing.");
    const byEvent = new Map(rows.map((row) => [row.event_id, row]));
    for (const source of [root, ...closure.nodes.map((node) => node.row)]) {
      const state = byEvent.get(source.event_id);
      if (state?.newer_version !== 0 || state.withdrawn !== 0)
        throw new ClaimDependencyAdmissionError("A dependency's published ancestry contains a withdrawn or superseded claim version. Re-anchor the dependency chain before publishing.");
      if (source.payload_json === null)
        throw new ClaimDependencyAdmissionError("A dependency's source content is unavailable.");
      const prior = seen.get(source.event_id);
      if (prior !== undefined) {
        if (prior !== source.payload_sha256)
          throw new ClaimDependencyAdmissionError("Dependency publications disagree across the snapshot.");
        continue;
      }
      seen.set(source.event_id, source.payload_sha256);
      sourceBytes += new TextEncoder().encode(source.payload_json).length;
      if (seen.size >= DEPENDENCY_CLOSURE_LIMIT || sourceBytes > DEPENDENCY_TOTAL_BYTES)
        throw new ClaimDependencyAdmissionError("The combined dependency ancestry exceeds the bounded publication budget.");
    }
  }
}
