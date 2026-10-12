import { test } from "bun:test";
import assert from "node:assert/strict";
import { discriminationReceiptLinks, withDiscriminationReadLinks } from "../../src/sessions/discrimination-receipt.ts";
const context = { problemId: "P-TEST", hypotheses: ["H-1", "H-2"] };
function receipt() {
  return { ok: true, problem_id: "P-TEST", results: [
    { tempId: "tmp:discriminate-H-1", action: "evidence", id: "E-ABC", seq: 12 },
    { tempId: "tmp:discriminate-H-2", action: "evidence", id: "E-DEF", seq: 13 },
  ] };
}
function response(value: unknown, status = 201) {
  return new Response(JSON.stringify(value), { status, headers: {
    "content-type": "application/json", "cache-control": "private, no-store", "x-writer": "canonical",
    link: '</protocol.md>; rel="help"',
  } });
}
test("complete receipt links each target to its actual returned evidence", () => {
  assert.deepEqual(discriminationReceiptLinks(receipt(), context), [
    '</p/P-TEST/evidence/E-ABC.json>; rel="item"; type="application/json"; title="Evidence for H-1"',
    '</p/P-TEST/evidence/E-DEF.json>; rel="item"; type="application/json"; title="Evidence for H-2"',
  ]);
});
test("topological receipt order is mapped back to target order", () => {
  const value = receipt(); value.results.reverse();
  assert.deepEqual(discriminationReceiptLinks(value, context), discriminationReceiptLinks(receipt(), context));
});
for (const status of [200, 201]) {
  test(`fresh/replayed ${status} keeps exact body and existing headers`, async () => {
    const original = response(receipt(), status);
    const linked = await withDiscriminationReadLinks(original, context);
    assert.equal(linked.status, status);
    assert.equal(linked.headers.get("cache-control"), "private, no-store");
    assert.equal(linked.headers.get("x-writer"), "canonical");
    assert.match(linked.headers.get("link")!, /rel="help"/);
    assert.match(linked.headers.get("link")!, /rel="describedby"/);
    assert.match(linked.headers.get("link")!, /E-ABC.json/);
    assert.match(linked.headers.get("link")!, /E-DEF.json/);
    assert.equal(await linked.text(), JSON.stringify(receipt()));
  });
}
for (const status of [400, 401, 403, 409, 422, 429, 500, 503]) {
  test(`never turns writer refusal ${status} into successful evidence links`, async () => {
    const original = response(receipt(), status);
    assert.equal(await withDiscriminationReadLinks(original, context), original);
  });
}
for (const [name, alter] of [
  ["wrong problem", (v: any) => { v.problem_id = "P-OTHER"; }],
  ["missing member", (v: any) => { v.results.pop(); }],
  ["extra member", (v: any) => { v.results.push(v.results[0]); }],
  ["wrong action", (v: any) => { v.results[0].action = "claim"; }],
  ["wrong temporary target", (v: any) => { v.results[0].tempId = "tmp:discriminate-H-9"; }],
  ["duplicate target", (v: any) => { v.results[1].tempId = v.results[0].tempId; }],
  ["duplicate evidence", (v: any) => { v.results[1].id = v.results[0].id; }],
  ["duplicate sequence", (v: any) => { v.results[1].seq = v.results[0].seq; }],
  ["unsafe sequence", (v: any) => { v.results[0].seq = Number.MAX_SAFE_INTEGER + 1; }],
  ["zero sequence", (v: any) => { v.results[0].seq = 0; }],
  ["fractional sequence", (v: any) => { v.results[0].seq = 1.5; }],
  ["unexpected version", (v: any) => { v.results[0].version = 2; }],
  ["unsafe ID", (v: any) => { v.results[0].id = 'E-X>; rel="hijack"'; }],
  ["newline ID", (v: any) => { v.results[0].id += "\n"; }],
  ["not successful", (v: any) => { v.ok = false; }],
] as const) {
  test(`withholds all navigation for ${name}`, async () => {
    const value = receipt(); alter(value);
    assert.deepEqual(discriminationReceiptLinks(value, context), []);
    const original = response(value);
    assert.equal(await withDiscriminationReadLinks(original, context), original);
    assert.equal(await original.text(), JSON.stringify(value));
  });
}
test("explicit immutable evidence version one is accepted", () => {
  const value: any = receipt(); value.results.forEach((r: any) => { r.version = 1; });
  assert.equal(discriminationReceiptLinks(value, context).length, 2);
});
test("malformed expected context cannot create links", () => {
  for (const hypotheses of [[], ["H-1"], ["H-1", "H-1"], ["H-1", "H-2\n"], Array(9).fill("H-1")]) {
    assert.deepEqual(discriminationReceiptLinks(receipt(), { ...context, hypotheses }), []);
  }
  for (const problemId of ["", "P-TEST/OTHER", "P-TEST\n", "P-X?key=1"]) {
    assert.deepEqual(discriminationReceiptLinks({ ...receipt(), problem_id: problemId }, { ...context, problemId }), []);
  }
});
test("malformed or non-JSON successful body is returned unchanged", async () => {
  for (const [body, type] of [["{", "application/json"], [JSON.stringify(receipt()), "text/plain"]]) {
    const original = new Response(body, { status: 200, headers: { "content-type": type! } });
    assert.equal(await withDiscriminationReadLinks(original, context), original);
    assert.equal(await original.text(), body);
  }
});
test("oversized receipt adds no links and preserves the full original stream", async () => {
  const value = { ...receipt(), padding: "x".repeat(16384) };
  const original = response(value);
  assert.equal(await withDiscriminationReadLinks(original, context), original);
  assert.equal(await original.text(), JSON.stringify(value));
});
test("ordinary receipt remains one experiment, not new scientific verification", async () => {
  const linked = await withDiscriminationReadLinks(response(receipt()), context);
  const body = await linked.json();
  assert.deepEqual(body, receipt());
  for (const name of ["verified", "independence_tier", "experiment_passed"]) assert.equal(Object.hasOwn(body, name), false);
});

/** A watchdog makes regressions fail rather than hanging the suite. Each
 * parked producer is completed in finally, so the original tee is also drained.
 * These are native Fetch/Web Streams, not a mocked writer or database. */
async function withinReceiptDeadline<T>(work: Promise<T>): Promise<T> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("OPTIONAL_RECEIPT_READ_DID_NOT_FINISH")), 1000);
      }),
    ]);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
}
const encode = (text: string) => new TextEncoder().encode(text);
function nativeStreamResponse(body: ReadableStream<Uint8Array> | null, status = 201) {
  return new Response(body, { status, headers: {
    "content-type": "application/json", "cache-control": "private, no-store",
    "idempotency-replayed": status === 200 ? "true" : "false",
    link: '</protocol.md>; rel="help"',
  } });
}

for (const status of [200, 201]) {
  test(`parked ${status} receipt returns unchanged without waiting for optional links or tee cancellation`, async () => {
    let producer!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const original = nativeStreamResponse(new ReadableStream({
      start(controller) { producer = controller; },
      cancel() { cancelled = true; },
    }), status);
    try {
      const returned = await withinReceiptDeadline(withDiscriminationReadLinks(original, context));
      assert.equal(returned, original);
      assert.equal(returned.status, status);
      assert.equal(returned.headers.get("link"), '</protocol.md>; rel="help"');
      assert.equal(returned.headers.get("idempotency-replayed"), status === 200 ? "true" : "false");
      assert.equal(returned.bodyUsed, false);
      assert.equal(returned.body?.locked, false);
      assert.equal(cancelled, false, "optional clone cancellation must not cancel the caller's body");
    } finally {
      producer.enqueue(encode(JSON.stringify(receipt()))); producer.close();
      assert.equal(await original.text(), JSON.stringify(receipt()));
    }
  });
}

test("complete-looking JSON without stream completion is not a complete receipt", async () => {
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const text = JSON.stringify(receipt());
  const original = nativeStreamResponse(new ReadableStream({
    start(controller) { producer = controller; controller.enqueue(encode(text)); },
  }));
  try {
    assert.equal(await withinReceiptDeadline(withDiscriminationReadLinks(original, context)), original);
    assert.equal(original.headers.get("link"), '</protocol.md>; rel="help"');
  } finally {
    producer.close();
    assert.equal(await original.text(), text);
  }
});

test("a slow trickle cannot renew the total optional receipt deadline", async () => {
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  let whitespace = "";
  const original = nativeStreamResponse(new ReadableStream({ start(controller) { producer = controller; } }));
  const trickle = setInterval(() => { whitespace += " "; producer.enqueue(encode(" ")); }, 25);
  try {
    assert.equal(await withinReceiptDeadline(withDiscriminationReadLinks(original, context)), original);
    assert.ok(whitespace.length > 0, "the stream must actually have advanced before timing out");
  } finally {
    clearInterval(trickle);
    producer.enqueue(encode(JSON.stringify(receipt()))); producer.close();
    assert.equal(await original.text(), whitespace + JSON.stringify(receipt()));
  }
});

test("empty chunks consume the finite chunk budget instead of bypassing the byte cap", async () => {
  let chunks = 0;
  const text = JSON.stringify(receipt());
  const original = nativeStreamResponse(new ReadableStream({
    pull(controller) {
      if (chunks++ < 257) controller.enqueue(new Uint8Array());
      else { controller.enqueue(encode(text)); controller.close(); }
    },
  }));
  assert.equal(await withinReceiptDeadline(withDiscriminationReadLinks(original, context)), original);
  assert.equal(await original.text(), text);
});

test("a receipt at the chunk limit still gains links after its final EOF", async () => {
  let chunks = 0;
  const text = JSON.stringify(receipt());
  const original = nativeStreamResponse(new ReadableStream({
    pull(controller) {
      if (chunks++ < 255) controller.enqueue(new Uint8Array());
      else { controller.enqueue(encode(text)); controller.close(); }
    },
  }));
  const linked = await withDiscriminationReadLinks(original, context);
  assert.match(linked.headers.get("link")!, /E-ABC.json/);
  assert.equal(await linked.text(), text);
});

test("exact byte cap is accepted while one byte beyond preserves the receipt without links", async () => {
  const text = JSON.stringify(receipt());
  for (const extra of [0, 1]) {
    const body = text + " ".repeat(16384 - encode(text).byteLength + extra);
    const original = new Response(body, { status: 201, headers: { "content-type": "application/json" } });
    const returned = await withDiscriminationReadLinks(original, context);
    if (extra === 0) assert.match(returned.headers.get("link")!, /E-ABC.json/);
    else assert.equal(returned, original);
    assert.equal(await returned.text(), body);
  }
});

test("oversized Content-Length skips optional reads without changing the response", async () => {
  const original = response(receipt()); original.headers.set("content-length", "99999");
  assert.equal(await withDiscriminationReadLinks(original, context), original);
  assert.equal(await original.text(), JSON.stringify(receipt()));
});

test("nonidentity content encoding is not parsed as unencoded JSON", async () => {
  const original = response(receipt()); original.headers.set("content-encoding", "gzip");
  assert.equal(await withDiscriminationReadLinks(original, context), original);
  assert.equal(original.headers.get("content-encoding"), "gzip");
  assert.equal(await original.text(), JSON.stringify(receipt()));
});

test("a declared small size cannot bypass the streamed byte cap", async () => {
  const body = JSON.stringify(receipt()) + " ".repeat(16384);
  const original = new Response(body, { status: 201, headers: { "content-type": "application/json", "content-length": "2" } });
  assert.equal(await withDiscriminationReadLinks(original, context), original);
  assert.equal(await original.text(), body);
});

test("null, already consumed and locked bodies never replace the writer response", async () => {
  const empty = nativeStreamResponse(null);
  assert.equal(await withDiscriminationReadLinks(empty, context), empty);
  const consumed = response(receipt()); await consumed.text();
  assert.equal(await withDiscriminationReadLinks(consumed, context), consumed);
  const locked = response(receipt()); const reader = locked.body!.getReader();
  try {
    assert.equal(await withDiscriminationReadLinks(locked, context), locked);
    const first = await reader.read(); assert.equal(new TextDecoder().decode(first.value), JSON.stringify(receipt()));
    assert.equal((await reader.read()).done, true);
  } finally { reader.releaseLock(); }
});

test("split UTF-8 and chunked receipts retain exact original bytes", async () => {
  const value = { ...receipt(), note: "é🚀" };
  const bytes = encode(JSON.stringify(value));
  const split = bytes.indexOf(0xc3) + 1;
  const original = nativeStreamResponse(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split, split + 3));
    controller.enqueue(bytes.slice(split + 3)); controller.close();
  } }));
  const linked = await withDiscriminationReadLinks(original, context);
  assert.match(linked.headers.get("link")!, /E-ABC.json/);
  assert.deepEqual(new Uint8Array(await linked.arrayBuffer()), bytes);
});

test("invalid UTF-8 preserves the original bytes instead of presenting guessed navigation", async () => {
  const bytes = new Uint8Array([0x7b, 0xff, 0x7d]);
  const original = new Response(bytes, { status: 200, headers: { "content-type": "application/json" } });
  assert.equal(await withDiscriminationReadLinks(original, context), original);
  assert.deepEqual(new Uint8Array(await original.arrayBuffer()), bytes);
});

test("body read rejection remains the original response failure, not a fabricated receipt", async () => {
  const failure = new Error("synthetic stream failure");
  const original = nativeStreamResponse(new ReadableStream({ start(controller) { controller.error(failure); } }));
  assert.equal(await withDiscriminationReadLinks(original, context), original);
  await assert.rejects(original.text(), failure);
});
