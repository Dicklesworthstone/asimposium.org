import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  SessionSynthesisDraftIndexSchema,
  SessionSynthesisDraftQuerySchema,
  SessionSynthesisDraftResponseSchema,
  sessionSynthesisDraftsPath,
} from "../../src/syntheses.ts";

const fixture = (name: string, valid = true) =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/${valid ? "valid" : "invalid"}/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

test("private synthesis recovery goldens agree with published query, index and exact schemas", () => {
  const document = JSON.parse(
    readFileSync(new URL("../../generated/syntheses.schema.json", import.meta.url), "utf8"),
  );
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const [name, definition, schema] of [
    ["session-synthesis-draft-query", "session_draft_query", SessionSynthesisDraftQuerySchema],
    ["session-synthesis-draft-index", "session_draft_index", SessionSynthesisDraftIndexSchema],
    ["session-synthesis-draft", "session_draft", SessionSynthesisDraftResponseSchema],
  ] as const) {
    const validate = ajv.compile(document.$defs[definition]);
    for (const valid of [true, false]) {
      const value = fixture(name, valid);
      expect(schema.safeParse(value).success).toBe(valid);
      expect(validate(value), JSON.stringify(validate.errors)).toBe(valid);
    }
  }
  const query = ajv.compile(document.$defs.session_draft_query);
  for (const [limit, valid] of [
    ["1", true],
    ["20", true],
    ["100", true],
    ["0", false],
    ["101", false],
    ["9007199254740992", false],
    ["02", false],
    ["1e2", false],
    ["1\n", false],
    [100, false],
  ] as const) {
    expect(SessionSynthesisDraftQuerySchema.safeParse({ limit }).success).toBe(valid);
    expect(query({ limit }), JSON.stringify(query.errors)).toBe(valid);
  }
});

test("draft recovery rejects foreign ownership, forged publication hints and nonadvancing pages", () => {
  const exact = fixture("session-synthesis-draft");
  for (const changed of [
    { ...exact, fellow_id: "foreign-fellow" },
    { ...exact, problem_id: "P-OTHER" },
    { ...exact, read_url: "/v1/sessions/foreign/syntheses/SYNTH-1" },
    { ...exact, publication: { ...exact.publication, event_id: "EV-WRONG" } },
    { ...exact, publication: { ...exact.publication, read_url: "https://foreign.invalid/" } },
  ])
    expect(SessionSynthesisDraftResponseSchema.safeParse(changed).success).toBe(false);
  const page = fixture("session-synthesis-draft-index");
  for (const changed of [
    { ...page, after: "SYNTH-1" },
    { ...page, next_after: "SYNTH-2" },
    { ...page, state: "published" },
    { ...page, items: [page.items[0], page.items[0]] },
    { ...page, items: [{ ...page.items[0], state: "published" }] },
  ])
    expect(SessionSynthesisDraftIndexSchema.safeParse(changed).success).toBe(false);
  for (const query of [
    { limit: "0" },
    { limit: "101" },
    { limit: "2\n" },
    { after: "SYNTH-1\n" },
    { problem_id: "P-OTHER" },
  ])
    expect(SessionSynthesisDraftQuerySchema.safeParse(query).success).toBe(false);
  expect(
    sessionSynthesisDraftsPath(page.session_id, { after: "SYNTH-1", limit: 2, state: "draft" }),
  ).toBe(`/v1/sessions/${page.session_id}/syntheses?after=SYNTH-1&limit=2&state=draft`);
});
