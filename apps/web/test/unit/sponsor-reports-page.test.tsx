import { expect, mock, test } from "bun:test";
import type { SponsorReportsResponse } from "@asimposium/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { SponsorReportsView } from "../../components/sponsor-reports-view";
import {
  loadSponsorReportsPage,
  type SponsorReportsQuery,
  sponsorReportsPageHref,
  sponsorReportsPageRequest,
} from "../../lib/sponsor-reports-view";
import type { StoaCall } from "../../lib/stoa";
import {
  pendingReport,
  reportsPage,
  reportsSponsor,
  resolvedReport,
} from "../fixtures/sponsor-reports";

test("history query uses complete canonical cursors and refuses private or repeated parameters", () => {
  expect(sponsorReportsPageRequest({})).toEqual({ limit: 20 });
  const query = { before_at: pendingReport.created_at, before_id: pendingReport.report_id };
  expect(sponsorReportsPageRequest(query)).toEqual({
    limit: 20,
    before: {
      created_at: pendingReport.created_at,
      report_id: pendingReport.report_id,
    },
  });
  for (const invalid of [
    { before_at: pendingReport.created_at },
    { before_id: pendingReport.report_id },
    { ...query, before_at: [pendingReport.created_at] },
    { ...query, before_at: "yesterday" },
    { sponsor_id: "usr_other" },
    { note: "private text" },
  ])
    expect(sponsorReportsPageRequest(invalid)).toBeNull();
});

test("unauthenticated and invalid history requests never contact Stoa", async () => {
  const reader = mock(async () => ({ ok: true as const, data: reportsPage }));
  expect(await loadSponsorReportsPage(undefined, {}, reader)).toEqual({ status: "sign-in" });
  expect(await loadSponsorReportsPage("someone@example.test", {}, reader)).toEqual({
    status: "sign-in",
  });
  expect(await loadSponsorReportsPage(reportsSponsor, { before_id: "wrong" }, reader)).toEqual({
    status: "invalid",
  });
  expect(reader).not.toHaveBeenCalled();
});

test("a private read failure or wrong account cannot become an empty history", async () => {
  expect(await loadSponsorReportsPage(reportsSponsor, {}, async () => ({ ok: false }))).toEqual({
    status: "unavailable",
  });
  expect(
    await loadSponsorReportsPage(reportsSponsor, {}, async () => {
      throw new Error("temporary read failure");
    }),
  ).toEqual({ status: "unavailable" });
  expect(
    await loadSponsorReportsPage(reportsSponsor, {}, async () => ({
      ok: true,
      data: { ...reportsPage, sponsor_id: "usr_other" },
    })),
  ).toEqual({ status: "unavailable" });
});

test("continuation uses the exact final row of the verified bounded page", async () => {
  const reports = Array.from({ length: 20 }, (_, index) => ({
    ...pendingReport,
    report_id: `RP-${String(99 - index).padStart(26, "0")}`,
  }));
  const last = reports.at(-1);
  if (last === undefined) throw new Error("missing report fixture");
  const cursor = { created_at: last.created_at, report_id: last.report_id };
  const page = await loadSponsorReportsPage(reportsSponsor, {}, async () => ({
    ok: true,
    data: { ...reportsPage, reports, has_more: true, next_cursor: cursor },
  }));
  expect(page.status).toBe("ready");
  if (page.status !== "ready") return;
  expect(page.nextHref).toBe(sponsorReportsPageHref(cursor));
  expect(page.nextHref).not.toContain("reason");
});

async function renderHistory(
  sponsor: unknown = reportsSponsor,
  query: SponsorReportsQuery = {},
  result: StoaCall<SponsorReportsResponse> = { ok: true, data: reportsPage },
): Promise<string> {
  const page = await loadSponsorReportsPage(sponsor, query, async () => result);
  const request = sponsorReportsPageRequest(query);
  return renderToStaticMarkup(
    <SponsorReportsView
      page={page}
      returnPath={sponsorReportsPageHref(request?.before)}
      signInAction={async () => {}}
    />,
  );
}

test("renders current statuses, source links and filing accountability without operator notes", async () => {
  const html = await renderHistory();
  expect(html).toContain("Awaiting operator review");
  expect(html).toContain("Dismissed by an operator");
  expect(html).toContain(pendingReport.report_id);
  expect(html).toContain(resolvedReport.resolved_at);
  expect(html).toContain("/p/P-4DSP/claims/C-1%402");
  expect(html).toContain("/r/p/P-4DSP/evidence/E-1");
  expect(html).toContain("A Fellow under your sponsorship at filing");
  expect(html).not.toContain("PRIVATE_OPERATOR_NOTE");
});

test("unavailable history offers retry instead of showing a fabricated empty state", async () => {
  const html = await renderHistory(reportsSponsor, {}, { ok: false, reason: "unreachable" });
  expect(html).toContain("Report history unavailable");
  expect(html).toContain("Retry this page");
  expect(html).not.toContain("No conduct reports are recorded");
});

test("signed-out and invalid query views cannot render another account's report identifiers", async () => {
  const signedOut = await renderHistory(null);
  expect(signedOut).toContain("Sign in with Google");
  expect(signedOut).not.toContain(pendingReport.report_id);
  const invalid = await renderHistory(reportsSponsor, { before_id: pendingReport.report_id });
  expect(invalid).toContain("Invalid report history link");
  expect(invalid).not.toContain(pendingReport.report_id);
});
