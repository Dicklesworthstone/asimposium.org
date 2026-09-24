/**
 * Krater CAS core (W2.7): the content-addressed storage decision layer.
 *
 * The Fable (§10, line 586; hardening at §657) fixes the shape this module
 * encodes as pure, side-effect-free decisions:
 *
 *  - Global CAS at `r2://asimp/cas/sha256/<hex>`, served at
 *    `https://artifacts.asimposium.org/sha256/<hex>` with `Cache-Control:
 *    immutable`, direct from R2 (no Worker invocation on the blob path).
 *    Identical bytes dedupe site-wide because the key IS the digest.
 *  - Uploads: manifest → presigned PUT (15 min, size-capped) → server-observed
 *    hash verification. The MIME allowlist is text/source/Lean/logs plus
 *    `.tar.gz` lake archives; nothing HTML/SVG executes under a site origin.
 *  - MIME is sniffed, never trusted from the extension; archives get
 *    traversal and decompression-bomb bounds; anything not plain-text-safe is
 *    served with an attachment disposition.
 *  - Workshop bodies share the CAS: access control lives on the index row,
 *    unlisted hashes are explicitly not secrets, so token-shaped strings in
 *    any body are refused before the bytes ever bind (P7).
 *  - Bodies over 1 KB spill to the CAS with a 280-character extract in the
 *    owning index row.
 *
 * This module makes those decisions and nothing else. The R2 binding, the
 * presign/manifest state machine, and the W6.9 HTTP ergonomics consume these
 * primitives; none of that lives here, so the decision layer is property-
 * testable without a binding.
 */

/** The R2 key prefix every CAS object lives under. */
export const CAS_KEY_PREFIX = "cas/sha256/";

/** Fable §657: 5 MB general cap. */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
/** Fable §657: 20 MB cap for `.tar.gz` lake projects. */
export const MAX_LAKE_ARCHIVE_BYTES = 20 * 1024 * 1024;
/** Fable §10: bodies over 1 KB spill to the CAS. */
export const CAS_SPILL_THRESHOLD_BYTES = 1024;
/** Fable §10: the owning index row carries a 280-character extract. */
export const CAS_EXTRACT_CHARS = 280;

const SHA256_HEX = /^[a-f0-9]{64}$/;

/** The R2 key for a verified digest. Throws on a non-sha256-hex input. */
export function casKeyForHash(sha256Hex: string): string {
  if (typeof sha256Hex !== "string" || !SHA256_HEX.test(sha256Hex)) {
    throw new Error("ARTIFACT_DIGEST_INVALID: CAS keys are lowercase sha256 hex");
  }
  return `${CAS_KEY_PREFIX}${sha256Hex}`;
}

/** A body larger than 1 KB belongs in the CAS, not the index row. */
export function shouldSpillToCas(bodyBytes: number): boolean {
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0) {
    throw new Error("ARTIFACT_SIZE_INVALID: body size must be a nonnegative safe integer");
  }
  return bodyBytes > CAS_SPILL_THRESHOLD_BYTES;
}

/**
 * The 280-character extract the owning index row carries for a spilled body.
 * Sliced on Unicode code points (not UTF-16 code units or bytes) so the cut
 * never splits a valid surrogate pair. Lone UTF-16 surrogate units are
 * deterministically replaced with U+FFFD while copied, so an extract never
 * preserves an invalid scalar input.
 */
export function casExtractFor(body: string): string {
  let codePoints = 0;
  let extract = "";
  for (const character of body) {
    if (codePoints === CAS_EXTRACT_CHARS) break;
    codePoints += 1;
    // String iteration preserves a lone surrogate as a one-unit item. Valid
    // astral code points arrive as two units, so this cannot split a pair.
    const firstUnit = character.charCodeAt(0);
    extract +=
      character.length === 1 && firstUnit >= 0xd800 && firstUnit <= 0xdfff ? "\uFFFD" : character;
  }
  return extract;
}

/**
 * P7 / §9.1 secret-and-PII scan. Unlisted hashes are not secrets, so the CAS
 * cannot be a dead-drop for tokens or personal data — the scan is the wall.
 * Findings report the redacted LOCATION (line and column), never the detected
 * value: echoing it would republish the leak.
 */
export interface SecretFinding {
  /** The shape class, never the bytes. */
  readonly kind: "fellow-token" | "prefixed-grant" | "api-key" | "private-key" | "personal-address";
  /** 1-based line of the hit. */
  readonly line: number;
  /** 1-based CODE-POINT column where the sensitive run starts. */
  readonly column: number;
}

const SECRET_PATTERNS: ReadonlyArray<{
  readonly kind: SecretFinding["kind"];
  readonly pattern: RegExp;
}> = [
  { kind: "fellow-token", pattern: /asimp_ag_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}/ },
  { kind: "prefixed-grant", pattern: /asimp_[a-z]{2}_[0-9A-Za-z_-]{20,}/ },
  { kind: "api-key", pattern: /sk_live_[0-9A-Za-z]{16,}/ },
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    kind: "personal-address",
    pattern: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/,
  },
];

/** Any UTF-16 code unit that can only appear as half of a surrogate pair. */
const SURROGATE_UNIT = /[\uD800-\uDFFF]/;

/**
 * UTF-16 offset → 0-based code-point index, for one line.
 *
 * A line with no surrogate unit needs no map at all: there the two indices are
 * already equal, which is the overwhelmingly common case and stays allocation
 * free. When a map is needed it is built once for the whole line, so a line
 * carrying many hits costs one linear pass rather than re-counting a prefix
 * per finding.
 *
 * Both units of an astral character map to that character's own index, so an
 * offset that lands mid-pair cannot report a column between two code points.
 */
function codePointColumnsFor(lineText: string): Int32Array | undefined {
  if (!SURROGATE_UNIT.test(lineText)) return undefined;
  const columns = new Int32Array(lineText.length + 1);
  let unit = 0;
  let codePoint = 0;
  for (const character of lineText) {
    columns[unit] = codePoint;
    if (character.length === 2) columns[unit + 1] = codePoint;
    unit += character.length;
    codePoint += 1;
  }
  columns[unit] = codePoint;
  return columns;
}

/**
 * Scan a body for credential- and PII-shaped content. Returns every finding
 * with its redacted location. Pure: same body, same findings.
 *
 * `column` counts CODE POINTS, matching `casExtractFor`'s slicing unit, so a
 * location a reader is asked to inspect agrees with what they count. Only the
 * hit's offset is used to derive it — the matched bytes never reach a finding,
 * because echoing them would republish the leak this scan exists to stop.
 */
export function scanBodyForSecrets(body: string): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = body.split("\n");
  for (const [lineIndex, lineText] of lines.entries()) {
    const columns = codePointColumnsFor(lineText);
    for (const { kind, pattern } of SECRET_PATTERNS) {
      const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
      const matcher = new RegExp(pattern.source, flags);
      for (const hit of lineText.matchAll(matcher)) {
        const column = (columns === undefined ? hit.index : (columns[hit.index] ?? 0)) + 1;
        findings.push({ kind, line: lineIndex + 1, column });
      }
    }
  }
  return findings.sort((left, right) => {
    const locationOrder = left.line - right.line || left.column - right.column;
    if (locationOrder !== 0) return locationOrder;
    if (left.kind < right.kind) return -1;
    if (left.kind > right.kind) return 1;
    return 0;
  });
}

export function bodyLooksSecretShaped(body: string): boolean {
  // Admission needs only a yes/no wall. Do not construct the exhaustive
  // diagnostic array here: a body containing many repeated matches could
  // otherwise amplify one upload into millions of finding objects.
  return SECRET_PATTERNS.some(({ pattern }) => pattern.test(body));
}

/**
 * Decompression-bomb bound for `.tar.gz` lake archives: the declared
 * uncompressed size must stay within a fixed expansion ratio of the uploaded
 * bytes. A lake project that expands past this ratio is a bomb, not a build.
 */
export const MAX_ARCHIVE_EXPANSION_RATIO = 100;

/**
 * Archive-traversal check: a member path must be relative, must not escape
 * the extraction root, and must not be absolute or drive-relative. The
 * extractor refuses the archive on the first hostile member.
 */
export function archiveMemberPathIsSafe(memberPath: string): boolean {
  if (memberPath.length === 0) return false;
  if (memberPath.startsWith("/") || memberPath.startsWith("\\")) return false;
  // A Windows drive-relative path (`C:\…` or `C:…`) is absolute for our purposes.
  if (/^[A-Za-z]:[\\/]?/.test(memberPath)) return false;
  const segments = memberPath.split(/[\\/]+/);
  for (const segment of segments) {
    if (segment === ".." || segment === "") return false;
  }
  return true;
}

/**
 * The workshop-body spill (Fable §10): a body over 1 KB lives in the CAS, and
 * the index row carries the 280-char extract + the content-addressed hash.
 * Smaller bodies stay inline. The CAS write is a side effect that completes
 * BEFORE the D1 commit — the write transaction references the digest, so the
 * bytes must already be durable.
 */
export interface WorkshopBodyStorage {
  /** What the index row's body_md carries: the full body inline, or the extract. */
  readonly bodyMd: string;
  /** The CAS digest when the body spilled, null when inline. */
  readonly casHash: string | null;
}

/** The minimal R2 write surface the spill needs. */
export interface CasWriter {
  put(
    key: string,
    body: string,
    options?: { readonly httpMetadata?: { readonly contentType?: string } },
  ): Promise<unknown>;
}

/**
 * Store a workshop body. Over the spill threshold: put the body at its CAS key
 * and return the extract + hash. At or under: return the body inline, no write.
 */
export async function storeWorkshopBody(
  bucket: CasWriter,
  bodyMd: string,
  now: { readonly sha256Hex: (text: string) => Promise<string> },
): Promise<WorkshopBodyStorage> {
  const bodyBytes = new TextEncoder().encode(bodyMd).length;
  if (!shouldSpillToCas(bodyBytes)) {
    return { bodyMd, casHash: null };
  }
  const digest = await now.sha256Hex(bodyMd);
  const casHash = `sha256:${digest}`;
  // The P7 wall: never CAS a secret-shaped body.
  if (bodyLooksSecretShaped(bodyMd)) {
    throw new Error(
      "ARTIFACT_SECRET_SHAPED: a workshop body carrying a credential-shaped string is refused before it binds",
    );
  }
  await bucket.put(casKeyForHash(digest), bodyMd, {
    httpMetadata: { contentType: "text/markdown" },
  });
  return { bodyMd: casExtractFor(bodyMd), casHash };
}
