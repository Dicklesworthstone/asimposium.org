export class OAuthDryCheckFailure extends Error {
  /**
   * Field *names* only, and only ever names this module already expects to
   * reason about. A value from the response never reaches this property, so a
   * dry check that arrives carrying a client secret cannot log one.
   */
  declare readonly unexpected_fields?: readonly string[];
  /** The true number of offending fields, which is always safe to state. */
  declare readonly unexpected_field_count?: number;

  constructor(
    readonly code: string,
    unexpectedFields?: readonly string[],
    unexpectedFieldCount?: number,
  ) {
    super(code);
    this.name = "OAuthDryCheckFailure";
    // Left genuinely absent when there is nothing to report, rather than present
    // and undefined: a serialized diagnostic should not carry an empty field that
    // looks like a redaction.
    if (unexpectedFields !== undefined) this.unexpected_fields = unexpectedFields;
    if (unexpectedFieldCount !== undefined) this.unexpected_field_count = unexpectedFieldCount;
  }
}

interface OAuthDryCheckResponse {
  readonly environment?: unknown;
  readonly provider?: unknown;
  readonly scopes?: unknown;
  readonly redirect_uris?: unknown;
}

/**
 * The exact and only shape this dry check accepts. A closed set, because the
 * payload describes an OAuth client: anything the endpoint volunteers beyond
 * these four fields is either a contract drift or credential material that has
 * no business travelling, and both are safer refused than parsed around.
 */
const EXPECTED_FIELDS = ["environment", "provider", "redirect_uris", "scopes"] as const;
const CANONICAL_GOOGLE_CALLBACK = "https://asimposium.org/api/auth/callback/google";

/**
 * The one label an unexpected field name collapses to. A fixed constant, never
 * derived from input.
 *
 * An earlier revision tried to classify names and print the boring ones. That is
 * a losing game: a property name is attacker-controlled, and any pattern list is
 * a bypass puzzle — `sk_live_51h8xyz…`, `xoxb_1234567890_abcdefgh` and a bare
 * high-entropy run like `a1b2c3d4e5f6a7b8c9d0e1f2` are all lowercase snake_case
 * and all sail past a heuristic while carrying the entire secret in the key.
 *
 * So no unexpected name is ever printed. The diagnostic keeps what is fixed and
 * coarse — this category plus a true count — which is enough to tell contract
 * drift from a clean payload, and cannot leak whatever the endpoint volunteered.
 * The *missing*-field diagnostic still names fields, because those names come
 * from `EXPECTED_FIELDS` in this file rather than from the payload.
 */
const REDACTED_FIELD_NAME = "<redacted-field-name>";

function hasExactStringSet(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  const seen = new Set<string>();
  for (const member of value) {
    // Do not coerce a nested array/object through `join()` or `toString()`.
    // The server response is untrusted until every scope is a direct primitive.
    if (typeof member !== "string" || !expected.includes(member)) return false;
    seen.add(member);
  }
  return seen.size === expected.length;
}

/**
 * The transport is staging, but this response attests production OAuth client
 * configuration only. It does not contact or mutate a cloud console.
 */
export function assertProductionOAuthDryCheck(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OAuthDryCheckFailure("OAUTH_DRY_CHECK_INVALID_RESPONSE");
  }
  // Exact and closed, checked before any field is read: an unexpected field is
  // refused whether or not the expected ones would have passed, so a payload
  // carrying a secret never reaches the value-level checks below.
  const keys = Object.keys(value as Record<string, unknown>);
  const expected = new Set<string>(EXPECTED_FIELDS);
  const unexpected = keys.filter((key) => !expected.has(key));
  if (unexpected.length > 0) {
    // Count and category only. The names never leave this function.
    throw new OAuthDryCheckFailure(
      "OAUTH_DRY_CHECK_UNEXPECTED_FIELDS",
      [REDACTED_FIELD_NAME],
      unexpected.length,
    );
  }
  // Missing names come from `EXPECTED_FIELDS`, not from the payload, so they are
  // safe by construction and need no classification.
  const missing = EXPECTED_FIELDS.filter((field) => !keys.includes(field));
  if (missing.length > 0) {
    throw new OAuthDryCheckFailure(
      "OAUTH_DRY_CHECK_FIELDS_MISSING",
      [...missing].sort(),
      missing.length,
    );
  }
  const response = value as OAuthDryCheckResponse;
  if (response.environment !== "production") {
    throw new OAuthDryCheckFailure("OAUTH_DRY_CHECK_ENVIRONMENT_MISMATCH");
  }
  if (response.provider !== "google") {
    throw new OAuthDryCheckFailure("OAUTH_DRY_CHECK_PROVIDER_MISMATCH");
  }
  if (!hasExactStringSet(response.scopes, ["email", "openid", "profile"])) {
    throw new OAuthDryCheckFailure("OAUTH_DRY_CHECK_SCOPE_MISMATCH");
  }
  if (!Array.isArray(response.redirect_uris) || response.redirect_uris.length !== 1) {
    throw new OAuthDryCheckFailure("OAUTH_DRY_CHECK_REDIRECT_MISSING");
  }
  const [redirect] = response.redirect_uris;
  // Exact source-text comparison is intentional: URL normalization would erase
  // an explicitly supplied default port and turn a non-canonical callback into
  // a passing one. No query, fragment, userinfo, alternate host, port, or path
  // is part of the production OAuth registration contract.
  if (typeof redirect !== "string" || redirect !== CANONICAL_GOOGLE_CALLBACK) {
    throw new OAuthDryCheckFailure("OAUTH_DRY_CHECK_REDIRECT_INVALID");
  }
}
