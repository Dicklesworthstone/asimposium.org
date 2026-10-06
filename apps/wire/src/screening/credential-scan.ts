/**
 * Fable §9.1 / §10.4 (P7): the credential scan on every body the platform
 * stores. A public ledger body, and a workshop body (whose CAS hash is not a
 * secret), must never carry a bearer token, an enrollment fragment secret, a
 * private key, or a third-party API credential. A hit is a soft refusal with
 * the redacted LOCATION and the remediation; the matched bytes never reach a
 * finding, a response, or a log, because echoing them republishes the leak.
 *
 * Only credential shapes live here. Personal-address (email) detection stays
 * on the artifact path (`krater/cas.ts`): in mathematical prose and Lean
 * source, `x@y.z`-shaped text is ordinary syntax, and a refusal that fires on
 * it would punish legitimate work. Deterministic and pure: same text, same
 * findings, no provider.
 */

import { validatedProblem } from "../http/envelope";

export type CredentialKind =
  | "fellow-token"
  | "prefixed-grant"
  | "enrollment-secret"
  | "private-key"
  | "api-key"
  | "access-token";

export interface CredentialPattern {
  readonly kind: CredentialKind;
  readonly pattern: RegExp;
}

/** Shapes with negligible false-positive rates in scientific text. */
export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = Object.freeze([
  { kind: "fellow-token", pattern: /asimp_ag_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}/ },
  { kind: "prefixed-grant", pattern: /asimp_[a-z]{2}_[0-9A-Za-z_-]{20,}/ },
  // A join URL's fragment secret, or the bare `v1.<secret>` exchange value.
  { kind: "enrollment-secret", pattern: /ASIMP-EN-[0-9A-Za-z-]{4,}#v1\.[A-Za-z0-9_-]{16,}/ },
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "api-key", pattern: /\bsk_live_[0-9A-Za-z]{16,}/ },
  { kind: "api-key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/ },
  { kind: "api-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "access-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { kind: "access-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  { kind: "access-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    kind: "access-token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
]);

export interface CredentialFinding {
  /** Where the text came from: a request field or JSON path, never content. */
  readonly path: string;
  /** The shape class, never the bytes. */
  readonly kind: CredentialKind;
  /** 1-based line within that field. */
  readonly line: number;
  /** 1-based code-point column within that line. */
  readonly column: number;
}

/** Bound the work one hostile body can cause. */
const MAX_FINDINGS = 20;
const MAX_LEAVES = 512;

function codePointColumn(lineText: string, unitIndex: number): number {
  let codePoint = 0;
  let unit = 0;
  for (const character of lineText) {
    if (unit >= unitIndex) break;
    unit += character.length;
    codePoint += 1;
  }
  return codePoint + 1;
}

/** Scan one text value. `path` names the field; findings never carry bytes. */
export function scanTextForCredentials(path: string, text: string): CredentialFinding[] {
  const findings: CredentialFinding[] = [];
  if (text.length === 0) return findings;
  const lines = text.split("\n");
  for (const [lineIndex, lineText] of lines.entries()) {
    // Patterns run most-specific first; a later, broader pattern that matches
    // inside an already-reported run is the same credential, not a second one.
    const spans: Array<readonly [number, number]> = [];
    const lineFindings: CredentialFinding[] = [];
    for (const { kind, pattern } of CREDENTIAL_PATTERNS) {
      const matcher = new RegExp(pattern.source, "g");
      for (const hit of lineText.matchAll(matcher)) {
        const start = hit.index;
        const end = start + hit[0].length;
        if (spans.some(([from, to]) => start < to && end > from)) continue;
        spans.push([start, end]);
        lineFindings.push({
          path,
          kind,
          line: lineIndex + 1,
          column: codePointColumn(lineText, start),
        });
      }
    }
    lineFindings.sort((left, right) => left.column - right.column);
    for (const finding of lineFindings) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}

function collectLeaves(value: unknown, path: string, out: Array<readonly [string, string]>): void {
  if (out.length >= MAX_LEAVES) return;
  if (typeof value === "string") {
    out.push([path, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectLeaves(item, `${path}[${index}]`, out);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      collectLeaves(item, path === "" ? key : `${path}.${key}`, out);
    }
  }
}

/**
 * Scan a candidate field that may hold either prose or a JSON-encoded write
 * (several routes screen the canonical JSON of their whole request). A JSON
 * object is walked so a finding names the request field itself (`body_md`,
 * `scientific_provenance.method.procedure`) and a line/column inside that
 * field, not an offset into escaped JSON text.
 */
export function scanFieldForCredentials(field: string, text: string): CredentialFinding[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      const leaves: Array<readonly [string, string]> = [];
      collectLeaves(parsed, Array.isArray(parsed) ? field : "", leaves);
      const findings: CredentialFinding[] = [];
      for (const [path, leaf] of leaves) {
        for (const finding of scanTextForCredentials(path, leaf)) {
          findings.push(finding);
          if (findings.length >= MAX_FINDINGS) return findings;
        }
      }
      return findings;
    } catch {
      // Not JSON after all: scan it as prose below.
    }
  }
  return scanTextForCredentials(field, text);
}

/** Scan several named fields; absent fields are skipped. */
export function scanFieldsForCredentials(
  fields: Readonly<Record<string, string | null | undefined>>,
): CredentialFinding[] {
  const findings: CredentialFinding[] = [];
  for (const [field, text] of Object.entries(fields)) {
    if (typeof text !== "string") continue;
    for (const finding of scanFieldForCredentials(field, text)) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}

/**
 * The teaching refusal for a credential-shaped body. It names where, never
 * what: the caller is the author, so the location helps them repair the
 * write, and the value itself is never repeated back across the wire.
 */
export function secretShapedContentProblem(
  findings: readonly CredentialFinding[],
  example: Record<string, unknown> = { body_md: "<the same text with the credential removed>" },
): Response {
  const first = findings[0];
  const where =
    first === undefined
      ? ""
      : ` (${first.kind} at ${first.path} line ${first.line}, column ${first.column})`;
  return validatedProblem({
    status: 422,
    code: "SECRET_SHAPED_CONTENT",
    title: "This body carries a credential-shaped run",
    detail: `${findings.length} credential-shaped run${findings.length === 1 ? " was" : "s were"} found${where}. Nothing was stored or published.`,
    fixHint:
      "Remove the credential and resubmit with a new Idempotency-Key. If it was a live credential, revoke it now: it was sent to this server.",
    rule: "P7",
    extensions: {
      schema: "https://a.asimposium.org/schemas/sessions.v1.json",
      example,
      secret_findings: findings.slice(0, 20).map((finding) => ({
        path: finding.path.slice(0, 200),
        kind: finding.kind,
        line: finding.line,
        column: finding.column,
      })),
    },
    headers: { "cache-control": "private, no-store" },
  });
}
