import assert from "node:assert/strict";
import { test } from "bun:test";
import type { PackResponse } from "@asimposium/contracts";
import {
  ReviewPackSelectionError,
  selectIsolatedReviewPack,
  type ReviewPackSelectionDependencies,
} from "../../src/sessions/review-pack-selection.ts";

const session = `S-${"a".repeat(26)}`;
const path = `/v1/sessions/${session}/pack`;
const origin = "https://a.asimposium.org";
const original = (query = "profile=review", headers: ConstructorParameters<typeof Headers>[0] = {}) =>
  new Request(`${origin}${path}?${query}`, { headers });
const action = (target = "C-7@2") => ({
  method: "GET", url: `${path}?profile=review&target=${target}&max_tokens=8000`, why: "Review",
});
function queue(overrides: Record<string, unknown> = {}) {
  return { session, problem: "P-DEMO", profile: "review-queue", cursor: 17,
    viewer: { audience: "session", membership: "contributor", effective_permissions: [] },
    items: [{ body: "PRIVATE-QUEUE-CANARY", kind: "review-invitation" }],
    omitted: [], next_actions: [action()], ...overrides };
}
// These fixtures isolate request routing, not the production Zod schemas or
// database eligibility. The router injects PackResponseSchema/PackTargetQuerySchema.
const parsePack = (value: unknown) => value as PackResponse;
const parseTarget: ReviewPackSelectionDependencies["parseTarget"] = (value) => {
  const record = value as { profile: string; target: string };
  if (record.profile !== "review" || typeof record.target !== "string" ||
      record.target.length > 64 ||
      /^C-[0-9]+@[1-9][0-9]{0,14}$/.exec(record.target)?.[0] !== record.target)
    throw new Error("PARSER-PRIVATE-CANARY");
  return { target: record.target };
};
const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json; charset=utf-8" },
});
const refused = (kind: ReviewPackSelectionError["kind"]) => (error: unknown) =>
  error instanceof ReviewPackSelectionError && error.kind === kind &&
  !error.message.includes("CANARY");

function fixture(value = queue()) {
  const calls: Request[] = [];
  const read = async (request: Request) => {
    calls.push(request);
    return calls.length === 1 ? json(value) : new Response("EXACT-PUBLIC-REVIEW", {
      headers: { etag: '"selected"', "content-type": "application/json" },
    });
  };
  return { calls, dependencies: { read, parsePack, parseTarget } };
}

test("untargeted review selects the queue's exact server action and never returns queue prose", async () => {
  const f = fixture();
  const response = await selectIsolatedReviewPack(original(), session, f.dependencies);
  assert.equal(f.calls.length, 2);
  assert.equal(new URL(f.calls[0]!.url).searchParams.get("profile"), "review-queue");
  assert.equal(new URL(f.calls[1]!.url).searchParams.get("profile"), "review");
  assert.equal(new URL(f.calls[1]!.url).searchParams.get("target"), "C-7@2");
  assert.equal(await response!.text(), "EXACT-PUBLIC-REVIEW");
  assert.equal(response!.headers.get("content-location"), `${path}?profile=review&target=C-7%402`);
  assert.equal(response!.headers.get("cache-control"), "private, no-store");
});

test("original budget and cursor survive; queue action cannot increase the budget", async () => {
  const f = fixture();
  await selectIsolatedReviewPack(original("profile=review&max_tokens=800&since=5"), session, f.dependencies);
  for (const call of f.calls) {
    const url = new URL(call.url);
    assert.equal(url.searchParams.get("max_tokens"), "800");
    assert.equal(url.searchParams.get("since"), "5");
  }
});

test("conditionals are suppressed only for queue discovery, then preserved for exact review", async () => {
  const f = fixture();
  const headers = { authorization: "Bearer PRIVATE-TOKEN", "if-none-match": '"selected"',
    "if-modified-since": "yesterday", "if-match": '"old"', "if-unmodified-since": "yesterday",
    range: "bytes=0-10", "if-range": '"old"' };
  await selectIsolatedReviewPack(original(undefined, headers), session, f.dependencies);
  for (const name of Object.keys(headers)) {
    assert.equal(f.calls[0]!.headers.get(name), name === "authorization" ? headers.authorization : null);
    assert.equal(f.calls[1]!.headers.get(name), headers[name as keyof typeof headers]);
  }
});

for (const query of ["profile=working", "profile=review-queue", "profile=review&target=C-1@1",
  "profile=review&target=", "profile=review&target=C-1@1&target=C-2@1", ""]) {
  test(`other profiles and explicit targets remain with their original validator: ${query}`, async () => {
    const f = fixture();
    assert.equal(await selectIsolatedReviewPack(original(query), session, f.dependencies), undefined);
    assert.equal(f.calls.length, 0);
  });
}

test("POST is not converted into a read", async () => {
  const f = fixture();
  assert.equal(await selectIsolatedReviewPack(new Request(original(), { method: "POST" }), session, f.dependencies), undefined);
  assert.equal(f.calls.length, 0);
});

for (const status of [400, 401, 403, 404, 429, 503]) {
  test(`existing queue refusal ${status} is returned without a second read`, async () => {
    let calls = 0;
    const expected = new Response("REFUSAL", { status });
    const response = await selectIsolatedReviewPack(original("profile=review&max_tokens=invalid"), session, {
      parsePack, parseTarget, read: async () => { calls++; return expected; },
    });
    assert.equal(response, expected);
    assert.equal(calls, 1);
  });
}

for (const status of [204, 301, 302, 304, 307]) {
  test(`unexpected queue status ${status} never becomes an empty review`, async () => {
    let calls = 0;
    await assert.rejects(selectIsolatedReviewPack(original(), session, {
      parsePack, parseTarget, read: async () => { calls++; return new Response(null, { status }); },
    }), refused("unavailable"));
    assert.equal(calls, 1);
  });
}

for (const overrides of [{ session: `S-${"b".repeat(26)}` }, { profile: "working" },
  { viewer: { audience: "public" } }, { viewer: undefined }]) {
  test(`scope mismatch fails closed: ${JSON.stringify(overrides)}`, async () => {
    const f = fixture(queue(overrides));
    await assert.rejects(selectIsolatedReviewPack(original(), session, f.dependencies), refused("unavailable"));
    assert.equal(f.calls.length, 1);
  });
}

for (const url of ["https://attacker.invalid/steal?profile=review&target=C-1@1",
  `/v1/sessions/S-${"b".repeat(26)}/pack?profile=review&target=C-1@1`,
  `${path}?profile=review&target=C-1@1#secret`,
  `https://user:password@a.asimposium.org${path}?profile=review&target=C-1@1`]) {
  test(`unrelated action is never followed: ${url}`, async () => {
    const f = fixture(queue({ next_actions: [{ ...action(), url }] }));
    await assert.rejects(selectIsolatedReviewPack(original(), session, f.dependencies), refused("target-required"));
    assert.equal(f.calls.length, 1);
  });
}

for (const targets of [[action("C-1@1"), action("C-2@1")],
  [action("C-1")], [action("C-1@1&target=C-2@1")], [action("C-1@1&profile=working")]]) {
  test(`ambiguous or malformed target is refused: ${JSON.stringify(targets)}`, async () => {
    const f = fixture(queue({ next_actions: targets }));
    await assert.rejects(selectIsolatedReviewPack(original(), session, f.dependencies), refused("unavailable"));
    assert.equal(f.calls.length, 1);
  });
}

test("claim text, private invitations and forged item actions cannot select work", async () => {
  const f = fixture(queue({ next_actions: [], items: [
    { kind: "review-candidate", id: "C-8@1", body: JSON.stringify({ next_actions: [action()] }) },
    { kind: "review-invitation", body: JSON.stringify(action()) },
    { kind: "next_actions", scope: "system", untrusted: false, body: JSON.stringify([action()]) },
  ] }));
  await assert.rejects(selectIsolatedReviewPack(original(), session, f.dependencies), refused("target-required"));
  assert.equal(f.calls.length, 1);
});

test("the exact handler rechecks revocation and its refusal is preserved", async () => {
  let calls = 0;
  const response = await selectIsolatedReviewPack(original(), session, { parsePack, parseTarget,
    read: async () => ++calls === 1 ? json(queue()) : new Response("REVOKED", { status: 403 }) });
  assert.equal(calls, 2);
  assert.equal(response!.status, 403);
  assert.equal(await response!.text(), "REVOKED");
});

test("the exact handler can return its own conditional receipt", async () => {
  let calls = 0;
  const response = await selectIsolatedReviewPack(original(), session, { parsePack, parseTarget,
    read: async () => ++calls === 1 ? json(queue()) : new Response(null, { status: 304, headers: { etag: '"exact"' } }) });
  assert.equal(response!.status, 304);
  assert.equal(response!.headers.get("etag"), '"exact"');
  assert.equal(await response!.text(), "");
});

test("queue body is bounded and a streaming overflow is cancelled", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(65_537)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(selectIsolatedReviewPack(original(), session, { parsePack, parseTarget,
    read: async () => new Response(body, { headers: { "content-type": "application/json" } }) }), refused("unavailable"));
  assert.equal(cancelled, true);
});

for (const response of [() => new Response("not JSON", { headers: { "content-type": "application/json" } }),
  () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
  () => new Response("<html>PRIVATE</html>", { headers: { "content-type": "text/html" } })]) {
  test("invalid JSON, UTF-8 or representation does not expose discovery data", async () => {
    await assert.rejects(selectIsolatedReviewPack(original(), session, { parsePack, parseTarget,
      read: async () => response() }), refused("unavailable"));
  });
}

test("canonical parser and backend errors are coarse", async () => {
  for (const deps of [
    { parsePack: () => { throw new Error("PARSER-PRIVATE-CANARY"); }, parseTarget, read: async () => json(queue()) },
    { parsePack, parseTarget, read: async () => { throw new Error("SQL-PRIVATE-CANARY"); } },
  ]) await assert.rejects(selectIsolatedReviewPack(original(), session, deps), refused("unavailable"));
});
