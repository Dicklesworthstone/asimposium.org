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
const MAX_PATH_LENGTH = 200;
const REDACTED_PATH = "[redacted-field]";
const NESTED_PATH = "[nested-field]";

/** JSON property names are authored content too. They must not become a
 * second route for echoing a credential through an otherwise redacted error. */
function diagnosticPath(path: string): string {
  if (
    path.length > MAX_PATH_LENGTH ||
    /[\r\n\t]/.test(path) ||
    CREDENTIAL_PATTERNS.some(({ pattern }) => pattern.test(path))
  )
    return REDACTED_PATH;
  return path || "[root]";
}

function appendPath(parent: string, suffix: string): string {
  if (parent === NESTED_PATH) return NESTED_PATH;
  const path = `${parent}${suffix}`;
  return path.length > MAX_PATH_LENGTH ? NESTED_PATH : diagnosticPath(path);
}

function memberPath(parent: string, key: string, index: number): string {
  if (
    /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) &&
    !CREDENTIAL_PATTERNS.some(({ pattern }) => pattern.test(key))
  )
    return appendPath(parent, `${parent ? "." : ""}${key}`);
  return appendPath(parent, `[entry:${index}]`);
}

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
  const safePath = diagnosticPath(path);
  const lines = text.split("\n");
  for (const [lineIndex, lineText] of lines.entries()) {
    // Patterns run most-specific first; a later, broader pattern that matches
    // inside an already-reported run is the same credential, not a second one.
    const spans: Array<readonly [number, number]> = [];
    const lineFindings: Array<{ kind: CredentialKind; start: number }> = [];
    for (const { kind, pattern } of CREDENTIAL_PATTERNS) {
      const matcher = new RegExp(pattern.source, "g");
      let admitted = 0;
      for (const hit of lineText.matchAll(matcher)) {
        const start = hit.index;
        const end = start + hit[0].length;
        if (spans.some(([from, to]) => start < to && end > from)) continue;
        spans.push([start, end]);
        lineFindings.push({ kind, start });
        // Later matches of this shape cannot enter the first twenty locations.
        // Bound accumulation before allocating findings or counting columns.
        if (++admitted === MAX_FINDINGS) break;
      }
    }
    lineFindings.sort((left, right) => left.start - right.start);
    for (const finding of lineFindings) {
      findings.push({
        path: safePath,
        kind: finding.kind,
        line: lineIndex + 1,
        column: codePointColumn(lineText, finding.start),
      });
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}

interface JsonFrame {
  kind: "object" | "array";
  path: string;
  index: number;
  keyPath?: string;
  expectingKey: boolean;
}

/**
 * Scan a candidate field that may hold either prose or a JSON-encoded write
 * (several routes screen the canonical JSON of their whole request). A JSON
 * object is walked so a finding names the request field itself (`body_md`,
 * `scientific_provenance.method.procedure`) and a line/column inside that
 * field, not an offset into escaped JSON text.
 */
export function scanFieldForCredentials(field: string, text: string): CredentialFinding[] {
  const findings: CredentialFinding[] = [];
  const pending = [{ field: diagnosticPath(field), text, root: true }];
  while (pending.length > 0 && findings.length < MAX_FINDINGS) {
    const current = pending.pop();
    if (current === undefined) break;
    const first = current.text.trimStart()[0];
    let json = first === "{" || first === "[" || first === '"';
    try {
      if (json) JSON.parse(current.text);
    } catch {
      json = false;
    }
    if (!json) {
      findings.push(...scanTextForCredentials(current.field, current.text));
      continue;
    }

    // Scan the submitted JSON tokens, not JSON.parse's object projection:
    // duplicate properties still contain stored bytes even when a later value
    // shadows them. Decoding every string also covers escaped keys and values.
    // Ingress byte limits bound traversal; no leaf/depth cap may imply "clean".
    const frames: JsonFrame[] = [];
    const valuePath = () => {
      const frame = frames.at(-1);
      return frame === undefined
        ? current.field
        : frame.kind === "array"
          ? appendPath(frame.path, `[${frame.index}]`)
          : (frame.keyPath ?? frame.path);
    };
    const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]/g;
    for (const token of current.text.matchAll(tokens)) {
      const value = token[0];
      const frame = frames.at(-1);
      if (value === "{" || value === "[") {
        frames.push({
          kind: value === "{" ? "object" : "array",
          path: frames.length === 0 && current.root && value === "{" ? "" : valuePath(),
          index: 0,
          expectingKey: value === "{",
        });
      } else if (value === "}" || value === "]") {
        frames.pop();
      } else if (value === "," && frame !== undefined) {
        frame.index++;
        frame.expectingKey = frame.kind === "object";
        frame.keyPath = undefined;
      } else if (value.startsWith('"')) {
        const decoded = JSON.parse(value) as string;
        let path: string;
        if (frame?.kind === "object" && frame.expectingKey) {
          path = appendPath(frame.path, `[key:${frame.index}]`);
          frame.keyPath = memberPath(frame.path, decoded, frame.index);
          frame.expectingKey = false;
        } else {
          path = valuePath();
        }
        findings.push(...scanTextForCredentials(path, decoded));
        // A workshop field or JSON key can itself contain encoded source.
        // Process shorter decoded strings iteratively, without recursive depth.
        const nested = decoded.trimStart()[0];
        if (nested === "{" || nested === "[" || nested === '"')
          pending.push({ field: path, text: decoded, root: false });
      }
      if (findings.length >= MAX_FINDINGS) return findings.slice(0, MAX_FINDINGS);
    }
  }
  return findings.slice(0, MAX_FINDINGS);
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
      : ` (${first.kind} at ${diagnosticPath(first.path)} line ${first.line}, column ${first.column})`;
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
        path: diagnosticPath(finding.path),
        kind: finding.kind,
        line: finding.line,
        column: finding.column,
      })),
    },
    headers: { "cache-control": "private, no-store" },
  });
}
