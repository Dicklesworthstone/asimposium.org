import assert from "node:assert/strict";
import {
  diffProjections,
  REPLAYED_TABLES,
  readProblemLog,
  replayProjections,
} from "../../src/krater/projection-replay.ts";

/** The replayed tables each event object kind builds rows in. */
const TABLES_BY_OBJECT_KIND = {
  claim: ["claims", "claim_projections", "claim_versions", "claim_deps"],
  review: ["reviews"],
  evidence: ["evidence"],
  hypothesis: ["hypotheses"],
  dead_end: ["dead_ends"],
  question: ["questions"],
  retraction: ["retractions"],
  citation: ["citations", "citation_versions"],
  gap: ["proof_gaps"],
  conflict: ["conflicts"],
  synthesis: ["syntheses"],
  relation: ["claim_relations"],
};

/**
 * W2.6 (79n) on real local D1: the projection rows a journey built through
 * its real write routes are exactly what a rebuild from the event log gives.
 * Most replayed tables refuse UPDATE/DELETE by trigger, but a row the log
 * never wrote can still be INSERTed (the lanes forge some on purpose), so
 * every exemption below names exactly which drift a redaction may explain.
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
        `SELECT e.id, e.seq, e.object_id, e.object_kind, e.type, e.object_version, e.actor_fellow_id
           FROM events e JOIN event_content c ON c.event_id = e.id
          WHERE e.problem_id = ? AND c.redacted_at IS NOT NULL`,
      )
      .bind(problemId)
      .all()
  ).results;
  const redactedIds = new Set(redacted.map((row) => row.id));
  // A redacted event explains rows only in the tables its object kind builds
  // (x78n: a questions row keyed like a redacted claim is not excused).
  const builds = (event, table) => (TABLES_BY_OBJECT_KIND[event.object_kind] ?? []).includes(table);
  const tablesOf = (event) => TABLES_BY_OBJECT_KIND[event.object_kind] ?? [];
  const redactedVersions = new Set(
    redacted.flatMap((row) =>
      tablesOf(row).map((table) => `${table}:${row.object_id}@${row.object_version}`),
    ),
  );
  const redactedCreated = new Set(
    redacted
      .filter((row) => row.object_version === 1 || row.object_version === null)
      .flatMap((row) => tablesOf(row).map((table) => `${table}:${row.object_id}`)),
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
      if (
        version === undefined
          ? redactedCreated.has(`${item.table}:${object}`)
          : redactedVersions.has(`${item.table}:${item.key}`)
      ) {
        continue;
      }
    }
    if (item.kind === "orphan_row") {
      // The live row, fetched by its whole key, names its source event (by id
      // or seq); that event must be redacted AND be about this very object and,
      // for a versioned row, this very version, so a forged row that copies a
      // redacted event's seq is not excused (x78n).
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
              builds(event, item.table) &&
              event.object_id === keyValues[0] &&
              (keyValues.length < 2 || String(event.object_version) === keyValues[1]),
          );
        if (source) continue;
      }
    }
    if (item.kind === "column" && item.table === "dead_ends" && item.column === "superseded_by") {
      // The one link replay cannot read once redacted: a dead end superseded by
      // a retry whose own event was redacted. Excused only when the replay left
      // it unfilled, the retry's creating event is redacted, and the retry's
      // live row points back at this dead end (x78n: an invented link to some
      // redacted retry is not excused).
      const live = await db
        .prepare(
          "SELECT superseded_by AS value FROM dead_ends WHERE problem_id = ? AND dead_end_id = ?",
        )
        .bind(problemId, item.key)
        .first();
      const rebuiltValue = replay.rows.dead_ends?.get(item.key)?.superseded_by;
      const backLink =
        live &&
        (await db
          .prepare(
            "SELECT 1 AS ok FROM dead_ends WHERE problem_id = ? AND dead_end_id = ? AND supersedes_dead_end_id = ?",
          )
          .bind(problemId, live.value, item.key)
          .first());
      if (
        backLink &&
        redactedCreated.has(`dead_ends:${live.value}`) &&
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
