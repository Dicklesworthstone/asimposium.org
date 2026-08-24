import { expect, test } from "bun:test";

import {
  LedgerContractsSchema,
  ProblemIndexEntrySchema,
  ProblemsIndexResponseSchema,
} from "../../src/ledger.ts";

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

test("the index rejects a hostile markdown-structural id (gfbc golden)", async () => {
  const HOSTILE_INDEX = new URL(
    "../fixtures/invalid/ledger-problems-index-hostile-id.json",
    import.meta.url,
  );
  expect(ProblemsIndexResponseSchema.safeParse(await fixture(HOSTILE_INDEX)).success).toBe(false);
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

test("every contract-valid entry has an unambiguous bounded markdown row", () => {
  // The markdown face renders `- \`${id}\` — seq N, opened TS, updated TS`.
  // Hostile scalars — newlines that would forge extra listing rows, backticks
  // that would escape the id code span, control text, non-canonical
  // timestamps — are contract-invalid, so the mounted reader refuses the row
  // instead of interpolating it (asimposiumorg-gfbc).
  const canonical = {
    id: "P-4DSP",
    public_seq: 1,
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z",
  };
  expect(ProblemIndexEntrySchema.safeParse(canonical).success).toBe(true);
  const hostileIds = [
    "P-X\n- `P-FORGED` — forged row",
    "P-X\rsecond row",
    "P-X` — seq 9",
    "`P-BACKTICK`",
    "P-SPACE SPACE",
    "P-Control\u0000NUL",
    "P-ESC\u001B[31mred",
    "",
    ".leading-dot",
    "-leading-dash",
    "a".repeat(129),
  ];
  for (const id of hostileIds) {
    expect(ProblemIndexEntrySchema.safeParse({ ...canonical, id }).success).toBe(false);
  }
  const hostileTimestamps = [
    "2026-08-14T00:00:00Z",
    "2026-08-14T00:00:00.000+00:00",
    "not-a-timestamp",
    "2026-08-14T00:00:00.000Z\nforged",
    "x",
    "",
  ];
  for (const field of ["created_at", "updated_at"] as const) {
    for (const value of hostileTimestamps) {
      expect(ProblemIndexEntrySchema.safeParse({ ...canonical, [field]: value }).success).toBe(
        false,
      );
    }
  }
});

test("the ledger root schema carries the index pair", () => {
  expect(
    LedgerContractsSchema.safeParse({
      problem_index_entry: {},
      problems_index_response: {},
    }).success,
  ).toBe(false);
});
