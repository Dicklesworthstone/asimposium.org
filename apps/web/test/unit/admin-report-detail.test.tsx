import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { ADMIN_REPORT_DETAIL_MAX_RESPONSE_BYTES, AdminReportDetailSchema } from "@asimposium/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportEvidence } from "../../app/admin/reports/report-evidence";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";

mock.module("server-only", () => ({}));
const { stoaAdminReportDetail } = await import("../../lib/stoa");
const detail = AdminReportDetailSchema.parse(await Bun.file(new URL(
  "../../../../packages/contracts/test/fixtures/valid/admin-report-detail.json", import.meta.url,
)).json());
const operator = "usr_report_operator";
const envKeys = ["STOA_ORIGIN", "SERVICE_ENVELOPE_PRIVATE_KEY_HEX", "SERVICE_ENVELOPE_KID", "OPERATOR_PRINCIPAL_IDS"] as const;
let old: Map<string, string | undefined>;
const realFetch = globalThis.fetch;
beforeEach(() => {
  old = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = "https://a.asimposium.org";
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "11".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "report-detail-transport";
  process.env.OPERATOR_PRINCIPAL_IDS = operator;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of envKeys) {
    const value = old.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("exact report transport signs the operator, target route/action and empty GET body without caching", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(detail);
  }) as unknown as typeof fetch;
  expect(await stoaAdminReportDetail(operator, detail.report.report_id)).toEqual({ ok: true, data: detail });
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.url).toBe(`https://a.asimposium.org/v1/operators/reports/${detail.report.report_id}`);
  expect(call.init).toMatchObject({ method: "GET", credentials: "omit", cache: "no-store", redirect: "error" });
  const headers = new Headers(call.init.headers);
  expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
    principal_type: "operator", principal_id: operator,
    route: "/v1/operators/reports/:reportId", action: "operator.reports.read",
    payload_sha256: await payloadDigest(""),
  });
  expect(headers.has("cookie")).toBe(false);
});

test("report transport refuses invalid local IDs, wrong response identity and oversized detail", async () => {
  let calls = 0;
  globalThis.fetch = mock(async () => { calls++; return Response.json(detail); }) as unknown as typeof fetch;
  for (const id of ["../reports", `${detail.report.report_id}?include=workshop`, `${detail.report.report_id}\n`, "RP-short"]) {
    expect((await stoaAdminReportDetail(operator, id)).ok).toBe(false);
  }
  expect(calls).toBe(0);
  globalThis.fetch = mock(async () => Response.json({ ...detail, report: { ...detail.report, report_id: `RP-${"1".repeat(26)}` } })) as unknown as typeof fetch;
  expect(await stoaAdminReportDetail(operator, detail.report.report_id)).toEqual({ ok: false, reason: "unreachable" });
  globalThis.fetch = mock(async () => new Response("private oversized body", {
    headers: { "content-type": "application/json", "content-length": String(ADMIN_REPORT_DETAIL_MAX_RESPONSE_BYTES + 1) },
  })) as unknown as typeof fetch;
  expect(await stoaAdminReportDetail(operator, detail.report.report_id)).toEqual({ ok: false, reason: "unreachable" });
});

test("operator evidence renders malicious notes, source bytes and labels only as inert text", () => {
  if (detail.source.state !== "available") throw new Error("Available source fixture required");
  const html = renderToStaticMarkup(<ReportEvidence detail={{ ...detail,
    note: "<script>report_note()</script> [click](javascript:report_note())",
    source: { ...detail.source, model_self_declared: "<img src=x onerror=report_model()>",
      payload_json: '{"statement":"<iframe src=javascript:report_source()></iframe>"}' },
  }} />);
  expect(html).toContain("&lt;script&gt;report_note()&lt;/script&gt;");
  expect(html).toContain("&lt;iframe");
  expect(html).toContain("&lt;img");
  expect(html).toContain("[click](javascript:report_note())");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<iframe");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("href=");
  expect(html).toContain(detail.source.event_id);
  expect(html).toContain(detail.source.payload_sha256);
});

test("unavailable and captured-at-filing evidence explain their limits without substituting text", () => {
  const html = renderToStaticMarkup(<ReportEvidence detail={{ ...detail, source: { state: "unavailable", reason: "not-pinned" } }} />);
  expect(html).toContain("did not retain an exact source");
  expect(html).toContain("A decision is disabled");
  expect(html).not.toContain("An exact original public statement");
  if (detail.source.state !== "available") throw new Error("Available source fixture required");
  const captured = renderToStaticMarkup(<ReportEvidence detail={{ ...detail, source: { ...detail.source, binding: "captured-at-filing" } }} />);
  expect(captured).toContain("does not establish which earlier page the reporter viewed");
});
