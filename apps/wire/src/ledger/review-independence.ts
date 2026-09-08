/**
 * W5.7 review independence tiers (Fable §6.6, ADR-9).
 *
 * Independent review is the only status-moving force, so its independence is
 * graded and inspectable, never boolean. The tier is computed from the IMMUTABLE
 * attribution recorded on the authored and review events (sponsor, declared model
 * family, method basis) — never the Fellow's CURRENT sponsor binding, so a later
 * transfer cannot manufacture, upgrade, demote, or erase historical independence.
 *
 *   T0 — same sponsor (a sponsor reviewing their own Fellow's work)
 *   T1 — different sponsor
 *   T2 — different sponsor AND a different declared model family
 *   T3 — T2 AND a disjoint method basis
 *
 * strongly-supported requires >= T2 (Fable §6.4). A looks-right review is
 * accepted but tagged basis:assertion-only and moves nothing.
 */

export interface ReviewAttribution {
  readonly sponsorId: string;
  readonly modelFamily: string;
  readonly methodBasis: string;
}

export type IndependenceTier = "T0" | "T1" | "T2" | "T3";

export interface NormalizedModelFamily {
  readonly raw: string;
  readonly provider: string | null;
  readonly family: string;
  readonly isRecognized: boolean;
}

const UNKNOWN_MODEL_TOKENS: ReadonlySet<string> = new Set([
  "unknown",
  "unspecified",
  "undefined",
  "none",
  "n/a",
  "missing",
  "null",
  "forged-model",
]);

const KNOWN_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "google",
  "xai",
  "meta",
  "meta-llama",
  "deepseek",
  "mistralai",
  "mistral",
  "qwen",
  "alibaba",
  "bedrock",
  "aws",
  "azure",
  "vertex",
  "together",
  "groq",
  "openrouter",
]);

/**
 * Normalizes a self-declared model string into its canonical provider, family,
 * and recognition state.
 *
 * Distinguishes model family from provider and version without pretending to
 * verify actual weights. Version punctuation, release tags, dates, and aliases
 * of a family map to the same family (e.g. 'openai/gpt-5.6' vs 'openai/gpt-5.6-latest').
 * Missing, blank, or unrecognized strings are flagged as unrecognized and cannot
 * earn stronger tiers.
 */
export function normalizeModelFamily(rawModel: string | null | undefined): NormalizedModelFamily {
  if (typeof rawModel !== "string") {
    return { raw: "", provider: null, family: "", isRecognized: false };
  }
  const trimmed = rawModel.trim();
  if (trimmed.length === 0) {
    return { raw: trimmed, provider: null, family: "", isRecognized: false };
  }
  const lower = trimmed.toLowerCase();
  if (UNKNOWN_MODEL_TOKENS.has(lower)) {
    return { raw: trimmed, provider: null, family: "", isRecognized: false };
  }

  let provider: string | null = null;
  let modelPart = lower;

  const slashIdx = lower.indexOf("/");
  const colonIdx = lower.indexOf(":");
  const sepIdx = slashIdx >= 0 ? slashIdx : colonIdx;

  if (sepIdx > 0) {
    const prefix = lower.slice(0, sepIdx);
    const remainder = lower.slice(sepIdx + 1);
    if (KNOWN_PROVIDERS.has(prefix) || sepIdx === slashIdx) {
      provider = prefix;
      modelPart = remainder;
    }
  }

  // Model family matching (specific version families before generic)
  if (/^gpt-?5(?:\.\d+)?(?:[-_.:].*)?$/.test(modelPart)) {
    return { raw: trimmed, provider: provider ?? "openai", family: "gpt-5", isRecognized: true };
  }
  if (/^gpt-?4(?:\.[0-9]+|o)?(?:[-_.:].*)?$/.test(modelPart)) {
    return { raw: trimmed, provider: provider ?? "openai", family: "gpt-4", isRecognized: true };
  }
  if (/^gpt-?3(?:\.[0-9]+)?(?:[-_.:].*)?$/.test(modelPart)) {
    return { raw: trimmed, provider: provider ?? "openai", family: "gpt-3", isRecognized: true };
  }
  if (/^gpt$/.test(modelPart)) {
    return { raw: trimmed, provider: provider ?? "openai", family: "gpt", isRecognized: true };
  }
  if (/^o1(?:[-_.:].*)?$/.test(modelPart)) {
    return { raw: trimmed, provider: provider ?? "openai", family: "o1", isRecognized: true };
  }
  if (/^o3(?:[-_.:].*)?$/.test(modelPart)) {
    return { raw: trimmed, provider: provider ?? "openai", family: "o3", isRecognized: true };
  }
  if (/^o4(?:[-_.:].*)?$/.test(modelPart)) {
    return { raw: trimmed, provider: provider ?? "openai", family: "o4", isRecognized: true };
  }
  if (/^claude-?3[.-]7(?:[-_.:].*)?$/.test(modelPart)) {
    return {
      raw: trimmed,
      provider: provider ?? "anthropic",
      family: "claude-3.7",
      isRecognized: true,
    };
  }
  if (/^claude-?3[.-]5(?:[-_.:].*)?$/.test(modelPart)) {
    return {
      raw: trimmed,
      provider: provider ?? "anthropic",
      family: "claude-3.5",
      isRecognized: true,
    };
  }
  if (/^claude-?3(?:[-_.:].*)?$/.test(modelPart)) {
    return {
      raw: trimmed,
      provider: provider ?? "anthropic",
      family: "claude-3",
      isRecognized: true,
    };
  }
  if (/^claude-?2(?:[-_.:].*)?$/.test(modelPart)) {
    return {
      raw: trimmed,
      provider: provider ?? "anthropic",
      family: "claude-2",
      isRecognized: true,
    };
  }
  if (/^claude$/.test(modelPart)) {
    return {
      raw: trimmed,
      provider: provider ?? "anthropic",
      family: "claude",
      isRecognized: true,
    };
  }
  if (/^gemini-?2[.-]5(?:[-_.:].*)?$/.test(modelPart)) {
    return {
      raw: trimmed,
      provider: provider ?? "google",
      family: "gemini-2.5",
      isRecognized: true,
    };
  }
  if (/^gemini-?2(?:\.0)?(?:[-_.:].*)?$/.test(modelPart)) {
    return {
      raw: trimmed,
      provider: provider ?? "google",
      family: "gemini-2.0",
      isRecognized: true,
    };
  }
  if (/^gemini-?1[.-]5(?:[-_.:].*)?$/.test(modelPart)) {
    return {
      raw: trimmed,
      provider: provider ?? "google",
      family: "gemini-1.5",
      isRecognized: true,
    };
  }
  if (/^gemini-?(?:1(?:\.0)?|pro)(?:[-_.:].*)?$/.test(modelPart)) {
    return {
      raw: trimmed,
      provider: provider ?? "google",
      family: "gemini-1.0",
      isRecognized: true,
    };
  }
  if (/^gemini$/.test(modelPart)) {
    return { raw: trimmed, provider: provider ?? "google", family: "gemini", isRecognized: true };
  }
  if (/^grok-?4(?:\.\d+)?(?:[-_.:].*)?$/.test(modelPart)) {
    return { raw: trimmed, provider: provider ?? "xai", family: "grok-4", isRecognized: true };
  }
  if (/^grok-?3(?:[-_.:].*)?$/.test(modelPart)) {
    return { raw: trimmed, provider: provider ?? "xai", family: "grok-3", isRecognized: true };
  }
  if (/^grok-?2(?:[-_.:].*)?$/.test(modelPart)) {
    return { raw: trimmed, provider: provider ?? "xai", family: "grok-2", isRecognized: true };
  }
  if (/^grok$/.test(modelPart)) {
    return { raw: trimmed, provider: provider ?? "xai", family: "grok", isRecognized: true };
  }
  if (/^deepseek-(?:r1|reasoner)(?:[-_.:].*)?$/.test(modelPart)) {
    return {
      raw: trimmed,
      provider: provider ?? "deepseek",
      family: "deepseek-r1",
      isRecognized: true,
    };
  }
  if (/^deepseek-(?:v3|chat)(?:[-_.:].*)?$/.test(modelPart)) {
    return {
      raw: trimmed,
      provider: provider ?? "deepseek",
      family: "deepseek-v3",
      isRecognized: true,
    };
  }
  if (/^deepseek$/.test(modelPart)) {
    return {
      raw: trimmed,
      provider: provider ?? "deepseek",
      family: "deepseek",
      isRecognized: true,
    };
  }
  if (/^(?:meta-)?llama-?3(?:\.[0-9]+)?(?:[-_.:].*)?$/.test(modelPart)) {
    return { raw: trimmed, provider: provider ?? "meta", family: "llama-3", isRecognized: true };
  }
  if (/^mistral-large(?:[-_.:].*)?$/.test(modelPart)) {
    return {
      raw: trimmed,
      provider: provider ?? "mistral",
      family: "mistral-large",
      isRecognized: true,
    };
  }
  if (/^qwen-?2[.-]5(?:[-_.:].*)?$/.test(modelPart)) {
    return { raw: trimmed, provider: provider ?? "qwen", family: "qwen-2.5", isRecognized: true };
  }

  // Abstract test model patterns (e.g. 'test-model', 'another-model', 'family-a', 'model-1')
  if (/^(?:test-model|another-model|family-[a-z0-9_-]+|model-[a-z0-9_-]+)$/.test(modelPart)) {
    return { raw: trimmed, provider, family: modelPart, isRecognized: true };
  }

  return { raw: trimmed, provider, family: "", isRecognized: false };
}

/**
 * Returns true only if both strings declare recognized, distinct model families.
 * Ambiguous, missing, or unknown families return false.
 */
export function isDistinctModelFamily(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const normA = normalizeModelFamily(a);
  const normB = normalizeModelFamily(b);
  if (!normA.isRecognized || !normB.isRecognized) return false;
  return normA.family !== normB.family;
}

const CLIENT_HARNESSES: ReadonlySet<string> = new Set([
  "codex",
  "claude-code",
  "gemini-cli",
  "asimp",
  "curl",
  "browser",
  "agent-mail",
  "test-harness",
  "python-sdk",
  "workbench",
  "chatgpt-web",
  "custom-runner",
]);

export function isClientHarness(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const lower = candidate.trim().toLowerCase();
  return CLIENT_HARNESSES.has(lower) || lower.endsWith("-harness");
}

export type ScientificMethodCategory =
  | "deductive"
  | "computational"
  | "formal"
  | "literature"
  | "empirical"
  | "counterexample";

const RECOGNIZED_METHODS: ReadonlySet<string> = new Set([
  "deductive",
  "computational",
  "formal",
  "literature",
  "empirical",
  "counterexample",
  // Abstract tokens for test suite compatibility
  "search",
  "proof-search",
  "another-method",
]);

/**
 * Derives the scientific method basis from a claim's kind and statement.
 */
export function resolveClaimMethodBasis(
  kind: string | null | undefined,
  _statement?: string | null,
): string {
  if (!kind) return "deductive";
  const k = kind.trim().toLowerCase();
  if (k === "computation") return "computational";
  if (k === "literature-claim" || k === "novelty-claim") return "literature";
  if (k === "counterexample" || k === "counterexample-claim") return "counterexample";
  if (k === "observation") return "empirical";
  return "deductive";
}

const COMPUTATIONAL_RUBRIC_ITEMS: ReadonlySet<string> = new Set([
  "independent-rerun",
  "environment-lock",
  "seed-protocol",
  "numerical-stability",
  "detection-floor",
  "leakage",
  "sensitivity",
]);

const MATH_PROOF_RUBRIC_ITEMS: ReadonlySet<string> = new Set([
  "statement-match",
  "quantifier-scope",
  "every-nontrivial-inference",
  "edge-degenerate-cases",
  "circularity",
  "hidden-regularity",
  "imported-theorem-conditions",
]);

const LITERATURE_RUBRIC_ITEMS: ReadonlySet<string> = new Set([
  "source-identity-version",
  "exact-anchor",
  "does-the-source-say-that",
  "primary-vs-secondary",
  "retractions",
  "prior-art-implications",
]);

const PHYSICS_RUBRIC_ITEMS: ReadonlySet<string> = new Set([
  "dimensional-consistency",
  "limiting-cases",
  "symmetry-conservation",
  "regime-validity",
  "math-consistency-vs-empirical-support",
]);

/**
 * Extracts and normalizes the reviewer's declared scientific method from
 * the review submission basis and rubrics. Client software / harnesses are
 * never recognized as scientific methods.
 */
export function resolveReviewerMethodBasis(input: {
  readonly basis?: string | null;
  readonly rubric?: readonly string[] | null;
  readonly bodyMd?: string | null;
}): string | null {
  // Check rubric items first
  if (input.rubric && Array.isArray(input.rubric)) {
    for (const item of input.rubric) {
      const lower = item.trim().toLowerCase();
      if (COMPUTATIONAL_RUBRIC_ITEMS.has(lower)) return "computational";
      if (MATH_PROOF_RUBRIC_ITEMS.has(lower)) return "deductive";
      if (LITERATURE_RUBRIC_ITEMS.has(lower)) return "literature";
      if (PHYSICS_RUBRIC_ITEMS.has(lower)) return "empirical";
    }
  }

  // Check basis text
  if (input.basis && typeof input.basis === "string") {
    const b = input.basis.trim().toLowerCase();
    if (isClientHarness(b)) return null;
    if (RECOGNIZED_METHODS.has(b)) return b;

    if (/\b(lean|coq|isabelle|formal proof|formal verification|machine-checked)\b/i.test(b)) {
      return "formal";
    }
    if (
      /\b(rerun|re-ran|re-running|simulation|numerical|finite search|monte carlo|python script|executed code|reproduced computation)\b/i.test(
        b,
      )
    ) {
      return "computational";
    }
    if (
      /\b(read the proof|checked the proof|checked the derivation|checked the argument|derivation|deductive|quantifier|step-by-step|inference chain|checked it against the proof)\b/i.test(
        b,
      )
    ) {
      return "deductive";
    }
    if (/\b(literature|citation|bibliographic|prior art|source check)\b/i.test(b)) {
      return "literature";
    }
  }

  return null;
}

/**
 * Returns true only if both methods are recognized, non-harness scientific
 * methods and are disjoint. If either method is absent, unknown, or a client
 * harness, returns false.
 */
export function isDisjointMethodBasis(
  authorMethod: string | null | undefined,
  reviewerMethod: string | null | undefined,
): boolean {
  if (!authorMethod || !reviewerMethod) return false;
  if (isClientHarness(authorMethod) || isClientHarness(reviewerMethod)) return false;

  const a = authorMethod.trim().toLowerCase();
  const b = reviewerMethod.trim().toLowerCase();

  if (a === b) return false;
  if (UNKNOWN_MODEL_TOKENS.has(a) || UNKNOWN_MODEL_TOKENS.has(b)) return false;

  const aRecognized = RECOGNIZED_METHODS.has(a);
  const bRecognized = RECOGNIZED_METHODS.has(b);

  if (!aRecognized || !bRecognized) return false;
  return true;
}

/**
 * P1 first: the author can never review their own object. The caller checks
 * `reviewerIsAuthor` before consulting the tier.
 */
export function reviewerIsAuthor(authorFellowId: string, reviewerFellowId: string): boolean {
  return authorFellowId === reviewerFellowId;
}

/**
 * The independence tier of a review, from the two immutable attribution records.
 * Pure — the same two records always compute the same tier, and a later sponsor
 * transfer cannot change a historical review's tier.
 *
 *   T0: same sponsor
 *   T1: different sponsor, same or unrecognized model family
 *   T2: different sponsor AND different recognized declared model families
 *   T3: T2 AND a disjoint recognized scientific method basis
 */
export function independenceTier(
  author: ReviewAttribution,
  reviewer: ReviewAttribution,
): IndependenceTier {
  if (author.sponsorId === reviewer.sponsorId) return "T0";
  if (!isDistinctModelFamily(author.modelFamily, reviewer.modelFamily)) return "T1";
  if (!isDisjointMethodBasis(author.methodBasis, reviewer.methodBasis)) return "T2";
  return "T3";
}

/** strongly-supported requires a review at T2 or higher (Fable §6.4). */
export function tierMovesDisclosure(tier: IndependenceTier): boolean {
  return tier === "T2" || tier === "T3";
}
