import { describe, expect, test } from "bun:test";
import {
  renderQuestionsHtmlFragment,
  renderQuestionsMarkdown,
  validateQuestionSubstance,
} from "../../src/ledger/questions";
import {
  renderRetractionsHtmlFragment,
  renderRetractionsMarkdown,
  validateRetractionSubstance,
} from "../../src/ledger/retractions";

describe("W5.8d Questions unit tests", () => {
  test("validateQuestionSubstance accepts substantive questions", () => {
    const res = validateQuestionSubstance({
      problem_id: "P-100",
      body_md: "Is there a known bounded gap for the residue class modulo 30 under Selberg sieve?",
      target_refs: ["C-12"],
    });
    expect(res.valid).toBe(true);
  });

  test("validateQuestionSubstance rejects short bodies", () => {
    const res = validateQuestionSubstance({
      problem_id: "P-100",
      body_md: "Tiny ask",
      target_refs: [],
    });
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.reason).toContain("at least 10 characters");
    }
  });

  test("validateQuestionSubstance rejects placeholder questions", () => {
    for (const ph of ["help", "todo", "tbd", "placeholder", "question"]) {
      const res = validateQuestionSubstance({
        problem_id: "P-100",
        body_md: ph,
        target_refs: [],
      });
      expect(res.valid).toBe(false);
    }
  });

  test("renderQuestionsMarkdown renders Diptych face with total attribution and no counts", () => {
    const md = renderQuestionsMarkdown("P-100", [
      {
        question_id: "Q-1",
        problem_id: "P-100",
        seq: 4,
        target_refs: ["C-12"],
        blocking: "C-12",
        body_md: "Can the Selberg sieve constant be bounded below 2.5?",
        author_fellow_id: "fel_alice",
        sponsor_id: "usr_sponsor_1",
        session_id: "ses_1",
        model_string_self_declared: "claude-3-opus",
        harness: "claude-code/1.0",
        status: "leased",
        leased_by: "fel_bob",
        leased_until: "2026-09-09T14:00:00.000Z",
        created_at: "2026-09-09T12:00:00.000Z",
      },
    ]);

    expect(md).toContain("## Question `Q-1`");
    expect(md).toContain("- **Status**: leased");
    expect(md).toContain("- **Author**: fel\\_alice");
    expect(md).toContain("- **Sponsor**: usr\\_sponsor\\_1");
    expect(md).toContain("- **Session**: ses\\_1");
    expect(md).toContain("- **Model (self-declared)**: claude-3-opus");
    expect(md).toContain("- **Harness**: claude-code/1.0");
    expect(md).toContain("- **Target refs**: `C-12`");
    expect(md).toContain("- **Blocking**: `C-12`");
    expect(md).toContain("- **Leased by**: fel\\_bob");
    expect(md).toContain("Can the Selberg sieve constant be bounded below 2.5?");

    // Rule A10: No aggregate counts or leaderboards
    expect(md).not.toContain("Total questions:");
    expect(md).not.toContain("Leaderboard");
  });

  test("renderQuestionsHtmlFragment renders neutralized HTML face", () => {
    const html = renderQuestionsHtmlFragment("P-100", [
      {
        question_id: "Q-1",
        problem_id: "P-100",
        seq: 4,
        target_refs: ["C-12"],
        blocking: null,
        body_md: "Can the constant be verified <script>alert(1)</script> safely?",
        author_fellow_id: "fel_alice",
        status: "open",
        created_at: "2026-09-09T12:00:00.000Z",
      },
    ]);

    expect(html).toContain("Questions for Problem <code>P-100</code>");
    expect(html).toContain("<h3>Question <code>Q-1</code></h3>");
    expect(html).toContain('class="asimp-status asimp-status-open"');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Total questions:");
  });
});

describe("W5.8d Retractions unit tests", () => {
  test("validateRetractionSubstance accepts substantive reasons and rejects short ones", () => {
    const valid = validateRetractionSubstance(
      "Author self-correction: sign error in the residue summation formula.",
    );
    expect(valid.valid).toBe(true);

    const invalid = validateRetractionSubstance("Too short");
    expect(invalid.valid).toBe(false);
  });

  test("renderRetractionsMarkdown renders self-corrected and externally-refuted retractions", () => {
    const md = renderRetractionsMarkdown("P-100", [
      {
        retraction_id: "R-1",
        problem_id: "P-100",
        seq: 5,
        target_object: "C-12@v1",
        retraction_kind: "self-corrected",
        reason: "Author self-correction: formula contained an uncorrected sign error.",
        author_fellow_id: "fel_alice",
        sponsor_id: "usr_sponsor_1",
        session_id: "ses_1",
        model_string_self_declared: "gpt-5-pro",
        harness: "custom-runner/1.0",
        created_at: "2026-09-09T13:00:00.000Z",
      },
    ]);

    expect(md).toContain("## Retraction `R-1`");
    expect(md).toContain("- **Target object**: `C-12@v1`");
    expect(md).toContain("- **Kind**: self-corrected");
    expect(md).toContain("- **Author**: fel\\_alice");
    expect(md).toContain("- **Sponsor**: usr\\_sponsor\\_1");
    expect(md).toContain("- **Session**: ses\\_1");
    expect(md).toContain("- **Model (self-declared)**: gpt-5-pro");
    expect(md).toContain("- **Harness**: custom-runner/1.0");
    expect(md).toContain("Author self-correction: formula contained an uncorrected sign error.");

    // Rule A10: No aggregate counts or leaderboards
    expect(md).not.toContain("Total retractions:");
    expect(md).not.toContain("Leaderboard");
  });

  test("renderRetractionsHtmlFragment renders HTML face with kind badge", () => {
    const html = renderRetractionsHtmlFragment("P-100", [
      {
        retraction_id: "R-1",
        problem_id: "P-100",
        seq: 5,
        target_object: "C-12@v1",
        retraction_kind: "externally-refuted",
        reason: "Retracting after external refutation by fel_bob in REV-42.",
        author_fellow_id: "fel_alice",
        created_at: "2026-09-09T13:00:00.000Z",
      },
    ]);

    expect(html).toContain("Retractions for Problem <code>P-100</code>");
    expect(html).toContain("<h3>Retraction <code>R-1</code></h3>");
    expect(html).toContain('class="asimp-retraction-kind asimp-kind-externally-refuted"');
    expect(html).not.toContain("Total retractions:");
  });
});
