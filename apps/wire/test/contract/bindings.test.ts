import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { REQUIRED_BINDINGS } from "../../src/env";
import worker from "../../src/index";
import { boundEnv, executionContext } from "../support/bindings";

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
  const config = Bun.TOML.parse(toml) as {
    d1_databases?: Array<{ binding?: unknown }>;
    r2_buckets?: Array<{ binding?: unknown }>;
    durable_objects?: { bindings?: Array<{ name?: unknown }> };
  };
  const values = [
    ...(config.d1_databases ?? []).map((entry) => entry.binding),
    ...(config.r2_buckets ?? []).map((entry) => entry.binding),
    ...(config.durable_objects?.bindings ?? []).map((entry) => entry.name),
  ];
  if (values.some((value) => typeof value !== "string")) {
    throw new Error("infra/wrangler.toml contains a binding without a string name");
  }
  return values as string[];
}

describe("binding names agree with the Worker configuration", () => {
  test("every binding this Worker requires is provided by infra/wrangler.toml", async () => {
    const provided = await configuredBindings();

    expect(provided.length).toBeGreaterThan(0);
    for (const required of REQUIRED_BINDINGS) {
      expect(provided).toContain(required);
    }
  });

  test("the production entrypoint cron always nudges the outbox binding", async () => {
    const requests: Request[] = [];
    const env = boundEnv({
      KRATER_OUTBOX: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (request: Request) => {
            requests.push(request);
            return new Response(JSON.stringify({ accepted: true }), { status: 202 });
          },
        }),
      },
    });

    await worker.scheduled(
      {} as Parameters<typeof worker.scheduled>[0],
      env,
      executionContext() as Parameters<typeof worker.scheduled>[2],
    );

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? "https://invalid.example").pathname).toBe("/nudge");
    expect(requests[0]?.method).toBe("POST");
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
