import { describe, expect, test } from "bun:test";

import {
  assessNoteIntent,
  CLAIM_LOOKALIKE_BODY_CHARS,
  suggestedClaimFromNote,
} from "../../src/krater/intent.ts";

describe("the §7.6 intent classifier", () => {
  test("a plain note is not claim-shaped", () => {
    const assessment = assessNoteIntent("Tried the obvious approach; it stalled.", false);
    expect(assessment.looksLikeClaim).toBe(false);
    expect(assessment.signals).toEqual([]);
  });

  test("proposition markers fire", () => {
    for (const marker of ["Therefore it holds.", "We prove the bound.", "Lemma: the map factors.", "Q.E.D."]) {
      const assessment = assessNoteIntent(marker, true);
      expect(assessment.looksLikeClaim, marker).toBe(true);
      expect(assessment.signals.length).toBeGreaterThan(0);
    }
  });

  test("a long unanchored body is claim-shaped; anchored is not", () => {
    const long = "x".repeat(CLAIM_LOOKALIKE_BODY_CHARS + 1);
    expect(assessNoteIntent(long, false).looksLikeClaim).toBe(true);
    expect(assessNoteIntent(long, true).looksLikeClaim).toBe(false);
  });

  test("the long-body threshold counts complete Unicode code points", () => {
    const atLimit = "🙂".repeat(CLAIM_LOOKALIKE_BODY_CHARS);
    const overLimit = `${atLimit}🙂`;
    expect(assessNoteIntent(atLimit, false).looksLikeClaim).toBe(false);
    expect(assessNoteIntent(overLimit, false).signals).toContain(
      `long-unanchored:>${CLAIM_LOOKALIKE_BODY_CHARS}`,
    );
  });

  test("a long anchored body with no markers is a note", () => {
    const long = "working note. ".repeat(200);
    expect(assessNoteIntent(long, true).looksLikeClaim).toBe(false);
  });

  test("the suggested claim prefills the statement from the first line", () => {
    const note = "\n  \nThe map factors through the quotient.\n\nA longer derivation follows.";
    expect(suggestedClaimFromNote(note).statement).toBe("The map factors through the quotient.");
  });

  test("the suggested statement truncates without splitting an astral character", () => {
    const statement = suggestedClaimFromNote(`${"a".repeat(499)}🙂discarded`).statement;
    expect(Array.from(statement)).toHaveLength(500);
    expect(statement.endsWith("🙂")).toBe(true);
    expect(statement).not.toContain("discarded");
  });

  test("the suggested statement stays canonical when the cut lands on whitespace", () => {
    const statement = suggestedClaimFromNote(`${"a".repeat(499)} discarded`).statement;
    expect(statement).toBe("a".repeat(499));
    expect(statement.endsWith(" ")).toBe(false);
  });

  test("an empty or all-blank note has no suggested statement", () => {
    expect(suggestedClaimFromNote("")).toEqual({ statement: "" });
    expect(suggestedClaimFromNote("\n\n  \n")).toEqual({ statement: "" });
  });

  test("the classifier is pure — same text, same verdict", () => {
    const body = "We show the invariant holds.";
    expect(assessNoteIntent(body, false)).toEqual(assessNoteIntent(body, false));
  });
});
