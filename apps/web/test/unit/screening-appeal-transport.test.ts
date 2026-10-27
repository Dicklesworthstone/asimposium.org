import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import {
  OperatorScreeningAppealsResponseSchema,
  SCREENING_APPEALS_MAX_RESPONSE_BYTES,
} from "@asimposium/contracts/appeals";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";

mock.module("server-only", () => ({}));
const {
  stoaScreeningCases,
  stoaScreeningAppeals,
  stoaSubmitScreeningAppeal,
  stoaDecideScreeningAppeal,
} = await import("../../lib/moderation-appeals");
const sponsor = "usr_appeal_sponsor",
  operator = "usr_appeal_operator",
  caseId = `QC-${"0".repeat(26)}`,
  appealId = `AP-${"0".repeat(26)}`;
const command = {
  case_id: caseId,
  statement: "Please reconsider the exact mathematical scope of this held candidate.",
};
const receipt = {
  appeal_id: appealId,
  case_id: caseId,
  state: "pending" as const,
  submitted_at: "2026-10-27T12:00:00.000Z",
  decided_at: null,
  audit_event_id: null,
};
const operatorItem = {
  ...receipt,
  sponsor_id: sponsor,
  fellow_id: "fellow-appeal",
  problem_id: "P-APPEAL",
  statement: command.statement,
  original_operator_id: "usr_original_operator",
};
const ownCase = {
  case_id: caseId,
  problem_id: "P-APPEAL",
  fellow_id: "fellow-appeal",
  route: "promote",
  state: "rejected",
  created_at: receipt.submitted_at,
  appeal: receipt,
};
const decision = {
  appeal_id: appealId,
  decision: "release" as const,
  reason: "Reviewed the precise candidate and original rejection independently.",
  step_up_authenticated_at: Math.floor(Date.now() / 1000),
};
const released = {
  ...receipt,
  state: "released" as const,
  decided_at: "2026-10-27T12:01:00.000Z",
  audit_event_id: `OA-${"0".repeat(26)}`,
};
const keys = [
  "STOA_ORIGIN",
  "SERVICE_ENVELOPE_PRIVATE_KEY_HEX",
  "SERVICE_ENVELOPE_KID",
  "OPERATOR_PRINCIPAL_IDS",
] as const;
const realFetch = globalThis.fetch;
let previous: Map<string, string | undefined>;
beforeEach(() => {
  previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "11".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "appeal-transport-test";
  process.env.OPERATOR_PRINCIPAL_IDS = operator;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("owner lookup and appeal commands sign exact human route, target, body and retry key", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(init?.method === "GET" ? { cases: [ownCase], has_more: false } : receipt);
  }) as unknown as typeof fetch;
  expect((await stoaScreeningCases(sponsor, caseId)).ok).toBe(true);
  expect(await stoaSubmitScreeningAppeal(sponsor, command, "retain-appeal-key")).toEqual({
    ok: true,
    data: receipt,
  });
  for (const entry of calls) {
    const get = entry.init.method === "GET",
      headers = new Headers(entry.init.headers);
    expect(entry.url).toBe(
      `${PRODUCTION_STOA_ORIGIN}/v1/sponsors/${get ? `screening-cases/${caseId}` : "screening-appeals"}`,
    );
    expect(entry.init.credentials).toBe("omit");
    expect(entry.init.cache).toBe("no-store");
    expect(entry.init.redirect).toBe("error");
    expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
      principal_id: sponsor,
      principal_type: "sponsor",
      route: get ? "/v1/sponsors/screening-cases/:caseId" : "/v1/sponsors/screening-appeals",
      action: get ? "sponsor.screening-cases.read" : "sponsor.screening-appeals.submit",
      payload_sha256: await payloadDigest(get ? "" : JSON.stringify(command)),
    });
    if (!get) expect(headers.get("idempotency-key")).toBe("retain-appeal-key");
  }
});

test("operator decisions use independent human authority and preserve ambiguous retry intent", async () => {
  const calls: RequestInit[] = [];
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    if (calls.length === 1) throw new Error("Lost response after commit");
    return Response.json(released);
  }) as unknown as typeof fetch;
  expect(await stoaDecideScreeningAppeal(operator, decision, "retained-decision-key")).toEqual({
    ok: false,
    reason: "unreachable",
  });
  expect(await stoaDecideScreeningAppeal(operator, decision, "retained-decision-key")).toEqual({
    ok: true,
    data: released,
  });
  for (const call of calls) {
    expect(call.body).toBe(JSON.stringify(decision));
    const headers = new Headers(call.headers);
    expect(headers.get("idempotency-key")).toBe("retained-decision-key");
    expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
      principal_type: "operator",
      principal_id: operator,
      action: "operator.screening-appeals.decide",
      route: "/v1/operators/screening-appeals/decision",
    });
  }
});

test("a valid full page of maximum Unicode and escaped control statements remains reviewable", async () => {
  for (const statement of ["数".repeat(2000), "\u0001".repeat(2000)]) {
    const page = OperatorScreeningAppealsResponseSchema.parse({
      appeals: Array.from({ length: 50 }, (_, i) => ({
        ...operatorItem,
        appeal_id: `AP-${String(i).padStart(26, "0")}`,
        statement,
      })),
      has_more: true,
    });
    const size = new TextEncoder().encode(JSON.stringify(page)).byteLength;
    expect(size).toBeGreaterThan(160_000);
    expect(size).toBeLessThan(SCREENING_APPEALS_MAX_RESPONSE_BYTES);
    globalThis.fetch = mock(async () => Response.json(page)) as unknown as typeof fetch;
    const result = await stoaScreeningAppeals(operator);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.appeals[49]?.statement).toBe(statement);
  }
});

test("malformed identifiers, caller-invented authority and nonoperators never dispatch", async () => {
  const fetcher = mock(async () => Response.json(receipt));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  expect((await stoaScreeningCases(sponsor, "../private")).ok).toBe(false);
  expect((await stoaScreeningAppeals(operator, "../private")).ok).toBe(false);
  expect((await stoaScreeningAppeals(sponsor)).ok).toBe(false);
  expect(
    (
      await stoaSubmitScreeningAppeal(
        sponsor,
        { ...command, sponsor_id: "usr_other" } as typeof command,
        "key",
      )
    ).ok,
  ).toBe(false);
  expect((await stoaDecideScreeningAppeal(operator, decision, "bad key")).ok).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});

test("exact case reads and decision receipts reject substituted targets and outcomes", async () => {
  let body: unknown = { cases: [{ ...ownCase, case_id: `QC-${"1".repeat(26)}` }], has_more: false };
  globalThis.fetch = mock(async () => Response.json(body)) as unknown as typeof fetch;
  expect(await stoaScreeningCases(sponsor, caseId)).toEqual({ ok: false, reason: "unreachable" });
  body = { appeals: [{ ...operatorItem, appeal_id: `AP-${"1".repeat(26)}` }], has_more: false };
  expect(await stoaScreeningAppeals(operator, appealId)).toEqual({
    ok: false,
    reason: "unreachable",
  });
  body = { ...released, state: "upheld" };
  expect(await stoaDecideScreeningAppeal(operator, decision, "decision-key")).toEqual({
    ok: false,
    reason: "unreachable",
  });
});
