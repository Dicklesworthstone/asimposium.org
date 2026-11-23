import { expect, test } from "bun:test";
import {
  REPORTS_SCHEMA_ID,
  SponsorReportsRequestSchema,
  SponsorReportsResponseSchema,
  sponsorReportsMatchRequest,
} from "../../src/moderation.ts";

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
