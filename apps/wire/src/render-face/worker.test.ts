/**
 * Focused tests for the S-5 face harness handler (bead asimposiumorg-6jo).
 *
 * These call the handler directly, which is fast and catches contract mistakes early. They
 * are not a substitute for the served proof: `scripts/e2e-s5-diptych.sh` runs this same
 * entrypoint under real workerd and compares served bytes to a local render, because a
 * handler that behaves in-process can still be mis-served by the runtime.
 */

import { describe, expect, test } from "bun:test";
import { MEDIA_TYPES, renderProjection, s5Canary, s5SpikeProjection } from "@asimposium/render";
import harness from "./worker.ts";

const call = (path: string, init?: RequestInit): Promise<Response> =>
  harness.fetch(new Request(`http://127.0.0.1${path}`, init));

describe("face negotiation", () => {
  test("serves each face with its own media type and the projection's fingerprint as ETag", async () => {
    for (const [format, alias] of [
      ["md", "md"],
      ["json", "json"],
      ["html-fragment", "html"],
    ] as const) {
      const response = await call(`/__s5/face?variant=public&format=${alias}`);
      const local = renderProjection(s5SpikeProjection("public"), format);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(local.body);
      expect(response.headers.get("content-type")).toBe(MEDIA_TYPES[format]);
      expect(response.headers.get("etag")).toBe(`"${local.fingerprint}"`);
    }
  });

  test("defaults to the canonical agent face", async () => {
    const response = await call("/__s5/face");
    expect(response.headers.get("content-type")).toBe(MEDIA_TYPES.md);
    expect(response.headers.get("x-asimp-face")).toBe("md");
  });

  test("an unknown format teaches instead of guessing", async () => {
    const response = await call("/__s5/face?format=toon");
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(400);
    expect(body.code).toBe("UNKNOWN_FORMAT");
    expect(body.allowed).toEqual(["md", "json", "html-fragment"]);
    expect(String(body.fix_hint)).toContain("md");
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  test("an unknown variant is refused with its allowed set", async () => {
    const response = await call("/__s5/face?variant=everything");
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(400);
    expect(body.code).toBe("UNKNOWN_VARIANT");
    expect(body.allowed).toEqual(["public", "sponsor"]);
  });
});

describe("conditional requests", () => {
  test("a matching validator yields a bodiless 304 that keeps the ETag", async () => {
    const local = renderProjection(s5SpikeProjection("public"), "md");
    const response = await call("/__s5/face", {
      headers: { "if-none-match": `"${local.fingerprint}"` },
    });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(`"${local.fingerprint}"`);
  });

  test("a stale validator still gets the body", async () => {
    const response = await call("/__s5/face", {
      headers: { "if-none-match": '"fnv1a64:0000000000000000"' },
    });
    expect(response.status).toBe(200);
    expect((await response.text()).length).toBeGreaterThan(0);
  });

  test("a validator list containing the current tag matches", async () => {
    const local = renderProjection(s5SpikeProjection("public"), "md");
    const response = await call("/__s5/face", {
      headers: { "if-none-match": `"fnv1a64:0000000000000000", "${local.fingerprint}"` },
    });
    expect(response.status).toBe(304);
  });
});

describe("the harness is a harness, not a product surface", () => {
  test("it serves no product face route", async () => {
    expect((await call("/p/demo-bounded-sums.md")).status).toBe(404);
    expect((await call("/v1/hello")).status).toBe(404);
  });

  test("it refuses writes", async () => {
    expect((await call("/__s5/face", { method: "POST" })).status).toBe(400);
  });

  test("a public face carries no workshop byte and no workshop id", async () => {
    const body = await (await call("/__s5/face?variant=public&format=json")).text();
    expect(body).not.toContain(s5Canary());
    expect(body).not.toContain("W-demo-fellow-03");
  });

  test("the sponsor face does carry it, so the check above is not vacuous", async () => {
    const body = await (await call("/__s5/face?variant=sponsor&format=json")).text();
    expect(body).toContain(s5Canary());
  });
});
