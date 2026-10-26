import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  AdminSponsorSuspensionReceiptSchema,
  AdminSponsorSuspensionRequestSchema,
  AdminSponsorSuspensionStateSchema,
  SponsorSuspensionStatusSchema,
  PRODUCTION_STOA_ORIGIN,
} from "@asimposium/contracts";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";

mock.module("server-only", () => ({}));
const { stoaAdminSponsorSuspension, stoaSponsorSuspensionStatus, stoaSuspendSponsor } = await import("../../lib/stoa");
const operatorId = "usr_suspension_operator";
const sponsorId = "usr_suspended_fixture";
const command = AdminSponsorSuspensionRequestSchema.parse({
  sponsor_id: sponsorId, expected_revision: 0, reviewed_case_id: `QC-${"0".repeat(26)}`,
  basis: "egregious-reviewed-case", reason: "Reviewed documented egregious conduct.",
  step_up_authenticated_at: 1793016000,
});
const receipt = AdminSponsorSuspensionReceiptSchema.parse({
  sponsor_id: sponsorId, event_id: `SS-${"0".repeat(26)}`, audit_event_id: `OA-${"0".repeat(26)}`,
  revision: 1, status: "suspended", reviewed_case_id: command.reviewed_case_id, basis: command.basis,
  applied_at: "2026-10-26T12:00:00.000Z",
  affected: { paused_fellows: 2, revoked_credentials: 3, cancelled_enrollments: 1, cancelled_transfers: 1 },
});
const standing = AdminSponsorSuspensionStateSchema.parse({
  sponsor_id: sponsorId, revision: 1, status: "suspended",
  suspension: {
    event_id: receipt.event_id, audit_event_id: receipt.audit_event_id,
    reviewed_case_id: command.reviewed_case_id, basis: command.basis,
    reason: command.reason, applied_at: receipt.applied_at,
  },
  impact: { active_fellows: 0, unrevoked_credentials: 0, pending_enrollments: 0, pending_transfers: 0 },
});
const sponsorStanding = SponsorSuspensionStatusSchema.parse({
  sponsor_id: sponsorId, status: "suspended",
  suspension: {
    event_id: receipt.event_id, audit_event_id: receipt.audit_event_id,
    applied_at: receipt.applied_at, appeal: "SPONSOR_APPEAL_AVAILABLE",
  },
});
const environmentKeys = ["STOA_ORIGIN", "SERVICE_ENVELOPE_PRIVATE_KEY_HEX", "SERVICE_ENVELOPE_KID", "OPERATOR_PRINCIPAL_IDS"] as const;
const realFetch = globalThis.fetch;
let previous: Map<string, string | undefined>;
beforeEach(() => {
  previous = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "11".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "suspension-test";
  process.env.OPERATOR_PRINCIPAL_IDS = operatorId;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of environmentKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("operator suspension calls sign the concrete target, reviewed case and original retry key", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(init?.method === "GET" ? standing : receipt);
  }) as unknown as typeof fetch;
  expect(await stoaAdminSponsorSuspension(operatorId, sponsorId)).toEqual({ ok: true, data: standing });
  expect(await stoaSuspendSponsor(operatorId, sponsorId, command, "exact-decision-key"))
    .toEqual({ ok: true, data: receipt });
  expect(calls).toHaveLength(2);
  for (const request of calls) {
    expect(request.url).toBe(`${PRODUCTION_STOA_ORIGIN}/v1/operators/sponsors/${sponsorId}/suspension`);
    const isRead = request.init.method === "GET";
    expect(request.init.body).toBe(isRead ? undefined : JSON.stringify(command));
    expect(request.init.credentials).toBe("omit");
    expect(request.init.cache).toBe("no-store");
    expect(request.init.redirect).toBe("error");
    const headers = new Headers(request.init.headers);
    expect(headers.has("cookie")).toBe(false);
    expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
      route: "/v1/operators/sponsors/:sponsorId/suspension",
      action: `operator.sponsor.suspension.${isRead ? "read" : "suspend"}`,
      principal_type: "operator", principal_id: operatorId,
      payload_sha256: await payloadDigest(isRead ? "" : JSON.stringify(command)),
    });
    if (!isRead) expect(headers.get("idempotency-key")).toBe("exact-decision-key");
  }
});

test("cross-sponsor commands, malformed targets and nonoperators cannot sign or dispatch", async () => {
  const request = mock(async () => Response.json(receipt));
  globalThis.fetch = request as unknown as typeof fetch;
  expect((await stoaSuspendSponsor(operatorId, "usr_another", command, "same-key")).ok).toBe(false);
  expect((await stoaSuspendSponsor(operatorId, sponsorId, command, "bad key")).ok).toBe(false);
  expect((await stoaAdminSponsorSuspension(operatorId, "../private")).ok).toBe(false);
  expect((await stoaSuspendSponsor("usr_nonoperator", sponsorId, command, "same-key")).ok).toBe(false);
  expect((await stoaAdminSponsorSuspension("usr_nonoperator", sponsorId)).ok).toBe(false);
  expect(request).not.toHaveBeenCalled();
});

test("a response cannot substitute a different sponsor, reviewed case or revision", async () => {
  let response: unknown = { ...standing, sponsor_id: "usr_another" };
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  expect(await stoaAdminSponsorSuspension(operatorId, sponsorId)).toEqual({ ok: false, reason: "unreachable" });
  for (const candidate of [
    { ...receipt, sponsor_id: "usr_another" }, { ...receipt, reviewed_case_id: `QC-${"1".repeat(26)}` },
    { ...receipt, revision: 2 }, { ...receipt, basis: "unreviewed-report" }, { ...receipt, status: "active" },
    { ...receipt, affected: { ...receipt.affected, revoked_credentials: -1 } },
  ]) {
    response = candidate;
    expect(await stoaSuspendSponsor(operatorId, sponsorId, command, "same-key"))
      .toEqual({ ok: false, reason: "unreachable" });
  }
});

test("a lost response can be retried with the same signed intent and idempotency key", async () => {
  const bodies: string[] = [];
  const keys: (string | null)[] = [];
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    keys.push(new Headers(init?.headers).get("idempotency-key"));
    if (bodies.length === 1) throw new Error("response lost after possible commit");
    return Response.json(receipt);
  }) as unknown as typeof fetch;
  expect(await stoaSuspendSponsor(operatorId, sponsorId, command, "recover-this-decision"))
    .toEqual({ ok: false, reason: "unreachable" });
  expect(await stoaSuspendSponsor(operatorId, sponsorId, command, "recover-this-decision"))
    .toEqual({ ok: true, data: receipt });
  expect(bodies).toEqual([JSON.stringify(command), JSON.stringify(command)]);
  expect(keys).toEqual(["recover-this-decision", "recover-this-decision"]);
});

test("the affected sponsor receives only their coarse standing through a sponsor-signed read", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: String(url), init: init ?? {} };
    return Response.json(sponsorStanding);
  }) as unknown as typeof fetch;
  expect(await stoaSponsorSuspensionStatus(sponsorId)).toEqual({ ok: true, data: sponsorStanding });
  expect(request?.url).toBe(`${PRODUCTION_STOA_ORIGIN}/v1/sponsors/account/suspension`);
  const headers = new Headers(request?.init.headers);
  expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
    route: "/v1/sponsors/account/suspension", action: "sponsor.account.suspension.read",
    principal_type: "sponsor", principal_id: sponsorId, payload_sha256: await payloadDigest(""),
  });
  expect(request?.init.cache).toBe("no-store");
  expect(request?.init.credentials).toBe("omit");
  for (const bad of [
    { ...sponsorStanding, sponsor_id: "usr_another" },
    { ...sponsorStanding, suspension: { ...sponsorStanding.suspension, reason: "PRIVATE_REASON" } },
  ]) {
    globalThis.fetch = mock(async () => Response.json(bad)) as unknown as typeof fetch;
    expect(await stoaSponsorSuspensionStatus(sponsorId)).toEqual({ ok: false, reason: "unreachable" });
  }
});
