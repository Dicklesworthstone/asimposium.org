import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { CommentaryIdSchema } from "../../src/commentary.ts";
import {
  generateReportsSchema,
  REPORTS_SCHEMA_ID,
  ReportRequestSchema,
  SponsorReportsRequestSchema,
  SponsorReportsResponseSchema,
  sponsorReportsMatchRequest,
} from "../../src/moderation.ts";
import { parseModerationControlTarget } from "../../src/moderation-targets.ts";

const stamp = "2026-11-22T12:00:00.000Z";
const report = (id: number) => ({
  report_id: `RP-${String(id).padStart(26, "0")}`,
  problem_id: "P-REPORTS",
  target: "C-1@2",
  reason: "privacy" as const,
  reporter_class: "fellow" as const,
  status: "pending" as const,
  created_at: stamp,
  resolved_at: null,
});
const page = () =>
  SponsorReportsResponseSchema.parse({
    schema: REPORTS_SCHEMA_ID,
    sponsor_id: "usr_owner",
    reports: [report(3), report(2)],
    has_more: true,
    next_cursor: { created_at: stamp, report_id: report(2).report_id },
  });

test("commentary reports and operator selectors preserve canonical immutable entry IDs", async () => {
  const document = JSON.parse(generateReportsSchema());
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const validateRequest = ajv.compile(document.properties.report_request);
  const validateHistory = ajv.compile(document.properties.sponsor_reports_response);
  for (const [directory, valid] of [
    ["valid", true],
    ["invalid", false],
  ] as const) {
    const value = await Bun.file(
      new URL(`../fixtures/${directory}/report-commentary.json`, import.meta.url),
    ).json();
    expect(ReportRequestSchema.safeParse(value).success).toBe(valid);
    expect(validateRequest(value)).toBe(valid);
  }
  for (const target of ["COMM-0123456789abcdef", `COMM-${"a".repeat(64)}`]) {
    expect(CommentaryIdSchema.safeParse(target).success).toBe(true);
    const body = { problem_id: "P-REPORTS", target, reason: "privacy" };
    expect(ReportRequestSchema.safeParse(body).success).toBe(true);
    expect(validateRequest(body)).toBe(true);
    const history = {
      ...page(),
      reports: [{ ...report(3), target }],
      has_more: false,
      next_cursor: null,
    };
    expect(SponsorReportsResponseSchema.safeParse(history).success).toBe(true);
    expect(validateHistory(history)).toBe(true);
    expect(parseModerationControlTarget("commentary", `P-REPORTS/${target}`)).toEqual({
      problemId: "P-REPORTS",
      targetKind: "commentary",
      targetRef: target,
    });
    expect(parseModerationControlTarget("claim", `P-REPORTS/${target}`)).toBeUndefined();
  }
  for (const target of [
    "COMM-0123456789abcde",
    `COMM-${"a".repeat(65)}`,
    "COMM-0123456789ABCDEF",
    "COMM-0123456789abcdef@1",
    "COMM-0123456789abcdef/other",
  ]) {
    const body = { problem_id: "P-REPORTS", target, reason: "privacy" };
    expect(ReportRequestSchema.safeParse(body).success).toBe(false);
    expect(validateRequest(body)).toBe(false);
    expect(parseModerationControlTarget("commentary", `P-REPORTS/${target}`)).toBeUndefined();
  }
});

test("report history requires bounded canonical signed inputs", () => {
  expect(SponsorReportsRequestSchema.parse({})).toEqual({ limit: 20 });
  for (const input of [
    { limit: 0 },
    { limit: 51 },
    { sponsor_id: "usr_other" },
    { before: { created_at: "2026-11-22T12:00:00+00:00", report_id: report(2).report_id } },
    { before: { created_at: stamp, report_id: "not-a-report" } },
  ])
    expect(SponsorReportsRequestSchema.safeParse(input).success).toBe(false);
});

test("history binds identity, descending tuple, page size and last-row cursor", () => {
  const request = SponsorReportsRequestSchema.parse({ limit: 2 });
  expect(sponsorReportsMatchRequest("usr_owner", request, page())).toBe(true);
  expect(sponsorReportsMatchRequest("usr_other", request, page())).toBe(false);
  expect(sponsorReportsMatchRequest("usr_owner", { limit: 1 }, page())).toBe(false);
  expect(sponsorReportsMatchRequest("usr_owner", { limit: 3 }, page())).toBe(false);
  expect(
    sponsorReportsMatchRequest("usr_owner", request, {
      ...page(),
      reports: [report(2), report(3)],
    }),
  ).toBe(false);
  expect(
    sponsorReportsMatchRequest("usr_owner", request, {
      ...page(),
      reports: [report(3), report(3)],
    }),
  ).toBe(false);
  expect(
    sponsorReportsMatchRequest("usr_owner", request, {
      ...page(),
      next_cursor: { created_at: stamp, report_id: report(3).report_id },
    }),
  ).toBe(false);
  expect(sponsorReportsMatchRequest("usr_owner", request, { ...page(), next_cursor: null })).toBe(
    false,
  );
  expect(
    sponsorReportsMatchRequest(
      "usr_owner",
      { limit: 2, before: { created_at: stamp, report_id: report(3).report_id } },
      page(),
    ),
  ).toBe(false);
});

test("resolution state is complete and private prose is outside the contract", () => {
  const complete = {
    ...page(),
    reports: [{ ...report(3), status: "dismissed", resolved_at: stamp }],
    has_more: false,
    next_cursor: null,
  };
  const parsed = SponsorReportsResponseSchema.parse(complete);
  expect(sponsorReportsMatchRequest("usr_owner", { limit: 20 }, parsed)).toBe(true);
  expect(
    sponsorReportsMatchRequest(
      "usr_owner",
      { limit: 20 },
      {
        ...parsed,
        reports: [{ ...report(3), status: "dismissed", resolved_at: null }],
      },
    ),
  ).toBe(false);
  for (const extra of ["note", "resolution_reason", "resolved_by", "reporter_fellow_id"])
    expect(
      SponsorReportsResponseSchema.safeParse({
        ...complete,
        reports: [{ ...complete.reports[0], [extra]: "PRIVATE" }],
      }).success,
    ).toBe(false);
  expect(
    sponsorReportsMatchRequest(
      "usr_owner",
      { limit: 20 },
      {
        schema: REPORTS_SCHEMA_ID,
        sponsor_id: "usr_owner",
        reports: [],
        has_more: false,
        next_cursor: null,
      },
    ),
  ).toBe(true);
});
