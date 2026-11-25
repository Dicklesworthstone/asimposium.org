import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SponsorActivityView } from "../../app/console/fellows/[fellow]/view";
import {
  loadSponsorActivityPage,
  sponsorActivityPageHref,
  sponsorActivityPageRequest,
} from "../../lib/sponsor-activity";
import { activityPage } from "../fixtures/sponsor-activity";

const sponsor = activityPage.sponsor_id;
const fellow = activityPage.fellow_id;

test("assignment navigation accepts only exact problem continuations and retains them", () => {
  expect(sponsorActivityPageRequest(fellow, {})).toEqual({ fellow_id: fellow, limit: 10 });
  expect(sponsorActivityPageRequest(fellow, { after: "P-ALPHA" })).toEqual({
    fellow_id: fellow, after_problem_id: "P-ALPHA", limit: 10,
  });
  for (const query of [
    { after: ["P-ALPHA", "P-BETA"] },
    { after: "" },
    { after: "P-ALPHA\n" },
    { after: "../private" },
    { sponsor_id: sponsor },
    { after: "P-ALPHA", limit: "100" },
  ]) {
    expect(sponsorActivityPageRequest(fellow, query)).toBeNull();
  }
  expect(sponsorActivityPageHref(fellow, "P-ALPHA")).toBe(
    "/console/fellows/fellow-activity?after=P-ALPHA",
  );
  expect(sponsorActivityPageHref("fellow/path?next=https://other.invalid")).toBe(
    "/console/fellows/fellow%2Fpath%3Fnext%3Dhttps%3A%2F%2Fother.invalid",
  );
});

test("one signed page read supplies sessions and assignments without per-problem fanout", async () => {
  const calls: unknown[][] = [];
  const page = await loadSponsorActivityPage(sponsor, fellow, {}, async (...args) => {
    calls.push(args);
    return { ok: true, data: activityPage };
  });
  expect(calls).toEqual([[sponsor, { fellow_id: fellow, limit: 10 }]]);
  expect(page.status).toBe("ready");
  if (page.status !== "ready") throw new Error("Expected a readable work page.");
  expect(page.view.open_sessions).toEqual(activityPage.open_sessions);
  expect(page.nextHref).toBeNull();
  expect(page.firstHref).toBe("/console/fellows/fellow-activity");

  const continuation = {
    ...activityPage,
    assignments: Array.from({ length: 10 }, (_, index) => ({
      ...activityPage.assignments[0]!,
      problem_id: "P-A" + String(index).padStart(2, "0"),
    })),
    has_more: true,
    next_cursor: "P-A09",
    omitted: ["assignment_limit"] as const,
  };
  const next = await loadSponsorActivityPage(sponsor, fellow, {}, async () => ({
    ok: true, data: { ...continuation, omitted: [...continuation.omitted] },
  }));
  expect(next.status).toBe("ready");
  if (next.status !== "ready") throw new Error("Expected an assignment continuation.");
  expect(next.nextHref).toBe("/console/fellows/fellow-activity?after=P-A09");
});

test("sign-in and invalid links do not dispatch reads", async () => {
  let calls = 0;
  const read: Parameters<typeof loadSponsorActivityPage>[3] = async () => {
    calls += 1;
    return { ok: true, data: activityPage };
  };
  for (const principal of [undefined, null, "", "person@example.com"]) {
    expect(await loadSponsorActivityPage(principal, fellow, {}, read)).toEqual({ status: "sign-in" });
  }
  expect(await loadSponsorActivityPage(sponsor, fellow, { after: "bad" }, read)).toEqual({
    status: "invalid",
  });
  expect(calls).toBe(0);
});

test("scope changes, inconsistent pages and failures withhold all private data", async () => {
  for (const data of [
    { ...activityPage, sponsor_id: "usr_other" },
    { ...activityPage, fellow_id: "fellow-other" },
    { ...activityPage, after_problem_id: "P-ALPHA" },
    { ...activityPage, assignments: [...activityPage.assignments].reverse() },
    { ...activityPage, next_cursor: "P-BETA" },
    { ...activityPage, omitted: [] },
    {
      ...activityPage,
      assignments: [{
        ...activityPage.assignments[0]!,
        last_public_increment: {
          ...activityPage.assignments[0]!.last_public_increment!,
          body_md: "PRIVATE_RESEARCH_CANARY",
        },
      }],
      omitted: [],
    },
  ]) {
    expect(await loadSponsorActivityPage(sponsor, fellow, {}, async () => ({
      ok: true, data,
    }))).toEqual({ status: "unavailable" });
  }
  for (const reason of ["unconfigured", "unreachable", "refused"] as const) {
    expect(await loadSponsorActivityPage(sponsor, fellow, {}, async () => ({
      ok: false, reason, detail: "PRIVATE_REFUSAL_CANARY",
    }))).toEqual({ status: "unavailable" });
  }
  expect(await loadSponsorActivityPage(sponsor, fellow, {}, async () => {
    throw new Error("PRIVATE_ERROR_CANARY");
  })).toEqual({ status: "unavailable" });
});

test("work view escapes handbacks and links exact history without inventing live activity", async () => {
  const page = await loadSponsorActivityPage(sponsor, fellow, {}, async () => ({
    ok: true, data: activityPage,
  }));
  if (page.status !== "ready") throw new Error("Expected a readable work page.");
  const html = renderToStaticMarkup(<SponsorActivityView page={page} />);
  expect(html).toContain("PRIVATE_HANDBACK");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("do not establish that the harness is currently working");
  expect(html).toContain("not a live");
  expect(html).toContain(activityPage.open_sessions[0]!.last_heartbeat_at);
  expect(html).toContain('/p/P-ALPHA/events?since=6&amp;limit=1&amp;through=7');
  expect(html).toContain('/console/workshop/fellow-activity/P-BETA');
  expect(html).not.toContain('href="/p/P-BETA"');
  expect(html).toContain('/console/workshop-search');
  expect(html).toContain("untrusted research context");
  expect(html).not.toContain("/v1/");
});

test("an older assignment page still renders independently recorded sessions and real omissions", async () => {
  const data = {
    ...activityPage,
    after_problem_id: "P-ALPHA",
    assignments: [activityPage.assignments[1]!],
  };
  const page = await loadSponsorActivityPage(sponsor, fellow, { after: "P-ALPHA" }, async () => ({
    ok: true, data,
  }));
  if (page.status !== "ready") throw new Error("Expected a later assignment page.");
  const html = renderToStaticMarkup(<SponsorActivityView page={page} />);
  expect(html).toContain("P-ALPHA private workshop");
  expect(html).toContain("First assignments");
  expect(html).toContain('name="after" value="P-ALPHA"');
  expect(html).toContain("Public titles and activity are unavailable");
  expect(html).not.toContain("PRIVATE_HANDBACK");
});
