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
  | { readonly kind: "sponsor"; readonly sponsorId: string }
  | { readonly kind: "fellow"; readonly fellowId: string; readonly sponsorId: string };

export interface WorkshopOwnership {
  readonly fellowId: string;
  readonly sponsorId: string;
}

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

/** A workshop is visible to its owning Fellow and its sponsor, and to nobody else. */
export function principalMayReadWorkshop(
  principal: SplitPrincipal,
  ownership: WorkshopOwnership,
): boolean {
  return (
    (principal.kind === "sponsor" && principal.sponsorId === ownership.sponsorId) ||
    (principal.kind === "fellow" &&
      principal.fellowId === ownership.fellowId &&
      principal.sponsorId === ownership.sponsorId)
  );
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
  "isproved",
  "confidence",
  "certificate",
  "certification",
  "verified",
  "isverified",
  "claimstatus",
  "reviewstatus",
]);
const STATUS_FIELD = "status";
const STATUS_UPGRADES = new Set([
  "proved",
  "verified",
  "certified",
  "corroborated",
  "stronglysupported",
  "resolved",
]);

function normalizedControlKey(key: string): string {
  return key.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function normalizedStatusValue(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function containsAuthoritativeField(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsAuthoritativeField(item, seen));

  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = normalizedControlKey(key);
    if (AUTHORITATIVE_FIELDS.has(normalizedKey)) return true;
    if (
      normalizedKey === STATUS_FIELD &&
      typeof nested === "string" &&
      STATUS_UPGRADES.has(normalizedStatusValue(nested))
    ) {
      return true;
    }
    if (containsAuthoritativeField(nested, seen)) return true;
  }
  return false;
}

/**
 * A Fellow may submit a claim to the ledger but may not submit the ledger's
 * computed assessment of that claim.  This is intentionally structural: the
 * actual value is not examined or echoed.
 */
export function rejectAuthoritativeFields(
  candidate: Readonly<Record<string, unknown>>,
): SplitProblemRefusal | null {
  if (containsAuthoritativeField(candidate)) {
    return {
      status: 422,
      code: "SCHEMA_INVALID",
      rule: "P2/P4",
      fixHint:
        "Remove author-writable disposition, proof, confidence, certification, or status-upgrade fields; the ledger computes disposition after independent review.",
      nextAction: "remove_authoritative_fields",
    };
  }
  return null;
}

/**
 * Fable P11's canonical near-duplicate representation.  Mathematical spans
 * are delimited before whitespace collapsing, so `$x + y$` remains one token
 * rather than becoming indistinguishable punctuation in surrounding prose.
 */
const CONFUSABLE_WHITESPACE = /[\p{White_Space}\u200B\u2060\uFEFF]+/gu;
const MATH_SPAN = /\$\$([\s\S]*?)\$\$|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$([^$]*)\$/gu;

function normalizeWhitespace(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(CONFUSABLE_WHITESPACE, " ").trim();
}

/**
 * The delimiters are recognized before prose whitespace is collapsed.  Inline
 * `$…$`, display `$$…$$`, `\\(…\\)`, and `\\[…\\]` all become a protected
 * mathematical token with normalized interior spacing.
 */
export function normalizeClaimStatement(statement: string): string {
  return normalizeWhitespace(
    statement.replace(MATH_SPAN, (_whole, display, paren, bracket, inline) => {
      const interior = [display, paren, bracket, inline].find(
        (value): value is string => typeof value === "string",
      );
      return `\u0002${normalizeWhitespace(interior ?? "")}\u0003`;
    }),
  );
}

/** A Web Crypto SHA-256, available in Workers and Bun without a Node-only dependency. */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function normHash(statement: string): Promise<string> {
  return sha256Hex(normalizeClaimStatement(statement));
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
  "privateartifact",
  "private_artifact",
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
