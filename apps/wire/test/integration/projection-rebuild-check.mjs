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
  const replay = replayProjections(problemId, await readProblemLog(db, problemId));
  const counts = Object.fromEntries(
    Object.keys(REPLAYED_TABLES).map((table) => [table, replay.rows[table].size]),
  );
  const first = await diffProjections(db, problemId, replay);
  assert.deepEqual(first.unreplayable, [], "every relevant event has its payload");
  assert.deepEqual(first.drift, [], "rebuild from the log equals the incrementally built rows");

  const populated = Object.keys(REPLAYED_TABLES).filter((table) => counts[table] > 0);
  assert.ok(populated.length > 0, "the journey produced replayed rows");
  return { counts };
}
