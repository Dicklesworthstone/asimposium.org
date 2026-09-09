import { describe, expect, test } from "bun:test";
import {
  DEAD_ENDS_SCHEMA_ID,
  DeadEndItemSchema,
  DeadEndRetryWhenSchema,
  DeadEndsListResponseSchema,
  RecordDeadEndRequestSchema,
  RecordDeadEndResponseSchema,
} from "../../src/dead-ends.ts";

const VALID_REQUEST = new URL("../fixtures/valid/record-dead-end-request.json", import.meta.url);
const INVALID_REQUEST = new URL(
  "../fixtures/invalid/record-dead-end-request.json",
  import.meta.url,
);

async function fixture(url: URL): Promise<unknown> {
  return JSON.parse(await Bun.file(url).text()) as unknown;
}

describe("W5.8a dead-ends contracts", () => {
  test("DEAD_ENDS_SCHEMA_ID is canonical", () => {
    expect(DEAD_ENDS_SCHEMA_ID).toBe("https://a.asimposium.org/schemas/dead-ends.v1.json");
  });

  test("RecordDeadEndRequestSchema accepts valid golden fixture", async () => {
    const data = await fixture(VALID_REQUEST);
    const parsed = RecordDeadEndRequestSchema.safeParse(data);
    expect(parsed.success).toBe(true);
  });

  test("RecordDeadEndRequestSchema rejects invalid fixture", async () => {
    const data = await fixture(INVALID_REQUEST);
    const parsed = RecordDeadEndRequestSchema.safeParse(data);
    expect(parsed.success).toBe(false);
  });

  test("DeadEndRetryWhenSchema accepts valid discriminants", () => {
    const claimReaches = DeadEndRetryWhenSchema.safeParse({
      kind: "claim-reaches",
      claim_id: "C-1",
      reaches: "corroborated",
    });
    expect(claimReaches.success).toBe(true);

    const statementRevised = DeadEndRetryWhenSchema.safeParse({
      kind: "statement-revised",
    });
    expect(statementRevised.success).toBe(true);

    const gapClosed = DeadEndRetryWhenSchema.safeParse({
      kind: "gap-closed",
      gap_id: "G-1",
    });
    expect(gapClosed.success).toBe(true);

    const unknownKind = DeadEndRetryWhenSchema.safeParse({
      kind: "unknown-kind",
    });
    expect(unknownKind.success).toBe(false);
  });

  test("RecordDeadEndResponseSchema validates response shape", () => {
    const response = {
      recorded: true,
      dead_end_id: "DE-1",
      problem_id: "P-4DSP",
      seq: 42,
    };
    const parsed = RecordDeadEndResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
  });

  test("DeadEndsListResponseSchema validates list face shape", () => {
    const list = {
      schema: DEAD_ENDS_SCHEMA_ID,
      problem_id: "P-4DSP",
      dead_ends: [
        {
          dead_end_id: "DE-1",
          problem_id: "P-4DSP",
          seq: 10,
          approach: "Exhaustive branching over modular classes.",
          why_it_fails: "Exponential explosion along odd paths.",
          retry_predicate: "Worth retrying if branch bounds tighten.",
          author_fellow_id: "fel_1",
          created_at: "2026-09-09T10:00:00.000Z",
        },
      ],
      omitted: ["superseded dead ends are excluded"],
    };
    const parsed = DeadEndsListResponseSchema.safeParse(list);
    expect(parsed.success).toBe(true);
  });

  test("DeadEndItemSchema validates canonical dead end item", () => {
    const item = {
      dead_end_id: "DE-1",
      problem_id: "P-4DSP",
      seq: 10,
      approach: "Exhaustive branching over modular classes.",
      why_it_fails: "Exponential explosion along odd paths.",
      retry_predicate: "Worth retrying if branch bounds tighten.",
      author_fellow_id: "fel_1",
      created_at: "2026-09-09T10:00:00.000Z",
    };
    expect(DeadEndItemSchema.safeParse(item).success).toBe(true);
  });
});
