import { describe, expect, test } from "bun:test";
import { ScientificProvenanceSchema } from "@asimposium/contracts";
import {
  reviewerIsAuthor,
  scientificIndependence,
  tierMovesDisclosure,
} from "../../src/ledger/review-independence.ts";

const digest = "a".repeat(64);
const evidence = {
  evidenceId: "E-1",
  payloadDigest: digest,
  eventId: "EVENT-1",
  fellowId: "F-reviewer",
  sponsorId: "SP-2",
  kind: "computation",
  direction: "supports",
  body: "Checked divisibility through n=100.",
  payload: { reproduction: { commands: ["python check.py"] } },
};
const methodReview = { reviewerFellowId: "F-reviewer" };
const declaration = (
  family: string | null,
  category: "deductive" | "computation" = "deductive",
  grounded = false,
) =>
  ScientificProvenanceSchema.parse({
    model_family_self_declared: family,
    method: {
      category,
      procedure: "Public check of the stated divisibility argument.",
      evidence: grounded ? [{ evidence_id: evidence.evidenceId, digest: `sha256:${digest}` }] : [],
    },
  });
const author = { sponsorId: "SP-1", provenance: declaration("gpt") };

describe("immutable declared scientific independence", () => {
  test("T0 sponsor, T1 family, T2 different family, T3 resolved disjoint procedure", () => {
    expect(
      scientificIndependence(
        author,
        { sponsorId: "SP-1", provenance: declaration("claude", "computation", true) },
        [evidence],
      ),
    ).toBe("T0");
    expect(
      scientificIndependence(
        author,
        { sponsorId: "SP-2", provenance: declaration("gpt", "computation", true) },
        [evidence],
      ),
    ).toBe("T1");
    expect(
      scientificIndependence(author, { sponsorId: "SP-2", provenance: declaration("claude") }, []),
    ).toBe("T2");
    expect(
      scientificIndependence(
        author,
        { sponsorId: "SP-2", provenance: declaration("claude", "computation", true) },
        [evidence],
        methodReview,
      ),
    ).toBe("T3");
  });

  test("missing or unknown family cannot earn cross-family credit", () => {
    for (const provenance of [null, declaration(null)]) {
      expect(scientificIndependence(author, { sponsorId: "SP-2", provenance }, [])).toBe("T1");
      expect(
        scientificIndependence(
          { ...author, provenance },
          { sponsorId: "SP-2", provenance: declaration("claude") },
          [],
        ),
      ).toBe("T1");
    }
    for (const family of ["", "unknown", "unspecified", "none", "null", "missing"]) {
      expect(
        ScientificProvenanceSchema.safeParse({ model_family_self_declared: family }).success,
      ).toBe(false);
    }
  });

  test("unresolved, wrong-id or wrong-digest method references cannot earn T3", () => {
    const reviewer = { sponsorId: "SP-2", provenance: declaration("claude", "computation", true) };
    for (const references of [
      [],
      [{ ...evidence, evidenceId: "E-2" }],
      [{ ...evidence, payloadDigest: "b".repeat(64) }],
    ]) {
      expect(scientificIndependence(author, reviewer, references, methodReview)).toBe("T2");
    }
    expect(
      scientificIndependence(
        author,
        { ...reviewer, provenance: declaration("claude", "computation") },
        [],
      ),
    ).toBe("T2");
  });

  test("borrowed arguments and unsupported method labels cannot manufacture T3", () => {
    const reviewer = { sponsorId: "SP-2", provenance: declaration("claude", "computation", true) };
    for (const publication of [
      { ...evidence, fellowId: "F-author" },
      { ...evidence, sponsorId: "SP-1" },
      { ...evidence, kind: "argument" },
      { ...evidence, payload: {} },
    ]) {
      expect(scientificIndependence(author, reviewer, [publication], methodReview)).toBe("T2");
    }
    expect(scientificIndependence(author, reviewer, [evidence])).toBe("T2");
  });

  test("raw model aliases, harness and prose keywords are not provenance declarations", () => {
    for (const model of [
      "openai/gpt-5.6",
      "openai/gpt-5.6-latest",
      "test-model",
      "another-model",
      "forged-model",
    ]) {
      expect(
        ScientificProvenanceSchema.safeParse({
          model,
          harness: "claude-code",
          basis: "not an independent rerun",
          rubric: ["independent-rerun"],
        }).success,
      ).toBe(false);
    }
    // Future families need no code catalog. This remains visibly self-declared.
    expect(
      scientificIndependence(
        author,
        { sponsorId: "SP-2", provenance: declaration("future-family") },
        [],
      ),
    ).toBe("T2");
  });

  test("an immutable record is unaffected by a later sponsor transfer", () => {
    const published = { sponsorId: "SP-2", provenance: declaration("claude") };
    const before = scientificIndependence(author, published, []);
    const currentBinding = { ...published, sponsorId: "SP-1" };
    expect(scientificIndependence(author, currentBinding, [])).toBe("T0");
    expect(scientificIndependence(author, published, [])).toBe(before);
  });

  test("self-review is separately refused; only cross-family tiers satisfy disclosure", () => {
    expect(reviewerIsAuthor("F-1", "F-1")).toBe(true);
    expect(reviewerIsAuthor("F-1", "F-2")).toBe(false);
    expect(
      ["T0", "T1", "T2", "T3"].map((tier) =>
        tierMovesDisclosure(tier as "T0" | "T1" | "T2" | "T3"),
      ),
    ).toEqual([false, false, true, true]);
  });
});
