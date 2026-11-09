import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";
import { accessProblem, accessSponsor } from "../fixtures/problem-governance";
import {
  stewardshipCommand,
  stewardshipReceipt,
  stewardshipWorkspace,
  stewardTarget,
} from "../fixtures/problem-stewardship";

mock.module("server-only", () => ({}));
const { stoaChangeProblemStewardship, stoaProblemGovernance } = await import(
  "../../lib/problem-governance"
);
const realFetch = globalThis.fetch;
const keys = ["STOA_ORIGIN", "SERVICE_ENVELOPE_PRIVATE_KEY_HEX", "SERVICE_ENVELOPE_KID"] as const;
let previous: Map<string, string | undefined>;
beforeEach(() => {
  previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "14".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "stewardship-test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("signed stewardship commands bind the target, operation, reviewed roster and retained retry key", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json({ governance_action: stewardshipReceipt });
  }) as unknown as typeof fetch;
  expect(
    await stoaChangeProblemStewardship(
      accessSponsor,
      accessProblem,
      stewardshipCommand,
      "exact-stewardship-key",
    ),
  ).toEqual({ ok: true, data: stewardshipReceipt });
  const call = calls[0];
  if (!call) throw new Error("Missing signed dispatch");
  const route = `/v1/sponsors/problems/${accessProblem}/lifecycle`;
  const body = JSON.stringify(stewardshipCommand);
  expect(call.url).toBe(`${PRODUCTION_STOA_ORIGIN}${route}`);
  expect(call.init).toMatchObject({
    method: "POST",
    body,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  const headers = new Headers(call.init.headers);
  expect(headers.get("idempotency-key")).toBe("exact-stewardship-key");
  expect(headers.has("cookie")).toBe(false);
  expect(headers.has("authorization")).toBe(false);
  expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
    route,
    action: "problem-lifecycle",
    principal_type: "sponsor",
    principal_id: accessSponsor,
    payload_sha256: await payloadDigest(body),
  });
});

test("receipt substitution or unpinned input never becomes a confirmed stewardship decision", async () => {
  let response: unknown;
  const fetcher = mock(async () => Response.json(response));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  expect(
    await stoaChangeProblemStewardship(
      accessSponsor,
      accessProblem,
      {
        ...stewardshipCommand,
        expected_stewardship_version: undefined,
      } as unknown as typeof stewardshipCommand,
      "key",
    ),
  ).toMatchObject({ ok: false });
  expect(fetcher).not.toHaveBeenCalled();
  for (const change of [
    { acting_sponsor_id: stewardTarget },
    { problem_id: "P-OTHER" },
    { operation: "add" },
    { target_sponsor_id: accessSponsor },
    { expected_stewardship_version: 8 },
    { expected_stewardship_version: null },
  ]) {
    response = { governance_action: { ...stewardshipReceipt, ...change } };
    expect(
      await stoaChangeProblemStewardship(accessSponsor, accessProblem, stewardshipCommand, "key"),
    ).toEqual({ ok: false, reason: "unreachable" });
  }
});

test("independent steward pagination is part of the exact signed read route", async () => {
  if (!stewardshipWorkspace.stewardship) throw new Error("Missing fixture stewardship");
  const page = {
    ...stewardshipWorkspace,
    stewardship: {
      ...stewardshipWorkspace.stewardship,
      total_count: 2,
      stewards: [
        {
          sponsor_id: stewardTarget,
          is_founding: false,
          created_at: stewardshipReceipt.updated_at,
        },
      ],
    },
  };
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(page);
  }) as unknown as typeof fetch;
  for (const query of [
    { steward_after: accessSponsor },
    { after: "F-ONE", steward_after: accessSponsor },
  ]) {
    expect(await stoaProblemGovernance(accessSponsor, accessProblem, query)).toEqual({
      ok: true,
      data: page,
    });
    const call = calls.at(-1);
    if (!call) throw new Error("Missing signed read");
    const route = `/v1/sponsors/problems/${accessProblem}/governance${query.after === undefined ? "" : `/after/${query.after}`}/stewards/after/${accessSponsor}`;
    expect(call.url).toBe(`${PRODUCTION_STOA_ORIGIN}${route}`);
    expect(
      JSON.parse(new Headers(call.init.headers).get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims,
    ).toMatchObject({ route, action: "problem-governance-read" });
  }
});

test("bounded roster parsing refuses duplicates and misleading continuations instead of inventing current authority", async () => {
  const roster = stewardshipWorkspace.stewardship;
  if (!roster) throw new Error("Missing fixture stewardship");
  let response: unknown;
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  for (const change of [
    { total_count: 0 },
    { stewards: [...roster.stewards, ...roster.stewards] },
    { next_after: accessSponsor },
    { has_more: true, next_after: accessSponsor },
  ]) {
    response = { ...stewardshipWorkspace, stewardship: { ...roster, ...change } };
    expect(await stoaProblemGovernance(accessSponsor, accessProblem)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  }
  response = stewardshipWorkspace;
  expect(
    await stoaProblemGovernance(accessSponsor, accessProblem, { steward_after: accessSponsor }),
  ).toEqual({ ok: false, reason: "unreachable" });
});
