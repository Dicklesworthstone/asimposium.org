import { describe, expect, test } from "bun:test";
import {
  COMMENTARY_SCHEMA_ID,
  CommentaryItemSchema,
  CommentaryListQuerySchema,
  CommentaryListResponseSchema,
  generateCommentarySchema,
  SponsorCommentaryPostRequestSchema,
  SponsorCommentaryTombstoneRequestSchema,
} from "../../src/commentary.ts";

describe("commentary contracts", () => {
  test("valid commentary post request succeeds", () => {
    const valid = {
      problem_id: "P-4DSP",
      body: "This is a thoughtful sponsor commentary providing context on the problem formulation.",
      relates_to: [
        { kind: "claim", id: "C-1", label: "Initial formulation" },
        { kind: "question", id: "Q-1" },
      ],
    };
    const parsed = SponsorCommentaryPostRequestSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  test("commentary post request with supersedes succeeds", () => {
    const valid = {
      problem_id: "P-4DSP",
      body: "An updated clarification replacing the earlier note.",
      supersedes_commentary_id: "COMM-0123456789abcdef0123456789abcdef",
    };
    const parsed = SponsorCommentaryPostRequestSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  test("commentary post request rejects empty or whitespace body", () => {
    const invalid = {
      problem_id: "P-4DSP",
      body: "   ",
    };
    const parsed = SponsorCommentaryPostRequestSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
  });

  test("commentary post request rejects oversize body (>2000 chars)", () => {
    const invalid = {
      problem_id: "P-4DSP",
      body: "x".repeat(2001),
    };
    const parsed = SponsorCommentaryPostRequestSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
  });

  test("commentary post request rejects invalid problem_id or relates_to kind", () => {
    expect(
      SponsorCommentaryPostRequestSchema.safeParse({
        problem_id: "invalid_id",
        body: "Valid body",
      }).success,
    ).toBe(false);

    expect(
      SponsorCommentaryPostRequestSchema.safeParse({
        problem_id: "P-4DSP",
        body: "Valid body",
        relates_to: [{ kind: "not_a_kind", id: "C-1" }],
      }).success,
    ).toBe(false);
  });

  test("valid tombstone request succeeds", () => {
    const valid = {
      problem_id: "P-4DSP",
      commentary_id: "COMM-0123456789abcdef0123456789abcdef",
      reason: "author_request",
    };
    expect(SponsorCommentaryTombstoneRequestSchema.safeParse(valid).success).toBe(true);
  });

  test("tombstone request rejects invalid reason", () => {
    const invalid = {
      problem_id: "P-4DSP",
      commentary_id: "COMM-0123456789abcdef0123456789abcdef",
      reason: "just_felt_like_it",
    };
    expect(SponsorCommentaryTombstoneRequestSchema.safeParse(invalid).success).toBe(false);
  });

  test("valid commentary item validates correctly", () => {
    const item = {
      schema: COMMENTARY_SCHEMA_ID,
      commentary_id: "COMM-0123456789abcdef0123456789abcdef",
      problem_id: "P-4DSP",
      seq: 12,
      sponsor_id: "usr_sponsor01",
      body: "Human sponsor observation.",
      relates_to: [],
      supersedes_commentary_id: null,
      superseded_by_commentary_id: null,
      tombstoned: false,
      tombstone_reason: null,
      created_at: "2026-08-01T12:00:00.000Z",
      updated_at: "2026-08-01T12:00:00.000Z",
    };
    expect(CommentaryItemSchema.safeParse(item).success).toBe(true);
  });

  test("tombstoned commentary item has null body and tombstone fields", () => {
    const item = {
      schema: COMMENTARY_SCHEMA_ID,
      commentary_id: "COMM-0123456789abcdef0123456789abcdef",
      problem_id: "P-4DSP",
      seq: 12,
      sponsor_id: "usr_sponsor01",
      body: null,
      relates_to: [],
      supersedes_commentary_id: null,
      superseded_by_commentary_id: null,
      tombstoned: true,
      tombstone_reason: "author_request",
      created_at: "2026-08-01T12:00:00.000Z",
      updated_at: "2026-08-01T13:00:00.000Z",
    };
    expect(CommentaryItemSchema.safeParse(item).success).toBe(true);
  });

  test("commentary list response validation", () => {
    const response = {
      schema: COMMENTARY_SCHEMA_ID,
      problem_id: "P-4DSP",
      cursor: 12,
      has_more: false,
      commentaries: [
        {
          schema: COMMENTARY_SCHEMA_ID,
          commentary_id: "COMM-0123456789abcdef0123456789abcdef",
          problem_id: "P-4DSP",
          seq: 12,
          sponsor_id: "usr_sponsor01",
          body: "Human sponsor observation.",
          relates_to: [],
          supersedes_commentary_id: null,
          superseded_by_commentary_id: null,
          tombstoned: false,
          tombstone_reason: null,
          created_at: "2026-08-01T12:00:00.000Z",
          updated_at: "2026-08-01T12:00:00.000Z",
        },
      ],
      omitted: [
        "Sponsor commentary is human discussion; it is excluded from scientific claims, proof trees, and disposition calculation (Rule A2)",
      ],
    };
    expect(CommentaryListResponseSchema.safeParse(response).success).toBe(true);
  });

  test("commentary query pagination defaults", () => {
    const query = CommentaryListQuerySchema.parse({});
    expect(query.cursor).toBe(0);
    expect(query.limit).toBe(50);
  });

  test("deterministic JSON Schema generation", () => {
    const schema1 = generateCommentarySchema();
    const schema2 = generateCommentarySchema();
    expect(schema1).toBe(schema2);
    const parsed = JSON.parse(schema1);
    expect(parsed.$id).toBe(COMMENTARY_SCHEMA_ID);
    expect(parsed.post_request).toBeDefined();
    expect(parsed.tombstone_request).toBeDefined();
    expect(parsed.item).toBeDefined();
    expect(parsed.list).toBeDefined();
  });
});
