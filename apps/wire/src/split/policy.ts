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
  return key
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

function normalizedStatusValue(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

function containsAuthoritativeField(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): boolean {
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
const CONFUSABLE_WHITESPACE_CHARACTER = /[\p{White_Space}\u200B\u2060\uFEFF]/u;
const EXPLICIT_MATH_SPAN = /\$\$([\s\S]*?)\$\$|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: C0/C1 controls must not survive into a public claim or impersonate private math-token delimiters.
const RAW_CONTROL = /[\u0000-\u001F\u007F-\u009F]/gu;
const CANONICAL_ESCAPE = "~";
const MATH_TOKEN_START = "\u0002";
const MATH_TOKEN_END = "\u0003";
const CURRENCY_LED_PROSE =
  /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?(?:\s?[a-z]{3})?(?:[),.;:!?…]|[-–—])\s*\p{L}{2}/u;
const EXPLICIT_CURRENCY_CONTEXT =
  /(?:^|[^\p{L}\p{N}_])(?:amounts?|budgets?|costs?|fees?|paid|pay|payments?|prices?|worth)(?:\s+(?:are|at|is|of|was|were))?\s*[:=]?\s*$/u;
const CURRENCY_CODE_LED_PROSE =
  /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?\s?[a-z]{3}(?:[),.;:!?…]|[-–—])\s*\p{L}{2}/u;

function collapseWhitespace(value: string): string {
  return value.replace(CONFUSABLE_WHITESPACE, " ").trim();
}

function prepareCanonicalInput(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(CANONICAL_ESCAPE, `${CANONICAL_ESCAPE}${CANONICAL_ESCAPE}`);
  return normalized.replace(RAW_CONTROL, (control) => {
    if (CONFUSABLE_WHITESPACE_CHARACTER.test(control)) return control;
    const codePoint = control.codePointAt(0);
    return `${CANONICAL_ESCAPE}c${(codePoint ?? 0).toString(16).padStart(2, "0")};`;
  });
}

function isEscapedDollar(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function canOpenInlineMath(value: string, index: number): boolean {
  const next = value[index + 1];
  return (
    next !== undefined &&
    next !== "$" &&
    !CONFUSABLE_WHITESPACE_CHARACTER.test(next) &&
    !isEscapedDollar(value, index)
  );
}

function canCloseInlineMath(value: string, index: number): boolean {
  const previous = value[index - 1];
  return (
    previous !== undefined &&
    previous !== "$" &&
    !CONFUSABLE_WHITESPACE_CHARACTER.test(previous) &&
    !isEscapedDollar(value, index)
  );
}

function inlineDollarPositions(value: string): readonly number[] {
  const positions: number[] = [];
  let index = 0;

  while (index < value.length) {
    if (value[index] === MATH_TOKEN_START) {
      const end = value.indexOf(MATH_TOKEN_END, index + 1);
      index = end === -1 ? index + 1 : end + 1;
      continue;
    }
    if (
      value[index] === "$" &&
      value[index - 1] !== "$" &&
      value[index + 1] !== "$" &&
      !isEscapedDollar(value, index)
    ) {
      positions.push(index);
    }
    index += 1;
  }

  return positions;
}

function currencyOpenerShouldYield(
  value: string,
  opener: number,
  nextOpener: number,
  hasLaterDollar: boolean,
): boolean {
  return (
    hasLaterDollar &&
    canOpenInlineMath(value, nextOpener) &&
    CURRENCY_LED_PROSE.test(value.slice(opener + 1, nextOpener)) &&
    (EXPLICIT_CURRENCY_CONTEXT.test(value.slice(Math.max(0, opener - 64), opener)) ||
      CURRENCY_CODE_LED_PROSE.test(value.slice(opener + 1, nextOpener)))
  );
}

/**
 * Tokenize single-dollar math without letting a currency dollar consume a
 * later real opener. If a dollar cannot close because whitespace precedes it
 * but can open, it supersedes the earlier unmatched opener. An ambidextrous
 * dollar also supersedes a numeric opener when the intervening text has an
 * unmistakable currency-then-prose boundary and another delimiter remains;
 * this keeps `$5$`, `$5+x$`, and numeric math outside currency context intact.
 * Each code unit is visited a bounded number of times; emitted slices cover
 * the input once.
 */
function tokenizeInlineMath(value: string): string {
  const output: string[] = [];
  let emittedThrough = 0;
  let opener = -1;
  const dollarPositions = inlineDollarPositions(value);

  for (const [positionIndex, index] of dollarPositions.entries()) {
    if (opener === -1) {
      if (canOpenInlineMath(value, index)) opener = index;
      continue;
    }

    if (canCloseInlineMath(value, index)) {
      if (
        currencyOpenerShouldYield(value, opener, index, positionIndex + 1 < dollarPositions.length)
      ) {
        opener = index;
        continue;
      }
      output.push(
        value.slice(emittedThrough, opener),
        MATH_TOKEN_START,
        collapseWhitespace(value.slice(opener + 1, index)),
        MATH_TOKEN_END,
      );
      emittedThrough = index + 1;
      opener = -1;
    } else if (canOpenInlineMath(value, index)) {
      opener = index;
    }
  }

  output.push(value.slice(emittedThrough));
  return output.join("");
}

/**
 * The delimiters are recognized before prose whitespace is collapsed.  Inline
 * `$…$`, display `$$…$$`, `\\(…\\)`, and `\\[…\\]` all become a protected
 * mathematical token with normalized interior spacing.
 */
export function normalizeClaimStatement(statement: string): string {
  const explicitMath = prepareCanonicalInput(statement).replace(
    EXPLICIT_MATH_SPAN,
    (_whole, display, paren, bracket) => {
      const interior = [display, paren, bracket].find(
        (value): value is string => typeof value === "string",
      );
      return `${MATH_TOKEN_START}${collapseWhitespace(interior ?? "")}${MATH_TOKEN_END}`;
    },
  );
  return collapseWhitespace(tokenizeInlineMath(explicitMath));
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
      if (FORBIDDEN_PUBLIC_KEYS.has(normalizedControlKey(key))) throw new SplitLeakError(key);
      visit(nested);
    }
  };

  visit(value);
}
