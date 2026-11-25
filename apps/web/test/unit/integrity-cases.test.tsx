import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  INTEGRITY_CASES_SCHEMA_ID,
  INTEGRITY_CASE_MAX_RESPONSE_BYTES,
  IntegrityCaseDetailResponseSchema,
  IntegrityCaseListResponseSchema,
  IntegrityCaseQuerySchema,
  IntegrityCaseReadRequestSchema,
  PublicIntegrityNoticesResponseSchema,
  type IntegrityCaseReceipt,
} from "@asimposium/contracts/integrity-cases";
import { IntegrityCaseView } from "../../components/integrity-case-view";
import { IntegrityNoticesView } from "../../components/integrity-notices-view";
import {
  integrityAuthIsRecent,
  integrityCaseHref,
  integrityNoticesMatchQuery,
  integrityNoticesPath,
  integrityPublicationHref,
  integrityWriteState,
  parseIntegrityHistoryQuery,
  parseIntegrityListQuery,
  parseIntegrityNoticesQuery,
  type IntegrityAttempt,
} from "../../lib/integrity-view";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";

mock.module("server-only", () => ({}));
const {
  stoaIntegrityCases,
  stoaOperatorIntegrityCase,
  stoaSponsorIntegrityCase,
  stoaRespondToIntegrityCase,
} = await import("../../lib/integrity-cases");
const { stoaFetchIntegrityNotices } = await import("../../lib/public-integrity-notices");

const operator = "usr_integrity_operator";
const sponsor = "usr_integrity_subject";
const id = "IC-" + "0".repeat(25) + "1";
const at = "2026-11-24T00:00:00.000Z";
const source = {
  problem_id: "P-4DSP", target_ref: "C-1@2", seq: 7,
  event_id: "EV-integrity-source", payload_sha256: "a".repeat(64),
};
const detail = IntegrityCaseDetailResponseSchema.parse({
  schema: INTEGRITY_CASES_SCHEMA_ID,
  case: {
    case_id: id, source, subject_sponsor_id: sponsor, subject_fellow_id: null,
    concern: "fabricated-source", summary: "Review this exact source citation.",
    public_notice: true, state: "open", revision: 2, appeals_used: 0,
    opened_at: at, resolved_at: null, outcome: null, rationale: null, corrections: [],
  },
  actions: [
    { action_id: "IA-" + "0".repeat(25) + "1", revision: 1, kind: "opened",
      actor_class: "operator", actor_id: operator, created_at: at,
      body: { concern: "fabricated-source", summary: "Review this exact source citation.", public_notice: true } },
    { action_id: "IA-" + "0".repeat(25) + "2", revision: 2, kind: "response",
      actor_class: "sponsor", actor_id: sponsor, created_at: at,
      body: { response: "The archived original source is available." } },
  ], has_more: false, next_after_revision: null,
});
const query = IntegrityCaseQuerySchema.parse({});
const read = IntegrityCaseReadRequestSchema.parse({ case_id: id });
const summary = {
  case_id: id, source, subject_sponsor_id: sponsor, subject_fellow_id: null,
  concern: "fabricated-source", public_notice: true, state: "open", revision: 2,
  appeals_used: 0, opened_at: at, resolved_at: null,
};
const list = IntegrityCaseListResponseSchema.parse({
  schema: INTEGRITY_CASES_SCHEMA_ID, cases: [summary], has_more: false, next_cursor: null,
});
const notices = PublicIntegrityNoticesResponseSchema.parse({
  schema: INTEGRITY_CASES_SCHEMA_ID, problem_id: source.problem_id,
  notices: [{ case_id: id, source, state: "open", opened_at: at, updated_at: at, corrections: [] }],
  has_more: false, next_after: null,
});

const envKeys = ["STOA_ORIGIN", "SERVICE_ENVELOPE_PRIVATE_KEY_HEX", "SERVICE_ENVELOPE_KID", "OPERATOR_PRINCIPAL_IDS"] as const;
let old: Map<string, string | undefined>;
const realFetch = globalThis.fetch;
beforeEach(() => {
  old = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = "https://a.asimposium.org";
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "11".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "integrity-transport";
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

test("private case reads sign the exact actor, route, action and canonical body", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(list);
  }) as unknown as typeof fetch;
  expect(await stoaIntegrityCases(operator, "operator", query)).toEqual({ ok: true, data: list });
  const call = calls[0]!;
  expect(call.url).toBe("https://a.asimposium.org/v1/operators/integrity/cases/query");
  expect(call.init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store", redirect: "error" });
  expect(call.init.body).toBe(JSON.stringify({ limit: 20 }));
  const headers = new Headers(call.init.headers);
  expect(headers.has("cookie")).toBe(false);
  expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
    principal_type: "operator", principal_id: operator,
    route: "/v1/operators/integrity/cases/query", action: "operator.integrity.cases.query",
    payload_sha256: await payloadDigest(String(call.init.body)),
  });
});

test("sponsor transport rejects another sponsor's case and operator-only report details", async () => {
  globalThis.fetch = mock(async () => Response.json(detail)) as unknown as typeof fetch;
  expect(await stoaSponsorIntegrityCase(sponsor, read)).toEqual({ ok: true, data: detail });
  expect((await stoaSponsorIntegrityCase("usr_other", read)).ok).toBe(false);
  globalThis.fetch = mock(async () => Response.json({
    ...detail, report_id: "RP-" + "0".repeat(26),
  })) as unknown as typeof fetch;
  expect((await stoaSponsorIntegrityCase(sponsor, read)).ok).toBe(false);
  expect((await stoaOperatorIntegrityCase(operator, read)).ok).toBe(true);
  globalThis.fetch = mock(async () => Response.json(list)) as unknown as typeof fetch;
  expect((await stoaIntegrityCases("usr_other", "sponsor", query)).ok).toBe(false);
});

test("case readers reject missing history revisions and excessive private response bodies", async () => {
  globalThis.fetch = mock(async () => Response.json({ ...detail, actions: [detail.actions[1]] })) as unknown as typeof fetch;
  expect((await stoaSponsorIntegrityCase(sponsor, read)).ok).toBe(false);
  globalThis.fetch = mock(async () => new Response("oversize", {
    headers: { "content-type": "application/json", "content-length": String(INTEGRITY_CASE_MAX_RESPONSE_BYTES + 1) },
  })) as unknown as typeof fetch;
  expect((await stoaSponsorIntegrityCase(sponsor, read)).ok).toBe(false);
});

test("write acknowledgments must name this case and its exact next revision", async () => {
  const receipt: IntegrityCaseReceipt = {
    case_id: id, action_id: "IA-" + "0".repeat(25) + "3", revision: 3,
    state: "open", action: "response", created_at: at, appeals_used: 0,
  };
  const request = { case_id: id, expected_revision: 2, response: "An exact response with evidence." };
  globalThis.fetch = mock(async () => Response.json(receipt)) as unknown as typeof fetch;
  expect(await stoaRespondToIntegrityCase(sponsor, request, "integrity-response-key")).toEqual({ ok: true, data: receipt });
  for (const wrong of [{ ...receipt, revision: 4 }, { ...receipt, case_id: "IC-" + "1".repeat(26) }]) {
    globalThis.fetch = mock(async () => Response.json(wrong)) as unknown as typeof fetch;
    expect((await stoaRespondToIntegrityCase(sponsor, request, "integrity-response-key")).ok).toBe(false);
  }
});

test("history URLs reject actor substitution, partial cursors and noncanonical revisions", () => {
  expect(parseIntegrityListQuery({})).toEqual({ limit: 20 });
  expect(parseIntegrityListQuery({ before_at: at, before_id: id })).toEqual({ before: { opened_at: at, case_id: id }, limit: 20 });
  for (const invalid of [{ before_at: at }, { before_id: id }, { sponsor_id: sponsor }, { before_id: [id], before_at: at }])
    expect(parseIntegrityListQuery(invalid)).toBeNull();
  for (const revision of ["01", "-1", "1e2", "2\n", "9007199254740992"])
    expect(parseIntegrityHistoryQuery(id, { after_revision: revision })).toBeNull();
  expect(parseIntegrityHistoryQuery(id, { after_revision: "2" })).toEqual({ case_id: id, after_revision: 2, limit: 20 });
  expect(parseIntegrityNoticesQuery({ after: id, summary: "PRIVATE" })).toBeNull();
  expect(parseIntegrityNoticesQuery({ after: [id] })).toBeNull();
  expect(integrityCaseHref("sponsor", id, 2)).toBe("/console/integrity/" + id + "?after_revision=2");
  expect(integrityPublicationHref(source)).toBe("/r/p/P-4DSP/events/7");
});

test("operator authentication uses the strict 15-minute boundary without future-clock tolerance", () => {
  expect(integrityAuthIsRecent(100, 1000)).toBe(true);
  expect(integrityAuthIsRecent(99, 1000)).toBe(false);
  expect(integrityAuthIsRecent(1001, 1000)).toBe(false);
  expect(integrityAuthIsRecent(undefined, 1000)).toBe(false);
  expect(integrityAuthIsRecent(Number.NaN, 1000)).toBe(false);
});

test("private allegations render as inert text and sponsor pages never link the original report", () => {
  const reportId = "RP-" + "9".repeat(26);
  const hostile = { ...detail, case: { ...detail.case, summary: "<script>private_summary()</script>" },
    actions: detail.actions.map((action) => action.kind === "response"
      ? { ...action, body: { response: "<img src=x onerror=private_response()>" } } : action) };
  const html = renderToStaticMarkup(<IntegrityCaseView page={hostile} audience="sponsor" afterRevision={0} reportId={reportId} />);
  expect(html).toContain("&lt;script&gt;private_summary()&lt;/script&gt;");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain(reportId);
  expect(html).toContain("Sponsor-authored publication");
  expect(html).toContain("/r/p/P-4DSP/events/7");
  const operatorHtml = renderToStaticMarkup(<IntegrityCaseView page={detail} audience="operator" afterRevision={0} reportId={reportId} />);
  expect(operatorHtml).toContain("/admin/reports/" + reportId);
});

test("public notice reads exclude every private field and bind the requested problem", async () => {
  for (const privateField of ["summary", "concern", "outcome", "rationale", "response", "subject_sponsor_id", "report_id"]) {
    const invalid = { ...notices, notices: [{ ...notices.notices[0], [privateField]: "PRIVATE_VALUE" }] };
    expect(PublicIntegrityNoticesResponseSchema.safeParse(invalid).success).toBe(false);
  }
  globalThis.fetch = mock(async () => Response.json(notices)) as unknown as typeof fetch;
  expect((await stoaFetchIntegrityNotices(source.problem_id)).state).toBe("ok");
  expect((await stoaFetchIntegrityNotices("P-OTHER")).state).toBe("unavailable");
  expect(integrityNoticesMatchQuery(source.problem_id, id, notices)).toBe(false);
});

test("empty withheld public segments still have a bounded forward continuation", () => {
  const page = PublicIntegrityNoticesResponseSchema.parse({
    ...notices, notices: [], has_more: true, next_after: id,
  });
  const html = renderToStaticMarkup(<IntegrityNoticesView page={page} />);
  expect(html).toContain("Continue through public notices");
  expect(html).toContain(integrityNoticesPath(source.problem_id, "human", id));
  expect(html).not.toContain("This record has a scientific-integrity review notice.");
  const populated = renderToStaticMarkup(<IntegrityNoticesView page={notices} />);
  expect(populated).toContain("not a finding of misconduct");
  expect(html).not.toContain(detail.case.summary);
  expect(html).not.toContain(sponsor);
  expect(html).not.toContain("PRIVATE_VALUE");
});

test("unknown write outcomes retain exact private intent and never invent a receipt", () => {
  const attempt: IntegrityAttempt = { kind: "respond", principalId: sponsor, key: "fixed-key",
    request: { case_id: id, expected_revision: 2, response: "An exact response with evidence." } };
  for (const failure of [
    { ok: false as const, reason: "unreachable" },
    { ok: false as const, reason: "refused", status: 503 },
    { ok: false as const, reason: "refused", status: 429 },
  ]) {
    expect(integrityWriteState(attempt, failure)).toMatchObject({ status: "unconfirmed", attempt });
  }
  expect(integrityWriteState(attempt, { ok: false, reason: "refused", status: 409 }).status).toBe("refused");
});
