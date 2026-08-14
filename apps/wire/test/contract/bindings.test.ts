import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { REQUIRED_BINDINGS } from "../../src/env";

/**
 * The binding names this Worker requires must be the binding names the Worker
 * configuration actually provides.
 *
 * The observed defect this closes: `src/env.ts` declared an R2 binding named
 * `CAS` while `infra/wrangler.toml` provides `ARTIFACTS`. Every suite in this
 * package passed, because every suite supplied its own env, and the Worker
 * would still have answered `503 BINDING_MISSING` the moment it ran under the
 * repository's only Wrangler configuration. A green package that cannot boot
 * is exactly the failure a scaffold exists to prevent.
 *
 * This reads `infra/wrangler.toml` as *text* and asserts agreement on names.
 * It runs no Wrangler command, starts no `workerd`, and proves nothing about
 * whether those bindings resolve to anything at runtime.
 *
 * `infra/` is owned elsewhere. This test only reads it, and fails loudly rather
 * than skipping if it moves, so the two sides cannot drift apart in silence.
 */

const CONFIG_PATH = resolve(import.meta.dir, "../../../../infra/wrangler.toml");

async function configuredBindings(): Promise<string[]> {
  const file = Bun.file(CONFIG_PATH);
  if (!(await file.exists())) {
    throw new Error(
      "infra/wrangler.toml is missing; apps/wire pins its binding names to that file " +
        "(see infra/README.md). Update this test and src/env.ts together if it moved.",
    );
  }
  const toml = await file.text();
  return [...toml.matchAll(/^\s*binding\s*=\s*"([^"]+)"/gm)].map((match) => match[1] as string);
}

describe("binding names agree with the Worker configuration", () => {
  test("every binding this Worker requires is provided by infra/wrangler.toml", async () => {
    const provided = await configuredBindings();

    expect(provided.length).toBeGreaterThan(0);
    for (const required of REQUIRED_BINDINGS) {
      expect(provided).toContain(required);
    }
  });

  test("the configuration provides no binding this Worker silently ignores", async () => {
    const provided = await configuredBindings();

    // Not a style rule: an unread binding is either a missing feature or a
    // stale config entry, and both should be a decision, not an accident.
    for (const name of provided) {
      expect(REQUIRED_BINDINGS as readonly string[]).toContain(name);
    }
  });
});
