import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import {
  ProblemSlowModeReceiptSchema,
  ProblemSlowModeStateSchema,
  type ProblemSlowModeReceipt,
  type ProblemSlowModeState,
} from "@asimposium/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { SlowModeInput } from "../../app/console/slow-mode/actions";
import type { StoaCall } from "../../lib/stoa";

mock.module("server-only", () => ({}));

const principal = "usr_slow_mode_human";
const problemId = "P-DEMO";
const input: SlowModeInput = {
  action: "set", expected_revision: 1, limit_per_hour: 5,
  expires_at: "2026-10-26T13:00:00.000Z", reason: "Review the publication backlog.",
};
const receipt = ProblemSlowModeReceiptSchema.parse({
  action: "set", problem_id: problemId, event_id: `SM-${"0".repeat(26)}`, revision: 2,
  limit_per_hour: 5, expires_at: "2026-10-26T13:00:00.000Z", applied_at: "2026-10-26T12:00:00.000Z",
});
const active = ProblemSlowModeStateSchema.parse({
  problem_id: problemId, revision: 2, effective_limit_per_hour: 5,
  slow_mode: {
    event_id: receipt.event_id, revision: 2, limit_per_hour: 5,
    expires_at: receipt.expires_at, applied_at: receipt.applied_at,
    reason: "<script>review backlog</script>",
  },
});
let identity: string | null;
let issuedAt: number | undefined;
let readResult: StoaCall<ProblemSlowModeState>;
let writeResult: StoaCall<ProblemSlowModeReceipt>;
const reads: unknown[][] = [];
const writes: unknown[][] = [];
let realStoa: typeof import("../../lib/stoa");
let realAuth: typeof import("../../auth");
let actions: typeof import("../../app/console/slow-mode/actions");
let sessionHelpers: typeof import("../../lib/problem-slow-mode");
let page: typeof import("../../components/problem-slow-mode-page");
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
    stoaProblemSlowMode: async (...args: unknown[]) => { reads.push(args); return readResult; },
    stoaChangeProblemSlowMode: async (...args: unknown[]) => { writes.push(args); return writeResult; },
  }));
  actions = await import("../../app/console/slow-mode/actions");
  sessionHelpers = await import("../../lib/problem-slow-mode");
  page = await import("../../components/problem-slow-mode-page");
});
beforeEach(() => {
  identity = principal;
  issuedAt = Math.floor(Date.now() / 1_000) - 10;
  process.env.OPERATOR_PRINCIPAL_IDS = principal;
  readResult = { ok: true, data: active };
  writeResult = { ok: true, data: receipt };
  reads.length = 0;
  writes.length = 0;
});
afterAll(() => {
  mock.module("@/lib/stoa", () => realStoa);
  mock.module("@/auth", () => realAuth);
  if (originalOperators === undefined) delete process.env.OPERATOR_PRINCIPAL_IDS;
  else process.env.OPERATOR_PRINCIPAL_IDS = originalOperators;
});

test("human commands derive principal, concrete problem and recent auth from the server session", async () => {
  for (const audience of ["sponsor", "operator"] as const) {
    const reply = await actions.changeProblemSlowMode(audience, problemId, input, "exact-command-key");
    expect(reply).toEqual({ ok: true, receipt, current: active });
    expect(writes.at(-1)).toEqual([
      principal, audience, problemId,
      { ...input, problem_id: problemId, step_up_authenticated_at: issuedAt },
      "exact-command-key",
    ]);
    expect(reads.at(-1)).toEqual([principal, audience, problemId]);
  }
});

test("forged identity/auth fields, malformed commands and unauthorized operators never dispatch", async () => {
  for (const command of [
    { ...input, step_up_authenticated_at: 0 },
    { ...input, problem_id: "P-OTHER" },
    { ...input, principal_id: "usr_other" },
    { ...input, limit_per_hour: 20 },
    { ...input, reason: "tiny" },
    { ...input, expected_revision: -1 },
  ]) {
    expect((await actions.changeProblemSlowMode("sponsor", problemId, command as SlowModeInput, "same-key")).ok).toBe(false);
  }
  expect((await actions.changeProblemSlowMode("sponsor", "../private", input, "same-key")).ok).toBe(false);
  expect((await actions.changeProblemSlowMode("sponsor", problemId, input, "bad key")).ok).toBe(false);
  identity = "usr_not_an_operator";
  expect((await actions.changeProblemSlowMode("operator", problemId, input, "same-key")).ok).toBe(false);
  identity = null;
  expect((await actions.changeProblemSlowMode("sponsor", problemId, input, "same-key")).ok).toBe(false);
  expect(writes).toHaveLength(0);
});

test("strict step-up bounds match the Worker and stale or future sessions cannot write", async () => {
  const now = 1793016000;
  expect(sessionHelpers.slowModeAuthIsRecent(now - 900, now)).toBe(true);
  for (const value of [undefined, now + 1, now - 901, now + 0.5, -1, Number.NaN]) {
    expect(sessionHelpers.slowModeAuthIsRecent(value, now)).toBe(false);
  }
  for (const value of [undefined, Math.floor(Date.now() / 1_000) - 901, Math.floor(Date.now() / 1_000) + 60]) {
    issuedAt = value;
    const reply = await actions.changeProblemSlowMode("sponsor", problemId, input, "same-key");
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.refreshRequired).toBe(true);
  }
  expect(writes).toHaveLength(0);
});

test("stale state, authorization, expiry and ambiguous failures teach different recovery", async () => {
  for (const [status, message] of [
    [409, "mode changed"], [403, "Re-authenticate"], [404, "current explicit steward"], [422, "future expiry"],
  ] as const) {
    writeResult = { ok: false, reason: "refused", status };
    const reply = await actions.changeProblemSlowMode("sponsor", problemId, input, "same-key");
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.message).toContain(message);
      expect(reply.retryable).toBe(false);
    }
  }
  writeResult = { ok: false, reason: "unreachable" };
  const uncertain = await actions.changeProblemSlowMode("sponsor", problemId, input, "same-key");
  expect(uncertain.ok).toBe(false);
  if (!uncertain.ok) expect(uncertain.retryable).toBe(true);
  expect(reads).toHaveLength(0);
});

test("an accepted or replayed receipt cannot impersonate the current mode", async () => {
  const expired = ProblemSlowModeStateSchema.parse({
    problem_id: problemId, revision: 2, effective_limit_per_hour: 20, slow_mode: null,
  });
  readResult = { ok: true, data: expired };
  expect(await actions.changeProblemSlowMode("sponsor", problemId, input, "same-key"))
    .toEqual({ ok: true, receipt, current: expired });
  readResult = { ok: false, reason: "unreachable" };
  expect(await actions.changeProblemSlowMode("sponsor", problemId, input, "same-key"))
    .toEqual({ ok: true, receipt, current: null });
  readResult = { ok: true, data: { ...expired, revision: 1 } };
  expect(await actions.changeProblemSlowMode("sponsor", problemId, input, "same-key"))
    .toEqual({ ok: true, receipt, current: null });
});

test("private pages show actual current state, escaped audit reason and an explicit command form", async () => {
  const html = renderToStaticMarkup(await page.ProblemSlowModePage({
    audience: "sponsor", searchParams: Promise.resolve({ problem: problemId }),
  }));
  expect(reads).toEqual([[principal, "sponsor", problemId]]);
  for (const text of ["5 new publication admissions per rolling hour", "Mode revision 2", "Expires at (UTC)",
    "&lt;script&gt;review backlog&lt;/script&gt;", "Set temporary limit", "Clear temporary limit", "Audit reason", "current explicit steward"])
    expect(html).toContain(text);
  expect(html).not.toContain("<script>review backlog</script>");
  const sponsorPage = await import("../../app/console/slow-mode/page");
  const operatorPage = await import("../../app/admin/slow-mode/page");
  expect(sponsorPage.metadata.robots).toEqual({ index: false, follow: false });
  expect(operatorPage.metadata.robots).toEqual({ index: false, follow: false });
});

test("invalid, unauthorized and unavailable reads never fabricate an inactive mode or a usable write form", async () => {
  for (const query of [{ problem: [problemId, "P-OTHER"] }, { problem: "../private" }, { problem: problemId, private: "CANARY" }]) {
    const html = renderToStaticMarkup(await page.ProblemSlowModePage({ audience: "sponsor", searchParams: Promise.resolve(query) }));
    expect(html).toContain("Choose one valid problem identifier");
    expect(html).not.toContain("Set temporary limit");
  }
  expect(reads).toHaveLength(0);
  identity = "usr_not_operator";
  const forbidden = renderToStaticMarkup(await page.ProblemSlowModePage({ audience: "operator", searchParams: Promise.resolve({ problem: problemId }) }));
  expect(forbidden).toContain("not authorized for operator controls");
  expect(reads).toHaveLength(0);
  identity = principal;
  readResult = { ok: false, reason: "refused", status: 404 };
  const missing = renderToStaticMarkup(await page.ProblemSlowModePage({ audience: "sponsor", searchParams: Promise.resolve({ problem: problemId }) }));
  expect(missing).toContain("Current mode unavailable");
  expect(missing).not.toContain("No temporary slow mode is active");
  expect(missing).not.toContain("Set temporary limit");
});

test("stale sessions may inspect the current mode while changes remain disabled", async () => {
  issuedAt = Math.floor(Date.now() / 1_000) - 1800;
  const html = renderToStaticMarkup(await page.ProblemSlowModePage({ audience: "sponsor", searchParams: Promise.resolve({ problem: problemId }) }));
  expect(html).toContain("5 new publication admissions per rolling hour");
  expect(html).toContain("<fieldset disabled");
  expect(html).toContain("Re-authenticate with Google");
  expect(writes).toHaveLength(0);
});
