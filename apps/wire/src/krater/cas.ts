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
const ALLOWED_CONTENT_TYPES: Readonly<
  Record<string, { readonly disposition: "inline" | "attachment" }>
> = {
  "text/plain": { disposition: "inline" },
  "text/markdown": { disposition: "inline" },
  "text/x-lean": { disposition: "inline" },
  "text/x-python": { disposition: "inline" },
  "text/x-csrc": { disposition: "inline" },
  "text/x-typescript": { disposition: "inline" },
  "text/x-log": { disposition: "inline" },
  "application/json": { disposition: "inline" },
  // Lake archives are never rendered; they download with an attachment
  // disposition so no archived byte executes under a site origin.
  "application/gzip": { disposition: "attachment" },
};

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
  | "ARTIFACT_DIGEST_INVALID"
  | "ARTIFACT_SECRET_SHAPED";

/** The R2 key for a verified digest. Throws on a non-sha256-hex input. */
export function casKeyForHash(sha256Hex: string): string {
  if (!SHA256_HEX.test(sha256Hex)) {
    throw new Error("ARTIFACT_DIGEST_INVALID: CAS keys are lowercase sha256 hex");
  }
  return `${CAS_KEY_PREFIX}${sha256Hex}`;
}

/** The immutable public URL for a verified digest. */
export function casUrlForHash(sha256Hex: string): string {
  if (!SHA256_HEX.test(sha256Hex)) {
    throw new Error("ARTIFACT_DIGEST_INVALID: CAS URLs are lowercase sha256 hex");
  }
  return `${ARTIFACTS_ORIGIN}/sha256/${sha256Hex}`;
}

/** A body larger than 1 KB belongs in the CAS, not the index row. */
export function shouldSpillToCas(bodyBytes: number): boolean {
  return bodyBytes > CAS_SPILL_THRESHOLD_BYTES;
}

/**
 * The 280-character extract the owning index row carries for a spilled body.
 * Sliced on characters (not bytes) so a multi-byte body never yields a
 * half-encoded tail; trailing whitespace collapsed so the extract reads clean.
 */
export function casExtractFor(body: string): string {
  if (body.length <= CAS_EXTRACT_CHARS) return body;
  return body.slice(0, CAS_EXTRACT_CHARS);
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
  /** 1-based column where the sensitive run starts. */
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
  { kind: "personal-address", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
];

/**
 * Scan a body for credential- and PII-shaped content. Returns every finding
 * with its redacted location. Pure: same body, same findings.
 */
export function scanBodyForSecrets(body: string): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = body.split("\n");
  for (const [lineIndex, lineText] of lines.entries()) {
    for (const { kind, pattern } of SECRET_PATTERNS) {
      const matcher = new RegExp(pattern.source, pattern.flags);
      const hit = matcher.exec(lineText);
      if (hit !== null) {
        findings.push({ kind, line: lineIndex + 1, column: hit.index + 1 });
      }
    }
  }
  return findings;
}

export function bodyLooksSecretShaped(body: string): boolean {
  return scanBodyForSecrets(body).length > 0;
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
  const { sniffedType, sizeBytes, body } = input;

  if (body !== undefined && bodyLooksSecretShaped(body)) {
    return {
      admitted: false,
      code: "ARTIFACT_SECRET_SHAPED",
      reason:
        "the body carries a credential-shaped string; unlisted hashes are not secrets, so tokens never belong in the CAS",
    };
  }

  if (FORBIDDEN_CONTENT_TYPES.has(sniffedType)) {
    return {
      admitted: false,
      code: "ARTIFACT_TYPE_FORBIDDEN",
      reason: `${sniffedType} executes under a site origin and is never served`,
    };
  }

  const allowed = ALLOWED_CONTENT_TYPES[sniffedType];
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
  if (compressedBytes <= 0 || declaredUncompressedBytes < 0) return false;
  return declaredUncompressedBytes <= compressedBytes * MAX_ARCHIVE_EXPANSION_RATIO;
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

export type UploadTransition =
  | "presign"
  | "upload"
  | "verify"
  | "bind"
  | "expire"
  | "mismatch";

const TERMINAL_UPLOAD_STATES: ReadonlySet<UploadState> = new Set([
  "bound",
  "expired",
  "quarantined",
]);

/** The lawful (from, transition) → to edges. Anything absent is refused. */
const UPLOAD_EDGES: Readonly<Record<UploadTransition, Readonly<Partial<Record<UploadState, UploadState>>>>> = {
  presign: { declared: "presigned" },
  upload: { presigned: "uploaded" },
  verify: { uploaded: "verified" },
  bind: { verified: "bound" },
  // Expiry lawfully preempts any non-terminal state; mismatch quarantines an
  // uploaded object whose observed digest/size disagrees with the manifest.
  expire: { declared: "expired", presigned: "expired", uploaded: "expired" },
  mismatch: { uploaded: "quarantined" },
};

export type UploadStep =
  | { readonly ok: true; readonly state: UploadState }
  | { readonly ok: false; readonly code: "UPLOAD_TRANSITION_ILLEGAL"; readonly from: UploadState; readonly transition: UploadTransition };

/** Advance the machine one edge. Illegal moves are refused, never coerced. */
export function stepUpload(state: UploadState, transition: UploadTransition): UploadStep {
  const next = UPLOAD_EDGES[transition][state];
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
        | "legal_hold";
      readonly preservedFor: readonly RetentionClass[];
    };

const NEVER_GC_CLASSES: ReadonlySet<RetentionClass> = new Set([
  "public",
  "licensed",
  "backup-restoration",
  "quarantine",
  "legal-hold",
]);

/**
 * Given the retention classes that still reference an object after some
 * binding's removal, decide whether the physical bytes may be collected. The
 * private association is removed by the caller regardless; this decides only
 * whether the shared bytes survive.
 */
export function gcEligibility(remainingClasses: readonly RetentionClass[]): GcEligibility {
  const preserved = [...new Set(remainingClasses)].filter((c) => NEVER_GC_CLASSES.has(c));
  if (preserved.length === 0) {
    return { eligible: true, reason: "no_lawful_reference_remains" };
  }
  const reason:
    | "public_bytes_stay_public"
    | "licensed_reference_remains"
    | "backup_restoration_reference_remains"
    | "quarantine_hold"
    | "legal_hold" = preserved.includes("legal-hold")
    ? "legal_hold"
    : preserved.includes("quarantine")
      ? "quarantine_hold"
      : preserved.includes("public")
        ? "public_bytes_stay_public"
        : preserved.includes("licensed")
          ? "licensed_reference_remains"
          : "backup_restoration_reference_remains";
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
