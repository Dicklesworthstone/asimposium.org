import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  generateIntegrityCasesSchema,
  INTEGRITY_CASES_SCHEMA_ID,
  INTEGRITY_CONCERNS,
  INTEGRITY_OUTCOMES,
  IntegrityCaseActionSchema,
  IntegrityCaseDetailResponseSchema,
  IntegrityCaseListResponseSchema,
  IntegrityCaseOpenRequestSchema,
  IntegrityCaseQuerySchema,
  IntegrityCaseReadRequestSchema,
  IntegrityCaseReceiptSchema,
  IntegrityCaseRespondRequestSchema,
  IntegrityCaseResolveRequestSchema,
  IntegrityCaseSchema,
  IntegrityCaseSummarySchema,
  IntegrityPublicationPinSchema,
  OperatorIntegrityCaseDetailResponseSchema,
  PublicIntegrityNoticesResponseSchema,
  integrityCaseDetailMatchesRequest,
  integrityCaseListMatchesQuery,
} from "../../src/integrity-cases.ts";

async function fixture(path: string): Promise<unknown> {
  return JSON.parse(
    await Bun.file(new URL(`../fixtures/${path}.json`, import.meta.url)).text(),
  );
}
const CASE = `IC-${"0".repeat(25)}1`;
const OTHER_CASE = `IC-${"0".repeat(25)}2`;
const REPORT = `RP-${"0".repeat(25)}1`;
const openedAt = "2026-10-30T12:00:00.000Z";
const pin = {
  problem_id: "P-INTEGRITY",
  target_ref: "C-1@1",
  event_id: "event-integrity-source",
  payload_sha256: "a".repeat(64),
  seq: 2,
};
const summaryFields = {
  case_id: CASE,
  source: pin,
  subject_sponsor_id: "sponsor-subject",
  subject_fellow_id: "fellow-subject",
  concern: "fabricated-source",
  public_notice: true,
  state: "open",
  revision: 1,
  appeals_used: 0,
  opened_at: openedAt,
  resolved_at: null,
};
function caseRecord() {
  return IntegrityCaseSchema.parse({
    ...summaryFields,
    summary: "Investigate the reported source against its retained publication.",
    outcome: null,
    rationale: null,
    corrections: [],
  });
}
function openedAction() {
  return IntegrityCaseActionSchema.parse({
    action_id: `IA-${"0".repeat(25)}1`,
    revision: 1,
    kind: "opened",
    actor_class: "operator",
    actor_id: "sponsor-operator",
    created_at: openedAt,
    body: {
      summary: caseRecord().summary,
      concern: "fabricated-source",
      public_notice: true,
    },
  });
}
function responseAction() {
  return IntegrityCaseActionSchema.parse({
    action_id: `IA-${"0".repeat(25)}2`,
    revision: 2,
    kind: "response",
    actor_class: "sponsor",
    actor_id: "sponsor-subject",
    created_at: "2026-10-30T12:30:00.000Z",
    body: { response: "The source is retained and the citation typo is corrected." },
  });
}

test("canonical JSON Schema and Zod agree on commands and public privacy fixtures", async () => {
  const schema = JSON.parse(generateIntegrityCasesSchema());
  expect(schema.$id).toBe(INTEGRITY_CASES_SCHEMA_ID);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema(schema, "integrity");
  const examples = [
    ["open", IntegrityCaseOpenRequestSchema, "integrity-case-open", [
      "integrity-case-open-identity",
      "integrity-case-open-weak-science",
    ]],
    ["respond", IntegrityCaseRespondRequestSchema, "integrity-case-respond", []],
    ["resolve", IntegrityCaseResolveRequestSchema, "integrity-case-resolve", [
      "integrity-case-resolve-override",
      "integrity-case-resolve-unpinned",
    ]],
    ["public_notices", PublicIntegrityNoticesResponseSchema, "integrity-notices", [
      "integrity-notices-private",
    ]],
  ] as const;
  for (const [property, zod, valid, invalid] of examples) {
    const validate = ajv.compile({ $ref: `integrity#/properties/${property}` });
    const accepted = await fixture(`valid/${valid}`);
    expect(zod.safeParse(accepted).success).toBe(true);
    expect(validate(accepted)).toBe(true);
    for (const rejected of invalid) {
      const value = await fixture(`invalid/${rejected}`);
      expect(zod.safeParse(value).success).toBe(false);
      expect(validate(value)).toBe(false);
    }
  }
});

test("the concern taxonomy distinguishes allegations from ordinary scientific error", async () => {
  const open = IntegrityCaseOpenRequestSchema.parse(await fixture("valid/integrity-case-open"));
  for (const concern of INTEGRITY_CONCERNS) {
    expect(IntegrityCaseOpenRequestSchema.safeParse({ ...open, concern }).success).toBe(true);
  }
  for (const concern of ["wrong", "unverified-source", "failed-reproduction", "honest-error"]) {
    expect(IntegrityCaseOpenRequestSchema.safeParse({ ...open, concern }).success).toBe(false);
  }
  for (const override of [
    { subject_sponsor_id: "chosen-subject" },
    { source_event_id: "chosen-event" },
    { sponsor_strikes: 1 },
    { disposition: "refuted" },
  ]) {
    expect(IntegrityCaseOpenRequestSchema.safeParse({ ...open, ...override }).success).toBe(false);
  }
});

test("outcomes include honest error and never accept a scientific or strike override", async () => {
  const resolve = IntegrityCaseResolveRequestSchema.parse(
    await fixture("valid/integrity-case-resolve"),
  );
  for (const outcome of INTEGRITY_OUTCOMES) {
    expect(IntegrityCaseResolveRequestSchema.safeParse({ ...resolve, outcome }).success).toBe(true);
  }
  expect(IntegrityCaseResolveRequestSchema.safeParse({
    ...resolve, conflict_declaration: "I might be involved",
  }).success).toBe(false);
  expect(IntegrityCaseResolveRequestSchema.safeParse({
    ...resolve, correction_refs: [resolve.correction_refs[0], resolve.correction_refs[0]],
  }).success).toBe(false);
  expect(IntegrityCaseResolveRequestSchema.safeParse({
    ...resolve, sponsor_strike: true,
  }).success).toBe(false);
});

test("publication references are exact and sponsor-only authors retain their real principal", () => {
  expect(IntegrityPublicationPinSchema.safeParse(pin).success).toBe(true);
  for (const bad of [
    { ...pin, target_ref: "C-1" },
    { ...pin, seq: 0 },
    { ...pin, payload_sha256: "a".repeat(63) },
    { ...pin, payload_json: "private source bytes" },
  ]) {
    expect(IntegrityPublicationPinSchema.safeParse(bad).success).toBe(false);
  }
  expect(IntegrityCaseSchema.safeParse({
    ...caseRecord(), subject_fellow_id: null,
  }).success).toBe(true);
});

test("current case state cannot claim a resolution without its decision or retain it after appeal", () => {
  const open = caseRecord();
  expect(IntegrityCaseSchema.safeParse({ ...open, state: "resolved" }).success).toBe(false);
  expect(IntegrityCaseSchema.safeParse({ ...open, outcome: "confirmed" }).success).toBe(false);
  expect(IntegrityCaseSchema.safeParse({ ...open, corrections: [pin] }).success).toBe(false);
  const resolved = {
    ...open,
    state: "resolved",
    revision: 2,
    resolved_at: "2026-10-30T13:00:00.000Z",
    outcome: "unsubstantiated",
    rationale: "The retained evidence does not substantiate the allegation.",
  };
  expect(IntegrityCaseSchema.safeParse(resolved).success).toBe(true);
  expect(IntegrityCaseSchema.safeParse({
    ...resolved, resolved_at: "2026-10-29T13:00:00.000Z",
  }).success).toBe(false);
  expect(IntegrityCaseSchema.safeParse({
    ...open, revision: 3, appeals_used: 1,
  }).success).toBe(true);
  expect(IntegrityCaseSchema.safeParse({ ...open, appeals_used: 2 }).success).toBe(false);
});

test("sponsor detail excludes reporter identity, report notes and the operator-only report id", () => {
  const detail = {
    schema: INTEGRITY_CASES_SCHEMA_ID,
    case: caseRecord(),
    actions: [openedAction()],
    has_more: false,
    next_after_revision: null,
  };
  expect(IntegrityCaseDetailResponseSchema.safeParse(detail).success).toBe(true);
  for (const privateField of [
    { reporter_sponsor_id: "sponsor-reporter" },
    { note: "Restricted report note" },
    { report_id: REPORT },
  ]) {
    expect(IntegrityCaseDetailResponseSchema.safeParse({
      ...detail, case: { ...detail.case, ...privateField },
    }).success).toBe(false);
  }
  expect(IntegrityCaseDetailResponseSchema.safeParse({
    ...detail, report_id: REPORT,
  }).success).toBe(false);
  expect(OperatorIntegrityCaseDetailResponseSchema.safeParse({
    ...detail, report_id: REPORT,
  }).success).toBe(true);
});

test("history reads bind case identity and walk every revision without omission", () => {
  const request = IntegrityCaseReadRequestSchema.parse({ case_id: CASE, limit: 1 });
  const first = IntegrityCaseDetailResponseSchema.parse({
    schema: INTEGRITY_CASES_SCHEMA_ID,
    case: { ...caseRecord(), revision: 2 },
    actions: [openedAction()],
    has_more: true,
    next_after_revision: 1,
  });
  expect(integrityCaseDetailMatchesRequest(request, first)).toBe(true);
  const secondRequest = { ...request, after_revision: 1 };
  const second = {
    ...first,
    actions: [responseAction()],
    has_more: false,
    next_after_revision: null,
  };
  expect(integrityCaseDetailMatchesRequest(secondRequest, second)).toBe(true);
  expect(integrityCaseDetailMatchesRequest(request, second)).toBe(false);
  expect(integrityCaseDetailMatchesRequest({ ...request, case_id: OTHER_CASE }, first)).toBe(false);
  expect(integrityCaseDetailMatchesRequest(request, { ...first, has_more: false })).toBe(false);
  expect(integrityCaseDetailMatchesRequest(secondRequest, {
    ...second, actions: [],
  })).toBe(false);
  expect(integrityCaseDetailMatchesRequest(secondRequest, {
    ...second, actions: [{ ...responseAction(), revision: 3 }],
  })).toBe(false);
});

test("private list cursors bind the final admitted case and preserve descending order", () => {
  const query = IntegrityCaseQuerySchema.parse({ limit: 1 });
  const summary = IntegrityCaseSummarySchema.parse(summaryFields);
  const page = IntegrityCaseListResponseSchema.parse({
    schema: INTEGRITY_CASES_SCHEMA_ID,
    cases: [summary],
    has_more: true,
    next_cursor: { opened_at: openedAt, case_id: CASE },
  });
  expect(integrityCaseListMatchesQuery(query, page)).toBe(true);
  expect(integrityCaseListMatchesQuery(query, {
    ...page, next_cursor: { opened_at: openedAt, case_id: OTHER_CASE },
  })).toBe(false);
  expect(integrityCaseListMatchesQuery({
    ...query, before: { opened_at: openedAt, case_id: CASE },
  }, page)).toBe(false);
  expect(integrityCaseListMatchesQuery({ ...query, limit: 2 }, {
    ...page, cases: [summary, summary],
  })).toBe(false);
});

test("case actions and receipts cannot switch actor class, order, appeal limit or state", () => {
  const action = openedAction();
  expect(IntegrityCaseActionSchema.safeParse({ ...action, actor_class: "sponsor" }).success).toBe(false);
  expect(IntegrityCaseActionSchema.safeParse({ ...action, revision: 2 }).success).toBe(false);
  expect(IntegrityCaseActionSchema.safeParse({
    ...responseAction(), body: { response: "A reply with an override", outcome: "confirmed" },
  }).success).toBe(false);
  const receipt = {
    case_id: CASE,
    action_id: action.action_id,
    revision: 1,
    state: "open",
    action: "opened",
    created_at: openedAt,
    appeals_used: 0,
  };
  expect(IntegrityCaseReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(IntegrityCaseReceiptSchema.safeParse({
    ...receipt, action: "resolved",
  }).success).toBe(false);
  expect(IntegrityCaseReceiptSchema.safeParse({
    ...receipt, action: "appealed", revision: 3,
  }).success).toBe(false);
});

test("public notices carry only source pins and neutral state, including on confirmed cases", async () => {
  const page = PublicIntegrityNoticesResponseSchema.parse(await fixture("valid/integrity-notices"));
  for (const extra of [
    { concern: "fabricated-source" },
    { outcome: "confirmed" },
    { summary: "A private allegation" },
    { reporter_sponsor_id: "sponsor-reporter" },
    { subject_sponsor_id: "sponsor-subject" },
    { rationale: "A private decision" },
    { report_id: REPORT },
    { response: "A private sponsor statement" },
  ]) {
    expect(PublicIntegrityNoticesResponseSchema.safeParse({
      ...page, notices: [{ ...page.notices[0], ...extra }],
    }).success).toBe(false);
  }
  expect(PublicIntegrityNoticesResponseSchema.safeParse({
    ...page, problem_id: "P-OTHER",
  }).success).toBe(false);
  expect(PublicIntegrityNoticesResponseSchema.safeParse({
    ...page, has_more: true,
  }).success).toBe(false);
  expect(PublicIntegrityNoticesResponseSchema.safeParse({
    ...page, notices: [page.notices[0], page.notices[0]],
  }).success).toBe(false);
});
