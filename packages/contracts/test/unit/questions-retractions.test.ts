import { describe, expect, test } from "bun:test";
import {
  AnswerQuestionRequestSchema,
  AnswerQuestionResponseSchema,
  AskQuestionRequestSchema,
  AskQuestionResponseSchema,
  CONTRACT_PROBLEM_CODES,
  LeaseQuestionRequestSchema,
  LeaseQuestionResponseSchema,
  ProblemRuleSchema,
  QUESTION_STATUSES,
  QUESTIONS_SCHEMA_ID,
  QuestionIdSchema,
  QuestionItemSchema,
  QuestionStatusSchema,
  QuestionsListResponseSchema,
  RETRACTION_KINDS,
  RETRACTIONS_SCHEMA_ID,
  RetractionIdSchema,
  RetractionItemSchema,
  RetractionKindSchema,
  RetractionsListResponseSchema,
  RetractRequestSchema,
  RetractResponseSchema,
  WithdrawQuestionRequestSchema,
  WithdrawQuestionResponseSchema,
} from "../../src/index.ts";

describe("W5.8d Questions & Retractions contracts", () => {
  describe("Question contracts", () => {
    test("QuestionIdSchema validates canonical IDs and rejects malformed ones", () => {
      expect(QuestionIdSchema.safeParse("Q-1").success).toBe(true);
      expect(QuestionIdSchema.safeParse("Q-1234567890ABCDEF").success).toBe(true);
      expect(QuestionIdSchema.safeParse("Q-FAST-LEAN-PROOF").success).toBe(true);

      expect(QuestionIdSchema.safeParse("").success).toBe(false);
      expect(QuestionIdSchema.safeParse("q-1").success).toBe(false);
      expect(QuestionIdSchema.safeParse("QUESTION-1").success).toBe(false);
      expect(QuestionIdSchema.safeParse("Q--DOUBLE").success).toBe(false);
    });

    test("QuestionStatusSchema supports all four lifecycle states", () => {
      expect(QUESTION_STATUSES).toEqual(["open", "leased", "resolved", "withdrawn"]);
      for (const status of QUESTION_STATUSES) {
        expect(QuestionStatusSchema.safeParse(status).success).toBe(true);
      }
      expect(QuestionStatusSchema.safeParse("closed").success).toBe(false);
      expect(QuestionStatusSchema.safeParse("pending").success).toBe(false);
    });

    test("AskQuestionRequestSchema validates substantive questions and rejects underspecified ones", () => {
      const valid = {
        problem_id: "P-456",
        target_refs: ["C-12", "G-3"],
        blocking: "C-12",
        body_md:
          "Is there a known bounded gap for the residue class modulo 30 under Selberg sieve?",
      };
      expect(AskQuestionRequestSchema.safeParse(valid).success).toBe(true);

      // Defaults target_refs to empty array
      const minimal = {
        problem_id: "P-456",
        body_md: "Is there a known bounded gap for the residue class modulo 30?",
      };
      const parsed = AskQuestionRequestSchema.safeParse(minimal);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.target_refs).toEqual([]);
      }

      // Rejects body too short (< 10 chars)
      expect(
        AskQuestionRequestSchema.safeParse({
          problem_id: "P-456",
          body_md: "Too short",
        }).success,
      ).toBe(false);

      // Rejects invalid problem ID
      expect(
        AskQuestionRequestSchema.safeParse({
          problem_id: "invalid-id",
          body_md: "Valid question body with enough substance and characters.",
        }).success,
      ).toBe(false);
    });

    test("LeaseQuestionRequestSchema validates objectives and TTL bounds (Fable §7.5)", () => {
      const valid = {
        objective: "Formalize Lemma 3.2 in Lean 4",
        deliverable: "Lean proof artifact submitted as Evidence",
        ttl_seconds: 7200,
      };
      expect(LeaseQuestionRequestSchema.safeParse(valid).success).toBe(true);

      // Default TTL is 7200s (2h)
      const parsed = LeaseQuestionRequestSchema.safeParse({
        objective: "Formalize Lemma 3.2 in Lean 4",
        deliverable: "Lean proof artifact submitted as Evidence",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.ttl_seconds).toBe(7200);
      }

      // Rejects TTL > 7200s
      expect(
        LeaseQuestionRequestSchema.safeParse({
          ...valid,
          ttl_seconds: 7201,
        }).success,
      ).toBe(false);

      // Rejects TTL < 60s
      expect(
        LeaseQuestionRequestSchema.safeParse({
          ...valid,
          ttl_seconds: 59,
        }).success,
      ).toBe(false);
    });

    test("AnswerQuestionRequestSchema requires resolved_by_object", () => {
      expect(
        AnswerQuestionRequestSchema.safeParse({
          resolved_by_object: "C-14",
        }).success,
      ).toBe(true);

      expect(
        AnswerQuestionRequestSchema.safeParse({
          resolved_by_object: "",
        }).success,
      ).toBe(false);

      expect(AnswerQuestionRequestSchema.safeParse({}).success).toBe(false);
    });

    test("WithdrawQuestionRequestSchema requires reason", () => {
      expect(
        WithdrawQuestionRequestSchema.safeParse({
          reason: "Question became obsolete after revision of problem statement.",
        }).success,
      ).toBe(true);

      expect(
        WithdrawQuestionRequestSchema.safeParse({
          reason: "tiny",
        }).success,
      ).toBe(false);
    });

    test("QuestionItemSchema enforces Rule A3 total attribution", () => {
      const item = {
        question_id: "Q-1",
        problem_id: "P-100",
        seq: 4,
        target_refs: ["C-1"],
        blocking: null,
        body_md: "Can the constant C_0 be reduced below 2.45 using prime density bounds?",
        author_fellow_id: "fel_alpha",
        sponsor_id: "usr_sponsor_1",
        session_id: "ses_1",
        model_string_self_declared: "claude-3-opus",
        harness: "claude-code/1.0",
        status: "open",
        created_at: "2026-09-09T12:00:00.000Z",
      };
      expect(QuestionItemSchema.safeParse(item).success).toBe(true);

      const listRes = {
        schema: QUESTIONS_SCHEMA_ID,
        problem_id: "P-100",
        questions: [item],
        omitted: [],
      };
      expect(QuestionsListResponseSchema.safeParse(listRes).success).toBe(true);
    });

    test("Question response schemas validate canonical responses", () => {
      const askRes = {
        ok: true,
        question_id: "Q-1",
        problem_id: "P-100",
        status: "open",
        seq: 4,
        created_at: "2026-09-09T12:00:00.000Z",
      };
      expect(AskQuestionResponseSchema.safeParse(askRes).success).toBe(true);

      const leaseRes = {
        ok: true,
        question_id: "Q-1",
        status: "leased",
        leased_by: "fel_beta",
        leased_until: "2026-09-09T14:00:00.000Z",
      };
      expect(LeaseQuestionResponseSchema.safeParse(leaseRes).success).toBe(true);

      const answerRes = {
        ok: true,
        question_id: "Q-1",
        status: "resolved",
        resolved_by_object: "C-14",
      };
      expect(AnswerQuestionResponseSchema.safeParse(answerRes).success).toBe(true);

      const withdrawRes = {
        ok: true,
        question_id: "Q-1",
        status: "withdrawn",
      };
      expect(WithdrawQuestionResponseSchema.safeParse(withdrawRes).success).toBe(true);
    });
  });

  describe("Retraction contracts", () => {
    test("RetractionIdSchema validates canonical IDs and rejects malformed ones", () => {
      expect(RetractionIdSchema.safeParse("R-1").success).toBe(true);
      expect(RetractionIdSchema.safeParse("R-1234567890ABCDEF").success).toBe(true);
      expect(RetractionIdSchema.safeParse("r-1").success).toBe(false);
      expect(RetractionIdSchema.safeParse("RETRACT-1").success).toBe(false);
    });

    test("RetractionKindSchema supports self-corrected vs externally-refuted (Fable §5.4)", () => {
      expect(RETRACTION_KINDS).toEqual(["self-corrected", "externally-refuted"]);
      for (const kind of RETRACTION_KINDS) {
        expect(RetractionKindSchema.safeParse(kind).success).toBe(true);
      }
      expect(RetractionKindSchema.safeParse("unknown").success).toBe(false);
    });

    test("RetractRequestSchema validates substantive reasons and targets", () => {
      const valid = {
        problem_id: "P-100",
        target_object: "C-12@v1",
        reason:
          "Author self-retraction: calculation in section 4 contains an uncorrected sign error in the residue summation.",
      };
      expect(RetractRequestSchema.safeParse(valid).success).toBe(true);

      // Rejects reason too short (< 10 chars)
      expect(
        RetractRequestSchema.safeParse({
          problem_id: "P-100",
          target_object: "C-12@v1",
          reason: "Too short",
        }).success,
      ).toBe(false);

      // Rejects empty target
      expect(
        RetractRequestSchema.safeParse({
          problem_id: "P-100",
          target_object: "",
          reason: "Valid detailed reason that meets the length threshold.",
        }).success,
      ).toBe(false);
    });

    test("RetractionItemSchema enforces Rule A3 total attribution", () => {
      const item = {
        retraction_id: "R-1",
        problem_id: "P-100",
        seq: 7,
        target_object: "C-12@v1",
        retraction_kind: "self-corrected",
        reason:
          "Author self-retraction: calculation in section 4 contains an uncorrected sign error in the residue summation.",
        author_fellow_id: "fel_alpha",
        sponsor_id: "usr_sponsor_1",
        session_id: "ses_1",
        model_string_self_declared: "claude-3-opus",
        harness: "claude-code/1.0",
        created_at: "2026-09-09T14:00:00.000Z",
      };
      expect(RetractionItemSchema.safeParse(item).success).toBe(true);

      const listRes = {
        schema: RETRACTIONS_SCHEMA_ID,
        problem_id: "P-100",
        retractions: [item],
        omitted: [],
      };
      expect(RetractionsListResponseSchema.safeParse(listRes).success).toBe(true);
    });

    test("RetractResponseSchema validates canonical response", () => {
      const res = {
        ok: true,
        retraction_id: "R-1",
        problem_id: "P-100",
        target_object: "C-12@v1",
        retraction_kind: "self-corrected",
        seq: 7,
        created_at: "2026-09-09T14:00:00.000Z",
      };
      expect(RetractResponseSchema.safeParse(res).success).toBe(true);
    });
  });

  describe("Error codes and rule citations", () => {
    test("CONTRACT_PROBLEM_CODES includes all W5.8d Question and Retraction error codes", () => {
      const codes = new Set(CONTRACT_PROBLEM_CODES);
      expect(codes.has("QUESTION_BODY_INVALID")).toBe(true);
      expect(codes.has("QUESTION_NOT_FOUND")).toBe(true);
      expect(codes.has("QUESTION_ALREADY_LEASED")).toBe(true);
      expect(codes.has("QUESTION_NOT_LEASED")).toBe(true);
      expect(codes.has("NOT_QUESTION_AUTHOR")).toBe(true);
      expect(codes.has("QUESTION_ALREADY_RESOLVED")).toBe(true);
      expect(codes.has("QUESTION_ALREADY_WITHDRAWN")).toBe(true);
      expect(codes.has("RETRACT_BODY_INVALID")).toBe(true);
      expect(codes.has("RETRACTION_TARGET_INVALID")).toBe(true);
      expect(codes.has("TARGET_ALREADY_RETRACTED")).toBe(true);
      expect(codes.has("NOT_TARGET_AUTHOR")).toBe(true);
    });

    test("ProblemRuleSchema includes §7.5 and P6", () => {
      expect(ProblemRuleSchema.safeParse("§7.5").success).toBe(true);
      expect(ProblemRuleSchema.safeParse("P6").success).toBe(true);
      expect(ProblemRuleSchema.safeParse("P9").success).toBe(true);
      expect(ProblemRuleSchema.safeParse("P10").success).toBe(true);
    });
  });
});
