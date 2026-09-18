import { test } from "bun:test";
import assert from "node:assert/strict";
import type { FellowCredentialBinding } from "../../src/enrollment/service.ts";
import {
  artifactPublicationRoute,
  handleArtifactPublicationHttp,
  PUBLICATION_BODY_BYTES,
  PublicationHttpError,
  type PublicationHttpOperations,
  readPublicationRequestBody,
} from "../../src/krater/artifact-publication-http.ts";

const upload = `AU-${"a".repeat(32)}`,
  publication = `AP-${"b".repeat(32)}`;
const publishPath = `/v1/artifacts/${upload}/publish`,
  statusPath = `/v1/artifact-publications/${publication}`;
const manifestPath = `/p/P-DEMO/artifacts/${publication}.json`,
  listPath = "/p/P-DEMO/evidence/E-1/artifacts.json";
const input = {
  session_id: `S-${"A".repeat(26)}`,
  evidence_id: "E-1",
  evidence_digest: `sha256:${"c".repeat(64)}`,
  publish: true as const,
  license: "CC-BY-4.0" as const,
};
const actor = { fellowId: "fellow-one", credentialProfile: "bearer" } as FellowCredentialBinding;
const receipt = {
  publication_id: publication,
  status_path: statusPath,
  initial_delivery: "queued",
  verification: "bytes-only",
};
const request = (path = publishPath, init: RequestInit = {}) =>
  new Request(`https://a.asimposium.org${path}`, init);
const post = (body: unknown = input, extra: Record<string, string> = {}) =>
  request(publishPath, {
    method: "POST",
    headers: {
      authorization: "Bearer TEST-TOKEN",
      "content-type": "application/json",
      "idempotency-key": "publish-1",
      ...extra,
    },
    body: JSON.stringify(body),
  });
function fixture() {
  const calls: unknown[][] = [];
  const ops: PublicationHttpOperations = {
    async authenticate(token) {
      calls.push(["auth", token]);
      return actor;
    },
    // This port tests transport success/refusal plumbing, not Zod acceptance.
    // The shared contract has separate native contract tests.
    decodeRequest(value) {
      calls.push(["decode"]);
      return value && typeof value === "object" && "publish" in value && value.publish === true
        ? input
        : undefined;
    },
    problem(value) {
      calls.push(["problem", value.code]);
      return new Response(
        JSON.stringify({
          type: `https://asimposium.org/errors/${value.code}`,
          title: value.title,
          code: value.code,
          status: value.status,
          detail: value.detail,
          fix_hint: value.fixHint,
          ...(value.rule ? { rule: value.rule } : {}),
          ...value.extensions,
        }),
        {
          status: value.status,
          headers: { "content-type": "application/problem+json", ...value.headers },
        },
      );
    },
    async publish(...args) {
      calls.push(["publish", ...args]);
      return receipt;
    },
    async status(...args) {
      calls.push(["status", ...args]);
      return { ...receipt, delivery: "queued", download_url: null };
    },
    async manifest(...args) {
      calls.push(["manifest", ...args]);
      return { publication_id: publication, verification: "bytes-only" };
    },
    async evidence(...args) {
      calls.push(["evidence", ...args]);
      return {
        artifacts: [],
        after: args[2],
        through: args[3] ?? 100,
        next_after: null,
        next_path: null,
        poll_path: `${listPath}?after=${args[3] ?? 100}`,
      };
    },
  };
  return { calls, ops };
}
async function response(req: Request, f = fixture()) {
  const result = await handleArtifactPublicationHttp(req, f.ops);
  assert.ok(result);
  return { result, ...f };
}

test("POST accepts consent through the service and reports acceptance, not delivery", async () => {
  const { result, calls } = await response(post());
  assert.equal(result.status, 202);
  assert.equal(result.headers.get("location"), statusPath);
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await result.json(), receipt);
  assert.deepEqual(calls, [
    ["auth", "TEST-TOKEN"],
    ["decode"],
    ["publish", actor, upload, input, "publish-1"],
  ]);
});
test("every private request freshly authenticates, including status and replays", async () => {
  const f = fixture();
  await response(post(), f);
  await response(post(), f);
  const { result } = await response(
    request(statusPath, { headers: { authorization: "Bearer TEST-TOKEN" } }),
    f,
  );
  assert.equal(result.status, 200);
  assert.equal(f.calls.filter((c) => c[0] === "auth").length, 3);
});
const nonFellowHeaders: Array<Record<string, string>> = [
  {},
  { cookie: "sponsor=sentinel" },
  { "x-sponsor-id": "sponsor-sentinel" },
  { authorization: "Bearer bad, Bearer other" },
  { authorization: "Bearer x y" },
  { authorization: `Bearer ${"x".repeat(257)}` },
  { authorization: "Basic dGVzdA==" },
  { authorization: "Bearer TEST-TOKEN", "asimp-service-envelope": "sentinel" },
];
for (const headers of nonFellowHeaders) {
  test(`refuses non-Fellow identity ${JSON.stringify(headers).slice(0, 65)}`, async () => {
    const { result, calls } = await response(request(statusPath, { headers }));
    assert.equal(result.status, 401);
    assert.equal(
      calls.some((c) => c[0] === "auth" || c[0] === "status"),
      false,
    );
    assert.ok(!(await result.text()).includes("sentinel"));
  });
}
for (const identity of [
  undefined,
  { ...actor, credentialProfile: "dpop" } as FellowCredentialBinding,
]) {
  test(`refuses missing or incompatible verified binding ${identity?.credentialProfile}`, async () => {
    const f = fixture();
    f.ops = { ...f.ops, authenticate: async () => identity };
    const { result } = await response(post(), f);
    assert.equal(result.status, 401);
    assert.equal(
      f.calls.some((c) => c[0] === "publish" || c[0] === "decode"),
      false,
    );
  });
}
test("authorization dependency failure is opaque and cannot call the writer", async () => {
  const f = fixture();
  f.ops = {
    ...f.ops,
    authenticate: async () => {
      throw new Error("PRIVATE-EXCEPTION");
    },
  };
  const { result } = await response(post(), f);
  assert.equal(result.status, 503);
  assert.ok(!(await result.text()).includes("PRIVATE-EXCEPTION"));
  assert.ok(!f.calls.some((c) => c[0] === "publish"));
});
for (const [method, path] of [
  ["GET", publishPath],
  ["PUT", publishPath],
  ["POST", statusPath],
  ["POST", manifestPath],
]) {
  test(`refuses ${method} on ${path}`, async () => {
    const { result, calls } = await response(request(path, { method }));
    assert.equal(result.status, 405);
    assert.ok(result.headers.get("allow"));
    assert.equal(calls.length, 1);
  });
}
for (const [headers, expected] of [
  [{ "content-type": "text/plain" }, 415],
  [{ "idempotency-key": "" }, 400],
  [{ "idempotency-key": "x y" }, 400],
  [{ "idempotency-key": "x".repeat(129) }, 400],
] as const) {
  test(`refuses malformed write headers ${JSON.stringify(headers).slice(0, 55)}`, async () => {
    const { result, calls } = await response(post(input, headers));
    assert.equal(result.status, expected);
    assert.ok(!calls.some((c) => c[0] === "decode" || c[0] === "publish"));
  });
}
test("decoder rejection never reaches publication", async () => {
  const { result, calls } = await response(post({ publish: false }));
  assert.equal(result.status, 422);
  assert.ok(!calls.some((c) => c[0] === "publish"));
});
test("malformed UTF-8 and malformed JSON cannot be accepted", async () => {
  for (const body of [new Uint8Array([0xff]), new TextEncoder().encode('{"publish":')]) {
    const { result, calls } = await response(
      request(publishPath, {
        method: "POST",
        body,
        headers: {
          authorization: "Bearer TEST-TOKEN",
          "content-type": "application/json",
          "idempotency-key": "key",
        },
      }),
    );
    assert.equal(result.status, 400);
    assert.ok(!calls.some((c) => c[0] === "publish"));
  }
});
test("all private and manifest routes reject query-string authority", async () => {
  for (const path of [publishPath, statusPath, manifestPath]) {
    const { result, calls } = await response(
      request(`${path}?token=PRIVATE-SENTINEL`, { method: path === publishPath ? "POST" : "GET" }),
    );
    assert.equal(result.status, 400);
    assert.equal(calls.length, 1);
    assert.ok(!(await result.text()).includes("PRIVATE-SENTINEL"));
  }
});
for (const query of [
  "after=-1",
  "after=1.5",
  "after=1e3",
  "after=01",
  "after=9007199254740992",
  "after=1&after=2",
  "through=1&through=1",
  "after=4&through=3",
  "token=sentinel",
  "limit=100",
]) {
  test(`refuses ambiguous pagination ${query}`, async () => {
    const { result, calls } = await response(request(`${listPath}?${query}`));
    assert.equal(result.status, 400);
    assert.ok(!calls.some((c) => c[0] === "evidence"));
  });
}
test("public listing preserves the pinned delivery cut and never authenticates supplied cookies", async () => {
  const { result, calls } = await response(
    request(`${listPath}?after=3&through=15`, {
      headers: { cookie: "ignored", authorization: "Bearer ignored" },
    }),
  );
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, [["evidence", "P-DEMO", "E-1", 3, 15]]);
  assert.deepEqual(await result.json(), {
    artifacts: [],
    after: 3,
    through: 15,
    next_after: null,
    next_path: null,
    poll_path: `${listPath}?after=15`,
  });
});
test("conditional public reads still resolve current visibility before 304", async () => {
  const f = fixture(),
    first = await response(request(manifestPath), f);
  const etag = first.result.headers.get("etag")!;
  const second = await response(
    request(manifestPath, { headers: { "if-none-match": `W/${etag}` } }),
    f,
  );
  assert.equal(second.result.status, 304);
  assert.equal(await second.result.text(), "");
  assert.equal(f.calls.filter((c) => c[0] === "manifest").length, 2);
  f.ops = {
    ...f.ops,
    manifest: async () => {
      throw new PublicationHttpError("NOT_FOUND");
    },
  };
  const hidden = await response(request(manifestPath, { headers: { "if-none-match": etag } }), f);
  assert.equal(hidden.result.status, 404);
});
test("HEAD public reads and refusals have no response body", async () => {
  for (const path of [manifestPath, listPath, `${listPath}?after=oops`, `${manifestPath}?bad=1`]) {
    const { result } = await response(request(path, { method: "HEAD" }));
    assert.equal(await result.text(), "");
  }
});
for (const [code, status] of [
  ["AUTH", 401],
  ["DENIED", 403],
  ["NOT_FOUND", 404],
  ["CONFLICT", 409],
  ["BUSY", 409],
  ["THROTTLED", 429],
  ["UNAVAILABLE", 503],
] as const) {
  test(`projects safe ${code} service failure`, async () => {
    const f = fixture();
    f.ops = {
      ...f.ops,
      publish: async () => {
        throw new PublicationHttpError(code, 5);
      },
    };
    const { result } = await response(post(), f);
    assert.equal(result.status, status);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    if ([429, 503].includes(status) || code === "BUSY")
      assert.equal(result.headers.get("retry-after"), "5");
  });
}
test("neighboring and noncanonical routes remain outside the publication adapter", async () => {
  const f = fixture();
  for (const path of [
    "/v1/artifacts",
    `/v1/artifacts/${upload}/complete`,
    `/v1/artifacts/${upload}/content`,
    `${publishPath}/extra`,
    `/v1/artifacts/AU-${"A".repeat(32)}/publish`,
    "/p/P--DEMO/evidence/E-1/artifacts.json",
    "/p/P-DEMO/evidence/E-1%2Fsecret/artifacts.json",
    `/v1/artifact-publications/${publication}/private`,
  ]) {
    assert.equal(artifactPublicationRoute(path), undefined);
    assert.equal(await handleArtifactPublicationHttp(request(path), f.ops), undefined);
  }
  assert.deepEqual(f.calls, []);
});
test("does not consume a body for an unrelated route", async () => {
  const f = fixture(),
    r = request("/v1/artifacts", { method: "POST", body: "untouched" });
  assert.equal(await handleArtifactPublicationHttp(r, f.ops), undefined);
  assert.equal(await r.text(), "untouched");
});
test("body budget counts streamed bytes, not a missing Content-Length", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(PUBLICATION_BODY_BYTES + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(() =>
    readPublicationRequestBody(
      request(publishPath, { method: "POST", body: stream, duplex: "half" } as RequestInit),
    ),
  );
  assert.equal(cancelled, true);
});
test("slow body is cancelled without waiting for the source to cooperate", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  });
  await assert.rejects(() =>
    readPublicationRequestBody(
      request(publishPath, { method: "POST", body: stream, duplex: "half" } as RequestInit),
      5,
    ),
  );
  assert.equal(cancelled, true);
});
test("abort interrupts a pending read and cannot accept cancellation as EOF", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(JSON.stringify(input)));
    },
    cancel() {
      cancelled = true;
    },
  });
  const reading = readPublicationRequestBody(
    request(publishPath, {
      method: "POST",
      signal: controller.signal,
      body: stream,
      duplex: "half",
    } as RequestInit),
    100,
  );
  controller.abort();
  await assert.rejects(() => reading);
  assert.equal(cancelled, true);
});
test("declared length and compressed JSON are refused exactly", async () => {
  const badHeaders: Array<Record<string, string>> = [
    { "content-length": "01" },
    { "content-length": "100" },
    { "content-length": "999999999999999999999" },
    { "content-encoding": "gzip" },
  ];
  for (const headers of badHeaders) {
    await assert.rejects(() =>
      readPublicationRequestBody(request(publishPath, { method: "POST", body: "{}", headers })),
    );
  }
  assert.deepEqual(
    await readPublicationRequestBody(
      request(publishPath, { method: "POST", body: "{}", headers: { "content-length": "2" } }),
    ),
    {},
  );
});
