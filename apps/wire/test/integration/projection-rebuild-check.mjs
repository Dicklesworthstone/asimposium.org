import assert from "node:assert/strict";
import {
  diffProjections,
  REPLAYED_TABLES,
  readProblemLog,
  replayProjections,
} from "../../src/krater/projection-replay.ts";

/**
 * W2.6 (79n) on real local D1: the projection rows a journey built through
 * its real write routes are exactly what a rebuild from the event log gives.
 * (The replayed tables are append-only by trigger, so drift cannot be planted
 * in place; export-restore-real-bindings.mjs proves repair by restoring into
 * an empty scratch database.)
 */
export async function assertProjectionsRebuild(db, problemId) {
  const replay = await replayProjections(problemId, await readProblemLog(db, problemId));
  const counts = Object.fromEntries(
    Object.keys(REPLAYED_TABLES).map((table) => [table, replay.rows[table].size]),
  );
  const first = await diffProjections(db, problemId, replay);
  // Lawfully redacted content cannot be replayed. Only those events may be
  // unreplayable, and the only drift allowed is the live rows they built.
  const redacted = (
    await db
      .prepare(
        `SELECT e.id, e.seq, e.object_id, e.type, e.object_version, e.actor_fellow_id
           FROM events e JOIN event_content c ON c.event_id = e.id
          WHERE e.problem_id = ? AND c.redacted_at IS NOT NULL`,
      )
      .bind(problemId)
      .all()
  ).results;
  const redactedIds = new Set(redacted.map((row) => row.id));
  const redactedSeqs = new Set(redacted.map((row) => row.seq));
  const redactedObjects = new Set(redacted.map((row) => row.object_id));
  // Statement review rows carry no source event: their key is version@reviewer.
  const redactedStatementReviews = new Set(
    redacted
      .filter((row) => row.type === "problem.statement-reviewed")
      .map((row) => `${row.object_version}@${row.actor_fellow_id}`),
  );
  assert.deepEqual(
    first.unreplayable.filter((id) => !redactedIds.has(id)),
    [],
    "only redacted events are unreplayable",
  );
  const unexplained = [];
  for (const item of first.drift) {
    if (item.table === "problems") {
      unexplained.push(item);
      continue;
    }
    if (
      item.kind === "orphan_row" &&
      item.table === "problem_statement_reviews" &&
      redactedStatementReviews.has(item.key)
    ) {
      continue;
    }
    if (item.kind === "orphan_row") {
      const [pk] = REPLAYED_TABLES[item.table];
      const row = await db
        .prepare(`SELECT * FROM ${item.table} WHERE problem_id = ? AND ${pk} = ?`)
        .bind(problemId, item.key.split("@")[0])
        .first();
      if (row && (redactedIds.has(row.source_event_id) || redactedSeqs.has(row.seq))) continue;
    }
    if (item.kind === "column") {
      // A link to an object whose own event was redacted (e.g. superseded_by
      // naming a redacted retry) can no longer be read from the log.
      const [pk] = REPLAYED_TABLES[item.table];
      const live = await db
        .prepare(
          `SELECT ${item.column} AS value FROM ${item.table} WHERE problem_id = ? AND ${pk} = ?`,
        )
        .bind(problemId, item.key.split("@")[0])
        .first();
      if (live && redactedObjects.has(live.value)) continue;
    }
    unexplained.push(item);
  }
  assert.deepEqual(unexplained, [], "rebuild from the log equals the incrementally built rows");

  const populated = Object.keys(REPLAYED_TABLES).filter((table) => counts[table] > 0);
  assert.ok(populated.length > 0, "the journey produced replayed rows");
  return { counts, redacted: redacted.length };
}
