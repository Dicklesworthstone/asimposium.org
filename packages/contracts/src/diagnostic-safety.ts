/**
 * The canonical never-log credential scanner (bead asimposiumorg-233, OPS.2a).
 *
 * Every ASImposium runner that prints a structured diagnostic has to answer the
 * same question — "could this string be a secret?" — and until this module
 * existed each one answered it separately. Those copies disagreed: one required
 * four characters after `asimp_ag_` while another accepted one, one had no
 * `Bearer` pattern at all, and one bounded a long hex run at a word boundary
 * while another did not. A value refused by one runner was printed by the next.
 *
 * This is the union of those vocabularies, and it lives in `packages/contracts`
 * because that is the lowest package every consumer already depends on. A
 * package must never import upward from `scripts/`.
 *
 * Scope is deliberately narrow. This module knows credential *shapes* only. It
 * does not know about repository roots or home directories: those are the
 * dispatcher's concern, need a caller-supplied path, and would drag `node:os`
 * into a package that is bundled into a Worker.
 *
 * It also deliberately carries **no generic-entropy heuristic**. A rule like
 * "mixed case plus digits over N characters" refuses ordinary identifiers —
 * seeds, run ids, assertion names — and a diagnostic that refuses to print a
 * legitimate identifier is an outage in the evidence path, not a safety win.
 * Every class below matches a credential family this project actually mints or
 * carries (Fable §5.2, §5.5, §14.2).
 */

/**
 * Credential families in their full, unclipped form.
 *
 * The `sk`/`rk`/`pk` family carries an optional `_live`/`_test` environment
 * segment because the vendors mint both `sk-…` and `sk_live_…`; matching only
 * the hyphen form left every live-mode key printable. `github_pat_` is a
 * separate family from `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` — `gh[pousr]_` cannot
 * match it, since `github_pat_` has `i` where that class expects one of
 * `p o u s r`.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // ASImposium Fellow bearer tokens and enrollment fragment secrets (Fable §5.2, §5.5).
  /asimp_ag_[A-Za-z0-9_-]{4,}/g,
  /#v1\.[A-Za-z0-9._~-]{8,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi,
  // Common third-party credential shapes, so a misconfigured child never leaks through a
  // dispatcher-authored field.
  /\b(?:sk|rk|pk)(?:_(?:live|test))?[-_][A-Za-z0-9_-]{12,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  // A truncated key block is not safer than a whole one: close on the END
  // marker when it survived the capture, and on end-of-input when it did not.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/**
 * Capture ceilings can cut a credential halfway through, and a clipped secret is
 * no safer to print than a whole one.
 *
 * These are deliberately **terminal-only**. An earlier revision ended each
 * pattern with a negative lookahead, which made them fire mid-sentence: a
 * `{0,7}` run followed by a space satisfies "not another credential character",
 * so ordinary prose like `Bearer tokens are hashed` and a version string like
 * `pk-3` were rewritten to `<redacted>`. Truncation only ever happens at the end
 * of a captured value, so anchoring to end-of-input keeps every real clipped
 * secret and stops the scanner from eating documentation. Trailing whitespace is
 * tolerated because a capture usually ends with a newline.
 */
const CLIPPED_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /asimp_ag_[A-Za-z0-9_-]{0,3}\s*$/g,
  /#v1\.[A-Za-z0-9._~-]{0,7}\s*$/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{0,7}\s*$/gi,
  // The `_live_`/`_test_` prefix has no benign reading, so any remainder is
  // clipped. The bare hyphen form does: `pk-3` and `sk-1` are ordinary version
  // and profile strings, and a truncation leaving three characters or fewer
  // carries no usable secret. Four is the floor where a clipped key becomes
  // more plausible than a revision number.
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]{0,11}\s*$/g,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{4,11}\s*$/g,
  /\bgithub_pat_[A-Za-z0-9_]{0,21}\s*$/g,
  /\bgh[pousr]_[A-Za-z0-9]{0,15}\s*$/g,
  /\bAIza[0-9A-Za-z_-]{0,19}\s*$/g,
];

/**
 * Fields whose *label* already declares the value a secret, and query
 * parameters that carry one.
 *
 * These need no shape heuristic: `password: …` is a secret because it says so.
 * Both forms keep the label and replace only the value — a diagnostic that says
 * `token: <redacted>` tells an operator which field was withheld, while
 * swallowing the label would leave them guessing, and both are equally safe.
 *
 * Ordering against the shape classes above is load-bearing. `authorization` is
 * a labelled field *and* `Bearer …` is a shape, and the unquoted value class
 * stops at the first delimiter. Run the label pass first and
 * `Authorization: Bearer abc123` becomes `Authorization: <redacted> abc123` —
 * the value tail survives. Run the shape pass first and the Bearer class
 * consumes the whole value, after which the label pass is idempotent over
 * `<redacted>`. The rule list below is therefore applied in order, shapes first.
 *
 * Two value classes, because two kinds of field are involved. A token-shaped
 * field holds one opaque value, so its unquoted class stops at the first
 * delimiter and an adjacent word survives — widening it would eat the rest of a
 * log line. A *body* field holds private prose, where stopping at the first
 * space prints the sentence; those consume through end of line instead, and
 * treat only CR/LF as a boundary because prose punctuation is not a delimiter.
 *
 * Quoted values are escape-aware in both classes. `"[^"]*"` ends at the first
 * `"`, so a JSON body containing `\"` would close the match early and print
 * everything after it; `"(?:\\.|[^"\\])*"` consumes the escape and its escaped
 * character together.
 *
 * The replacement echoes only the captured label — a fixed alternation of
 * literal field names plus its separator — never any part of the value.
 *
 * `&` is a delimiter here, which is one deliberate divergence from the runner:
 * without it, `?signature=abc&page=2` redacts the page number too, because `&`
 * would otherwise be an ordinary value character. Stopping at `&` lets the
 * global replace treat each `key=value` pair independently, so every secret
 * parameter is redacted and every ordinary one survives.
 */
const LABELLED_SECRET_PATTERNS: readonly RegExp[] = [
  // Line-valued fields: everything after the separator belongs to the field.
  //
  // Two kinds qualify. Private prose — `directive_body`, `workshop_body` —
  // carries sentences, so a short-token class redacts `find` and prints `the
  // counterexample`. Structured headers — `authorization`, `cookie`,
  // `set-cookie` — carry a scheme plus a credential, or a whole `;`-separated
  // attribute list, so a short-token class redacts `Bearer` and prints the
  // token after it, or redacts `sid=abc` and prints `other=secret`.
  //
  // The unquoted value therefore runs to CR/LF and to nothing else. `,` and `;`
  // are punctuation inside prose, and attribute separators inside a cookie, far
  // more often than they end a record — `prove lemma, then reveal witness` and
  // `sid=abc; other=secret` both end the match early and print the remainder.
  // Only a line break is an unambiguous boundary. Redacting a status token that
  // happened to share the line is the accepted trade against leaking a body or
  // a credential.
  //
  // A quoted value still wins the alternation and stays bounded to its closing
  // quote, so a JSON sibling on the same line survives.
  /(\b(?:authorization|cookie|set-cookie|directive_body|workshop_body)"?\s*(?:=|:)\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]+)/gi,
  // Assignment form for token-shaped fields: `password: hunter2`,
  // `"token": "abc"`. These hold a single opaque value, so the value class stops
  // at the first delimiter and an adjacent word survives.
  // `signature` precedes `sig` so the longer field wins the alternation, and
  // `authorization_code` is scalar even though `authorization` is line-valued:
  // the separator requirement keeps the line rule from matching its prefix.
  /(\b(?:token|access_token|refresh_token|id_token|secret|password|signature|sig|authorization_code)"?\s*(?:=|:)\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/gi,
  // Query form: `?token=…`, `&code=…`. The value ends at the next parameter,
  // fragment or whitespace.
  /([?&](?:token|access_token|code|signature|sig)=)[^&#\s]+/gi,
];

/** The replacement every consumer prints in place of a credential-shaped run. */
export const REDACTED_TOKEN = "<redacted>";

/**
 * Replace every credential-shaped run with `REDACTED_TOKEN`.
 *
 * The patterns are module-level and carry the `g` flag, so each call resets
 * `lastIndex` by using `String.prototype.replace`, which always restarts a
 * global regex. Detection below is expressed in terms of this function rather
 * than `RegExp.prototype.test`, whose `lastIndex` advance on a global pattern
 * is exactly the kind of stateful surprise a safety scanner must not have.
 */
export function redactCredentials(text: string): string {
  let output = text;
  // Shapes first, then labels. See LABELLED_SECRET_PATTERNS: reversing this
  // leaves a value tail on `Authorization: Bearer …`.
  for (const pattern of [...CREDENTIAL_PATTERNS, ...CLIPPED_CREDENTIAL_PATTERNS]) {
    output = output.replace(pattern, REDACTED_TOKEN);
  }
  for (const pattern of LABELLED_SECRET_PATTERNS) {
    output = output.replace(pattern, `$1${REDACTED_TOKEN}`);
  }
  return output;
}

/**
 * True when `text` carries a credential shape. Defined as "redaction would
 * change it" so a caller can never be refused by a rule that redaction does not
 * also apply — one behaviour, one source of truth.
 */
export function containsCredentialShape(text: string): boolean {
  return redactCredentials(text) !== text;
}
