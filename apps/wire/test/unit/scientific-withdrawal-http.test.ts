import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ScientificWithdrawalRequest } from "@asimposium/contracts/scientific-withdrawals";
import {
  handleScientificWithdrawalHttp,
  type ScientificWithdrawalOperations,
  scientificWithdrawalRoute,
  WITHDRAWAL_BODY_LIMIT,
  WithdrawalHttpError,
} from "../../src/ledger/scientific-withdrawal-http.ts";

const schema = "https://a.asimposium.org/schemas/scientific-withdrawals.v1.json";
const session = `S-${"A".repeat(26)}`;
const path = `/v1/sessions/${session}/evidence/E-1/retract`;
const body = {
  source_event_id: "E-source",
  source_digest: `sha256:${"a".repeat(64)}`,
  reason: "The author found a substantive error.",
};
function fixture() {
  let authCalls = 0;
  const writes: unknown[][] = [];
  const actor = { credentialProfile: "bearer", fellowId: "F-author" } as Awaited<
    ReturnType<ScientificWithdrawalOperations["authenticate"]>
  >;
  const ops: ScientificWithdrawalOperations = {
    schema,
    problem: (input) =>
      new Response(
        JSON.stringify({
          type: `https://asimposium.org/errors/${input.code}`,
          code: input.code,
          title: input.title,
          detail: input.detail,
          fix_hint: input.fixHint,
          ...(input.extensions ?? {}),
        }),
        {
          status: input.status,
          headers: {
            ...input.headers,
            "content-type": "application/problem+json; charset=utf-8",
          },
        },
      ),
    authenticate: async (token) => {
      authCalls++;
      return token === "asimp_ag_test" ? actor : undefined;
    },
    // Deliberate decoder port: these are transport tests, not Zod tests.
    decode(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const v = value as Record<string, unknown>;
      return Object.keys(v).sort().join(",") === "reason,source_digest,source_event_id" &&
        typeof v.reason === "string" &&
        v.reason.trim().length >= 10 &&
        v.reason.length <= 2000 &&
        v.source_digest === body.source_digest &&
        v.source_event_id === body.source_event_id
        ? (v as unknown as ScientificWithdrawalRequest)
        : undefined;
    },
    withdraw: async (...args) => {
      writes.push(args);
      return {
        schema,
        ok: true,
        event_id: "E-withdraw",
        retraction_id: "R-EXAMPLE",
        problem_id: "P-DEMO",
        target_kind: args[2],
        target_object: args[3],
        target_event_id: args[4].source_event_id,
        target_digest: args[4].source_digest,
        claim_id: "C-1",
        claim_version: 1,
        retraction_kind: "self-corrected",
        seq: 9,
        created_at: "2026-09-17T00:00:00.000Z",
      };
    },
  };
  return { ops, writes, authCalls: () => authCalls };
}
function request(
  options: {
    path?: string;
    method?: string;
    body?: string | Uint8Array | ReadableStream<Uint8Array>;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
) {
  const method = options.method ?? "POST";
  return new Request(`https://a.asimposium.org${options.path ?? path}`, {
    method,
    headers: {
      authorization: "Bearer asimp_ag_test",
      "content-type": "application/json",
      "idempotency-key": "correction-1",
      ...options.headers,
    },
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: options.body ?? JSON.stringify(body) }),
    ...(options.signal ? { signal: options.signal } : {}),
    duplex: "half",
  } as RequestInit);
}

for (const [collection, id, kind] of [
  ["evidence", "E-1", "evidence"],
  ["reviews", "R-1", "review"],
] as const) {
  test(`${kind} withdrawal forwards exact source and key to the authenticated command`, async () => {
    const f = fixture(),
      p = `/v1/sessions/${session}/${collection}/${id}/retract`;
    const response = (await handleScientificWithdrawalHttp(request({ path: p }), f.ops))!;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(f.writes[0]?.slice(1), [session, kind, id, body, "correction-1"]);
    assert.equal(((await response.json()) as { target_object: string }).target_object, id);
  });
}
test("unchanged retries forward the same replay identity", async () => {
  const f = fixture();
  const a = await handleScientificWithdrawalHttp(request(), f.ops),
    b = await handleScientificWithdrawalHttp(request(), f.ops);
  assert.equal(await a!.text(), await b!.text());
  assert.deepEqual(f.writes[0], f.writes[1]);
});
test("non-withdrawal and claim-withdrawal routes remain untouched", async () => {
  const f = fixture();
  assert.equal(
    await handleScientificWithdrawalHttp(
      request({ path: `/v1/sessions/${session}/retract` }),
      f.ops,
    ),
    undefined,
  );
  assert.equal(scientificWithdrawalRoute(`/v1/sessions/${session}/reviews/E-1/retract`), undefined);
  assert.equal(f.authCalls(), 0);
});
for (const method of ["GET", "HEAD", "DELETE"]) {
  test(`${method} cannot invoke a withdrawal`, async () => {
    const f = fixture(),
      r = (await handleScientificWithdrawalHttp(request({ method }), f.ops))!;
    assert.equal(r.status, 405);
    assert.equal(r.headers.get("allow"), "POST");
    if (method === "HEAD") assert.equal(await r.text(), "");
    assert.equal(f.writes.length, 0);
    assert.equal(f.authCalls(), 0);
  });
}
for (const authorization of ["", "Bearer wrong", "Bearer a,b", "Basic asimp_ag_test"]) {
  test(`invalid bearer ${authorization || "(absent)"} cannot use cookie identity`, async () => {
    const f = fixture();
    const r = await handleScientificWithdrawalHttp(
      request({ headers: { authorization, cookie: "sponsor=trusted" } }),
      f.ops,
    );
    assert.equal(r!.status, 401);
    assert.equal(f.writes.length, 0);
  });
}
test("a service envelope cannot be mixed into the Fellow correction route", async () => {
  const f = fixture(),
    r = await handleScientificWithdrawalHttp(
      request({ headers: { "asimp-service-envelope": "{}" } }),
      f.ops,
    );
  assert.equal(r!.status, 401);
  assert.equal(f.authCalls(), 0);
});
test("query parameters are refused rather than becoming target or credential overrides", async () => {
  const f = fixture(),
    r = await handleScientificWithdrawalHttp(request({ path: `${path}?token=secret` }), f.ops);
  assert.equal(r!.status, 400);
  assert.equal(f.writes.length, 0);
});
test("wrong media type and missing replay key do not execute a correction", async () => {
  const f = fixture();
  assert.equal(
    (await handleScientificWithdrawalHttp(
      request({ headers: { "content-type": "text/plain" } }),
      f.ops,
    ))!.status,
    415,
  );
  assert.equal(
    (await handleScientificWithdrawalHttp(request({ headers: { "idempotency-key": "" } }), f.ops))!
      .status,
    400,
  );
  assert.equal(f.writes.length, 0);
});
test("invalid JSON, UTF-8 and mismatched lengths are refused", async () => {
  const f = fixture();
  for (const req of [
    request({ body: "{" }),
    request({ body: new Uint8Array([255]) }),
    request({ headers: { "content-length": "2" } }),
  ])
    assert.equal((await handleScientificWithdrawalHttp(req, f.ops))!.status, 400);
  assert.equal(f.writes.length, 0);
});
test("unrecognized fields cannot set scientific or actor authority", async () => {
  const f = fixture(),
    r = await handleScientificWithdrawalHttp(
      request({ body: JSON.stringify({ ...body, actor: "admin", disposition: "proved" }) }),
      f.ops,
    );
  assert.equal(r!.status, 422);
  assert.equal(f.writes.length, 0);
});
test("oversized streamed bodies are cancelled before command execution", async () => {
  const f = fixture();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(WITHDRAWAL_BODY_LIMIT + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  assert.equal(
    (await handleScientificWithdrawalHttp(request({ body: stream }), f.ops))!.status,
    400,
  );
  assert.ok(cancelled);
  assert.equal(f.writes.length, 0);
});
test("slow request bodies are cancelled at the internal deadline", async () => {
  const f = fixture();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  assert.equal(
    (await handleScientificWithdrawalHttp(request({ body: stream }), {
      ...f.ops,
      bodyTimeoutMs: 5,
    }))!.status,
    400,
  );
  assert.ok(cancelled);
  assert.equal(f.writes.length, 0);
});
test("request cancellation stops a stalled body without issuing a write", async () => {
  const f = fixture(),
    controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const pending = handleScientificWithdrawalHttp(
    request({ body: stream, signal: controller.signal }),
    f.ops,
  );
  setTimeout(() => controller.abort(), 5);
  assert.equal((await pending)!.status, 400);
  assert.ok(cancelled);
  assert.equal(f.writes.length, 0);
});
test("a mismatched command receipt cannot be reported as success", async () => {
  const f = fixture();
  const r = await handleScientificWithdrawalHttp(request(), {
    ...f.ops,
    withdraw: async (...args) => ({ ...(await f.ops.withdraw(...args)), target_object: "E-other" }),
  });
  assert.equal(r!.status, 503);
});
for (const [code, status] of [
  ["DENIED", 401],
  ["CONFLICT", 409],
  ["HELD", 403],
  ["THROTTLED", 429],
  ["UNAVAILABLE", 503],
] as const) {
  test(`${code} becomes the bounded private refusal`, async () => {
    const f = fixture(),
      r = (await handleScientificWithdrawalHttp(request(), {
        ...f.ops,
        withdraw: async () => {
          throw new WithdrawalHttpError(code, 17);
        },
      }))!;
    assert.equal(r.status, status);
    assert.equal(r.headers.get("cache-control"), "private, no-store");
    if (status === 429 || status === 503) assert.equal(r.headers.get("retry-after"), "17");
  });
}
test("dependency exception text is never exposed", async () => {
  const f = fixture(),
    r = (await handleScientificWithdrawalHttp(request(), {
      ...f.ops,
      authenticate: async () => {
        throw new Error("PRIVATE-SECRET-SENTINEL");
      },
    }))!;
  assert.equal(r.status, 503);
  assert.ok(!(await r.text()).includes("PRIVATE-SECRET-SENTINEL"));
});
