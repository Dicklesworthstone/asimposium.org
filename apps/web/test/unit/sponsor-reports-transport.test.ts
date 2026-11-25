import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  PRODUCTION_STOA_ORIGIN,
  SPONSOR_REPORTS_MAX_RESPONSE_BYTES,
  type SponsorReportsRequest,
} from "@asimposium/contracts";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";
import {
  pendingReport,
  reportsPage,
  reportsSponsor,
  resolvedReport,
} from "../fixtures/sponsor-reports";

mock.module("server-only", () => ({}));
const { stoaSponsorReports } = await import("../../lib/stoa");
const envKeys = [
  "STOA_ORIGIN",
  "SERVICE_ENVELOPE_PRIVATE_KEY_HEX",
  "SERVICE_ENVELOPE_KID",
] as const;
const realFetch = globalThis.fetch;
let previous: Map<string, string | undefined>;
beforeEach(() => {
  previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "17".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "report-history-test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("report history signs the exact bounded read body and never sends cookies or mutation keys", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(reportsPage);
  }) as unknown as typeof fetch;
  expect(await stoaSponsorReports(reportsSponsor, { limit: 20 })).toEqual({
    ok: true,
    data: reportsPage,
  });
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (call === undefined) throw new Error("Report history was not dispatched");
  const body = JSON.stringify({ limit: 20 });
  expect(call.url).toBe(`${PRODUCTION_STOA_ORIGIN}/v1/sponsors/reports/list`);
  expect(call.init).toMatchObject({
    method: "POST",
    body,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  const headers = new Headers(call.init.headers);
  for (const absent of ["authorization", "cookie", "idempotency-key"])
    expect(headers.has(absent)).toBe(false);
  expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
    route: "/v1/sponsors/reports/list",
    action: "sponsor.reports.list",
    principal_type: "sponsor",
    principal_id: reportsSponsor,
    payload_sha256: await payloadDigest(body),
  });
});

test("report history preserves continuation and rejects another sponsor or an invalid readback", async () => {
  let response: unknown = { ...reportsPage, reports: [resolvedReport] };
  const request = {
    limit: 20,
    before: { created_at: pendingReport.created_at, report_id: pendingReport.report_id },
  };
  let sent: unknown;
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return Response.json(response);
  }) as unknown as typeof fetch;
  expect((await stoaSponsorReports(reportsSponsor, request)).ok).toBe(true);
  expect(sent).toEqual({ before: request.before, limit: 20 });
  for (const value of [
    { ...reportsPage, sponsor_id: "usr_other" },
    { ...reportsPage, reports: [...reportsPage.reports].reverse() },
    { ...reportsPage, reports: [{ ...pendingReport, note: "PRIVATE_OPERATOR_NOTE" }] },
    { ...reportsPage, has_more: true },
  ]) {
    response = value;
    expect(await stoaSponsorReports(reportsSponsor, { limit: 20 })).toEqual({
      ok: false,
      reason: "unreachable",
    });
  }
  response = reportsPage;
  expect(await stoaSponsorReports(reportsSponsor, request)).toEqual({
    ok: false,
    reason: "unreachable",
  });
});

test("invalid requests never dispatch and oversized private histories fail closed", async () => {
  const fetcher = mock(async () => Response.json(reportsPage));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  for (const value of [
    { limit: 20, sponsor_id: reportsSponsor },
    { limit: 51 },
    { limit: 20, before: { report_id: pendingReport.report_id } },
  ])
    expect(await stoaSponsorReports(reportsSponsor, value as SponsorReportsRequest)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  expect(fetcher).not.toHaveBeenCalled();
  globalThis.fetch = mock(
    async () =>
      new Response("PRIVATE_OVERSIZED_REPORTS", {
        headers: { "content-length": String(SPONSOR_REPORTS_MAX_RESPONSE_BYTES + 1) },
      }),
  ) as unknown as typeof fetch;
  expect(await stoaSponsorReports(reportsSponsor, { limit: 20 })).toEqual({
    ok: false,
    reason: "unreachable",
  });
});
