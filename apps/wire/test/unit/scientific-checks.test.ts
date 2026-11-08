import { expect, test } from "bun:test";
import { EvidenceRequestSchema, ScientificVerificationSchema } from "@asimposium/contracts";
import type { ScientificProvenance } from "../../../../packages/contracts/src/scientific-provenance.ts";
import { assessEvidenceClass } from "../../src/ledger/evidence-class.ts";
import { scientificIndependence } from "../../src/ledger/review-independence.ts";
import {
  inspectFormalArtifact,
  readScientificProvenance,
  type ScientificClaim,
  type ScientificEvidence,
  validateScientificVerification,
} from "../../src/ledger/scientific-checks.ts";
import { withGroundingFixture } from "./evidence-grounding-fixture.ts";

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

for (const kind of ["argument", "construction"] as const) {
  test(`an independent full-write-up review can check an original ${kind} without a citation`, () =>
    withGroundingFixture(async (f) => {
      const request = EvidenceRequestSchema.parse({
        bears_on_kind: "claim",
        bears_on_id: "C-1",
        bears_on_version: 1,
        direction: "supports",
        kind,
        source: { kind: "model_memory" },
        mode: "confirmatory",
        body_md: "For every natural n, n + 0 = n by the defining recursion for addition.",
      });
      const assessment = assessEvidenceClass({ source: request.source, mode: request.mode });
      expect(assessment.class).toBe("assertion");
      const reference = f.add("E-proof", { ...request, computed_class: assessment.class });
      const claim: ScientificClaim = {
        eventId: "event-C-1",
        payloadDigest: "c".repeat(64),
        claimId: "C-1",
        version: 1,
        contentDigest: digest,
        statement: "For every natural n, n + 0 = n.",
        fellowId: "fellow-a",
        sponsorId: "sponsor-a",
        provenance: provenance("gpt", "deductive"),
      };
      const verification = ScientificVerificationSchema.parse({
        kind: "full-write-up",
        target_digest: digest,
        evidence: reference,
        coverage: ["The recursion fixes the right zero argument for every natural number."],
        result: "verified",
      });
      const checked = await validateScientificVerification(
        f.db,
        "P-DEMO",
        claim,
        verification,
        "fellow-reviewer",
        "sponsor-reviewer",
      );
      expect(checked.fullWriteUp).toBe(true);
      expect(checked.certifiedArtifact).toBe(false);
      expect(checked.evidence.payload.computed_class).toBe("assertion");
      expect(checked.evidence.groundingWitnesses).toHaveLength(1);
    }));
}

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
