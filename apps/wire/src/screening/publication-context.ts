import type { ScreeningPublicationContextInput } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";
import { hiddenByContentControlSql } from "../krater/public-content";

/** Whole bodies only. A budget failure never becomes a candidate-only screen. */
export const MAX_PUBLICATION_SCREENING_BODY_BYTES = 1048576;
export const MAX_PUBLICATION_HISTORY_BODY_BYTES = 512 * 1024;
export const MAX_PUBLICATION_HISTORY = 6;
export const MAX_PUBLICATION_PENDING_CANDIDATES = 15;

export interface PublicationCandidateText {
  readonly kind: string;
  readonly statement: string;
  readonly falsifier: string | null;
}
export interface PublicationSourceIdentity {
  readonly eventId: string;
  readonly seq: number;
  readonly payloadDigest: string;
}
interface PublicationSource extends PublicationSourceIdentity {
  readonly payloadJson: string;
}
interface PublicationProblemStatement {
  readonly version: number;
  readonly title: string;
  readonly statement: string;
  readonly falsifier: string;
  readonly motivation: string;
  readonly source: PublicationSource | null;
}
/** Created only by the public database reader; never accepted from a request. */
export interface PublicationContextSnapshot {
  readonly problemId: string;
  readonly fellowId: string;
  readonly mode: "public-problem" | "initial-publication";
  readonly statement: PublicationProblemStatement | null;
  readonly sameFellowHead: PublicationSourceIdentity | null;
  readonly recentPublications: readonly PublicationSource[];
  readonly visiblePublicationCount: number;
}
export interface PublicationBatchContext {
  readonly snapshot: PublicationContextSnapshot;
  readonly precedingCandidates: readonly {
    readonly eventId: string;
    readonly input: PublicationCandidateText;
  }[];
}
export interface PublicationContextGuard {
  readonly snapshot: PublicationContextSnapshot;
  readonly precedingCandidates: readonly {
    readonly eventId: string;
    readonly candidateDigest: string;
  }[];
}

const issuedSnapshots = new WeakSet<PublicationContextSnapshot>();
const HEX64 = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const staleMarker = "SCREENING_CONTEXT_STALE";

export class PublicationContextUnavailableError extends Error {
  constructor(readonly reason: "unavailable" | "limit" = "unavailable") {
    super("A complete current publication screening context is unavailable.");
    this.name = "PublicationContextUnavailableError";
  }
}
export function isScreeningContextStaleError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes(staleMarker) ||
      (error.cause instanceof Error && isScreeningContextStaleError(error.cause)))
  );
}
export function screeningContextStaleProblem(): Response {
  return validatedProblem({
    code: "SCREENING_CONTEXT_STALE",
    status: 409,
    title: "Publication context changed during screening",
    detail:
      "Nothing was published because the public context changed while this candidate was evaluated.",
    fixHint:
      "Refresh the problem or workshop, or fetch a fresh working pack, then retry the exact candidate with the same request identity so its current context can be evaluated.",
    rule: "A5",
    extensions: {
      schema: "https://a.asimposium.org/schemas/problem.v1.json",
      example: { method: "GET", path: "/p/P-4DSP.json" },
    },
    headers: { "cache-control": "private, no-store" },
  });
}
export function screeningContextUnavailableProblem(error?: unknown): Response {
  const limited = error instanceof PublicationContextUnavailableError && error.reason === "limit";
  return validatedProblem({
    code: "SCREENING_CONTEXT_UNAVAILABLE",
    status: 503,
    title: "Complete publication context is unavailable",
    detail: limited
      ? "The complete candidate and required public context exceed the screening input budget. No prefix was screened and nothing was published."
      : "A complete, verified and currently visible publication context could not be read. Nothing was published.",
    fixHint: limited
      ? "Keep the work in the private workshop. Reduce a compound candidate or batch where possible, or ask an operator to review the context limit before retrying."
      : "Keep the same request identity and retry after the public context is available; fetch a fresh working pack if it has changed.",
    rule: "A5",
    extensions: {
      schema: "https://a.asimposium.org/schemas/problem.v1.json",
      example: { method: "GET", path: "/p/P-4DSP.json" },
      ...(limited ? { maximum_context_bytes: MAX_PUBLICATION_SCREENING_BODY_BYTES } : {}),
    },
    headers: { "cache-control": "private, no-store", "retry-after": "5" },
  });
}

export async function publicationSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function exactInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function frozenSource(row: SourceRow): PublicationSource {
  if (
    !exactInteger(row.seq) ||
    row.seq < 1 ||
    !HEX64.test(row.payload_sha256) ||
    typeof row.payload_json !== "string"
  )
    throw new PublicationContextUnavailableError();
  return Object.freeze({
    eventId: row.id,
    seq: row.seq,
    payloadDigest: row.payload_sha256,
    payloadJson: row.payload_json,
  });
}

/** Item faces require the scientific target's content, even when the child
 * publication itself has not been hidden. Claim targets keep their exact
 * recorded version; a later revision does not move a historical review.
 * These are existence checks, so no target or retained projection text is
 * copied into the screening context. */
function scientificTargetAvailableSql(): string {
  const claim = (id: string, version: string) => `EXISTS (
    SELECT 1 FROM claim_versions target_version JOIN events target_event
      ON target_event.problem_id = target_version.problem_id
      AND target_event.object_id = target_version.claim_id
      AND target_event.object_version = target_version.version
      AND target_event.object_kind = 'claim'
      AND target_event.type IN ('claim.created', 'claim.revised')
    JOIN event_content target_content ON target_content.event_id = target_event.id
      AND target_content.payload_sha256 = target_event.payload_sha256
    WHERE target_version.problem_id = e.problem_id AND target_version.claim_id = ${id}
      AND target_version.version = ${version} AND target_event.seq < e.seq
      AND target_event.seq <= p.public_seq
      AND target_content.redacted_at IS NULL AND target_content.payload_json IS NOT NULL
      AND NOT ${hiddenByContentControlSql("target_version.problem_id", "target_version.claim_id")}
  )`;
  return `(e.type NOT IN ('evidence.created', 'review.created')
    OR (e.type = 'evidence.created' AND e.object_kind = 'evidence' AND EXISTS (
      SELECT 1 FROM evidence target_record
      WHERE target_record.problem_id = e.problem_id AND target_record.evidence_id = e.object_id
        AND target_record.source_event_id = e.id AND target_record.source_seq = e.seq
        AND target_record.author_fellow_id = e.actor_fellow_id
        AND target_record.bears_on_id = json_extract(c.payload_json, '$.bears_on_id')
        AND target_record.bears_on_kind = json_extract(c.payload_json, '$.bears_on_kind')
        AND target_record.bears_on_version IS json_extract(c.payload_json, '$.bears_on_version')
        AND ((target_record.bears_on_kind = 'claim'
          AND ${claim("target_record.bears_on_id", "target_record.bears_on_version")})
          OR (target_record.bears_on_kind = 'hypothesis' AND target_record.bears_on_version IS NULL
            AND EXISTS (
              SELECT 1 FROM hypotheses target_hypothesis JOIN events target_event
                ON target_event.id = target_hypothesis.source_event_id
                AND target_event.problem_id = target_hypothesis.problem_id
                AND target_event.seq = target_hypothesis.source_seq
                AND target_event.object_id = target_hypothesis.hypothesis_id
                AND target_event.object_version = 1
                AND target_event.object_kind = 'hypothesis' AND target_event.type = 'hypothesis.created'
                AND target_event.actor_fellow_id = target_hypothesis.author_fellow_id
              JOIN event_content target_content ON target_content.event_id = target_event.id
                AND target_content.payload_sha256 = target_event.payload_sha256
              WHERE target_hypothesis.problem_id = e.problem_id
                AND target_hypothesis.hypothesis_id = target_record.bears_on_id
                AND target_event.seq < e.seq AND target_event.seq <= p.public_seq
                AND target_content.redacted_at IS NULL
                AND length(CAST(target_content.payload_json AS BLOB)) BETWEEN 1 AND ${MAX_PUBLICATION_HISTORY_BODY_BYTES}
                AND NOT ${hiddenByContentControlSql("target_hypothesis.problem_id", "target_hypothesis.hypothesis_id")}
            )))
    ))
    OR (e.type = 'review.created' AND e.object_kind = 'review' AND EXISTS (
      SELECT 1 FROM reviews target_record
      WHERE target_record.problem_id = e.problem_id AND target_record.review_id = e.object_id
        AND target_record.source_event_id = e.id AND target_record.source_seq = e.seq
        AND target_record.reviewer_fellow_id = e.actor_fellow_id
        AND target_record.target_claim_id = json_extract(c.payload_json, '$.target_claim_id')
        AND target_record.target_version = json_extract(c.payload_json, '$.target_version')
        AND ${claim("target_record.target_claim_id", "target_record.target_version")}
    )))`;
}

/** Public visibility is evaluated in the same query that reads the bytes. */
function visibleHistoryWhere(seqCeiling: string): string {
  return `p.status <> 'private-draft' AND e.seq <= p.public_seq AND e.seq <= ${seqCeiling}
    AND c.redacted_at IS NULL AND c.payload_json IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM scientific_withdrawals w WHERE w.source_event_id = e.id)
    AND NOT ${hiddenByContentControlSql("e.problem_id", "'problem'")}
    AND NOT ${hiddenByContentControlSql("e.problem_id", "e.object_id")}
    AND ${scientificTargetAvailableSql()}`;
}
const historyFrom = `FROM events e
  JOIN problems p ON p.id = e.problem_id
  JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256`;
interface SourceRow {
  id: string;
  seq: number;
  payload_sha256: string;
  payload_json: string | null;
}
interface ProblemRow {
  id: string;
  status: string;
  public_seq: number;
  title: string | null;
  version: number | null;
  statement: string | null;
  falsifier: string | null;
  motivation: string | null;
  source_id: string | null;
  source_seq: number | null;
  source_digest: string | null;
  source_json: string | null;
}

/**
 * D1 executes this read batch in one transaction. The cut is this author's
 * public head and the immutable current problem statement, not unrelated
 * authors' global cursor. Hidden/redacted/withdrawn bytes and private drafts
 * never leave the database. A missing statement is not an empty context.
 */
export async function readPublicationContext(
  db: D1Database,
  input: { readonly problemId: string; readonly fellowId: string; readonly kind: string },
): Promise<PublicationContextSnapshot> {
  const { problemId, fellowId } = input;
  const results = await db.batch([
    db
      .prepare(`SELECT p.id, p.status, p.public_seq,
      CASE WHEN p.status <> 'private-draft' THEN p.title END AS title,
      CASE WHEN p.status <> 'private-draft' THEN v.version END AS version,
      CASE WHEN p.status <> 'private-draft' THEN v.statement END AS statement,
      CASE WHEN p.status <> 'private-draft' THEN v.falsifier END AS falsifier,
      CASE WHEN p.status <> 'private-draft' THEN v.motivation END AS motivation,
      e.id AS source_id, e.seq AS source_seq, e.payload_sha256 AS source_digest,
      CASE WHEN c.redacted_at IS NULL AND c.payload_sha256 = e.payload_sha256
        AND length(CAST(c.payload_json AS BLOB)) <= ? THEN c.payload_json END AS source_json
      FROM problems p
      LEFT JOIN problem_statement_versions v ON v.problem_id = p.id
        AND v.version = p.current_statement_version AND p.status <> 'private-draft'
      LEFT JOIN events e ON e.id = (SELECT source.id FROM events source
        WHERE source.problem_id = p.id AND source.object_kind = 'problem'
          AND source.type IN ('problem.admitted','problem.statement-revised')
          AND source.object_version = p.current_statement_version
          AND source.seq <= p.public_seq AND p.status <> 'private-draft'
        ORDER BY source.seq DESC LIMIT 1)
      LEFT JOIN event_content c ON c.event_id = e.id
      WHERE p.id = ? AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}`)
      .bind(MAX_PUBLICATION_HISTORY_BODY_BYTES, problemId),
    db
      .prepare(`SELECT e.id, e.seq, e.payload_sha256 FROM events e
      JOIN problems p ON p.id = e.problem_id
      WHERE e.problem_id = ? AND e.actor_fellow_id = ?
        AND p.status <> 'private-draft' AND e.seq <= p.public_seq ORDER BY e.seq DESC LIMIT 1`)
      .bind(problemId, fellowId),
    db
      .prepare(`SELECT e.id, e.seq, e.payload_sha256,
      CASE WHEN length(CAST(c.payload_json AS BLOB)) <= ? THEN c.payload_json END AS payload_json
      ${historyFrom} WHERE e.problem_id = ? AND e.actor_fellow_id = ?
      AND ${visibleHistoryWhere("p.public_seq")} ORDER BY e.seq DESC LIMIT ?`)
      .bind(MAX_PUBLICATION_HISTORY_BODY_BYTES, problemId, fellowId, MAX_PUBLICATION_HISTORY),
    db
      .prepare(`SELECT COUNT(*) AS count ${historyFrom}
      WHERE e.problem_id = ? AND e.actor_fellow_id = ? AND ${visibleHistoryWhere("p.public_seq")}`)
      .bind(problemId, fellowId),
  ]);
  if (results.some((result) => !result.success)) throw new PublicationContextUnavailableError();
  const problem = results[0]?.results[0] as ProblemRow | undefined;
  const head = results[1]?.results[0] as Omit<SourceRow, "payload_json"> | undefined;
  const historyRows = (results[2]?.results ?? []) as unknown as SourceRow[];
  const visibleCount = (results[3]?.results[0] as { count?: unknown } | undefined)?.count;
  if (!problem || !exactInteger(problem.public_seq) || !exactInteger(visibleCount))
    throw new PublicationContextUnavailableError();
  if (problem.status === "private-draft") {
    if (input.kind !== "problem-proposal" || problem.public_seq !== 0 || head || historyRows.length)
      throw new PublicationContextUnavailableError();
    const snapshot = Object.freeze({
      problemId,
      fellowId,
      mode: "initial-publication" as const,
      statement: null,
      sameFellowHead: null,
      recentPublications: Object.freeze([]),
      visiblePublicationCount: 0,
    });
    issuedSnapshots.add(snapshot);
    return snapshot;
  }
  if (
    !exactInteger(problem.version) ||
    problem.version < 1 ||
    typeof problem.title !== "string" ||
    typeof problem.statement !== "string" ||
    problem.statement.length === 0 ||
    typeof problem.falsifier !== "string" ||
    typeof problem.motivation !== "string" ||
    visibleCount < historyRows.length
  )
    throw new PublicationContextUnavailableError();
  const history = historyRows.map(frozenSource);
  for (const source of history) {
    if ((await publicationSha256(source.payloadJson)) !== source.payloadDigest)
      throw new PublicationContextUnavailableError();
    try {
      JSON.parse(source.payloadJson);
    } catch {
      throw new PublicationContextUnavailableError();
    }
  }
  let statementSource: PublicationSource | null = null;
  if (problem.source_id !== null) {
    statementSource = frozenSource({
      id: problem.source_id,
      seq: problem.source_seq ?? 0,
      payload_sha256: problem.source_digest ?? "",
      payload_json: problem.source_json,
    });
    if ((await publicationSha256(statementSource.payloadJson)) !== statementSource.payloadDigest)
      throw new PublicationContextUnavailableError();
    let source: unknown;
    try {
      source = JSON.parse(statementSource.payloadJson);
    } catch {
      throw new PublicationContextUnavailableError();
    }
    const formulation = (source as { problem?: Record<string, unknown> } | null)?.problem;
    if (
      !formulation ||
      formulation.current_statement_version !== problem.version ||
      formulation.statement !== problem.statement ||
      formulation.falsifier !== problem.falsifier ||
      formulation.motivation !== problem.motivation
    )
      throw new PublicationContextUnavailableError();
  }
  let sameFellowHead: PublicationSourceIdentity | null = null;
  if (head) {
    if (!exactInteger(head.seq) || head.seq < 1 || !HEX64.test(head.payload_sha256))
      throw new PublicationContextUnavailableError();
    sameFellowHead = Object.freeze({
      eventId: head.id,
      seq: head.seq,
      payloadDigest: head.payload_sha256,
    });
  }
  const snapshot = Object.freeze({
    problemId,
    fellowId,
    mode: "public-problem" as const,
    statement: Object.freeze({
      version: problem.version,
      title: problem.title,
      statement: problem.statement,
      falsifier: problem.falsifier,
      motivation: problem.motivation,
      source: statementSource,
    }),
    sameFellowHead,
    recentPublications: Object.freeze(history),
    visiblePublicationCount: visibleCount,
  });
  issuedSnapshots.add(snapshot);
  return snapshot;
}

export function assertPublicationBatchContext(
  context: PublicationBatchContext,
  actor: { readonly problemId: string; readonly fellowId: string },
): void {
  if (
    !issuedSnapshots.has(context.snapshot) ||
    context.snapshot.problemId !== actor.problemId ||
    context.snapshot.fellowId !== actor.fellowId ||
    context.precedingCandidates.length > MAX_PUBLICATION_PENDING_CANDIDATES ||
    new Set(context.precedingCandidates.map((candidate) => candidate.eventId)).size !==
      context.precedingCandidates.length ||
    context.precedingCandidates.some(
      (candidate) =>
        typeof candidate.eventId !== "string" ||
        candidate.eventId.length < 1 ||
        candidate.eventId.length > 128 ||
        typeof candidate.input.kind !== "string" ||
        typeof candidate.input.statement !== "string" ||
        (candidate.input.falsifier !== null && typeof candidate.input.falsifier !== "string"),
    )
  )
    throw new PublicationContextUnavailableError();
}

/** The current candidate and pending prefix are distinct from public provenance. */
export function publicationContextDocument(context: PublicationBatchContext) {
  const snapshot = context.snapshot;
  const source = (item: PublicationSourceIdentity) => ({
    event_id: item.eventId,
    seq: item.seq,
    payload_digest: item.payloadDigest,
  });
  return {
    version: "publication-context.v1" as const,
    problem_id: snapshot.problemId,
    fellow_id: snapshot.fellowId,
    mode: snapshot.mode,
    problem_statement:
      snapshot.statement === null
        ? null
        : {
            version: snapshot.statement.version,
            title: snapshot.statement.title,
            statement: snapshot.statement.statement,
            falsifier: snapshot.statement.falsifier,
            motivation: snapshot.statement.motivation,
            source_event:
              snapshot.statement.source === null ? null : source(snapshot.statement.source),
          },
    same_fellow_public_head:
      snapshot.sameFellowHead === null ? null : source(snapshot.sameFellowHead),
    recent_same_fellow_publications: [...snapshot.recentPublications].reverse().map((item) => ({
      ...source(item),
      payload_json: item.payloadJson,
    })),
    omitted_older_publication_count:
      snapshot.visiblePublicationCount - snapshot.recentPublications.length,
    pending_batch_candidates: context.precedingCandidates.map((item, index) => ({
      ordinal: index + 1,
      kind: item.input.kind,
      statement: item.input.statement,
      falsifier: item.input.falsifier,
    })),
    limits: {
      recent_publications: MAX_PUBLICATION_HISTORY as 6,
      total_input_bytes: MAX_PUBLICATION_SCREENING_BODY_BYTES as 1048576,
    },
  };
}

interface GuardSql {
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
}
/** A transaction-level fence. SQL contains no submitted text; bytes are bindings. */
export function publicationContextGuardSql(
  guard: PublicationContextGuard,
  eventId: string,
): GuardSql {
  const snapshot = guard.snapshot;
  if (!issuedSnapshots.has(snapshot)) throw new PublicationContextUnavailableError();
  const conditions: string[] = [];
  const bindings: (string | number | null)[] = [];
  const add = (sql: string, ...values: (string | number | null)[]) => {
    conditions.push(sql);
    bindings.push(...values);
  };
  if (snapshot.mode === "initial-publication") {
    add(
      `EXISTS (SELECT 1 FROM events current WHERE current.id = ?
      AND current.problem_id = ? AND current.type = 'problem.admitted' AND current.seq = 1)`,
      eventId,
      snapshot.problemId,
    );
  } else {
    const statement = snapshot.statement;
    if (!statement) throw new PublicationContextUnavailableError();
    add(
      `EXISTS (SELECT 1 FROM problems p JOIN problem_statement_versions v ON v.problem_id = p.id
      JOIN events current ON current.id = ? AND current.problem_id = p.id
      WHERE p.id = ? AND p.status <> 'private-draft' AND p.title = ?
        AND v.version = ? AND v.statement = ? AND v.falsifier = ? AND v.motivation = ?
        AND (p.current_statement_version = v.version OR
          (current.type = 'problem.statement-revised' AND p.current_statement_version = v.version + 1
            AND EXISTS (SELECT 1 FROM event_content current_content WHERE current_content.event_id = current.id
              AND json_extract(current_content.payload_json, '$.previous_statement_version') = v.version)))
        AND NOT ${hiddenByContentControlSql("p.id", "'problem'")})`,
      eventId,
      snapshot.problemId,
      statement.title,
      statement.version,
      statement.statement,
      statement.falsifier,
      statement.motivation,
    );
    const sourceRows = [
      ...snapshot.recentPublications,
      ...(statement.source === null ? [] : [statement.source]),
    ];
    add(
      `NOT EXISTS (SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS (
      SELECT 1 FROM events e JOIN event_content c ON c.event_id = e.id
        AND c.payload_sha256 = e.payload_sha256
      WHERE e.id = json_extract(expected.value, '$.eventId') AND e.problem_id = ?
        AND e.seq = json_extract(expected.value, '$.seq')
        AND e.payload_sha256 = json_extract(expected.value, '$.payloadDigest')
        AND c.payload_json = json_extract(expected.value, '$.payloadJson') AND c.redacted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM scientific_withdrawals w WHERE w.source_event_id = e.id)
        AND NOT ${hiddenByContentControlSql("e.problem_id", "e.object_id")}))`,
      JSON.stringify(sourceRows),
      snapshot.problemId,
    );
  }
  const headSeq = snapshot.sameFellowHead?.seq ?? 0;
  if (snapshot.sameFellowHead)
    add(
      `EXISTS (SELECT 1 FROM events e WHERE e.id = ?
    AND e.problem_id = ? AND e.actor_fellow_id = ? AND e.seq = ? AND e.payload_sha256 = ?)`,
      snapshot.sameFellowHead.eventId,
      snapshot.problemId,
      snapshot.fellowId,
      headSeq,
      snapshot.sameFellowHead.payloadDigest,
    );
  add(
    `NOT EXISTS (SELECT 1 FROM events e WHERE e.problem_id = ? AND e.actor_fellow_id = ?
    AND e.seq > ? AND e.seq < (SELECT seq FROM events WHERE id = ?)
    AND e.id NOT IN (SELECT json_extract(value, '$.eventId') FROM json_each(?)))`,
    snapshot.problemId,
    snapshot.fellowId,
    headSeq,
    eventId,
    JSON.stringify(guard.precedingCandidates),
  );
  // The visible window also changes on restoration, without any new author event.
  add(
    `(SELECT json_group_array(json_array(id, seq, payload_sha256)) FROM (
    SELECT e.id, e.seq, e.payload_sha256 ${historyFrom}
    WHERE e.problem_id = ? AND e.actor_fellow_id = ? AND ${visibleHistoryWhere("?")}
    ORDER BY e.seq DESC LIMIT ?)) = ?`,
    snapshot.problemId,
    snapshot.fellowId,
    headSeq,
    MAX_PUBLICATION_HISTORY,
    JSON.stringify(
      snapshot.recentPublications.map((item) => [item.eventId, item.seq, item.payloadDigest]),
    ),
  );
  add(
    `(SELECT COUNT(*) ${historyFrom} WHERE e.problem_id = ? AND e.actor_fellow_id = ?
    AND ${visibleHistoryWhere("?")}) = ?`,
    snapshot.problemId,
    snapshot.fellowId,
    headSeq,
    snapshot.visiblePublicationCount,
  );
  add(
    `NOT EXISTS (SELECT 1 FROM json_each(?) pending WHERE NOT EXISTS (
    SELECT 1 FROM events e JOIN screening_publications screening ON screening.event_id = e.id
    WHERE e.id = json_extract(pending.value, '$.eventId') AND e.problem_id = ?
      AND e.actor_fellow_id = ? AND e.seq > ? AND e.seq < (SELECT seq FROM events WHERE id = ?)
      AND json_extract(screening.provenance_json, '$.candidate_digest') = json_extract(pending.value, '$.candidateDigest')
      AND json_extract(screening.provenance_json, '$.scope') = 'candidate-and-public-context'))`,
    JSON.stringify(guard.precedingCandidates),
    snapshot.problemId,
    snapshot.fellowId,
    headSeq,
    eventId,
  );
  return { sql: conditions.map((condition) => `(${condition})`).join(" AND "), bindings };
}

/** Useful for non-Fellow governance and withdrawal writers with their own receipt tables. */
export function screeningContextGuardStatement(
  db: D1Database,
  guard: PublicationContextGuard,
  eventId: string,
): D1PreparedStatement {
  const condition = publicationContextGuardSql(guard, eventId);
  return db
    .prepare(`SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM events WHERE id = ?)
    OR (${condition.sql}) THEN 1 ELSE json_extract('[]', '$[${staleMarker}') END`)
    .bind(eventId, ...condition.bindings);
}

/** A private case must not become a retained back door to later-hidden public text. */
export async function storedPublicationContextIsVisible(
  db: D1Database,
  context: ScreeningPublicationContextInput,
): Promise<boolean> {
  if (context.mode === "initial-publication")
    return (
      context.problem_statement === null && context.recent_same_fellow_publications.length === 0
    );
  const statement = context.problem_statement;
  if (statement === null) return false;
  const source = statement.source_event;
  const results = await db.batch([
    db
      .prepare(`SELECT 1 AS available FROM problems p JOIN problem_statement_versions v ON v.problem_id = p.id
      WHERE p.id = ? AND p.status <> 'private-draft' AND v.version = ?
        AND v.statement = ? AND v.falsifier = ? AND v.motivation = ?
        AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
        AND (? IS NULL OR EXISTS (SELECT 1 FROM events e JOIN event_content c ON c.event_id = e.id
          AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
          WHERE e.id = ? AND e.problem_id = p.id AND e.payload_sha256 = ? AND e.seq <= p.public_seq))`)
      .bind(
        context.problem_id,
        statement.version,
        statement.statement,
        statement.falsifier,
        statement.motivation,
        source?.event_id ?? null,
        source?.event_id ?? null,
        source?.payload_digest ?? null,
      ),
    // At most six direct source checks share this D1 read transaction. Keep
    // the public predicate flat: wrapping its target checks in two more
    // anti-joins exceeds Workerd SQLite's expression-depth ceiling of 100.
    ...context.recent_same_fellow_publications.map((expected) =>
      db
        .prepare(`SELECT 1 AS available ${historyFrom}
        WHERE e.id = ? AND e.problem_id = ? AND e.actor_fellow_id = ?
          AND e.seq = ? AND e.payload_sha256 = ? AND c.payload_json = ?
          AND ${visibleHistoryWhere("p.public_seq")}`)
        .bind(
          expected.event_id,
          context.problem_id,
          context.fellow_id,
          expected.seq,
          expected.payload_digest,
          expected.payload_json,
        ),
    ),
  ]);
  return results.every(
    (result) =>
      result.success && (result.results[0] as { available?: unknown } | undefined)?.available === 1,
  );
}
