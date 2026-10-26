import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";
import {
  accessMemberCommand, accessMemberReceipt, accessModeCommand, accessModeReceipt,
  accessProblem, accessSponsor, accessWorkspace,
} from "../fixtures/problem-governance";

mock.module("server-only", () => ({}));
const { stoaProblemGovernance, stoaChangeProblemAccess } = await import("../../lib/problem-governance");
const envKeys = ["STOA_ORIGIN", "SERVICE_ENVELOPE_PRIVATE_KEY_HEX", "SERVICE_ENVELOPE_KID"] as const;
const realFetch = globalThis.fetch;
let previous: Map<string, string | undefined>;
beforeEach(() => {
  previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "14".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "problem-access-test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("governance reads sign the filled path, preserve a bounded cursor and omit browser credentials", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(accessWorkspace);
  }) as unknown as typeof fetch;
  expect(await stoaProblemGovernance(accessSponsor, accessProblem, { after: "fellow-access-0" }))
    .toEqual({ ok: true, data: accessWorkspace });
  const call = calls[0]!;
  const route = `/v1/sponsors/problems/${accessProblem}/governance/after/fellow-access-0`;
  expect(call.url).toBe(`${PRODUCTION_STOA_ORIGIN}${route}`);
  expect(call.init).toMatchObject({ method: "GET", credentials: "omit", cache: "no-store", redirect: "error" });
  const headers = new Headers(call.init.headers);
  expect(headers.has("cookie")).toBe(false);
  expect(headers.has("authorization")).toBe(false);
  expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
    route, principal_type: "sponsor", principal_id: accessSponsor,
    action: "problem-governance-read", payload_sha256: await payloadDigest(""),
  });
  expect(call.init.body).toBeUndefined();
});

test("accepted mode and membership changes require the exact signed command receipt", async () => {
  let expected: unknown;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json({ governance_action: expected });
  }) as unknown as typeof fetch;
  for (const [command, receipt] of [[accessModeCommand, accessModeReceipt], [accessMemberCommand, accessMemberReceipt]] as const) {
    expected = receipt;
    expect(await stoaChangeProblemAccess(accessSponsor, accessProblem, command, "console-access-retry-key"))
      .toEqual({ ok: true, data: receipt });
    const call = calls.at(-1)!;
    const path = `/v1/sponsors/problems/${accessProblem}/lifecycle`;
    const body = JSON.stringify(command);
    expect(call.url).toBe(`${PRODUCTION_STOA_ORIGIN}${path}`);
    expect(call.init.body).toBe(body);
    expect(call.init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store" });
    const headers = new Headers(call.init.headers);
    expect(headers.get("idempotency-key")).toBe("console-access-retry-key");
    expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
      route: path, principal_type: "sponsor", principal_id: accessSponsor,
      action: "problem-lifecycle", payload_sha256: await payloadDigest(body),
    });
  }
});

test("non-access commands, implicit roles, injected authority and invalid targets never dispatch", async () => {
  const fetcher = mock(async () => Response.json({ governance_action: accessModeReceipt }));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  for (const target of ["../private", "P-ACCESS\n", "P-X?another=1"]) {
    expect((await stoaProblemGovernance(accessSponsor, target)).ok).toBe(false);
    expect((await stoaChangeProblemAccess(accessSponsor, target, accessModeCommand, "key")).ok).toBe(false);
  }
  for (const command of [
    { action: "set-writer-cap", writer_cap: 1 }, { action: "manage-steward", operation: "add", target_sponsor_id: accessSponsor },
    { ...accessMemberCommand, role: undefined }, { ...accessMemberCommand, role: "steward" },
    { ...accessMemberCommand, operation: "remove" }, { ...accessModeCommand, mode: "invented" },
    { ...accessModeCommand, sponsor_id: accessSponsor },
  ]) {
    expect((await stoaChangeProblemAccess(accessSponsor, accessProblem,
      command as Parameters<typeof stoaChangeProblemAccess>[2], "key")).ok).toBe(false);
  }
  for (const key of ["", "key\n", "bad key"]) {
    expect((await stoaChangeProblemAccess(accessSponsor, accessProblem, accessModeCommand, key)).ok).toBe(false);
  }
  for (const query of [{ after: "" }, { after: "a".repeat(129) }, { after: ["a", "b"] }, { limit: 1000 }]) {
    expect((await stoaProblemGovernance(accessSponsor, accessProblem,
      query as Parameters<typeof stoaProblemGovernance>[2])).ok).toBe(false);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

test("a successful HTTP response cannot substitute another problem, principal, member, role or mode", async () => {
  let response: unknown;
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  for (const changed of [
    { problem_id: "P-OTHER" }, { acting_sponsor_id: "usr_fedcba0987654321" },
    { target_fellow_id: "fellow-wrong" }, { role: "contributor" }, { operation: "remove", role: null },
  ]) {
    response = { governance_action: { ...accessMemberReceipt, ...changed } };
    expect(await stoaChangeProblemAccess(accessSponsor, accessProblem, accessMemberCommand, "key"))
      .toEqual({ ok: false, reason: "unreachable" });
  }
  response = { governance_action: { ...accessModeReceipt, mode: "open" } };
  expect(await stoaChangeProblemAccess(accessSponsor, accessProblem, accessModeCommand, "key"))
    .toEqual({ ok: false, reason: "unreachable" });
  response = { problem: accessWorkspace.problem };
  expect(await stoaChangeProblemAccess(accessSponsor, accessProblem, accessModeCommand, "key"))
    .toEqual({ ok: false, reason: "unreachable" });
});

test("removal is confirmed only by a receipt with that Fellow and a null replacement role", async () => {
  const command = { action: "manage-member", operation: "remove", target_fellow_id: "fellow-access-c" } as const;
  const receipt = { ...accessMemberReceipt, ...command, role: null };
  globalThis.fetch = mock(async () => Response.json({ governance_action: receipt })) as unknown as typeof fetch;
  expect(await stoaChangeProblemAccess(accessSponsor, accessProblem, command, "remove-key"))
    .toEqual({ ok: true, data: receipt });
});

test("governance pages reject scope mismatches, false totals, duplicate members and misleading cursors", async () => {
  let response: unknown;
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  for (const changed of [
    { acting_sponsor_id: "usr_fedcba0987654321" }, { problem: { ...accessWorkspace.problem, id: "P-OTHER" } },
    { member_counts: { ...accessWorkspace.member_counts, total: 999 } },
    { members: [accessWorkspace.members[0], accessWorkspace.members[0]] },
    { has_more: true, next_after: "fellow-access-b" }, { next_after: "fellow-access-b" },
  ]) {
    response = { ...accessWorkspace, ...changed };
    expect(await stoaProblemGovernance(accessSponsor, accessProblem)).toEqual({ ok: false, reason: "unreachable" });
  }
  response = accessWorkspace;
  expect(await stoaProblemGovernance(accessSponsor, accessProblem, { after: "fellow-access-a" }))
    .toEqual({ ok: false, reason: "unreachable" });
});

test("private roster bodies have a response bound and never leak through failure results", async () => {
  globalThis.fetch = mock(async () => new Response("PRIVATE_MEMBER_RESPONSE", {
    status: 200, headers: { "content-length": String(262_145) },
  })) as unknown as typeof fetch;
  const result = await stoaProblemGovernance(accessSponsor, accessProblem);
  expect(result).toEqual({ ok: false, reason: "unreachable" });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_MEMBER_RESPONSE");
});
