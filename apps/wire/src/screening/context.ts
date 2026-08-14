import type { ContextualPromotionCandidate, ContextualScreeningInput } from "./types";

/** The provider gets enough statement context to adjudicate scope, not an archive. */
export const MAX_CONTEXTUAL_PROBLEM_STATEMENT_BYTES = 4_096;
/** Promotion text is bounded independently so one field cannot consume the complete context budget. */
export const MAX_CONTEXTUAL_PROMOTION_BYTES = 4_096;
/** Select this newest prefix, then present it chronologically before the current promotion. */
export const MAX_CONTEXTUAL_PROMOTIONS = 6;
/** The complete raw provider payload remains bounded even when every field is individually valid. */
export const MAX_CONTEXTUAL_TOTAL_BYTES = 12_288;

export interface SameScopePromotionContext {
  readonly problem_id: string;
  readonly fellow_id: string;
  readonly public_seq: number;
  readonly promotion: ContextualPromotionCandidate;
}

export interface ContextualScreeningSource {
  readonly problem_id: string;
  readonly fellow_id: string;
  readonly server_owned_problem_statement: string;
  readonly current_promotion: ContextualPromotionCandidate;
  readonly recent_promotions: readonly SameScopePromotionContext[];
}

export class ContextualScreeningInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextualScreeningInputError";
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireBoundedText(
  value: unknown,
  maxBytes: number,
  label: string,
  nonEmpty = true,
): string {
  if (
    typeof value !== "string" ||
    (nonEmpty && value.length === 0) ||
    utf8Bytes(value) > maxBytes
  ) {
    throw new ContextualScreeningInputError(
      `${label} is absent or exceeds its bounded context limit.`,
    );
  }
  return value;
}

function requireScopeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
    throw new ContextualScreeningInputError(`${label} is malformed.`);
  }
  return value;
}

function candidateFrom(value: unknown): ContextualPromotionCandidate {
  if (!isRecord(value) || Object.keys(value).length !== 4) {
    throw new ContextualScreeningInputError(
      "current promotion must contain exactly its outward fields.",
    );
  }
  const keys = ["title", "extract", "statement", "public_artifact_md"] as const;
  if (keys.some((key) => !Object.hasOwn(value, key))) {
    throw new ContextualScreeningInputError(
      "current promotion must contain exactly its outward fields.",
    );
  }
  return {
    // Empty public fields remain explicit in the provider payload; omission is
    // not an acceptable way to save context budget.
    title: requireBoundedText(
      value.title,
      MAX_CONTEXTUAL_PROMOTION_BYTES,
      "promotion title",
      false,
    ),
    extract: requireBoundedText(
      value.extract,
      MAX_CONTEXTUAL_PROMOTION_BYTES,
      "promotion extract",
      false,
    ),
    statement: requireBoundedText(
      value.statement,
      MAX_CONTEXTUAL_PROMOTION_BYTES,
      "promotion statement",
      false,
    ),
    public_artifact_md: requireBoundedText(
      value.public_artifact_md,
      MAX_CONTEXTUAL_PROMOTION_BYTES,
      "promotion public artifact",
      false,
    ),
  };
}

function totalInputBytes(input: ContextualScreeningInput): number {
  const candidateBytes = (candidate: ContextualPromotionCandidate): number =>
    utf8Bytes(candidate.title) +
    utf8Bytes(candidate.extract) +
    utf8Bytes(candidate.statement) +
    utf8Bytes(candidate.public_artifact_md);
  return (
    utf8Bytes(input.problem_statement) +
    candidateBytes(input.current_promotion) +
    input.recent_same_fellow_promotions.reduce(
      (total, promotion) => total + candidateBytes(promotion),
      0,
    )
  );
}

/**
 * Recheck the provider payload at its boundary. Most callers use
 * `buildContextualScreeningInput`, but this guard prevents an alternate route
 * from bypassing the text and item budgets later.
 */
export function assertContextualScreeningInput(
  input: unknown,
): asserts input is ContextualScreeningInput {
  if (!isRecord(input) || !Array.isArray(input.recent_same_fellow_promotions)) {
    throw new ContextualScreeningInputError("contextual screening input has an invalid shape.");
  }
  const problemStatement = requireBoundedText(
    input.problem_statement,
    MAX_CONTEXTUAL_PROBLEM_STATEMENT_BYTES,
    "server-owned problem statement",
  );
  const candidate = candidateFrom(input.current_promotion);
  if (input.recent_same_fellow_promotions.length > MAX_CONTEXTUAL_PROMOTIONS) {
    throw new ContextualScreeningInputError("recent promotions exceed the bounded context limit.");
  }
  for (const promotion of input.recent_same_fellow_promotions) {
    candidateFrom(promotion);
  }
  const normalized: ContextualScreeningInput = {
    problem_statement: problemStatement,
    current_promotion: candidate,
    recent_same_fellow_promotions: input.recent_same_fellow_promotions,
  };
  if (totalInputBytes(normalized) > MAX_CONTEXTUAL_TOTAL_BYTES) {
    throw new ContextualScreeningInputError(
      "contextual screening input exceeds the aggregate byte budget.",
    );
  }
}

/**
 * Construct exactly the context an ingest screen may receive. The source rows
 * are scope-checked before ordering, so a caller cannot accidentally turn a
 * same-Fellow history lookup into cross-Fellow or cross-problem context.
 */
export function buildContextualScreeningInput(source: unknown): ContextualScreeningInput {
  if (!isRecord(source) || !Array.isArray(source.recent_promotions)) {
    throw new ContextualScreeningInputError("contextual screening source has an invalid shape.");
  }
  const problemId = requireScopeId(source.problem_id, "problem id");
  const fellowId = requireScopeId(source.fellow_id, "fellow id");
  const problemStatement = requireBoundedText(
    source.server_owned_problem_statement,
    MAX_CONTEXTUAL_PROBLEM_STATEMENT_BYTES,
    "server-owned problem statement",
  );
  const currentPromotion = candidateFrom(source.current_promotion);
  const recent = source.recent_promotions.map((promotion) => {
    if (!isRecord(promotion)) {
      throw new ContextualScreeningInputError("recent promotion has an invalid shape.");
    }
    if (promotion.problem_id !== problemId || promotion.fellow_id !== fellowId) {
      throw new ContextualScreeningInputError(
        "contextual screening accepts promotions from the current Fellow and problem only.",
      );
    }
    const publicSeq = promotion.public_seq;
    if (typeof publicSeq !== "number" || !Number.isSafeInteger(publicSeq) || publicSeq < 1) {
      throw new ContextualScreeningInputError("recent promotion sequence is malformed.");
    }
    const promotionCandidate = candidateFrom(promotion.promotion);
    return {
      public_seq: publicSeq,
      promotion: promotionCandidate,
    };
  });
  if (new Set(recent.map((promotion) => promotion.public_seq)).size !== recent.length) {
    throw new ContextualScreeningInputError("recent promotion sequences must be unique.");
  }
  // Select the newest N to bound assembly history, then present that retained
  // window oldest-to-newest so the provider sees a coherent trajectory ending
  // in the current proposed promotion.
  const chronologicalRecent = recent
    .sort((left, right) => right.public_seq - left.public_seq)
    .slice(0, MAX_CONTEXTUAL_PROMOTIONS)
    .sort((left, right) => left.public_seq - right.public_seq);
  const input = {
    problem_statement: problemStatement,
    current_promotion: currentPromotion,
    recent_same_fellow_promotions: chronologicalRecent.map((promotion) => promotion.promotion),
  };
  assertContextualScreeningInput(input);
  return input;
}

/** Stable safe binding for a decision record; it never returns its raw source. */
export async function contextualScreeningInputDigest(
  input: ContextualScreeningInput,
): Promise<string> {
  assertContextualScreeningInput(input);
  const encoded = new TextEncoder().encode(JSON.stringify(input));
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  return `sha256:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
