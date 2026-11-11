import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  type ReviewWeightInput,
  reviewCarriesWeight,
  reviewCarriesWeightSql,
} from "../../src/ledger/review-weight.ts";

const finding: ReviewWeightInput = {
  basis: "Checked the exact quantified statement and its zero case.",
  capableOfFailure: "The zero case could violate the conclusion.",
  bodyMd: "Verified.",
};

test("the shared review rule recognizes whole-field impressions without judging arbitrary prose", () => {
  for (const basis of [
    "looks right",
    "Looks correct.",
    "looks good",
    "looks wrong",
    "looks incorrect",
    "Seems right!",
    "Seems correct",
    "seems good",
    "seems wrong",
    "seems incorrect",
    "I agree.",
    "I disagree.",
    "Agreed.",
    "Disagreed.",
    "LGTM",
    " > **LOOKS\tRIGHT!** \n",
    "“looks\u00a0right”",
    "`Looks\u2028wrong.`",
  ]) {
    const input = { ...finding, basis };
    expect(reviewCarriesWeight(input)).toBe(false);
    expect(input.basis).toBe(basis);
  }
  for (const basis of [
    finding.basis,
    "The claim looks right after checking that the only possible output is zero.",
    "Checked the statement match.",
    "Independent rerun",
  ])
    expect(reviewCarriesWeight({ ...finding, basis })).toBe(true);
  // A terse result does not erase the actual work stated in the basis.
  expect(reviewCarriesWeight({ ...finding, bodyMd: "Looks right." })).toBe(true);
});

test("legacy or malformed missing review fields cannot supply verification weight", () => {
  for (const field of ["basis", "capableOfFailure", "bodyMd"] as const) {
    for (const value of [undefined, null, "", " \t\r\n\u00a0\ufeff", 1, {}, []])
      expect(reviewCarriesWeight({ ...finding, [field]: value })).toBe(false);
  }
  expect(reviewCarriesWeight({ ...finding, basis: " **.!?** " })).toBe(false);
});

test("SQLite's immutable review metadata uses the same weight rule as write admission", () => {
  const db = new Database(":memory:");
  try {
    const query = db.query(`WITH review(basis, capability, body) AS (VALUES (?, ?, ?))
      SELECT ${reviewCarriesWeightSql({ basis: "review.basis", capableOfFailure: "review.capability", bodyMd: "review.body" })}
        AS carries_weight FROM review`);
    const cases = [
      finding,
      { ...finding, basis: "Looks right." },
      { ...finding, basis: " > **LOOKS\tRIGHT!** \n" },
      { ...finding, basis: "“looks\u00a0right”" },
      { ...finding, basis: "`Looks\u2028wrong.`" },
      { ...finding, basis: "The equality looks right because reflexivity covers this integer." },
      { ...finding, bodyMd: "Looks right." },
      { ...finding, basis: " **.!?** " },
      { ...finding, basis: null },
      { ...finding, basis: 1 },
      { ...finding, capableOfFailure: null },
      { ...finding, bodyMd: null },
      { ...finding, basis: "\0looks right" },
      { ...finding, capableOfFailure: "\0" },
    ];
    for (const field of ["basis", "capableOfFailure", "bodyMd"] as const)
      cases.push({ ...finding, [field]: " \t\r\n\u00a0\ufeff" });
    for (const input of cases) {
      const result = query.get(
        input.basis as string | number | null,
        input.capableOfFailure as string | null,
        input.bodyMd as string | null,
      ) as { carries_weight: number };
      expect(result.carries_weight === 1).toBe(reviewCarriesWeight(input));
    }
  } finally {
    db.close();
  }
});
