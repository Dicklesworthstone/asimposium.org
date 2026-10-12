import { test } from "bun:test";
import assert from "node:assert/strict";
import type { EventBatchRequest } from "@asimposium/contracts";
import {
  DISCRIMINATION_BATCH_MAX_BYTES,
  DISCRIMINATION_REQUEST_MAX_BYTES,
} from "@asimposium/contracts/discrimination-model";
import {
  DiscriminationRequestError,
  prepareDiscriminationBatchRequest,
} from "../../src/sessions/discrimination-request.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const body = bytes('{"work":"actual observation"}');
function request(path = "/v1/p/P-TEST/discrimination", headers: Record<string, string> = {}, method = "POST") {
  return new Request(`https://a.asimposium.org${path}`, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": "same-experiment-1", authorization: "Bearer synthetic-test-token", ...headers },
  });
}
const batch = { members: [{ tempId: "tmp:discriminate-H-1", action: "evidence", causedBy: [], data: { body_md: "observed result" } }] } as EventBatchRequest;
const encode = () => batch;

test("forwarding preserves origin, bearer, caller key and exact encoder output", async () => {
  let calls = 0;
  const forwarded = prepareDiscriminationBatchRequest(request(), body, (input, problemId) => {
    calls += 1;
    assert.deepEqual(input, { work: "actual observation" });
    assert.equal(problemId, "P-TEST");
    return batch;
  });
  assert.equal(calls, 1);
  assert.equal(forwarded.url, "https://a.asimposium.org/v1/p/P-TEST/events:batch");
  assert.equal(forwarded.method, "POST");
  assert.equal(forwarded.headers.get("authorization"), "Bearer synthetic-test-token");
  assert.equal(forwarded.headers.get("idempotency-key"), "same-experiment-1");
  assert.deepEqual(await forwarded.json(), batch);
});

test("request-local delegation preserves a preview origin rather than contacting production", () => {
  const r = new Request("https://preview.example/v1/p/P-TEST/discrimination", { method: "POST", headers: request().headers });
  assert.equal(new URL(prepareDiscriminationBatchRequest(r, body, encode).url).origin, "https://preview.example");
});

test("content metadata is recalculated after expansion", () => {
  const r = request(undefined, { "content-length": "2", "content-encoding": "identity", "transfer-encoding": "chunked", "x-request-id": "trace-1" });
  const forwarded = prepareDiscriminationBatchRequest(r, body, encode);
  assert.equal(forwarded.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(forwarded.headers.get("content-length"), null);
  assert.equal(forwarded.headers.get("content-encoding"), null);
  assert.equal(forwarded.headers.get("transfer-encoding"), null);
  assert.equal(forwarded.headers.get("x-request-id"), "trace-1");
});

test("cancellation propagates to the delegated write", () => {
  const controller = new AbortController();
  const r = new Request(request(), { signal: controller.signal });
  const forwarded = prepareDiscriminationBatchRequest(r, body, encode);
  controller.abort();
  assert.equal(forwarded.signal.aborted, true);
});

for (const method of ["GET", "PUT", "DELETE", "HEAD"]) {
  test(`does not delegate ${method}`, () => {
    assert.throws(() => prepareDiscriminationBatchRequest(request(undefined, {}, method), body, encode), DiscriminationRequestError);
  });
}
for (const path of [
  "/v1/p/P-TEST/discrimination?through=1", "/v1/p/P-TEST/discrimination#secret",
  "/v1/p/P-TEST/evidence", "/v1/p/P-TEST/discrimination/extra", "/v1/p//discrimination",
  "/v1/p/P-TEST%2fOTHER/discrimination", "/v1/p/P-TEST%5cOTHER/discrimination",
  "/v1/p/P-TEST%3fprivate/discrimination", "/v1/p/P-TEST%23hidden/discrimination",
  "/v1/p/P-%00TEST/discrimination", "/v1/p/P-%0aTEST/discrimination", "/v1/p/%ZZ/discrimination",
]) {
  test(`rejects unsafe or changed route ${path}`, () => {
    let called = false;
    assert.throws(() => prepareDiscriminationBatchRequest(request(path), body, () => { called = true; return batch; }), DiscriminationRequestError);
    assert.equal(called, false);
  });
}

test("the canonical encoder owns the retained problem identifier grammar", () => {
  let seen = "";
  prepareDiscriminationBatchRequest(request("/v1/p/P-legacy-long-problem-slug-012345678901234567890/discrimination"), body, (_input, id) => { seen = id; return batch; });
  assert.equal(seen, "P-legacy-long-problem-slug-012345678901234567890");
});

for (const type of ["text/plain", "application/jsonp", "application/octet-stream", ""]) {
  test(`rejects incorrect media type ${type}`, () => {
    assert.throws(() => prepareDiscriminationBatchRequest(request(undefined, { "content-type": type }), body, encode), DiscriminationRequestError);
  });
}

test("JSON with charset parameters is accepted", () => {
  assert.doesNotThrow(() => prepareDiscriminationBatchRequest(request(undefined, { "content-type": "application/json; charset=utf-8" }), body, encode));
});
for (const encoding of ["gzip", "br", "deflate"]) {
  test(`compressed ${encoding} input cannot bypass the bound`, () => {
    assert.throws(() => prepareDiscriminationBatchRequest(request(undefined, { "content-encoding": encoding }), body, encode), DiscriminationRequestError);
  });
}
for (const key of ["", "a b", "key/other", "x".repeat(161)]) {
  test(`rejects invalid idempotency key of length ${key.length}`, () => {
    assert.throws(() => prepareDiscriminationBatchRequest(request(undefined, { "idempotency-key": key }), body, encode), DiscriminationRequestError);
  });
}

test("a missing bearer remains missing so the ordinary writer refuses it", () => {
  const r = request();
  r.headers.delete("authorization");
  assert.equal(prepareDiscriminationBatchRequest(r, body, encode).headers.get("authorization"), null);
});
for (const value of ["", "{", "{\"a\":undefined}"]) {
  test(`malformed JSON never reaches the encoder: ${JSON.stringify(value)}`, () => {
    let calls = 0;
    assert.throws(() => prepareDiscriminationBatchRequest(request(), bytes(value), () => { calls += 1; return batch; }), DiscriminationRequestError);
    assert.equal(calls, 0);
  });
}

test("invalid UTF-8 is not repaired into a different scientific observation", () => {
  assert.throws(() => prepareDiscriminationBatchRequest(request(), new Uint8Array([0x7b, 0xff, 0x7d]), encode), DiscriminationRequestError);
});

test("input byte boundary is enforced before JSON parse or schema work", () => {
  const exact = bytes(`"${"x".repeat(DISCRIMINATION_REQUEST_MAX_BYTES - 2)}"`);
  assert.equal(exact.byteLength, DISCRIMINATION_REQUEST_MAX_BYTES);
  assert.doesNotThrow(() => prepareDiscriminationBatchRequest(request(), exact, encode));
  assert.throws(() => prepareDiscriminationBatchRequest(request(), bytes(`${new TextDecoder().decode(exact)} `), encode), DiscriminationRequestError);
});

test("multibyte input is bounded in bytes, not character count", () => {
  assert.throws(() => prepareDiscriminationBatchRequest(request(), bytes(`"${"界".repeat(12000)}"`), encode), DiscriminationRequestError);
});

test("expanded batch bound protects against target fan-out amplification", () => {
  // Compute the boundary from actual encoding, not an assumed wrapper size.
  const seed = JSON.stringify({ members: [], padding: "" }).length;
  const at = { members: [], padding: "x".repeat(DISCRIMINATION_BATCH_MAX_BYTES - seed) } as unknown as EventBatchRequest;
  assert.equal(bytes(JSON.stringify(at)).byteLength, DISCRIMINATION_BATCH_MAX_BYTES);
  assert.doesNotThrow(() => prepareDiscriminationBatchRequest(request(), body, () => at));
  assert.throws(() => prepareDiscriminationBatchRequest(request(), body, () => ({ ...at, more: "x" }) as EventBatchRequest), DiscriminationRequestError);
});

test("schema failures do not expose the rejected scientific body", () => {
  assert.throws(() => prepareDiscriminationBatchRequest(request(), body, () => { throw new Error("PRIVATE-CANARY"); }), (error: unknown) => {
    assert.ok(error instanceof DiscriminationRequestError);
    assert.equal(error.message, "DISCRIMINATION_REQUEST_INVALID");
    assert.equal(error.message.includes("PRIVATE-CANARY"), false);
    return true;
  });
});

test("identical retries keep both the body and batch namespace unchanged", async () => {
  const a = prepareDiscriminationBatchRequest(request(), body, encode);
  const b = prepareDiscriminationBatchRequest(request(), body, encode);
  assert.equal(a.url, b.url);
  assert.equal(a.headers.get("idempotency-key"), b.headers.get("idempotency-key"));
  assert.equal(await a.text(), await b.text());
});
