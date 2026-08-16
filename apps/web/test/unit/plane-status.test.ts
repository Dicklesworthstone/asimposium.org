import { describe, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN, STAGING_STOA_ORIGIN } from "@asimposium/contracts";

import type { PlaneStatusFetch } from "../../lib/plane-status.ts";
import { sha256Hex } from "../../lib/service-envelope.ts";

mock.module("server-only", () => ({}));

const {
  ARTIFACT_CANARY_BODY,
  ARTIFACT_CANARY_MAX_BYTES,
  ARTIFACT_CANARY_SHA256,
  PLANE_STATUS_CACHE_TTL_MS,
  PLANE_STATUS_PUBLIC_MAX_AGE_SECONDS,
  artifactOriginForStoaOrigin,
  consolePlaneStatusRows,
  createPlaneStatusCache,
  planeStatusFreshnessCopy,
  probeArtifactCanary,
  resolvePlaneStatus,
} = await import("../../lib/plane-status.ts");

const PRODUCTION_ARTIFACTS = "https://artifacts.asimposium.org";
const STAGING_ARTIFACTS = "https://artifacts-staging.asimposium.org";

function healthyStoaFetch(calls: string[]): PlaneStatusFetch {
  return async (input, init) => {
    const url = String(input);
    calls.push(url);
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (url.endsWith("/internal/health") || url.endsWith("/capabilities")) {
      return new Response("{}", { status: 200 });
    }
    if (url.endsWith("/problems.json")) {
      return Response.json({ problems: [], omitted: [] });
    }
    throw new Error(`unexpected status probe ${url}`);
  };
}

function chunkedBody(...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("environment-bound plane status", () => {
  test("selects only the artifact origin paired with production, staging, or local Stoa", () => {
    expect(artifactOriginForStoaOrigin(PRODUCTION_STOA_ORIGIN)).toBe(PRODUCTION_ARTIFACTS);
    expect(artifactOriginForStoaOrigin(STAGING_STOA_ORIGIN)).toBe(STAGING_ARTIFACTS);
    // Local public delivery intentionally has no custom domain.
    expect(artifactOriginForStoaOrigin("http://127.0.0.1:8787")).toBeUndefined();
    expect(artifactOriginForStoaOrigin("https://artifacts.attacker.invalid")).toBeUndefined();
  });

  test("PLANTED: prototype-key Stoa origins select no artifact target and fetch nothing", async () => {
    for (const stoaOrigin of ["__proto__", "constructor", "toString"]) {
      const calls: string[] = [];
      const artifactOrigin = artifactOriginForStoaOrigin(stoaOrigin);
      expect(artifactOrigin).toBeUndefined();
      await expect(
        probeArtifactCanary({
          artifactOrigin,
          provisioning: "configured",
          fetchImpl: async (input) => {
            calls.push(String(input));
            return new Response(null, { status: 200 });
          },
        }),
      ).resolves.toBe("not_configured");
      expect(calls).toEqual([]);
    }
  });

  test("PLANTED: a foreign STOA_ORIGIN sends no Stoa, ledger, or artifact request", async () => {
    const calls: string[] = [];
    const status = await resolvePlaneStatus({
      environment: {
        STOA_ORIGIN: "https://a.asimposium.org.attacker.invalid",
        ARTIFACT_CANARY_VERSION: "v1",
      },
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(null, { status: 500 });
      },
    });

    expect(calls).toEqual([]);
    expect(status.stoa.origin_configuration).toBe("invalid");
    expect(status.stoa.internal_health_reachability).toBe("not_probed");
    expect(status.ledger.public_index).toBe("not_probed");
    expect(status.artifacts.origin_mapping).toBe("not_configured");
    expect(status.artifacts.canary).toBe("not_configured");
  });

  test("verifies only the fixed public canary bytes and bounds every body", async () => {
    expect(await sha256Hex(new TextEncoder().encode(ARTIFACT_CANARY_BODY))).toBe(
      ARTIFACT_CANARY_SHA256,
    );

    let calls = 0;
    const notProvisioned = await probeArtifactCanary({
      artifactOrigin: PRODUCTION_ARTIFACTS,
      provisioning: "missing",
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 200 });
      },
    });
    expect(notProvisioned).toBe("not_provisioned");
    expect(calls).toBe(0);

    const wrongOrigin = await probeArtifactCanary({
      artifactOrigin: "https://artifacts.attacker.invalid",
      provisioning: "configured",
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 200 });
      },
    });
    expect(wrongOrigin).toBe("not_configured");
    expect(calls).toBe(0);

    const exactCanary = async (response: Response) => {
      const destinations: string[] = [];
      const status = await probeArtifactCanary({
        artifactOrigin: PRODUCTION_ARTIFACTS,
        provisioning: "configured",
        fetchImpl: async (input, init) => {
          destinations.push(String(input));
          expect(init).toMatchObject({
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
          });
          return response;
        },
      });
      expect(destinations).toEqual([`${PRODUCTION_ARTIFACTS}/sha256/${ARTIFACT_CANARY_SHA256}`]);
      return status;
    };

    expect(await exactCanary(new Response(ARTIFACT_CANARY_BODY, { status: 200 }))).toBe("verified");
    expect(await exactCanary(new Response("not the canary", { status: 200 }))).toBe("wrong_bytes");
    expect(await exactCanary(new Response("missing", { status: 404 }))).toBe("wrong_status");
    expect(
      await exactCanary(
        new Response(null, {
          headers: { "content-length": String(ARTIFACT_CANARY_MAX_BYTES + 1) },
        }),
      ),
    ).toBe("oversize");
    expect(
      await exactCanary(
        new Response(chunkedBody(new Uint8Array(ARTIFACT_CANARY_MAX_BYTES), new Uint8Array([1]))),
      ),
    ).toBe("oversize");
  });

  test("PLANTED: invalid and declared or chunked oversize public ledger indexes are refused", async () => {
    const cases: readonly [string, Response, string][] = [
      ["invalid", Response.json({ problems: "not-an-array", omitted: [] }), "invalid_response"],
      [
        "declared oversize",
        new Response(null, {
          headers: { "content-length": String(128 * 1024 + 1) },
        }),
        "oversize",
      ],
      [
        "chunked oversize",
        new Response(chunkedBody(new Uint8Array(128 * 1024), new Uint8Array([1]))),
        "oversize",
      ],
    ];

    for (const [, ledgerResponse, expected] of cases) {
      const status = await resolvePlaneStatus({
        environment: { STOA_ORIGIN: PRODUCTION_STOA_ORIGIN },
        fetchImpl: async (input) => {
          if (String(input).endsWith("/problems.json")) return ledgerResponse;
          return new Response(null, { status: 200 });
        },
      });
      expect(status.ledger).toMatchObject({ public_index: expected, public_index_entries: null });
    }
  });

  test(
    "PLANTED: each bounded status probe receives an abort signal and settles as unreachable",
    async () => {
      let aborted = 0;
      const status = await resolvePlaneStatus({
        environment: { STOA_ORIGIN: PRODUCTION_STOA_ORIGIN, ARTIFACT_CANARY_VERSION: "v1" },
        fetchImpl: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init.signal;
            if (signal === null || signal === undefined)
              throw new Error("missing status abort signal");
            signal.addEventListener(
              "abort",
              () => {
                aborted += 1;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      });

      expect(aborted).toBe(4);
      expect(status.stoa).toMatchObject({
        internal_health_reachability: "unreachable",
        capabilities_reachability: "unreachable",
      });
      expect(status.ledger.public_index).toBe("unreachable");
      expect(status.artifacts.canary).toBe("unreachable");
    },
    PLANE_STATUS_CACHE_TTL_MS,
  );

  test("PLANTED: cache construction refuses every non-finite or non-positive TTL", () => {
    for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createPlaneStatusCache({
          ttlMs,
          refresh: async () => resolvePlaneStatus({ environment: {} }),
        }),
      ).toThrow(RangeError);
    }
  });

  test("shares one short-lived refresh, expires it once, and never permanently poisons retry", async () => {
    let now = 100;
    let refreshes = 0;
    const calls: string[] = [];
    const cache = createPlaneStatusCache({
      now: () => now,
      refresh: async () => {
        refreshes += 1;
        return resolvePlaneStatus({
          environment: { STOA_ORIGIN: PRODUCTION_STOA_ORIGIN },
          fetchImpl: healthyStoaFetch(calls),
        });
      },
    });

    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(refreshes).toBe(1);
    expect(calls).toHaveLength(3);

    await cache.get();
    expect(refreshes).toBe(1);
    expect(calls).toHaveLength(3);

    // The injected clock moves backward like a wall clock adjustment. The
    // cache's monotonic wrapper must not turn it into a false expiry.
    now = 50;
    await cache.get();
    expect(refreshes).toBe(1);
    expect(calls).toHaveLength(3);

    now = 100 + PLANE_STATUS_CACHE_TTL_MS;
    await Promise.all([cache.get(), cache.get()]);
    expect(refreshes).toBe(2);
    expect(calls).toHaveLength(6);

    let failedRefreshes = 0;
    const retryingCache = createPlaneStatusCache({
      refresh: async () => {
        failedRefreshes += 1;
        if (failedRefreshes === 1) throw new Error("bounded refresh failure");
        return resolvePlaneStatus({ environment: {} });
      },
    });
    await expect(retryingCache.get()).rejects.toThrow("bounded refresh failure");
    await expect(retryingCache.get()).resolves.toMatchObject({ plane: "agora" });
    expect(failedRefreshes).toBe(2);

    let failingNow = 0;
    let transportAvailable = false;
    let transportCalls = 0;
    const recoveringCache = createPlaneStatusCache({
      now: () => failingNow,
      refresh: () =>
        resolvePlaneStatus({
          environment: { STOA_ORIGIN: PRODUCTION_STOA_ORIGIN },
          fetchImpl: async () => {
            transportCalls += 1;
            if (!transportAvailable) throw new Error("bounded transport failure");
            return new Response(null, { status: 200 });
          },
        }),
    });
    expect((await recoveringCache.get()).stoa.internal_health_reachability).toBe("unreachable");
    expect(transportCalls).toBe(3);
    await recoveringCache.get();
    expect(transportCalls).toBe(3);
    failingNow += PLANE_STATUS_CACHE_TTL_MS;
    transportAvailable = true;
    expect((await recoveringCache.get()).stoa.internal_health_reachability).toBe("reachable");
    expect(transportCalls).toBe(6);
  });

  test("PLANTED: configured status inputs never enter the public machine status or copy", async () => {
    const environment = {
      STOA_ORIGIN: STAGING_STOA_ORIGIN,
      SERVICE_ENVELOPE_PRIVATE_KEY_HEX: "a".repeat(64),
      SERVICE_ENVELOPE_KID: "status-disclosure-kid",
      ENROLLMENT_RECOVERY_HMAC_KEY_HEX: "b".repeat(64),
      ARTIFACT_CANARY_VERSION: "v1",
    } as const;
    const status = await resolvePlaneStatus({
      environment,
      fetchImpl: async () => new Response(null, { status: 503 }),
    });
    const publicText = JSON.stringify({ status, rows: consolePlaneStatusRows(status) });

    for (const value of Object.values(environment)) {
      expect(publicText).not.toContain(value);
    }
    expect(status.freshness).toEqual({
      console_snapshot_max_age_seconds: 15,
      public_response_max_age_seconds: PLANE_STATUS_PUBLIC_MAX_AGE_SECONDS,
    });
    expect(planeStatusFreshnessCopy()).toBe(
      "Checked recently: this snapshot is cached for up to 15 seconds.",
    );
  });

  test("a reachable Stoa is not conflated with missing Agora wiring or a live ledger", async () => {
    const calls: string[] = [];
    const status = await resolvePlaneStatus({
      environment: { STOA_ORIGIN: PRODUCTION_STOA_ORIGIN },
      fetchImpl: healthyStoaFetch(calls),
    });

    expect(calls).toEqual([
      `${PRODUCTION_STOA_ORIGIN}/internal/health`,
      `${PRODUCTION_STOA_ORIGIN}/capabilities`,
      `${PRODUCTION_STOA_ORIGIN}/problems.json`,
    ]);
    expect(status.stoa).toMatchObject({
      origin_configuration: "configured",
      internal_health_reachability: "reachable",
      capabilities_reachability: "reachable",
      sponsor_dispatch_configuration: "missing",
      enrollment_recovery_hmac_configuration: "missing",
      sponsor_enrollment_write_configuration: "not_configured",
    });
    expect(status.ledger).toMatchObject({
      public_index: "reachable_empty",
      public_index_entries: 0,
      research_writes: "not_implemented",
      product_readiness: "not_ready",
    });

    const rows = consolePlaneStatusRows(status);
    expect(rows.find((row) => row.key === "stoa-reachability")?.value).toBe(
      "Internal-health endpoint reachability is reachable; capabilities endpoint reachability is reachable.",
    );
    expect(rows.find((row) => row.key === "agora-stoa-wiring")?.value).toBe(
      "ENROLLMENT_RECOVERY_HMAC_KEY_HEX is missing; recoverable sponsor writes are unavailable.",
    );
    expect(rows.find((row) => row.key === "public-ledger-index")?.value).toBe(
      "Reachable but empty: this proves only the public index contract.",
    );
    expect(rows.find((row) => row.key === "ledger-product-readiness")?.healthy).toBe(false);
  });

  test("PLANTED: configured enrollment plumbing cannot promote an empty public index into research-write readiness", async () => {
    const calls: string[] = [];
    const status = await resolvePlaneStatus({
      environment: {
        STOA_ORIGIN: STAGING_STOA_ORIGIN,
        SERVICE_ENVELOPE_PRIVATE_KEY_HEX: "1".repeat(64),
        SERVICE_ENVELOPE_KID: "status-test",
        ENROLLMENT_RECOVERY_HMAC_KEY_HEX: "2".repeat(64),
      },
      fetchImpl: healthyStoaFetch(calls),
    });

    expect(status.stoa.sponsor_enrollment_write_configuration).toBe("configured");
    expect(status.ledger.public_index).toBe("reachable_empty");
    expect(status.ledger.research_writes).toBe("not_implemented");
    expect(status.ledger.product_readiness).toBe("not_ready");
  });

  test("PLANTED: configured sponsor-write plumbing remains configuration-only when Stoa is unreachable", async () => {
    const status = await resolvePlaneStatus({
      environment: {
        STOA_ORIGIN: STAGING_STOA_ORIGIN,
        SERVICE_ENVELOPE_PRIVATE_KEY_HEX: "1".repeat(64),
        SERVICE_ENVELOPE_KID: "status-test",
        ENROLLMENT_RECOVERY_HMAC_KEY_HEX: "2".repeat(64),
      },
      fetchImpl: async () => {
        throw new Error("transport unavailable");
      },
    });

    expect(status.stoa).toMatchObject({
      internal_health_reachability: "unreachable",
      capabilities_reachability: "unreachable",
      sponsor_enrollment_write_configuration: "configured",
    });
    const rows = consolePlaneStatusRows(status);
    expect(rows.find((row) => row.key === "agora-stoa-wiring")).toMatchObject({
      healthy: false,
      value:
        "Sponsor dispatch is configured and ENROLLMENT_RECOVERY_HMAC_KEY_HEX is configured; sponsor enrollment write configuration is configured.",
    });
  });

  test("copy names a missing configured origin as an Agora wiring gap", async () => {
    const status = await resolvePlaneStatus({ environment: {} });
    const rows = consolePlaneStatusRows(status);

    expect(rows.find((row) => row.key === "stoa-reachability")?.value).toBe(
      "Not probed: this Agora deployment lacks STOA_ORIGIN. This does not say Stoa is down.",
    );
    expect(rows.find((row) => row.key === "agora-stoa-wiring")?.value).toBe(
      "ENROLLMENT_RECOVERY_HMAC_KEY_HEX is missing; recoverable sponsor writes are unavailable.",
    );
    expect(rows.find((row) => row.key === "artifact-canary")?.value).toBe(
      "Not provisioned: no immutable public canary is configured for this environment.",
    );
  });
});
