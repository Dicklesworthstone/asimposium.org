import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkPlants, classifyPlantRun, PLANTS } from "../planted-defects.mjs";

// The planted-defect registry must stay applicable: every snippet matches its
// file exactly once, every plant changes something, and every command target
// exists. A refactor that silently breaks a plant fails here, in toolchain:test.
const ROOT = resolve(import.meta.dir, "../..");

test("every planted defect still applies to the current source", () => {
  expect(checkPlants(ROOT)).toEqual([]);
});

test("an explicit selection checks its named current source site", () => {
  expect(checkPlants(ROOT, ["artifact-binds-unverified-bytes"])).toEqual([]);
  expect(
    checkPlants(resolve(import.meta.dir, "planted-defects.test.ts"), [
      "artifact-binds-unverified-bytes",
    ]),
  ).toEqual(["artifact-binds-unverified-bytes: apps/wire/src/krater/artifact-store.ts is missing"]);
});

test("empty, unknown and duplicate selections cannot report a zero-run success", () => {
  expect(checkPlants(ROOT, [])).toEqual(["no plants selected"]);
  expect(checkPlants(ROOT, ["PLANTED-not-a-real-id"])).toEqual([
    "unknown plant selector at position 1",
  ]);
  expect(checkPlants(ROOT, ["artifact-binds-unverified-bytes", "PLANTED-not-a-real-id"])).toEqual([
    "unknown plant selector at position 2",
  ]);
  expect(
    checkPlants(ROOT, ["artifact-binds-unverified-bytes", "artifact-binds-unverified-bytes"]),
  ).toEqual(["duplicate plant selector at position 2"]);
});

test("runner refuses its primary checkout through the existing Linux cwd alias", () => {
  // procfs gives Linux a real filesystem alias without creating/deleting a
  // fixture. Other platforms still exercise direct primary-root refusal.
  const target = process.platform === "linux" ? "/proc/self/cwd" : ROOT;
  const result = spawnSync(
    process.execPath,
    [
      resolve(ROOT, "scripts/planted-defects.mjs"),
      "--run",
      target,
      // Keep this probe incapable of running a mutation if the root guard breaks.
      "--only",
      "PLANTED-not-a-real-id",
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 5_000 },
  );
  expect(result.signal).toBeNull();
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("never the primary checkout");
});

test("every plant changes code and names an existing proof", () => {
  const ids = new Set<string>();
  for (const plant of PLANTS) {
    expect(ids.has(plant.id)).toBe(false);
    ids.add(plant.id);
    expect(plant.replace).not.toBe(plant.find);
    const target = plant.command.find((part: string) => /\.(mjs|ts|sh)$/.test(part));
    expect(target, plant.id).toBeDefined();
    expect(existsSync(resolve(ROOT, target as string)), `${plant.id} -> ${target}`).toBe(true);
  }
});

test("only an assertion or test failure counts as caught", () => {
  const run = (status: number | null, output: string, signal: string | null = null) =>
    classifyPlantRun({ status, signal, output });
  expect(run(1, "AssertionError [ERR_ASSERTION]: expected 503")).toBe("caught");
  expect(run(1, "(fail) retention > replays credentials\n 1 fail")).toBe("caught");
  expect(run(0, "")).toBe("survived");
  expect(run(null, "", "SIGTERM")).toBe("inconclusive");
  expect(run(1, "Error: Cannot find module 'hono'\nAssertionError")).toBe("inconclusive");
  expect(run(1, "SyntaxError: Unexpected token")).toBe("inconclusive");
  expect(run(1, "D1_ERROR: database is locked")).toBe("inconclusive");
  expect(run(1, '{"suite":"e2e-herald-wrangler-dev","status":"fail","code":"X"}')).toBe("caught");
  expect(run(78, '{"suite":"e2e-herald-wrangler-dev","status":"blocked","code":"X"}')).toBe(
    "inconclusive",
  );
  expect(
    run(1, '{"kind":"agora-local-lane-summary","status":"fail","checks":109,"failed":["x"]}'),
  ).toBe("caught");
  expect(
    run(1, '{"kind":"agora-local-lane-summary","status":"fail","code":"AGORA_BUILD_FAILED"}'),
  ).toBe("inconclusive");
  expect(
    run(1, '{"kind":"agora-local-lane-summary","status":"fail","checks":109,"failed":[]}'),
  ).toBe("inconclusive");
});
