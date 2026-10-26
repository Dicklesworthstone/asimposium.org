import { SponsorWorkshopObjectSchema } from "@asimposium/contracts";
import {
  SPONSOR_DATA_EXPORT_EXCLUSIONS,
  SPONSOR_DATA_EXPORT_FORMAT,
  SPONSOR_DATA_EXPORT_MAX_RESPONSE_BYTES,
  SPONSOR_DATA_EXPORT_PAGE_LIMIT,
  SPONSOR_DATA_EXPORT_SECTIONS,
  SponsorDataExportRecordSchema,
  type SponsorDataExportRequest,
  type SponsorDataExportResponse,
  SponsorDataExportResponseSchema,
  type SponsorDataExportSection,
} from "@asimposium/contracts/account-export";
import type { Env } from "../env.ts";
import { casKeyForHash } from "../krater/cas.ts";

export class AccountExportError extends Error {
  constructor(readonly kind: "changed" | "unavailable" | "missing") {
    super(`ACCOUNT_EXPORT_${kind.toUpperCase()}`);
  }
}

type Row = Record<string, unknown> & { _row: number };
const owned = (alias: string) =>
  `EXISTS (SELECT 1 FROM enrollment_fellows owner WHERE owner.fellow_id = ${alias}.fellow_id AND owner.sponsor_id = ?1)`;
const page = (table: string, alias: string, columns: string, condition: string, joins = "") =>
  `SELECT ${alias}.rowid AS _row, ${columns} FROM ${table} ${alias} ${joins}
   WHERE ${condition} AND ${alias}.rowid > ?2 ORDER BY ${alias}.rowid LIMIT ?3`;

/** Each selection lists its fields. Tokens, hashes, enrollment secrets,
 * encrypted replay bodies and internal review records are never selected. */
const QUERIES: Record<SponsorDataExportSection, string> = {
  account: page(
    "sponsors",
    "s",
    "s.sponsor_id, s.created_at, s.active_fellow_limit",
    "s.sponsor_id = ?1 AND s.tombstoned_at IS NULL",
  ),
  fellows: page(
    "enrollment_fellows",
    "f",
    `f.fellow_id, f.name, f.model, f.harness,
    f.status, f.created_at, f.status_changed_at, g.granted_scopes_json,
    CASE WHEN g.granted_resources_json IS NULL THEN NULL
      ELSE json_remove(g.granted_resources_json, '$.firstDirective') END AS granted_resources_json`,
    "f.sponsor_id = ?1",
    "LEFT JOIN enrollment_grants g ON g.fellow_id = f.fellow_id",
  ),
  // The immutable grant follows a transferred Fellow, but its original first
  // directive remains private to its author. Only that sponsor's enrollment
  // section includes the complete original requested and approved resources.
  enrollments: page(
    "enrollment_records",
    "r",
    `r.enrollment_id, r.kind, r.created_at, r.invalidated,
    r.requested_scopes_json, r.requested_resources_json, p.proposal_id, p.fellow_id,
    p.name, p.model, p.harness, p.reasoning_effort, p.tools_note, p.status,
    p.created_at AS proposal_created_at, p.expires_at, p.granted_scopes_json, p.granted_resources_json`,
    "r.sponsor_id = ?1",
    "LEFT JOIN enrollment_proposals p ON p.enrollment_id = r.enrollment_id",
  ),
  lifecycle: page(
    "fellow_lifecycle_events",
    "l",
    `l.event_id, l.sponsor_seq, l.action,
    l.fellow_id, l.from_status, l.to_status, l.effective_at, l.review_from`,
    "l.sponsor_id = ?1",
  ),
  transfers: page(
    "sponsor_fellow_transfers",
    "t",
    `t.transfer_id, t.fellow_id,
    t.source_sponsor_id, t.target_sponsor_id, t.status, t.created_at, t.expires_at,
    t.resolved_at, t.transfer_manifest_json`,
    "(t.source_sponsor_id = ?1 OR t.target_sponsor_id = ?1)",
  ),
  memberships: page(
    "problem_memberships",
    "m",
    "m.fellow_id, m.problem_id, m.role, m.joined_at",
    owned("m"),
  ),
  stewardships: page(
    "problem_stewards",
    "s",
    "s.problem_id, s.is_founding, s.created_at",
    "s.sponsor_id = ?1",
  ),
  sessions: page(
    "sessions",
    "s",
    `s.session_id, s.fellow_id, s.problem_id, s.intent,
    s.opened_at, s.closed_at, s.handback, s.close_keep_json, s.close_discard_json`,
    owned("s"),
  ),
  workshop: page(
    "workshop_objects",
    "w",
    `w.workshop_id, w.fellow_id, w.problem_id,
    w.session_id, w.type, w.title, w.body_md, w.cas_hash, w.relates_to_json,
    w.workshop_seq, w.created_at, w.current_version, w.state, w.ledger_intent_json,
    w.publication_json, w.revision_json`,
    owned("w"),
  ),
  workshop_history: page(
    "workshop_revisions",
    "r",
    `r.workshop_id, r.fellow_id,
    r.problem_id, r.session_id, r.version, r.type, r.title, r.body_md, r.cas_hash,
    r.relates_to_json, w.workshop_seq, r.created_at, w.current_version, w.state,
    r.ledger_intent_json, r.publication_json, r.revision_json, r.revise_action,
    r.acting_sponsor_id, r.publication_event_id`,
    owned("r"),
    "JOIN workshop_objects w ON w.workshop_id = r.workshop_id AND w.fellow_id = r.fellow_id AND w.problem_id = r.problem_id",
  ),
  directives: page(
    "sponsor_directives",
    "d",
    "d.id, d.fellow_id, d.problem_id, d.verb, d.body, d.created_at",
    "d.sponsor_id = ?1",
  ),
  private_problems: page(
    "problems",
    "p",
    `p.id AS problem_id, p.title, p.created_at,
    p.updated_at, p.current_statement_version, p.created_by_fellow_id,
    p.areas AS areas_json, p.famous_guardrail`,
    "p.sponsor_id = ?1 AND p.status = 'private-draft'",
  ),
  private_statements: page(
    "problem_statement_versions",
    "v",
    `v.problem_id, v.version,
    v.statement, v.falsifier, v.motivation, v.created_at`,
    "p.sponsor_id = ?1 AND p.status = 'private-draft'",
    "JOIN problems p ON p.id = v.problem_id",
  ),
  briefs: page(
    "sponsor_problem_briefs",
    "b",
    `b.id, b.assigned_fellow_id, b.title,
    b.statement, b.falsifier, b.motivation, b.areas AS areas_json, b.famous_guardrail,
    b.status, b.created_at, b.updated_at`,
    "b.sponsor_id = ?1",
  ),
  follows: page(
    "problem_follows",
    "f",
    "f.problem_id, f.created_at AS updated_at",
    "f.principal_id = ?1",
  ),
  public_events: page(
    "events",
    "e",
    `e.id AS event_id, e.problem_id, e.seq, e.type,
    e.object_kind, e.object_id, e.object_version, e.created_at, e.actor_fellow_id,
    e.actor_sponsor_id, e.actor_session_id`,
    "e.actor_sponsor_id = ?1 AND p.status <> 'private-draft'",
    "JOIN problems p ON p.id = e.problem_id",
  ),
};

async function revision(db: Env["DB"], sponsorId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT r.revision FROM sponsors s
    JOIN sponsor_export_revisions r ON r.sponsor_id = s.sponsor_id
    WHERE s.sponsor_id = ? AND s.tombstoned_at IS NULL`)
    .bind(sponsorId)
    .first<{ revision: number }>();
  if (!row) throw new AccountExportError("missing");
  if (!Number.isSafeInteger(row.revision) || row.revision < 0)
    throw new AccountExportError("unavailable");
  return row.revision;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new AccountExportError("unavailable");
  try {
    return JSON.parse(value);
  } catch {
    throw new AccountExportError("unavailable");
  }
}

async function workshopData(env: Pick<Env, "ARTIFACTS">, row: Row) {
  let body = row.body_md;
  if (row.cas_hash !== null) {
    if (typeof row.cas_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(row.cas_hash))
      throw new AccountExportError("unavailable");
    const digest = row.cas_hash.slice(7);
    const object = await env.ARTIFACTS.get(casKeyForHash(digest));
    if (!object) throw new AccountExportError("unavailable");
    if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > 524_288) {
      await object.body.cancel();
      throw new AccountExportError("unavailable");
    }
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength !== object.size) throw new AccountExportError("unavailable");
    const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (actual !== digest) throw new AccountExportError("unavailable");
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  }
  return SponsorWorkshopObjectSchema.parse({
    workshop_id: row.workshop_id,
    type: row.type,
    title: row.title,
    body_md: body,
    relates_to: parseJson(row.relates_to_json),
    workshop_seq: row.workshop_seq,
    created_at: row.created_at,
    version: row.version ?? row.current_version,
    current_version: row.current_version,
    state: row.state,
    ...(row.ledger_intent_json === null
      ? {}
      : { ledger_intent: parseJson(row.ledger_intent_json) }),
    ...(row.publication_json === null ? {} : { publication: parseJson(row.publication_json) }),
    ...(row.revision_json === null ? {} : { revision: parseJson(row.revision_json) }),
  });
}

async function materialize(
  env: Pick<Env, "ARTIFACTS">,
  section: SponsorDataExportSection,
  row: Row,
) {
  const { _row: unused, ...fields } = row;
  void unused;
  let data: unknown = fields;
  if (section === "workshop" || section === "workshop_history") {
    data = {
      fellow_id: row.fellow_id,
      problem_id: row.problem_id,
      session_id: row.session_id,
      object: await workshopData(env, row),
      ...(section === "workshop_history"
        ? {
            revise_action: row.revise_action,
            acting_sponsor_id: row.acting_sponsor_id,
            publication_event_id: row.publication_event_id,
          }
        : {}),
    };
  } else if (section === "transfers") {
    const { transfer_manifest_json, ...transfer } = fields;
    data = { ...transfer, manifest: parseJson(transfer_manifest_json) };
  } else if (section === "enrollments") {
    data = { ...fields, invalidated: fields.invalidated === 1 };
  } else if (section === "stewardships") {
    data = { ...fields, is_founding: fields.is_founding === 1 };
  } else if (section === "follows") {
    data = { ...fields, following: true };
  } else if (section === "public_events") {
    data = {
      ...fields,
      read_url: `/r/p/${encodeURIComponent(String(row.problem_id))}/events/${row.seq}`,
    };
  }
  return SponsorDataExportRecordSchema.parse({ kind: section, data });
}

/** Read-only, current-ownership export. The immutable data revision is pinned
 * across sections; no page claims completeness when SQL or CAS is missing. */
export async function readSponsorDataExportPage(
  env: Pick<Env, "DB" | "ARTIFACTS">,
  sponsorId: string,
  request: SponsorDataExportRequest,
  now = Date.now(),
): Promise<SponsorDataExportResponse> {
  const current = await revision(env.DB, sponsorId);
  const snapshot = request.cursor?.snapshot ?? { revision: current, exported_at: new Date(now).toISOString() };
  if (snapshot.revision !== current) throw new AccountExportError("changed");
  const section = request.cursor?.section ?? SPONSOR_DATA_EXPORT_SECTIONS[0];
  const after = request.cursor?.after ?? 0;
  const limit = section === "workshop" || section === "workshop_history" ? 2 : SPONSOR_DATA_EXPORT_PAGE_LIMIT;
  const result = await env.DB.prepare(QUERIES[section]).bind(sponsorId, after, limit + 1).all<Row>();
  if (!result.success || !Array.isArray(result.results)) throw new AccountExportError("unavailable");
  const rows = result.results;
  let previous = after;
  if (rows.length > limit + 1) throw new AccountExportError("unavailable");
  for (const row of rows) {
    if (!Number.isSafeInteger(row._row) || row._row <= previous) throw new AccountExportError("unavailable");
    previous = row._row;
  }
  const records: SponsorDataExportResponse["records"] = [];
  let last = after;
  let bytes = 4096;
  for (const row of rows.slice(0, limit)) {
    const record = await materialize(env, section, row);
    const size = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    if (bytes + size > SPONSOR_DATA_EXPORT_MAX_RESPONSE_BYTES) {
      if (records.length === 0) throw new AccountExportError("unavailable");
      break;
    }
    records.push(record);
    bytes += size + 1;
    last = row._row;
  }
  const next = SPONSOR_DATA_EXPORT_SECTIONS[SPONSOR_DATA_EXPORT_SECTIONS.indexOf(section) + 1];
  const nextCursor = records.length < rows.length
    ? { snapshot, section, after: last } : next ? { snapshot, section: next, after: 0 } : null;
  if (await revision(env.DB, sponsorId) !== current) throw new AccountExportError("changed");
  const response = SponsorDataExportResponseSchema.parse({
    version: SPONSOR_DATA_EXPORT_FORMAT, sponsor_id: sponsorId, snapshot, section,
    records, next_cursor: nextCursor, omitted: SPONSOR_DATA_EXPORT_EXCLUSIONS,
  });
  if (new TextEncoder().encode(JSON.stringify(response)).byteLength > SPONSOR_DATA_EXPORT_MAX_RESPONSE_BYTES)
    throw new AccountExportError("unavailable");
  return response;
}
