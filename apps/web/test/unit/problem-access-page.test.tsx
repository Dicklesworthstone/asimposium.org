import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SponsorProblemGovernanceResponse } from "@asimposium/contracts";
import type { StoaCall } from "../../lib/stoa";
import { accessProblem, accessSponsor, accessWorkspace } from "../fixtures/problem-governance";

mock.module("server-only", () => ({}));
let identity: string | null;
let readResult: StoaCall<SponsorProblemGovernanceResponse>;
let failRead: boolean;
const reads: unknown[][] = [];
let realGovernance: typeof import("../../lib/problem-governance");
let realAuth: typeof import("../../auth");
let realNavigation: typeof import("next/navigation");
let page: typeof import("../../app/console/problems/[problem]/access/page");
let cards: typeof import("../../app/console/problem-card");

beforeAll(async () => {
  realGovernance = { ...(await import("../../lib/problem-governance")) };
  realAuth = { ...(await import("../../auth")) };
  realNavigation = { ...(await import("next/navigation")) };
  mock.module("@/auth", () => ({ ...realAuth,
    auth: async () => identity === null ? null : { user: { id: identity } },
    signIn: async () => {},
  }));
  mock.module("@/lib/problem-governance", () => ({ ...realGovernance,
    stoaProblemGovernance: async (...args: unknown[]) => {
      reads.push(args);
      if (failRead) throw new Error("PRIVATE_GOVERNANCE_READ_FAILED");
      return readResult;
    },
  }));
  mock.module("next/navigation", () => ({ ...realNavigation, useRouter: () => ({ refresh() {} }) }));
  page = await import("../../app/console/problems/[problem]/access/page");
  cards = await import("../../app/console/problem-card");
});
beforeEach(() => {
  identity = accessSponsor;
  readResult = { ok: true, data: accessWorkspace };
  failRead = false;
  reads.length = 0;
});
afterAll(() => {
  mock.module("@/auth", () => realAuth);
  mock.module("@/lib/problem-governance", () => realGovernance);
  mock.module("next/navigation", () => realNavigation);
});

async function render(problem = accessProblem, query: Record<string, string | string[]> = {}) {
  return renderToStaticMarkup(await page.default({ params: Promise.resolve({ problem }), searchParams: Promise.resolve(query) }));
}

test("the private workspace renders actual admission, member roles and explicit bounded controls", async () => {
  const html = await render();
  for (const marker of ["PRIVATE_ACCESS_TITLE", "PRIVATE_MEMBER_ALPHA", "PRIVATE_MEMBER_BETA",
    "approval-required", "Current steward", "2 memberships", "contributor", "observer", "archived",
    "Admit, update or remove one exact Fellow", "I confirm setting admission", "I confirm assigning",
    "Assigning contributor does not reserve a writer slot"]) {
    expect(html).toContain(marker);
  }
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>untrusted()");
  for (const mode of ["open", "approval-required", "invite-only", "archived-read-only"]) {
    expect(html).toContain(`value="${mode}"`);
  }
  expect(html).toContain("transfer sponsor stewardship");
  expect(html).toContain("Fellow&#x27;s credentials");
  expect(html).toContain("/console#directives-title");
  expect(reads).toEqual([[accessSponsor, accessProblem, {}]]);
  expect(page.dynamic).toBe("force-dynamic");
  expect(page.metadata.robots).toEqual({ index: false, follow: false });
  expect(JSON.stringify(page.metadata)).not.toContain("PRIVATE_ACCESS_TITLE");
});

test("signed-out and noncanonical identities cannot load or render private membership", async () => {
  for (const principal of [null, "someone@example.invalid"]) {
    identity = principal;
    const html = await render();
    expect(html).toContain("Sign in to inspect problem access");
    expect(html).not.toContain("PRIVATE_ACCESS_TITLE");
    expect(html).not.toContain("PRIVATE_MEMBER_ALPHA");
    expect(html).not.toContain("Apply Fellow membership");
  }
  expect(reads).toHaveLength(0);
});

test("malformed problem IDs and repeated, extra or oversized query parameters never initiate private IO", async () => {
  for (const [problem, query] of [
    ["../private", {}], ["P-ACCESS\n", {}], [accessProblem, { after: "" }],
    [accessProblem, { after: ["a", "b"] }], [accessProblem, { after: "a".repeat(129) }],
    [accessProblem, { sponsor: "usr_fedcba0987654321" }], [accessProblem, { limit: "1000" }],
  ] as const) {
    const html = await render(problem, query as Record<string, string | string[]>);
    expect(html).toContain("Choose a problem from the sponsor console");
    expect(html).not.toContain("PRIVATE_MEMBER_ALPHA");
  }
  expect(reads).toHaveLength(0);
});

test("denials and unavailable reads never present a stale roster or mutation forms", async () => {
  for (const result of [
    { ok: false, reason: "refused", status: 404 }, { ok: false, reason: "refused", status: 403 },
    { ok: false, reason: "unconfigured" }, { ok: false, reason: "unreachable" },
  ] as const) {
    readResult = result;
    const html = await render();
    expect(html).toContain("Problem access unavailable");
    expect(html).not.toContain("PRIVATE_ACCESS_TITLE");
    expect(html).not.toContain("PRIVATE_MEMBER_ALPHA");
    expect(html).not.toContain("Apply admission mode");
  }
  failRead = true;
  expect(await render()).not.toContain("PRIVATE_GOVERNANCE_READ_FAILED");
});

test("membership pagination states the full count and follows only the authoritative continuation", async () => {
  const members = Array.from({ length: 100 }, (_, index) => ({
    fellow_id: `fellow-page-${String(index).padStart(3, "0")}`, name: `Member ${index}`,
    role: "observer" as const, fellow_status: "active" as const, joined_at: "2026-10-26T12:00:00.000Z",
  }));
  readResult = { ok: true, data: { ...accessWorkspace, members,
    member_counts: { total: 101, observer: 101, contributor: 0, steward: 0 },
    has_more: true, next_after: "fellow-page-099",
  } };
  const html = await render(accessProblem, { after: "fellow-before-page" });
  expect(html).toContain("101 memberships");
  expect(html).toContain("This page shows 100 after fellow-before-page");
  expect(html).toContain(`/console/problems/${accessProblem}/access?after=fellow-page-099`);
  expect(html).toContain("Next member page");
  expect(html).toContain("First member page");
  expect(reads).toEqual([[accessSponsor, accessProblem, { after: "fellow-before-page" }]]);
});

test("closed workspaces disable mutations while archived admission and private access use truthful limits", async () => {
  readResult = { ok: true, data: { ...accessWorkspace,
    problem: { ...accessWorkspace.problem, status: "retired", admission_mode: "archived-read-only" },
    authority: { ...accessWorkspace.authority, can_edit_access: false },
  } };
  const closed = await render();
  expect(closed).toContain("admission and membership changes are unavailable");
  expect(closed.match(/<fieldset disabled=""/g)).toHaveLength(2);
  expect(closed).toContain("Stops new session admission and new scientific publications, including from existing sessions");
  expect(closed).toContain("Existing receipts remain recoverable; sessions and credentials are not terminated");
  readResult = { ok: true, data: { ...accessWorkspace,
    problem: { ...accessWorkspace.problem, status: "private-draft", unlisted: false },
  } };
  const draft = await render();
  expect(draft).toContain("Membership alone does not grant access to a private formulation or workshop");
  expect(draft).toContain("Publishing a listed draft changes approval-required admission to open");
});

test("both private and published console cards lead to their own access workspace", () => {
  const problems = ["private-draft", "active"].map((status, index) => ({
    id: `${accessProblem}-${index}`, title: `Workspace ${index}`, status: status as "private-draft" | "active",
    unlisted: true, created_by_fellow_id: "fellow-access-a", current_statement_version: 3,
    created_at: "2026-10-25T12:00:00.000Z", updated_at: "2026-10-26T12:00:00.000Z",
  }));
  const html = renderToStaticMarkup(<cards.ProblemManager fellows={[]} briefs={[]} configured problems={problems} />);
  expect(html).toContain(`/console/problems/${accessProblem}-0/access`);
  expect(html).toContain(`/console/problems/${accessProblem}-1/access`);
  expect(html.match(/Manage admission and members/g)).toHaveLength(2);
  expect(html).toContain("Published problems you govern");
});
