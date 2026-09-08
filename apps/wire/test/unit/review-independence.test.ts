import { describe, expect, test } from "bun:test";

import {
  independenceTier,
  type ReviewAttribution,
  reviewerIsAuthor,
  tierMovesDisclosure,
} from "../../src/ledger/review-independence.ts";

const A: ReviewAttribution = { sponsorId: "SP-1", modelFamily: "claude", methodBasis: "search" };

describe("W5.7 review independence tiers", () => {
  test("P1: the author can never review their own object", () => {
    expect(reviewerIsAuthor("F-1", "F-1")).toBe(true);
    expect(reviewerIsAuthor("F-1", "F-2")).toBe(false);
  });

  test("T0 same sponsor; T1 different sponsor, same model family; T2 different model family; T3 disjoint method", () => {
    expect(independenceTier(A, { ...A })).toBe("T0");
    expect(independenceTier(A, { ...A, sponsorId: "SP-2" })).toBe("T1");
    expect(
      independenceTier(A, { sponsorId: "SP-2", modelFamily: "gpt", methodBasis: "search" }),
    ).toBe("T2");
    expect(
      independenceTier(A, { sponsorId: "SP-2", modelFamily: "gpt", methodBasis: "proof-search" }),
    ).toBe("T3");
  });

  test("strongly-supported requires T2 or higher", () => {
    expect(tierMovesDisclosure("T0")).toBe(false);
    expect(tierMovesDisclosure("T1")).toBe(false);
    expect(tierMovesDisclosure("T2")).toBe(true);
    expect(tierMovesDisclosure("T3")).toBe(true);
  });

  test("aliases and version spellings of one family refuse T2 and return T1", () => {
    const author: ReviewAttribution = {
      sponsorId: "SP-1",
      modelFamily: "openai/gpt-5.6",
      methodBasis: "deductive",
    };
    // Different version punctuation and aliases of gpt-5
    expect(
      independenceTier(author, {
        sponsorId: "SP-2",
        modelFamily: "openai/gpt-5.6-latest",
        methodBasis: "computational",
      }),
    ).toBe("T1");
    expect(
      independenceTier(author, {
        sponsorId: "SP-2",
        modelFamily: "gpt-5.6-turbo",
        methodBasis: "computational",
      }),
    ).toBe("T1");
    expect(
      independenceTier(author, {
        sponsorId: "SP-2",
        modelFamily: "gpt-5",
        methodBasis: "computational",
      }),
    ).toBe("T1");

    // Claude 3.7 variants
    const claudeAuthor: ReviewAttribution = {
      sponsorId: "SP-1",
      modelFamily: "anthropic/claude-3-7-sonnet",
      methodBasis: "deductive",
    };
    expect(
      independenceTier(claudeAuthor, {
        sponsorId: "SP-2",
        modelFamily: "claude-3.7-sonnet-latest",
        methodBasis: "computational",
      }),
    ).toBe("T1");

    // Gemini variants
    const geminiAuthor: ReviewAttribution = {
      sponsorId: "SP-1",
      modelFamily: "google/gemini-2.5-pro",
      methodBasis: "deductive",
    };
    expect(
      independenceTier(geminiAuthor, {
        sponsorId: "SP-2",
        modelFamily: "gemini-2.5-flash",
        methodBasis: "computational",
      }),
    ).toBe("T1");

    // Grok variants
    const grokAuthor: ReviewAttribution = {
      sponsorId: "SP-1",
      modelFamily: "xai/grok-3",
      methodBasis: "deductive",
    };
    expect(
      independenceTier(grokAuthor, {
        sponsorId: "SP-2",
        modelFamily: "grok-3-mini",
        methodBasis: "computational",
      }),
    ).toBe("T1");
  });

  test("genuinely distinct declared families earn T2", () => {
    const author: ReviewAttribution = {
      sponsorId: "SP-1",
      modelFamily: "openai/gpt-5.6",
      methodBasis: "deductive",
    };
    // GPT-5 vs Claude 3.7
    expect(
      independenceTier(author, {
        sponsorId: "SP-2",
        modelFamily: "anthropic/claude-3.7-sonnet",
        methodBasis: "deductive",
      }),
    ).toBe("T2");

    // Same provider (openai), distinct families (gpt-5 vs o3)
    expect(
      independenceTier(author, {
        sponsorId: "SP-2",
        modelFamily: "openai/o3",
        methodBasis: "deductive",
      }),
    ).toBe("T2");

    // Different providers (anthropic vs bedrock), same underlying family (claude-3.7) -> refuses T2
    expect(
      independenceTier(
        { sponsorId: "SP-1", modelFamily: "anthropic/claude-3.7-sonnet", methodBasis: "deductive" },
        { sponsorId: "SP-2", modelFamily: "bedrock/claude-3.7-sonnet", methodBasis: "deductive" },
      ),
    ).toBe("T1");

    // Gemini vs Llama
    expect(
      independenceTier(
        { sponsorId: "SP-1", modelFamily: "google/gemini-2.5-pro", methodBasis: "deductive" },
        { sponsorId: "SP-2", modelFamily: "meta/llama-3.3-70b", methodBasis: "deductive" },
      ),
    ).toBe("T2");

    // DeepSeek vs GPT
    expect(
      independenceTier(
        { sponsorId: "SP-1", modelFamily: "deepseek-r1", methodBasis: "deductive" },
        { sponsorId: "SP-2", modelFamily: "openai/gpt-5", methodBasis: "deductive" },
      ),
    ).toBe("T2");
  });

  test("missing or unknown model data refuses T2 and caps at T1", () => {
    const author: ReviewAttribution = {
      sponsorId: "SP-1",
      modelFamily: "openai/gpt-5.6",
      methodBasis: "deductive",
    };
    for (const unknownModel of [
      "",
      "   ",
      "unknown",
      "unspecified",
      "undefined",
      "none",
      "n/a",
      "custom-unrecognized",
    ]) {
      expect(
        independenceTier(author, {
          sponsorId: "SP-2",
          modelFamily: unknownModel,
          methodBasis: "computational",
        }),
      ).toBe("T1");
      expect(
        independenceTier(
          { sponsorId: "SP-1", modelFamily: unknownModel, methodBasis: "deductive" },
          { sponsorId: "SP-2", modelFamily: "openai/gpt-5.6", methodBasis: "computational" },
        ),
      ).toBe("T1");
    }
  });

  test("changed harness with unchanged method refuses T3 and returns T2", () => {
    // Both read the same derivation (method: deductive)
    // Even though author uses codex and reviewer uses claude-code
    const author: ReviewAttribution = {
      sponsorId: "SP-1",
      modelFamily: "openai/gpt-5.6",
      methodBasis: "deductive",
    };
    const reviewer: ReviewAttribution = {
      sponsorId: "SP-2",
      modelFamily: "anthropic/claude-3.7-sonnet",
      methodBasis: "deductive",
    };
    expect(independenceTier(author, reviewer)).toBe("T2");

    // Client harness strings passed as methodBasis never earn T3
    expect(
      independenceTier(
        { sponsorId: "SP-1", modelFamily: "openai/gpt-5.6", methodBasis: "codex" },
        {
          sponsorId: "SP-2",
          modelFamily: "anthropic/claude-3.7-sonnet",
          methodBasis: "claude-code",
        },
      ),
    ).toBe("T2");
  });

  test("same harness with documented disjoint method earns T3", () => {
    // Both fellows used the same client software (e.g. codex), but reviewer executed
    // an independent computational rerun against the author's deductive proof
    const author: ReviewAttribution = {
      sponsorId: "SP-1",
      modelFamily: "openai/gpt-5.6",
      methodBasis: "deductive",
    };
    const reviewer: ReviewAttribution = {
      sponsorId: "SP-2",
      modelFamily: "anthropic/claude-3.7-sonnet",
      methodBasis: "computational",
    };
    expect(independenceTier(author, reviewer)).toBe("T3");
  });

  test("absent or unknown method evidence refuses T3 and returns T2", () => {
    const author: ReviewAttribution = {
      sponsorId: "SP-1",
      modelFamily: "openai/gpt-5.6",
      methodBasis: "deductive",
    };
    for (const unknownMethod of ["", "   ", "unknown", "unspecified", "undefined", "looks-right"]) {
      expect(
        independenceTier(author, {
          sponsorId: "SP-2",
          modelFamily: "anthropic/claude-3.7-sonnet",
          methodBasis: unknownMethod,
        }),
      ).toBe("T2");
    }
  });

  test("same sponsor always returns T0 regardless of model or method", () => {
    expect(
      independenceTier(
        { sponsorId: "SP-1", modelFamily: "openai/gpt-5.6", methodBasis: "deductive" },
        {
          sponsorId: "SP-1",
          modelFamily: "anthropic/claude-3.7-sonnet",
          methodBasis: "computational",
        },
      ),
    ).toBe("T0");
  });

  test("the tier is over the immutable attribution, never the current binding", () => {
    // The same two records always compute the same tier — a later transfer
    // cannot change a historical review's independence.
    const reviewer: ReviewAttribution = {
      sponsorId: "SP-2",
      modelFamily: "gpt",
      methodBasis: "proof-search",
    };
    expect(independenceTier(A, reviewer)).toBe(independenceTier(A, { ...reviewer }));
  });
});
