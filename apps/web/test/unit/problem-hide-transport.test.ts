import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  PRODUCTION_STOA_ORIGIN,
  SponsorProblemHideReceiptSchema,
  SponsorProblemHideRequestSchema,
} from "@asimposium/contracts";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";

mock.module("server-only", () => ({}));
const { stoaHideProblem } = await import("../../lib/stoa");

const principal = "usr_hide_fixture";
const command = SponsorProblemHideRequestSchema.parse({
  problem_id: "P-HIDE",
  reason: "Withdraw this problem from public display.",
  step_up_authenticated_at: 1794398400,
});
const receipt = SponsorProblemHideReceiptSchema.parse({
  ok: true,
  problem_id: command.problem_id,
  action: "hide",
  visibility: "hidden",
  actor_kind: "sponsor",
  control_id: `CC-${"0".repeat(26)}`,
  version: 1,
  applied_at: "2026-11-11T12:00:00.000Z",
});
const keys = [
  "STOA_ORIGIN", "SERVICE_ENVELOPE_PRIVATE_KEY_HEX", "SERVICE_ENVELOPE_KID",
] as const;
const realFetch = globalThis.fetch;
let previous: Map<string, string | undefined>;
beforeEach(() => {
  previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "11".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "problem-hide-test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("hide signs exact owner identity, path, body and retry key without cookies", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(receipt);
  }) as unknown as typeof fetch;
  expect(await stoaHideProblem(principal, command.problem_id, command, "same-hide-key"))
    .toEqual({ ok: true, data: receipt });
  expect(calls).toHaveLength(1);
  const request = calls[0];
  if (request === undefined) throw new Error("Expected the signed request");
  const path = "/v1/sponsors/problems/P-HIDE/hide";
  expect(request.url).toBe(PRODUCTION_STOA_ORIGIN + path);
  expect(request.init.body).toBe(JSON.stringify(command));
  expect(request.init.credentials).toBe("omit");
  expect(request.init.cache).toBe("no-store");
  expect(request.init.redirect).toBe("error");
  const headers = new Headers(request.init.headers);
  expect(headers.has("cookie")).toBe(false);
  expect(headers.has("authorization")).toBe(false);
  expect(headers.get("idempotency-key")).toBe("same-hide-key");
  expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
    route: path,
    action: "problem.hide",
    principal_type: "sponsor",
    principal_id: principal,
    payload_sha256: await payloadDigest(JSON.stringify(command)),
  });
});

test("hide refuses path mismatches and invalid keys before any signing transport", async () => {
  const fetchMock = mock(async () => Response.json(receipt));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  expect((await stoaHideProblem(principal, "P-OTHER", command, "same-hide-key")).ok).toBe(false);
  expect((await stoaHideProblem(principal, command.problem_id, command, "bad key")).ok).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("hide rejects responses for another target, authority, action or private-data shape", async () => {
  let body: unknown = receipt;
  globalThis.fetch = mock(async () => Response.json(body)) as unknown as typeof fetch;
  for (const candidate of [
    { ...receipt, problem_id: "P-OTHER" },
    { ...receipt, actor_kind: "operator" },
    { ...receipt, action: "restore" },
    { ...receipt, visibility: "visible" },
    { ...receipt, reason: command.reason },
  ]) {
    body = candidate;
    expect(await stoaHideProblem(principal, command.problem_id, command, "same-hide-key"))
      .toEqual({ ok: false, reason: "unreachable" });
  }
});
