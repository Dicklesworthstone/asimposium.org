import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type { SponsorInboxResponse } from "@asimposium/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { StoaCall } from "../../lib/stoa";
import {
  inboxFellow,
  inboxNotice,
  inboxPage,
  inboxProblem,
  inboxSponsor,
} from "../fixtures/sponsor-inbox";

mock.module("server-only", () => ({}));
let identity: string | null;
let result: StoaCall<SponsorInboxResponse>;
let failRead: boolean;
const calls: unknown[][] = [];
let realAuth: typeof import("../../auth");
let realStoa: typeof import("../../lib/stoa");
let page: typeof import("../../app/console/inbox/[fellow]/page");

beforeAll(async () => {
  realAuth = { ...(await import("../../auth")) };
  realStoa = { ...(await import("../../lib/stoa")) };
  mock.module("@/auth", () => ({
    ...realAuth,
    auth: async () => (identity === null ? null : { user: { id: identity } }),
    signIn: async () => {},
  }));
  mock.module("@/lib/stoa", () => ({
    ...realStoa,
    stoaSponsorInbox: async (...args: unknown[]) => {
      calls.push(args);
      if (failRead) throw new Error("PRIVATE_FAILURE_CANARY");
      return result;
    },
  }));
  page = await import("../../app/console/inbox/[fellow]/page");
});
beforeEach(() => {
  identity = inboxSponsor;
  result = { ok: true, data: inboxPage };
  failRead = false;
  calls.length = 0;
});
afterAll(() => {
  mock.module("@/auth", () => realAuth);
  mock.module("@/lib/stoa", () => realStoa);
});

async function render(query: Record<string, string | string[]> = {}) {
  return renderToStaticMarkup(
    await page.default({
      params: Promise.resolve({ fellow: inboxFellow }),
      searchParams: Promise.resolve(query),
    }),
  );
}

test("the sponsor reads real notices with distinct Fellow acknowledgement and usable research links", async () => {
  const html = await render();
  expect(calls).toEqual([[inboxSponsor, { fellow_id: inboxFellow, limit: 25 }]]);
  expect(html).toContain("redshift’s notices");
  expect(html).toContain("PRIVATE_NOTICE &lt;script&gt;");
  expect(html).not.toContain("<script>alert");
  expect(html).toContain("Not yet acknowledged by the Fellow.");
  expect(html).toContain("Acknowledged by the Fellow:");
  expect(html).toContain("Opening this page does not acknowledge anything");
  expect(html).toContain(`/p/${inboxProblem}/gaps?target=G-9`);
  expect(html).toContain(`/console/workshop/${inboxFellow}/${inboxProblem}`);
  expect(html).toContain("Check for later notices");
  expect(html).toContain(`/console/inbox/${inboxFellow}?since=8`);
  expect(html).not.toContain("/v1/inbox/ack");
  expect(html).not.toContain("Mark as read");
  expect(page.dynamic).toBe("force-dynamic");
  expect(page.metadata.robots).toEqual({ index: false, follow: false });
});

test("unacknowledged pagination preserves the selected Fellow and filter", async () => {
  result = {
    ok: true,
    data: {
      ...inboxPage,
      items: Array.from({ length: 25 }, (_, index) => ({
        ...inboxNotice,
        id: `notice-${index + 11}`,
        seq: index + 11,
      })),
      next_cursor: 35,
      has_more: true,
      fellow_unacknowledged_count: 40,
      omitted: ["limit_reached"],
    },
  };
  const html = await render({ since: "10", unacknowledged_only: "true" });
  expect(calls).toEqual([
    [
      inboxSponsor,
      {
        fellow_id: inboxFellow,
        since: 10,
        limit: 25,
        unacknowledged_only: true,
      },
    ],
  ]);
  expect(html).toContain("Next notices");
  expect(html).toContain(`/console/inbox/${inboxFellow}?since=35&amp;unacknowledged_only=true`);
  expect(html).toContain(`/console/inbox/${inboxFellow}?unacknowledged_only=true`);
  expect(html).toContain('name="unacknowledged_only" value="true"');
  expect(html).toContain("More notices are available on the next page.");
});

test("anonymous, forged and malformed selections do not load private notices", async () => {
  identity = null;
  expect(await render()).toContain("Sign in to read your Fellow’s notices");
  identity = "email@example.com";
  expect(await render()).toContain("Sign in to read your Fellow’s notices");
  identity = inboxSponsor;
  expect(await render({ since: ["1", "2"] })).toContain("Invalid inbox link");
  expect(await render({ sponsor_id: "usr_someone_else" })).toContain("Invalid inbox link");
  expect(calls).toHaveLength(0);
});

test("changed ownership, refusals and failures do not render private bytes or an empty-success claim", async () => {
  for (const unavailable of [
    { ok: false, reason: "refused", status: 404, detail: "PRIVATE_REFUSAL_CANARY" },
    { ok: false, reason: "unreachable" },
    { ok: true, data: { ...inboxPage, sponsor_id: "usr_other" } },
    { ok: true, data: { ...inboxPage, fellow_id: "fellow-other" } },
  ] as const) {
    result = unavailable;
    const html = await render();
    expect(html).toContain("Fellow inbox unavailable");
    expect(html).not.toContain("PRIVATE_");
    expect(html).not.toContain("No visible notices yet");
  }
  failRead = true;
  const html = await render();
  expect(html).toContain("Fellow inbox unavailable");
  expect(html).not.toContain("PRIVATE_FAILURE_CANARY");
});

test("empty later pages retain a way back and describe the active Fellow filter", async () => {
  result = {
    ok: true,
    data: {
      ...inboxPage,
      items: [],
      next_cursor: null,
      has_more: false,
      fellow_unacknowledged_count: 0,
    },
  };
  const first = await render({ unacknowledged_only: "true" });
  expect(first).toContain("No visible notices are awaiting the Fellow’s acknowledgment.");
  const later = await render({ since: "8", unacknowledged_only: "true" });
  expect(later).toContain("No later visible notices on this page.");
  expect(later).toContain("First page");
  expect(later).not.toContain("Next notices");
});
