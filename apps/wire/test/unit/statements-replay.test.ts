import { afterEach, expect, test } from "bun:test";
import { redactEventContent } from "../../src/krater/krater.ts";
import {
  diffProjections,
  type ProjectionDrift,
  projectionDoctorReport,
  readProblemLog,
  repairProjections,
  replayProjections,
} from "../../src/krater/projection-replay.ts";
import { PROBLEM, statementsFixture } from "../support/statements-fixture.ts";

type Fixture = Awaited<ReturnType<typeof statementsFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});
async function fixture() {
  const f = await statementsFixture();
  fixtures.push(f);
  return f;
}

test("a withdrawn admission keeps its immutable public version boundary without concealing intact later rows", async () => {
  const f = await fixture();
  for (let version = 4; version <= 8; version++)
    await f.revise(`Finite tree scope at public statement ${version}.`);
  const before = await projectionDoctorReport(f.db, PROBLEM);
  expect(before.status).toBe("consistent");
  expect(before.drift).toEqual([]);
  const admission = (await readProblemLog(f.db, PROBLEM)).find(
    (event) => event.type === "problem.admitted",
  );
  if (!admission) throw new Error("Expected an immutable admission source");
  expect(admission.objectVersion).toBe(2);
  const live = () =>
    f.sql
      .query<Record<string, unknown> & { version: number }, [string]>(
        "SELECT * FROM problem_statement_versions WHERE problem_id=? ORDER BY version",
      )
      .all(PROBLEM);
  const liveBefore = live();
  expect(liveBefore.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  await redactEventContent(f.db, admission.id, "privacy", new Date().toISOString());
  expect(live()).toEqual(liveBefore);

  const replay = await replayProjections(PROBLEM, await readProblemLog(f.db, PROBLEM));
  expect(replay.statementVersionsFrom).toBe(2);
  expect(replay.unreplayable).toEqual([admission.id]);
  expect([...replay.rows.problem_statement_versions.keys()]).toEqual([
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
  ]);
  const expected = [
    { table: "problem_statement_versions", key: "2", kind: "orphan_row" },
  ] satisfies ProjectionDrift[];
  expect((await diffProjections(f.db, PROBLEM, replay)).drift).toEqual(expected);
  const after = await projectionDoctorReport(f.db, PROBLEM);
  expect(after.status).toBe("unreplayable");
  expect(after.unreplayable_events).toBe(1);
  expect(after.drift).toEqual(expected);
  expect(after.repairable).toBe(false);
  await expect(repairProjections(f.db, PROBLEM)).rejects.toMatchObject({
    code: "PROJECTION_REBUILD_UNREPLAYABLE",
    inserted: 0,
  });
  expect(live()).toEqual(liveBefore);
});

test("the admission-envelope boundary excludes private versions and preserves known legacy omissions", async () => {
  const f = await fixture();
  const admission = (await readProblemLog(f.db, PROBLEM)).find(
    (event) => event.type === "problem.admitted",
  );
  if (!admission?.payload) throw new Error("Expected a complete admission source");
  expect((await replayProjections(PROBLEM, [])).statementVersionsFrom).toBe(
    Number.POSITIVE_INFINITY,
  );
  for (const patch of [
    { objectId: "P-OTHER" },
    { objectVersion: 0 },
    { objectVersion: -1 },
    { objectVersion: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    expect(
      (await replayProjections(PROBLEM, [{ ...admission, ...patch, payload: null }]))
        .statementVersionsFrom,
    ).toBe(Number.POSITIVE_INFINITY);
  }
  const { admitted_version: _privateTimeMetadata, ...legacy } = admission.payload;
  const older = await replayProjections(PROBLEM, [{ ...admission, payload: legacy }]);
  expect(older.statementVersionsFrom).toBe(3);
  expect(older.rows.problem_statement_versions.size).toBe(0);
  const withdrawn = await replayProjections(PROBLEM, [{ ...admission, payload: null }]);
  expect(withdrawn.statementVersionsFrom).toBe(2);
  expect(withdrawn.rows.problem_statement_versions.size).toBe(0);
  expect(withdrawn.head).toEqual({
    last_material_at: admission.createdAt,
    last_material_event_id: admission.id,
  });
  expect(withdrawn.governanceKnown).toBe(false);
});
