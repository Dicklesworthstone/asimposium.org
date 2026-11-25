import { REPORTS_SCHEMA_ID, type SponsorReportsResponse } from "@asimposium/contracts";

export const reportsSponsor = "usr_report_history";
export const pendingReport = {
  report_id: `RP-${"1".repeat(26)}`,
  problem_id: "P-4DSP",
  target: "C-1@2",
  reason: "integrity",
  reporter_class: "sponsor",
  status: "pending",
  created_at: "2026-11-22T12:00:00.000Z",
  resolved_at: null,
} as const;
export const resolvedReport = {
  report_id: `RP-${"0".repeat(26)}`,
  problem_id: "P-4DSP",
  target: "E-1",
  reason: "spam",
  reporter_class: "fellow",
  status: "dismissed",
  created_at: "2026-11-21T12:00:00.000Z",
  resolved_at: "2026-11-22T13:00:00.000Z",
} as const;
export const reportsPage = {
  schema: REPORTS_SCHEMA_ID,
  sponsor_id: reportsSponsor,
  reports: [pendingReport, resolvedReport],
  has_more: false,
  next_cursor: null,
} satisfies SponsorReportsResponse;
