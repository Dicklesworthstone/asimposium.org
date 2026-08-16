import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { KraterOutboxDrainer as enrollmentHarnessDrainer } from "../../src/enrollment/local-d1-worker";
import { REQUIRED_BINDINGS } from "../../src/env";
import worker, { KraterOutboxDrainer as productionDrainer } from "../../src/index";
import { KraterOutboxDrainer as renderHarnessDrainer } from "../../src/render-face/worker";
import { boundEnv, executionContext } from "../support/bindings";

/**
 * The binding names this Worker requires must be the binding names the Worker
 * configuration actually provides.
 *
 * The observed defect this closes: the topology and generated configs bound a
 * public-delivery R2 bucket while `src/env.ts` and the base config ignored it.
 * Every suite supplied its own env, so the Worker could have answered a
 * cheerful health response despite a required production binding being absent.
 * A green package that cannot boot with the configured binding set is exactly
 * the failure a scaffold exists to prevent.
 *
 * This reads `infra/wrangler.toml` as *text* and asserts agreement on names.
 * It runs no Wrangler command, starts no `workerd`, and proves nothing about
 * whether those bindings resolve to anything at runtime.
 *
 * `infra/` is owned elsewhere. This test only reads it, and fails loudly rather
 * than skipping if it moves, so the two sides cannot drift apart in silence.
 */

const CONFIG_PATH = resolve(import.meta.dir, "../../../../infra/wrangler.toml");

interface ConfiguredBindings {
  names: string[];
  r2Buckets: Array<{ binding: string; bucketName: string }>;
}

async function configuredBindings(): Promise<ConfiguredBindings> {
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
    r2_buckets?: Array<{ binding?: unknown; bucket_name?: unknown }>;
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

  const r2Buckets = config.r2_buckets ?? [];
  if (
    r2Buckets.some(
      (bucket) => typeof bucket.binding !== "string" || typeof bucket.bucket_name !== "string",
    )
  ) {
    throw new Error(
      "infra/wrangler.toml contains an R2 bucket without string binding and bucket_name",
    );
  }
  return {
    names: values as string[],
    r2Buckets: (r2Buckets as Array<{ binding: string; bucket_name: string }>).map((bucket) => ({
      binding: bucket.binding,
      bucketName: bucket.bucket_name,
    })),
  };
}

describe("binding names agree with the Worker configuration", () => {
  test("every binding this Worker requires is provided by infra/wrangler.toml", async () => {
    const { names: provided } = await configuredBindings();

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

  test("alternate Wrangler entrypoints export every configured Durable Object class", () => {
    // The S-1 and S-5 harnesses override `main` while retaining
    // infra/wrangler.toml. Wrangler validates the configured class export on
    // the selected entrypoint before workerd starts, even though these
    // harnesses never call KRATER_OUTBOX.
    expect(enrollmentHarnessDrainer).toBe(productionDrainer);
    expect(renderHarnessDrainer).toBe(productionDrainer);
  });

  test("the configuration provides no binding this Worker silently ignores", async () => {
    const { names: provided } = await configuredBindings();

    // Not a style rule: an unread binding is either a missing feature or a
    // stale config entry, and both should be a decision, not an accident.
    for (const name of provided) {
      expect(REQUIRED_BINDINGS as readonly string[]).toContain(name);
    }
  });

  test("the base config and required roster are the same exact binding set", async () => {
    const { names: provided } = await configuredBindings();

    // This includes the absence of HERALD_ROOMS: topology defers it uniformly
    // until an exported W7 Durable Object class exists.
    expect([...provided].sort()).toEqual([...REQUIRED_BINDINGS].sort());
    expect(provided).not.toContain("HERALD_ROOMS");
  });

  test("the base config keeps private CAS and public artifact delivery separate", async () => {
    const { r2Buckets } = await configuredBindings();

    expect(r2Buckets).toEqual([
      { binding: "ARTIFACTS", bucketName: "asimposium-artifacts-local" },
      { binding: "PUBLIC_ARTIFACTS", bucketName: "asimposium-public-local" },
    ]);
    expect(r2Buckets[0]?.bucketName).not.toBe(r2Buckets[1]?.bucketName);
  });
});
