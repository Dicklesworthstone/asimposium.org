import { describe, expect, test } from "bun:test";
import {
  canonicalReadinessReceipt,
  MAX_READINESS_RECEIPT_BYTES,
  ReadinessStatusSchema,
} from "@asimposium/contracts";
import { sha256Hex } from "@asimposium/protocol";
import { readinessFixture } from "../../../../packages/contracts/test/fixtures/readiness.ts";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";
import { loadReadiness, readinessReceiptKey } from "../../src/readiness.ts";

const now = Date.parse("2026-11-07T00:00:00.000Z");
const fixture = readinessFixture(now);

/** Storage doubles exercise verification policy only; these are not real-R2 qualification. */
function environmentFor(body: string, size = new TextEncoder().encode(body).byteLength): Env {
  return {
    STOA_ORIGIN: fixture.origin,
    ASIMPOSIUM_SOURCE_REVISION: fixture.revision,
    ASIMPOSIUM_READINESS_RECEIPT_SHA256: sha256Hex(body),
    ARTIFACTS: {
      get: async (key: string) => {
        expect(key).toBe(readinessReceiptKey(sha256Hex(body)));
        return { size, body: new Response(body).body };
      },
    },
  } as unknown as Env;
}

describe("Stoa readiness receipt consumer", () => {
  test("serves only the complete, canonical, digest-pinned receipt", async () => {
    const body = canonicalReadinessReceipt(fixture);
    const status = await loadReadiness(environmentFor(body), () => now);
    expect(status).toEqual({
      schema: fixture.schema,
      status: "ready",
      receipt_sha256: sha256Hex(body),
      receipt: fixture,
    });
    expect(ReadinessStatusSchema.safeParse(status).success).toBe(true);
  });

  test("missing configuration never reads storage or manufactures evidence", async () => {
    const env = environmentFor(canonicalReadinessReceipt(fixture));
    env.ARTIFACTS = {
      get: () => {
        throw new Error("must not read");
      },
    } as never;
    expect(await loadReadiness({ ...env, STOA_ORIGIN: "http://127.0.0.1:8787" })).toMatchObject({
      status: "unavailable",
      reason: "origin_unavailable",
    });
    expect(await loadReadiness({ ...env, ASIMPOSIUM_SOURCE_REVISION: undefined })).toMatchObject({
      status: "unavailable",
      reason: "revision_unavailable",
    });
    expect(
      await loadReadiness({ ...env, ASIMPOSIUM_READINESS_RECEIPT_SHA256: undefined }),
    ).toMatchObject({
      status: "unavailable",
      reason: "receipt_unconfigured",
    });
    expect(
      await loadReadiness({ ...env, ASIMPOSIUM_READINESS_RECEIPT_SHA256: "../../private" }),
    ).toMatchObject({
      status: "unavailable",
      reason: "receipt_configuration_invalid",
    });
  });

  test("rejects noncanonical bytes, duplicate JSON keys, malformed/private payloads, and size lies", async () => {
    const canonical = canonicalReadinessReceipt(fixture);
    for (const body of [
      JSON.stringify(fixture, null, 2),
      `\ufeff${canonical}`,
      canonical.replace('"mode":"mock_free"', '"mode":"fixture","mode":"mock_free"'),
      JSON.stringify({ ...fixture, secret: "private-value" }),
      JSON.stringify({ ...fixture, proofs: [] }),
      "not JSON",
    ]) {
      const status = await loadReadiness(environmentFor(body), () => now);
      expect(status).toMatchObject({ status: "unavailable", reason: "invalid_evidence" });
      expect(JSON.stringify(status)).not.toContain("private-value");
    }
    expect(
      await loadReadiness(environmentFor(canonical, MAX_READINESS_RECEIPT_BYTES + 1), () => now),
    ).toMatchObject({ status: "unavailable", reason: "receipt_oversize" });
    expect(
      await loadReadiness(
        environmentFor("x".repeat(MAX_READINESS_RECEIPT_BYTES + 1), 1),
        () => now,
      ),
    ).toMatchObject({ status: "unavailable", reason: "receipt_oversize" });
  });

  test("refuses wrong digests, stale/mixed evidence, storage absence, and provider failures", async () => {
    const body = canonicalReadinessReceipt(fixture);
    const env = environmentFor(body);
    env.ARTIFACTS = {
      get: async () => ({ size: body.length, body: new Response(body).body }),
    } as never;
    expect(
      await loadReadiness(
        { ...env, ASIMPOSIUM_READINESS_RECEIPT_SHA256: "b".repeat(64) },
        () => now,
      ),
    ).toMatchObject({ status: "unavailable", reason: "receipt_digest_mismatch" });
    const bomBody = `\ufeff${body}`;
    expect(
      await loadReadiness(
        {
          ...env,
          ARTIFACTS: {
            get: async () => ({
              size: new TextEncoder().encode(bomBody).length,
              body: new Response(bomBody).body,
            }),
          } as never,
        },
        () => now,
      ),
    ).toMatchObject({ status: "unavailable", reason: "receipt_digest_mismatch" });
    expect(await loadReadiness(env, () => now + 60_000)).toMatchObject({
      status: "unavailable",
      reason: "expired_evidence",
    });
    expect(await loadReadiness(env, () => now - 2_000)).toMatchObject({
      status: "unavailable",
      reason: "future_evidence",
    });
    const mixed = structuredClone(fixture);
    mixed.proofs[2].revision = "c".repeat(40);
    expect(
      await loadReadiness(environmentFor(canonicalReadinessReceipt(mixed)), () => now),
    ).toMatchObject({ status: "unavailable", reason: "mixed_evidence" });
    env.ARTIFACTS = { get: async () => null } as never;
    expect(await loadReadiness(env, () => now)).toMatchObject({
      status: "unavailable",
      reason: "receipt_unavailable",
    });
    env.ARTIFACTS = {
      get: async () => {
        throw new Error("private-provider-diagnostic");
      },
    } as never;
    const unavailable = await loadReadiness(env, () => now);
    expect(unavailable).toMatchObject({ status: "unavailable", reason: "receipt_unavailable" });
    expect(JSON.stringify(unavailable)).not.toContain("private-provider-diagnostic");
  });

  test("existing capabilities embeds evidence, changes its ETag, and bounds HTTP cache lifetime", async () => {
    const liveFixture = readinessFixture(Date.now());
    const body = canonicalReadinessReceipt(liveFixture);
    const env = environmentFor(body);
    const app = createApp();
    const request = (headers?: Record<string, string>) =>
      app.fetch(new Request(`${fixture.origin}/capabilities`, { headers }), env);
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=15, must-revalidate",
    );
    const value = (await response.json()) as { readiness: unknown };
    expect(value.readiness).toEqual({
      schema: fixture.schema,
      status: "ready",
      receipt_sha256: sha256Hex(body),
      receipt: liveFixture,
    });
    const etag = response.headers.get("etag") ?? "missing";
    expect((await request({ "if-none-match": etag })).status).toBe(304);
    env.ASIMPOSIUM_READINESS_RECEIPT_SHA256 = undefined;
    const changed = await request({ "if-none-match": etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect(((await changed.json()) as { readiness: unknown }).readiness).toMatchObject({
      status: "unavailable",
      reason: "receipt_unconfigured",
    });
  });
});
