import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  ADMIN_REPORT_DETAIL_SCHEMA_ID,
  AdminReportDetailSchema,
  AdminReportItemSchema,
  generateAdminReportDetailSchema,
} from "../../src/admin.ts";

const fixture = async (directory: string, name: string) =>
  JSON.parse(
    await Bun.file(new URL(`../fixtures/${directory}/${name}.json`, import.meta.url)).text(),
  );

test("private report detail Zod and generated schema agree on exact sources and withheld bytes", async () => {
  const schema = JSON.parse(generateAdminReportDetailSchema());
  expect(schema.$id).toBe(ADMIN_REPORT_DETAIL_SCHEMA_ID);
  const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
  for (const [directory, name, valid] of [
    ["valid", "admin-report-detail", true],
    ["invalid", "admin-report-detail-unavailable-body", false],
  ] as const) {
    const value = await fixture(directory, name);
    expect(AdminReportDetailSchema.safeParse(value).success).toBe(valid);
    expect(validate(value)).toBe(valid);
  }
  const detail = await fixture("valid", "admin-report-detail");
  for (const reason of [
    "not-pinned",
    "not-public",
    "missing",
    "redacted",
    "integrity-failed",
    "too-large",
  ]) {
    const withheld = { ...detail, source: { state: "unavailable", reason } };
    expect(AdminReportDetailSchema.safeParse(withheld).success).toBe(true);
    expect(validate(withheld)).toBe(true);
  }
});

test("report notes stay bounded and private detail never widens the operator queue", async () => {
  const detail = await fixture("valid", "admin-report-detail");
  for (const extra of [
    { reporter_sponsor_id: "usr_private_reporter" },
    { raw_prompt: "detector" },
    { workshop: "private draft" },
  ]) {
    expect(AdminReportDetailSchema.safeParse({ ...detail, ...extra }).success).toBe(false);
  }
  expect(AdminReportDetailSchema.safeParse({ ...detail, note: "x".repeat(501) }).success).toBe(
    false,
  );
  expect(
    AdminReportDetailSchema.safeParse({
      ...detail,
      source: { ...detail.source, payload_sha256: "forged" },
    }).success,
  ).toBe(false);
  expect(
    AdminReportDetailSchema.safeParse({ ...detail, source: { ...detail.source, seq: 0 } }).success,
  ).toBe(false);
  expect(
    AdminReportDetailSchema.safeParse({
      ...detail,
      report: { ...detail.report, report_id: `${detail.report.report_id}\n` },
    }).success,
  ).toBe(false);
  expect(
    AdminReportDetailSchema.safeParse({
      ...detail,
      source: { ...detail.source, payload_sha256: `${detail.source.payload_sha256}\n` },
    }).success,
  ).toBe(false);
  expect(AdminReportItemSchema.safeParse(detail.report).success).toBe(true);
  expect(AdminReportItemSchema.safeParse({ ...detail.report, note: detail.note }).success).toBe(
    false,
  );
  expect(AdminReportItemSchema.safeParse({ ...detail.report, source: detail.source }).success).toBe(
    false,
  );
});
