import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import type { parseProblemExport } from "./export.ts";

/** Only an already verified, intact export may supply this identity. This
 * fence is not a replacement for verifyProblemExportChain or scratch authority. */
type VerifiedExport = Extract<ReturnType<typeof parseProblemExport>, { readonly ok: true }>;
const EVENTS_PER_GUARD = 8;

/**
 * Resume a committed restore without ever restoring bytes over an existing
 * log. The target must still equal the verified export, including every
 * envelope field, v2 sidecar, payload, checkpoint and the complete chain head.
 * Any content control excludes resumption: an older backup is not authority
 * to undo a hide, redaction or deletion-journal replay.
 *
 * Projection replay performs several reads/writes. Every execution through
 * `database` checks the same identity INSIDE its D1 transaction. A change
 * after the initial probe therefore rolls back that transaction instead of
 * applying a stale governance head or resurrecting projection content.
 */
export function createRestoreFence(db: D1Database, source: VerifiedExport): {
  matches(): Promise<boolean>;
  database: D1Database;
} {
  const problem = source.header.problem;
  const last = source.events.at(-1);
  if (!last || source.trailer.finalCursor !== last.seq)
    throw new Error("RESTORE_FENCE_INPUT_INVALID");
  const checks: { predicate: string; values: unknown[] }[] = [{
    predicate: `EXISTS (SELECT 1 FROM problems p WHERE p.id = ?
      AND p.public_seq = ? AND p.chain_digest = ? AND p.chain_version = 2
      AND (SELECT COUNT(*) FROM events e WHERE e.problem_id = p.id) = ?
      AND (SELECT COUNT(*) FROM event_chain_v2 e WHERE e.problem_id = p.id) = ?
      AND (SELECT COUNT(*) FROM integrity_checkpoints c WHERE c.problem_id = p.id) = ?
      AND (SELECT COUNT(*) FROM checkpoint_chain_v2 c WHERE c.problem_id = p.id) = ?
      AND EXISTS (SELECT 1 FROM krater_integrity_backfill b WHERE b.problem_id = p.id
        AND b.state = 'complete' AND b.chain_version = 2)
      AND NOT EXISTS (SELECT 1 FROM content_controls c WHERE c.problem_id = p.id))`,
    values: [problem, last.seq, last.chainDigest, source.events.length, source.events.length,
      source.header.checkpoints.length, source.header.checkpoints.length],
  }];
  const fields = [
    ["id", "eventId"], ["seq", "seq"], ["type", "type"],
    ["object_kind", "objectKind"], ["object_id", "objectId"],
    ["object_version", "objectVersion"], ["payload_sha256", "payloadSha256"],
    ["created_at", "createdAt"], ["actor_fellow_id", "actorFellowId"],
    ["actor_sponsor_id", "actorSponsorId"], ["actor_session_id", "actorSessionId"],
    ["model_string_self_declared", "modelStringSelfDeclared"], ["harness", "harness"],
    ["writer_credential_id", "writerCredentialId"],
  ] as const;
  // Freeze bound values now; callers cannot change the identity between probes.
  for (let offset = 0; offset < source.events.length; offset += EVENTS_PER_GUARD) {
    const page = source.events.slice(offset, offset + EVENTS_PER_GUARD);
    checks.push({
      predicate: `(SELECT COUNT(*) FROM json_each(?) j
        JOIN events e ON e.problem_id = ? AND e.seq = json_extract(j.value, '$.seq')
        JOIN event_chain_v2 ch ON ch.event_id = e.id AND ch.problem_id = e.problem_id AND ch.seq = e.seq
        JOIN event_content c ON c.event_id = e.id
        WHERE ${fields.map(([column, key]) => `e.${column} IS json_extract(j.value, '$.${key}')`).join(" AND ")}
          AND ch.chain_version = 2
          AND ch.row_digest IS json_extract(j.value, '$.rowDigest')
          AND ch.chain_digest IS json_extract(j.value, '$.chainDigest')
          AND c.payload_sha256 IS e.payload_sha256
          AND c.payload_json IS json_extract(j.value, '$.payloadJson')
          AND c.redacted_at IS NULL) = ?`,
      values: [JSON.stringify(page), problem, page.length],
    });
  }
  for (let offset = 0; offset < source.header.checkpoints.length; offset += EVENTS_PER_GUARD) {
    const page = source.header.checkpoints.slice(offset, offset + EVENTS_PER_GUARD);
    checks.push({
      predicate: `(SELECT COUNT(*) FROM json_each(?) j
        JOIN integrity_checkpoints c ON c.problem_id = ?
          AND c.checkpoint_seq = json_extract(j.value, '$.checkpointSeq')
        JOIN checkpoint_chain_v2 ch ON ch.problem_id = c.problem_id AND ch.checkpoint_seq = c.checkpoint_seq
        WHERE c.root_chain_digest IS json_extract(j.value, '$.rootChainDigest')
          AND c.checkpoint_digest IS json_extract(j.value, '$.checkpointDigest')
          AND ch.root_chain_digest IS c.root_chain_digest AND ch.checkpoint_digest IS c.checkpoint_digest
          AND ch.chain_version = 2
          AND c.checkpoint_version = 1 AND c.checkpoint_mode = 'unsigned-v0') = ?`,
      values: [JSON.stringify(page), problem, page.length],
    });
  }
  const probes = checks.map(({ predicate, values }) =>
    db.prepare(`SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END AS restore_matches`).bind(...values),
  );
  // SQLite's integer-overflow error aborts the batch. A returned false row
  // alone would be too late: later writes in that batch would already commit.
  const guards = checks.map(({ predicate, values }) =>
    db.prepare(`SELECT CASE WHEN ${predicate} THEN 1 ELSE abs(-9223372036854775808) END AS restore_matches`).bind(...values),
  );
  const passed = (results: readonly D1Result[]) =>
    results.length === checks.length && results.every((result) =>
      result.success && result.results.length === 1 &&
      (result.results[0] as { restore_matches?: unknown }).restore_matches === 1,
    );
  async function execute<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results = await db.batch<T>([...guards, ...statements]);
    if (results.length !== guards.length + statements.length ||
        !passed(results.slice(0, guards.length)))
      throw new Error("RESTORE_FENCE_RESULT_INVALID");
    return results.slice(guards.length);
  }
  const owned = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function wrap(raw: D1PreparedStatement): D1PreparedStatement {
    const statement = {
      bind: (...values: unknown[]) => wrap(raw.bind(...values)),
      all: async <T>() => (await execute<T>([raw]))[0]!,
      run: async <T>() => (await execute<T>([raw]))[0]!,
      first: async <T>(column?: string): Promise<T | null> => {
        const row = (await execute<Record<string, unknown>>([raw]))[0]!.results[0];
        if (row === undefined) return null;
        if (column === undefined) return row as T;
        if (!Object.hasOwn(row, column)) throw new Error("RESTORE_FENCE_COLUMN_INVALID");
        return row[column] as T;
      },
    } as D1PreparedStatement;
    owned.set(statement, raw);
    return statement;
  }
  // Deliberately only the prepared-statement interface used by projection
  // replay. No exec/dump/withSession escape hatch to an unfenced writer.
  const database = {
    prepare: (query: string) => wrap(db.prepare(query)),
    batch: <T>(statements: D1PreparedStatement[]) => execute<T>(statements.map((statement) => {
      const raw = owned.get(statement);
      if (!raw) throw new Error("RESTORE_FENCE_FOREIGN_STATEMENT");
      return raw;
    })),
  } as D1Database;
  return { matches: async () => passed(await db.batch(probes)), database };
}
