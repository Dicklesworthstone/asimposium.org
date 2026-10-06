import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-expect-error -- plain ESM lane helper without type declarations
import { classifyGuardTrigger, refusingTriggerDigests } from "../integration/trigger-probes.mjs";

/**
 * W2.1 (asimposiumorg-jfi): every guard trigger the real-bindings lanes can
 * probe is accounted for. Each probe id of every probe-eligible trigger in
 * the migrated schema is either listed under a lane in
 * trigger-probe-coverage.json (that lane fails if it stops reaching it) or
 * named in its "unprobed" map with a reason. A new guard trigger therefore
 * cannot land unclassified.
 *
 * The probes try one row per trigger, so a guard narrowed in place (a WHEN
 * that still covers the probed row, a transition rule loosened) could pass
 * them. "definitions" therefore pins a digest of every refusing BEFORE
 * UPDATE/DELETE trigger, transition rules included: any edit, addition or
 * removal fails here until the pin is updated in the same reviewed commit.
 * This is a change detector, not behavioural proof.
 */
const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");
const COVERAGE = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../integration/trigger-probe-coverage.json"), "utf8"),
) as {
  lanes: Record<string, string[]>;
  unprobed: Record<string, string>;
  definitions: Record<string, string>;
};

function migratedTriggers(): Array<{ name: string; tbl_name: string; sql: string }> {
  const sqlite = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    sqlite.run(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return sqlite
    .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
    .all() as Array<{ name: string; tbl_name: string; sql: string }>;
}

describe("guard trigger probe coverage (jfi)", () => {
  const eligible = migratedTriggers()
    .map((trigger) => classifyGuardTrigger(trigger.name, trigger.tbl_name, trigger.sql))
    .filter((probe: { kind: string }) => probe.kind !== "skip") as Array<{
    name: string;
    ids: string[];
  }>;
  const covered = new Set(Object.values(COVERAGE.lanes).flat());

  test("the classifier finds the ledger guards (nonvacuity)", () => {
    const names = eligible.map((probe) => probe.name);
    for (const name of [
      "events_immutable_before_delete",
      "reviews_immutable_delete",
      "scientific_withdrawals_no_delete",
      "proof_gaps_immutable_update",
    ]) {
      expect(names).toContain(name);
    }
  });

  test("every probe id is covered by a lane or unprobed with a reason", () => {
    const unaccounted = eligible
      .flatMap((probe) => probe.ids.map((id) => ({ id, name: probe.name })))
      .filter(
        ({ id, name }) =>
          !covered.has(id) &&
          !(typeof COVERAGE.unprobed[id] === "string" && COVERAGE.unprobed[id].length > 0) &&
          !(typeof COVERAGE.unprobed[name] === "string" && COVERAGE.unprobed[name].length > 0),
      )
      .map(({ id }) => id);
    expect(unaccounted).toEqual([]);
  });

  test("every refusing trigger's definition matches its reviewed pin", () => {
    expect(refusingTriggerDigests(migratedTriggers())).toEqual(COVERAGE.definitions);
  });

  test("coverage names only probe ids that exist", () => {
    const ids = new Set(eligible.flatMap((probe) => probe.ids));
    const names = new Set(eligible.map((probe) => probe.name));
    expect([...covered].filter((id) => !ids.has(id))).toEqual([]);
    expect(
      Object.keys(COVERAGE.unprobed).filter((key) => !ids.has(key) && !names.has(key)),
    ).toEqual([]);
  });
});
