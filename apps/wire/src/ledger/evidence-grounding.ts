import type { D1Database } from "@cloudflare/workers-types";

/** Admission reads, not historical presentation. Closed routes cannot acquire
 * new positive authority through another evidence object's method/check pins. */
export const EVIDENCE_GROUNDING_NODE_LIMIT = 64;
export const EVIDENCE_GROUNDING_BYTE_LIMIT = 1024 * 1024;
const SOURCE_BYTE_LIMIT = 512 * 1024;
const REFERENCE_LIMIT = 16;
const EVIDENCE_ID = /^E-[A-Za-z0-9]{1,78}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export class EvidenceGroundingError extends Error {
  constructor(readonly reason: "unavailable" | "invalid" | "limit") {
    super(reason === "limit"
      ? "The complete evidence dependency graph exceeds the admission budget; use a smaller, independently grounded work product."
      : "An exact evidence dependency is unavailable, withdrawn, or cannot ground this claim version. Fetch a fresh pack and re-anchor the work.");
  }
}
export interface EvidenceReference { readonly evidence_id: string; readonly digest: string }
export interface GroundingWitness {
  readonly eventId: string;
  readonly payloadDigest: string;
  readonly payloadJson: string;
  readonly problemId: string;
}
export interface GroundedEvidence extends GroundingWitness {
  readonly evidenceId: string;
  readonly sequence: number;
  readonly fellowId: string;
  readonly sponsorId: string;
  readonly kind: string;
  readonly direction: string;
  readonly body: string;
  readonly payload: Record<string, unknown>;
}
interface Row {
  evidence_id: string; expected_sha256: string; event_id: string | null;
  seq: number | null; payload_sha256: string | null; payload_json: string | null;
  fellow_id: string | null; sponsor_id: string | null;
}

/** UNION deduplicates (id,digest), and the recursive LIMIT bounds traversal,
 * not merely the final result page. A 65th node means refusal, never a prefix
 * presented as a complete proof. Each expansion examines <=32 declared pins.
 * Bodies are bounded before JSON expansion and never searched for references.
 */
export const EVIDENCE_GROUNDING_SQL = `WITH RECURSIVE
  scope AS (SELECT id, public_seq FROM problems WHERE id = ? AND status <> 'private-draft'),
  nodes(evidence_id, expected_sha256) AS (
    SELECT json_extract(value, '$.evidence_id'), substr(json_extract(value, '$.digest'), 8)
    FROM json_each(?)
    UNION
    SELECT json_extract(ref.value, '$.evidence_id'), substr(json_extract(ref.value, '$.digest'), 8)
    FROM nodes n JOIN scope p
    JOIN events e ON e.problem_id = p.id AND e.object_id = n.evidence_id
      AND e.type = 'evidence.created' AND e.object_kind = 'evidence' AND e.object_version = 1
      AND e.payload_sha256 = n.expected_sha256 AND e.seq <= p.public_seq
    JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      AND c.redacted_at IS NULL AND length(CAST(c.payload_json AS BLOB)) <= ${SOURCE_BYTE_LIMIT}
    JOIN json_each(json_array(
      json_extract(CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END, '$.falsification_check.evidence'),
      json_extract(CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END, '$.scientific_provenance.method.evidence')
    )) groups
    JOIN json_each(CASE WHEN groups.type = 'array' THEN groups.value ELSE '[]' END) ref
    WHERE ref.type = 'object' AND CAST(ref.key AS INTEGER) < ${REFERENCE_LIMIT}
      AND json_type(ref.value, '$.evidence_id') = 'text' AND json_type(ref.value, '$.digest') = 'text'
      AND NOT EXISTS (SELECT 1 FROM scientific_withdrawals w WHERE w.source_event_id = e.id)
    LIMIT ${EVIDENCE_GROUNDING_NODE_LIMIT + 1}
  )
  SELECT n.evidence_id, n.expected_sha256, e.id AS event_id, e.seq,
    e.payload_sha256, c.payload_json, e.actor_fellow_id AS fellow_id, e.actor_sponsor_id AS sponsor_id
  FROM nodes n JOIN scope p
  LEFT JOIN events e ON e.problem_id = p.id AND e.object_id = n.evidence_id
    AND e.type = 'evidence.created' AND e.object_kind = 'evidence' AND e.object_version = 1
    AND e.payload_sha256 = n.expected_sha256 AND e.seq <= p.public_seq
  LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
    AND c.redacted_at IS NULL AND length(CAST(c.payload_json AS BLOB)) <= ${SOURCE_BYTE_LIMIT}
    AND NOT EXISTS (SELECT 1 FROM scientific_withdrawals w WHERE w.source_event_id = e.id)
  ORDER BY e.seq, n.evidence_id, n.expected_sha256 LIMIT ${EVIDENCE_GROUNDING_NODE_LIMIT + 1}`;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function references(value: unknown): EvidenceReference[] {
  if (!Array.isArray(value) || value.length > REFERENCE_LIMIT) throw new EvidenceGroundingError("invalid");
  const seen = new Set<string>();
  return value.map((ref: unknown) => {
    if (!record(ref) || Object.keys(ref).length !== 2 || typeof ref.evidence_id !== "string" ||
      !EVIDENCE_ID.test(ref.evidence_id) || typeof ref.digest !== "string" || !DIGEST.test(ref.digest) ||
      seen.has(ref.evidence_id)) throw new EvidenceGroundingError("invalid");
    seen.add(ref.evidence_id);
    return { evidence_id: ref.evidence_id, digest: ref.digest };
  });
}
function dependencies(payload: Record<string, unknown>): EvidenceReference[] {
  const result: EvidenceReference[] = [];
  if (payload.falsification_check != null) {
    if (!record(payload.falsification_check)) throw new EvidenceGroundingError("invalid");
    result.push(...references(payload.falsification_check.evidence));
  }
  if (payload.scientific_provenance != null) {
    if (!record(payload.scientific_provenance)) throw new EvidenceGroundingError("invalid");
    const method = payload.scientific_provenance.method;
    if (method != null) {
      if (!record(method)) throw new EvidenceGroundingError("invalid");
      if (method.evidence !== undefined) result.push(...references(method.evidence));
    }
  }
  return result;
}
async function sha256(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    byte => byte.toString(16).padStart(2, "0")).join("");
}

/** All roots share one snapshot and one traversal budget. Returned witnesses
 * are ephemeral commit preconditions; never persist them as a second ledger. */
export async function readEvidenceGrounding(
  db: D1Database, problemId: string, claim: { readonly claimId: string; readonly version: number },
  requested: readonly EvidenceReference[],
): Promise<{ roots: GroundedEvidence[]; witnesses: readonly GroundingWitness[] }> {
  const roots = references(requested);
  if (roots.length === 0) return { roots: [], witnesses: [] };
  if (!Number.isSafeInteger(claim.version) || claim.version < 1) throw new EvidenceGroundingError("invalid");
  const result = await db.prepare(EVIDENCE_GROUNDING_SQL).bind(problemId, JSON.stringify(roots)).all<Row>();
  if (!result.success) throw new EvidenceGroundingError("unavailable");
  if (result.results.length > EVIDENCE_GROUNDING_NODE_LIMIT) throw new EvidenceGroundingError("limit");
  const resolved = new Map<string, GroundedEvidence>();
  let totalBytes = 0;
  for (const row of result.results) {
    if (!row.event_id || !row.fellow_id || !row.sponsor_id || !Number.isSafeInteger(row.seq) || row.seq! < 1 ||
      row.payload_json === null || row.payload_sha256 !== row.expected_sha256) throw new EvidenceGroundingError("unavailable");
    totalBytes += new TextEncoder().encode(row.payload_json).byteLength;
    if (totalBytes > EVIDENCE_GROUNDING_BYTE_LIMIT) throw new EvidenceGroundingError("limit");
    if (await sha256(row.payload_json) !== row.expected_sha256) throw new EvidenceGroundingError("unavailable");
    let payload: unknown;
    try { payload = JSON.parse(row.payload_json); } catch { throw new EvidenceGroundingError("invalid"); }
    if (!record(payload) || payload.bears_on_kind !== "claim" || payload.bears_on_id !== claim.claimId ||
      payload.bears_on_version !== claim.version || payload.mode !== "confirmatory" || payload.selected_hypothesis_id != null ||
      payload.computed_class === "assertion" || payload.computed_class === "heuristic" ||
      typeof payload.kind !== "string" || typeof payload.direction !== "string" ||
      typeof payload.body_md !== "string" || payload.body_md.trim().length === 0) throw new EvidenceGroundingError("invalid");
    if (resolved.has(row.evidence_id)) throw new EvidenceGroundingError("invalid");
    resolved.set(row.evidence_id, { eventId: row.event_id, payloadDigest: row.expected_sha256,
      payloadJson: row.payload_json, problemId, evidenceId: row.evidence_id, sequence: row.seq!,
      fellowId: row.fellow_id, sponsorId: row.sponsor_id, kind: payload.kind, direction: payload.direction,
      body: payload.body_md, payload });
  }
  for (const source of resolved.values()) {
    for (const pin of dependencies(source.payload)) {
      const dependency = resolved.get(pin.evidence_id);
      if (!dependency || pin.digest !== `sha256:${dependency.payloadDigest}` || dependency.sequence >= source.sequence)
        throw new EvidenceGroundingError("invalid");
    }
  }
  return {
    roots: roots.map(pin => {
      const source = resolved.get(pin.evidence_id);
      if (!source || pin.digest !== `sha256:${source.payloadDigest}`) throw new EvidenceGroundingError("unavailable");
      return source;
    }),
    witnesses: [...resolved.values()].map(({ eventId, payloadDigest, payloadJson, problemId: scope }) =>
      ({ eventId, payloadDigest, payloadJson, problemId: scope })),
  };
}
