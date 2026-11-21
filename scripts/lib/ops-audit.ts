/**
 * Shared OPS.5 audit logging, step-up / reason enforcement, and Fable §14.3
 * never-log redaction layer (`asimposiumorg-vpx`).
 *
 * Wraps the canonical `@asimposium/contracts/diagnostic-safety` scanner so all
 * `ops:*` commands share ONE never-log authority plus structured field masking
 * for private workshop/directive/scientific bodies and signing keys.
 */

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  containsCredentialShape,
  REDACTED_TOKEN,
  redactCredentials,
} from "@asimposium/contracts/diagnostic-safety";

export const NEVER_LOG_REDACTED = REDACTED_TOKEN;

export const NEVER_LOG_CATEGORIES = [
  "enrollment-secrets-and-fragments",
  "fellow-bearer-tokens-and-device-codes",
  "oauth-tokens-cookies-and-jwts",
  "signing-keys-and-service-signatures",
  "full-directive-and-workshop-bodies",
  "detected-secrets-and-pii",
  "raw-scientific-and-screening-bodies",
  "presigned-storage-urls",
] as const;

const EXTRA_NEVER_LOG_PATTERNS: readonly RegExp[] = [
  // Presigned S3 / R2 query credentials.
  /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Amz-Algorithm)=)[^&#\s]+/gi,
  // Auth.js session cookie names in headers or logs.
  /(\b(?:__Secure-)?(?:authjs|next-auth|asimp)\.session(?:-token)?\s*=\s*)[^;\s,"']+/gi,
  // Service envelope signature headers & raw hex seeds.
  /(\b(?:x-asimp-service-sig|x-asimp-signature|service_envelope_sig|seed_hex|seedHex|signing_key|private_key_pem)"?\s*(?:=|:)\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/gi,
];

/** Structured JSON keys whose values must NEVER be emitted verbatim in ops logs. */
const NEVER_LOG_OBJECT_KEYS = new Set([
  "secret",
  "enrollment_secret",
  "token",
  "bearer_token",
  "access_token",
  "refresh_token",
  "id_token",
  "cookie",
  "set_cookie",
  "authorization",
  "authorization_code",
  "flow_handle",
  "device_code",
  "user_code",
  "signature",
  "service_envelope_sig",
  "signing_key",
  "seed_hex",
  "seedhex",
  "private_key",
  "private_key_pem",
  "directive_body",
  "workshop_body",
  "private_body",
  "body_md",
  "raw_body",
  "candidate_json",
  "presigned_url",
]);

/**
 * Redact any Fable §14.3 never-log material from free-form text while leaving
 * ordinary scientific identifiers (`P-4DSP`, `C-1@2`, `v1.2`, `OA-01JXYZ`) intact.
 */
export function redactOpsText(input: string): string {
  let out = redactCredentials(input);
  for (const pattern of EXTRA_NEVER_LOG_PATTERNS) {
    out = out.replace(pattern, `$1${NEVER_LOG_REDACTED}`);
  }
  return out;
}

/**
 * Recursively redact structured JSON-compatible values before logging or writing
 * to the immutable audit trail.
 */
export function redactOpsValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactOpsText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactOpsValue(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const redactedKeys: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      const lower = k.toLowerCase();
      if (NEVER_LOG_OBJECT_KEYS.has(lower)) {
        redactedKeys.push(k);
      } else {
        out[k] = redactOpsValue(v);
      }
    }
    if (redactedKeys.length > 0) {
      out._redacted_fields = redactedKeys.sort();
    }
    return out;
  }
  return value;
}

export function containsNeverLogMaterial(text: string): boolean {
  return containsCredentialShape(text) || redactOpsText(text) !== text;
}

export interface MutationAuthInput {
  readonly apply: boolean;
  readonly reason: string | null;
  readonly stepUpConfirm: string | null;
  readonly expectedStepUp: string;
  readonly command: string;
}

/**
 * Enforce OPS.5 admin/ops mutation discipline:
 * - dry-run (apply === false) is always read-only and requires no reason/step-up.
 * - apply === true requires a non-empty reason (>= 8 chars, zero never-log shapes)
 *   AND explicit step-up confirmation matching `expectedStepUp`.
 */
export function assertMutationAuthorized(input: MutationAuthInput): void {
  if (!input.apply) return;
  const reason = (input.reason ?? "").trim();
  if (reason.length < 8) {
    throw new Error(
      `OPS_REASON_REQUIRED: '${input.command} --apply' requires --reason with at least 8 characters explaining the operator action.`,
    );
  }
  if (containsNeverLogMaterial(reason)) {
    throw new Error(
      `OPS_REASON_NEVER_LOG_REFUSED: --reason for '${input.command}' contains credential or never-log material; strip secrets before retrying.`,
    );
  }
  if ((input.stepUpConfirm ?? "").trim() !== input.expectedStepUp) {
    throw new Error(
      `OPS_STEP_UP_REQUIRED: '${input.command} --apply' is a mutating action and requires --step-up-confirm "${input.expectedStepUp}".`,
    );
  }
}

export interface OpsAuditEntry {
  readonly schema: "asimposium.ops-audit.v1";
  readonly recorded_at: string;
  readonly command: string;
  readonly mode: "dry-run" | "apply";
  readonly operator: string;
  readonly reason: string | null;
  readonly status: "pass" | "fail" | "refused";
  readonly summary: unknown;
  readonly prev_entry_sha256: string;
  readonly entry_sha256: string;
}

const GENESIS_AUDIT_HASH = "0".repeat(64);

function canonicalAuditPayload(record: Omit<OpsAuditEntry, "entry_sha256">): string {
  return JSON.stringify(record);
}

/**
 * Append one SHA-256-chained, Fable §14.3-redacted audit entry to `auditLogPath`
 * with `0600` file permissions. Refuses to write if redaction failed to clear a secret.
 */
export function appendOpsAuditRecord(
  auditLogPath: string,
  input: {
    readonly command: string;
    readonly mode: "dry-run" | "apply";
    readonly operator?: string;
    readonly reason?: string | null;
    readonly status: "pass" | "fail" | "refused";
    readonly summary: unknown;
  },
): OpsAuditEntry {
  let prevHash = GENESIS_AUDIT_HASH;
  if (existsSync(auditLogPath)) {
    const raw = readFileSync(auditLogPath, "utf8").trim();
    if (raw.length > 0) {
      const lines = raw.split("\n");
      const last = JSON.parse(lines[lines.length - 1] ?? "{}") as { entry_sha256?: string };
      if (typeof last.entry_sha256 === "string" && /^[0-9a-f]{64}$/.test(last.entry_sha256)) {
        prevHash = last.entry_sha256;
      }
    }
  } else {
    mkdirSync(dirname(auditLogPath), { recursive: true });
  }

  const baseRecord: Omit<OpsAuditEntry, "entry_sha256"> = {
    schema: "asimposium.ops-audit.v1",
    recorded_at: new Date().toISOString(),
    command: redactOpsText(input.command),
    mode: input.mode,
    operator: redactOpsText(input.operator ?? process.env.USER ?? "operator"),
    reason: input.reason ? redactOpsText(input.reason) : null,
    status: input.status,
    summary: redactOpsValue(input.summary),
    prev_entry_sha256: prevHash,
  };

  const payload = canonicalAuditPayload(baseRecord);
  if (containsNeverLogMaterial(payload)) {
    throw new Error("OPS_AUDIT_REDACTION_VIOLATION: audit payload still contained never-log shape");
  }
  const entrySha = createHash("sha256").update(payload).digest("hex");
  const entry: OpsAuditEntry = { ...baseRecord, entry_sha256: entrySha };

  appendFileSync(auditLogPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  try {
    chmodSync(auditLogPath, 0o600);
  } catch {
    // Ignore on platforms where chmod after write is restricted.
  }
  return entry;
}

/** Verify the entire append-only SHA-256 audit chain and never-log cleanliness. */
export function verifyOpsAuditLog(auditLogPath: string): {
  readonly valid: boolean;
  readonly entryCount: number;
  readonly error: string | null;
} {
  if (!existsSync(auditLogPath)) {
    return { valid: false, entryCount: 0, error: "AUDIT_LOG_NOT_FOUND" };
  }
  const lines = readFileSync(auditLogPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let expectedPrev = GENESIS_AUDIT_HASH;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (containsNeverLogMaterial(raw)) {
      return {
        valid: false,
        entryCount: i,
        error: `AUDIT_LOG_NEVER_LOG_VIOLATION at line ${i + 1}`,
      };
    }
    const parsed = JSON.parse(raw) as OpsAuditEntry;
    if (parsed.prev_entry_sha256 !== expectedPrev) {
      return {
        valid: false,
        entryCount: i,
        error: `AUDIT_LOG_CHAIN_BROKEN at line ${i + 1}`,
      };
    }
    const { entry_sha256, ...rest } = parsed;
    const recomputed = createHash("sha256").update(canonicalAuditPayload(rest)).digest("hex");
    if (recomputed !== entry_sha256) {
      return {
        valid: false,
        entryCount: i,
        error: `AUDIT_LOG_DIGEST_MISMATCH at line ${i + 1}`,
      };
    }
    expectedPrev = entry_sha256;
  }
  return { valid: true, entryCount: lines.length, error: null };
}
