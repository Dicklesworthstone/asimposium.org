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
  // The bare exchange value has the full 43-character base64url secret;
  // short version labels (v1.2, v1.0-rc1) are ordinary scientific content.
  // One alternative also covers complete join URLs without double-reporting
  // their embedded fragment on the shared artifact scan.
  {
    kind: "enrollment-secret",
    pattern: /ASIMP-EN-[0-9A-Za-z-]{4,}#v1\.[A-Za-z0-9_-]{16,}|\bv1\.[A-Za-z0-9_-]{43,}/,
  },
  // Body-only enrollment polling and device-code credentials use this same
  // frame. A public proposal ID is harmless; its flow handle is authority.
  { kind: "prefixed-grant", pattern: /\bflow_v1\.[A-Za-z0-9_-]{43,}/ },
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

/** Match whole credential-name segments, never words such as token_count or
 * secreted. An underscore prefix is common in copied environment settings. */
const CREDENTIAL_LABEL_SOURCE = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*_)?(?:password|passwd|pwd|secret|token|api_?key|private_key|secret_access_key)`;
const CREDENTIAL_LABEL = new RegExp(`^${CREDENTIAL_LABEL_SOURCE}$`, "i");

function credentialLabelKind(label: string): CredentialKind | null {
  if (!CREDENTIAL_LABEL.test(label)) return null;
  return /(?:^|_)(?:api_?key|secret_access_key)$/i.test(label) ? "api-key" : "access-token";
}

/** Exempt only explicit placeholders and references, not weak or short secrets.
 * These are useful in reproducibility instructions without publishing authority. */
function inertCredentialValue(value: string): boolean {
  const text = value.trim();
  return (
    text.length === 0 ||
    /^(?:\*{3,}|x{4,}|\.{3,}|…+|\[redacted\]|<redacted>|redacted|\[removed\]|<removed>|\[masked\]|<masked>)$/i.test(
      text,
    ) ||
    /^<(?:your[_ -]?)?(?:password|passwd|pwd|secret|token|api[_ -]?key|private[_ -]?key|replace[_ -]?me)>$/i.test(
      text,
    ) ||
    /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(text) ||
    /^%[A-Za-z_][A-Za-z0-9_]*%$/.test(text) ||
    /^\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/.test(text)
  );
}

function sourceCredentialReference(value: string): boolean {
  return (
    /^(?:process\.env\.[A-Za-z_][A-Za-z0-9_]*|(?:process\.env|os\.environ)\[\s*["'][A-Za-z_][A-Za-z0-9_]*["']\s*\])$/.test(
      value,
    ) || /^(?:os\.)?getenv\(\s*["'][A-Za-z_][A-Za-z0-9_]*["']\s*\)$/.test(value)
  );
}

function decodeLiteral(value: string): string {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      // Shell-style quotes need not be valid JSON. Escapes still belong to the
      // literal; malformed JSON must not turn a credential into a clean body.
    }
  }
  return value.slice(1, -1).replace(/\\([\\"'])/g, "$1");
}

export interface CredentialRun {
  readonly kind: CredentialKind;
  readonly start: number;
  readonly end: number;
}

/** Shared literal detection for ledger/workshop and artifact bodies. A run
 * exposes offsets only, never a matched value. Limits bound the diagnostic
 * caller; the artifact predicate can stop at its first run. */
export function* credentialRuns(
  lineText: string,
  maxPerPattern = Number.POSITIVE_INFINITY,
): Generator<CredentialRun> {
  for (const { kind, pattern } of CREDENTIAL_PATTERNS) {
    const matcher = new RegExp(pattern.source, pattern.flags.replaceAll("g", "") + "g");
    let count = 0;
    for (const hit of lineText.matchAll(matcher)) {
      yield { kind, start: hit.index, end: hit.index + hit[0].length };
      if (++count === maxPerPattern) break;
    }
  }

  // A scheme plus a password-bearing userinfo component is authority even
  // when its password has no vendor prefix. Bound the scheme grammar so a
  // long dotted scientific identifier cannot induce quadratic backtracking.
  const uri = /\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/([^\s/?#"'`\\]+)/g;
  let uriCount = 0;
  for (const hit of lineText.matchAll(uri)) {
    const authority = hit[1]!;
    const at = authority.lastIndexOf("@");
    const colon = authority.indexOf(":");
    if (colon < 0 || at <= colon + 1 || at === authority.length - 1) continue;
    const encodedPassword = authority.slice(colon + 1, at);
    let password = encodedPassword;
    try {
      password = decodeURIComponent(password);
    } catch {
      // Invalid percent encoding is still a nonempty password-shaped literal.
    }
    if (inertCredentialValue(password)) continue;
    const start = hit.index + hit[0].indexOf("://") + 3 + colon + 1;
    yield { kind: "access-token", start, end: start + encodedPassword.length };
    if (++uriCount === maxPerPattern) break;
  }

  // '=' accepts .env/shell/code assignments; ':' requires a quoted key or
  // quoted value, avoiding ordinary source annotations such as token: String.
  // Recognize spaced environment lookups as complete source expressions; the
  // ordinary unquoted alternative ends at whitespace so an inert assignment
  // cannot swallow a later credential on the same line.
  const assignment = new RegExp(
    String.raw`(?:^|[^A-Za-z0-9_$])(?:"(${CREDENTIAL_LABEL_SOURCE})"|'(${CREDENTIAL_LABEL_SOURCE})'|(${CREDENTIAL_LABEL_SOURCE}))[ \t]*(=(?!=|>)|:(?![=:]))[ \t]*("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|(?:process\.env|os\.environ)\[[^\r\n]*?\](?=[ \t]*(?:$|[;,#}]))|(?:os\.)?getenv\([^\r\n]*?\)(?=[ \t]*(?:$|[;,#}]))|\$\{[A-Za-z_][A-Za-z0-9_]*\}(?=$|[\s;,}])|\{\{[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*\}\}(?=$|[\s;,}])|[^\s;,}"']+)`,
    "gi",
  );
  let assignmentCount = 0;
  for (const hit of lineText.matchAll(assignment)) {
    const label = hit[1] ?? hit[2] ?? hit[3]!;
    const kind = credentialLabelKind(label);
    if (kind === null) continue;
    const raw = hit[5]!.trimEnd();
    const quoted = raw.startsWith('"') || raw.startsWith("'");
    if (hit[4] === ":" && !hit[1] && !hit[2] && !quoted) continue;
    const offset = hit.index + hit[0].lastIndexOf(hit[5]!);
    const rest = lineText.slice(hit.index + hit[0].length);
    const continued = /^[ \t]*[+|&?]/.test(rest) || (quoted && /^[^\s;,}\]]/.test(rest));
    if (!continued && !quoted && sourceCredentialReference(raw)) continue;
    if (!continued && !quoted && inertCredentialValue(raw)) continue;
    // Bare lowercase token/secret are also common mathematical or parser
    // variables. Calls and operator expressions are source, not literal keys.
    // Keep this ambiguity rule off explicit prefixed/uppercase env names so
    // a weak .env password is not excused merely for containing punctuation.
    if (
      !quoted &&
      !continued &&
      (/^(?:token|secret|password|passwd|pwd|api_?key)$/.test(label) ||
        /\b(?:const|let|var)[ \t]+$/.test(lineText.slice(0, hit.index + 1))) &&
      /^(?:await[ \t]+|new[ \t]+|[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*[ \t]*\(|[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*|[A-Za-z_$][A-Za-z0-9_$]*[ \t]*[+*/%<>=!?|&-])/.test(
        lineText.slice(offset),
      )
    )
      continue;
    const literal = quoted ? decodeLiteral(raw) : raw;
    if (!continued && inertCredentialValue(literal)) continue;
    const start = offset + (quoted ? 1 : 0);
    yield { kind, start, end: start + Math.max(1, quoted ? raw.length - 2 : literal.length) };
    if (++assignmentCount === maxPerPattern) break;
  }
}

export function hasCredentialShape(text: string): boolean {
  return hasRawCredentialShape(text) || !structuredCredentialRuns(text).next().done;
}

function hasRawCredentialShape(text: string): boolean {
  return !credentialRuns(text, 1).next().done;
}

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
  if (path.length > MAX_PATH_LENGTH || /[\r\n\t]/.test(path) || hasRawCredentialShape(path))
    return REDACTED_PATH;
  return path || "[root]";
}

function appendPath(parent: string, suffix: string): string {
  if (parent === NESTED_PATH) return NESTED_PATH;
  const path = `${parent}${suffix}`;
  return path.length > MAX_PATH_LENGTH ? NESTED_PATH : diagnosticPath(path);
}

function memberPath(parent: string, key: string, index: number): string {
  if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) && !hasRawCredentialShape(key))
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
    for (const { kind, start, end } of credentialRuns(lineText, MAX_FINDINGS)) {
      if (spans.some(([from, to]) => start < to && end > from)) continue;
      spans.push([start, end]);
      lineFindings.push({ kind, start });
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
  credentialKind?: CredentialKind | null;
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
    const tokens =
      /"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;
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
        frame.credentialKind = null;
      } else if (value.startsWith('"')) {
        const decoded = JSON.parse(value) as string;
        let path: string;
        if (frame?.kind === "object" && frame.expectingKey) {
          path = appendPath(frame.path, `[key:${frame.index}]`);
          frame.keyPath = memberPath(frame.path, decoded, frame.index);
          frame.credentialKind = credentialLabelKind(decoded);
          frame.expectingKey = false;
        } else {
          path = valuePath();
        }
        const shaped = scanTextForCredentials(path, decoded);
        if (
          frame?.kind === "object" &&
          path === frame.keyPath &&
          frame.credentialKind &&
          shaped.length === 0 &&
          !inertCredentialValue(decoded)
        ) {
          shaped.push({
            path,
            kind: frame.credentialKind,
            line: 1,
            column: 1,
          });
        }
        findings.push(...shaped);
        // A workshop field or JSON key can itself contain encoded source.
        // Process shorter decoded strings iteratively, without recursive depth.
        const nested = decoded.trimStart()[0];
        if (nested === "{" || nested === "[" || nested === '"')
          pending.push({ field: path, text: decoded, root: false });
      } else if (frame?.kind === "object" && frame.credentialKind && /^-?\d/.test(value)) {
        findings.push({
          path: frame.keyPath ?? frame.path,
          kind: frame.credentialKind,
          line: 1,
          column: 1,
        });
      }
      if (findings.length >= MAX_FINDINGS) return findings.slice(0, MAX_FINDINGS);
    }
  }
  return findings.slice(0, MAX_FINDINGS);
}

/** JSON artifact fallback. Escaped keys, encoded URI separators and multiline
 * key/value pairs use the same decoded-field scanner as request bodies. The
 * diagnostic location is the containing source token, never an offset into
 * decoded bytes that do not physically exist in the artifact. */
export function* structuredCredentialRuns(text: string): Generator<CredentialRun> {
  if (!['"', "{", "["].includes(text.trimStart()[0] ?? "")) return;
  try {
    JSON.parse(text);
  } catch {
    return;
  }
  const frames: Array<{ object: boolean; expectingKey: boolean; kind: CredentialKind | null }> = [];
  const tokens =
    /"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;
  let count = 0;
  for (const token of text.matchAll(tokens)) {
    const value = token[0];
    const frame = frames.at(-1);
    if (value === "{" || value === "[") {
      frames.push({ object: value === "{", expectingKey: value === "{", kind: null });
    } else if (value === "}" || value === "]") {
      frames.pop();
    } else if (value === "," && frame) {
      frame.expectingKey = frame.object;
      frame.kind = null;
    } else if (value.startsWith('"')) {
      const decoded = JSON.parse(value) as string;
      const key = frame?.object && frame.expectingKey;
      if (key) {
        frame.kind = credentialLabelKind(decoded);
        frame.expectingKey = false;
      }
      const kinds = new Set(
        scanFieldForCredentials("artifact", decoded).map((finding) => finding.kind),
      );
      if (!key && frame?.object && frame.kind && !inertCredentialValue(decoded))
        kinds.add(frame.kind);
      for (const kind of kinds) {
        yield { kind, start: token.index + 1, end: token.index + value.length - 1 };
        if (++count === MAX_FINDINGS) return;
      }
    } else if (frame?.object && frame.kind && /^-?\d/.test(value)) {
      yield { kind: frame.kind, start: token.index, end: token.index + value.length };
      if (++count === MAX_FINDINGS) return;
    }
  }
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
