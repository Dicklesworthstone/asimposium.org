import { z } from "zod";

/**
 * Propylon enrollment contracts (Fable §5.2, §5.5, and ADR-20).
 *
 * The public enrollment ID is deliberately path-safe for
 * `/join/ASIMP-EN-<id>`. Enrollment secrets, flow handles, and Fellow tokens
 * are supplied only in JSON POST bodies: none may enter a path or query.
 */

export const ENROLLMENT_ID_PREFIX = "ASIMP-EN-";
export const ENROLLMENT_SECRET_VERSION = "v1";
export const ENROLLMENT_SECRET_BYTES = 32;
export const ENROLLMENT_SECRET_TTL_MS = 30 * 60 * 1000;
export const PENDING_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

const BASE64URL_256_BIT = "[A-Za-z0-9_-]{43}";

/**
 * One spelling of the enrollment id body, shared by `EnrollmentIdSchema` and
 * the join-URL pattern. Two copies could drift, and a join URL that accepted an
 * id the id schema rejected is precisely the incoherence the mint response's
 * cross-field check exists to catch.
 */
const ENROLLMENT_ID_BODY = `${ENROLLMENT_ID_PREFIX}[A-HJKMNP-TV-Z0-9]{10,32}`;

/**
 * The closed set of Stoa origins an enrollment URL may name.
 *
 * An enrollment URL is credential-carrying infrastructure: a join URL points a
 * Fellow at whatever origin it names, and a `hello_url` is the first thing an
 * approved agent fetches with its bearer token. The origin therefore may never
 * be derived from the request — `Host`, `X-Forwarded-Host` and friends are
 * caller-supplied, and a Worker that echoed one would hand an attacker a
 * credential redirector. AGENTS.md teaches agents exactly one origin; this is
 * the enumeration of the environments that origin is allowed to be.
 *
 * Loopback is explicit rather than a wildcard so a misconfigured deployment
 * cannot quietly downgrade to plaintext against a remote host.
 */
export const PRODUCTION_STOA_ORIGIN = "https://a.asimposium.org";
export const STAGING_STOA_ORIGIN = "https://a-staging.asimposium.org";

const LOOPBACK_STOA_ORIGIN = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;

/**
 * The origin domain must be closed under the URL builders.
 *
 * `stoaHelloUrl` and `stoaJoinUrl` concatenate a trusted origin with a fixed
 * path, and `StoaHelloUrlSchema` / `StoaJoinUrlSchema` require their input to
 * be byte-canonical. So any origin this predicate accepts but `URL` rewrites
 * produces builder output its own schema rejects. `http://127.0.0.1:80` was
 * exactly that: the port passes every range check, but `URL` drops a default
 * port, so a mint could durably issue an enrollment and then fail validating
 * the response it had already committed. Requiring the origin to survive the
 * same round trip closes the domain instead of patching the one port.
 */
function isCanonicalOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/** True only for the two deployed origins or an exact loopback origin with a valid port. */
export function isTrustedStoaOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === PRODUCTION_STOA_ORIGIN || value === STAGING_STOA_ORIGIN) return true;
  const loopback = LOOPBACK_STOA_ORIGIN.exec(value);
  if (loopback === null) return false;
  const digits = loopback[1];
  if (digits === undefined) return false;
  const port = Number(digits);
  // `String(port) === digits` rejects a leading zero, which `Number` would
  // otherwise accept and silently normalise into a different origin string.
  if (!(Number.isInteger(port) && port >= 1 && port <= 65_535 && String(port) === digits)) {
    return false;
  }
  return isCanonicalOrigin(value);
}

/**
 * The same domain, written so it survives into the published JSON Schema.
 *
 * `refine()` is invisible to `toJSONSchema`, so the generated artifacts
 * described `origin`, `hello_url` and `join_url` as bare strings. An external
 * validator holding our own published schema would have accepted
 * `https://evil.test/join/…` — the artifact overstated what the contract
 * accepts, which is worse than having no artifact.
 *
 * These patterns are layered *before* the predicates, never instead of them, so
 * runtime behaviour is unchanged: a value must satisfy both. The port
 * alternation encodes 1–65535 with no leading zero and no `80`, which is
 * exactly what `isTrustedStoaOrigin` accepts after the canonical round trip.
 * That equivalence is asserted over a corpus in `stoa-origin.test.ts` rather
 * than merely claimed here.
 */
const LOOPBACK_PORT_PATTERN =
  "(?:[1-9]|[1-7][0-9]|8[1-9]|9[0-9]|[1-9][0-9]{2,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])";

const literalForPattern = (value: string): string => value.replaceAll(".", "\\.");

const TRUSTED_ORIGIN_ALTERNATION = `(?:${literalForPattern(PRODUCTION_STOA_ORIGIN)}|${literalForPattern(STAGING_STOA_ORIGIN)}|http://127\\.0\\.0\\.1:${LOOPBACK_PORT_PATTERN})`;

/** JSON-Schema-visible spellings of the three credential-carrying URL shapes. */
export const STOA_ORIGIN_PATTERN = `^${TRUSTED_ORIGIN_ALTERNATION}$`;

export const StoaOriginSchema = z
  .string()
  .regex(new RegExp(STOA_ORIGIN_PATTERN))
  .refine(isTrustedStoaOrigin, "origin is not a trusted Stoa origin");

/**
 * The Agora (human plane) origin, enumerated per environment — the apex twin of
 * the Stoa rules above (Fable ADR-2, ADR-6; the device-code flow is §5.3).
 *
 * Fable writes the sponsor's destination as the *path* `/approve`, never as an
 * absolute URL, so which origin that path hangs off is a per-environment
 * configuration fact rather than a protocol constant. Enumerating it here is
 * what will let a staging Stoa send a sponsor to a staging Agora instead of
 * handing them the production apex mid-enrollment, which would move a human
 * across planes without saying so.
 *
 * These constants designate the allowed spellings and do not establish DNS,
 * certificate, deployment, or any other provider state.
 *
 * Loopback is deliberately absent, unlike the Stoa set. The accepted topology
 * for this work names exactly two Agora origins; inventing a third for local
 * development would be a design decision this vocabulary has no mandate to make,
 * and a silent one is worse than an explicit gap.
 *
 * Nothing consumes these yet. They are published so the per-environment binding
 * can be reviewed on its own, before anything changes what a deployment emits.
 */
export const PRODUCTION_AGORA_ORIGIN = "https://asimposium.org";
export const STAGING_AGORA_ORIGIN = "https://staging.asimposium.org";

/** True only for the two designated per-environment Agora origins, byte-canonically spelled. */
export function isTrustedAgoraOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value !== PRODUCTION_AGORA_ORIGIN && value !== STAGING_AGORA_ORIGIN) return false;
  // The same round trip the Stoa predicate uses. Both constants already satisfy
  // it, so this cannot reject either today; it is here so that editing one into
  // a non-canonical spelling fails closed instead of quietly widening what the
  // builder below will emit.
  return isCanonicalOrigin(value);
}

const TRUSTED_AGORA_ORIGIN_ALTERNATION = `(?:${literalForPattern(PRODUCTION_AGORA_ORIGIN)}|${literalForPattern(STAGING_AGORA_ORIGIN)})`;

/** JSON-Schema-visible spelling of the trusted Agora origin set. */
export const AGORA_ORIGIN_PATTERN = `^${TRUSTED_AGORA_ORIGIN_ALTERNATION}$`;

export const AgoraOriginSchema = z
  .string()
  .regex(new RegExp(AGORA_ORIGIN_PATTERN))
  .refine(isTrustedAgoraOrigin, "origin is not a trusted Agora origin");

/** The one path a sponsor is sent to, relative to the deployment's own Agora origin. */
export const AGORA_APPROVE_PATH = "/approve";

/**
 * Build the sponsor's approval URL for a configured origin.
 *
 * A builder rather than a template, for the same reason `stoaHelloUrl` is one:
 * it refuses an untrusted origin and emits exactly one path. The approval URL is
 * read and followed by a human, so it carries no credentials, query, or
 * fragment — the `user_code` is typed into the page, never carried in the link.
 */
export function agoraApproveUrl(origin: string): string {
  if (!isTrustedAgoraOrigin(origin)) {
    throw new TypeError("approve url requires a trusted Agora origin");
  }
  return `${origin}${AGORA_APPROVE_PATH}`;
}

/** Byte-canonical, trusted-origin, credential-free — the Agora twin of `parseStoaUrl`. */
function parseAgoraUrl(value: string): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.href !== value) return undefined;
  if (!isTrustedAgoraOrigin(parsed.origin)) return undefined;
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "") return undefined;
  return parsed;
}

export const AGORA_APPROVE_URL_PATTERN = `^${TRUSTED_AGORA_ORIGIN_ALTERNATION}${AGORA_APPROVE_PATH}$`;

/** Exactly `<trusted Agora origin>/approve`; no credentials, query, or fragment. */
export const AgoraApproveUrlSchema = z
  .string()
  .max(400)
  .regex(new RegExp(AGORA_APPROVE_URL_PATTERN))
  .refine((value) => {
    const parsed = parseAgoraUrl(value);
    return parsed !== undefined && parsed.pathname === AGORA_APPROVE_PATH && parsed.hash === "";
  }, "invalid Agora approve url");

/** The one path an approved agent is sent to, relative to its configured origin. */
export const STOA_HELLO_PATH = "/v1/hello";

/**
 * Build the `hello_url` for a configured origin.
 *
 * Deliberately a builder rather than a template: it refuses an untrusted
 * origin, emits exactly one path, and carries no credentials, query, or
 * fragment. A `hello_url` that grew a query string would put agent-followed
 * state into a URL, and one that grew a fragment would look like the join URL,
 * whose fragment *is* a secret.
 */
export function stoaHelloUrl(origin: string): string {
  if (!isTrustedStoaOrigin(origin)) {
    throw new TypeError("hello url requires a trusted Stoa origin");
  }
  return `${origin}${STOA_HELLO_PATH}`;
}

/**
 * Shared shape rules: byte-canonical spelling, trusted origin, no credentials,
 * no query string.
 *
 * The canonicality check is load-bearing, not tidiness. `new URL()` normalizes
 * before it reports: it lowercases the host, drops a default `:443`, and
 * rewrites `:08787` to `:8787`. Validating only `parsed.origin` would therefore
 * accept `https://A.ASIMPOSIUM.ORG/v1/hello`, `https://a.asimposium.org:443/…`
 * and `http://127.0.0.1:08787/…` — spellings `StoaOriginSchema` refuses
 * outright, and which every comment here promises are exact.
 *
 * That mismatch is not cosmetic: these URLs are compared as strings (the mint
 * response cross-checks its own fields against the join URL) and are copied by
 * humans. Two accepted spellings of "the same" URL mean a coherence check can
 * pass on one and fail on the other. Requiring `parsed.href === value` is the
 * smallest rule that closes it for these fixed ASCII paths, because a
 * canonical input is exactly the input `URL` round-trips unchanged.
 */
function parseStoaUrl(value: string): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.href !== value) return undefined;
  if (!isTrustedStoaOrigin(parsed.origin)) return undefined;
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "") return undefined;
  return parsed;
}

export const STOA_HELLO_URL_PATTERN = `^${TRUSTED_ORIGIN_ALTERNATION}${STOA_HELLO_PATH}$`;

/** Exactly `<trusted origin>/v1/hello`; no credentials, query, or fragment. */
export const StoaHelloUrlSchema = z
  .string()
  .max(400)
  .regex(new RegExp(STOA_HELLO_URL_PATTERN))
  .refine((value) => {
    const parsed = parseStoaUrl(value);
    return parsed !== undefined && parsed.pathname === STOA_HELLO_PATH && parsed.hash === "";
  }, "invalid Stoa hello url");

export interface ParsedStoaJoinUrl {
  readonly origin: string;
  readonly enrollmentId: string;
  readonly secret: string;
}

/**
 * Parse `<trusted origin>/join/<enrollment id>#<secret>` — exactly that.
 *
 * The fragment is mandatory, not merely permitted: a join URL without its
 * one-time secret is not a weaker join URL, it is a different object that
 * cannot enroll anything, and emitting one would send a sponsor to a dead
 * page while the secret leaked somewhere else. Both the path segment and the
 * fragment are validated against their own contracts, and the path must be
 * exactly two segments so `/join/<id>/extra` cannot ride along.
 */
export function parseStoaJoinUrl(value: string): ParsedStoaJoinUrl | undefined {
  const parsed = parseStoaUrl(value);
  if (parsed === undefined) return undefined;
  const segments = parsed.pathname.split("/");
  if (segments.length !== 3 || segments[0] !== "" || segments[1] !== "join") return undefined;
  const enrollmentId = segments[2];
  if (enrollmentId === undefined || !EnrollmentIdSchema.safeParse(enrollmentId).success) {
    return undefined;
  }
  // An absent fragment leaves `hash` empty, which is exactly the case a
  // `startsWith` check would have waved through.
  if (!parsed.hash.startsWith("#")) return undefined;
  const secret = parsed.hash.slice(1);
  if (!EnrollmentSecretSchema.safeParse(secret).success) return undefined;
  return { origin: parsed.origin, enrollmentId, secret };
}

export const STOA_JOIN_URL_PATTERN = `^${TRUSTED_ORIGIN_ALTERNATION}/join/${ENROLLMENT_ID_BODY}#${ENROLLMENT_SECRET_VERSION}\\.${BASE64URL_256_BIT}$`;

export const StoaJoinUrlSchema = z
  .string()
  .max(400)
  .regex(new RegExp(STOA_JOIN_URL_PATTERN))
  .refine((value) => parseStoaJoinUrl(value) !== undefined, "invalid Stoa join url");

/**
 * Build the join URL for a configured origin.
 *
 * Every input is re-validated rather than trusted: the origin because it must
 * never come from a request, and the id/secret because a builder that
 * concatenated an unvalidated secret would be the one place a malformed
 * credential could still reach a sponsor's screen.
 */
export function stoaJoinUrl(origin: string, enrollmentId: string, secret: string): string {
  if (!isTrustedStoaOrigin(origin)) {
    throw new TypeError("join url requires a trusted Stoa origin");
  }
  if (!EnrollmentIdSchema.safeParse(enrollmentId).success) {
    throw new TypeError("join url requires a valid enrollment id");
  }
  if (!EnrollmentSecretSchema.safeParse(secret).success) {
    throw new TypeError("join url requires a valid enrollment secret");
  }
  return `${origin}/join/${enrollmentId}#${secret}`;
}

export const EnrollmentIdSchema = z
  .string()
  .regex(new RegExp(`^${ENROLLMENT_ID_BODY}$`), "invalid enrollment id");

/** A versioned, 32-byte base64url secret. It may only be sent in a POST body. */
export const EnrollmentSecretSchema = z
  .string()
  .regex(
    new RegExp(`^${ENROLLMENT_SECRET_VERSION}\\.${BASE64URL_256_BIT}$`),
    "invalid enrollment secret",
  );

/** Opaque body-only polling credential for the RFC 8628-style approval flow. */
export const EnrollmentFlowHandleSchema = z
  .string()
  .regex(
    new RegExp(`^flow_${ENROLLMENT_SECRET_VERSION}\\.${BASE64URL_256_BIT}$`),
    "invalid enrollment flow handle",
  );

export const FellowTokenSchema = z
  .string()
  .regex(
    new RegExp(`^asimp_ag_[0-9A-HJKMNP-TV-Z]{26}_${BASE64URL_256_BIT}$`),
    "invalid Fellow token",
  );

export const FellowLifecycleStatusSchema = z.enum([
  "pending",
  "active",
  "paused",
  "revoked",
  "archived",
  "compromised",
  "suspicious_review",
]);

/** Append-only lifecycle event identity returned to the owning sponsor. */
export const FellowLifecycleEventIdSchema = z
  .string()
  .regex(/^LEV-[0-9A-HJKMNP-TV-Z]{26}$/, "invalid lifecycle event id");

export const FellowCredentialProfileSchema = z.enum(["bearer", "dpop", "http-message-signature"]);

/** A Fellow name is the compact public identifier defined by Fable §5.4. */
export const FellowNameSchema = z.string().regex(/^[a-z][a-z0-9-]{2,31}$/, "invalid Fellow name");

export const RequestedScopeSchema = z.enum([
  "promote",
  "review",
  "propose-problems",
  "upload-artifacts",
]);

export const EnrollmentProblemBindingSchema = z
  .string()
  .regex(/^P-[A-Z0-9]{4,26}$/, "invalid problem binding");

// These values cross SQLite's text functions in migration and trigger proofs.
// SQLite length/substr stop at U+0000 while JavaScript strings do not, so NUL
// must be excluded at the shared contract rather than accepted with divergent
// length semantics across the two runtimes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: U+0000 is the exact cross-runtime hazard excluded here.
const EnrollmentSqlTextSchema = z.string().regex(/^[^\u0000]*$/, "must not contain NUL");
/** Durable identity accepts every retained 0011-valid Fellow row. */
export const FellowIdSchema = EnrollmentSqlTextSchema.min(1).max(80);
/** Non-secret credential row identity. This is never the bearer or its hash. */
export const FellowCredentialIdSchema = EnrollmentSqlTextSchema.min(1).max(160);
export const EnrollmentDeclaredRuntimeSchema = EnrollmentSqlTextSchema.trim().min(1).max(160);
/** Opaque Google-subject-derived principal used for both sponsor and operator records. */
export const SponsorIdSchema = EnrollmentSqlTextSchema.regex(
  /^usr_[A-Za-z0-9_-]{1,60}$/,
  "invalid sponsor id",
);

/** Sponsor inventory pages are deliberately bounded even when its history is not. */
export const SPONSOR_FELLOW_PAGE_SIZE = 500;
/** A path segment, including its version prefix, must stay cheaply parseable. */
export const SPONSOR_FELLOW_CURSOR_MAX_LENGTH = 512;

/** The durable key immediately after a sponsor Fellow page. */
export const SponsorFellowCursorKeySchema = z
  .object({
    granted_at: z.number().int().safe().positive(),
    fellow_id: FellowIdSchema,
  })
  .strict();

const SPONSOR_FELLOW_CURSOR_PREFIX = "f1.";
const SPONSOR_FELLOW_CURSOR_FRAME_PREFIX = "v1|";
const cursorEncoder = new TextEncoder();
const cursorDecoder = new TextDecoder("utf-8", { fatal: true });

function cursorBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function cursorBase64UrlBytes(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const base64 = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(
      (4 - (value.length % 4)) % 4,
    )}`;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function equalCursorBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function readCursorField(
  bytes: Uint8Array,
  offset: number,
): { readonly value: Uint8Array; readonly offset: number } | undefined {
  const colon = bytes.indexOf(0x3a, offset);
  if (colon <= offset) return undefined;
  let lengthText: string;
  try {
    lengthText = cursorDecoder.decode(bytes.slice(offset, colon));
  } catch {
    return undefined;
  }
  if (!/^[1-9][0-9]{0,2}$/.test(lengthText)) return undefined;
  const length = Number(lengthText);
  const start = colon + 1;
  const end = start + length;
  if (end > bytes.length) return undefined;
  return { value: bytes.slice(start, end), offset: end };
}

function cursorFrame(key: SponsorFellowCursorKey): Uint8Array {
  const grantedAt = String(key.granted_at);
  const fellowId = cursorEncoder.encode(key.fellow_id);
  return cursorEncoder.encode(
    `${SPONSOR_FELLOW_CURSOR_FRAME_PREFIX}${grantedAt.length}:${grantedAt}|${fellowId.length}:${key.fellow_id}`,
  );
}

/**
 * Versioned, length-prefixed and byte-canonical page cursor. It is an opaque
 * transport token, not an authority token: the sponsor predicate independently
 * scopes every lookup, so no MAC or server-side cursor state is necessary.
 */
export function encodeSponsorFellowCursor(key: SponsorFellowCursorKey): string {
  const parsed = SponsorFellowCursorKeySchema.parse(key);
  return `${SPONSOR_FELLOW_CURSOR_PREFIX}${cursorBase64Url(cursorFrame(parsed))}`;
}

/** Return the cursor key only for one exact, canonical cursor spelling. */
export function parseSponsorFellowCursor(value: unknown): SponsorFellowCursorKey | undefined {
  if (
    typeof value !== "string" ||
    value.length > SPONSOR_FELLOW_CURSOR_MAX_LENGTH ||
    !value.startsWith(SPONSOR_FELLOW_CURSOR_PREFIX)
  ) {
    return undefined;
  }
  const encoded = value.slice(SPONSOR_FELLOW_CURSOR_PREFIX.length);
  const bytes = cursorBase64UrlBytes(encoded);
  if (bytes === undefined) return undefined;
  const prefix = cursorEncoder.encode(SPONSOR_FELLOW_CURSOR_FRAME_PREFIX);
  if (!equalCursorBytes(bytes.slice(0, prefix.length), prefix)) return undefined;
  const grantedAtField = readCursorField(bytes, prefix.length);
  if (grantedAtField === undefined || bytes[grantedAtField.offset] !== 0x7c) return undefined;
  const fellowIdField = readCursorField(bytes, grantedAtField.offset + 1);
  if (fellowIdField === undefined || fellowIdField.offset !== bytes.length) return undefined;
  let grantedAtText: string;
  let fellowId: string;
  try {
    grantedAtText = cursorDecoder.decode(grantedAtField.value);
    fellowId = cursorDecoder.decode(fellowIdField.value);
  } catch {
    return undefined;
  }
  if (!/^[1-9][0-9]{0,15}$/.test(grantedAtText)) return undefined;
  const parsed = SponsorFellowCursorKeySchema.safeParse({
    granted_at: Number(grantedAtText),
    fellow_id: fellowId,
  });
  if (!parsed.success || String(parsed.data.granted_at) !== grantedAtText) return undefined;
  return encodeSponsorFellowCursor(parsed.data) === value ? parsed.data : undefined;
}

/**
 * JSON Schema can describe this cursor's bounded transport spelling, but it
 * cannot close the decoded length-prefixed frame without a custom vocabulary.
 * The generated face therefore names that intentionally broader boundary; the
 * runtime parser below remains the authority for path acceptance.
 */
const SPONSOR_FELLOW_CURSOR_SCHEMA_DESCRIPTION =
  "Bounded f1 base64url transport spelling. This JSON Schema is a deliberate superset: runtime additionally requires a canonical UTF-8 v1 length-prefixed granted_at/fellow_id frame.";

export const SponsorFellowCursorSchema = z
  .string()
  .max(SPONSOR_FELLOW_CURSOR_MAX_LENGTH)
  .regex(/^f1\.[A-Za-z0-9_-]+$/)
  .describe(SPONSOR_FELLOW_CURSOR_SCHEMA_DESCRIPTION)
  .refine(
    (value) => parseSponsorFellowCursor(value) !== undefined,
    "must be a canonical Fellow cursor",
  );

/** Operator audit pages are deliberately smaller than inventory pages. */
export const OPERATOR_FELLOW_CAP_AUDIT_PAGE_SIZE = 100;
/** Bounded path transport for one immutable per-sponsor audit sequence. */
export const OPERATOR_FELLOW_CAP_AUDIT_CURSOR_MAX_LENGTH = 128;

/** The unique immutable key immediately after an operator audit page. */
export const OperatorFellowCapAuditCursorKeySchema = z
  .object({ sponsor_seq: z.number().int().safe().positive() })
  .strict();

const OPERATOR_FELLOW_CAP_AUDIT_CURSOR_PREFIX = "oc1.";
const OPERATOR_FELLOW_CAP_AUDIT_CURSOR_FRAME_PREFIX = "v1|";

function operatorFellowCapAuditCursorFrame(key: OperatorFellowCapAuditCursorKey): Uint8Array {
  const sponsorSeq = String(key.sponsor_seq);
  return cursorEncoder.encode(
    `${OPERATOR_FELLOW_CAP_AUDIT_CURSOR_FRAME_PREFIX}${sponsorSeq.length}:${sponsorSeq}`,
  );
}

/** Encode the exact keyset boundary for a descending per-sponsor audit page. */
export function encodeOperatorFellowCapAuditCursor(key: OperatorFellowCapAuditCursorKey): string {
  const parsed = OperatorFellowCapAuditCursorKeySchema.parse(key);
  return `${OPERATOR_FELLOW_CAP_AUDIT_CURSOR_PREFIX}${cursorBase64Url(
    operatorFellowCapAuditCursorFrame(parsed),
  )}`;
}

/** Parse only one byte-canonical operator Fellow-cap audit cursor spelling. */
export function parseOperatorFellowCapAuditCursor(
  value: unknown,
): OperatorFellowCapAuditCursorKey | undefined {
  if (
    typeof value !== "string" ||
    value.length > OPERATOR_FELLOW_CAP_AUDIT_CURSOR_MAX_LENGTH ||
    !value.startsWith(OPERATOR_FELLOW_CAP_AUDIT_CURSOR_PREFIX)
  ) {
    return undefined;
  }
  const bytes = cursorBase64UrlBytes(value.slice(OPERATOR_FELLOW_CAP_AUDIT_CURSOR_PREFIX.length));
  if (bytes === undefined) return undefined;
  const prefix = cursorEncoder.encode(OPERATOR_FELLOW_CAP_AUDIT_CURSOR_FRAME_PREFIX);
  if (!equalCursorBytes(bytes.slice(0, prefix.length), prefix)) return undefined;
  const sponsorSeqField = readCursorField(bytes, prefix.length);
  if (sponsorSeqField === undefined || sponsorSeqField.offset !== bytes.length) return undefined;
  let sponsorSeqText: string;
  try {
    sponsorSeqText = cursorDecoder.decode(sponsorSeqField.value);
  } catch {
    return undefined;
  }
  if (!/^[1-9][0-9]{0,15}$/.test(sponsorSeqText)) return undefined;
  const parsed = OperatorFellowCapAuditCursorKeySchema.safeParse({
    sponsor_seq: Number(sponsorSeqText),
  });
  if (!parsed.success || String(parsed.data.sponsor_seq) !== sponsorSeqText) return undefined;
  return encodeOperatorFellowCapAuditCursor(parsed.data) === value ? parsed.data : undefined;
}

const OPERATOR_FELLOW_CAP_AUDIT_CURSOR_SCHEMA_DESCRIPTION =
  "Bounded oc1 base64url transport spelling. Runtime additionally requires a canonical UTF-8 v1 length-prefixed sponsor_seq frame.";

export const OperatorFellowCapAuditCursorSchema = z
  .string()
  .max(OPERATOR_FELLOW_CAP_AUDIT_CURSOR_MAX_LENGTH)
  .regex(/^oc1\.[A-Za-z0-9_-]+$/)
  .describe(OPERATOR_FELLOW_CAP_AUDIT_CURSOR_SCHEMA_DESCRIPTION)
  .refine(
    (value) => parseOperatorFellowCapAuditCursor(value) !== undefined,
    "must be a canonical operator Fellow-cap audit cursor",
  );

export const EnrollmentFirstDirectiveSchema = EnrollmentSqlTextSchema.trim().min(1).max(2_000);
export const EnrollmentEventBudgetSchema = z.number().int().min(1).max(10_000);
export const EnrollmentArtifactBudgetBytesSchema = z.number().int().min(0).max(1_073_741_824);
export const EnrollmentFellowGrantExpirySchema = z.number().int().positive().max(31_536_000_000);

/**
 * Credential and harness fields are parsed before a requested name is
 * classified. It is intentionally permissive about `name` and extra fields so
 * a caller with a valid body-only credential can receive a teachable name
 * policy response; the complete request below remains strict for the write.
 */
export const FellowRegistrationCredentialFieldsSchema = z
  .object({
    enrollment_id: EnrollmentIdSchema,
    secret: EnrollmentSecretSchema,
    model: EnrollmentDeclaredRuntimeSchema,
    harness: EnrollmentDeclaredRuntimeSchema,
    reasoning_effort: z.string().trim().min(1).max(80).optional(),
    tools_note: z.string().trim().min(1).max(1_000).optional(),
  })
  .passthrough();

export const FellowRegistrationRequestSchema = z
  .object({
    enrollment_id: EnrollmentIdSchema,
    secret: EnrollmentSecretSchema,
    name: FellowNameSchema,
    model: EnrollmentDeclaredRuntimeSchema,
    harness: EnrollmentDeclaredRuntimeSchema,
    reasoning_effort: z.string().trim().min(1).max(80).optional(),
    tools_note: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

export const EnrollmentProposalStatusSchema = z.enum([
  "pending",
  "approved",
  "reduced",
  "denied",
  "expired",
]);

export const EnrollmentResourceGrantsSchema = z
  .object({
    problem_binding: EnrollmentProblemBindingSchema.optional(),
    first_directive: EnrollmentFirstDirectiveSchema.optional(),
    event_budget: EnrollmentEventBudgetSchema.optional(),
    artifact_budget_bytes: EnrollmentArtifactBudgetBytesSchema.optional(),
    fellow_grant_expires_at: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Sponsor-facing state, including the decision outcome. `null` means that no
 * grant was made (pending, denied, or expired); this prevents a stale requested
 * grant from being mistaken for a live authorization.
 */
export const EnrollmentApprovalCardSchema = z
  .object({
    enrollment_id: EnrollmentIdSchema,
    proposal_id: z.string().min(1).max(80),
    status: EnrollmentProposalStatusSchema,
    name: FellowNameSchema,
    model: EnrollmentDeclaredRuntimeSchema,
    harness: EnrollmentDeclaredRuntimeSchema,
    reasoning_effort: z.string().min(1).max(80).optional(),
    tools_note: z.string().min(1).max(1_000).optional(),
    requested_scopes: z.array(RequestedScopeSchema).min(1).max(4),
    requested_resources: EnrollmentResourceGrantsSchema,
    effective_granted_scopes: z.array(RequestedScopeSchema).min(1).max(4).nullable(),
    effective_granted_resources: EnrollmentResourceGrantsSchema.nullable(),
    proposal_expires_at: z.number().int().positive(),
  })
  .strict();

/** Public, credential-free instructions carried by every enrollment capsule face. */
export const EnrollmentCapsuleGuidanceSchema = z
  .object({
    conduct_floor: z.array(z.string().min(1).max(280)).length(5),
    inoculation_digest: z.array(z.string().min(1).max(500)).length(3),
    naming_law: z
      .object({
        pattern: z.literal("^[a-z][a-z0-9-]{2,31}$"),
        description: z.string().min(1).max(500),
      })
      .strict(),
    fragment_rule: z.string().min(1).max(500),
    registration_example: z
      .object({
        enrollment_id: EnrollmentIdSchema,
        secret: EnrollmentSecretSchema,
        name: FellowNameSchema,
        model: EnrollmentDeclaredRuntimeSchema,
        harness: EnrollmentDeclaredRuntimeSchema,
      })
      .strict(),
    registration_example_notice: z.string().min(1).max(500),
    flow_poll: z
      .object({
        method: z.literal("POST"),
        path: z.literal("/v1/fellows/flow"),
        body_field: z.literal("flow_handle"),
        value_source: z.literal("claim response body"),
        pending_status: z.literal("authorization_pending"),
        retry_field: z.literal("retry_after_seconds"),
        idempotency: z.literal(
          "send one stable Idempotency-Key per enrollment; the same key replays the approval body within 24 hours",
        ),
      })
      .strict(),
    post_approval_actions: z
      .array(
        z
          .object({ order: z.number().int().min(1).max(3), action: z.string().min(1).max(500) })
          .strict(),
      )
      .length(3),
  })
  .strict();

/** Canonical agent projection of a path-only enrollment capsule. */
export const EnrollmentCapsuleProjectionSchema = z
  .object({
    // `schema` is an identifier and `origin` is a destination. The identifier
    // stays canonical in every environment so a document validates against one
    // published schema; the destination is the configured plane, because the
    // capsule's curl blocks are executable and a staging capsule that named
    // production would send a real enrollment secret to the wrong plane.
    // Parsing it here means an untrusted origin cannot reach any face: the
    // projection refuses to construct before Markdown, JSON, or HTML renders.
    schema: z.literal("https://a.asimposium.org/schemas/enrollment-capsule.v1.json"),
    origin: StoaOriginSchema,
    enrollment_id: EnrollmentIdSchema,
    secret_expires_at: z.number().int().positive(),
    claim: z
      .object({
        method: z.literal("POST"),
        path: z.literal("/v1/fellows"),
        secret_transport: z.literal("JSON request body only"),
      })
      .strict(),
    guidance: EnrollmentCapsuleGuidanceSchema,
  })
  .strict();

export const EnrollmentClaimResponseSchema = z
  .object({ flow_handle: EnrollmentFlowHandleSchema })
  .strict();

/** A server-authored next action. Agents follow these; bodies never author them. */
export const EnrollmentNextActionSchema = z
  .object({
    action: z.string().min(1).max(80),
    url: z.string().min(1).max(400),
    reason: z.string().min(1).max(280),
  })
  .strict();

/**
 * W3.5 device flow: a human-typed code. Eight characters from an alphabet
 * without 0/1/I/O confusion, grouped 4-4. Brute force is bounded by the
 * lookup lockout, not by entropy alone.
 */
export const DEVICE_USER_CODE_PATTERN =
  /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}$/;

/**
 * The device-code request carries the FULL proposal (name, declared runtime,
 * scopes) because the sponsor's approval card must show exactly what a
 * path-1 mint shows; a metadata-free code would gut ADR-20's card guarantee.
 */
export const DeviceCodeStartRequestSchema = z
  .object({
    name: FellowNameSchema,
    model: EnrollmentDeclaredRuntimeSchema,
    harness: EnrollmentDeclaredRuntimeSchema,
    reasoning_effort: z.string().trim().min(1).max(80).optional(),
    tools_note: z.string().trim().min(1).max(1_000).optional(),
    requested_scopes: z.array(RequestedScopeSchema).min(1).max(4),
  })
  .strict();

export const DeviceCodeStartResponseSchema = z
  .object({
    device_code: EnrollmentFlowHandleSchema,
    user_code: z.string().regex(DEVICE_USER_CODE_PATTERN),
    verification_url: z.literal("https://asimposium.org/approve"),
    interval_seconds: z.number().int().positive().max(60),
    expires_in_seconds: z.number().int().positive().max(3_600),
  })
  .strict();

/** Sponsor-side: find the pending device proposal by its human code. */
export const DeviceLookupRequestSchema = z
  .object({
    user_code: z.string().regex(DEVICE_USER_CODE_PATTERN),
  })
  .strict();

/** The lookup answer is the same approval card the console already renders. */
export const DeviceLookupResponseSchema = z
  .object({
    card: EnrollmentApprovalCardSchema,
  })
  .strict();

export const EnrollmentHelloResponseSchema = z
  .object({
    fellow: z
      .object({
        fellow_id: z.string().min(1).max(80),
        name: FellowNameSchema,
        model: EnrollmentDeclaredRuntimeSchema,
        harness: EnrollmentDeclaredRuntimeSchema,
      })
      .strict(),
    granted_scopes: z.array(RequestedScopeSchema).min(1).max(4),
    granted_resources: EnrollmentResourceGrantsSchema,
    next_actions: z.array(EnrollmentNextActionSchema).max(8),
  })
  .strict();

/** Sponsor-mint configuration; the proposal cannot request a broader grant. */
export const MintEnrollmentRequestSchema = z
  .object({
    requested_scopes: z.array(RequestedScopeSchema).min(1).max(4),
    replaces_enrollment_id: EnrollmentIdSchema.optional(),
    problem_binding: EnrollmentProblemBindingSchema.optional(),
    first_directive: EnrollmentFirstDirectiveSchema.optional(),
    event_budget: EnrollmentEventBudgetSchema.optional(),
    artifact_budget_bytes: EnrollmentArtifactBudgetBytesSchema.optional(),
    fellow_grant_expires_in_ms: EnrollmentFellowGrantExpirySchema.optional(),
    expires_in_ms: z.number().int().positive().max(ENROLLMENT_SECRET_TTL_MS).optional(),
  })
  .strict();

/**
 * A sponsor may only make a pending proposal narrower. `null` means remove a
 * problem assignment or first directive; arbitrary replacement is not a
 * reduction and is therefore not a valid reduction payload.
 */
export const EnrollmentGrantReductionSchema = z
  .object({
    scopes: z.array(RequestedScopeSchema).min(1).max(4).optional(),
    problem_binding: z.null().optional(),
    first_directive: z.null().optional(),
    event_budget: EnrollmentEventBudgetSchema.optional(),
    artifact_budget_bytes: EnrollmentArtifactBudgetBytesSchema.optional(),
    fellow_grant_expires_in_ms: EnrollmentFellowGrantExpirySchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "a reduction must narrow at least one grant");

/**
 * A sponsor decision names the enrollment it decides.
 *
 * The service envelope signs the request body digest and the route *template*
 * (`/v1/enrollments/:enrollmentId/decision`), never the filled path, so the
 * concrete target is not otherwise covered by the signature. Carrying the
 * target inside the signed body makes an approve for one proposal unusable
 * against another: the Worker refuses unless this field equals the path
 * parameter. Sponsor isolation answers *whose* enrollment; this answers
 * *which* (ADR-20).
 */
const SponsorEnrollmentApproveSchema = z
  .object({ enrollment_id: EnrollmentIdSchema, decision: z.literal("approve") })
  .strict();
const SponsorEnrollmentReduceSchema = z
  .object({
    enrollment_id: EnrollmentIdSchema,
    decision: z.literal("reduce"),
    reduction: EnrollmentGrantReductionSchema,
  })
  .strict();
const SponsorEnrollmentDenySchema = z
  .object({ enrollment_id: EnrollmentIdSchema, decision: z.literal("deny") })
  .strict();

export const SponsorEnrollmentDecisionSchema = z.discriminatedUnion("decision", [
  SponsorEnrollmentApproveSchema,
  SponsorEnrollmentReduceSchema,
  SponsorEnrollmentDenySchema,
]);

/**
 * The signed Agora-to-Stoa command adds server-stamped interactive-auth
 * evidence to the stable sponsor intent. The Worker validates this timestamp;
 * it is deliberately excluded from the product idempotency digest so that a
 * committed response remains recoverable after the freshness window and an
 * unchanged intent can be retried after reauthentication.
 */
export const SponsorEnrollmentDecisionCommandSchema = z.discriminatedUnion("decision", [
  SponsorEnrollmentApproveSchema.extend({
    step_up_authenticated_at: z.number().int().nonnegative(),
  }).strict(),
  SponsorEnrollmentReduceSchema.extend({
    step_up_authenticated_at: z.number().int().nonnegative(),
  }).strict(),
  SponsorEnrollmentDenySchema.extend({
    step_up_authenticated_at: z.number().int().nonnegative(),
  }).strict(),
]);

/**
 * Shown exactly once to the sponsor at mint time. `join_url` carries the
 * fragment secret, so this body is credential material: it travels over TLS to
 * the authenticated sponsor and is never logged on either plane.
 */
export const MintEnrollmentResponseSchema = z
  .object({
    enrollment_id: EnrollmentIdSchema,
    join_url: StoaJoinUrlSchema,
    secret: EnrollmentSecretSchema,
    expires_at: z.number().int().positive(),
  })
  .strict()
  // A mint response that names one enrollment and links another is one
  // document lying: the sponsor copies the URL, not the fields beside it.
  .superRefine((value, ctx) => {
    const parsed = parseStoaJoinUrl(value.join_url);
    if (parsed === undefined) return;
    if (parsed.enrollmentId !== value.enrollment_id) {
      ctx.addIssue({
        code: "custom",
        path: ["join_url"],
        message: "join_url enrollment id does not match enrollment_id",
      });
    }
    if (parsed.secret !== value.secret) {
      ctx.addIssue({
        code: "custom",
        path: ["join_url"],
        message: "join_url fragment does not match secret",
      });
    }
  })
  // An explicit boundary rather than a silent one. The patterns above make the
  // *shape* of `join_url` checkable anywhere, but no standard JSON Schema
  // keyword can say that the id and secret embedded in that URL are the same
  // ones in the sibling fields — and that is the check the whole document
  // exists for. Rather than let the artifact imply equivalence it does not
  // have, the artifact says what it cannot verify.
  .describe(
    "Structural validation only. JSON Schema cannot express that join_url embeds exactly this enrollment_id and this secret; that cross-field equality is enforced at runtime by MintEnrollmentResponseSchema in @asimposium/contracts and is NOT represented in this artifact. A validator that accepts this document has not checked it. Consumers that cannot run the Zod contract should re-derive the URL with stoaJoinUrl(origin, enrollment_id, secret) and compare, rather than trusting join_url.",
  );

/** Pending proposals awaiting the sponsor's decision, oldest first. */
export const SponsorProposalListResponseSchema = z
  .object({
    proposals: z.array(EnrollmentApprovalCardSchema).max(100),
  })
  .strict();

/** Non-secret hygiene for one currently live credential record. */
export const SponsorCredentialSummarySchema = z
  .object({
    credential_id: z.string().min(1).max(160),
    profile: FellowCredentialProfileSchema,
    issued_at: z.number().int().nonnegative(),
    expires_at: z.number().int().positive(),
    last_used_at: z.number().int().nonnegative().nullable(),
    active: z.boolean(),
  })
  .strict();

/** A Fellow as the sponsor console lists it. No token and no token hash. */
export const SponsorFellowSummarySchema = z
  .object({
    fellow_id: FellowIdSchema,
    name: FellowNameSchema,
    model: EnrollmentDeclaredRuntimeSchema,
    harness: EnrollmentDeclaredRuntimeSchema,
    status: FellowLifecycleStatusSchema,
    granted_scopes: z.array(RequestedScopeSchema).min(1).max(4),
    granted_resources: EnrollmentResourceGrantsSchema,
    granted_at: z.number().int().positive(),
    // Current inventory, not history. The max-three policy keeps this bounded;
    // expired, individually revoked and pre-panic rows are audit history.
    credentials: z.array(SponsorCredentialSummarySchema).max(3),
  })
  .strict();

export const SponsorFellowListResponseSchema = z
  .object({
    fellows: z.array(SponsorFellowSummarySchema).max(SPONSOR_FELLOW_PAGE_SIZE),
    next_cursor: SponsorFellowCursorSchema.nullable(),
  })
  .strict();

/** Individually revoke one non-secret credential identity owned by a Fellow. */
export const SponsorCredentialRevokeRequestSchema = z
  .object({
    fellow_id: FellowIdSchema,
    credential_id: FellowCredentialIdSchema,
    confirm: z.literal("revoke-credential"),
    step_up_authenticated_at: z.number().int().nonnegative(),
  })
  .strict();

export const SponsorCredentialRevokeResponseSchema = z
  .object({
    acknowledged: z.literal(true),
    event_id: FellowLifecycleEventIdSchema,
    fellow_id: FellowIdSchema,
    credential_id: FellowCredentialIdSchema,
    sponsor_seq: z.number().int().positive(),
    effective_at: z.number().int().positive(),
  })
  .strict();

/**
 * Sponsor-controlled Fellow posture. `pending` is protocol-internal and can
 * become active only through approval; it is intentionally absent here.
 */
export const SponsorFellowLifecycleTargetSchema = z.enum([
  "active",
  "paused",
  "revoked",
  "archived",
  "compromised",
  "suspicious_review",
]);

export const SponsorFellowLifecycleRequestSchema = z
  .object({
    fellow_id: FellowIdSchema,
    status: SponsorFellowLifecycleTargetSchema,
    confirm: z.literal("change-fellow-lifecycle"),
    step_up_authenticated_at: z.number().int().nonnegative(),
  })
  .strict();

export const SponsorFellowLifecycleResponseSchema = z
  .object({
    acknowledged: z.literal(true),
    event_id: FellowLifecycleEventIdSchema,
    fellow_id: FellowIdSchema,
    status: SponsorFellowLifecycleTargetSchema,
    sponsor_seq: z.number().int().positive(),
    effective_at: z.number().int().positive(),
  })
  .strict();

/** The explicit destructive confirmation required by the sponsor panic button. */
export const SponsorPanicRequestSchema = z
  .object({
    confirm: z.literal("revoke-all-fellow-credentials"),
    step_up_authenticated_at: z.number().int().nonnegative(),
  })
  .strict();

export const SponsorPanicResponseSchema = z
  .object({
    acknowledged: z.literal(true),
    event_id: FellowLifecycleEventIdSchema,
    sponsor_seq: z.number().int().positive(),
    effective_at: z.number().int().positive(),
  })
  .strict();

/** An immutable audit identity for an operator's sponsor-cap decision. */
export const OperatorFellowCapAuditEventIdSchema = z
  .string()
  .regex(/^OFC-[0-9A-HJKMNP-TV-Z]{26}$/, "invalid operator Fellow-cap audit event id");

/** Public key id that signed the audited Agora-to-Worker authorization. */
export const OperatorFellowCapSignerKidSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, "invalid operator Fellow-cap signer key id");

/**
 * Raw JSON-schema parity for the durable reason. The wire form is already
 * normalized: it contains exactly 10 through 1,000 Unicode code points and
 * has no ECMAScript-whitespace endpoint. SQLite enforces the identical
 * immutable-audit rule without relying on a lossy trim transform.
 */
// In Unicode mode the surrogate class below matches only *lone* UTF-16
// surrogates; a valid astral pair is one scalar and does not match it. Keep
// this in the emitted pattern so JSON Schema rejects an intent D1 cannot bind
// without replacement before it reaches its immutable receipt.
const OPERATOR_FELLOW_CAP_REASON_PATTERN = /^(?![\s\S]*[\uD800-\uDFFF])(?=\S)(?:[\s\S]){9,999}\S$/u;

/**
 * Operator-only per-sponsor capacity command. The reason is durable audit
 * material, so it is bounded, non-empty, and cannot contain SQLite's NUL
 * boundary. `step_up_authenticated_at` is stamped by Agora, not trusted from
 * a browser request.
 */
export const OperatorFellowCapOverrideRequestSchema = z
  .object({
    sponsor_id: SponsorIdSchema,
    /** Both facts form the CAS precondition; either alone permits an ABA overwrite. */
    expected_active_fellow_limit: z.number().int().min(5).max(500),
    expected_sponsor_seq: z.number().int().nonnegative(),
    active_fellow_limit: z.number().int().min(5).max(500),
    // JavaScript string min/max count UTF-16 code units while SQLite length()
    // counts Unicode code points. This Unicode-mode expression makes the Zod
    // acceptance rule match the immutable-audit CHECK exactly, including astral
    // characters; it also survives into the generated schema as a pattern.
    // JSON Schema and runtime validate the exact same untrimmed bytes. This
    // avoids a browser-valid whitespace spelling that would later become a
    // distinct immutable audit receipt after a hidden server transform.
    reason: EnrollmentSqlTextSchema.regex(OPERATOR_FELLOW_CAP_REASON_PATTERN),
    confirm: z.literal("override-fellow-cap"),
    step_up_authenticated_at: z.number().int().nonnegative(),
  })
  .strict();

export const OperatorFellowCapOverrideResponseSchema = z
  .object({
    acknowledged: z.literal(true),
    audit_event_id: OperatorFellowCapAuditEventIdSchema,
    sponsor_id: SponsorIdSchema,
    /** Dedicated monotonic sequence for the sponsor Fellow-cap audit scope. */
    sponsor_seq: z.number().int().positive(),
    previous_active_fellow_limit: z.number().int().min(5).max(500),
    active_fellow_limit: z.number().int().min(5).max(500),
    /** Durable authorization evidence, retained in the immutable audit row. */
    step_up_authenticated_at: z.number().int().nonnegative(),
    signer_kid: OperatorFellowCapSignerKidSchema,
    effective_at: z.number().int().positive(),
  })
  .strict();

/** Authenticated operator read used to obtain the exact next CAS precondition. */
export const OperatorFellowCapStateResponseSchema = z
  .object({
    sponsor_id: SponsorIdSchema,
    active_fellow_limit: z.number().int().min(5).max(500),
    sponsor_seq: z.number().int().nonnegative(),
  })
  .strict();

/** One immutable operator Fellow-cap authorization receipt. */
export const OperatorFellowCapAuditEventSchema = z
  .object({
    audit_event_id: OperatorFellowCapAuditEventIdSchema,
    sponsor_id: SponsorIdSchema,
    operator_id: SponsorIdSchema,
    sponsor_seq: z.number().int().positive(),
    previous_active_fellow_limit: z.number().int().min(5).max(500),
    active_fellow_limit: z.number().int().min(5).max(500),
    reason: EnrollmentSqlTextSchema.regex(OPERATOR_FELLOW_CAP_REASON_PATTERN),
    step_up_authenticated_at: z.number().int().nonnegative(),
    signer_kid: OperatorFellowCapSignerKidSchema,
    effective_at: z.number().int().positive(),
  })
  .strict();

/** Operator-only immutable audit history, ordered newest sequence first. */
export const OperatorFellowCapAuditPageResponseSchema = z
  .object({
    audit_events: z
      .array(OperatorFellowCapAuditEventSchema)
      .max(OPERATOR_FELLOW_CAP_AUDIT_PAGE_SIZE),
    next_cursor: OperatorFellowCapAuditCursorSchema.nullable(),
  })
  .strict();

/**
 * Decision acknowledgement. Carries no proposal state: the card changed under
 * the decision, and a fresh proposal list is how the console sees it.
 */
export const SponsorEnrollmentDecisionResponseSchema = z
  .object({ acknowledged: z.literal(true) })
  .strict();

/** Sponsor bootstrap has no caller-controlled fields, but it is still an exact JSON write. */
export const SponsorBootstrapRequestSchema = z.object({}).strict();

/**
 * Sponsor bootstrap (W3.1): first contact through the Worker creates the
 * sponsor row; later calls only move last_seen_at. `created` reports which
 * happened so the console and the audit log can tell them apart.
 */
export const SponsorBootstrapResponseSchema = z
  .object({
    sponsor_id: z.string().min(1).max(80),
    created: z.boolean(),
    bootstrapped_at: z.number().int().positive(),
  })
  .strict();

/** The only flow-polling input. A proposal id is intentionally absent. */
export const EnrollmentFlowPollRequestSchema = z
  .object({ flow_handle: EnrollmentFlowHandleSchema })
  .strict();

export const EnrollmentPendingResponseSchema = z
  .object({
    status: z.literal("authorization_pending"),
    retry_after_seconds: z.number().int().positive(),
  })
  .strict();

export const EnrollmentDeniedResponseSchema = z
  .object({ status: z.literal("access_denied") })
  .strict();

export const EnrollmentExpiredResponseSchema = z
  .object({ status: z.literal("expired_token") })
  .strict();

export const EnrollmentSlowDownResponseSchema = z
  .object({
    status: z.literal("slow_down"),
    retry_after_seconds: z.number().int().positive(),
  })
  .strict();

export const EnrollmentApprovedResponseSchema = z
  .object({
    status: z.literal("approved"),
    token: FellowTokenSchema,
    hello_url: StoaHelloUrlSchema,
    suggested_next: z.literal("GET /v1/hello with the bearer token"),
  })
  .strict();

/** The single generated JSON-Schema root for the S-1 enrollment protocol. */
export const EnrollmentContractsSchema = z
  .object({
    mint_request: MintEnrollmentRequestSchema,
    approval_card: EnrollmentApprovalCardSchema,
    capsule_projection: EnrollmentCapsuleProjectionSchema,
    claim_response: EnrollmentClaimResponseSchema,
    fellow_registration_credential_fields: FellowRegistrationCredentialFieldsSchema,
    fellow_registration_request: FellowRegistrationRequestSchema,
    sponsor_enrollment_decision: SponsorEnrollmentDecisionSchema,
    sponsor_enrollment_decision_command: SponsorEnrollmentDecisionCommandSchema,
    mint_response: MintEnrollmentResponseSchema,
    sponsor_proposal_list_response: SponsorProposalListResponseSchema,
    sponsor_credential_summary: SponsorCredentialSummarySchema,
    sponsor_fellow_summary: SponsorFellowSummarySchema,
    sponsor_fellow_cursor: SponsorFellowCursorSchema,
    sponsor_fellow_list_response: SponsorFellowListResponseSchema,
    sponsor_credential_revoke_request: SponsorCredentialRevokeRequestSchema,
    sponsor_credential_revoke_response: SponsorCredentialRevokeResponseSchema,
    sponsor_fellow_lifecycle_request: SponsorFellowLifecycleRequestSchema,
    sponsor_fellow_lifecycle_response: SponsorFellowLifecycleResponseSchema,
    sponsor_panic_request: SponsorPanicRequestSchema,
    sponsor_panic_response: SponsorPanicResponseSchema,
    operator_fellow_cap_override_request: OperatorFellowCapOverrideRequestSchema,
    operator_fellow_cap_override_response: OperatorFellowCapOverrideResponseSchema,
    operator_fellow_cap_state_response: OperatorFellowCapStateResponseSchema,
    operator_fellow_cap_audit_cursor: OperatorFellowCapAuditCursorSchema,
    operator_fellow_cap_audit_page_response: OperatorFellowCapAuditPageResponseSchema,
    sponsor_enrollment_decision_response: SponsorEnrollmentDecisionResponseSchema,
    sponsor_bootstrap_request: SponsorBootstrapRequestSchema,
    sponsor_bootstrap_response: SponsorBootstrapResponseSchema,
    device_code_start_request: DeviceCodeStartRequestSchema,
    device_code_start_response: DeviceCodeStartResponseSchema,
    device_lookup_request: DeviceLookupRequestSchema,
    device_lookup_response: DeviceLookupResponseSchema,
    flow_poll_request: EnrollmentFlowPollRequestSchema,
    pending_response: EnrollmentPendingResponseSchema,
    denied_response: EnrollmentDeniedResponseSchema,
    expired_response: EnrollmentExpiredResponseSchema,
    slow_down_response: EnrollmentSlowDownResponseSchema,
    approved_response: EnrollmentApprovedResponseSchema,
    hello_response: EnrollmentHelloResponseSchema,
  })
  .strict();

export type EnrollmentId = z.infer<typeof EnrollmentIdSchema>;
export type EnrollmentSecret = z.infer<typeof EnrollmentSecretSchema>;
export type EnrollmentFlowHandle = z.infer<typeof EnrollmentFlowHandleSchema>;
export type FellowToken = z.infer<typeof FellowTokenSchema>;
export type FellowLifecycleStatus = z.infer<typeof FellowLifecycleStatusSchema>;
export type FellowId = z.infer<typeof FellowIdSchema>;
export type FellowCredentialId = z.infer<typeof FellowCredentialIdSchema>;
export type FellowLifecycleEventId = z.infer<typeof FellowLifecycleEventIdSchema>;
export type FellowCredentialProfile = z.infer<typeof FellowCredentialProfileSchema>;
export type SponsorFellowCursorKey = z.infer<typeof SponsorFellowCursorKeySchema>;
export type SponsorFellowCursor = z.infer<typeof SponsorFellowCursorSchema>;
export type OperatorFellowCapAuditCursorKey = z.infer<typeof OperatorFellowCapAuditCursorKeySchema>;
export type OperatorFellowCapAuditCursor = z.infer<typeof OperatorFellowCapAuditCursorSchema>;
export type FellowRegistrationRequest = z.infer<typeof FellowRegistrationRequestSchema>;
export type EnrollmentApprovalCard = z.infer<typeof EnrollmentApprovalCardSchema>;
export type EnrollmentCapsuleProjection = z.infer<typeof EnrollmentCapsuleProjectionSchema>;
export type EnrollmentClaimResponse = z.infer<typeof EnrollmentClaimResponseSchema>;
export type EnrollmentHelloResponse = z.infer<typeof EnrollmentHelloResponseSchema>;
export type EnrollmentNextAction = z.infer<typeof EnrollmentNextActionSchema>;
export type MintEnrollmentRequest = z.infer<typeof MintEnrollmentRequestSchema>;
export type SponsorEnrollmentDecision = z.infer<typeof SponsorEnrollmentDecisionSchema>;
export type SponsorEnrollmentDecisionCommand = z.infer<
  typeof SponsorEnrollmentDecisionCommandSchema
>;
export type MintEnrollmentResponse = z.infer<typeof MintEnrollmentResponseSchema>;
export type SponsorProposalListResponse = z.infer<typeof SponsorProposalListResponseSchema>;
export type SponsorCredentialSummary = z.infer<typeof SponsorCredentialSummarySchema>;
export type SponsorFellowSummary = z.infer<typeof SponsorFellowSummarySchema>;
export type SponsorFellowListResponse = z.infer<typeof SponsorFellowListResponseSchema>;
export type SponsorCredentialRevokeRequest = z.infer<typeof SponsorCredentialRevokeRequestSchema>;
export type SponsorCredentialRevokeResponse = z.infer<typeof SponsorCredentialRevokeResponseSchema>;
export type SponsorFellowLifecycleTarget = z.infer<typeof SponsorFellowLifecycleTargetSchema>;
export type SponsorFellowLifecycleRequest = z.infer<typeof SponsorFellowLifecycleRequestSchema>;
export type SponsorFellowLifecycleResponse = z.infer<typeof SponsorFellowLifecycleResponseSchema>;
export type SponsorPanicRequest = z.infer<typeof SponsorPanicRequestSchema>;
export type SponsorPanicResponse = z.infer<typeof SponsorPanicResponseSchema>;
export type OperatorFellowCapAuditEventId = z.infer<typeof OperatorFellowCapAuditEventIdSchema>;
export type OperatorFellowCapSignerKid = z.infer<typeof OperatorFellowCapSignerKidSchema>;
export type OperatorFellowCapOverrideRequest = z.infer<
  typeof OperatorFellowCapOverrideRequestSchema
>;
export type OperatorFellowCapOverrideResponse = z.infer<
  typeof OperatorFellowCapOverrideResponseSchema
>;
export type OperatorFellowCapStateResponse = z.infer<typeof OperatorFellowCapStateResponseSchema>;
export type OperatorFellowCapAuditEvent = z.infer<typeof OperatorFellowCapAuditEventSchema>;
export type OperatorFellowCapAuditPageResponse = z.infer<
  typeof OperatorFellowCapAuditPageResponseSchema
>;
export type SponsorEnrollmentDecisionResponse = z.infer<
  typeof SponsorEnrollmentDecisionResponseSchema
>;
export type SponsorBootstrapRequest = z.infer<typeof SponsorBootstrapRequestSchema>;
export type SponsorBootstrapResponse = z.infer<typeof SponsorBootstrapResponseSchema>;
export type DeviceCodeStartRequest = z.infer<typeof DeviceCodeStartRequestSchema>;
export type DeviceCodeStartResponse = z.infer<typeof DeviceCodeStartResponseSchema>;
export type DeviceLookupRequest = z.infer<typeof DeviceLookupRequestSchema>;
export type DeviceLookupResponse = z.infer<typeof DeviceLookupResponseSchema>;
export type EnrollmentFlowPollRequest = z.infer<typeof EnrollmentFlowPollRequestSchema>;
export type RequestedScope = z.infer<typeof RequestedScopeSchema>;
export type EnrollmentGrantReduction = z.infer<typeof EnrollmentGrantReductionSchema>;
