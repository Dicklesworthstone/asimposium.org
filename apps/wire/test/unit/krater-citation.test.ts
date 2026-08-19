import { describe, expect, test } from "bun:test";

import {
  bibtexForClaim,
  citeKeyFor,
  claimStableUrl,
  cslForClaim,
  type CitableClaim,
} from "../../src/krater/citation.ts";

const CLAIM: CitableClaim = {
  problemId: "P-4DSP",
  claimId: "C-12",
  statement: "Every toggle-invariant labeling factors through the quotient.",
  statementVersion: 2,
  authorFellowId: "F-01HY",
};

describe("citation export (W2.8)", () => {
  test("the stable URL is problem-scoped and citable", () => {
    expect(claimStableUrl("https://asimposium.org", "P-4DSP", "C-12")).toBe(
      "https://asimposium.org/p/P-4DSP/claims/C-12",
    );
  });

  test("the cite key is stable, boring, and BibTeX-safe", () => {
    expect(citeKeyFor("P-4DSP", "C-12")).toBe("asimposiump4dspc12");
    // The key survives punctuation and case without drifting.
    expect(citeKeyFor("P-4DSP", "C-12")).toBe(citeKeyFor("p-4dsp", "c-12"));
  });

  test("the BibTeX entry pins version and access date and escapes specials", () => {
    const bib = bibtexForClaim(
      { ...CLAIM, statement: "A 100% sure thing with $math$ & _underscores_." },
      "2026-08-18",
      "https://asimposium.org",
    );
    expect(bib).toContain("@misc{asimposiump4dspc12,");
    expect(bib).toContain("statement version 2");
    expect(bib).toContain("Accessed 2026-08-18");
    expect(bib).toContain("\\url{https://asimposium.org/p/P-4DSP/claims/C-12}");
    // BibTeX specials are escaped, never raw.
    expect(bib).toContain("100\\% sure thing with \\$math\\$ \\& \\_underscores\\_");
    expect(bib).not.toContain("100% sure");
  });

  test("the CSL item is machine-readable with a structured access date", () => {
    const csl = cslForClaim(CLAIM, "2026-08-18", "https://asimposium.org");
    expect(csl.id).toBe("asimposiump4dspc12");
    expect(csl.URL).toBe("https://asimposium.org/p/P-4DSP/claims/C-12");
    expect(csl.accessed).toEqual({ "date-parts": [[2026, 8, 18]] });
    expect(csl.note).toContain("statement version 2");
  });

  test("the version is pinned so an edit never silently strengthens a citation (P9)", () => {
    const v1 = bibtexForClaim({ ...CLAIM, statementVersion: 1 }, "2026-08-18", "https://asimposium.org");
    const v2 = bibtexForClaim({ ...CLAIM, statementVersion: 2 }, "2026-08-18", "https://asimposium.org");
    // Same stable key, different pinned version — the citation names the exact
    // version it relied on.
    expect(citeKeyFor(CLAIM.problemId, CLAIM.claimId)).toBe(citeKeyFor(CLAIM.problemId, CLAIM.claimId));
    expect(v1).toContain("statement version 1");
    expect(v2).toContain("statement version 2");
  });
});
