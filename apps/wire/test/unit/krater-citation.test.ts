import { describe, expect, test } from "bun:test";

import {
  bibtexForClaim,
  type CitableClaim,
  CitationInputError,
  citeKeyFor,
  claimStableUrl,
  cslForClaim,
} from "../../src/krater/citation.ts";

const CLAIM: CitableClaim = {
  problemId: "P-4DSP",
  claimId: "C-12",
  statement: "Every toggle-invariant labeling factors through the quotient.",
  statementVersion: 2,
  authorFellowId: "F-01HY",
  publishedAt: "2025-11-03T12:34:56.000Z",
};

describe("citation export (W2.8)", () => {
  test("the stable URL is problem-scoped and citable", () => {
    expect(claimStableUrl("https://asimposium.org", "P-4DSP", "C-12")).toBe(
      "https://asimposium.org/p/P-4DSP/claims/C-12",
    );
  });

  test("the cite key is stable, boring, and BibTeX-safe", () => {
    expect(citeKeyFor("P-4DSP", "C-12")).toBe("asimposium_p_4dsp_c_12");
    expect(citeKeyFor("P-AB", "C-12")).not.toBe(citeKeyFor("P-A-B", "C-12"));
    expect(() => citeKeyFor("p-4dsp", "C-12")).toThrow("CITATION_INPUT_INVALID");
  });

  test("the BibTeX entry pins version and access date and escapes specials", () => {
    const bib = bibtexForClaim(
      {
        ...CLAIM,
        authorFellowId: "F-{#}",
        statement:
          "A {100%} sure #thing with $math$ & _underscores_, \\path, ^x, ~y.",
      },
      "2026-08-18",
      "https://asimposium.org",
    );
    expect(bib).toContain("@misc{asimposium_p_4dsp_c_12,");
    expect(bib).toContain("statement version 2");
    expect(bib).toContain("Accessed 2026-08-18");
    expect(bib).toContain("\\url{https://asimposium.org/p/P-4DSP/claims/C-12}");
    // BibTeX specials are escaped, never raw.
    expect(bib).toContain("\\{100\\%\\} sure \\#thing with \\$math\\$ \\& \\_underscores\\_");
    expect(bib).toContain("ASImposium Fellow F-\\{\\#\\}");
    expect(bib).toContain("\\textbackslash{}path");
    expect(bib).toContain("\\textasciicircum{}x");
    expect(bib).toContain("\\textasciitilde{}y");
    expect(bib).not.toContain("{100%}");
    expect(bib).toContain("year = {2025}");
  });

  test("the CSL item is machine-readable with a structured access date", () => {
    const csl = cslForClaim(CLAIM, "2026-08-18", "https://asimposium.org");
    expect(csl.id).toBe("asimposium_p_4dsp_c_12");
    expect(csl.URL).toBe("https://asimposium.org/p/P-4DSP/claims/C-12");
    expect(csl.type).toBe("webpage");
    expect(csl.title).toBe(CLAIM.statement);
    expect(csl.author).toEqual([{ literal: `ASImposium Fellow ${CLAIM.authorFellowId}` }]);
    expect(csl.accessed).toEqual({ "date-parts": [[2026, 8, 18]] });
    expect(csl.issued).toEqual({ "date-parts": [[2025, 11, 3]] });
    expect(csl.note).toContain("statement version 2");
  });

  test("invalid identities, origins, versions, and access dates are refused", () => {
    for (const invalidClaim of [
      { ...CLAIM, problemId: "P-A_B" },
      { ...CLAIM, claimId: "C-one" },
      { ...CLAIM, authorFellowId: "" },
      { ...CLAIM, authorFellowId: "F-01HY " },
      { ...CLAIM, authorFellowId: "F-01\nHY" },
      { ...CLAIM, authorFellowId: "F-01\u200bHY" },
      { ...CLAIM, authorFellowId: "F-e\u0301" },
      { ...CLAIM, statement: "" },
      { ...CLAIM, statement: " leading whitespace" },
      { ...CLAIM, statement: "line one\nline two" },
      { ...CLAIM, statement: "left\u202eright" },
      { ...CLAIM, statement: "caf\u0065\u0301" },
      { ...CLAIM, statement: "non\u00a0breaking" },
      { ...CLAIM, statement: "lone\ud800surrogate" },
      { ...CLAIM, statement: "private\ue000use" },
      { ...CLAIM, statement: "unassigned\u0378codepoint" },
      { ...CLAIM, statement: "x".repeat(8 * 1024 + 1) },
      { ...CLAIM, statementVersion: 0 },
      { ...CLAIM, statementVersion: 1.5 },
      { ...CLAIM, publishedAt: "2025-11-03" },
      { ...CLAIM, publishedAt: "2025-02-30T00:00:00.000Z" },
    ]) {
      expect(() => bibtexForClaim(invalidClaim, "2026-08-18", "https://asimposium.org")).toThrow(
        "CITATION_INPUT_INVALID",
      );
    }
    for (const origin of [
      "http://asimposium.org",
      "https://asimposium.org/extra",
      "https://asimposium.org/",
      "https://user@example.org",
      "https://bad_host.example",
      "https://-bad.example",
      "https://bad-.example",
      "https://bad..example",
      `https://${"a".repeat(64)}.example`,
    ]) {
      expect(() => claimStableUrl(origin, CLAIM.problemId, CLAIM.claimId)).toThrow(
        "CITATION_INPUT_INVALID",
      );
    }
    for (const accessDate of ["2026-2-03", "2026-02-30", "not-a-date", "2025-11-02"]) {
      expect(() => cslForClaim(CLAIM, accessDate, "https://asimposium.org")).toThrow(
        "CITATION_INPUT_INVALID",
      );
    }
    expect(() => bibtexForClaim(CLAIM, "2025-11-02", "https://asimposium.org")).toThrow(
      "CITATION_INPUT_INVALID",
    );
  });

  test("citation input refusals expose one typed machine code", () => {
    try {
      claimStableUrl("http://asimposium.org", CLAIM.problemId, CLAIM.claimId);
      throw new Error("expected citation refusal");
    } catch (error) {
      if (!(error instanceof CitationInputError)) throw error;
      expect(error.code).toBe("CITATION_INPUT_INVALID");
      expect(error.message).toContain("origin");
    }
  });

  test("the version is pinned so an edit never silently strengthens a citation (P9)", () => {
    const v1 = bibtexForClaim(
      { ...CLAIM, statementVersion: 1 },
      "2026-08-18",
      "https://asimposium.org",
    );
    const v2 = bibtexForClaim(
      { ...CLAIM, statementVersion: 2 },
      "2026-08-18",
      "https://asimposium.org",
    );
    // Same stable key, different pinned version — the citation names the exact
    // version it relied on.
    expect(v1.split("\n", 1)[0]).toBe("@misc{asimposium_p_4dsp_c_12,");
    expect(v2.split("\n", 1)[0]).toBe("@misc{asimposium_p_4dsp_c_12,");
    expect(v1).toContain("statement version 1");
    expect(v2).toContain("statement version 2");
  });
});
