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

/** The expected validator, computed here independently of the handler. */
async function expectedEtag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `"sha256:${hex}"`;
}

const etagOf = async (path: string): Promise<string> =>
  (await call(path)).headers.get("etag") as string;

describe("face negotiation", () => {
  test("serves each face with its own media type and a SHA-256 ETag over its own bytes", async () => {
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
      // The validator is a digest of the representation, not of the projection.
      expect(response.headers.get("etag")).toBe(await expectedEtag(local.body));
      expect(response.headers.get("etag")).toMatch(/^"sha256:[0-9a-f]{64}"$/);
      // The projection fingerprint is still served, in its own header, where a client that
      // wants "same state?" rather than "same bytes?" reads it.
      expect(response.headers.get("x-asimp-fingerprint")).toBe(local.fingerprint);
      expect(response.headers.get("etag")).not.toContain(local.fingerprint);
    }
  });

  test("the three faces of one projection share a fingerprint but never a validator", async () => {
    const [md, json, html] = await Promise.all([
      call("/__s5/face?variant=public&format=md"),
      call("/__s5/face?variant=public&format=json"),
      call("/__s5/face?variant=public&format=html-fragment"),
    ]);
    const fingerprints = [md, json, html].map((r) => r.headers.get("x-asimp-fingerprint"));
    const etags = [md, json, html].map((r) => r.headers.get("etag"));
    expect(new Set(fingerprints).size).toBe(1);
    expect(new Set(etags).size).toBe(3);
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
    const etag = await etagOf("/__s5/face");
    const response = await call("/__s5/face", { headers: { "if-none-match": etag } });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(etag);
  });

  test("a stale validator still gets the body", async () => {
    const response = await call("/__s5/face", {
      headers: { "if-none-match": `"sha256:${"0".repeat(64)}"` },
    });
    expect(response.status).toBe(200);
    expect((await response.text()).length).toBeGreaterThan(0);
  });

  test("a validator list containing the current tag matches", async () => {
    const etag = await etagOf("/__s5/face");
    const response = await call("/__s5/face", {
      headers: { "if-none-match": `"sha256:${"0".repeat(64)}", ${etag}` },
    });
    expect(response.status).toBe(304);
  });

  test("a weak validator for the same representation matches (RFC 9110 §13.1.2)", async () => {
    const etag = await etagOf("/__s5/face");
    const response = await call("/__s5/face", { headers: { "if-none-match": `W/${etag}` } });
    expect(response.status).toBe(304);
  });

  test("`*` matches whenever a representation exists", async () => {
    const response = await call("/__s5/face", { headers: { "if-none-match": "*" } });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
  });

  test("one face's validator can never satisfy another face", async () => {
    // The defect this replaces: every face of a projection shared one strong ETag, so a
    // client holding markdown was told its JSON copy was fresh, with no body to correct it.
    const mdEtag = await etagOf("/__s5/face?variant=public&format=md");
    for (const other of ["json", "html-fragment"]) {
      const response = await call(`/__s5/face?variant=public&format=${other}`, {
        headers: { "if-none-match": mdEtag },
      });
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(0);
    }
  });

  test("one variant's validator can never satisfy the other variant", async () => {
    const publicEtag = await etagOf("/__s5/face?variant=public&format=md");
    const response = await call("/__s5/face?variant=sponsor&format=md", {
      headers: { "if-none-match": publicEtag },
    });
    expect(response.status).toBe(200);
  });
});

describe("HEAD parity", () => {
  test("HEAD carries the GET headers with no body", async () => {
    for (const format of ["md", "json", "html-fragment"]) {
      const path = `/__s5/face?variant=public&format=${format}`;
      const get = await call(path);
      const head = await call(path, { method: "HEAD" });
      const body = await get.text();
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.get("etag")).toBe(get.headers.get("etag"));
      expect(head.headers.get("etag")).toBe(await expectedEtag(body));
      expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
      expect(head.headers.get("x-asimp-fingerprint")).toBe(get.headers.get("x-asimp-fingerprint"));
    }
  });

  test("a conditional HEAD is a bodiless 304 like a conditional GET", async () => {
    const etag = await etagOf("/__s5/face");
    const response = await call("/__s5/face", {
      method: "HEAD",
      headers: { "if-none-match": etag },
    });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
  });
});

describe("teaching refusals are not sniffable", () => {
  test("every refusal carries nosniff alongside problem+json", async () => {
    for (const path of ["/__s5/face?format=toon", "/__s5/face?variant=everything", "/nope"]) {
      const response = await call(path);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  test("a served face carries nosniff too", async () => {
    const response = await call("/__s5/face?format=html-fragment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
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
