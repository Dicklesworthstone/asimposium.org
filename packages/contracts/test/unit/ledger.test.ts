import { expect, test } from "bun:test";

import { LedgerContractsSchema, ProblemsIndexResponseSchema } from "../../src/ledger.ts";

const VALID_INDEX = new URL("../fixtures/valid/ledger-problems-index.json", import.meta.url);
const INVALID_INDEX = new URL(
  "../fixtures/invalid/ledger-problems-index-no-omitted.json",
  import.meta.url,
);

async function fixture(url: URL): Promise<unknown> {
  try {
    return JSON.parse(await Bun.file(url).text()) as unknown;
  } catch {
    throw new Error("synthetic ledger fixture is not valid JSON");
  }
}

test("the problems index accepts the valid fixture and requires omitted[]", async () => {
  const parsed = ProblemsIndexResponseSchema.safeParse(await fixture(VALID_INDEX));
  expect(parsed.success).toBe(true);

  // omitted[] is mandatory: an index that does not say what it left out is
  // not a valid face, even when the list itself is well-formed.
  expect(ProblemsIndexResponseSchema.safeParse(await fixture(INVALID_INDEX)).success).toBe(false);
});

test("the index rejects extra fields and malformed entries", () => {
  expect(
    ProblemsIndexResponseSchema.safeParse({ problems: [], omitted: [], extra: true }).success,
  ).toBe(false);
  expect(
    ProblemsIndexResponseSchema.safeParse({
      problems: [{ id: "P-1", public_seq: -1, created_at: "x", updated_at: "y" }],
      omitted: [],
    }).success,
  ).toBe(false);
});

test("the ledger root schema carries the index pair", () => {
  expect(
    LedgerContractsSchema.safeParse({
      problem_index_entry: {},
      problems_index_response: {},
    }).success,
  ).toBe(false);
});
