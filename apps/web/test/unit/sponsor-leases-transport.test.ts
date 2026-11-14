import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  PRODUCTION_STOA_ORIGIN,
  SPONSOR_LEASE_LIST_MAX_RESPONSE_BYTES,
} from "@asimposium/contracts";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";
import {
  leasePage,
  leaseReceipt,
  leaseSponsor,
  leaseSummary,
  leaseTarget,
} from "../fixtures/sponsor-leases";

mock.module("server-only", () => ({}));
const { stoaSponsorLeases, stoaSponsorReleaseLease } = await import("../../lib/stoa-leases");
const envKeys = [
  "STOA_ORIGIN",
  "SERVICE_ENVELOPE_PRIVATE_KEY_HEX",
  "SERVICE_ENVELOPE_KID",
] as const;
const realFetch = globalThis.fetch;
let previous: Map<string, string | undefined>;

beforeEach(() => {
  previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "17".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "lease-test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("private discovery signs its exact bounded body without browser credentials or writes", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(leasePage);
  }) as unknown as typeof fetch;
  const request = { after: `L-${"0".repeat(25)}1` };
  expect(await stoaSponsorLeases(leaseSponsor, request)).toEqual({ ok: true, data: leasePage });
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call) throw new Error("Lease request was not dispatched");
  const body = JSON.stringify(request);
  expect(call.url).toBe(`${PRODUCTION_STOA_ORIGIN}/v1/sponsors/leases`);
  expect(call.init).toMatchObject({
    method: "POST",
    body,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  const headers = new Headers(call.init.headers);
  for (const absent of ["authorization", "cookie", "idempotency-key"])
    expect(headers.has(absent)).toBe(false);
  expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
    route: "/v1/sponsors/leases",
    action: "lease.list",
    principal_type: "sponsor",
    principal_id: leaseSponsor,
    payload_sha256: await payloadDigest(body),
  });
});

test("a wrong owner, repeated cursor, injected text or oversized lease page fails without private data", async () => {
  let response: unknown;
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  for (const value of [
    { ...leasePage, sponsor_id: "usr_other" },
    { ...leasePage, leases: [leaseSummary, leaseSummary] },
    { ...leasePage, next_cursor: leaseSummary.lease_id },
    { ...leasePage, leases: [{ ...leaseSummary, objective: "PRIVATE_CANARY" }] },
  ]) {
    response = value;
    expect(await stoaSponsorLeases(leaseSponsor, {})).toEqual({ ok: false, reason: "unreachable" });
  }
  response = leasePage;
  expect(await stoaSponsorLeases(leaseSponsor, { after: leaseSummary.lease_id })).toEqual({
    ok: false,
    reason: "unreachable",
  });
  globalThis.fetch = mock(
    async () =>
      new Response("PRIVATE_OVERSIZED_LEASES", {
        headers: { "content-length": String(SPONSOR_LEASE_LIST_MAX_RESPONSE_BYTES + 1) },
      }),
  ) as unknown as typeof fetch;
  expect(await stoaSponsorLeases(leaseSponsor, {})).toEqual({ ok: false, reason: "unreachable" });
});

test("release pins the immutable lease and reuses the exact command after a lost receipt", async () => {
  const calls: RequestInit[] = [];
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    calls.push(init ?? {});
    if (calls.length === 1) throw new Error("The response was lost after commit");
    return Response.json(leaseReceipt);
  }) as unknown as typeof fetch;
  expect(await stoaSponsorReleaseLease(leaseSponsor, leaseTarget)).toEqual({
    ok: false,
    reason: "unreachable",
  });
  expect(await stoaSponsorReleaseLease(leaseSponsor, leaseTarget)).toEqual({
    ok: true,
    data: leaseReceipt,
  });
  const body = JSON.stringify({ problem_id: leaseTarget.problem_id, object: leaseTarget.lease_id });
  for (const call of calls) {
    expect(call.body).toBe(body);
    const headers = new Headers(call.headers);
    expect(headers.get("idempotency-key")).toBe(`console-lease-release-${leaseTarget.lease_id}`);
    expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
      route: "/v1/sponsors/leases/release",
      action: "lease.release",
      principal_id: leaseSponsor,
      payload_sha256: await payloadDigest(body),
    });
    expect(headers.has("cookie")).toBe(false);
  }
});

test("release never accepts a substituted lease, object or acting sponsor receipt", async () => {
  for (const receipt of [
    { ...leaseReceipt, lease_id: `L-${"1".repeat(26)}` },
    { ...leaseReceipt, object: "C-OTHER" },
    { ...leaseReceipt, released_by: "usr_other" },
  ]) {
    globalThis.fetch = mock(async () => Response.json(receipt)) as unknown as typeof fetch;
    expect(await stoaSponsorReleaseLease(leaseSponsor, leaseTarget)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  }
  const fetcher = mock(async () => Response.json(leaseReceipt));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  expect(() =>
    stoaSponsorReleaseLease(leaseSponsor, { ...leaseTarget, lease_id: "C-12" }),
  ).toThrow();
  expect(() => stoaSponsorLeases(leaseSponsor, { after: "../private" })).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
