import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkPlants, PLANTS } from "../planted-defects.mjs";

// The planted-defect registry must stay applicable: every snippet matches its
// file exactly once, every plant changes something, and every command target
// exists. A refactor that silently breaks a plant fails here, in toolchain:test.
const ROOT = resolve(import.meta.dir, "../..");

test("every planted defect still applies to the current source", () => {
  expect(checkPlants(ROOT)).toEqual([]);
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
