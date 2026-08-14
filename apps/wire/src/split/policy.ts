/**
 * Pure policy for the workshop/ledger split (Fable §6.3, §7.1, §7.4, ADR-12).
 *
 * This module deliberately has no Worker, D1, R2, or router imports.  It is
 * usable by every future surface, while `service.ts` supplies the transaction
 * boundary that Krater must implement.  In particular, a caller cannot turn a
 * private object into a public response by choosing a different route class.
 */

export type SplitPrincipal =
  | { readonly kind: "anonymous" }
  | { readonly kind: "sponsor"; readonly sponsorId: string };

export interface PrivateNotFound {
  readonly status: 404;
  readonly code: "NOT_FOUND";
  /** Private misses never enter a shared cache. */
  readonly cacheControl: "no-store";
}

/**
 * Private reads intentionally use one response for absent, anonymous, and
 * cross-sponsor objects.  Do not add an existence or authorization field: it
 * becomes an oracle for workshop membership and object IDs.
 */
export function privateNotFound(): PrivateNotFound {
  return { status: 404, code: "NOT_FOUND", cacheControl: "no-store" };
}

export function sponsorMayReadWorkshop(principal: SplitPrincipal, sponsorId: string): boolean {
  return principal.kind === "sponsor" && principal.sponsorId === sponsorId;
}

export interface SplitProblemRefusal {
  readonly status: 409 | 422;
  readonly code: "DUPLICATE_CLAIM" | "SCHEMA_INVALID";
  readonly rule: "P11" | "P2/P4";
  readonly fixHint: string;
  readonly nextAction: "review_or_refine" | "remove_authoritative_fields";
  /** Present only for P11, where Fable requires the existing public ID. */
  readonly existingId?: string;
}

const AUTHORITATIVE_FIELDS = new Set([
  "disposition",
  "proved",
  "confidence",
  "certificate",
  "certification",
  "verified",
]);

/**
 * A Fellow may submit a claim to the ledger but may not submit the ledger's
 * computed assessment of that claim.  This is intentionally structural: the
 * actual value is not examined or echoed.
 */
export function rejectAuthoritativeFields(
  candidate: Readonly<Record<string, unknown>>,
): SplitProblemRefusal | null {
  for (const key of AUTHORITATIVE_FIELDS) {
    if (Object.hasOwn(candidate, key)) {
      return {
        status: 422,
        code: "SCHEMA_INVALID",
        rule: "P2/P4",
        fixHint:
          "Remove author-writable disposition, proof, confidence, or certification fields; the ledger computes disposition after independent review.",
        nextAction: "remove_authoritative_fields",
      };
    }
  }
  return null;
}

/**
 * Fable P11's canonical near-duplicate representation.  Mathematical spans
 * are delimited before whitespace collapsing, so `$x + y$` remains one token
 * rather than becoming indistinguishable punctuation in surrounding prose.
 */
export function normalizeClaimStatement(statement: string): string {
  const normalized = statement.normalize("NFKC").toLowerCase();
  const tokenizedMath = normalized.replace(/\$([^$]*)\$/gu, (_whole, inner: string) => {
    return `\u0002${inner.trim().replace(/\s+/gu, " ")}\u0003`;
  });
  return tokenizedMath.replace(/\s+/gu, " ").trim();
}

/** A Web Crypto SHA-256, available in Workers and Bun without a Node-only dependency. */
export async function normHash(statement: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeClaimStatement(statement));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function duplicateClaimRefusal(existingId: string): SplitProblemRefusal {
  return {
    status: 409,
    code: "DUPLICATE_CLAIM",
    rule: "P11",
    existingId,
    fixHint: "Review the existing claim or refine the statement so its scope differs materially.",
    nextAction: "review_or_refine",
  };
}

/**
 * A last-line invariant on every public projection.  It is not a serializer:
 * it rejects accidental attempts to pass workshop-shaped data into a public
 * face.  Tests plant a `workshop_seq` key to prove the guard detects the
 * defect rather than merely documenting it.
 */
const FORBIDDEN_PUBLIC_KEYS = new Set([
  "workshopseq",
  "workshop_seq",
  "sponsorid",
  "sponsor_id",
  "privateartifactdigest",
  "private_artifact_digest",
  "body",
  "bodymd",
  "body_md",
  "workshop",
]);

export class SplitLeakError extends Error {
  readonly code = "SPLIT_LEAK_DETECTED";

  constructor(key: string) {
    super(`public split projection contains forbidden private field: ${key}`);
    this.name = "SplitLeakError";
  }
}

export function assertPublicProjectionSafe(value: unknown): void {
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;

    for (const [key, nested] of Object.entries(candidate)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key.toLowerCase())) throw new SplitLeakError(key);
      visit(nested);
    }
  };

  visit(value);
}
