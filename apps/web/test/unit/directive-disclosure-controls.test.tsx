import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  SponsorDirectiveDisclosureReceipt,
  SponsorDirectiveDisclosureState,
} from "@asimposium/contracts/directive-disclosures";
import type { DirectiveDisclosureInput } from "../../app/console/disclosures/actions";
import type { StoaCall } from "../../lib/stoa";
import {
  disclosureCommand, disclosureCompleted, disclosureInitial, disclosureOtherSponsor,
  disclosureReceipt, disclosureSponsor, disclosureTarget,
} from "../fixtures/directive-disclosure";

mock.module("server-only", () => ({}));

const input: DirectiveDisclosureInput = { ...disclosureCommand, confirm_public_record: true };
let identity: string | null;
let authCalls: number;
let readResult: StoaCall<SponsorDirectiveDisclosureState>;
let writeResult: StoaCall<SponsorDirectiveDisclosureReceipt>;
let failWrite: boolean;
let failRead: boolean;
const reads: unknown[][] = [];
const writes: unknown[][] = [];
let realTransport: typeof import("../../lib/directive-disclosures");
let realAuth: typeof import("../../auth");
let actions: typeof import("../../app/console/disclosures/actions");
let page: typeof import("../../app/console/disclosures/page");

beforeAll(async () => {
  realTransport = { ...(await import("../../lib/directive-disclosures")) };
  realAuth = { ...(await import("../../auth")) };
  mock.module("@/auth", () => ({
    ...realAuth,
    auth: async () => { authCalls += 1; return identity === null ? null : { user: { id: identity } }; },
    signIn: async () => {},
  }));
  mock.module("@/lib/directive-disclosures", () => ({
    ...realTransport,
    stoaDirectiveDisclosure: async (...args: unknown[]) => {
      reads.push(args);
      if (failRead) throw new Error("synthetic read interruption");
      return readResult;
    },
    stoaRecordDirectiveDisclosure: async (...args: unknown[]) => {
      writes.push(args);
      if (failWrite) throw new Error("synthetic response interruption");
      return writeResult;
    },
  }));
  actions = await import("../../app/console/disclosures/actions");
  page = await import("../../app/console/disclosures/page");
});
beforeEach(() => {
  identity = disclosureSponsor;
  authCalls = 0;
  readResult = { ok: true, data: disclosureCompleted };
  writeResult = { ok: true, data: disclosureReceipt };
  failWrite = false;
  failRead = false;
  reads.length = 0;
  writes.length = 0;
});
afterAll(() => {
  mock.module("@/auth", () => realAuth);
  mock.module("@/lib/directive-disclosures", () => realTransport);
});

test("the action derives current sponsor identity and confirms only the immutable receipt", async () => {
  const result = await actions.recordDirectiveDisclosure(disclosureSponsor, disclosureTarget, input, "exact-key");
  expect(result).toEqual({ ok: true, receipt: disclosureReceipt, current: disclosureCompleted });
  expect(writes).toEqual([[disclosureSponsor, disclosureTarget, disclosureCommand, "exact-key"]]);
  expect(reads).toEqual([[disclosureSponsor, disclosureTarget]]);
  expect(authCalls).toBe(1);
  // One sponsor's accepted declaration does not resolve the previous sponsor's scope.
  expect(result.ok && result.current?.status).toBe("unresolved");
});

test("sign-out and account changes cannot submit the previous sponsor's declaration", async () => {
  for (const principal of [null, disclosureOtherSponsor, "person@example.invalid"]) {
    identity = principal;
    const result = await actions.recordDirectiveDisclosure(disclosureSponsor, disclosureTarget, input, "exact-key");
    expect(result).toMatchObject({ ok: false, retryable: false, refreshRequired: true });
  }
  expect(writes).toHaveLength(0);
  expect(reads).toHaveLength(0);
  expect(authCalls).toBe(3);
});

test("public confirmation, exact target and closed request fields are enforced before dispatch", async () => {
  for (const candidate of [
    { ...input, confirm_public_record: false },
    { ...input, sponsor_id: disclosureOtherSponsor },
    { ...input, unresolved_transferred_directives: [] },
    { ...input, expected_revision: -1 },
    { ...input, decision: "disclose", disclosures: [] },
  ]) {
    const result = await actions.recordDirectiveDisclosure(disclosureSponsor, disclosureTarget, candidate as DirectiveDisclosureInput, "key");
    expect(result).toMatchObject({ ok: false, retryable: false });
  }
  expect((await actions.recordDirectiveDisclosure(disclosureSponsor, { ...disclosureTarget, version: 0 }, input, "key")).ok).toBe(false);
  expect((await actions.recordDirectiveDisclosure(disclosureSponsor, disclosureTarget, input, "bad key")).ok).toBe(false);
  expect(writes).toHaveLength(0);
});

test("a lost response preserves an exact retry while current reads remain independent", async () => {
  failWrite = true;
  expect(await actions.recordDirectiveDisclosure(disclosureSponsor, disclosureTarget, input, "retain-this-key"))
    .toMatchObject({ ok: false, retryable: true });
  failWrite = false;
  failRead = true;
  expect(await actions.recordDirectiveDisclosure(disclosureSponsor, disclosureTarget, input, "retain-this-key"))
    .toEqual({ ok: true, receipt: disclosureReceipt, current: null });
  expect(writes).toEqual([
    [disclosureSponsor, disclosureTarget, disclosureCommand, "retain-this-key"],
    [disclosureSponsor, disclosureTarget, disclosureCommand, "retain-this-key"],
  ]);
  expect(authCalls).toBe(2);
});

test("changed lineage or authority requires review, while policy holds never become receipts", async () => {
  for (const status of [401, 403, 404, 409]) {
    writeResult = { ok: false, reason: "refused", status };
    expect(await actions.recordDirectiveDisclosure(disclosureSponsor, disclosureTarget, input, "key"))
      .toMatchObject({ ok: false, retryable: false, refreshRequired: true });
  }
  writeResult = { ok: false, reason: "refused", status: 202, screening: {
    code: "SCREENING_HOLD", coarse_category: "injection", appeal: "SPONSOR_APPEAL_AVAILABLE",
    case_id: `QC-${"0".repeat(26)}`,
  } };
  const held = await actions.recordDirectiveDisclosure(disclosureSponsor, disclosureTarget, input, "held-key");
  expect(held).toMatchObject({ ok: false, retryable: true });
  expect(!held.ok && held.message).toContain("has not been published");
  expect(!held.ok && held.message).toContain(`QC-${"0".repeat(26)}`);
  expect(reads).toHaveLength(0);
});

test("only a signed-in exact selection starts the bounded private page read", async () => {
  const selected = { problem: disclosureTarget.problemId, claim: disclosureTarget.claimId, version: "2" };
  for (const query of [{}, { ...selected, version: ["2", "3"] }, { ...selected, sponsor: disclosureOtherSponsor }]) {
    await page.default({ searchParams: Promise.resolve(query) });
  }
  identity = null;
  const anonymous = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve(selected) }));
  expect(anonymous).toContain("Sign in with Google");
  expect(anonymous).not.toContain("PRIVATE_DIRECTIVE_FIXTURE");
  expect(reads).toHaveLength(0);
  identity = disclosureSponsor;
  await page.default({ searchParams: Promise.resolve(selected) });
  expect(reads).toEqual([[disclosureSponsor, disclosureTarget]]);
  expect(page.metadata.robots).toEqual({ index: false, follow: false });
  expect(page.dynamic).toBe("force-dynamic");
});

test("inspection renders exact source, unresolved prior coverage and escaped own private text", async () => {
  readResult = { ok: true, data: disclosureInitial };
  const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({
    problem: disclosureTarget.problemId, claim: disclosureTarget.claimId, version: "2",
  }) }));
  expect(html).toContain("C-7@2");
  expect(html).toContain("unresolved sponsor coverage");
  expect(html).toContain(disclosureOtherSponsor);
  expect(html).toContain("PRIVATE_DIRECTIVE_FIXTURE &lt;script&gt;not executable&lt;/script&gt;");
  expect(html).toContain("Initial enrollment instruction");
  expect(html).toContain("PRIVATE_INITIAL_INSTRUCTION_FIXTURE");
  expect(html).not.toContain("<script>not executable</script>");
  expect(html).toContain("does not authorize a new sponsor to attest for an earlier sponsor");
  expect(html).toContain("permanent public record");
  expect(html).not.toContain("Confirmed public declaration");
});

test("an interrupted private inspection renders a coarse unavailable state without mutation", async () => {
  failRead = true;
  const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({
    problem: disclosureTarget.problemId, claim: disclosureTarget.claimId, version: "2",
  }) }));
  expect(html).toContain("Disclosure scope unavailable");
  expect(html).not.toContain("synthetic read interruption");
  expect(html).not.toContain("PRIVATE_DIRECTIVE_FIXTURE");
  expect(writes).toHaveLength(0);
});
