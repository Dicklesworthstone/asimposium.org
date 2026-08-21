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
/** The public artifacts host that serves CAS bytes directly from R2. */
export const ARTIFACTS_ORIGIN = "https://artifacts.asimposium.org";

/** Fable §657: 5 MB general cap. */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
/** Fable §657: 20 MB cap for `.tar.gz` lake projects. */
export const MAX_LAKE_ARCHIVE_BYTES = 20 * 1024 * 1024;
/** Fable §10: bodies over 1 KB spill to the CAS. */
export const CAS_SPILL_THRESHOLD_BYTES = 1024;
/** Fable §10: the owning index row carries a 280-character extract. */
export const CAS_EXTRACT_CHARS = 280;

const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * The MIME allowlist (Fable §657: text/source/Lean/logs, plus `.tar.gz` lake
 * projects). Anything else is refused at admission; nothing HTML/SVG is ever
 * served under a site origin. Keys are the SNIFFED type, never the extension.
 */
const ALLOWED_CONTENT_TYPES: ReadonlyMap<
  string,
  { readonly disposition: "inline" | "attachment" }
> = new Map<string, { readonly disposition: "inline" | "attachment" }>([
  ["text/plain", { disposition: "inline" }],
  ["text/markdown", { disposition: "inline" }],
  ["text/x-lean", { disposition: "inline" }],
  ["text/x-python", { disposition: "inline" }],
  ["text/x-csrc", { disposition: "inline" }],
  ["text/x-typescript", { disposition: "inline" }],
  ["text/x-log", { disposition: "inline" }],
  ["application/json", { disposition: "inline" }],
  // Lake archives are never rendered; they download with an attachment
  // disposition so no archived byte executes under a site origin.
  ["application/gzip", { disposition: "attachment" }],
]);

/** Types that are categorically refused — executable under a site origin. */
const FORBIDDEN_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "image/svg+xml",
  "application/xhtml+xml",
  "text/xml",
  "application/javascript",
  "text/javascript",
]);

export type CasAdmission =
  | {
      readonly admitted: true;
      readonly contentType: string;
      readonly disposition: "inline" | "attachment";
      readonly isLakeArchive: boolean;
    }
  | { readonly admitted: false; readonly code: CasRefusalCode; readonly reason: string };

export type CasRefusalCode =
  | "ARTIFACT_TYPE_FORBIDDEN"
  | "ARTIFACT_TYPE_NOT_ALLOWED"
  | "ARTIFACT_TOO_LARGE"
  | "ARTIFACT_SIZE_INVALID"
  | "ARTIFACT_DIGEST_INVALID"
  | "ARTIFACT_SECRET_SHAPED";

/** The R2 key for a verified digest. Throws on a non-sha256-hex input. */
export function casKeyForHash(sha256Hex: string): string {
  if (typeof sha256Hex !== "string" || !SHA256_HEX.test(sha256Hex)) {
    throw new Error("ARTIFACT_DIGEST_INVALID: CAS keys are lowercase sha256 hex");
  }
  return `${CAS_KEY_PREFIX}${sha256Hex}`;
}

/** The immutable public URL for a verified digest. */
export function casUrlForHash(sha256Hex: string): string {
  if (typeof sha256Hex !== "string" || !SHA256_HEX.test(sha256Hex)) {
    throw new Error("ARTIFACT_DIGEST_INVALID: CAS URLs are lowercase sha256 hex");
  }
  return `${ARTIFACTS_ORIGIN}/sha256/${sha256Hex}`;
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
 * The admission decision for one artifact. `sniffedType` is the type the
 * server derived from the bytes (never the client-declared type or the
 * extension); `sizeBytes` is the server-observed size. The decision is pure:
 * same inputs, same verdict, no clock, no I/O.
 */
export function decideArtifactAdmission(input: {
  readonly sniffedType: string;
  readonly sizeBytes: number;
  readonly body?: string;
}): CasAdmission {
  const { sniffedType, sizeBytes } = input;

  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    return {
      admitted: false,
      code: "ARTIFACT_SIZE_INVALID",
      reason: "the server-observed artifact size must be a nonnegative safe integer",
    };
  }

  if (FORBIDDEN_CONTENT_TYPES.has(sniffedType)) {
    return {
      admitted: false,
      code: "ARTIFACT_TYPE_FORBIDDEN",
      reason: `${sniffedType} executes under a site origin and is never served`,
    };
  }

  const allowed = ALLOWED_CONTENT_TYPES.get(sniffedType);
  if (allowed === undefined) {
    return {
      admitted: false,
      code: "ARTIFACT_TYPE_NOT_ALLOWED",
      reason: `${sniffedType} is not on the artifact allowlist (text/source/Lean/logs, or .tar.gz)`,
    };
  }

  const isLakeArchive = sniffedType === "application/gzip";
  const cap = isLakeArchive ? MAX_LAKE_ARCHIVE_BYTES : MAX_ARTIFACT_BYTES;
  if (sizeBytes > cap) {
    return {
      admitted: false,
      code: "ARTIFACT_TOO_LARGE",
      reason: `${sizeBytes} bytes exceeds the ${cap}-byte cap for ${sniffedType}`,
    };
  }

  // Secret scanning is deliberately last among the cheap admission checks.
  // It is linear in the supplied body but still materially more expensive
  // than scalar/type/cap validation, so a doomed upload must never reach it.
  const body = input.body;
  if (body !== undefined && bodyLooksSecretShaped(body)) {
    return {
      admitted: false,
      code: "ARTIFACT_SECRET_SHAPED",
      reason:
        "the body carries a credential-shaped string; unlisted hashes are not secrets, so tokens never belong in the CAS",
    };
  }

  return {
    admitted: true,
    contentType: sniffedType,
    disposition: allowed.disposition,
    isLakeArchive,
  };
}

/**
 * Decompression-bomb bound for `.tar.gz` lake archives: the declared
 * uncompressed size must stay within a fixed expansion ratio of the uploaded
 * bytes. A lake project that expands past this ratio is a bomb, not a build.
 */
export const MAX_ARCHIVE_EXPANSION_RATIO = 100;

export function archiveExpansionIsBounded(
  compressedBytes: number,
  declaredUncompressedBytes: number,
): boolean {
  if (
    !Number.isSafeInteger(compressedBytes) ||
    compressedBytes <= 0 ||
    !Number.isSafeInteger(declaredUncompressedBytes) ||
    declaredUncompressedBytes < 0
  ) {
    return false;
  }
  return (
    BigInt(declaredUncompressedBytes) <=
    BigInt(compressedBytes) * BigInt(MAX_ARCHIVE_EXPANSION_RATIO)
  );
}

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
 * The upload manifest lifecycle (Fable §10: "manifest → presigned PUT (15
 * min, size-capped) → hash verification"). This is a pure state machine: the
 * R2 binding supplies the clock and the I/O; this layer owns which moves are
 * lawful and which are terminal, so an upload can never skip verification or
 * resurrect from a terminal state.
 *
 *   declared ──presign──► presigned ──upload──► uploaded ──verify──► verified
 *      │                    │                     │   │                 │
 *      │                    └──expire─────────────┘   └──mismatch──► quarantined
 *      └──expire──► expired                            (digest/size)
 *   verified ──bind──► bound   (terminal; the index row now references it)
 *      └──expire──► expired    (binding failed and the manifest aged out)
 *
 * `expired` and `quarantined` are terminal; `bound` is the only success
 * terminal. An unverified or quarantined object can never reach `bound`, which
 * is the property the disposition-moving-evidence rule depends on.
 */
export type UploadState =
  | "declared"
  | "presigned"
  | "uploaded"
  | "verified"
  | "bound"
  | "expired"
  | "quarantined";

const UPLOAD_STATE_ORDER: readonly UploadState[] = [
  "declared",
  "presigned",
  "uploaded",
  "verified",
  "bound",
  "expired",
  "quarantined",
];

const UPLOAD_STATES: ReadonlySet<UploadState> = new Set(UPLOAD_STATE_ORDER);

export type UploadTransition = "presign" | "upload" | "verify" | "bind" | "expire" | "mismatch";

const TERMINAL_UPLOAD_STATES: ReadonlySet<UploadState> = new Set([
  "bound",
  "expired",
  "quarantined",
]);

/** The lawful (from, transition) → to edges. Anything absent is refused. */
const UPLOAD_EDGES: ReadonlyMap<UploadTransition, ReadonlyMap<UploadState, UploadState>> = new Map<
  UploadTransition,
  ReadonlyMap<UploadState, UploadState>
>([
  ["presign", new Map<UploadState, UploadState>([["declared", "presigned"]])],
  ["upload", new Map<UploadState, UploadState>([["presigned", "uploaded"]])],
  ["verify", new Map<UploadState, UploadState>([["uploaded", "verified"]])],
  ["bind", new Map<UploadState, UploadState>([["verified", "bound"]])],
  // Expiry lawfully preempts any non-terminal state; mismatch quarantines an
  // uploaded object whose observed digest/size disagrees with the manifest.
  [
    "expire",
    new Map<UploadState, UploadState>([
      ["declared", "expired"],
      ["presigned", "expired"],
      ["uploaded", "expired"],
      ["verified", "expired"],
    ]),
  ],
  ["mismatch", new Map<UploadState, UploadState>([["uploaded", "quarantined"]])],
]);

export type UploadStep =
  | { readonly ok: true; readonly state: UploadState }
  | {
      readonly ok: false;
      readonly code: "UPLOAD_TRANSITION_ILLEGAL";
      readonly from: UploadState;
      readonly transition: UploadTransition;
    };

/** Advance the machine one edge. Illegal moves are refused, never coerced. */
export function stepUpload(state: UploadState, transition: UploadTransition): UploadStep {
  const next = UPLOAD_EDGES.get(transition)?.get(state);
  if (next === undefined) {
    return { ok: false, code: "UPLOAD_TRANSITION_ILLEGAL", from: state, transition };
  }
  return { ok: true, state: next };
}

/** A terminal state admits no further transition. */
export function uploadStateIsTerminal(state: UploadState): boolean {
  return TERMINAL_UPLOAD_STATES.has(state);
}

/**
 * The binding gate: only a `verified` object may bind as an artifact an index
 * row references. This is the single chokepoint the "no unverified or
 * quarantined object binds as disposition-moving evidence" rule hangs on.
 */
export function uploadMayBind(state: UploadState): boolean {
  return state === "verified";
}

/**
 * Reference-aware GC eligibility (W2.7). CAS dedup means many index rows can
 * point at one physical object, so deleting a row NEVER deletes the bytes —
 * the bytes go only when no lawful reference remains. The classes:
 *
 *  - public: a published ledger reference. Public bytes are never GC-eligible;
 *    a duplicate private upload must not make them private either.
 *  - licensed: a reference carrying a license obligation (e.g. a CC-BY export).
 *  - backup-restoration: a reference a restore would need.
 *  - quarantine: a quarantined object held for review.
 *  - legal-hold: a legal hold; absolute.
 *  - private: a workshop/private-draft binding — the only class whose removal
 *    can ever free the bytes, and only when it is the LAST remaining class.
 *
 * The decision is pure over the surviving reference classes.
 */
export type RetentionClass =
  | "public"
  | "licensed"
  | "backup-restoration"
  | "quarantine"
  | "legal-hold"
  | "private";

export type GcEligibility =
  | { readonly eligible: true; readonly reason: "no_lawful_reference_remains" }
  | {
      readonly eligible: false;
      readonly reason:
        | "public_bytes_stay_public"
        | "licensed_reference_remains"
        | "backup_restoration_reference_remains"
        | "quarantine_hold"
        | "legal_hold"
        | "private_reference_remains";
      readonly preservedFor: readonly RetentionClass[];
    };

const PRESERVING_REFERENCE_CLASSES: ReadonlySet<RetentionClass> = new Set([
  "public",
  "licensed",
  "backup-restoration",
  "quarantine",
  "legal-hold",
  "private",
]);

const RETENTION_CLASS_ORDER: readonly RetentionClass[] = [
  "public",
  "licensed",
  "backup-restoration",
  "quarantine",
  "legal-hold",
  "private",
];
const RETENTION_CLASSES: ReadonlySet<RetentionClass> = new Set(RETENTION_CLASS_ORDER);

/**
 * Given the retention classes that still reference an object after some
 * binding's removal, decide whether the physical bytes may be collected. The
 * private association is removed by the caller regardless; this decides only
 * whether the shared bytes survive.
 */
export function gcEligibility(remainingClasses: readonly RetentionClass[]): GcEligibility {
  const remaining = new Set<RetentionClass>();
  for (const retentionClass of remainingClasses) {
    if (typeof retentionClass !== "string" || !RETENTION_CLASSES.has(retentionClass)) {
      throw new Error("ARTIFACT_RETENTION_INVALID: every remaining reference class must be known");
    }
    remaining.add(retentionClass);
  }
  const preserved = RETENTION_CLASS_ORDER.filter(
    (retentionClass) =>
      remaining.has(retentionClass) && PRESERVING_REFERENCE_CLASSES.has(retentionClass),
  );
  if (preserved.length === 0) {
    return { eligible: true, reason: "no_lawful_reference_remains" };
  }
  const reason:
    | "public_bytes_stay_public"
    | "licensed_reference_remains"
    | "backup_restoration_reference_remains"
    | "quarantine_hold"
    | "legal_hold"
    | "private_reference_remains" = preserved.includes("legal-hold")
    ? "legal_hold"
    : preserved.includes("quarantine")
      ? "quarantine_hold"
      : preserved.includes("public")
        ? "public_bytes_stay_public"
        : preserved.includes("licensed")
          ? "licensed_reference_remains"
          : preserved.includes("backup-restoration")
            ? "backup_restoration_reference_remains"
            : "private_reference_remains";
  return { eligible: false, reason, preservedFor: preserved };
}

/**
 * The duplicate-upload privacy rule: a hash that is already public is NOT made
 * private by a later private/workshop upload of the same bytes. The deletion
 * response must explain that identical public bytes remain public without
 * revealing another private owner. This predicate is that explanation's
 * server-side guard.
 */
export function duplicateUploadKeepsPublicStatus(
  existingClasses: readonly RetentionClass[],
): boolean {
  return existingClasses.includes("public");
}

/**
 * Artifact inventory reconciliation (W2.7): the periodic sweep that audits the
 * R2 object listing against the index table and names every divergence. It
 * never deletes — it REPORTS, so orphan cleanup is a guarded, audit-logged
 * decision, not a blind sweep.
 *
 * Divergence classes (the bead's "detects every seeded divergence"):
 *  - orphan_object: an R2 object with no index row references it. Eligible for
 *    guarded GC review (subject to the retention classes above), never auto-
 *    deleted.
 *  - missing_object: an index row references a digest no R2 object has. The
 *    binding is dangling — this is the corruption signal, surfaced loudly.
 *  - state_mismatch: an index row's recorded upload state disagrees with the
 *    object actually being present (an uploaded/verified row with no object,
 *    or an object present for a `declared` row that never uploaded).
 */
export interface ArtifactIndexRow {
  readonly digest: string;
  readonly state: UploadState;
}

export type InventoryDivergence =
  | { readonly kind: "orphan_object"; readonly digest: string }
  | { readonly kind: "missing_object"; readonly digest: string }
  | { readonly kind: "state_mismatch"; readonly digest: string; readonly state: UploadState };

/**
 * Diff the index rows against the observed R2 digests. Pure over the two sets;
 * deterministic output ordering (digests sorted) so a reconciliation report is
 * stable and diff-able run over run.
 */
export function reconcileArtifactInventory(
  indexRows: readonly ArtifactIndexRow[],
  observedDigests: readonly string[],
): readonly InventoryDivergence[] {
  const indexed = new Map<string, Set<UploadState>>();
  for (const row of indexRows) {
    if (typeof row !== "object" || row === null) {
      throw new Error(
        "ARTIFACT_INVENTORY_INVALID: index rows require lowercase sha256 digests and known upload states",
      );
    }
    const { digest, state } = row;
    if (
      typeof digest !== "string" ||
      typeof state !== "string" ||
      !SHA256_HEX.test(digest) ||
      !UPLOAD_STATES.has(state)
    ) {
      throw new Error(
        "ARTIFACT_INVENTORY_INVALID: index rows require lowercase sha256 digests and known upload states",
      );
    }
    const states = indexed.get(digest) ?? new Set<UploadState>();
    states.add(state);
    indexed.set(digest, states);
  }

  const observed = new Set<string>();
  for (const digest of observedDigests) {
    if (typeof digest !== "string" || !SHA256_HEX.test(digest)) {
      throw new Error(
        "ARTIFACT_INVENTORY_INVALID: observed objects require lowercase sha256 digests",
      );
    }
    observed.add(digest);
  }

  const divergences: InventoryDivergence[] = [];

  for (const digest of observed) {
    if (!indexed.has(digest)) {
      divergences.push({ kind: "orphan_object", digest });
    }
  }

  for (const [digest, states] of indexed) {
    const present = observed.has(digest);
    if (!present && states.has("bound")) {
      divergences.push({ kind: "missing_object", digest });
    }
    if (!present) {
      // Every distinct uploaded/verified row is independently inconsistent
      // with an absent object. A bound row for the same digest does not erase
      // these partial-write signals.
      for (const state of UPLOAD_STATE_ORDER) {
        if ((state === "uploaded" || state === "verified") && states.has(state)) {
          divergences.push({ kind: "state_mismatch", digest, state });
        }
      }
    } else if (states.has("declared")) {
      // An object exists for a row that never recorded an upload.
      divergences.push({ kind: "state_mismatch", digest, state: "declared" });
    }
  }

  const kindOrder: Readonly<Record<InventoryDivergence["kind"], number>> = {
    missing_object: 0,
    orphan_object: 1,
    state_mismatch: 2,
  };
  return divergences.sort((left, right) => {
    // Digests are validated lowercase ASCII hex, so compare code units
    // directly. `localeCompare` unnecessarily delegates report order to the
    // host locale/ICU build, weakening the byte-identical-report promise.
    const digestOrder = left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0;
    if (digestOrder !== 0) return digestOrder;
    const divergenceOrder = kindOrder[left.kind] - kindOrder[right.kind];
    if (divergenceOrder !== 0) return divergenceOrder;
    if (left.kind !== "state_mismatch" || right.kind !== "state_mismatch") return 0;
    return UPLOAD_STATE_ORDER.indexOf(left.state) - UPLOAD_STATE_ORDER.indexOf(right.state);
  });
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
