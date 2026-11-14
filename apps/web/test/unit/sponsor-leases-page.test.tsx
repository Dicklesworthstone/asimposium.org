import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type { SponsorLeaseListResponse, SponsorLeaseReleaseResponse } from "@asimposium/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { StoaCall } from "../../lib/stoa";
import {
  leasePage,
  leaseReceipt,
  leaseSponsor,
  leaseSummary,
  leaseTarget,
} from "../fixtures/sponsor-leases";

mock.module("server-only", () => ({}));
let identity: string | null;
let listResult: StoaCall<SponsorLeaseListResponse>;
let releaseResult: StoaCall<SponsorLeaseReleaseResponse>;
let listThrows: boolean;
let releaseThrows: boolean;
const reads: unknown[][] = [];
const writes: unknown[][] = [];
let realAuth: typeof import("../../auth");
let realLeases: typeof import("../../lib/stoa-leases");
let page: typeof import("../../app/console/leases/page");
let release: typeof import("../../app/console/leases/actions").releaseLease;

beforeAll(async () => {
  realAuth = { ...(await import("../../auth")) };
  realLeases = { ...(await import("../../lib/stoa-leases")) };
  mock.module("@/auth", () => ({
    ...realAuth,
    auth: async () => (identity === null ? null : { user: { id: identity } }),
  }));
  mock.module("@/lib/stoa-leases", () => ({
    ...realLeases,
    stoaSponsorLeases: async (...args: unknown[]) => {
      reads.push(args);
      if (listThrows) throw new Error("PRIVATE_READ_CANARY");
      return listResult;
    },
    stoaSponsorReleaseLease: async (...args: unknown[]) => {
      writes.push(args);
      if (releaseThrows) throw new Error("PRIVATE_WRITE_CANARY");
      return releaseResult;
    },
  }));
  const pageSpecifier: string = "../../app/console/leases/page.tsx?hermetic-lease-page";
  const actionSpecifier: string = "../../app/console/leases/actions.ts?hermetic-lease-action";
  page = await import(pageSpecifier);
  release = (await import(actionSpecifier)).releaseLease;
});
beforeEach(() => {
  identity = leaseSponsor;
  listResult = { ok: true, data: leasePage };
  releaseResult = { ok: true, data: leaseReceipt };
  listThrows = false;
  releaseThrows = false;
  reads.length = 0;
  writes.length = 0;
});
afterAll(() => {
  mock.module("@/auth", () => realAuth);
  mock.module("@/lib/stoa-leases", () => realLeases);
});

async function render(query: Record<string, string | string[] | undefined> = {}) {
  return renderToStaticMarkup(await page.default({ searchParams: Promise.resolve(query) }));
}
function confirmed() {
  const form = new FormData();
  form.set("confirm_release", "yes");
  return form;
}

test("the private server-rendered lease page exposes an exact confirmation control and stored deadlines", async () => {
  const html = await render();
  expect(reads).toEqual([[leaseSponsor, {}]]);
  expect(html).toContain("redshift");
  expect(html).toContain(leaseSummary.lease_id);
  expect(html).toContain(leaseSummary.leased_until);
  expect(html).toContain('name="confirm_release"');
  expect(html).toContain("Release lease");
  expect(html).toContain("Refresh active leases");
  expect(html).toContain("A lease does not show whether a Fellow is currently running.");
  expect(writes).toHaveLength(0);
  expect(page.dynamic).toBe("force-dynamic");
  expect(page.metadata.robots).toEqual({ index: false, follow: false });
});

test("anonymous and malformed page requests never read private rows", async () => {
  for (const account of [null, "person@example.com"]) {
    identity = account;
    const html = await render();
    expect(html).toContain("Sign in required");
    expect(html).not.toContain(leaseSummary.lease_id);
  }
  identity = leaseSponsor;
  for (const query of [{ after: ["one", "two"] }, { sponsor_id: "usr_other" }, { after: "C-12" }])
    expect(await render(query)).toContain("Invalid lease page");
  expect(reads).toHaveLength(0);
});

test("a failed read or mismatched private response is unavailable rather than empty success", async () => {
  const outcomes: StoaCall<SponsorLeaseListResponse>[] = [
    { ok: false, reason: "refused", status: 403, detail: "PRIVATE_REFUSAL_CANARY" },
    { ok: true, data: { ...leasePage, sponsor_id: "usr_other" } },
    { ok: true, data: { ...leasePage, leases: [leaseSummary, leaseSummary] } },
  ];
  for (const value of outcomes) {
    listResult = value;
    const html = await render();
    expect(html).toContain("Active leases unavailable");
    expect(html).not.toContain(leaseSummary.lease_id);
    expect(html).not.toContain("PRIVATE_");
    expect(html).not.toContain("No active leases");
  }
  listThrows = true;
  expect(await render()).toContain("Active leases unavailable");
});

test("pagination preserves the immutable cursor and an empty later page still offers the first page", async () => {
  const leases = Array.from({ length: 20 }, (_, index) => ({
    ...leaseSummary,
    lease_id: `L-${String(index + 10).padStart(26, "0")}`,
  }));
  const lastId = leases.at(-1)?.lease_id ?? "";
  listResult = { ok: true, data: { ...leasePage, leases, next_cursor: lastId } };
  expect(await render()).toContain(`/console/leases?after=${lastId}`);
  listResult = { ok: true, data: { ...leasePage, leases: [] } };
  const html = await render({ after: lastId });
  expect(html).toContain("No active leases were found on this page.");
  expect(html).toContain("First page");
  expect(html).not.toContain("Next leases");
});

test("release reauthenticates and requires a canonical pin plus one explicit confirmation", async () => {
  for (const account of [null, "person@example.com", "usr_other"]) {
    identity = account;
    expect((await release(leaseSponsor, leaseTarget, { status: "idle" }, confirmed())).status).toBe(
      "refused",
    );
  }
  identity = leaseSponsor;
  const injected = { ...leaseTarget, reason: "Sponsor scientific text" };
  expect(
    (
      await release(
        leaseSponsor,
        { ...leaseTarget, lease_id: "C-12" },
        { status: "idle" },
        confirmed(),
      )
    ).status,
  ).toBe("refused");
  expect((await release(leaseSponsor, injected, { status: "idle" }, confirmed())).status).toBe(
    "refused",
  );
  expect(
    (await release(leaseSponsor, leaseTarget, { status: "idle" }, new FormData())).status,
  ).toBe("refused");
  const duplicate = confirmed();
  duplicate.append("confirm_release", "yes");
  expect((await release(leaseSponsor, leaseTarget, { status: "idle" }, duplicate)).status).toBe(
    "refused",
  );
  expect(writes).toHaveLength(0);
});

test("an ambiguous release is safely retryable and only a confirmed receipt reports success", async () => {
  const form = confirmed();
  form.set("reason", "Untrusted text never enters the command");
  form.set("object", "C-OTHER");
  releaseThrows = true;
  const uncertain = await release(leaseSponsor, leaseTarget, { status: "idle" }, form);
  expect(uncertain.status).toBe("refused");
  expect(JSON.stringify(uncertain)).toContain("Retry this same lease");
  expect(JSON.stringify(uncertain)).not.toContain("PRIVATE_");
  releaseThrows = false;
  expect(await release(leaseSponsor, leaseTarget, uncertain, form)).toEqual({
    status: "released",
    receipt: leaseReceipt,
  });
  expect(writes).toEqual([
    [leaseSponsor, leaseTarget],
    [leaseSponsor, leaseTarget],
  ]);
  releaseResult = {
    ok: false,
    reason: "refused",
    status: 403,
    problemCode: "NOT_LESSEE_SPONSOR",
    detail: "PRIVATE_REFUSAL_CANARY",
  };
  const refused = await release(leaseSponsor, leaseTarget, { status: "idle" }, confirmed());
  expect(refused.status).toBe("refused");
  expect(JSON.stringify(refused)).not.toContain("PRIVATE_");
});
