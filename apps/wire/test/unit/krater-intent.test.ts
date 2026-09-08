import { describe, expect, test } from "bun:test";

import {
  assessNoteIntent,
  CLAIM_LOOKALIKE_BODY_CHARS,
  suggestedClaimFromNote,
} from "../../src/krater/intent.ts";

/**
 * One body per proposition-marker family, paired with the exact signal that
 * family emits. The isolation is asserted, not assumed: every case below
 * requires `signals` to equal exactly `[signal]`, so a body that fired the
 * wrong family — or fired two — is red rather than merely non-empty. That is
 * what lets a failure name its family, and what makes broadening any one
 * regex detectable instead of silently absorbed by a sibling.
 *
 * Each `signal` is `proposition-marker:${regex.source}` spelled literally
 * rather than derived from the module, so a source edit has to be made here
 * too and cannot restate itself as its own proof.
 */
const MARKER_FIXTURES = [
  { body: "Therefore it holds.", signal: "proposition-marker:\\btherefore\\b" },
  {
    body: "We prove the bound.",
    signal: "proposition-marker:\\bwe (prove|show|establish|claim)\\b",
  },
  {
    body: "Lemma: the map factors.",
    signal: "proposition-marker:\\b(lemma|theorem|corollary|conjecture|proposition)\\s*[:.\\d]",
  },
  { body: "Claim: the bound is tight.", signal: "proposition-marker:\\bclaim\\s*:" },
  { body: "Q.E.D.", signal: "proposition-marker:\\bq\\.?e\\.?d\\.?\\b" },
] as const;

describe("the §7.6 intent classifier", () => {
  test("a plain note is not claim-shaped", () => {
    const assessment = assessNoteIntent("Tried the obvious approach; it stalled.", false);
    expect(assessment.looksLikeClaim).toBe(false);
    expect(assessment.signals).toEqual([]);
  });

  test("each proposition marker fires its own family and only its own", () => {
    for (const { body, signal } of MARKER_FIXTURES) {
      // Anchored, so the long-unanchored signal cannot join the array and
      // turn an exact-match assertion into an accidental two-element one.
      const assessment = assessNoteIntent(body, true);
      expect(assessment.looksLikeClaim, body).toBe(true);
      expect(assessment.signals, body).toEqual([signal]);
    }
  });

  test("the long-body threshold is the Fable §7.6 value, not merely self-consistent", () => {
    // Stated as a literal on purpose. Every other assertion in this file is
    // written relative to the constant, so all of them stay green if it drifts
    // to 8 or 8000; this is the only one that would notice.
    expect(CLAIM_LOOKALIKE_BODY_CHARS).toBe(800);
  });

  test("a long unanchored body is claim-shaped; anchored is not", () => {
    const long = "x".repeat(CLAIM_LOOKALIKE_BODY_CHARS + 1);
    expect(assessNoteIntent(long, false).looksLikeClaim).toBe(true);
    expect(assessNoteIntent(long, true).looksLikeClaim).toBe(false);
  });

  test("the long-body threshold counts code points, not UTF-16 or UTF-8 units", () => {
    const atLimit = "🙂".repeat(CLAIM_LOOKALIKE_BODY_CHARS);
    const overLimit = `${atLimit}🙂`;
    expect(atLimit.length).toBe(CLAIM_LOOKALIKE_BODY_CHARS * 2);
    expect(new TextEncoder().encode(atLimit)).toHaveLength(CLAIM_LOOKALIKE_BODY_CHARS * 4);
    expect(assessNoteIntent(atLimit, false).looksLikeClaim).toBe(false);
    expect(assessNoteIntent(overLimit, false).signals).toContain(
      `long-unanchored:>${CLAIM_LOOKALIKE_BODY_CHARS}`,
    );
  });

  test("the threshold counts combining and ZWJ code points, not rendered graphemes", () => {
    // This is 400 rendered e-acute sequences but 800 code points. Adding one
    // ASCII code point crosses the Fable boundary without a locale segmenter.
    const combiningAtLimit = "e\u0301".repeat(400);
    const combiningOverLimit = `${combiningAtLimit}x`;
    expect(Array.from(combiningAtLimit)).toHaveLength(CLAIM_LOOKALIKE_BODY_CHARS);
    expect(assessNoteIntent(combiningAtLimit, false).looksLikeClaim).toBe(false);
    expect(assessNoteIntent(combiningOverLimit, false).signals).toContain(
      `long-unanchored:>${CLAIM_LOOKALIKE_BODY_CHARS}`,
    );

    // Each scientist sequence is one rendered grapheme but three code points
    // (woman, ZWJ, microscope), so 267 sequences cross the same code-point cap.
    const zwjOverLimit = "👩‍🔬".repeat(267);
    expect(Array.from(zwjOverLimit)).toHaveLength(CLAIM_LOOKALIKE_BODY_CHARS + 1);
    expect(assessNoteIntent(zwjOverLimit, false).signals).toContain(
      `long-unanchored:>${CLAIM_LOOKALIKE_BODY_CHARS}`,
    );
  });

  test("a long anchored body with no markers is a note", () => {
    const long = "working note. ".repeat(200);
    expect(assessNoteIntent(long, true).looksLikeClaim).toBe(false);
  });

  test("the suggested claim prefills the first nonblank line for every Markdown line ending", () => {
    for (const lineEnding of ["\n", "\r\n", "\r"] as const) {
      const note = ["", "  ", "The map factors through the quotient.", "", "Later line."].join(
        lineEnding,
      );
      const statement = suggestedClaimFromNote(note).statement;
      expect(statement, JSON.stringify(lineEnding)).toBe("The map factors through the quotient.");
      expect(statement, JSON.stringify(lineEnding)).not.toMatch(/[\r\n]/);
    }
  });

  // The walk scans code units and slices only the selected line rather than
  // splitting the body, so no full-body line-array is allocated. That is the
  // whole of the claim: a single-line body still slices and trims the body
  // itself, so this is not zero string allocation and is not asserted to be.
  test("the suggested statement preserves a valid surrogate pair at the code-point prefix", () => {
    const statement = suggestedClaimFromNote(`${"a".repeat(499)}🙂discarded`).statement;
    expect(Array.from(statement)).toHaveLength(500);
    expect(statement.endsWith("🙂")).toBe(true);
    expect(statement).not.toContain("discarded");
  });

  test("the suggested statement has code-point rather than grapheme prefix semantics", () => {
    // The 500th code point is the base e; the following combining mark is not
    // retained. This intentionally promises scalar safety, not grapheme repair.
    const combining = suggestedClaimFromNote(`${"a".repeat(499)}e\u0301discarded`).statement;
    expect(combining).toBe(`${"a".repeat(499)}e`);
    expect(Array.from(combining)).toHaveLength(500);

    // Likewise, a ZWJ sequence may end at a code-point boundary. The result is
    // valid UTF-16 and deterministic, while a locale-sensitive display-unit
    // policy would be a distinct product contract.
    const zwj = suggestedClaimFromNote(`${"a".repeat(498)}👩‍🔬discarded`).statement;
    expect(zwj).toBe(`${"a".repeat(498)}👩‍`);
    expect(Array.from(zwj)).toHaveLength(500);
    expect(zwj).not.toContain("🔬");
  });

  test("the suggested statement stays canonical when the cut lands on whitespace", () => {
    const statement = suggestedClaimFromNote(`${"a".repeat(499)} discarded`).statement;
    expect(statement).toBe("a".repeat(499));
    expect(statement.endsWith(" ")).toBe(false);
  });

  test("an empty or all-blank note has no suggested statement", () => {
    expect(suggestedClaimFromNote("")).toEqual({ statement: "" });
    expect(suggestedClaimFromNote("\n\n  \n")).toEqual({ statement: "" });
    expect(suggestedClaimFromNote("\r\n\r\r  \r\n")).toEqual({ statement: "" });
  });

  test("the classifier is pure — same text, same verdict", () => {
    const body = "We show the invariant holds.";
    expect(assessNoteIntent(body, false)).toEqual(assessNoteIntent(body, false));
  });

  test("every proposition marker family stays deterministic across repeated calls", () => {
    // The markers are module-level regexes shared by every call, so a `g` or
    // `y` flag on any one of them would make `test()` advance its `lastIndex`
    // past the first hit and miss on the repeat, silently dropping that
    // family's signal. Anchoring the notes keeps the long-unanchored signal
    // out of the comparison, so a difference can only come from a marker.
    for (const { body, signal } of MARKER_FIXTURES) {
      const first = assessNoteIntent(body, true);
      const second = assessNoteIntent(body, true);
      // A fixture matching nothing would make the repeat comparison vacuous,
      // so the first call must be pinned to its own family before the repeat
      // is allowed to mean anything.
      expect(first.signals, body).toEqual([signal]);
      expect(second, body).toEqual(first);
    }
  });

  test("exact 800 and 801 boundary checks with and without relates_to", () => {
    const exact800 = "a".repeat(800);
    const exact801 = "a".repeat(801);

    // Unanchored: 800 passes, 801 triggers LOOKS_LIKE_CLAIM
    const unanchored800 = assessNoteIntent(exact800, false);
    expect(unanchored800.looksLikeClaim).toBe(false);
    expect(unanchored800.signals).toEqual([]);

    const unanchored801 = assessNoteIntent(exact801, false);
    expect(unanchored801.looksLikeClaim).toBe(true);
    expect(unanchored801.signals).toEqual(["long-unanchored:>800"]);

    // Anchored (relates_to present): both pass
    const anchored800 = assessNoteIntent(exact800, true);
    expect(anchored800.looksLikeClaim).toBe(false);
    expect(anchored800.signals).toEqual([]);

    const anchored801 = assessNoteIntent(exact801, true);
    expect(anchored801.looksLikeClaim).toBe(false);
    expect(anchored801.signals).toEqual([]);

    // 801 whitespace characters without relates_to triggers classifier,
    // but suggestedClaimFromNote produces an empty statement cleanly.
    const whitespace801 = " \t\n".repeat(267);
    const unanchoredWhitespace = assessNoteIntent(whitespace801, false);
    expect(unanchoredWhitespace.looksLikeClaim).toBe(true);
    expect(unanchoredWhitespace.signals).toEqual(["long-unanchored:>800"]);
    expect(suggestedClaimFromNote(whitespace801)).toEqual({ statement: "" });
  });

  test("clear claims in various standard mathematical forms", () => {
    const claimSamples = [
      "Therefore every positive integer greater than 1 has a unique prime factorization.",
      "We prove that the Riemann zeta function has all non-trivial zeros on the critical line.",
      "We show that P does not equal NP under standard Turing machine assumptions.",
      "We establish that the heat kernel satisfies the maximum principle.",
      "We claim that the spectral gap is bounded strictly away from zero.",
      "Lemma 1: For all n > 0, the factorial n! is divisible by all primes <= n.",
      "Theorem 2.1: Compact subsets of metric spaces are closed and bounded.",
      "Corollary 3: There are infinitely many primes of the form 4k + 1.",
      "Conjecture: The Collatz sequence terminates for all positive integers.",
      "Proposition: The quotient ring R/M is a field if and only if M is maximal.",
      "Claim: The running time of Dijkstra's algorithm is O(E + V log V).",
      "By induction on k, we obtain the identity. Q.E.D.",
    ];

    for (const sample of claimSamples) {
      const assessment = assessNoteIntent(sample, false);
      expect(assessment.looksLikeClaim, sample).toBe(true);
      expect(assessment.signals.length, sample).toBeGreaterThan(0);
    }
  });

  test("clear notes without claim markers pass unconditionally", () => {
    const noteSamples = [
      "Initial brainstorm on the structure of the proof.",
      "Tried using the Cauchy-Schwarz inequality, but the denominator blew up.",
      "Need to review Tao's 2014 paper on arithmetic progressions in primes.",
      "Refactored lemma helper to clean up unnecessary lemmas in the draft.",
      "Checked test coverage on local workerd instance: 100% green.",
      "Meeting with sponsor agreed to focus on the modular representation approach.",
    ];

    for (const sample of noteSamples) {
      const assessment = assessNoteIntent(sample, false);
      expect(assessment.looksLikeClaim, sample).toBe(false);
      expect(assessment.signals, sample).toEqual([]);
    }
  });

  test("math formulas and near-miss vocabulary do not trigger false claims", () => {
    const nearMissSamples = [
      // Substring overlaps: "there" or "fore" without "therefore"
      "Look over there at the fore of the ship.",
      // "dilemma" does not match "lemma:"
      "The classical prisoner's dilemma is often analyzed in game theory.",
      // "claim" without colon
      "This is a bold claim to make in informal notes without formal verification.",
      // "prove" without "we prove"
      "Can one prove this directly from the axioms? It remains unclear.",
      // "theorem" without colon or digit
      "Every major theorem in this subject relies on compactness.",
      // Math formulas
      "Consider the integral $$\\int_{-\\infty}^\\infty e^{-x^2} dx = \\sqrt{\\pi}$$.",
      "Let $f(x) = x^2 + 2x + 1 = (x + 1)^2$. Clearly $f(x) \\ge 0$.",
      "Let variables be $a_1, a_2, \\dots, a_n \\in \\mathbb{R}$.",
      // Code fragments in notes
      "```python\ndef prove_bound(x, y):\n    return x + y > 0\n```",
      "assert len(data) > 0, 'data must be non-empty'",
    ];

    for (const sample of nearMissSamples) {
      const assessment = assessNoteIntent(sample, false);
      expect(assessment.looksLikeClaim, sample).toBe(false);
      expect(assessment.signals, sample).toEqual([]);
    }
  });

  test("valid strange notes and rich formatting pass under 800 characters", () => {
    const strangeSamples = [
      // Markdown table
      "| Method | Accuracy | Latency (ms) |\n|---|---|---|\n| Baseline | 82.1% | 12 |\n| Proposed | 88.4% | 14 |",
      // Nested blockquotes
      "> First observation\n>> Secondary detail on the observation\n>>> Minor side note",
      // Unicode math symbols (Fraktur, Greek, Blackboard Bold)
      "Let $\\mathfrak{g}$ be a Lie algebra over $\\mathbb{C}$, with roots $\\alpha \\in \\Phi$.",
      // ASCII art diagram
      "+-------+     +-------+\n| A     | --> | B     |\n+-------+     +-------+",
      // Short poem
      "Roses are red,\nViolets are blue,\nWorking on proofs,\nUntil dreams come true.",
    ];

    for (const sample of strangeSamples) {
      expect(sample.length).toBeLessThan(800);
      const assessment = assessNoteIntent(sample, false);
      expect(assessment.looksLikeClaim, sample).toBe(false);
      expect(assessment.signals, sample).toEqual([]);
    }
  });

  test("adversarial prose containing quoted markers fires classifier as designed (escape via force_note)", () => {
    // Colleague-voice rule: even if quoting or discussing markers, the classifier
    // mechanically flags them, directing the author to promote or use force_note: true.
    const metaProse =
      "The author states: 'Therefore the solution is unique', but this is questionable.";
    const assessment = assessNoteIntent(metaProse, false);
    expect(assessment.looksLikeClaim).toBe(true);
    expect(assessment.signals).toContain("proposition-marker:\\btherefore\\b");
  });
});
