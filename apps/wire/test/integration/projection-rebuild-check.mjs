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
 *
 * options.standInTypes: lane-only event types (e.g. a competing-write stand-in)
 * that build no rows, so they may also be unreplayable (x78n).
 * options.requirePopulated: false when the caller sweeps every problem,
 * including ones whose journey replays no rows.
 */
export async function assertProjectionsRebuild(db, problemId, options = {}) {
  const standInTypes = options.standInTypes ?? new Set();
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
  const redactedVersions = new Set(redacted.map((row) => `${row.object_id}@${row.object_version}`));
  const redactedCreated = new Set(
    redacted
      .filter((row) => row.object_version === 1 || row.object_version === null)
      .map((row) => row.object_id),
  );
  // Statement review rows carry no source event: their key is version@reviewer.
  const redactedStatementReviews = new Set(
    redacted
      .filter((row) => row.type === "problem.statement-reviewed")
      .map((row) => `${row.object_version}@${row.actor_fellow_id}`),
  );
  const standIns = new Set();
  if (standInTypes.size > 0) {
    const rows = (
      await db
        .prepare(
          `SELECT id FROM events WHERE problem_id = ? AND type IN (${[...standInTypes]
            .map(() => "?")
            .join(", ")})`,
        )
        .bind(problemId, ...standInTypes)
        .all()
    ).results;
    for (const row of rows) standIns.add(row.id);
  }
  assert.deepEqual(
    first.unreplayable.filter((id) => !redactedIds.has(id) && !standIns.has(id)),
    [],
    "only redacted events (and lane stand-ins) are unreplayable",
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
    // A row built by a redacted event cannot be rebuilt either: a versioned
    // row (key "object@version") only when that exact object version's event
    // was redacted, an unversioned row (a claim, its projection) only when the
    // object's creating event (version 1) was. A forged later version under a
    // redacted claim is not excused (x78n).
    if (item.kind === "orphan_row") {
      const [object, version] = item.key.split("@");
      if (version === undefined ? redactedCreated.has(object) : redactedVersions.has(item.key)) {
        continue;
      }
    }
    if (item.kind === "orphan_row") {
      // The live row, fetched by its whole key, names its source event (by id
      // or seq); that event must be redacted AND be about this very object, so
      // a forged row that copies a redacted event's seq is not excused (x78n).
      const keyColumns = REPLAYED_TABLES[item.table];
      const keyValues = item.key.split("@");
      if (keyValues.length === keyColumns.length) {
        const row = await db
          .prepare(
            `SELECT * FROM ${item.table} WHERE problem_id = ? AND ${keyColumns
              .map((column) => `${column} = ?`)
              .join(" AND ")}`,
          )
          .bind(problemId, ...keyValues)
          .first();
        const source =
          row &&
          redacted.find(
            (event) =>
              (event.id === row.source_event_id || event.seq === row.seq) &&
              event.object_id === keyValues[0],
          );
        if (source) continue;
      }
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
      // Excused only when the replay could not fill the link at all and the
      // object it names was never replayable (its creating event is redacted).
      const rebuiltValue = replay.rows[item.table]?.get(item.key)?.[item.column];
      if (
        live &&
        redactedCreated.has(live.value) &&
        (rebuiltValue === null || rebuiltValue === undefined)
      ) {
        continue;
      }
    }
    unexplained.push(item);
  }
  // Drift items are keys and column names only (no content), so they are safe
  // to print, and lanes that hash their error messages still show them.
  if (unexplained.length > 0) {
    console.error(JSON.stringify({ stage: "projection-rebuild-drift", problemId, unexplained }));
  }
  assert.deepEqual(unexplained, [], "rebuild from the log equals the incrementally built rows");

  if (options.requirePopulated !== false) {
    const populated = Object.keys(REPLAYED_TABLES).filter((table) => counts[table] > 0);
    assert.ok(populated.length > 0, "the journey produced replayed rows");
  }
  return { counts, redacted: redacted.length };
}
