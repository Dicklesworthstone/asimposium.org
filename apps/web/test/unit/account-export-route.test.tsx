import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SPONSOR_DATA_EXPORT_EXCLUSIONS, SPONSOR_DATA_EXPORT_FORMAT, type SponsorDataExportResponse } from "@asimposium/contracts/account-export";
import type { SponsorSuspensionStatus } from "@asimposium/contracts";
import type { StoaCall } from "../../lib/stoa";

mock.module("server-only", () => ({}));
const principal = "usr_export_route";
const first: SponsorDataExportResponse = {
  version: SPONSOR_DATA_EXPORT_FORMAT, sponsor_id: principal,
  snapshot: { revision: 3, exported_at: "2026-10-26T01:00:00.000Z" }, section: "account",
  records: [{ kind: "account", data: { sponsor_id: principal, created_at: 1, active_fellow_limit: 5 } }],
  next_cursor: { snapshot: { revision: 3, exported_at: "2026-10-26T01:00:00.000Z" }, section: "fellows", after: 0 },
  omitted: [...SPONSOR_DATA_EXPORT_EXCLUSIONS],
};
let identity: string | null;
let result: StoaCall<SponsorDataExportResponse>;
let standing: StoaCall<SponsorSuspensionStatus>;
const calls: unknown[][] = [];
const statusCalls: string[] = [];
let route: typeof import("../../app/console/account/export/route");
let page: typeof import("../../app/console/account/page");
let realAuth: typeof import("../../auth");
let realExport: typeof import("../../lib/account-export");
let realStoa: typeof import("../../lib/stoa");

beforeAll(async () => {
  realAuth = { ...(await import("../../auth")) };
  realExport = { ...(await import("../../lib/account-export")) };
  realStoa = { ...(await import("../../lib/stoa")) };
  mock.module("@/auth", () => ({ ...realAuth,
    auth: async () => identity === null ? null : { user: { id: identity } }, signIn: async () => {},
  }));
  mock.module("@/lib/account-export", () => ({ ...realExport,
    stoaSponsorDataExportPage: async (...args: unknown[]) => { calls.push(args); return result; },
  }));
  mock.module("@/lib/stoa", () => ({ ...realStoa,
    stoaSponsorSuspensionStatus: async (id: string) => { statusCalls.push(id); return standing; },
  }));
  route = await import("../../app/console/account/export/route");
  page = await import("../../app/console/account/page");
});
beforeEach(() => {
  identity = principal;
  result = { ok: true, data: first };
  standing = { ok: true, data: { sponsor_id: principal, status: "active", suspension: null } };
  calls.length = 0;
  statusCalls.length = 0;
});
afterAll(() => {
  mock.module("@/auth", () => realAuth);
  mock.module("@/lib/account-export", () => realExport);
  mock.module("@/lib/stoa", () => realStoa);
});

function request(body: unknown = {}, origin = "https://asimposium.org", query = "") {
  return new Request(`https://asimposium.org/console/account/export${query}`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

test("export route derives identity anew and keeps all successes private and unindexed", async () => {
  const response = await route.POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(first);
  expect(calls).toEqual([[principal, {}]]);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  identity = "usr_changed_session";
  await route.POST(request({ cursor: first.next_cursor }));
  expect(calls.at(-1)?.[0]).toBe("usr_changed_session");
});

test("no sign-in, forged identity, cross-origin requests and oversized bodies cannot request data", async () => {
  identity = null;
  expect((await route.POST(request())).status).toBe(401);
  identity = principal;
  expect((await route.POST(request({ sponsor_id: "usr_victim" }))).status).toBe(400);
  expect((await route.POST(request({}, "https://other.example"))).status).toBe(403);
  expect((await route.POST(request({}, "https://asimposium.org", "?sponsor=usr_other"))).status).toBe(403);
  expect((await route.POST(request({ cursor: "x".repeat(5_000) }))).status).toBe(400);
  expect(calls).toHaveLength(0);
});

test("snapshot conflicts and service failures return safe errors rather than incomplete data", async () => {
  for (const [failure, expected] of [
    [{ ok: false, reason: "refused", status: 409, detail: "private failure detail" }, 409],
    [{ ok: false, reason: "refused", status: 403 }, 403],
    [{ ok: false, reason: "unreachable" }, 502],
    [{ ok: false, reason: "unconfigured" }, 503],
  ] as const) {
    result = failure;
    const response = await route.POST(request());
    expect(response.status).toBe(expected);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("private failure detail");
  }
});

test("account page explains export scope without fetching or rendering private work", async () => {
  const html = renderToStaticMarkup(await page.default());
  expect(statusCalls).toEqual([principal]);
  expect(calls).toHaveLength(0);
  expect(html).toContain("Download your account data");
  expect(html).toContain("current workshop objects and their revisions");
  expect(html).toContain("Another sponsor’s private directives");
  expect(html).toContain("No suspension is currently recorded");
  expect(page.metadata.robots).toEqual({ index: false, follow: false });
});

test("suspended sponsors see a coarse appeal reference and can still start an export", async () => {
  standing = { ok: true, data: {
    sponsor_id: principal, status: "suspended", suspension: {
      event_id: `SS-${"0".repeat(26)}`, audit_event_id: `OA-${"0".repeat(26)}`,
      applied_at: "2026-10-26T01:00:00.000Z", appeal: "SPONSOR_APPEAL_AVAILABLE",
    },
  } };
  const html = renderToStaticMarkup(await page.default());
  expect(html).toContain("Your sponsorship is suspended");
  expect(html).toContain("appeal to the operator by email");
  expect(html).toContain("Prepare private download");
  expect(html).not.toContain("reviewed_case_id");
  standing = { ok: false, reason: "unreachable" };
  expect(renderToStaticMarkup(await page.default())).toContain("Account standing could not be verified");
});

test("anonymous account page offers sign-in without private reads or export controls", async () => {
  identity = null;
  const html = renderToStaticMarkup(await page.default());
  expect(html).toContain("Sign in to your account");
  expect(html).not.toContain("Prepare private download");
  expect(calls).toHaveLength(0);
  expect(statusCalls).toHaveLength(0);
});
