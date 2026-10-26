import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  ProblemSlowModeRequestSchema,
  ProblemSlowModeReceiptSchema,
  ProblemSlowModeStateSchema,
  PRODUCTION_STOA_ORIGIN,
} from "@asimposium/contracts";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";

mock.module("server-only", () => ({}));
const { stoaChangeProblemSlowMode, stoaProblemSlowMode } = await import("../../lib/stoa");

const principal = "usr_slow_mode_fixture";
const problemId = "P-DEMO";
const command = ProblemSlowModeRequestSchema.parse({
  action: "set", problem_id: problemId, expected_revision: 0, limit_per_hour: 5,
  expires_at: "2026-10-26T13:00:00.000Z", reason: "Review the pending publication backlog.",
  step_up_authenticated_at: 1793016000,
});
const receipt = ProblemSlowModeReceiptSchema.parse({
  action: "set", problem_id: problemId, event_id: `SM-${"0".repeat(26)}`, revision: 1,
  limit_per_hour: 5, expires_at: command.action === "set" ? command.expires_at : "",
  applied_at: "2026-10-26T12:00:00.000Z",
});
const current = ProblemSlowModeStateSchema.parse({
  problem_id: problemId, revision: 1, effective_limit_per_hour: 5,
  slow_mode: {
    event_id: receipt.event_id, revision: 1, limit_per_hour: 5,
    expires_at: receipt.expires_at, reason: command.reason, applied_at: receipt.applied_at,
  },
});
const keys = ["STOA_ORIGIN", "SERVICE_ENVELOPE_PRIVATE_KEY_HEX", "SERVICE_ENVELOPE_KID", "OPERATOR_PRINCIPAL_IDS"] as const;
const realFetch = globalThis.fetch;
let previous: Map<string, string | undefined>;
beforeEach(() => {
  previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "11".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "slow-mode-test";
  process.env.OPERATOR_PRINCIPAL_IDS = principal;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("slow-mode adapters sign exact role, problem-bound body and retry key without cookies", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(init?.method === "GET" ? current : receipt);
  }) as unknown as typeof fetch;
  for (const audience of ["sponsor", "operator"] as const) {
    expect(await stoaProblemSlowMode(principal, audience, problemId)).toEqual({ ok: true, data: current });
    expect(await stoaChangeProblemSlowMode(principal, audience, problemId, command, "same-intent-key"))
      .toEqual({ ok: true, data: receipt });
    const read = calls[calls.length - 2];
    const write = calls[calls.length - 1];
    if (read === undefined || write === undefined) throw new Error("Expected both requests");
    const path = `/v1/${audience}s/problems/P-DEMO/slow-mode`;
    expect(read.url).toBe(`${PRODUCTION_STOA_ORIGIN}${path}`);
    expect(write.url).toBe(read.url);
    expect(read.init.body).toBeUndefined();
    expect(write.init.body).toBe(JSON.stringify(command));
    for (const request of [read, write]) {
      const headers = new Headers(request.init.headers);
      expect(request.init.credentials).toBe("omit");
      expect(request.init.cache).toBe("no-store");
      expect(request.init.redirect).toBe("error");
      expect(headers.has("cookie")).toBe(false);
      expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
        route: `/v1/${audience}s/problems/:problemId/slow-mode`,
        action: `${audience}.problem.slow-mode.${request === read ? "read" : "set"}`,
        principal_type: audience, principal_id: principal,
        payload_sha256: await payloadDigest(request === read ? "" : JSON.stringify(command)),
      });
    }
    expect(new Headers(write.init.headers).get("idempotency-key")).toBe("same-intent-key");
  }
});

test("scope, revision, action and applied settings must match a slow-mode response", async () => {
  let response: unknown = { ...current, problem_id: "P-OTHER" };
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  expect(await stoaProblemSlowMode(principal, "sponsor", problemId)).toEqual({ ok: false, reason: "unreachable" });
  for (const candidate of [
    { ...receipt, problem_id: "P-OTHER" },
    { ...receipt, revision: 2 },
    { ...receipt, limit_per_hour: 6 },
    { ...receipt, expires_at: "2026-10-26T14:00:00.000Z" },
    { ...receipt, action: "clear", limit_per_hour: null, expires_at: null },
  ]) {
    response = candidate;
    expect(await stoaChangeProblemSlowMode(principal, "sponsor", problemId, command, "same-intent-key"))
      .toEqual({ ok: false, reason: "unreachable" });
  }
});

test("cross-problem commands, invalid paths and nonoperators refuse before signing or dispatch", async () => {
  const request = mock(async () => Response.json(receipt));
  globalThis.fetch = request as unknown as typeof fetch;
  expect((await stoaChangeProblemSlowMode(principal, "sponsor", "P-OTHER", command, "same-key")).ok).toBe(false);
  expect((await stoaProblemSlowMode(principal, "sponsor", "../private")).ok).toBe(false);
  expect((await stoaProblemSlowMode("usr_another_sponsor", "operator", problemId)).ok).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
