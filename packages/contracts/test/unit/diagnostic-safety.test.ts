import { describe, expect, test } from "bun:test";

import {
  containsCredentialShape,
  REDACTED_TOKEN,
  redactCredentials,
} from "../../src/diagnostic-safety.ts";
import { REPRODUCE, safeDiagnostic } from "../../src/diagnostics.ts";

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
