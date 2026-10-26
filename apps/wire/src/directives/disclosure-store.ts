import {
  EnrollmentFirstDirectiveSchema,
  ScreeningPublicationProvenanceSchema,
} from "@asimposium/contracts";
import {
  DIRECTIVE_DISCLOSURE_MAX_REQUEST_BYTES,
  DIRECTIVE_DISCLOSURE_MAX_RESPONSE_BYTES,
  DIRECTIVE_DISCLOSURES_SCHEMA_ID,
  type DirectiveDisclosurePublication,
  DirectiveDisclosurePublicationSchema,
  type DirectiveDisclosureTarget,
  DirectiveDisclosureTargetSchema,
  type SponsorDirectiveDisclosureReceipt,
  SponsorDirectiveDisclosureReceiptSchema,
  type SponsorDirectiveDisclosureRequest,
  SponsorDirectiveDisclosureRequestSchema,
  type SponsorDirectiveDisclosureState,
  SponsorDirectiveDisclosureStateSchema,
} from "@asimposium/contracts/directive-disclosures";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  canonicalJson,
  KraterIdempotencyConflictError,
  KraterLedgerPreconditionError,
  type KraterWriteHooks,
  sha256Hex,
  writeLedgerEvent,
} from "../krater/krater.ts";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import {
  composeDependencyClosure,
  type DependencyClosureRow,
  prepareDependencyClosure,
} from "../ledger/claim-dependency-closure.ts";
import { type ScreenedPublication, supersedeHeldCaseStatement } from "../screening/ingress.ts";
import {
  isScreeningContextStaleError,
  screeningContextGuardStatement,
  screeningContextStaleProblem,
} from "../screening/publication-context.ts";
import {
  checkAndReserveQuota,
  promotionRateLimitedProblem,
  settleQuotaReservation,
  settleQuotaReservationStatement,
} from "../sessions/quota.ts";

export interface DisclosureTarget {
  readonly problemId: string;
  readonly claimId: string;
  readonly version: number;
}
export class DirectiveDisclosureError extends Error {
  constructor(readonly code: "not-found" | "forbidden" | "conflict" | "unavailable" | "invalid") {
    super(`DIRECTIVE_DISCLOSURE_${code.toUpperCase()}`);
  }
}

/** Trusted SQL expressions only. Values belong in the caller's bound query. */
function targetSql(problem: string, claim: string, version: string): string {
  return `dt.problem_id = (${problem}) AND dt.claim_id = (${claim}) AND dt.claim_version = (${version})`;
}

function sourcesAvailableSql(): string {
  return `NOT EXISTS (
    SELECT 1 FROM json_each(dt.lineage_json, '$.pins') pin
    LEFT JOIN events pe ON pe.id = json_extract(pin.value, '$.event_id')
      AND pe.problem_id = dt.problem_id AND pe.object_kind = 'claim'
      AND pe.object_id = json_extract(pin.value, '$.claim_id')
      AND pe.object_version = json_extract(pin.value, '$.version')
      AND pe.payload_sha256 = json_extract(pin.value, '$.payload_digest')
    LEFT JOIN event_content pc ON pc.event_id = pe.id AND pc.payload_sha256 = pe.payload_sha256
    WHERE pe.id IS NULL OR pc.payload_json IS NULL OR pc.redacted_at IS NOT NULL
      OR pc.payload_json <> json_extract(pin.value, '$.payload_json')
      OR ${eventContentHiddenSql("pe")}
  )`;
}

function coveredSql(cursor?: string): string {
  return `NOT EXISTS (SELECT 1 FROM json_each(dt.scope_requirements_json) needed
    WHERE NOT EXISTS (
      SELECT 1 FROM directive_disclosure_records dr
      JOIN events de ON de.id = dr.event_id AND de.problem_id = dr.problem_id
        AND de.seq = dr.seq AND de.type = 'directive.disclosure-recorded'
        AND de.object_kind = 'directive-disclosure' AND de.object_id = dr.event_id
        AND de.object_version = dr.revision AND de.actor_sponsor_id = dr.sponsor_id
        AND de.actor_fellow_id IS NULL AND de.payload_sha256 = dr.public_payload_sha256
      JOIN event_content dc ON dc.event_id = de.id AND dc.payload_sha256 = de.payload_sha256
        AND dc.redacted_at IS NULL AND dc.payload_json = dr.public_payload_json
      WHERE dr.scope_id = json_extract(needed.value, '$.scope_id')
        AND dr.coverage_digest = json_extract(needed.value, '$.coverage_digest')
        AND dr.problem_id = dt.problem_id AND dr.claim_id = dt.claim_id AND dr.claim_version = dt.claim_version
        AND dr.content_digest = dt.content_digest AND dr.source_event_id = dt.source_event_id
        AND dr.decision <> 'withdraw'
        AND NOT ${eventContentHiddenSql("de")}
        ${cursor === undefined ? "" : `AND dr.seq <= (${cursor})`}
        AND NOT EXISTS (SELECT 1 FROM directive_disclosure_records later
          WHERE later.scope_id = dr.scope_id AND later.revision > dr.revision
          ${
            cursor === undefined
              ? ""
              : `AND (later.seq <= (${cursor}) OR (later.decision = 'withdraw'
            AND NOT EXISTS (SELECT 1 FROM directive_disclosure_records latest
              WHERE latest.scope_id = later.scope_id AND latest.revision > later.revision)))`
          })
    ))`;
}

export function directiveDisclosureCompleteSql(
  problem: string,
  claim: string,
  version: string,
  cursor?: string,
): string {
  return `EXISTS (SELECT 1 FROM directive_disclosure_targets dt WHERE ${targetSql(problem, claim, version)}
    AND dt.invalidated = 0 AND ${sourcesAvailableSql()} AND ${coveredSql(cursor)})`;
}

export function directiveDisclosureStatusSql(
  problem: string,
  claim: string,
  version: string,
  cursor?: string,
): string {
  return `COALESCE((SELECT CASE WHEN dt.invalidated = 1 THEN 'unresolved'
    WHEN NOT ${sourcesAvailableSql()} THEN 'unavailable'
    WHEN ${coveredSql(cursor)} THEN 'satisfied' ELSE 'unresolved' END
    FROM directive_disclosure_targets dt WHERE ${targetSql(problem, claim, version)}), 'missing')`;
}

export function directiveDisclosureLineageSql(
  problem: string,
  claim: string,
  version: string,
): string {
  return `(SELECT dt.lineage_digest FROM directive_disclosure_targets dt WHERE ${targetSql(problem, claim, version)})`;
}

interface Head {
  public_seq: number;
  current_statement_version: number;
  claim_statement_version: number;
  claim_source_seq: number;
  latest_version: number;
}
interface Fellow {
  fellow_id: string;
  sponsor_id: string;
  created_at: number;
  initial_sponsor_id: string;
  enrollment_id: string;
  granted_resources_json: string;
}
interface Transfer {
  row_id: number;
  transfer_id: string;
  fellow_id: string;
  source_sponsor_id: string;
  target_sponsor_id: string;
  resolved_at: number;
}
interface Directive {
  row_id: number;
  id: string;
  fellow_id: string;
  sponsor_id: string;
  problem_id: string | null;
  verb: "focus" | "forbid" | "unfocus";
  body: string | null;
  created_at: number;
  request_digest: string;
}
interface RecordRow {
  event_id: string;
  seq: number;
  scope_id: string;
  coverage_digest: string;
  revision: number;
  sponsor_id: string;
  fellow_id: string;
  decision: SponsorDirectiveDisclosureRequest["decision"];
  request_digest: string;
  public_payload_sha256: string;
  public_payload_json: string;
  recorded_at: string;
  visible_payload: string | null;
  source_payload: string | null;
  source_digest: string | null;
}
interface Scope {
  scopeId: string;
  fellowId: string;
  sponsorId: string;
  coverageDigest: string;
  directives: Directive[];
  initialInstruction?: { readonly id: string; readonly text: string };
  latest?: RecordRow;
  receipt: SponsorDirectiveDisclosureReceipt | null;
}
export interface DisclosureSnapshot {
  readonly target: DirectiveDisclosureTarget;
  readonly lineageDigest: string;
  readonly lineageJson: string;
  readonly requirementsJson: string;
  readonly scopes: readonly Scope[];
  readonly state: SponsorDirectiveDisclosureState;
  /** Captured authoritative values; never returned by the HTTP layer. */
  readonly guard: { readonly sql: string; readonly bindings: readonly (string | number | null)[] };
}

const TRANSFER_FIELDS_SQL = `t.rowid || ':' || t.transfer_id || ':' || t.source_sponsor_id || ':' || t.target_sponsor_id || ':' || t.resolved_at`;
const DIRECTIVE_FIELDS_SQL = `d.rowid || ':' || d.id || ':' || d.sponsor_id || ':' || COALESCE(d.problem_id, '') || ':' || d.request_digest || ':' || d.created_at`;
function transferFingerprint(rows: readonly Transfer[]): string {
  return rows
    .map(
      (r) =>
        `${r.row_id}:${r.transfer_id}:${r.source_sponsor_id}:${r.target_sponsor_id}:${r.resolved_at}`,
    )
    .join("|");
}
function directiveFingerprint(rows: readonly Directive[]): string {
  return rows
    .map(
      (r) =>
        `${r.row_id}:${r.id}:${r.sponsor_id}:${r.problem_id ?? ""}:${r.request_digest}:${r.created_at}`,
    )
    .join("|");
}

const RECORD_READ_SQL = `SELECT r.*, source_content.payload_json AS source_payload,
  source.payload_sha256 AS source_digest, CASE WHEN e.id = r.event_id AND e.problem_id = r.problem_id
  AND e.type = 'directive.disclosure-recorded' AND e.object_kind = 'directive-disclosure'
  AND e.object_id = r.event_id AND e.object_version = r.revision AND e.seq = r.seq
  AND e.actor_sponsor_id = r.sponsor_id AND e.actor_fellow_id IS NULL
  AND e.payload_sha256 = r.public_payload_sha256 AND c.payload_sha256 = e.payload_sha256
  AND c.payload_json = r.public_payload_json AND c.redacted_at IS NULL
  AND NOT ${eventContentHiddenSql("e")}
  AND source.problem_id = r.problem_id AND source.object_kind = 'claim'
  AND source.object_id = r.claim_id AND source.object_version = r.claim_version
  AND source_content.payload_sha256 = source.payload_sha256
  AND source_content.redacted_at IS NULL AND NOT ${eventContentHiddenSql("source")}
  THEN c.payload_json ELSE NULL END AS visible_payload
  FROM directive_disclosure_records r JOIN events e ON e.id = r.event_id
  LEFT JOIN event_content c ON c.event_id = e.id
  LEFT JOIN events source ON source.id = r.source_event_id
  LEFT JOIN event_content source_content ON source_content.event_id = source.id`;

async function recordReceipt(row: RecordRow): Promise<SponsorDirectiveDisclosureReceipt | null> {
  if (
    row.visible_payload === null ||
    row.visible_payload !== row.public_payload_json ||
    (await sha256Hex(row.visible_payload)) !== row.public_payload_sha256 ||
    row.source_payload === null ||
    row.source_digest === null ||
    (await sha256Hex(row.source_payload)) !== row.source_digest
  )
    return null;
  let parsed: ReturnType<typeof DirectiveDisclosurePublicationSchema.safeParse>;
  try {
    parsed = DirectiveDisclosurePublicationSchema.safeParse(JSON.parse(row.visible_payload));
  } catch {
    return null;
  }
  if (
    !parsed.success ||
    parsed.data.sponsor_id !== row.sponsor_id ||
    parsed.data.fellow_id !== row.fellow_id ||
    parsed.data.scope_id !== row.scope_id ||
    parsed.data.coverage_digest !== row.coverage_digest ||
    parsed.data.revision !== row.revision ||
    parsed.data.decision !== row.decision ||
    parsed.data.recorded_at !== row.recorded_at
  )
    return null;
  const { kind: _kind, ...publication } = parsed.data;
  const receipt = SponsorDirectiveDisclosureReceiptSchema.safeParse({
    schema: DIRECTIVE_DISCLOSURES_SCHEMA_ID,
    event_id: row.event_id,
    seq: row.seq,
    ...publication,
  });
  return receipt.success ? receipt.data : null;
}

function checkedRows<T>(result: { success?: boolean; results?: unknown[] }, limit: number): T[] {
  if (result.success === false || !Array.isArray(result.results) || result.results.length > limit)
    throw new DirectiveDisclosureError("unavailable");
  return result.results as T[];
}

/** Exact immutable dependency pins plus the complete bounded transfer history
 * determine who may speak. The legacy transfer checkbox is intentionally not
 * selected: a receiving sponsor cannot attest for another person's steering. */
export async function readDirectiveDisclosureSnapshot(
  db: D1Database,
  target: DisclosureTarget,
  sponsorId: string,
): Promise<DisclosureSnapshot> {
  const { problemId, claimId, version } = target;
  if (
    !/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/.test(problemId) ||
    !/^C-[0-9]+$/.test(claimId) ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    throw new DirectiveDisclosureError("invalid");
  const head = await db
    .prepare(`SELECT p.public_seq, p.current_statement_version,
    c.statement_version AS claim_statement_version, c.source_seq AS claim_source_seq,
    (SELECT MAX(version) FROM claim_versions cv WHERE cv.problem_id = p.id AND cv.claim_id = c.id) AS latest_version
    FROM problems p JOIN claims c ON c.problem_id = p.id
    WHERE p.id = ? AND c.id = ? AND p.status <> 'private-draft'
      AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
      AND NOT ${hiddenByContentControlSql("p.id", "c.id")}`)
    .bind(problemId, claimId)
    .first<Head>();
  if (!head) throw new DirectiveDisclosureError("not-found");
  if (head.latest_version !== version) throw new DirectiveDisclosureError("conflict");
  const sources = checkedRows<DependencyClosureRow>(
    await prepareDependencyClosure(db, problemId, head.public_seq, `${claimId}@${version}`).all(),
    64,
  );
  const closure = await composeDependencyClosure(sources, problemId, `${claimId}@${version}`);
  if (!closure.root_available || !closure.complete || sources.length === 0)
    throw new DirectiveDisclosureError("unavailable");
  // The closure's nodes are premises only. Its verified root is the first
  // publication row; ordinary zero-dependency claims still have an author.
  const root = sources[0]!;
  const nodes = [{ row: root }, ...closure.nodes];
  const exact = DirectiveDisclosureTargetSchema.parse({
    problem_id: problemId,
    claim_id: claimId,
    version,
    content_digest: root.content_digest,
    publication_event_id: root.event_id,
    publication_seq: root.seq,
    statement_version: head.claim_statement_version,
  });
  const fellowIds = [...new Set(nodes.map((n) => n.row.fellow))].sort();
  if (fellowIds.length > 32 || fellowIds.some((id) => typeof id !== "string"))
    throw new DirectiveDisclosureError("unavailable");
  const fellowJson = JSON.stringify(fellowIds);
  const results = await db.batch([
    db
      .prepare(`SELECT f.fellow_id, f.sponsor_id, f.created_at, er.sponsor_id AS initial_sponsor_id,
      er.enrollment_id, g.granted_resources_json
      FROM enrollment_fellows f JOIN enrollment_grants g ON g.fellow_id = f.fellow_id
      JOIN enrollment_proposals ep ON ep.proposal_id = g.proposal_id
      JOIN enrollment_records er ON er.enrollment_id = ep.enrollment_id
      WHERE f.fellow_id IN (SELECT value FROM json_each(?)) ORDER BY f.fellow_id LIMIT 33`)
      .bind(fellowJson),
    db
      .prepare(`SELECT rowid AS row_id, transfer_id, fellow_id, source_sponsor_id, target_sponsor_id, resolved_at
      FROM sponsor_fellow_transfers WHERE status = 'accepted'
        AND fellow_id IN (SELECT value FROM json_each(?)) ORDER BY rowid LIMIT 129`)
      .bind(fellowJson),
    db
      .prepare(`SELECT rowid AS row_id, id, fellow_id, sponsor_id, problem_id, verb, body, created_at, request_digest
      FROM sponsor_directives WHERE fellow_id IN (SELECT value FROM json_each(?))
        AND (problem_id IS NULL OR problem_id = ?) ORDER BY rowid LIMIT 257`)
      .bind(fellowJson, problemId),
    db
      .prepare(`${RECORD_READ_SQL} WHERE r.problem_id = ? AND r.claim_id = ? AND r.claim_version = ?
      AND NOT EXISTS (SELECT 1 FROM directive_disclosure_records newer
        WHERE newer.scope_id = r.scope_id AND newer.revision > r.revision)
      ORDER BY r.scope_id LIMIT 65`)
      .bind(problemId, claimId, version),
    db
      .prepare(`SELECT sponsor_id, tombstoned_at,
      EXISTS (SELECT 1 FROM sponsor_suspension_events b WHERE b.sponsor_id = s.sponsor_id) AS suspended
      FROM sponsors s WHERE sponsor_id = ?`)
      .bind(sponsorId),
  ]);
  if (results.length !== 5) throw new DirectiveDisclosureError("unavailable");
  const fellows = checkedRows<Fellow>(results[0]!, 32);
  const transfers = checkedRows<Transfer>(results[1]!, 128);
  const directives = checkedRows<Directive>(results[2]!, 256);
  const records = checkedRows<RecordRow>(results[3]!, 64);
  const principal = checkedRows<{
    sponsor_id: string;
    tombstoned_at: number | null;
    suspended: number;
  }>(results[4]!, 1)[0];
  if (!principal || principal.tombstoned_at !== null)
    throw new DirectiveDisclosureError("forbidden");
  if (fellows.length !== fellowIds.length) throw new DirectiveDisclosureError("unavailable");
  for (const directive of directives) {
    const body = {
      fellow_id: directive.fellow_id,
      ...(directive.problem_id === null ? {} : { problem_id: directive.problem_id }),
      verb: directive.verb,
      ...(directive.body === null ? {} : { text: directive.body }),
    };
    // Delivery may infer the problem from the enrollment grant while the
    // original signed request intentionally omitted problem_id.
    const { problem_id: _problem, ...withoutProblem } = body;
    if (
      (await sha256Hex(JSON.stringify(body))) !== directive.request_digest &&
      (await sha256Hex(JSON.stringify(withoutProblem))) !== directive.request_digest
    )
      throw new DirectiveDisclosureError("unavailable");
  }
  const pins = nodes
    .map((node) => ({
      event_id: node.row.event_id,
      claim_id: node.row.claim_id,
      version: node.row.version,
      payload_digest: node.row.payload_sha256,
      payload_json: node.row.payload_json,
      fellow_id: node.row.fellow,
      sponsor_id: node.row.sponsor,
    }))
    .sort((a, b) => a.event_id.localeCompare(b.event_id));
  const scopes: Scope[] = [];
  const lineageFellows: Record<string, unknown>[] = [];
  const guards: Record<string, unknown>[] = [];
  for (const fellow of fellows) {
    const history = transfers.filter((row) => row.fellow_id === fellow.fellow_id);
    const steering = directives.filter((row) => row.fellow_id === fellow.fellow_id);
    const intervals = new Map<string, { start: string | null; end: string | null }[]>();
    let accountable = fellow.initial_sponsor_id;
    let start: string | null = null;
    let priorTime = fellow.created_at;
    for (const transfer of history) {
      if (
        transfer.source_sponsor_id !== accountable ||
        !Number.isSafeInteger(transfer.resolved_at) ||
        transfer.resolved_at < priorTime ||
        transfer.target_sponsor_id === accountable
      )
        throw new DirectiveDisclosureError("unavailable");
      const owned = intervals.get(accountable) ?? [];
      owned.push({ start, end: transfer.transfer_id });
      intervals.set(accountable, owned);
      accountable = transfer.target_sponsor_id;
      start = transfer.transfer_id;
      priorTime = transfer.resolved_at;
    }
    if (accountable !== fellow.sponsor_id) throw new DirectiveDisclosureError("unavailable");
    const current = intervals.get(accountable) ?? [];
    current.push({ start, end: null });
    intervals.set(accountable, current);
    if (
      steering.some((d) => !intervals.has(d.sponsor_id)) ||
      pins.some((pin) => pin.fellow_id === fellow.fellow_id && !intervals.has(pin.sponsor_id!))
    )
      throw new DirectiveDisclosureError("unavailable");
    let first: unknown;
    try {
      first = JSON.parse(fellow.granted_resources_json).firstDirective ?? null;
    } catch {
      throw new DirectiveDisclosureError("unavailable");
    }
    const firstDigest = await sha256Hex(canonicalJson(first));
    if (first !== null && !EnrollmentFirstDirectiveSchema.safeParse(first).success)
      throw new DirectiveDisclosureError("unavailable");
    const initialInstruction =
      typeof first === "string" && first.length > 0
        ? {
            id: `EI-${(await sha256Hex(`${fellow.enrollment_id}\0${fellow.fellow_id}\0${fellow.initial_sponsor_id}`)).slice(0, 32)}`,
            text: first,
          }
        : undefined;
    const metadata = steering.map(({ body: _body, ...row }) => row);
    lineageFellows.push({
      fellow_id: fellow.fellow_id,
      current_sponsor_id: fellow.sponsor_id,
      initial_sponsor_id: fellow.initial_sponsor_id,
      enrollment_id: fellow.enrollment_id,
      first_directive_digest: firstDigest,
      transfers: history,
      directives: metadata,
    });
    guards.push({
      fellow_id: fellow.fellow_id,
      sponsor_id: fellow.sponsor_id,
      enrollment_id: fellow.enrollment_id,
      initial_sponsor_id: fellow.initial_sponsor_id,
      granted_resources_json: fellow.granted_resources_json,
      transfers: transferFingerprint(history),
      directives: directiveFingerprint(steering),
    });
    for (const [owner, periods] of [...intervals.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const ownDirectives = steering.filter((d) => d.sponsor_id === owner);
      const scopeId = await sha256Hex(
        canonicalJson({ target: exact, fellow_id: fellow.fellow_id, sponsor_id: owner }),
      );
      const coverageDigest = await sha256Hex(
        canonicalJson({
          target: exact,
          pins: pins.map(({ payload_json: _body, ...pin }) => pin),
          fellow_id: fellow.fellow_id,
          sponsor_id: owner,
          intervals: periods,
          directives: metadata.filter((d) => d.sponsor_id === owner),
          initial_directive: owner === fellow.initial_sponsor_id ? firstDigest : null,
        }),
      );
      const latest = records.find((row) => row.scope_id === scopeId);
      const receipt = latest ? await recordReceipt(latest) : null;
      scopes.push({
        scopeId,
        fellowId: fellow.fellow_id,
        sponsorId: owner,
        coverageDigest,
        directives: ownDirectives,
        latest,
        receipt,
        ...(owner === fellow.initial_sponsor_id && initialInstruction
          ? { initialInstruction }
          : {}),
      });
    }
  }
  if (scopes.length > 64) throw new DirectiveDisclosureError("unavailable");
  if (!scopes.some((scope) => scope.sponsorId === sponsorId))
    throw new DirectiveDisclosureError("forbidden");
  const lineageJson = canonicalJson({
    target: exact,
    problem_statement_version: head.current_statement_version,
    pins,
    fellows: lineageFellows,
  });
  if (new TextEncoder().encode(lineageJson).length > 524_288)
    throw new DirectiveDisclosureError("unavailable");
  const lineageDigest = await sha256Hex(lineageJson);
  const requirementsJson = canonicalJson(
    scopes.map((scope) => ({ scope_id: scope.scopeId, coverage_digest: scope.coverageDigest })),
  );
  const views = scopes.map((scope) => {
    const canAttest = scope.sponsorId === sponsorId && principal.suspended === 0;
    const status =
      scope.receipt?.coverage_digest === scope.coverageDigest &&
      scope.receipt.decision !== "withdraw"
        ? ("complete" as const)
        : scope.latest
          ? ("unresolved" as const)
          : ("missing" as const);
    return {
      scope_id: scope.scopeId,
      fellow_id: scope.fellowId,
      sponsor_id: scope.sponsorId,
      can_attest: canAttest,
      status,
      revision: scope.latest?.revision ?? 0,
      directives: canAttest
        ? [
            ...(scope.initialInstruction
              ? [
                  {
                    directive_id: scope.initialInstruction.id,
                    source_kind: "enrollment-instruction" as const,
                    verb: "initial" as const,
                    text: scope.initialInstruction.text,
                    created_at: fellows.find((f) => f.fellow_id === scope.fellowId)!.created_at,
                  },
                ]
              : []),
            ...scope.directives.map((d) => ({
              directive_id: d.id,
              source_kind: "directive" as const,
              verb: d.verb,
              text: d.body,
              created_at: d.created_at,
            })),
          ]
        : [],
      receipt: scope.receipt,
    };
  });
  const state = SponsorDirectiveDisclosureStateSchema.parse({
    schema: DIRECTIVE_DISCLOSURES_SCHEMA_ID,
    target: exact,
    lineage_digest: lineageDigest,
    status: views.every((scope) => scope.status === "complete")
      ? "complete"
      : views.every((scope) => scope.status === "missing")
        ? "missing"
        : "unresolved",
    scopes: views,
  });
  if (
    new TextEncoder().encode(JSON.stringify(state)).length > DIRECTIVE_DISCLOSURE_MAX_RESPONSE_BYTES
  )
    throw new DirectiveDisclosureError("unavailable");
  const guard = {
    sql: `EXISTS (SELECT 1 FROM claims c JOIN problems p ON p.id = c.problem_id
      WHERE c.problem_id = ? AND c.id = ? AND c.source_seq = ? AND c.statement_version = ?
        AND p.current_statement_version = ? AND p.status <> 'private-draft'
        AND (SELECT MAX(version) FROM claim_versions cv WHERE cv.problem_id = c.problem_id AND cv.claim_id = c.id) = ?)
      AND NOT EXISTS (SELECT 1 FROM json_each(?) captured WHERE NOT EXISTS (
        SELECT 1 FROM enrollment_fellows f JOIN enrollment_grants g ON g.fellow_id = f.fellow_id
        JOIN enrollment_proposals ep ON ep.proposal_id = g.proposal_id
        JOIN enrollment_records er ON er.enrollment_id = ep.enrollment_id
        WHERE f.fellow_id = json_extract(captured.value, '$.fellow_id')
          AND f.sponsor_id = json_extract(captured.value, '$.sponsor_id')
          AND er.enrollment_id = json_extract(captured.value, '$.enrollment_id')
          AND er.sponsor_id = json_extract(captured.value, '$.initial_sponsor_id')
          AND g.granted_resources_json = json_extract(captured.value, '$.granted_resources_json')
          AND COALESCE((SELECT group_concat(mark, '|') FROM (
            SELECT ${TRANSFER_FIELDS_SQL} AS mark FROM sponsor_fellow_transfers t
            WHERE t.fellow_id = f.fellow_id AND t.status = 'accepted' ORDER BY t.rowid
          )), '') = json_extract(captured.value, '$.transfers')
          AND COALESCE((SELECT group_concat(mark, '|') FROM (
            SELECT ${DIRECTIVE_FIELDS_SQL} AS mark FROM sponsor_directives d
            WHERE d.fellow_id = f.fellow_id AND (d.problem_id IS NULL OR d.problem_id = ?) ORDER BY d.rowid
          )), '') = json_extract(captured.value, '$.directives')
      ))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) pin WHERE NOT EXISTS (
        SELECT 1 FROM events e JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
        WHERE e.id = json_extract(pin.value, '$.event_id') AND e.problem_id = ?
          AND e.payload_sha256 = json_extract(pin.value, '$.payload_digest') AND c.redacted_at IS NULL
          AND c.payload_json = json_extract(pin.value, '$.payload_json')
          AND NOT ${eventContentHiddenSql("e")}
      ))`,
    bindings: [
      problemId,
      claimId,
      head.claim_source_seq,
      head.claim_statement_version,
      head.current_statement_version,
      version,
      JSON.stringify(guards),
      problemId,
      JSON.stringify(pins),
      problemId,
    ],
  };
  // Sequential reads above may race a directive, transfer or revision. Refuse a
  // mixed snapshot before it reaches a human; this same predicate guards writes.
  const stable = await db
    .prepare(`SELECT 1 AS stable WHERE ${guard.sql}`)
    .bind(...guard.bindings)
    .first();
  if (!stable) throw new DirectiveDisclosureError("conflict");
  return { target: exact, lineageDigest, lineageJson, requirementsJson, scopes, state, guard };
}

export async function readDirectiveDisclosureState(
  db: D1Database,
  target: DisclosureTarget,
  sponsorId: string,
) {
  return (await readDirectiveDisclosureSnapshot(db, target, sponsorId)).state;
}

export interface DirectiveDisclosureWriteOptions {
  readonly screen?: (
    publication: DirectiveDisclosurePublication,
  ) => Promise<ScreenedPublication | Response>;
  readonly sponsorLimit?: number | null;
  readonly hooks?: KraterWriteHooks;
}

/** The shared public event writer owns cursor/chain/idempotency. The private
 * scope projection and accepted declaration bytes commit inside its batch. */
export async function recordDirectiveDisclosure(
  db: D1Database,
  target: DisclosureTarget,
  sponsorId: string,
  command: SponsorDirectiveDisclosureRequest,
  key: string,
  options: DirectiveDisclosureWriteOptions = {},
): Promise<SponsorDirectiveDisclosureReceipt | Response> {
  const parsed = SponsorDirectiveDisclosureRequestSchema.safeParse(command);
  if (!parsed.success) throw new DirectiveDisclosureError("invalid");
  command = parsed.data;
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(key)) throw new DirectiveDisclosureError("invalid");
  const keyDigest = await sha256Hex(`${sponsorId}\0${key}`);
  const requestDigest = await sha256Hex(canonicalJson({ target, command }));
  const replay = async () => {
    const prior = await db
      .prepare(`${RECORD_READ_SQL}
      WHERE r.sponsor_id = ? AND r.idempotency_key_digest = ?`)
      .bind(sponsorId, keyDigest)
      .first<RecordRow>();
    if (!prior) return undefined;
    if (prior.request_digest !== requestDigest) throw new DirectiveDisclosureError("conflict");
    const receipt = await recordReceipt(prior);
    if (!receipt) throw new DirectiveDisclosureError("unavailable");
    return receipt;
  };
  const existing = await replay();
  if (existing) return existing;
  const snapshot = await readDirectiveDisclosureSnapshot(db, target, sponsorId);
  if (snapshot.lineageDigest !== command.expected_lineage_digest)
    throw new DirectiveDisclosureError("conflict");
  const scope = snapshot.scopes.find((item) => item.scopeId === command.scope_id);
  const view = snapshot.state.scopes.find((item) => item.scope_id === command.scope_id);
  if (!scope || scope.sponsorId !== sponsorId || !view?.can_attest)
    throw new DirectiveDisclosureError("forbidden");
  if (view.revision !== command.expected_revision || view.revision >= Number.MAX_SAFE_INTEGER)
    throw new DirectiveDisclosureError("conflict");
  if (
    command.disclosures.some((item) =>
      item.source_kind === "enrollment-instruction"
        ? item.directive_id !== scope.initialInstruction?.id
        : !scope.directives.some((d) => d.id === item.directive_id),
    )
  )
    throw new DirectiveDisclosureError("forbidden");
  const publication = DirectiveDisclosurePublicationSchema.parse({
    kind: "directive-disclosure",
    target: snapshot.target,
    scope_id: scope.scopeId,
    coverage_digest: scope.coverageDigest,
    revision: view.revision + 1,
    decision: command.decision,
    sponsor_id: sponsorId,
    fellow_id: scope.fellowId,
    disclosures: command.disclosures,
    recorded_at: new Date().toISOString(),
  });
  const payload = canonicalJson(publication);
  if (new TextEncoder().encode(payload).length > DIRECTIVE_DISCLOSURE_MAX_REQUEST_BYTES)
    throw new DirectiveDisclosureError("invalid");
  const eventId = `DD-${keyDigest.slice(0, 32)}`;
  const quota = await checkAndReserveQuota(db, {
    fellowId: `sponsor:${sponsorId}`,
    sponsorId,
    problemId: target.problemId,
    sessionId: `sponsor-disclosure:${scope.scopeId}`,
    route: "directive-disclosure",
    idempotencyKey: keyDigest,
    requestDigest,
    sponsorLimit: options.sponsorLimit,
  });
  if (!quota.allowed) {
    const winner = await replay();
    if (winner) return winner;
    if (quota.reason === "RATE_LIMITED") return promotionRateLimitedProblem(quota);
    throw new DirectiveDisclosureError("conflict");
  }
  const reservationId = quota.reservation.reservationId;
  let screened: ScreenedPublication | undefined;
  try {
    // Structured declarations carry no caller-authored public prose. Chosen
    // summaries do, and never publish without the common screening boundary.
    if (command.decision === "disclose") {
      if (!options.screen) throw new DirectiveDisclosureError("unavailable");
      const result = await options.screen(publication);
      if (result instanceof Response) {
        await settleQuotaReservation(
          db,
          reservationId,
          result.status === 202
            ? "settled_held"
            : result.status === 403
              ? "settled_rejected"
              : "settled_failed",
        );
        return result;
      }
      if (result.problemId !== target.problemId || result.fellowId !== scope.fellowId)
        throw new DirectiveDisclosureError("unavailable");
      const provenance = ScreeningPublicationProvenanceSchema.safeParse(result.provenance);
      const candidateDigest = await sha256Hex(
        JSON.stringify({
          kind: "directive-disclosure",
          statement: JSON.stringify(publication.disclosures),
          falsifier: null,
        }),
      );
      if (
        !provenance.success ||
        (provenance.data.version === "ledger-publication-screening.v2"
          ? provenance.data.candidate_digest !== candidateDigest || !result.contextGuard
          : provenance.data.input_digest !== candidateDigest)
      )
        throw new DirectiveDisclosureError("unavailable");
      screened = result;
    }
    await writeLedgerEvent(
      db,
      {
        problemId: target.problemId,
        eventId,
        idempotencyKey: `disclosure:${keyDigest}`,
        requestDigest,
        eventType: "directive.disclosure-recorded",
        objectKind: "directive-disclosure",
        objectId: eventId,
        objectVersion: publication.revision,
        payloadJson: payload,
        createdAt: publication.recorded_at,
        attribution: {
          principalType: "sponsor",
          sponsorId,
          fellowId: null,
          sessionId: null,
          modelSelfDeclared: null,
          harness: null,
        },
      },
      {
        preconditionSql: ` AND (${snapshot.guard.sql})
        AND EXISTS (SELECT 1 FROM sponsors ds WHERE ds.sponsor_id = ? AND ds.tombstoned_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events ban WHERE ban.sponsor_id = ds.sponsor_id))
        AND COALESCE((SELECT MAX(revision) FROM directive_disclosure_records WHERE scope_id = ?), 0) = ?
        AND EXISTS (SELECT 1 FROM public_cursor WHERE singleton = 1 AND cursor < 9007199254740991)`,
        preconditionBindings: [
          ...snapshot.guard.bindings,
          sponsorId,
          scope.scopeId,
          command.expected_revision,
        ],
        statementsAfterEvent: ({ sequence, payloadSha256 }) => {
          const statements: D1PreparedStatement[] = [
            db
              .prepare(`INSERT INTO directive_disclosure_records
            (event_id,problem_id,claim_id,claim_version,content_digest,source_event_id,sponsor_id,fellow_id,
             scope_id,coverage_digest,lineage_digest,revision,decision,seq,idempotency_key_digest,
             request_digest,public_payload_sha256,public_payload_json,recorded_at)
            SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM events WHERE id = ?)`)
              .bind(
                eventId,
                target.problemId,
                target.claimId,
                target.version,
                snapshot.target.content_digest,
                snapshot.target.publication_event_id,
                sponsorId,
                scope.fellowId,
                scope.scopeId,
                scope.coverageDigest,
                snapshot.lineageDigest,
                publication.revision,
                command.decision,
                sequence,
                keyDigest,
                requestDigest,
                payloadSha256,
                payload,
                publication.recorded_at,
                eventId,
              ),
            db
              .prepare(`INSERT INTO directive_disclosure_targets
            (problem_id,claim_id,claim_version,content_digest,source_event_id,lineage_digest,lineage_json,
             scope_requirements_json,invalidated,last_event_id,last_event_seq)
            SELECT ?,?,?,?,?,?,?,?,0,?,? WHERE EXISTS (SELECT 1 FROM events WHERE id = ?)
            ON CONFLICT(problem_id,claim_id,claim_version) DO UPDATE SET
              lineage_digest = excluded.lineage_digest, lineage_json = excluded.lineage_json,
              scope_requirements_json = excluded.scope_requirements_json, invalidated = 0,
              last_event_id = excluded.last_event_id, last_event_seq = excluded.last_event_seq`)
              .bind(
                target.problemId,
                target.claimId,
                target.version,
                snapshot.target.content_digest,
                snapshot.target.publication_event_id,
                snapshot.lineageDigest,
                snapshot.lineageJson,
                snapshot.requirementsJson,
                eventId,
                sequence,
                eventId,
              ),
            db
              .prepare(`UPDATE public_cursor SET cursor = cursor + 1
            WHERE singleton = 1 AND EXISTS (SELECT 1 FROM events WHERE id = ?)`)
              .bind(eventId),
            settleQuotaReservationStatement(db, reservationId, eventId),
          ];
          if (screened) {
            if (screened.contextGuard)
              statements.push(screeningContextGuardStatement(db, screened.contextGuard, eventId));
            statements.push(
              db
                .prepare(`INSERT INTO screening_publications(event_id, request_digest, provenance_json)
            SELECT id, ?, ? FROM events WHERE id = ? AND problem_id = ? AND actor_sponsor_id = ?`)
                .bind(
                  requestDigest,
                  JSON.stringify(screened.provenance),
                  eventId,
                  target.problemId,
                  sponsorId,
                ),
            );
            if (screened.supersedeInputDigest)
              statements.push(supersedeHeldCaseStatement(db, screened, eventId));
          }
          return statements;
        },
      },
      options.hooks,
    );
    const receipt = await replay();
    if (!receipt) throw new DirectiveDisclosureError("unavailable");
    return receipt;
  } catch (error) {
    const winner = await replay();
    if (winner) return winner;
    await settleQuotaReservation(db, reservationId, "settled_failed");
    if (isScreeningContextStaleError(error)) return screeningContextStaleProblem();
    if (
      error instanceof KraterIdempotencyConflictError ||
      error instanceof KraterLedgerPreconditionError ||
      (error instanceof Error && error.message.includes("DIRECTIVE_DISCLOSURE_REVISION_CONFLICT"))
    )
      throw new DirectiveDisclosureError("conflict");
    throw error;
  }
}

/** Safe public document for one immutable declaration. It never consults or
 * returns a private directive body, including after a sponsorship transfer. */
export async function readPublicDirectiveDisclosure(
  db: D1Database,
  problemId: string,
  eventId: string,
): Promise<{ receipt: SponsorDirectiveDisclosureReceipt; unlisted: boolean } | null> {
  if (!/^DD-[a-f0-9]{32}$/.test(eventId)) return null;
  const rows = await db.batch([
    db
      .prepare(`${RECORD_READ_SQL} WHERE r.problem_id = ? AND r.event_id = ?`)
      .bind(problemId, eventId),
    db
      .prepare(`SELECT unlisted FROM problems WHERE id = ? AND status <> 'private-draft'
      AND NOT ${hiddenByContentControlSql("problems.id", "'problem'")}`)
      .bind(problemId),
  ]);
  if (rows.length !== 2) throw new DirectiveDisclosureError("unavailable");
  const record = checkedRows<RecordRow>(rows[0]!, 1)[0];
  const head = checkedRows<{ unlisted: number }>(rows[1]!, 1)[0];
  if (!record || !head) return null;
  const receipt = await recordReceipt(record);
  return receipt ? { receipt, unlisted: head.unlisted === 1 } : null;
}
