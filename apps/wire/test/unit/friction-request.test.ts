import { test } from "bun:test";
import assert from "node:assert/strict";
import type { EvidenceRequest } from "@asimposium/contracts";
import {
  FRICTION_REQUEST_MAX_BYTES,
  FrictionRequestError,
  prepareFrictionEvidenceRequest,
} from "../../src/sessions/friction-request.ts";

// These exercise the actual request adapter. The serializer is a named fixture;
// actual Zod shape validation is covered by the separate contract tests.
const evidence = {
  bears_on_kind: "claim",
  bears_on_id: "C-2",
  bears_on_version: 4,
  direction: "informs",
  kind: "formalization-friction",
  source: { kind: "model_memory" },
  mode: "exploratory",
  body_md: "a serialized deliberate work product",
} as EvidenceRequest;
const encode = (value: unknown) => {
  assert.deepEqual(value, { work: "fixture" });
  return evidence;
};
const bytes = new TextEncoder().encode(JSON.stringify({ work: "fixture" }));
function request(
  url = "https://a-staging.asimposium.org/v1/sessions/SS-example/friction",
  headers: Record<string, string | undefined> = {},
) {
  const filteredHeaders: Record<string, string> = {
    authorization: "Bearer test-credential",
    "idempotency-key": "owned-key",
    "content-type": "application/json",
    "content-length": "999",
  };
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) filteredHeaders[k] = v;
  }
  return new Request(url, { method: "POST", headers: filteredHeaders });
}

test("forwarding retains session, credential, replay key and deployment origin", async () => {
  const source = request();
  const next = prepareFrictionEvidenceRequest(source, bytes, encode);
  assert.equal(next.url, "https://a-staging.asimposium.org/v1/sessions/SS-example/evidence");
  assert.equal(next.headers.get("authorization"), "Bearer test-credential");
  assert.equal(next.headers.get("idempotency-key"), "owned-key");
  assert.equal(next.headers.get("content-length"), null);
  assert.deepEqual(await next.json(), evidence);
  assert.equal(source.headers.get("content-length"), "999");
});

for (const suffix of ["?target=C-99", "?role=steward", "?x=1&x=2", "#fragment"]) {
  test(`query/fragment cannot carry hidden authority: ${suffix}`, () => {
    assert.throws(
      () =>
        prepareFrictionEvidenceRequest(
          request(`https://a.asimposium.org/v1/sessions/SS-example/friction${suffix}`),
          bytes,
          encode,
        ),
      FrictionRequestError,
    );
  });
}

for (const headers of [
  { "idempotency-key": "" },
  { "idempotency-key": "a b" },
  { "idempotency-key": "a".repeat(161) },
  { "content-type": "text/plain" },
  { "content-type": "application/jsonp" },
  { "content-encoding": "gzip" },
]) {
  test(`invalid request metadata is rejected: ${JSON.stringify(headers)}`, () => {
    assert.throws(
      () => prepareFrictionEvidenceRequest(request(undefined, headers), bytes, encode),
      FrictionRequestError,
    );
  });
}

test("malformed JSON, invalid UTF-8 and oversized requests never reach serialization", () => {
  let calls = 0;
  for (const body of [
    new TextEncoder().encode("{"),
    new Uint8Array([0xff]),
    new Uint8Array(FRICTION_REQUEST_MAX_BYTES + 1),
  ])
    assert.throws(
      () =>
        prepareFrictionEvidenceRequest(request(), body, () => {
          calls++;
          return evidence;
        }),
      FrictionRequestError,
    );
  assert.equal(calls, 0);
});

test("schema errors expose only a fixed refusal and never echo submitted private values", () => {
  assert.throws(
    () =>
      prepareFrictionEvidenceRequest(request(), bytes, () => {
        throw new Error("PRIVATE-BODY");
      }),
    (error) => error instanceof FrictionRequestError && !error.message.includes("PRIVATE"),
  );
});

test("forwarding cannot select another verb or route", () => {
  for (const source of [
    new Request(request().url),
    request("https://a.asimposium.org/v1/sponsors/friction"),
    request("https://a.asimposium.org/v1/sessions/SS-x/promote"),
    request("https://a.asimposium.org/v1/sessions/SS-x/friction/extra"),
  ])
    assert.throws(
      () => prepareFrictionEvidenceRequest(source, bytes, encode),
      FrictionRequestError,
    );
});

test("caller cancellation and identity encoding survive the local forwarding boundary", () => {
  const abort = new AbortController();
  const source = new Request(request(undefined, { "content-encoding": "identity" }), {
    signal: abort.signal,
  });
  const next = prepareFrictionEvidenceRequest(source, bytes, encode);
  abort.abort();
  assert.equal(next.signal.aborted, true);
  assert.equal(next.headers.get("content-encoding"), null);
});
