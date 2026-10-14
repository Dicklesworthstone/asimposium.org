import { ClaimDependencyPinsSchema, type ClaimDependencyPin } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { hiddenByContentControlSql } from "../krater/public-content";

// Includes the root. Limits bound work, not a claim that a partial graph is complete.
export const DEPENDENCY_CLOSURE_LIMIT = 64;
export const DEPENDENCY_SOURCE_BYTES = 65_536;
export const DEPENDENCY_TOTAL_BYTES = 262_144;

/** Only immutable publication pins are traversed. The recursive UNION deduplicates
 * diamonds before expansion; its LIMIT also bounds hostile/corrupt graphs. SQL
 * discovers candidates, NOT verified edges: composeDependencyClosure hashes the
 * actual bytes and follows only pins from verified reachable parents. */
export function prepareDependencyClosure(
  db: D1Database,
  problem: string,
  cursor: number,
  target: string,
): D1PreparedStatement {
  const [claim, version] = target.split("@");
  if (/^C-[0-9]+@[1-9][0-9]*$/.exec(target)?.[0] !== target || target.length > 64 ||
      !Number.isSafeInteger(Number(version)) ||
      Number(version) < 1 || !Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error("An exact claim version and published cursor are required.");
  return db.prepare(DEPENDENCY_CLOSURE_SQL).bind(JSON.stringify({
    problem, claim, version: Number(version), cursor,
  }));
}

export const DEPENDENCY_CLOSURE_SQL = `
WITH RECURSIVE input(j) AS (VALUES (?)),
root AS MATERIALIZED (
  SELECT e.id FROM events e JOIN problems p ON p.id = e.problem_id, input
  WHERE e.problem_id = json_extract(j, '$.problem')
    AND e.object_id = json_extract(j, '$.claim')
    AND e.object_version = json_extract(j, '$.version')
    AND e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised')
    AND p.status <> 'private-draft' AND e.seq <= p.public_seq
    AND e.seq <= json_extract(j, '$.cursor')
  ORDER BY e.seq, e.id LIMIT 1
),
walk(id) AS (
  SELECT id FROM root
  UNION
  SELECT child.id FROM walk
  JOIN events parent ON parent.id = walk.id
  JOIN event_content c ON c.event_id = parent.id AND c.payload_sha256 = parent.payload_sha256
  JOIN json_each(CASE WHEN c.redacted_at IS NULL
    AND length(CAST(c.payload_json AS BLOB)) <= ${DEPENDENCY_SOURCE_BYTES}
    AND NOT ${hiddenByContentControlSql("parent.problem_id", "parent.object_id")}
    AND NOT ${hiddenByContentControlSql("parent.problem_id", "'problem'")}
    THEN CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END
    ELSE '{}' END, '$.dependency_pins') pin
  JOIN events child ON child.id = json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.event_id')
    AND child.problem_id = parent.problem_id AND child.object_kind = 'claim'
    AND child.type IN ('claim.created', 'claim.revised') AND child.seq < parent.seq
    AND child.object_id = json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.claim_id')
    AND child.object_version = json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.version')
    AND child.payload_sha256 = json_extract(CASE WHEN pin.type = 'object' THEN pin.value ELSE '{}' END, '$.payload_digest')
  WHERE pin.type = 'object' AND CAST(pin.key AS INTEGER) BETWEEN 0 AND 15
  ORDER BY 1 LIMIT ${DEPENDENCY_CLOSURE_LIMIT + 1}
),
selected AS MATERIALIZED (
  SELECT e.*, v.content_digest,
    row_number() OVER (ORDER BY (e.id = (SELECT id FROM root)) DESC, e.id) AS ordinal,
    CASE WHEN c.redacted_at IS NULL AND c.event_id IS NOT NULL
      AND NOT ${hiddenByContentControlSql("e.problem_id", "e.object_id")}
      AND NOT ${hiddenByContentControlSql("e.problem_id", "'problem'")}
      THEN length(CAST(c.payload_json AS BLOB)) ELSE NULL END AS source_bytes
  FROM walk JOIN events e ON e.id = walk.id
  LEFT JOIN claim_versions v ON v.problem_id = e.problem_id
    AND v.claim_id = e.object_id AND v.version = e.object_version
  LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
),
budgeted AS MATERIALIZED (
  SELECT *, sum(CASE WHEN source_bytes <= ${DEPENDENCY_SOURCE_BYTES}
    THEN source_bytes ELSE 0 END) OVER (ORDER BY ordinal) AS cumulative_bytes
  FROM selected
)
SELECT b.id AS event_id, b.problem_id, b.object_id AS claim_id,
  b.object_version AS version, b.type, b.seq, b.payload_sha256, b.content_digest,
  b.actor_fellow_id AS fellow, b.actor_sponsor_id AS sponsor,
  b.actor_session_id AS session, b.model_string_self_declared AS model_self_declared,
  b.harness AS harness_self_declared, b.ordinal,
  CASE WHEN b.ordinal <= ${DEPENDENCY_CLOSURE_LIMIT}
    AND b.source_bytes <= ${DEPENDENCY_SOURCE_BYTES}
    AND b.cumulative_bytes <= ${DEPENDENCY_TOTAL_BYTES} THEN c.payload_json END AS payload_json
FROM budgeted b LEFT JOIN event_content c ON c.event_id = b.id
  AND c.payload_sha256 = b.payload_sha256
  AND b.ordinal <= ${DEPENDENCY_CLOSURE_LIMIT}
  AND b.source_bytes <= ${DEPENDENCY_SOURCE_BYTES}
  AND b.cumulative_bytes <= ${DEPENDENCY_TOTAL_BYTES}
ORDER BY b.ordinal`;

export interface DependencyClosureRow {
  event_id: string;
  problem_id: string;
  claim_id: string;
  version: number;
  type: string;
  seq: number;
  payload_sha256: string;
  content_digest: string | null;
  fellow: string | null;
  sponsor: string | null;
  session: string | null;
  model_self_declared: string | null;
  harness_self_declared: string | null;
  ordinal: number;
  payload_json: string | null;
}
export interface DependencyClosureNode {
  target: string;
  depth: number;
  /** One deterministic shortest path, not every path through a diamond. */
  path: string[];
  row: DependencyClosureRow;
  statement: string;
  falsifier: string | null;
  kind: string | null;
  pins: ClaimDependencyPin[] | null;
}
export interface DependencyClosure {
  root_available: boolean;
  complete: boolean;
  nodes: DependencyClosureNode[];
  edges: { from: string; to: string; available: boolean }[];
  /** Only references learned from verified reachable source bytes appear here. */
  unavailable: string[];
}

/** A missing pin list is unknown history, never an unconditional premise. This
 * closure describes declared dependency structure only: it neither upgrades a
 * disposition nor certifies evidence, and never substitutes mutable claim_deps. */
export async function composeDependencyClosure(
  rows: readonly DependencyClosureRow[],
  problem: string,
  target: string,
): Promise<DependencyClosure> {
  const output: DependencyClosure = {
    root_available: false, complete: true, nodes: [], edges: [], unavailable: [],
  };
  if (rows.length > DEPENDENCY_CLOSURE_LIMIT) output.complete = false;
  const verified = new Map<string, Omit<DependencyClosureNode, "path" | "depth">>();
  const duplicates = new Set<string>();
  const seen = new Set<string>();
  let bytes = 0;
  for (const row of rows.slice(0, DEPENDENCY_CLOSURE_LIMIT)) {
    if (seen.has(row.event_id)) duplicates.add(row.event_id);
    seen.add(row.event_id);
    if (row.problem_id !== problem || row.payload_json === null ||
        row.payload_json.length > DEPENDENCY_SOURCE_BYTES) continue;
    const encoded = new TextEncoder().encode(row.payload_json);
    bytes += encoded.length;
    if (encoded.length > DEPENDENCY_SOURCE_BYTES || bytes > DEPENDENCY_TOTAL_BYTES) continue;
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== row.payload_sha256) continue;
    let body: unknown;
    try { body = JSON.parse(row.payload_json); } catch { continue; }
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const payload = body as Record<string, unknown>;
    if (payload.claim_id !== row.claim_id || typeof payload.statement !== "string" ||
        payload.statement.trim().length === 0 || !Number.isSafeInteger(row.version) ||
        row.version < 1 || !Number.isSafeInteger(row.seq) || row.seq < 1 ||
        !/^C-[0-9]+$/.test(row.claim_id) || !row.content_digest ||
        (row.type === "claim.created" ? row.version !== 1 :
          row.type !== "claim.revised" || row.version < 2 || payload.base_version !== row.version - 1))
      continue;
    const pins = ClaimDependencyPinsSchema.safeParse(payload.dependency_pins);
    verified.set(row.event_id, {
      target: `${row.claim_id}@${row.version}`, row, statement: payload.statement,
      falsifier: typeof payload.falsifier === "string" ? payload.falsifier : null,
      kind: typeof payload.kind === "string" ? payload.kind : null,
      pins: pins.success && !pins.data.some((pin) => pin.claim_id === row.claim_id) ? pins.data : null,
    });
  }
  for (const id of duplicates) verified.delete(id);
  const root = rows[0] && verified.get(rows[0].event_id);
  if (!root || root.target !== target) {
    output.complete = false;
    output.unavailable.push(target);
    return output;
  }
  output.root_available = true;
  const queue: DependencyClosureNode[] = [{ ...root, depth: 0, path: [target] }];
  const reached = new Set([root.row.event_id]);
  const unavailable = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index];
    if (!node) break;
    if (node.depth > 0) output.nodes.push(node);
    if (node.pins === null) {
      output.complete = false;
      unavailable.add(node.target);
      continue;
    }
    for (const pin of node.pins) {
      const childTarget = `${pin.claim_id}@${pin.version}`;
      const child = verified.get(pin.event_id);
      const available = !!child && child.target === childTarget &&
        child.row.payload_sha256 === pin.payload_digest &&
        child.row.content_digest === pin.content_digest && child.row.seq < node.row.seq &&
        !node.path.some((step) => step.split("@")[0] === pin.claim_id);
      output.edges.push({ from: node.target, to: childTarget, available });
      if (!available) {
        output.complete = false;
        unavailable.add(childTarget);
      } else if (child && !reached.has(pin.event_id)) {
        reached.add(pin.event_id);
        queue.push({ ...child, depth: node.depth + 1, path: [...node.path, childTarget] });
      }
    }
  }
  output.unavailable = [...unavailable];
  return output;
}
