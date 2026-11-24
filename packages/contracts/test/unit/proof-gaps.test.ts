import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { ProofGapRecordSchema } from "../../src/proof-gaps.ts";
import { GapFileRequestSchema, GapTransitionRequestSchema } from "../../src/sessions.ts";

async function fixture(path: string) {
  return JSON.parse(await readFile(new URL(`../fixtures/${path}`, import.meta.url), "utf8"));
}

test("gap settlement warnings are additive response metadata separate from the filing", async () => {
  const value = await fixture("valid/proof-gap-settlement-warning.json");
  expect(ProofGapRecordSchema.parse(value)).toEqual(value);
  expect(value.screening_notice.notice).toBe("off-scope");
  expect(value.last_event_screening_notice.notice).toBe("screening-warning");
  const { last_event_screening_notice: _notice, ...legacy } = value;
  expect(ProofGapRecordSchema.parse(legacy)).toEqual(legacy);
  expect(
    ProofGapRecordSchema.safeParse({
      ...value,
      last_event_screening_notice: {
        ...value.last_event_screening_notice,
        private_detail: "PRIVATE_CANARY",
      },
    }).success,
  ).toBe(false);
  expect(
    ProofGapRecordSchema.safeParse({
      ...value,
      last_event_screening_notice: {
        ...value.last_event_screening_notice,
        notice: "detector-rule",
      },
    }).success,
  ).toBe(false);
});

test("Fellows cannot submit a platform settlement warning on a filing or transition", async () => {
  const forged = await fixture("invalid/proof-gap-settlement-warning-request.json");
  expect(GapTransitionRequestSchema.safeParse(forged).success).toBe(false);
  const { last_event_screening_notice, ...request } = forged;
  expect(GapTransitionRequestSchema.parse(request)).toEqual(request);
  const record = await fixture("valid/proof-gap-settlement-warning.json");
  expect(
    GapFileRequestSchema.safeParse({ ...record.content, last_event_screening_notice }).success,
  ).toBe(false);
});
