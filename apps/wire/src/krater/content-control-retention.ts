import { canonicalJson } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import type { RetentionControlRecord } from "./retention.ts";

/** Private recovery material. Actor and rationale stay in the restricted
 * journal; public faces continue to use the existing coarse moderation log. */
export const ContentControlSnapshotSchema = z
  .object({
    control_id: z.string().startsWith("CC-").max(128),
    problem_id: z.string().min(1).max(128),
    target_kind: z.string().min(1).max(128),
    target_ref: z.string().min(1).max(128),
    visibility: z.enum(["hidden", "visible"]),
    source: z.enum(["community-reports", "operator"]),
    reason_category: z.string().max(128),
    actor: z.string().max(256),
    reason: z.string().min(1).max(1000),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    created_at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    actor_kind: z.enum(["community", "sponsor", "operator"]).nullable(),
  })
  .strict()
  .refine(
    (row) =>
      row.actor_kind === null ||
      (row.actor_kind === "community"
        ? row.source === "community-reports"
        : row.source === "operator"),
  );

export type ContentControlSnapshot = z.infer<typeof ContentControlSnapshotSchema>;
export const CONTENT_CONTROL_COLUMNS = [
  "control_id",
  "problem_id",
  "target_kind",
  "target_ref",
  "visibility",
  "source",
  "reason_category",
  "actor",
  "reason",
  "version",
  "created_at",
  "actor_kind",
] as const satisfies readonly (keyof ContentControlSnapshot)[];

export function contentControlRecoverySnapshot(
  record: RetentionControlRecord,
): ContentControlSnapshot {
  const row = ContentControlSnapshotSchema.parse(record.payload);
  if (
    record.action !== "content-control" ||
    record.targetType !== "content_control" ||
    record.targetId !== row.control_id ||
    record.controlId !== `RC-${row.control_id}` ||
    record.issuedAt !== row.created_at
  )
    throw new Error("CONTENT_CONTROL_RECOVERY_INVALID");
  return row;
}

/** Existing immutable controls must be represented before a new journal can
 * be published. The comparison includes private attribution and exact version,
 * not only the current visible/hidden bit. Digest verification is separate. */
export function contentControlJournalCoverageSql(
  controlAlias: string,
  journalAlias: string,
): string {
  return `${journalAlias}.control_id = 'RC-' || ${controlAlias}.control_id
    AND ${journalAlias}.action = 'content-control'
    AND ${journalAlias}.target_type = 'content_control'
    AND ${journalAlias}.target_id = ${controlAlias}.control_id
    AND ${journalAlias}.created_at = ${controlAlias}.created_at
    AND json_extract(${journalAlias}.record_json, '$.controlId') = 'RC-' || ${controlAlias}.control_id
    AND json_extract(${journalAlias}.record_json, '$.action') = 'content-control'
    AND json_extract(${journalAlias}.record_json, '$.targetType') = 'content_control'
    AND json_extract(${journalAlias}.record_json, '$.targetId') = ${controlAlias}.control_id
    AND json_extract(${journalAlias}.record_json, '$.issuedAt') = ${controlAlias}.created_at
    AND ${CONTENT_CONTROL_COLUMNS.map(
      (column) =>
        `json_extract(${journalAlias}.record_json, '$.payload.${column}') IS ${controlAlias}.${column}`,
    ).join(" AND ")}`;
}

function groups(records: readonly RetentionControlRecord[]): ContentControlSnapshot[][] {
  const targets = new Map<string, ContentControlSnapshot[]>();
  const identities = new Set<string>();
  for (const record of records) {
    if (record.action !== "content-control") continue;
    const row = contentControlRecoverySnapshot(record);
    if (identities.has(row.control_id)) throw new Error("CONTENT_CONTROL_RECOVERY_CONFLICT");
    identities.add(row.control_id);
    const key = JSON.stringify([row.problem_id, row.target_ref]);
    const target = targets.get(key) ?? [];
    if (target.some((previous) => previous.version === row.version))
      throw new Error("CONTENT_CONTROL_RECOVERY_CONFLICT");
    target.push(row);
    targets.set(key, target);
  }
  // Historical backfill may append earlier decisions after recent decisions
  // in the journal. The original version, never journal arrival time, orders them.
  return [...targets.values()].map((rows) => rows.sort((a, b) => a.version - b.version));
}

async function storedControls(db: D1Database, row: ContentControlSnapshot) {
  const result = await db
    .prepare(`SELECT ${CONTENT_CONTROL_COLUMNS.join(", ")} FROM content_controls
      WHERE problem_id = ? AND target_ref = ? ORDER BY version`)
    .bind(row.problem_id, row.target_ref)
    .all<ContentControlSnapshot>();
  if (!result.success) throw new Error("CONTENT_CONTROL_RECOVERY_UNAVAILABLE");
  return result.results.map((value) => ContentControlSnapshotSchema.parse(value));
}

/** Preflight all affected targets before any restore or retention mutation.
 * The returned batch repeats the exact predecessor check transactionally:
 * a new control between preflight and replay aborts every visibility insertion.
 * No row is overwritten and no public object is copied or published. */
export async function prepareContentControlReplay(
  db: D1Database,
  records: readonly RetentionControlRecord[],
): Promise<{ readonly count: number; apply(): Promise<void> }> {
  const statements: D1PreparedStatement[] = [];
  let count = 0;
  for (const expected of groups(records)) {
    const first = expected[0];
    if (!first) throw new Error("CONTENT_CONTROL_RECOVERY_INVALID");
    const existing = await storedControls(db, first);
    const expectedById = new Map(expected.map((row) => [row.control_id, canonicalJson(row)]));
    for (const row of existing) {
      if (expectedById.get(row.control_id) !== canonicalJson(row))
        throw new Error("CONTENT_CONTROL_RECOVERY_CONFLICT");
    }
    const matches = CONTENT_CONTROL_COLUMNS.map(
      (column) => `c.${column} IS json_extract(j.value, '$.${column}')`,
    ).join(" AND ");
    statements.push(
      db
        .prepare(`SELECT CASE WHEN
          (SELECT COUNT(*) FROM content_controls WHERE problem_id = ? AND target_ref = ?) = ?
          AND (SELECT COUNT(*) FROM content_controls c JOIN json_each(?) j ON ${matches}
            WHERE c.problem_id = ? AND c.target_ref = ?) = ?
          THEN 1 ELSE abs(-9223372036854775808) END AS recovery_unchanged`)
        .bind(
          first.problem_id,
          first.target_ref,
          existing.length,
          JSON.stringify(existing),
          first.problem_id,
          first.target_ref,
          existing.length,
        ),
    );
    for (const row of expected) {
      count += 1;
      if (existing.some((previous) => previous.control_id === row.control_id)) continue;
      statements.push(
        db
          .prepare(`INSERT INTO content_controls (${CONTENT_CONTROL_COLUMNS.join(", ")})
            SELECT ${CONTENT_CONTROL_COLUMNS.map(() => "?").join(", ")}
            WHERE EXISTS (SELECT 1 FROM problems WHERE id = ?)`)
          .bind(...CONTENT_CONTROL_COLUMNS.map((column) => row[column]), row.problem_id),
      );
    }
  }
  return {
    count,
    async apply() {
      if (statements.length > 0) {
        const result = await db.batch(statements);
        if (result.length !== statements.length || result.some((row) => !row.success))
          throw new Error("CONTENT_CONTROL_RECOVERY_UNAVAILABLE");
      }
    },
  };
}

/** Verify the whole authenticated history and its effective latest decision.
 * A per-problem restore need not invent unrelated absent problem rows. */
export async function contentControlResurrections(
  db: D1Database,
  records: readonly RetentionControlRecord[],
): Promise<string[]> {
  const conflicts: string[] = [];
  for (const expected of groups(records)) {
    const first = expected[0];
    if (!first) throw new Error("CONTENT_CONTROL_RECOVERY_INVALID");
    const present = await db
      .prepare("SELECT id FROM problems WHERE id = ?")
      .bind(first.problem_id)
      .first();
    if (present === null) continue;
    if (canonicalJson(await storedControls(db, first)) !== canonicalJson(expected))
      conflicts.push(`content-control:${first.problem_id}/${first.target_ref}`);
  }
  return conflicts;
}
