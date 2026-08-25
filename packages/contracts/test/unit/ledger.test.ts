import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

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
const VALID_PROBLEM_FACE = new URL("../fixtures/valid/ledger-problem-face.json", import.meta.url);
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

  const nonClaimId = structuredClone(valid);
  if (nonClaimId.items[0] !== undefined) nonClaimId.items[0].id = "H-7@2";
  expect(ProblemFaceResponseSchema.safeParse(nonClaimId).success).toBe(false);

  const longestClaimId = structuredClone(valid);
  if (longestClaimId.items[0] !== undefined) {
    longestClaimId.items[0].id = `C-${"1".repeat(126)}`;
  }
  expect(ProblemFaceResponseSchema.safeParse(longestClaimId).success).toBe(true);

  const oversizedClaimId = structuredClone(valid);
  if (oversizedClaimId.items[0] !== undefined) {
    oversizedClaimId.items[0].id = `C-${"1".repeat(127)}`;
  }
  expect(ProblemFaceResponseSchema.safeParse(oversizedClaimId).success).toBe(false);

  const duplicate = structuredClone(valid);
  const first = duplicate.items[0];
  if (first !== undefined) duplicate.items.push(structuredClone(first));
  expect(ProblemFaceResponseSchema.safeParse(duplicate).success).toBe(false);
});

test("the published ledger schema preserves the public face safety boundary", async () => {
  const generated = JSON.parse(
    readFileSync(new URL("../../generated/ledger.schema.json", import.meta.url), "utf8"),
  ) as {
    properties: {
      problem_face_response: {
        properties: {
          problem: { maxLength?: number; pattern?: string };
          items: {
            maxItems?: number;
            items: {
              properties: {
                kind: { const?: string };
                id: { maxLength?: number; pattern?: string };
                scope: { const?: string };
                untrusted: { const?: boolean };
                tokens?: unknown;
              };
            };
          };
          next_actions: {
            items: {
              properties: {
                method: { const?: string };
                url: { maxLength?: number; pattern?: string };
              };
            };
          };
        };
      };
      problem_index_entry: {
        properties: {
          created_at: { pattern?: string };
        };
      };
    };
  };
  const face = generated.properties.problem_face_response.properties;
  const action = face.next_actions.items.properties;
  expect(action.method.const).toBe("GET");
  expect(action.url.maxLength).toBe(400);
  expect(typeof action.url.pattern).toBe("string");
  const publishedPath = new RegExp(action.url.pattern as string);
  expect(publishedPath.test("/problems.json?after=P-A%20B")).toBe(true);
  for (const unsafe of [
    "https://attacker.example/collect",
    "//attacker.example/collect",
    "/../internal/health",
    "/%2e%2e/internal/health",
    "/p/P-4DSP.md#forged",
    "/p/P-4DSP.md `forged`",
  ]) {
    expect(publishedPath.test(unsafe), unsafe).toBe(false);
  }

  expect(face.problem.maxLength).toBe(128);
  expect(typeof face.problem.pattern).toBe("string");
  const publishedProblemId = new RegExp(face.problem.pattern as string);
  expect(publishedProblemId.test("P-alpha")).toBe(true);
  expect(publishedProblemId.test("P-X--FORGED")).toBe(false);

  const itemId = face.items.items.properties.id;
  expect(face.items.maxItems).toBe(200);
  expect(face.items.items.properties.kind.const).toBe("claim");
  expect(face.items.items.properties.scope.const).toBe("ledger");
  expect(face.items.items.properties.untrusted.const).toBe(true);
  expect("tokens" in face.items.items.properties).toBe(false);
  expect(itemId.maxLength).toBe(128);
  expect(typeof itemId.pattern).toBe("string");
  const publishedItemId = new RegExp(itemId.pattern as string);
  expect(publishedItemId.test("C-7")).toBe(true);
  expect(publishedItemId.test("H-7@2")).toBe(false);

  const createdAt = generated.properties.problem_index_entry.properties.created_at;
  expect(typeof createdAt.pattern).toBe("string");
  const publishedTimestamp = new RegExp(createdAt.pattern as string);
  expect(publishedTimestamp.test("2026-08-14T23:59:59.999Z")).toBe(true);
  expect(publishedTimestamp.test("2026-99-14T00:00:00.000Z")).toBe(false);
  expect(publishedTimestamp.test("2026-08-14T24:00:00.000Z")).toBe(false);

  // Differentially pin every safety rule representable in Draft 2020-12.
  // The Zod-only real-instant round trip and uniqueness-by-item-id refinements
  // remain covered by the runtime cases above; standard JSON Schema cannot
  // compare two array members' id properties.
  const index = (await fixture(VALID_INDEX)) as { problems: unknown[] };
  const problemFace = await fixture(VALID_PROBLEM_FACE);
  const valid = {
    problem_index_entry: index.problems[0],
    problems_index_response: index,
    problem_face_response: problemFace,
  };
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validatePublished = ajv.compile(generated as object);
  expect(LedgerContractsSchema.safeParse(valid).success).toBe(true);
  expect(validatePublished(valid), JSON.stringify(validatePublished.errors)).toBe(true);

  const expectBothReject = (candidate: unknown, label: string): void => {
    expect(LedgerContractsSchema.safeParse(candidate).success, `Zod: ${label}`).toBe(false);
    expect(validatePublished(candidate), `JSON Schema: ${label}`).toBe(false);
  };
  const withFace = (faceValue: unknown): Record<string, unknown> => ({
    ...valid,
    problem_face_response: faceValue,
  });

  expectBothReject(withFace(await fixture(INVALID_WORKSHOP_FACE)), "workshop item");
  for (const [label, mutate] of [
    [
      "trusted item",
      (face: { items: Array<Record<string, unknown>> }) => {
        if (face.items[0] !== undefined) face.items[0].untrusted = false;
      },
    ],
    [
      "composer token field",
      (face: { items: Array<Record<string, unknown>> }) => {
        if (face.items[0] !== undefined) face.items[0].tokens = 1;
      },
    ],
    [
      "non-claim item id",
      (face: { items: Array<Record<string, unknown>> }) => {
        if (face.items[0] !== undefined) face.items[0].id = "H-7@2";
      },
    ],
    [
      "POST action",
      (face: { next_actions: Array<Record<string, unknown>> }) => {
        if (face.next_actions[0] !== undefined) face.next_actions[0].method = "POST";
      },
    ],
    [
      "external action",
      (face: { next_actions: Array<Record<string, unknown>> }) => {
        if (face.next_actions[0] !== undefined) {
          face.next_actions[0].url = "https://attacker.example/collect";
        }
      },
    ],
  ] as const) {
    const face = structuredClone(problemFace) as {
      items: Array<Record<string, unknown>>;
      next_actions: Array<Record<string, unknown>>;
    };
    mutate(face);
    expectBothReject(withFace(face), label);
  }

  const unsafeProblem = structuredClone(valid) as {
    problem_index_entry: Record<string, unknown>;
  };
  unsafeProblem.problem_index_entry.id = "P-X--FORGED";
  expectBothReject(unsafeProblem, "renderer-unsafe problem id");

  const invalidTimestamp = structuredClone(valid) as {
    problem_index_entry: Record<string, unknown>;
  };
  invalidTimestamp.problem_index_entry.created_at = "2026-99-14T00:00:00.000Z";
  expectBothReject(invalidTimestamp, "out-of-range timestamp");
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
  expect(
    ProblemIndexEntrySchema.safeParse({
      ...canonical,
      created_at: "2024-02-29T23:59:59.999Z",
      updated_at: "2024-02-29T23:59:59.999Z",
    }).success,
  ).toBe(true);
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
    "2026-99-14T00:00:00.000Z",
    "2026-08-14T24:00:00.000Z",
    "2026-02-30T00:00:00.000Z",
    "2025-02-29T00:00:00.000Z",
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
