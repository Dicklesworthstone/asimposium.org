import { describe, expect, test } from "bun:test";

import {
  BATCH_PLAN_REFUSAL_CODES,
  BATCH_TEMP_ID_PATTERN,
  BatchCommitPlanRequestSchema,
  BatchEventCauseSchema,
  BatchMemberSchema,
  BatchPlanFailureSchema,
  BatchPlanSchema,
  BatchPlanSuccessSchema,
  BatchTempIdSchema,
  MAX_BATCH_MEMBERS,
  MAX_CAUSED_BY_PER_MEMBER,
} from "../../src/batch.ts";

describe("batch contracts (W1.2)", () => {
  test("a persisted cause names an exact public problem event", async () => {
    const valid = await Bun.file(
      new URL("../fixtures/valid/batch-event-cause.json", import.meta.url),
    ).json();
    expect(BatchEventCauseSchema.parse(valid)).toEqual({
      scope: "problem",
      scope_id: "P-4DSP",
      event_id: "E-CPARENT",
      seq: 12,
    });
    const invalid = await Bun.file(
      new URL("../fixtures/invalid/batch-event-cause-unbound.json", import.meta.url),
    ).json();
    expect(BatchEventCauseSchema.safeParse(invalid).success).toBe(false);
    for (const mutation of [
      { scope: "global" },
      { scope: "session" },
      { scope_id: "" },
      { event_id: "tmp:parent", seq: 0 },
      { seq: -1 },
      { seq: 1.5 },
      { seq: Number.MAX_SAFE_INTEGER + 1 },
      { private_body: "not public" },
    ])
      expect(BatchEventCauseSchema.safeParse({ ...valid, ...mutation }).success).toBe(false);
  });

  test("literal constants are pinned", () => {
    expect(MAX_BATCH_MEMBERS).toBe(16);
    expect(MAX_CAUSED_BY_PER_MEMBER).toBe(15);
    expect(BATCH_PLAN_REFUSAL_CODES).toEqual([
      "BATCH_EMPTY",
      "BATCH_TOO_LARGE",
      "BATCH_INVALID_TEMP_ID",
      "BATCH_DUPLICATE_TEMP_ID",
      "BATCH_SELF_CAUSAL_REF",
      "BATCH_DUPLICATE_CAUSAL_REF",
      "BATCH_DANGLING_CAUSAL_REF",
      "BATCH_CAUSAL_CYCLE",
    ]);
  });

  describe("BatchTempIdSchema", () => {
    test("accepts valid temporary ids", () => {
      const valid = [
        "tmp:a",
        "tmp:1",
        "tmp:claim-1",
        "tmp:evidence_2.v1",
        "tmp:problem:claim:review",
        `tmp:${"a".repeat(124)}`, // 128 total chars
      ];
      for (const id of valid) {
        expect(BatchTempIdSchema.parse(id)).toBe(id);
        expect(BATCH_TEMP_ID_PATTERN.test(id)).toBe(true);
      }
    });

    test("refuses invalid temporary ids", () => {
      const invalid = [
        "",
        "tmp:",
        "tmp",
        "a",
        "claim-1",
        "TMP:a",
        "tmp: leading-space",
        "tmp:trailing-space ",
        "tmp:with\nnewline",
        "tmp:with\0null",
        "tmp:with`backtick",
        'tmp:with"quote',
        "tmp:with<tag>",
        "tmp:with{bracket}",
        "tmp:-leading-dash",
        "tmp:.leading-dot",
        `tmp:${"a".repeat(125)}`, // 129 total chars (>128)
      ];
      for (const id of invalid) {
        expect(() => BatchTempIdSchema.parse(id)).toThrow();
        expect(BATCH_TEMP_ID_PATTERN.test(id)).toBe(false);
      }
    });
  });

  describe("BatchMemberSchema", () => {
    test("accepts valid member without causedBy", () => {
      const parsed = BatchMemberSchema.parse({ tempId: "tmp:m1" });
      expect(parsed.tempId).toBe("tmp:m1");
      expect(parsed.causedBy).toEqual([]);
    });

    test("accepts valid member with causedBy", () => {
      const parsed = BatchMemberSchema.parse({
        tempId: "tmp:m2",
        causedBy: ["tmp:m1"],
      });
      expect(parsed.tempId).toBe("tmp:m2");
      expect(parsed.causedBy).toEqual(["tmp:m1"]);
    });

    test("accepts up to 15 distinct causedBy parents", () => {
      const parents = Array.from({ length: 15 }, (_, i) => `tmp:p${i}`);
      const parsed = BatchMemberSchema.parse({
        tempId: "tmp:child",
        causedBy: parents,
      });
      expect(parsed.causedBy.length).toBe(15);
    });

    test("refuses >15 causedBy parents", () => {
      const parents = Array.from({ length: 16 }, (_, i) => `tmp:p${i}`);
      expect(() =>
        BatchMemberSchema.parse({
          tempId: "tmp:child",
          causedBy: parents,
        }),
      ).toThrow();
    });

    test("refuses extra properties", () => {
      expect(() =>
        BatchMemberSchema.parse({
          tempId: "tmp:m1",
          causedBy: [],
          extra: "forbidden",
        }),
      ).toThrow();
    });
  });

  describe("BatchCommitPlanRequestSchema", () => {
    test("accepts valid single-member batch", () => {
      const parsed = BatchCommitPlanRequestSchema.parse({
        members: [{ tempId: "tmp:solo", causedBy: [] }],
      });
      expect(parsed.members.length).toBe(1);
    });

    test("accepts exact 16-member batch boundary", () => {
      const members = Array.from({ length: 16 }, (_, i) => ({
        tempId: `tmp:m${i}`,
        causedBy: i > 0 ? [`tmp:m${i - 1}`] : [],
      }));
      const parsed = BatchCommitPlanRequestSchema.parse({ members });
      expect(parsed.members.length).toBe(16);
    });

    test("refuses empty members array", () => {
      expect(() => BatchCommitPlanRequestSchema.parse({ members: [] })).toThrow();
    });

    test("refuses 17-member batch exceeding bound", () => {
      const members = Array.from({ length: 17 }, (_, i) => ({
        tempId: `tmp:m${i}`,
        causedBy: [],
      }));
      expect(() => BatchCommitPlanRequestSchema.parse({ members })).toThrow();
    });
  });

  describe("BatchPlanSchema", () => {
    test("validates success result", () => {
      const parsed = BatchPlanSchema.parse({
        ok: true,
        commitOrder: ["tmp:p1", "tmp:p2"],
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.commitOrder).toEqual(["tmp:p1", "tmp:p2"]);

      const direct = BatchPlanSuccessSchema.parse({
        ok: true,
        commitOrder: ["tmp:p1"],
      });
      expect(direct.commitOrder).toEqual(["tmp:p1"]);
    });

    test("validates failure result for every refusal code", () => {
      for (const code of BATCH_PLAN_REFUSAL_CODES) {
        const parsed = BatchPlanSchema.parse({
          ok: false,
          code,
          detail: `Refusal detail for ${code}`,
        });
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
          expect(parsed.code).toBe(code);
          expect(parsed.detail).toContain(code);
        }

        const direct = BatchPlanFailureSchema.parse({
          ok: false,
          code,
          detail: `Direct detail for ${code}`,
        });
        expect(direct.code).toBe(code);
      }
    });

    test("refuses unrecognized error code", () => {
      expect(() =>
        BatchPlanSchema.parse({
          ok: false,
          code: "UNKNOWN_CODE",
          detail: "Invalid",
        }),
      ).toThrow();
    });
  });
});
