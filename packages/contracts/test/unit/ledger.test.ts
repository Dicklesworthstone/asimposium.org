import { expect, test } from "bun:test";

import {
  LedgerContractsSchema,
  ProblemFaceResponseSchema,
  ProblemIndexEntrySchema,
  ProblemsIndexResponseSchema,
  PublicLedgerProblemIdSchema,
} from "../../src/ledger.ts";

const VALID_INDEX = new URL("../fixtures/valid/ledger-problems-index.json", import.meta.url);
const INVALID_INDEX = new URL(
  "../fixtures/invalid/ledger-problems-index-no-omitted.json",
  import.meta.url,
);
const VALID_PROBLEM_FACE = new URL(
  "../fixtures/valid/ledger-problem-face.json",
  import.meta.url,
);
const INVALID_WORKSHOP_FACE = new URL(
  "../fixtures/invalid/ledger-problem-face-workshop-item.json",
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

test("the problem face accepts the golden fixture and refuses workshop leakage", async () => {
  expect(ProblemFaceResponseSchema.safeParse(await fixture(VALID_PROBLEM_FACE)).success).toBe(true);
  expect(ProblemFaceResponseSchema.safeParse(await fixture(INVALID_WORKSHOP_FACE)).success).toBe(
    false,
  );
});

test("the public face cannot claim trusted items, unsafe actions, or composer-only token fields", async () => {
  const valid = (await fixture(VALID_PROBLEM_FACE)) as {
    items: Array<Record<string, unknown>>;
    next_actions: Array<Record<string, unknown>>;
  };
  const trusted = structuredClone(valid);
  if (trusted.items[0] !== undefined) trusted.items[0].untrusted = false;
  expect(ProblemFaceResponseSchema.safeParse(trusted).success).toBe(false);

  const posting = structuredClone(valid);
  if (posting.next_actions[0] !== undefined) posting.next_actions[0].method = "POST";
  expect(ProblemFaceResponseSchema.safeParse(posting).success).toBe(false);

  const encodedQuery = structuredClone(valid);
  if (encodedQuery.next_actions[0] !== undefined) {
    encodedQuery.next_actions[0].url = "/problems.json?after=P-A%20B";
  }
  expect(ProblemFaceResponseSchema.safeParse(encodedQuery).success).toBe(true);

  for (const url of [
    "https://attacker.example/collect",
    "//attacker.example/collect",
    "/../internal/health",
    "/%2e%2e/internal/health",
    "/p/P-4DSP.md#forged",
    "/p/P-4DSP.md `forged`",
  ]) {
    const unsafeAction = structuredClone(valid);
    if (unsafeAction.next_actions[0] !== undefined) unsafeAction.next_actions[0].url = url;
    expect(ProblemFaceResponseSchema.safeParse(unsafeAction).success, url).toBe(false);
  }

  const tokenBearing = structuredClone(valid);
  if (tokenBearing.items[0] !== undefined) tokenBearing.items[0].tokens = 1;
  expect(ProblemFaceResponseSchema.safeParse(tokenBearing).success).toBe(false);

  const duplicate = structuredClone(valid);
  const first = duplicate.items[0];
  if (first !== undefined) duplicate.items.push(structuredClone(first));
  expect(ProblemFaceResponseSchema.safeParse(duplicate).success).toBe(false);
});

test("the public ledger id grammar is renderer-safe without rewriting Krater's full ingress law", () => {
  for (const valid of ["P-4DSP", "P-alpha", "problem.v2:branch_1"]) {
    expect(PublicLedgerProblemIdSchema.safeParse(valid).success, valid).toBe(true);
  }
  for (const invalid of ["P-X--FORGED", "-leading", ".leading", "x".repeat(129)]) {
    expect(PublicLedgerProblemIdSchema.safeParse(invalid).success, invalid).toBe(false);
  }
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

test("the ledger root schema positively carries both index faces and the problem digest", async () => {
  const index = await fixture(VALID_INDEX);
  const indexEntry = (index as { problems: unknown[] }).problems[0];
  expect(
    LedgerContractsSchema.safeParse({
      problem_index_entry: indexEntry,
      problems_index_response: index,
      problem_face_response: await fixture(VALID_PROBLEM_FACE),
    }).success,
  ).toBe(true);
});
