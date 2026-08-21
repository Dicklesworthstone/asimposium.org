import { describe, expect, test } from "bun:test";

import {
  containsCredentialShape,
  REDACTED_TOKEN,
  redactCredentials,
} from "../../src/diagnostic-safety.ts";
import { REPRODUCE, safeDiagnostic } from "../../src/diagnostics.ts";
import { EnrollmentFlowHandleSchema, EnrollmentSecretSchema } from "../../src/enrollment.ts";

/**
 * The shared never-log scanner (bead asimposiumorg-233, OPS.2a).
 *
 * Each case names one credential class and asserts the **exact** rewritten
 * string. `toContain(REDACTED_TOKEN)` would pass while leaving key bytes beside
 * the marker, which is the failure this module exists to prevent.
 *
 * Delete any one class and exactly one test here must fail.
 */

describe("full credential classes are refused", () => {
  for (const [name, sample] of [
    ["Fellow bearer token", "asimp_ag_01JXYZABCDEF_s3cr3tvalue"],
    ["enrollment fragment secret", "#v1.AAAAAAAAAAAAAAAAAAAA"],
    ["secret-key hyphen form", "sk-0123456789abcdefghij"],
    ["restricted-key hyphen form", "rk-0123456789abcdefghij"],
    ["publishable-key hyphen form", "pk-0123456789abcdefghij"],
    ["secret-key live form", "sk_live_0123456789abcdefghij"],
    ["restricted-key live form", "rk_live_0123456789abcdefghij"],
    ["publishable-key live form", "pk_live_0123456789abcdefghij"],
    ["secret-key test form", "sk_test_0123456789abcdefghij"],
    ["GitHub classic token", "ghp_0123456789abcdefghij"],
    ["GitHub fine-grained token", "github_pat_0123456789abcdefghijklmnopqrstuv"],
    ["Google API key", "AIzaSyA0123456789abcdefghijklmnopqrs"],
  ] as const) {
    test(`${name} is replaced entirely`, () => {
      expect(redactCredentials(sample)).toBe(REDACTED_TOKEN);
      expect(containsCredentialShape(sample)).toBe(true);
    });
  }

  test("a Bearer header keeps its field name and loses its value", () => {
    expect(redactCredentials("Authorization: Bearer abcdef0123456789")).toBe(
      `Authorization: ${REDACTED_TOKEN}`,
    );
  });

  // `gh[pousr]_` declares five prefixes. Testing only `ghp_` leaves four
  // character-class branches unproven, so each family is planted separately.
  for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr"] as const) {
    test(`GitHub ${prefix}_ token is replaced entirely`, () => {
      expect(redactCredentials(`${prefix}_0123456789abcdefghij`)).toBe(REDACTED_TOKEN);
    });
  }

  test("two secrets of the same family are both replaced, not just the first", () => {
    // Every pattern carries `g`. Without it `String.replace` rewrites only the
    // first occurrence and the second prints verbatim.
    const redacted = redactCredentials(
      "first ghp_0123456789abcdefghij then ghp_zyxwvutsrq987654321",
    );
    expect(redacted).toBe(`first ${REDACTED_TOKEN} then ${REDACTED_TOKEN}`);
    expect(redacted).not.toContain("0123456789abcdefghij");
    expect(redacted).not.toContain("zyxwvutsrq987654321");
  });

  test("a complete private key block is replaced whole", () => {
    const key = "-----BEGIN TEST PRIVATE KEY-----\nabc\ndef\n-----END TEST PRIVATE KEY-----";
    expect(redactCredentials(key)).toBe(REDACTED_TOKEN);
  });

  test("a private key truncated before its END marker is still replaced", () => {
    // The capture ceiling cut the block. Closing only on END would print the
    // header and every key byte that survived.
    const truncated = "-----BEGIN TEST PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ";
    expect(redactCredentials(truncated)).toBe(REDACTED_TOKEN);
  });
});

describe("the bare enrollment fragment secret is refused (ADR-20)", () => {
  // The secret is minted, submitted, and stored WITHOUT the `#`; the `#` is only
  // the URL-fragment delimiter, never part of the secret. Matching only the
  // `#v1.` form left the shape a diagnostic actually meets — bare `v1.<material>`
  // — printable, and left this canonical scanner strictly weaker than the sibling
  // `apps/wire/src/http/redact.ts` for the one family they share (bead
  // asimposiumorg-diagnostic-safety-bare-v1-secret).

  // 43 base64url characters: the exact minted frame (32 random bytes).
  const MINTED_MATERIAL = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_ABCDE";
  const BARE_SECRET = `v1.${MINTED_MATERIAL}`;

  test("the plant is the real minted frame, not an arbitrary literal", () => {
    // Causal tie: the plant is exactly what `EnrollmentSecretSchema` mints and
    // accepts, so if the frame ever changes this guard fails before the redaction
    // assertions can pass vacuously.
    expect(MINTED_MATERIAL.length).toBe(43);
    expect(EnrollmentSecretSchema.safeParse(BARE_SECRET).success).toBe(true);
    // The `#`-anchored form is a URL artefact the schema rejects, proving the
    // secret itself carries no `#` and the bare shape is the one to catch.
    expect(EnrollmentSecretSchema.safeParse(`#${BARE_SECRET}`).success).toBe(false);
  });

  test("the bare minted secret is replaced entirely", () => {
    expect(redactCredentials(BARE_SECRET)).toBe(REDACTED_TOKEN);
    expect(containsCredentialShape(BARE_SECRET)).toBe(true);
  });

  test("a bare secret in a non-secret field is caught by shape alone", () => {
    // `note` is not a labelled never-log field, so only the shape class can
    // catch the pasted secret — this proves the fix, not the label rule.
    const redacted = redactCredentials(`{"note":"pasted ${BARE_SECRET} by mistake"}`);
    expect(redacted).not.toContain(MINTED_MATERIAL);
    expect(redacted).toContain(REDACTED_TOKEN);
    expect(redacted).toContain("by mistake");
  });

  test("a capture-clipped bare secret is still replaced", () => {
    // A buffer cut the 43-char secret; a clipped secret is no safer than a whole
    // one. 28 base64url characters remain — above the 24 floor — so the shape
    // class still fires, which is why this family needs no terminal sub-floor
    // variant the way `#v1.`, `asimp_ag_` and `Bearer` do.
    const clipped = `v1.${"AbCdEfGhIjKlMnOpQrStUvWx1234"}`;
    expect(clipped.length).toBe("v1.".length + 28);
    expect(redactCredentials(clipped)).toBe(REDACTED_TOKEN);
    expect(containsCredentialShape(clipped)).toBe(true);
  });

  test("a bare secret at the end of a longer capture keeps the prose", () => {
    expect(redactCredentials(`minted at 12:04 for run 7: ${BARE_SECRET}`)).toBe(
      `minted at 12:04 for run 7: ${REDACTED_TOKEN}`,
    );
  });

  test("a bare secret followed by a captured newline loses its value", () => {
    const redacted = redactCredentials(`${BARE_SECRET}\n`);
    expect(redacted).not.toContain(MINTED_MATERIAL);
    expect(redacted).toBe(`${REDACTED_TOKEN}\n`);
  });

  test("the floor is exactly 24 base64url characters", () => {
    // One below the floor survives; the floor itself is refused. This pins the
    // number so a mutation in either direction fails here.
    const belowFloor = `v1.${"A".repeat(23)}`;
    const atFloor = `v1.${"A".repeat(24)}`;
    expect(redactCredentials(belowFloor)).toBe(belowFloor);
    expect(containsCredentialShape(belowFloor)).toBe(false);
    expect(redactCredentials(atFloor)).toBe(REDACTED_TOKEN);
    expect(containsCredentialShape(atFloor)).toBe(true);
  });

  // Near-miss negatives: ordinary `v1.` version tokens must survive, or the
  // scanner becomes an outage in the evidence path. The sibling path redactor
  // can redact every `v1.` because a URL path segment is not prose; a free-form
  // diagnostic scanner cannot, so the frame — base64url only, 24-char floor — is
  // what keeps these alive while the minted secret above is refused.
  for (const [name, sample] of [
    ["minor version token", "v1.2"],
    ["prerelease version token", "v1.x"],
    ["patch version chain", "v1.2.3"],
    ["dotted schema coordinate", "enrollment-capsule.v1.json"],
    ["build metadata below the floor", "v1.0-rc1-build-2026a"],
    // `.` is not base64url, so a dotted chain cannot accumulate length across its
    // separators however long it runs; widening the charset would break this.
    ["long dotted version chain", "v1.1.2.3.4.5.6.7.8.9.10.11.12.13.14"],
    ["twenty base64url chars below the floor", "v1.AbCdEfGhIj0123456789"],
  ] as const) {
    test(`${name} is left alone`, () => {
      expect(redactCredentials(sample)).toBe(sample);
      expect(containsCredentialShape(sample)).toBe(false);
    });
  }
});

describe("the enrollment flow handle / device code shape is refused (asimposiumorg-233.1)", () => {
  // EnrollmentFlowHandleSchema (enrollment.ts) is `^flow_v1\.<43 base64url>$` and is
  // the type of both `flow_handle` (the opaque body-only polling credential) and the
  // device flow's `device_code`. The minted `flow_v1.` prefix — distinct from a bare
  // `v1.` version token — is redacted by shape, and, being self-declaring, also
  // carries a terminal-clipped form. A separate pattern is required rather than
  // widening bare `v1.`, because `\bv1\.` cannot match inside `flow_v1.`: the `_v`
  // seam has no word boundary.
  const FLOW_MATERIAL = "a".repeat(43);
  const FLOW_HANDLE = `flow_v1.${FLOW_MATERIAL}`;

  test("the plant is the real minted flow-handle frame, not an arbitrary literal", () => {
    expect(FLOW_MATERIAL.length).toBe(43);
    expect(EnrollmentFlowHandleSchema.safeParse(FLOW_HANDLE).success).toBe(true);
    // The schema pins the exact 43-scalar frame, so this plant cannot pass vacuously
    // on a short literal: a bare or clipped prefix is not itself a valid handle.
    expect(EnrollmentFlowHandleSchema.safeParse("flow_v1.aaa").success).toBe(false);
  });

  test("the whole flow handle is replaced by the shape alone", () => {
    expect(redactCredentials(FLOW_HANDLE)).toBe(REDACTED_TOKEN);
    expect(containsCredentialShape(FLOW_HANDLE)).toBe(true);
  });

  test("a flow handle pasted into a non-secret field is caught by shape", () => {
    const redacted = redactCredentials(`{"note":"polled ${FLOW_HANDLE} once"}`);
    expect(redacted).not.toContain(FLOW_MATERIAL);
    expect(redacted).toContain(REDACTED_TOKEN);
    expect(redacted).toContain("once");
  });

  test("a capture-clipped flow handle above the floor is still replaced", () => {
    expect(redactCredentials(`flow_v1.${"a".repeat(28)}`)).toBe(REDACTED_TOKEN);
  });

  test("a flow handle clipped below the floor is refused only at the end of a capture", () => {
    // Unlike the bare `v1.` family, `flow_v1.` is self-declaring, so a short
    // truncation at end-of-input is redacted; the terminal `\s*$` consumes a
    // captured newline, exactly as the other clipped classes do.
    expect(redactCredentials(`flow_v1.${"a".repeat(10)}`)).toBe(REDACTED_TOKEN);
    expect(redactCredentials(`flow_v1.${"a".repeat(10)}\n`)).toBe(REDACTED_TOKEN);
    // Both declared clipped-range endpoints are load-bearing: a bare prefix (zero
    // remainder) and exactly 23 base64url characters are each wholly redacted at end
    // of input; the 24-char mid-line case below proves the handoff to the full pattern.
    expect(redactCredentials("flow_v1.")).toBe(REDACTED_TOKEN);
    expect(redactCredentials(`flow_v1.${"a".repeat(23)}`)).toBe(REDACTED_TOKEN);
    // ...but a short remainder mid-line is left to the label class, not eaten.
    expect(redactCredentials(`flow_v1.${"a".repeat(10)} then more prose`)).toBe(
      `flow_v1.${"a".repeat(10)} then more prose`,
    );
  });

  test("the flow_v1 dot separator is load-bearing", () => {
    // A colon (a non-dot the `.` metacharacter would match) between `flow_v1` and 43
    // otherwise-valid base64url characters stays unmatched under the literal `\.`, so
    // it survives — but mutating that escaped dot to a bare wildcard would match the
    // colon and redact, reddening this test. `flow_v1.json` cannot prove this: its four
    // characters are below the 24-char floor, so an unescaped-dot mutant still misses.
    const colonSeparated = `flow_v1:${"a".repeat(43)}`;
    expect(redactCredentials(colonSeparated)).toBe(colonSeparated);
    expect(containsCredentialShape(colonSeparated)).toBe(false);
  });

  test("the shape floor is exactly 24 base64url characters", () => {
    // Mid-line (a trailing word, not end-of-input) so only the full pattern's floor
    // decides; the terminal-clipped form cannot fire here.
    const belowFloor = `flow_v1.${"a".repeat(23)} tail`;
    const atFloor = `flow_v1.${"a".repeat(24)} tail`;
    expect(redactCredentials(belowFloor)).toBe(belowFloor);
    expect(redactCredentials(atFloor)).toBe(`${REDACTED_TOKEN} tail`);
  });

  test("the word boundary keeps the scanner off `workflow_v1.`", () => {
    // `flow_v1.` is only a substring of `workflow_v1.`; the anchor must not match it,
    // or an ordinary versioned workflow reference would be eaten.
    const workflow = `workflow_v1.${FLOW_MATERIAL}`;
    expect(redactCredentials(workflow)).toBe(workflow);
    expect(containsCredentialShape(workflow)).toBe(false);
  });

  for (const [name, sample] of [
    ["a dotted chain cannot accumulate across the excluded dot", "flow_v1.1.2.3.4.5.6.7.8.9.10.11"],
    ["a tilde is outside the base64url charset", "flow_v1.~one~two~three~four~five~six~seven"],
    [
      "prose naming the prefix with a trailing space",
      "Everything after flow_v1. is a one-time handle.",
    ],
    ["a flow_v1 filename mid-line", "see flow_v1.json for the current config"],
    ["an ordinary three-part version chain", "v1.2.3"],
  ] as const) {
    test(`${name} is left alone`, () => {
      expect(redactCredentials(sample)).toBe(sample);
      expect(containsCredentialShape(sample)).toBe(false);
    });
  }
});

describe("a structurally strict three-segment JWT is refused by shape (asimposiumorg-233.1)", () => {
  // A bearer JWS is three base64url segments joined by dots whose first two are JSON
  // objects — the `{"alg":…}` header and the `{…}` claims — so both encode to `eyJ`.
  // The trailing boundary refuses a fourth dotted segment or base64url tail, so a JWE
  // is never partially accepted; the labelled `id_token` class is the defence there.
  const JWT = `eyJ${"a".repeat(30)}.eyJ${"b".repeat(37)}.${"c".repeat(43)}`;

  test("a bare JWT is replaced whole by its shape", () => {
    expect(redactCredentials(JWT)).toBe(REDACTED_TOKEN);
    expect(containsCredentialShape(JWT)).toBe(true);
  });

  test("a JWT in an unlabelled field is caught by shape, not label", () => {
    const redacted = redactCredentials(`{"note":"authenticated with ${JWT} earlier"}`);
    expect(redacted).not.toContain(JWT);
    expect(redacted).toContain(REDACTED_TOKEN);
    expect(redacted).toContain("earlier");
  });

  test("a JWT ending a sentence is redacted and the punctuation survives", () => {
    // The terminal-dot rule allows a period before a space or end of input, so a JWT
    // that ends a sentence is still caught rather than missed by the boundary.
    expect(redactCredentials(`${JWT} at 12:04`)).toBe(`${REDACTED_TOKEN} at 12:04`);
    expect(redactCredentials(`(${JWT})`)).toBe(`(${REDACTED_TOKEN})`);
    expect(redactCredentials(`saw ${JWT}. Then more.`)).toBe(`saw ${REDACTED_TOKEN}. Then more.`);
    expect(redactCredentials(`${JWT}.`)).toBe(`${REDACTED_TOKEN}.`);
  });

  test("the two escaped dot separators are load-bearing", () => {
    // Each sample is a valid eyJ-header / eyJ-claims / signature triple joined with a
    // colon — a non-dot that the `.` metacharacter would match — at exactly ONE
    // separator position. Under the literal `\.` neither matches, so both survive; but
    // mutating THAT escaped dot to a bare wildcard would match its colon and redact,
    // reddening this test. Colonising a single position (not both) is what makes each
    // dot individually load-bearing: a single-dot mutation is caught, not only the
    // simultaneous mutation of both.
    const colonAtFirst = `eyJ${"a".repeat(30)}:eyJ${"b".repeat(37)}.${"c".repeat(43)}`;
    const colonAtSecond = `eyJ${"a".repeat(30)}.eyJ${"b".repeat(37)}:${"c".repeat(43)}`;
    expect(redactCredentials(colonAtFirst)).toBe(colonAtFirst);
    expect(containsCredentialShape(colonAtFirst)).toBe(false);
    expect(redactCredentials(colonAtSecond)).toBe(colonAtSecond);
    expect(containsCredentialShape(colonAtSecond)).toBe(false);
  });

  for (const [name, sample] of [
    // Causal negatives: each removes exactly one structural requirement.
    [
      "a non-eyJ header segment is not the strict header shape",
      `${"z".repeat(33)}.eyJ${"b".repeat(37)}.${"c".repeat(43)}`,
    ],
    [
      "a non-eyJ payload segment is not the strict claims shape",
      `eyJ${"a".repeat(30)}.${"b".repeat(40)}.${"c".repeat(43)}`,
    ],
    [
      "a non-base64url `+` in the header remainder breaks the frame",
      `eyJ+${"a".repeat(36)}.eyJ${"b".repeat(37)}.${"c".repeat(43)}`,
    ],
    [
      "a non-base64url `+` in the payload breaks the frame",
      `eyJ${"a".repeat(30)}.eyJ+${"b".repeat(36)}.${"c".repeat(43)}`,
    ],
    [
      "a non-base64url `+` in the signature breaks the frame",
      `eyJ${"a".repeat(30)}.eyJ${"b".repeat(37)}.c+${"c".repeat(43)}`,
    ],
    ["a merged leading word character defeats the leading boundary", `x${JWT}`],
    [
      "a nonempty fourth dotted segment is refused whole, never partially accepted",
      `${JWT}.${"d".repeat(20)}`,
    ],
    ["a two-segment eyJ string is not a whole JWT", `eyJ${"a".repeat(30)}.eyJ${"b".repeat(37)}`],
    ["a non-eyJ three-part dotted string", "service.auth.core"],
    ["an ordinary three-part version chain", "v1.2.3"],
    ["a package coordinate", "@asimposium/wire.core.build"],
    [
      "prose naming the header prefix",
      "A JWT header base64url-encodes to eyJ before the first dot.",
    ],
  ] as const) {
    test(`${name} is left alone`, () => {
      expect(redactCredentials(sample)).toBe(sample);
      expect(containsCredentialShape(sample)).toBe(false);
    });
  }
});

describe("the enrollment flow labelled fields withhold their value (asimposiumorg-233.1)", () => {
  // flow_handle, device_code, and user_code are never-log by their label (Fable
  // §5.5): the opaque body-only polling handle, the device-flow code that carries the
  // same value, and the code that authorizes a sponsor-side pending-proposal lookup.
  // They are exact scalar labels — the shape class already redacts a `flow_v1.<…>`
  // value, so these controls use a non-shape value to prove the LABEL withholds it.
  for (const field of ["flow_handle", "device_code", "user_code"] as const) {
    test(`${field} keeps its label and drops an unquoted value`, () => {
      expect(redactCredentials(`${field}: opaque-value-123 status=ok`)).toBe(
        `${field}: ${REDACTED_TOKEN} status=ok`,
      );
      expect(redactCredentials(`${field}=opaque-value-123&next=2`)).toBe(
        `${field}=${REDACTED_TOKEN}&next=2`,
      );
    });

    test(`${field} consumes a quoted value whole so a JSON sibling survives`, () => {
      expect(redactCredentials(`{"${field}":"a value with spaces","step":"3"}`)).toBe(
        `{"${field}":${REDACTED_TOKEN},"step":"3"}`,
      );
    });

    test(`${field} named in prose without a separator is left alone`, () => {
      const prose = `The ${field} is opaque and is never written to a log.`;
      expect(redactCredentials(prose)).toBe(prose);
      expect(containsCredentialShape(prose)).toBe(false);
    });
  }
});

describe("clipped credential classes are refused at the end of a capture", () => {
  for (const [name, sample] of [
    ["truncated Fellow token", "asimp_ag_abc"],
    ["bare Fellow token prefix", "asimp_ag_"],
    ["truncated fragment secret", "#v1.abc"],
    ["short Bearer value", "Bearer abc1234"],
    ["truncated secret-key", "sk-abcd"],
    ["truncated live secret-key", "sk_live_abc"],
    ["truncated GitHub classic token", "ghp_abc"],
    ["truncated GitHub fine-grained token", "github_pat_abc"],
    ["truncated Google API key", "AIzaShort"],
  ] as const) {
    test(`${name} is replaced entirely`, () => {
      expect(redactCredentials(sample)).toBe(REDACTED_TOKEN);
      expect(containsCredentialShape(sample)).toBe(true);
    });
  }

  test("a clipped secret followed by a captured newline is still replaced", () => {
    expect(redactCredentials("ghp_abc\n")).toBe(REDACTED_TOKEN);
  });

  test("a clipped secret at the end of a longer capture keeps the prose", () => {
    expect(redactCredentials("minted at 12:04 for run 7: ghp_abc")).toBe(
      `minted at 12:04 for run 7: ${REDACTED_TOKEN}`,
    );
  });
});

describe("labelled never-log fields lose their value, not their name", () => {
  // These need no shape heuristic: the label declares the value a secret. Each
  // case asserts the exact rewritten string, so a surviving value tail fails.
  for (const [field, value] of [
    ["authorization", "Basic YWxhZGRpbjpvcGVuc2VzYW1l"],
    ["cookie", "asimp.session=abc123def456"],
    ["set-cookie", "asimp.session=abc123def456"],
    ["token", "abc123def456"],
    ["access_token", "abc123def456"],
    ["refresh_token", "abc123def456"],
    ["id_token", "eyJhbGciOiJSUzI1NiJ9.payload.sig"],
    ["secret", "hunter2hunter2"],
    ["password", "hunter2hunter2"],
    ["signature", "MEUCIQDabc123"],
    ["sig", "MEUCIQDabc123"],
    ["authorization_code", "4/0Aabc123def"],
    ["directive_body", "findthecounterexample"],
    ["workshop_body", "privateworkshopprose"],
  ] as const) {
    test(`${field} assignment keeps the label and drops the value`, () => {
      for (const separator of [": ", "=", " : ", ":"] as const) {
        const line = `${field}${separator}${value}`;
        const redacted = redactCredentials(line);
        expect(redacted).toBe(`${field}${separator}${REDACTED_TOKEN}`);
        expect(redacted).not.toContain(value);
      }
    });
  }

  test("a quoted value is consumed whole, including its spaces", () => {
    expect(redactCredentials('"token": "abc 123 def"')).toBe(`"token": ${REDACTED_TOKEN}`);
    expect(redactCredentials("password: 'two words'")).toBe(`password: ${REDACTED_TOKEN}`);
  });

  test("a labelled field inside a longer line loses only its value", () => {
    expect(redactCredentials("step=3 token=abc123def456 status=ok")).toBe(
      `step=3 token=${REDACTED_TOKEN} status=ok`,
    );
  });

  test("the field name is matched case-insensitively", () => {
    expect(redactCredentials("Set-Cookie: abc123def456")).toBe(`Set-Cookie: ${REDACTED_TOKEN}`);
    expect(redactCredentials("PASSWORD=hunter2hunter2")).toBe(`PASSWORD=${REDACTED_TOKEN}`);
  });

  test("signature wins the alternation over sig", () => {
    expect(redactCredentials("signature=MEUCIQDabc123")).toBe(`signature=${REDACTED_TOKEN}`);
  });

  test("a Basic authorization header leaves no base64 tail", () => {
    // `Basic <base64>` is a two-token value like `Bearer <token>`. Without the
    // scheme in the shape classes the label pass stops at `Basic` and prints
    // the credential that follows it.
    const redacted = redactCredentials("authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l");
    expect(redacted).toBe(`authorization: ${REDACTED_TOKEN}`);
    expect(redacted).not.toContain("YWxhZGRpbjpvcGVuc2VzYW1l");
  });

  test("a JSON-shaped field name is matched through its closing quote", () => {
    expect(redactCredentials('{"access_token":"abc123def456"}')).toBe(
      `{"access_token":${REDACTED_TOKEN}}`,
    );
  });

  test("an unquoted token-shaped value redacts its first token only", () => {
    // Token fields hold one opaque value; widening this class to end-of-line
    // would eat the rest of a log line. Body fields are handled separately
    // below, because for prose this behaviour would be a leak.
    expect(redactCredentials("token: abc123def456 status=ok")).toBe(
      `token: ${REDACTED_TOKEN} status=ok`,
    );
  });

  test("an Authorization header is redacted once, with no Bearer value tail", () => {
    // The shape pass consumes `Bearer …` first; the label pass is then
    // idempotent over the marker. Reversing the order would leave the token.
    const redacted = redactCredentials("Authorization: Bearer abcdef0123456789");
    expect(redacted).toBe(`Authorization: ${REDACTED_TOKEN}`);
    expect(redacted).not.toContain("abcdef0123456789");
    expect(redactCredentials(redacted)).toBe(redacted);
  });
});

describe("private body fields lose their whole value", () => {
  // `directive_body` and `workshop_body` carry sentences. Redacting only the
  // first word prints the rest of the private prose, so each case below asserts
  // the exact rewritten string and that no word of the body survives.
  for (const field of ["directive_body", "workshop_body"] as const) {
    test(`${field} multi-word prose is redacted in full`, () => {
      const redacted = redactCredentials(`${field}: find the counterexample`);
      expect(redacted).toBe(`${field}: ${REDACTED_TOKEN}`);
      for (const word of ["find", "the", "counterexample"]) {
        expect(redacted).not.toContain(word);
      }
    });

    test(`${field} prose containing token-like words leaks none of them`, () => {
      // The body mentions `token`, `secret` and `password`. None of those is a
      // separator-bearing assignment, so only the body rule can catch them.
      const body = "the token and secret password words are ordinary prose here";
      const redacted = redactCredentials(`${field}: ${body}`);
      expect(redacted).toBe(`${field}: ${REDACTED_TOKEN}`);
      for (const word of ["ordinary", "prose", "words", "here"]) {
        expect(redacted).not.toContain(word);
      }
    });

    test(`${field} stops at a newline and leaves the next record`, () => {
      expect(redactCredentials(`${field}: private prose here\nstep: 3`)).toBe(
        `${field}: ${REDACTED_TOKEN}\nstep: 3`,
      );
    });

    test(`${field} prose containing a comma leaks no clause`, () => {
      // A comma is punctuation inside a sentence far more often than a record
      // delimiter. Stopping there printed everything after it.
      const redacted = redactCredentials(`${field}: prove lemma, then reveal witness`);
      expect(redacted).toBe(`${field}: ${REDACTED_TOKEN}`);
      for (const word of ["prove", "lemma", "then", "reveal", "witness"]) {
        expect(redacted).not.toContain(word);
      }
    });

    test(`${field} prose containing a semicolon leaks no clause`, () => {
      const redacted = redactCredentials(`${field}: step one; step two; step three`);
      expect(redacted).toBe(`${field}: ${REDACTED_TOKEN}`);
      for (const word of ["step", "one", "two", "three"]) {
        expect(redacted).not.toContain(word);
      }
    });

    test(`${field} prose with mixed punctuation leaks nothing to end of line`, () => {
      const redacted = redactCredentials(
        `${field}: first, second; third — and a trailing clause status=ok`,
      );
      expect(redacted).toBe(`${field}: ${REDACTED_TOKEN}`);
      for (const word of ["first", "second", "third", "trailing", "clause", "status"]) {
        expect(redacted).not.toContain(word);
      }
    });

    test(`${field} redacts a trailing status token rather than leak prose`, () => {
      // The accepted trade: with no delimiter, an adjacent non-secret token is
      // swallowed. Losing `status=ok` is strictly better than printing prose.
      expect(redactCredentials(`${field}: private prose here status=ok`)).toBe(
        `${field}: ${REDACTED_TOKEN}`,
      );
    });

    test(`${field} with an escaped quote leaks no tail`, () => {
      // `"[^"]*"` would end at the `\"` and print everything after it.
      const line = `{"${field}":"prose with a \\" quote and more prose"}`;
      const redacted = redactCredentials(line);
      expect(redacted).toBe(`{"${field}":${REDACTED_TOKEN}}`);
      for (const word of ["prose", "quote", "more"]) {
        expect(redacted).not.toContain(word);
      }
    });
  }

  test("a short multi-token Authorization value leaks no credential", () => {
    // `Bearer abc` is below the full Bearer shape's minimum and is not at end
    // of input, so no shape class fires. Only the line rule can catch it; a
    // scalar rule redacts `Bearer` and prints `abc`.
    const redacted = redactCredentials("authorization: Bearer abc status=ok");
    expect(redacted).toBe(`authorization: ${REDACTED_TOKEN}`);
    expect(redacted).not.toContain("abc");
  });

  for (const field of ["cookie", "set-cookie"] as const) {
    test(`${field} attribute lists are redacted past every semicolon`, () => {
      const redacted = redactCredentials(`${field}: sid=abc; other=secret; Path=/`);
      expect(redacted).toBe(`${field}: ${REDACTED_TOKEN}`);
      for (const part of ["sid", "abc", "other", "secret", "Path"]) {
        expect(redacted).not.toContain(part);
      }
    });

    test(`${field} stops at a newline and leaves the next record`, () => {
      expect(redactCredentials(`${field}: sid=abc; other=secret\nstep: 3`)).toBe(
        `${field}: ${REDACTED_TOKEN}\nstep: 3`,
      );
    });
  }

  for (const field of ["authorization", "cookie", "directive_body"] as const) {
    test(`a quoted ${field} value stays bounded so a JSON sibling survives`, () => {
      const redacted = redactCredentials(`{"${field}":"a=b; c=d","step":"3"}`);
      expect(redacted).toBe(`{"${field}":${REDACTED_TOKEN},"step":"3"}`);
      expect(redacted).toContain('"step":"3"');
      expect(redacted).not.toContain("a=b");
    });
  }

  test("authorization_code stays scalar and leaves an adjacent field", () => {
    // The line rule's separator requirement stops `authorization` matching the
    // prefix of `authorization_code`, so this one keeps short-token behaviour.
    expect(redactCredentials("authorization_code=4/0Aabc123 step=3")).toBe(
      `authorization_code=${REDACTED_TOKEN} step=3`,
    );
  });

  test("an ordinary secret label with an escaped quote leaks no tail", () => {
    const redacted = redactCredentials('{"password":"hunter\\"2 tail"}');
    expect(redacted).toBe(`{"password":${REDACTED_TOKEN}}`);
    expect(redacted).not.toContain("tail");
    expect(redacted).not.toContain("hunter");
  });

  test("a single-quoted value with an escaped quote leaks no tail", () => {
    // The single-quote branch is a separate parser from the double-quote one.
    // Without its escape clause, `'[^']*'` ends at the `\'` and prints the rest.
    const redacted = redactCredentials("password: 'hunter\\'2 tail'");
    expect(redacted).toBe(`password: ${REDACTED_TOKEN}`);
    expect(redacted).not.toContain("tail");
    expect(redacted).not.toContain("hunter");
  });

  test("a single-quoted line-valued body with an escaped quote leaks no tail", () => {
    const redacted = redactCredentials("directive_body: 'prove \\'lemma\\' then reveal witness'");
    expect(redacted).toBe(`directive_body: ${REDACTED_TOKEN}`);
    for (const word of ["prove", "lemma", "reveal", "witness"]) {
      expect(redacted).not.toContain(word);
    }
  });
});

describe("query-string credentials lose their value", () => {
  for (const parameter of ["token", "access_token", "code", "signature", "sig"] as const) {
    test(`?${parameter}= is redacted`, () => {
      const url = `https://a.asimposium.org/v1/hello?${parameter}=abc123def456`;
      const redacted = redactCredentials(url);
      expect(redacted).toBe(`https://a.asimposium.org/v1/hello?${parameter}=${REDACTED_TOKEN}`);
      expect(redacted).not.toContain("abc123def456");
    });

    test(`&${parameter}= is redacted mid-query`, () => {
      const url = `https://a.asimposium.org/v1/hello?run=7&${parameter}=abc123def456&page=2`;
      const redacted = redactCredentials(url);
      expect(redacted).toBe(
        `https://a.asimposium.org/v1/hello?run=7&${parameter}=${REDACTED_TOKEN}&page=2`,
      );
      expect(redacted).not.toContain("abc123def456");
    });
  }

  test("a value ending at a fragment does not eat the fragment", () => {
    expect(redactCredentials("https://example.test/x?code=abc123#section")).toBe(
      `https://example.test/x?code=${REDACTED_TOKEN}#section`,
    );
  });
});

describe("ordinary prose survives", () => {
  // The clipped patterns were terminal-anchored because a negative lookahead
  // made every one of these fire mid-sentence. A scanner that cannot print
  // documentation is an outage in the evidence path, not a safety win.
  for (const [name, sample] of [
    ["Bearer discussed in prose", "Bearer tokens are hashed before storage."],
    ["Bearer at a sentence end", "The header carries a Bearer."],
    ["short version string", "pk-3 is the third publishable revision."],
    ["short hyphen identifier at end", "the profile is sk-1"],
    ["three-character hyphen suffix at end", "the lane is rk-abc"],
    ["fragment rule in prose", "Everything after #v1. stays in the fragment, never a log."],
    ["asimp prefix in prose", "Tokens use the asimp_ag_ prefix for secret scanning."],
    ["GitHub prefix in prose", "Classic tokens begin with ghp_ and fine-grained with github_pat_."],
  ] as const) {
    test(`${name} is left alone`, () => {
      expect(redactCredentials(sample)).toBe(sample);
      expect(containsCredentialShape(sample)).toBe(false);
    });
  }
});

describe("legitimate identifiers survive", () => {
  // The positive capability. A generic "mixed case plus digits over N chars"
  // heuristic refuses every one of these; the canonical scanner carries no such
  // rule and these lock that decision in.
  for (const [name, sample] of [
    ["mixed-case seed", "s5-Parent-Loss-XyZ-4821"],
    ["long run identifier", "s5-s5-fixed-seed-v1-Alpha7-23244"],
    ["assertion name", "served_md_etag_is_a_sha256_of_the_representation"],
    ["mixed-case scenario", "PLANTED-Checker-Timeout-Reaps-Exact-Group-2026"],
    ["sha256 digest field", `sha256:${"a".repeat(64)}`],
    ["ordinary scientific prose", "The bound holds for every n greater than 2."],
    ["package coordinate", "@asimposium/wire@0.0.0"],
  ] as const) {
    test(`${name} is left alone`, () => {
      expect(redactCredentials(sample)).toBe(sample);
      expect(containsCredentialShape(sample)).toBe(false);
    });
  }
});

describe("scanner behaviour is stateless", () => {
  // Every pattern carries the `g` flag. `RegExp.prototype.test` advances
  // `lastIndex` on a global pattern, so a scanner built on `test` answers
  // differently on a second identical call. Detection is defined in terms of
  // redaction precisely so this cannot happen.
  test("repeated calls on the same input agree", () => {
    const sample = "asimp_ag_01JXYZABCDEF_s3cr3tvalue";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(containsCredentialShape(sample)).toBe(true);
      expect(redactCredentials(sample)).toBe(REDACTED_TOKEN);
    }
  });

  test("interleaving a safe and an unsafe input does not leak state", () => {
    expect(containsCredentialShape("ghp_0123456789abcdefghij")).toBe(true);
    expect(containsCredentialShape("s5-Parent-Loss-XyZ-4821")).toBe(false);
    expect(containsCredentialShape("ghp_0123456789abcdefghij")).toBe(true);
  });
});

describe("safeDiagnostic scans its one free-form field", () => {
  // `status`, `code` and `reproduce` are closed vocabularies, so `suite` is the
  // only string a caller can shape. Every caller in this package passes a
  // literal today; this is the causal proof that a dynamic one cannot echo a
  // secret, and that the record is still emitted rather than thrown away.
  test("a credential-shaped suite name is redacted, and the record still parses", () => {
    const serialized = safeDiagnostic({
      suite: "ghp_0123456789abcdefghij",
      status: "invalid",
      startedAt: performance.now(),
      reproduce: REPRODUCE.unit,
    });
    const record = JSON.parse(serialized) as { readonly suite: string; readonly status: string };
    expect(record.suite).toBe(REDACTED_TOKEN);
    expect(serialized).not.toContain("ghp_0123456789abcdefghij");
    expect(record.status).toBe("invalid");
  });

  test("an ordinary suite name is untouched", () => {
    const serialized = safeDiagnostic({
      suite: "contract-drift",
      status: "pass",
      startedAt: performance.now(),
      reproduce: REPRODUCE.drift,
    });
    expect((JSON.parse(serialized) as { readonly suite: string }).suite).toBe("contract-drift");
  });
});
