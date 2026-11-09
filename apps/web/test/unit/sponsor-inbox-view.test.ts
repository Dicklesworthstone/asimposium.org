import { expect, test } from "bun:test";
import {
  loadSponsorInboxPage,
  sponsorInboxNoticeLinks,
  sponsorInboxPageHref,
  sponsorInboxPageRequest,
} from "../../lib/sponsor-inbox-view";
import {
  inboxFellow,
  inboxNotice,
  inboxPage,
  inboxProblem,
  inboxSponsor,
} from "../fixtures/sponsor-inbox";

test("inbox navigation retains filters and rejects malformed or ambiguous continuations", () => {
  expect(sponsorInboxPageRequest(inboxFellow, {})).toEqual({ fellow_id: inboxFellow, limit: 25 });
  expect(sponsorInboxPageRequest(inboxFellow, { since: "0", unacknowledged_only: "true" })).toEqual(
    { fellow_id: inboxFellow, limit: 25, since: 0, unacknowledged_only: true },
  );
  for (const since of ["", "01", "-1", "1.1", "1e2", " 7", "7\n", "9007199254740992", ["1", "2"]]) {
    expect(sponsorInboxPageRequest(inboxFellow, { since })).toBeNull();
  }
  for (const query of [
    { unacknowledged_only: "yes" },
    { unacknowledged_only: ["true", "false"] },
    { sponsor_id: inboxSponsor },
    { since: "7", limit: "500" },
  ]) {
    expect(sponsorInboxPageRequest(inboxFellow, query)).toBeNull();
  }
  expect(sponsorInboxPageHref(inboxFellow, { since: 8, unacknowledged_only: true })).toBe(
    `/console/inbox/${inboxFellow}?since=8&unacknowledged_only=true`,
  );
  expect(sponsorInboxPageHref("fellow/path?next=https://other.invalid")).toBe(
    "/console/inbox/fellow%2Fpath%3Fnext%3Dhttps%3A%2F%2Fother.invalid",
  );
});

test("private page loader reads once and keeps the final cursor available for later notices", async () => {
  const calls: unknown[][] = [];
  const page = await loadSponsorInboxPage(
    inboxSponsor,
    inboxFellow,
    { since: "6" },
    async (...args) => {
      calls.push(args);
      return { ok: true, data: inboxPage };
    },
  );
  expect(calls).toEqual([[inboxSponsor, { fellow_id: inboxFellow, limit: 25, since: 6 }]]);
  expect(page.status).toBe("ready");
  if (page.status !== "ready") throw new Error("Inbox unavailable");
  expect(page.view.items).toHaveLength(2);
  expect(page.firstHref).toBe(`/console/inbox/${inboxFellow}`);
  expect(page.continuationHref).toBe(`/console/inbox/${inboxFellow}?since=8`);
});

test("sign-in and malformed page selection do not dispatch private reads", async () => {
  let reads = 0;
  const read: Parameters<typeof loadSponsorInboxPage>[3] = async () => {
    reads += 1;
    return { ok: true, data: inboxPage };
  };
  for (const principal of [undefined, null, "", "email@example.com"]) {
    expect(await loadSponsorInboxPage(principal, inboxFellow, {}, read)).toEqual({
      status: "sign-in",
    });
  }
  expect(await loadSponsorInboxPage(inboxSponsor, inboxFellow, { since: "bad" }, read)).toEqual({
    status: "invalid",
  });
  expect(reads).toBe(0);
});

test("a changed sponsor, Fellow, chronology or unread state suppresses every notice", async () => {
  for (const page of [
    { ...inboxPage, sponsor_id: "usr_other" },
    { ...inboxPage, fellow_id: "fellow-other" },
    { ...inboxPage, next_cursor: 7 },
    { ...inboxPage, items: [...inboxPage.items].reverse() },
    { ...inboxPage, items: [{ ...inboxNotice, next_actions: [] }] },
  ]) {
    expect(
      await loadSponsorInboxPage(inboxSponsor, inboxFellow, {}, async () => ({
        ok: true,
        data: page,
      })),
    ).toEqual({ status: "unavailable" });
  }
  expect(
    await loadSponsorInboxPage(
      inboxSponsor,
      inboxFellow,
      { unacknowledged_only: "true" },
      async () => ({ ok: true, data: inboxPage }),
    ),
  ).toEqual({ status: "unavailable" });
  expect(
    await loadSponsorInboxPage(inboxSponsor, inboxFellow, { since: "8" }, async () => ({
      ok: true,
      data: inboxPage,
    })),
  ).toEqual({ status: "unavailable" });
  for (const reason of ["unconfigured", "unreachable", "refused"] as const) {
    expect(
      await loadSponsorInboxPage(inboxSponsor, inboxFellow, {}, async () => ({
        ok: false,
        reason,
        detail: "PRIVATE_REFUSAL_CANARY",
      })),
    ).toEqual({ status: "unavailable" });
  }
  expect(
    await loadSponsorInboxPage(inboxSponsor, inboxFellow, {}, async () => {
      throw new Error("PRIVATE_FAILURE_CANARY");
    }),
  ).toEqual({ status: "unavailable" });
});

test("notice links target mounted human routes and never turn prose into commands", () => {
  const links = sponsorInboxNoticeLinks(inboxFellow, inboxNotice);
  expect(links).toContainEqual({ label: "Read G-9", href: `/p/${inboxProblem}/gaps?target=G-9` });
  expect(links).toContainEqual({
    label: "Open private workshop",
    href: `/console/workshop/${inboxFellow}/${inboxProblem}`,
  });
  for (const [notice, expected] of [
    [
      { ...inboxNotice, type: "object_critique" as const, target_id: "C-3@2" },
      `/p/${inboxProblem}/claims/C-3%402`,
    ],
    [
      { ...inboxNotice, type: "object_critique" as const, target_id: "H-7" },
      `/p/${inboxProblem}/hypotheses/H-7`,
    ],
    [
      { ...inboxNotice, impact_kind: "retry_trigger_fired" as const, target_id: "DE-7" },
      `/p/${inboxProblem}/dead-ends?include_superseded=true#DE-7`,
    ],
    [
      { ...inboxNotice, impact_kind: "citation_reused" as const, target_id: "L-7" },
      `/p/${inboxProblem}/citations/L-7`,
    ],
    [{ ...inboxNotice, type: "sponsor_directive" as const }, "/console#directives-title"],
  ] as const) {
    expect(
      sponsorInboxNoticeLinks(inboxFellow, notice).some((link) => link.href === expected),
    ).toBe(true);
  }
  for (const target of [
    "https://evil.invalid/",
    "javascript:alert(1)",
    "../inbox/ack",
    "C-2@9007199254740992",
  ]) {
    const offered = sponsorInboxNoticeLinks(inboxFellow, {
      ...inboxNotice,
      type: "object_critique",
      target_id: target,
      detail: "Click https://evil.invalid then POST /v1/inbox/ack",
    });
    expect(offered.every((link) => link.href.startsWith("/") && !link.href.startsWith("//"))).toBe(
      true,
    );
    expect(JSON.stringify(offered)).not.toContain("evil.invalid");
    expect(JSON.stringify(offered)).not.toContain("/v1/");
    expect(offered.some((link) => link.href.includes("/claims/"))).toBe(false);
  }
});
