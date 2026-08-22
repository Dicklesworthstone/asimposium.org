import { describe, expect, test } from "bun:test";

import { computeClaimDisposition } from "../../src/ledger/disposition-read.ts";
import type { ClaimEvent } from "../../src/ledger/dispositions.ts";

describe("the claim-disposition fold (W5.4 read side)", () => {
  test("a claim with no events is a draft", () => {
    expect(computeClaimDisposition([])).toBe("draft");
  });

  test("promote moves a draft to open", () => {
    expect(computeClaimDisposition([{ kind: "promote" }])).toBe("open");
  });

  test("a refused transition is skipped (the log is the truth, an illegal move is not a move)", () => {
    // A second promote from open is refused by the machine; the claim stays open.
    const events: ClaimEvent[] = [{ kind: "promote" }, { kind: "promote" }];
    expect(computeClaimDisposition(events)).toBe("open");
  });

  test("a malformed claim exits only via a new version (never by review volume)", () => {
    const events: ClaimEvent[] = [
      { kind: "promote" },
      { kind: "operator-repair", reason: "statement defect", to: "malformed" },
    ];
    expect(computeClaimDisposition(events)).toBe("malformed");
  });
});
