import { describe, expect, test } from "bun:test";

import {
  bibtexForClaim,
  type CitableClaim,
  CitationInputError,
  type CitationRequest,
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
/** The caller's observed instant. Every fixture below dates against this. */
const OBSERVED_AT = "2026-08-18T09:00:00.000Z";
const ORIGIN = "https://asimposium.org";
/** One request, so a test states only the axis it is varying. */
const request = (overrides: Partial<CitationRequest> = {}): CitationRequest => ({
  claim: CLAIM,
  accessDate: "2026-08-18",
  origin: ORIGIN,
  observedAt: OBSERVED_AT,
  ...overrides,
});

describe("citation export (W2.8)", () => {
  test("the stable URL is problem-scoped and citable", () => {
    expect(claimStableUrl("https://asimposium.org", "P-4DSP", "C-12")).toBe(
      "https://asimposium.org/p/P-4DSP/claims/C-12",
    );
  });

  test("the cite key is stable, boring, and BibTeX-safe", () => {
    expect(citeKeyFor("P-4DSP", "C-12", 2)).toBe("asimposium_p_4dsp_c_12_v2");
    expect(citeKeyFor("P-AB", "C-12", 2)).not.toBe(citeKeyFor("P-A-B", "C-12", 2));
    expect(() => citeKeyFor("p-4dsp", "C-12", 2)).toThrow("CITATION_INPUT_INVALID");
    expect(() => citeKeyFor("P-4DSP", "C-12", 0)).toThrow("CITATION_INPUT_INVALID");
  });

  test("the BibTeX entry pins version and access date and escapes specials", () => {
    const bib = bibtexForClaim(
      request({
        claim: {
          ...CLAIM,
          authorFellowId: "F-{#}",
          statement: "A {100%} sure #thing with $math$ & _underscores_, \\path, ^x, ~y.",
        },
      }),
    );
    expect(bib).toContain("@misc{asimposium_p_4dsp_c_12_v2,");
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
    const csl = cslForClaim(request());
    expect(csl.id).toBe("asimposium_p_4dsp_c_12_v2");
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
      expect(() => bibtexForClaim(request({ claim: invalidClaim }))).toThrow(
        "CITATION_INPUT_INVALID",
      );
    }
    for (const origin of [
      "http://asimposium.org",
      "https://asimposium.org/extra",
      "https://asimposium.org/",
      "https://user@example.org",
      "https://a.asimposium.org",
      "https://example.org",
      "https://asimposium.org:8443",
      "https://bad_host.example",
      "https://-bad.example",
      "https://bad-.example",
      "https://bad..example",
    ]) {
      expect(() => claimStableUrl(origin, CLAIM.problemId, CLAIM.claimId)).toThrow(
        "CITATION_INPUT_INVALID",
      );
    }
    for (const accessDate of ["2026-2-03", "2026-02-30", "not-a-date", "2025-11-02"]) {
      expect(() => cslForClaim(request({ accessDate }))).toThrow("CITATION_INPUT_INVALID");
    }
    expect(() => bibtexForClaim(request({ accessDate: "2025-11-02" }))).toThrow(
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
    const v1 = bibtexForClaim(request({ claim: { ...CLAIM, statementVersion: 1 } }));
    const v2 = bibtexForClaim(request({ claim: { ...CLAIM, statementVersion: 2 } }));
    const cslV1 = cslForClaim(request({ claim: { ...CLAIM, statementVersion: 1 } }));
    const cslV2 = cslForClaim(request({ claim: { ...CLAIM, statementVersion: 2 } }));
    // One axis changes: exact statement version. Distinct keys let both
    // revisions coexist in one bibliography instead of silently overwriting.
    expect(v1.split("\n", 1)[0]).toBe("@misc{asimposium_p_4dsp_c_12_v1,");
    expect(v2.split("\n", 1)[0]).toBe("@misc{asimposium_p_4dsp_c_12_v2,");
    expect(v1.split("\n", 1)[0]).not.toBe(v2.split("\n", 1)[0]);
    expect(cslV1.id).toBe("asimposium_p_4dsp_c_12_v1");
    expect(cslV2.id).toBe("asimposium_p_4dsp_c_12_v2");
    expect(cslV1.id).not.toBe(cslV2.id);
    expect(v1).toContain("statement version 1");
    expect(v2).toContain("statement version 2");
  });

  test.each(["https://a.asimposium.org", "https://example.org", "https://asimposium.org:8443"])(
    "PLANTED: noncanonical public citation origin %s is refused",
    (origin) => {
      for (const render of [bibtexForClaim, cslForClaim]) {
        expect(() => render(request({ origin }))).toThrow("origin");
      }
    },
  );

  test.each([
    ["null request", null],
    ["missing claim", {}],
    ["null claim", { ...request(), claim: null }],
  ] as const)("PLANTED: malformed runtime %s is a typed refusal", (_label, malformed) => {
    for (const render of [bibtexForClaim, cslForClaim]) {
      let thrown: unknown;
      try {
        render(malformed as unknown as CitationRequest);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CitationInputError);
      expect((thrown as CitationInputError).code).toBe("CITATION_INPUT_INVALID");
    }
  });

  // One axis per plant. Each starts from `request()`, which renders cleanly, so
  // every refusal below is caused by the single field the plant overrides.
  test("PLANTED: the unmutated request renders, so each refusal is caused", () => {
    expect(() => bibtexForClaim(request())).not.toThrow();
    expect(() => cslForClaim(request())).not.toThrow();
  });

  test("PLANTED: a publication instant after the observed instant is refused", () => {
    const future = { ...CLAIM, publishedAt: "9999-12-31T23:59:59.999Z" };
    // The access date stays valid and in the past, so the ONLY check that can
    // produce this exact message is the publication bound. Delete that bound
    // and the inversion check refuses instead, with a different message — so
    // asserting the message, not merely that it throws, is what makes this red.
    for (const render of [bibtexForClaim, cslForClaim]) {
      expect(() => render(request({ claim: future }))).toThrow(
        "publication instant is after the observed instant",
      );
    }
  });

  test("PLANTED: an access date after the observed instant is refused", () => {
    for (const render of [bibtexForClaim, cslForClaim]) {
      expect(() => render(request({ accessDate: "2026-08-19" }))).toThrow(
        "access date is after the observed instant",
      );
    }
  });

  test("PLANTED: both bounds are inclusive at exact equality", () => {
    // Retrieved on the observed day, published at the observed instant. Neither
    // is a prediction, so neither may be refused — this is what proves the two
    // comparisons are strictly-greater rather than greater-or-equal.
    const sameDay = request({ accessDate: OBSERVED_AT.slice(0, 10) });
    expect(() => bibtexForClaim(sameDay)).not.toThrow();
    const sameInstant = request({
      claim: { ...CLAIM, publishedAt: OBSERVED_AT },
      accessDate: OBSERVED_AT.slice(0, 10),
    });
    expect(cslForClaim(sameInstant).issued).toEqual({ "date-parts": [[2026, 8, 18]] });
  });

  test("PLANTED: the observed instant itself must be a canonical UTC instant", () => {
    for (const observedAt of [
      "2026-08-18",
      "2026-08-18T09:00:00Z",
      "2026-08-18T09:00:00.000+01:00",
      "2026-02-30T09:00:00.000Z",
      "not-a-date",
    ]) {
      expect(() => bibtexForClaim(request({ observedAt }))).toThrow("observed instant");
    }
  });

  test("PLANTED: an access date before publication is still refused under a valid bound", () => {
    // Both times are in the past and canonical; only their order is wrong.
    expect(() => cslForClaim(request({ accessDate: "2025-11-02" }))).toThrow(
      "access date precedes publication",
    );
  });
});
