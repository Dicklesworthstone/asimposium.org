import { expect, test } from "bun:test";
import type { ScientificProvenance } from "../../../../packages/contracts/src/scientific-provenance.ts";
import { scientificIndependence } from "../../src/ledger/review-independence.ts";
import {
  inspectFormalArtifact,
  readScientificProvenance,
  type ScientificEvidence,
} from "../../src/ledger/scientific-checks.ts";

const digest = `sha256:${"a".repeat(64)}`;
const evidence: ScientificEvidence = {
  sponsorId: "S-evidence",
  eventId: "E-PUBLIC",
  payloadDigest: "a".repeat(64),
  evidenceId: "E-123",
  fellowId: "F-author",
  kind: "computation",
  direction: "supports",
  body: "Published computation.",
  payload: {},
};
const provenance = (
  family: string | null,
  category: "deductive" | "computation",
  grounded = false,
): ScientificProvenance => ({
  model_family_self_declared: family,
  method: {
    category,
    procedure: "Published procedure and failure condition.",
    evidence: grounded ? [{ evidence_id: "E-123", digest }] : [],
  },
});
const author = { sponsorId: "S-author", provenance: provenance("gpt", "deductive") };

test("independence requires explicit declarations and grounded disjoint methods", () => {
  expect(
    scientificIndependence(
      author,
      { sponsorId: "S-author", provenance: provenance("claude", "computation", true) },
      [evidence],
    ),
  ).toBe("T0");
  expect(scientificIndependence(author, { sponsorId: "S-other", provenance: null }, [])).toBe("T1");
  expect(
    scientificIndependence(
      author,
      { sponsorId: "S-other", provenance: provenance("gpt", "computation", true) },
      [evidence],
    ),
  ).toBe("T1");
  expect(
    scientificIndependence(
      author,
      { sponsorId: "S-other", provenance: provenance("claude", "deductive", true) },
      [evidence],
    ),
  ).toBe("T2");
  expect(
    scientificIndependence(
      author,
      { sponsorId: "S-other", provenance: provenance("claude", "computation") },
      [],
    ),
  ).toBe("T2");
  expect(
    scientificIndependence(
      author,
      { sponsorId: "S-other", provenance: provenance("claude", "computation", true) },
      [],
    ),
  ).toBe("T2");
  expect(
    scientificIndependence(
      author,
      { sponsorId: "S-other", provenance: provenance("claude", "computation", true) },
      [evidence],
    ),
  ).toBe("T2");
  expect(
    scientificIndependence(
      author,
      { sponsorId: "S-other", provenance: provenance("claude", "computation", true) },
      [
        {
          ...evidence,
          fellowId: "F-reviewer",
          sponsorId: "S-other",
          payload: { reproduction: { commands: ["python check.py"] } },
        },
      ],
      { reviewerFellowId: "F-reviewer" },
    ),
  ).toBe("T3");
});

test("raw model and harness aliases cannot stand in for a scientific declaration", () => {
  for (const model of ["gpt-5.6", "gpt-5.6-latest", "test-model", "another-model"]) {
    expect(readScientificProvenance({ model, harness: "different-harness" })).toBeNull();
  }
  expect(readScientificProvenance({ model_family_self_declared: "unknown" })).toBeNull();
});

test("formal source scan identifies bytes and refuses holes; it never asserts compilation", async () => {
  const artifact = {
    language: "lean",
    declaration: "calibration",
    source: "theorem calibration : 1 = 1 := rfl",
    toolchain: "Declared local Lean toolchain",
    axiom_report: "calibration does not depend on any axioms",
  };
  expect(await inspectFormalArtifact(artifact)).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(
    await inspectFormalArtifact({ ...artifact, source: "theorem calibration : False := by sorry" }),
  ).toBeNull();
  expect(
    await inspectFormalArtifact({ ...artifact, source: "axiom calibration : False" }),
  ).toBeNull();
  expect(
    await inspectFormalArtifact({ ...artifact, axiom_report: "calibration depends on sorryAx" }),
  ).toBeNull();
  expect(await inspectFormalArtifact({ ...artifact, declaration: "unrelated_theorem" })).toBeNull();
});
