import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN, type SaveProblemBriefRequest } from "@asimposium/contracts";
import { problemBriefFields, problemBriefRequest } from "../../lib/problem-briefs";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";
import { briefSponsor, privateBrief } from "../fixtures/problem-briefs";

mock.module("server-only", () => ({}));
const { stoaSaveProblemBrief, stoaWithdrawProblemBrief } = await import("../../lib/stoa");
const envKeys = [
  "STOA_ORIGIN",
  "SERVICE_ENVELOPE_PRIVATE_KEY_HEX",
  "SERVICE_ENVELOPE_KID",
] as const;
const realFetch = globalThis.fetch;
let previous: Map<string, string | undefined>;
const receipt = { ...privateBrief, version: 5, updated_at: "2026-11-03T00:00:00.000Z" };

beforeEach(() => {
  previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "19".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "brief-transport-test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function edit(): SaveProblemBriefRequest {
  const request = problemBriefRequest(problemBriefFields(privateBrief), privateBrief);
  if (request === null) throw new Error("Expected a full brief edit");
  return request;
}

test("save and withdrawal sign the exact target, version-pinned body and retry identity", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(
      String(url).endsWith("/withdraw")
        ? { withdrawn: true, id: privateBrief.id, version: 5 }
        : { brief: receipt },
    );
  }) as unknown as typeof fetch;
  const request = edit();
  expect(await stoaSaveProblemBrief(briefSponsor, request, "console-save-stable")).toEqual({
    ok: true,
    data: receipt,
  });
  expect(
    await stoaWithdrawProblemBrief(
      briefSponsor,
      privateBrief.id,
      { expected_version: 4 },
      "console-withdraw-stable",
    ),
  ).toEqual({ ok: true, data: { withdrawn: true, id: privateBrief.id, version: 5 } });
  for (const call of calls) {
    const withdrawal = call.url.endsWith("/withdraw");
    const path = `/v1/sponsors/problem-briefs${withdrawal ? `/${privateBrief.id}/withdraw` : ""}`;
    const body = withdrawal ? JSON.stringify({ expected_version: 4 }) : JSON.stringify(request);
    const headers = new Headers(call.init.headers);
    expect(call.url).toBe(PRODUCTION_STOA_ORIGIN + path);
    expect(call.init).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    expect(call.init.body).toBe(body);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("idempotency-key")).toBe(
      withdrawal ? "console-withdraw-stable" : "console-save-stable",
    );
    expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
      route: path,
      principal_type: "sponsor",
      principal_id: briefSponsor,
      action: withdrawal ? "withdraw-problem-brief" : "save-problem-brief",
      payload_sha256: await payloadDigest(body),
    });
  }
});

test("an uncertain save retries identical content and key while using a fresh signed envelope", async () => {
  const sent: RequestInit[] = [];
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(init ?? {});
    if (sent.length === 1) throw new Error("PRIVATE_TRANSPORT_FAILURE");
    return Response.json({ brief: receipt });
  }) as unknown as typeof fetch;
  const request = edit();
  expect(await stoaSaveProblemBrief(briefSponsor, request, "console-exact-retry")).toEqual({
    ok: false,
    reason: "unreachable",
  });
  expect(await stoaSaveProblemBrief(briefSponsor, request, "console-exact-retry")).toEqual({
    ok: true,
    data: receipt,
  });
  expect(sent).toHaveLength(2);
  expect(sent[0]?.body).toBe(sent[1]?.body);
  const first = new Headers(sent[0]?.headers);
  const second = new Headers(sent[1]?.headers);
  expect(first.get("idempotency-key")).toBe(second.get("idempotency-key"));
  expect(first.get(SERVICE_ENVELOPE_HEADER)).not.toBe(second.get(SERVICE_ENVELOPE_HEADER));
});

test("schema-valid receipts from another sponsor, target or version are never displayed as success", async () => {
  let response: unknown;
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  for (const candidate of [
    { ...receipt, sponsor_id: "usr_fedcba0987654321" },
    { ...receipt, id: "brief-other" },
    { ...receipt, version: 6 },
    { ...receipt, status: "adopted" },
    { ...receipt, hidden_private_field: "UNRELATED_PRIVATE_BYTES" },
  ]) {
    response = { brief: candidate };
    expect(await stoaSaveProblemBrief(briefSponsor, edit(), "console-save")).toEqual({
      ok: false,
      reason: "unreachable",
    });
  }
  for (const candidate of [
    { withdrawn: true, id: "brief-other", version: 5 },
    { withdrawn: true, id: privateBrief.id, version: 6 },
    { withdrawn: false, id: privateBrief.id, version: 5 },
  ]) {
    response = candidate;
    expect(
      await stoaWithdrawProblemBrief(
        briefSponsor,
        privateBrief.id,
        { expected_version: 4 },
        "console-withdraw",
      ),
    ).toEqual({ ok: false, reason: "unreachable" });
  }
});

test("withdrawal preserves opaque IDs in the signed route and malformed commands never dispatch", async () => {
  const id = "brief/with spaces?fragment#%";
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json({ withdrawn: true, id, version: 5 });
  }) as unknown as typeof fetch;
  expect(
    await stoaWithdrawProblemBrief(briefSponsor, id, { expected_version: 4 }, "console-opaque"),
  ).toEqual({ ok: true, data: { withdrawn: true, id, version: 5 } });
  const path = `/v1/sponsors/problem-briefs/${encodeURIComponent(id)}/withdraw`;
  expect(calls[0]?.url).toBe(PRODUCTION_STOA_ORIGIN + path);
  const headers = new Headers(calls[0]?.init.headers);
  expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims.route).toBe(path);
  calls.length = 0;
  expect(() =>
    stoaWithdrawProblemBrief(briefSponsor, id, { expected_version: 0 }, "console-invalid"),
  ).toThrow();
  expect(() =>
    stoaSaveProblemBrief(
      briefSponsor,
      { ...edit(), sponsor_id: "usr_other" } as SaveProblemBriefRequest,
      "console-invalid",
    ),
  ).toThrow();
  expect(
    (await stoaWithdrawProblemBrief(briefSponsor, "", { expected_version: 4 }, "console-invalid"))
      .ok,
  ).toBe(false);
  expect(calls).toHaveLength(0);
});
