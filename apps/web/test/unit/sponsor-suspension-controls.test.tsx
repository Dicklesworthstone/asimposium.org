import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import {
  AdminQuarantineCaseDetailSchema,
  type AdminQuarantineCaseDetail,
  AdminSponsorSuspensionReceiptSchema,
  AdminSponsorSuspensionStateSchema,
  type AdminSponsorSuspensionReceipt,
  type AdminSponsorSuspensionState,
} from "@asimposium/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { SponsorSuspensionInput } from "../../app/admin/sponsors/actions";
import type { StoaCall } from "../../lib/stoa";

mock.module("server-only", () => ({}));

const operatorId = "usr_suspension_operator";
const sponsorId = "usr_suspended_fixture";
const caseId = `QC-${"0".repeat(26)}`;
const input: SponsorSuspensionInput = {
  expected_revision: 0, reviewed_case_id: caseId, basis: "egregious-reviewed-case",
  reason: "Reviewed the documented egregious conduct.", confirm_reviewed_egregious_case: true,
};
const receipt = AdminSponsorSuspensionReceiptSchema.parse({
  sponsor_id: sponsorId, revision: 1, status: "suspended", reviewed_case_id: caseId,
  basis: "egregious-reviewed-case", event_id: `SS-${"0".repeat(26)}`,
  audit_event_id: `OA-${"0".repeat(26)}`, applied_at: "2026-10-26T12:00:00.000Z",
  affected: { paused_fellows: 2, revoked_credentials: 3, cancelled_enrollments: 1, cancelled_transfers: 1 },
});
const active = AdminSponsorSuspensionStateSchema.parse({
  sponsor_id: sponsorId, revision: 0, status: "active", suspension: null,
  impact: { active_fellows: 2, unrevoked_credentials: 3, pending_enrollments: 1, pending_transfers: 1 },
});
const suspended = AdminSponsorSuspensionStateSchema.parse({
  sponsor_id: sponsorId, revision: 1, status: "suspended",
  suspension: {
    event_id: receipt.event_id, audit_event_id: receipt.audit_event_id, reviewed_case_id: caseId,
    basis: receipt.basis, reason: "<script>reviewed private reason</script>", applied_at: receipt.applied_at,
  },
  impact: { active_fellows: 0, unrevoked_credentials: 0, pending_enrollments: 0, pending_transfers: 0 },
});
const reviewedCase = AdminQuarantineCaseDetailSchema.parse({
  item: {
    id: caseId, target_id: "claim-fixture", created_at: "2026-10-26T10:00:00.000Z",
    coarse_category: "operational-harm", decision_path: "provider", provider_status: "ok",
    input_digest: "a".repeat(64), context_frontier_digest: "b".repeat(64),
    model_version: "screen-v1", policy_version: "policy-v1", configuration_digest: "c".repeat(64),
    reviewer_state: "pending-operator-review", appeal_status: "adjudicated",
  },
  problem_id: "P-DEMO", route: "promote", fellow_id: "fellow-fixture", sponsor_id: sponsorId,
  outcome: "quarantine", state: "rejected",
  candidate: { kind: "claim", statement: "UNNEEDED_PRIVATE_CANDIDATE", falsifier: null },
  decided_at: "2026-10-26T11:00:00.000Z", decision_reason: "<img src=x onerror=alert(1)> rejected after review",
});

let identity: string | null;
let issuedAt: number | undefined;
let readResult: StoaCall<AdminSponsorSuspensionState>;
let writeResult: StoaCall<AdminSponsorSuspensionReceipt>;
let caseResult: StoaCall<AdminQuarantineCaseDetail>;
let failWrite: boolean;
let failRead: boolean;
const reads: unknown[][] = [];
const writes: unknown[][] = [];
const caseReads: unknown[][] = [];
let realStoa: typeof import("../../lib/stoa");
let realAuth: typeof import("../../auth");
let actions: typeof import("../../app/admin/sponsors/actions");
let admin: typeof import("../../lib/admin");
let page: typeof import("../../app/admin/sponsors/page");
const originalOperators = process.env.OPERATOR_PRINCIPAL_IDS;

beforeAll(async () => {
  realStoa = { ...(await import("../../lib/stoa")) };
  realAuth = { ...(await import("../../auth")) };
  mock.module("@/auth", () => ({
    ...realAuth,
    auth: async () => identity === null ? null : { user: { id: identity }, authIssuedAt: issuedAt },
    signIn: async () => {},
  }));
  mock.module("@/lib/stoa", () => ({
    ...realStoa,
    stoaAdminSponsorSuspension: async (...args: unknown[]) => {
      reads.push(args);
      if (failRead) throw new Error("response lost");
      return readResult;
    },
    stoaSuspendSponsor: async (...args: unknown[]) => {
      writes.push(args);
      if (failWrite) throw new Error("response lost");
      return writeResult;
    },
    stoaAdminQuarantineCase: async (...args: unknown[]) => { caseReads.push(args); return caseResult; },
  }));
  actions = await import("../../app/admin/sponsors/actions");
  admin = await import("../../lib/admin");
  page = await import("../../app/admin/sponsors/page");
});
beforeEach(() => {
  identity = operatorId;
  issuedAt = Math.floor(Date.now() / 1000) - 10;
  process.env.OPERATOR_PRINCIPAL_IDS = operatorId;
  readResult = { ok: true, data: suspended };
  writeResult = { ok: true, data: receipt };
  caseResult = { ok: true, data: reviewedCase };
  failWrite = false;
  failRead = false;
  reads.length = 0;
  writes.length = 0;
  caseReads.length = 0;
});
afterAll(() => {
  mock.module("@/lib/stoa", () => realStoa);
  mock.module("@/auth", () => realAuth);
  if (originalOperators === undefined) delete process.env.OPERATOR_PRINCIPAL_IDS;
  else process.env.OPERATOR_PRINCIPAL_IDS = originalOperators;
});

test("a confirmed decision uses the server identity and time, binds its target and recovers its receipt", async () => {
  const reply = await actions.suspendSponsor(operatorId, sponsorId, input, "exact-decision-key");
  expect(reply).toEqual({ ok: true, receipt, current: suspended });
  const { confirm_reviewed_egregious_case: confirmation, ...command } = input;
  expect(confirmation).toBe(true);
  expect(writes).toEqual([[operatorId, sponsorId,
    { ...command, sponsor_id: sponsorId, step_up_authenticated_at: issuedAt }, "exact-decision-key"]]);
  expect(reads).toEqual([[operatorId, sponsorId]]);
});

test("injected authority, missing confirmation and malformed decisions cannot dispatch", async () => {
  for (const candidate of [
    { ...input, step_up_authenticated_at: 0 }, { ...input, sponsor_id: "usr_another" },
    { ...input, operator_id: "usr_another" }, { ...input, disposition: "strongly-supported" },
    { ...input, confirm_reviewed_egregious_case: false }, { ...input, expected_revision: 1 },
    { ...input, basis: "unreviewed-reports" }, { ...input, reviewed_case_id: "../case" },
    { ...input, reason: "tiny" },
  ]) {
    const result = await actions.suspendSponsor(operatorId, sponsorId, candidate as SponsorSuspensionInput, "same-key");
    expect(result.ok).toBe(false);
  }
  expect((await actions.suspendSponsor(operatorId, "../private", input, "same-key")).ok).toBe(false);
  expect((await actions.suspendSponsor(operatorId, sponsorId, input, "bad key")).ok).toBe(false);
  expect((await actions.suspendSponsor("usr_previous_operator", sponsorId, input, "same-key")).ok).toBe(false);
  expect(writes).toHaveLength(0);
});

test("only the current allowlisted operator with strict recent authentication may write", async () => {
  const now = 1793016000;
  expect(admin.sponsorSuspensionAuthIsRecent(now - 900, now)).toBe(true);
  for (const value of [undefined, now + 1, now - 901, -1, now + 0.5, Number.NaN]) {
    expect(admin.sponsorSuspensionAuthIsRecent(value, now)).toBe(false);
  }
  for (const value of [undefined, Math.floor(Date.now() / 1000) - 901, Math.floor(Date.now() / 1000) + 30]) {
    issuedAt = value;
    const result = await actions.suspendSponsor(operatorId, sponsorId, input, "same-key");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refreshRequired).toBe(true);
  }
  issuedAt = Math.floor(Date.now() / 1000);
  for (const principal of [null, "usr_not_allowlisted"]) {
    identity = principal;
    expect((await actions.suspendSponsor(operatorId, sponsorId, input, "same-key")).ok).toBe(false);
  }
  expect(writes).toHaveLength(0);
});

test("refusals distinguish changed state, authority, missing case and invalid decisions from uncertain writes", async () => {
  for (const [status, message] of [[409, "sponsor state changed"], [403, "Re-authenticate"],
    [404, "screening case is unavailable"], [422, "documented egregious-case reason"]] as const) {
    writeResult = { ok: false, reason: "refused", status };
    const result = await actions.suspendSponsor(operatorId, sponsorId, input, "same-key");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.message).toContain(message);
    }
  }
  for (const failure of [{ ok: false, reason: "unreachable" }, { ok: false, reason: "refused", status: 503 }] as const) {
    writeResult = failure;
    const result = await actions.suspendSponsor(operatorId, sponsorId, input, "same-key");
    if (result.ok) throw new Error("Unconfirmed write became success");
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("original retry key");
  }
  failWrite = true;
  const failed = await actions.suspendSponsor(operatorId, sponsorId, input, "same-key");
  expect(failed.ok).toBe(false);
  if (!failed.ok) expect(failed.retryable).toBe(true);
  expect(reads).toHaveLength(0);
});

test("an immutable receipt stays confirmed when current-state readback fails or is older", async () => {
  for (const current of [{ ok: false, reason: "unreachable" }, { ok: true, data: active }] as const) {
    readResult = current;
    expect(await actions.suspendSponsor(operatorId, sponsorId, input, "same-key"))
      .toEqual({ ok: true, receipt, current: null });
  }
  failRead = true;
  expect(await actions.suspendSponsor(operatorId, sponsorId, input, "same-key"))
    .toEqual({ ok: true, receipt, current: null });
});

test("inspection shows actual account impact, case ownership and separate reviewed confirmation", async () => {
  readResult = { ok: true, data: active };
  const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ sponsor: sponsorId, case: caseId }) }));
  expect(reads).toEqual([[operatorId, sponsorId]]);
  expect(caseReads).toEqual([[operatorId, caseId]]);
  for (const text of ["Active Fellows", "Unrevoked Fellow credentials", "Pending enrollments", "Pending transfers",
    "A rejected submission does not itself suspend its sponsor", "egregious", "Suspend sponsor and revoke credentials", "operational-harm",
    "&lt;img src=x onerror=alert(1)&gt; rejected after review"]) expect(html).toContain(text);
  expect(html).not.toContain("UNNEEDED_PRIVATE_CANDIDATE");
  expect(html).not.toContain("<img src=x");
  expect(html).not.toContain("<fieldset disabled");
  expect(page.metadata.robots).toEqual({ index: false, follow: false });
});

test("wrong-sponsor, pending and missing cases leave suspension disabled", async () => {
  readResult = { ok: true, data: active };
  for (const detail of [
    { ...reviewedCase, sponsor_id: "usr_other" }, { ...reviewedCase, state: "pending" as const },
    { ...reviewedCase, item: { ...reviewedCase.item, id: `QC-${"1".repeat(26)}` } },
  ]) {
    caseResult = { ok: true, data: detail };
    const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ sponsor: sponsorId, case: caseId }) }));
    expect(html).toContain("<fieldset disabled");
    expect(html).not.toContain("I reviewed case <code>QC-");
  }
  expect(writes).toHaveLength(0);
});

test("stale sessions can diagnose standing, but cannot submit another suspension", async () => {
  readResult = { ok: true, data: active };
  issuedAt = Math.floor(Date.now() / 1000) - 1800;
  const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ sponsor: sponsorId, case: caseId }) }));
  expect(html).toContain("Active Fellows");
  expect(html).toContain("<fieldset disabled");
  expect(html).toContain("Re-authenticate with Google");
  expect(reads).toHaveLength(1);
  expect(writes).toHaveLength(0);
});

test("invalid selectors and unauthorized viewers cause no private reads", async () => {
  for (const query of [{ sponsor: [sponsorId, "usr_other"] }, { sponsor: "../private" },
    { sponsor: sponsorId, case: [caseId, caseId] }, { sponsor: sponsorId, extra: "private" }]) {
    const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve(query) }));
    expect(html).toContain("Choose one valid sponsor identifier");
    expect(html).not.toContain("Suspend sponsor and revoke credentials");
  }
  for (const principal of [null, "usr_not_allowlisted"]) {
    identity = principal;
    const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ sponsor: sponsorId, case: caseId }) }));
    expect(html).not.toContain("Sponsor standing at last read");
  }
  expect(reads).toHaveLength(0);
  expect(caseReads).toHaveLength(0);
});

test("unavailable standing never becomes an active account, and suspension reasons remain inert text", async () => {
  readResult = { ok: false, reason: "unreachable" };
  let html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ sponsor: sponsorId }) }));
  expect(html).toContain("Sponsor standing unavailable");
  expect(html).not.toContain("<strong>Active</strong>");
  expect(html).not.toContain("Suspend sponsor and revoke credentials");
  readResult = { ok: true, data: suspended };
  html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ sponsor: sponsorId }) }));
  expect(html).toContain("<strong>Suspended</strong>");
  expect(html).toContain("&lt;script&gt;reviewed private reason&lt;/script&gt;");
  expect(html).not.toContain("<script>reviewed private reason");
  expect(html).not.toContain("Suspend sponsor and revoke credentials");
});
