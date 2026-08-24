import { describe, expect, test } from "bun:test";

import {
  activeHtmlScanDiagnostics,
  escapeHtml,
  fenceFor,
  firstUnpairedUtf16SurrogateOffset,
  isSafeHeaderValue,
  isSafeWorkerPath,
  longestBacktickRun,
  neutralizeUntrustedBody,
} from "../../src/sanitize.ts";
import { FORGED } from "../_support/fixtures.ts";

/** Historical detector retained only to prove the slash-separator regression. */
const OLD_WHITESPACE_ONLY_HANDLER =
  /<\s*[A-Za-z][A-Za-z0-9:-]*\b[^<>]*\s+on[a-z][A-Za-z0-9:_-]*\s*=/i;

/**
 * Deliberately independent semantic oracle. It parses raw HTML-comment
 * candidates regardless of their prefix, then canonicalizes the reserved
 * namespace. In particular, it never borrows the sanitizer's matcher or the
 * old "not preceded by a backslash" rule.
 */
function semanticControlComments(text: string): string[] {
  const matches: string[] = [];
  let searchFrom = 0;

  while (true) {
    const open = text.indexOf("<!--", searchFrom);
    if (open === -1) return matches;
    const standardClose = text.indexOf("-->", open + 4);
    const parseErrorClose = text.indexOf("--!>", open + 4);
    const close =
      standardClose === -1
        ? parseErrorClose
        : parseErrorClose === -1
          ? standardClose
          : Math.min(standardClose, parseErrorClose);
    const comment = text.slice(open + 4, close === -1 ? text.length : close);
    const canonical = comment
      .trimStart()
      .normalize("NFKD")
      .replace(/[\p{M}\p{Cf}]/gu, "")
      .normalize("NFKC")
      .toLowerCase();
    if (canonical === "asimp" || canonical.startsWith("asimp:") || /^asimp\s/u.test(canonical)) {
      matches.push(comment);
    }
    searchFrom = open + 4;
  }
}

/**
 * Separate raw-text oracle for the documented reserved quoted-key-colon
 * grammar. A backslash before either quote is not a semantic exemption.
 */
const SEMANTIC_RESERVED_ENVELOPE_KEYS = new Set(["next_actions", "why_included"]);

function semanticReservedEnvelopeKeys(text: string): string[] {
  const matches: string[] = [];
  let searchFrom = 0;

  while (true) {
    const open = text.indexOf('"', searchFrom);
    if (open === -1) return matches;
    let candidateClose = text.indexOf('"', open + 1);
    while (candidateClose !== -1) {
      let key: unknown;
      try {
        key = JSON.parse(text.slice(open, candidateClose + 1));
      } catch {
        candidateClose = text.indexOf('"', candidateClose + 1);
        continue;
      }

      let cursor = candidateClose + 1;
      while (cursor < text.length && /\s/u.test(text[cursor] as string)) cursor += 1;
      if (
        typeof key === "string" &&
        SEMANTIC_RESERVED_ENVELOPE_KEYS.has(key) &&
        text[cursor] === ":"
      ) {
        matches.push(key);
      }
      break;
    }
    // A quote that closed one candidate can still open the documented raw-text
    // grammar. Advancing by one keeps this oracle independent of JSON object
    // validity and of the sanitizer's own scanning strategy.
    searchFrom = open + 1;
  }
}

describe("neutralizeUntrustedBody", () => {
  test("leaves ordinary scientific prose byte-identical and reports nothing", () => {
    const body =
      "For k >= 2 we have S(k) < 2^k, since $\\sum_{i<k} a_i < 2^{k-1}$. See L-4 for the source.";
    const result = neutralizeUntrustedBody(body);
    expect(result.text).toBe(body);
    expect(result.findings).toEqual([]);
  });

  test("escapes a forged asimp control comment and records it", () => {
    const result = neutralizeUntrustedBody(`prefix\n${FORGED.itemHeader}\nsuffix`);
    expect(semanticControlComments(result.text)).toEqual([]);
    expect(result.text).toContain("&lt;!-- asimp:item id=SYS-99");
    expect(result.findings).toEqual([{ marker: "asimp-control-comment", count: 1 }]);
  });

  test("neutralizes prefix, backslash, whitespace, case, and Unicode mutations without a rerender escape", () => {
    const markers = [
      ...Array.from(
        { length: 9 },
        (_, slashCount) => `${"\\".repeat(slashCount)}<!-- asimp:item id=SYS-${slashCount} -->`,
      ),
      "ordinary line prefix <!--\tASIMP:item id=CASE -->",
      "math prefix \\alpha = 1; <!--\u00a0aSiMp\uff1aitem id=SPACE -->",
      "unicode prefix \\<!--\u200bＡＳＩＭＰ\u200d：item id=FULLWIDTH -->",
      "combining prefix <!-- a\u034fs\u0307imp:item id=MARKS -->",
      "interior ZWJ <!-- a\u200dsimp:item id=ZWJ-A -->",
      "interior ZWJ <!-- as\u200dimp:item id=ZWJ-AS -->",
      "interior BOM <!-- asi\ufeffmp:item id=BOM-ASI -->",
      "interior word joiner <!-- asim\u2060p:item id=WJ-ASIM -->",
      "edge BOM <!-- \ufeffasimp\u200d:item id=EDGE-CF -->",
      "combining interior <!-- a\u0301simp:item id=COMBINING-A -->",
      "fieldless bare <!--asimp-->",
      "fieldless prefixed \\<!--asimp-->",
      "fieldless case <!--aSiMp-->",
      "fieldless fullwidth <!--ＡＳＩＭＰ-->",
      "fieldless every-letter format <!--a\u200ds\u200di\u200dm\u200dp-->",
      "fieldless parse-error closer <!--asimp--!>",
      "fieldless parse-error fullwidth <!--ＡＳＩＭＰ--!>",
      "fieldless parse-error astral <!--\u{1d400}\u{1d412}\u{1d408}\u{1d40c}\u{1d40f}--!>",
    ];

    for (const marker of markers) {
      expect(semanticControlComments(marker)).toHaveLength(1);
      const once = neutralizeUntrustedBody(marker);
      expect(semanticControlComments(once.text)).toEqual([]);
      expect(once.text).toContain("&lt;!--");
      expect(once.findings).toEqual([{ marker: "asimp-control-comment", count: 1 }]);

      const twice = neutralizeUntrustedBody(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.findings).toEqual([]);
    }
  });

  test("counts every forged control comment in one body", () => {
    const result = neutralizeUntrustedBody(`${FORGED.itemHeader}\n${FORGED.faceHeader}`);
    expect(result.findings).toEqual([{ marker: "asimp-control-comment", count: 2 }]);
  });

  test("an independent oracle finds a parse-error-closed control opener nested after ordinary data", () => {
    const body = "outer <!--ordinary nested <!--ＡＳＩＭＰ--!>";

    expect(semanticControlComments(body)).toHaveLength(1);
    expect(neutralizeUntrustedBody(body)).toEqual({
      text: "outer <!--ordinary nested &lt;!--ＡＳＩＭＰ--!>",
      findings: [{ marker: "asimp-control-comment", count: 1 }],
    });
  });

  test("does not touch an ordinary HTML comment that is not addressed to us", () => {
    const body = "\\alpha + \\beta = 1; \\\\<!-- a note to future readers -->; <!--ordinary-->";
    const result = neutralizeUntrustedBody(body);
    expect(result.text).toBe(body);
    expect(result.findings).toEqual([]);
  });

  test("rejects a non-prefix control-comment candidate before later comment data can matter", () => {
    const bodies = [
      "<!--x asimp:item id=NOT-A-HEADER -->",
      "<!--asix asimp:item id=NOT-A-HEADER -->",
      "<!--asimpersonation: not site control furniture -->",
    ];

    for (const body of bodies) {
      expect(neutralizeUntrustedBody(body)).toEqual({ text: body, findings: [] });
    }
  });

  test("scales linearly across repeated unterminated non-prefix openers", () => {
    const smallRejected = "<!--x".repeat(1_024);
    const largeRejected = "<!--x".repeat(2_048);
    const terminatedControls = "<!--asimp-->".repeat(1_024);

    // Warm both paths before timing. A single scan is only about a millisecond
    // on a fast host, where timer quantization and one JIT transition can
    // overwhelm the scaling ratio. Measure adjacent small/large batches and
    // take the median of their ratios. Alternating the order prevents a steady
    // warm-up trend from favoring either body, while an isolated scheduler
    // pause can spoil only one pair. A quadratic suffix rescan still grows by
    // roughly 4x when the input doubles.
    neutralizeUntrustedBody(smallRejected);
    neutralizeUntrustedBody(largeRejected);
    const batchDurationMs = (body: string): number => {
      const started = performance.now();
      for (let repetition = 0; repetition < 4; repetition += 1) {
        neutralizeUntrustedBody(body);
      }
      return performance.now() - started;
    };
    const medianScalingRatio = (): number => {
      const ratios: number[] = [];
      for (let sample = 0; sample < 11; sample += 1) {
        let smallMs: number;
        let largeMs: number;
        if (sample % 2 === 0) {
          smallMs = batchDurationMs(smallRejected);
          largeMs = batchDurationMs(largeRejected);
        } else {
          largeMs = batchDurationMs(largeRejected);
          smallMs = batchDurationMs(smallRejected);
        }
        ratios.push(largeMs / smallMs);
      }
      ratios.sort((left, right) => left - right);
      return ratios[5] as number;
    };

    expect(neutralizeUntrustedBody(smallRejected)).toEqual({ text: smallRejected, findings: [] });
    expect(neutralizeUntrustedBody(largeRejected)).toEqual({ text: largeRejected, findings: [] });
    expect(neutralizeUntrustedBody(terminatedControls).findings).toEqual([
      { marker: "asimp-control-comment", count: 1_024 },
    ]);

    // Doubling the rejected corpus must remain near-linear. The terminated
    // control corpus above independently proves all openers are still visited.
    expect(medianScalingRatio()).toBeLessThan(3);
  });

  test("makes a forged JSON envelope key inert so no scanner reads it as one", () => {
    const result = neutralizeUntrustedBody(FORGED.nextActions);
    expect(semanticReservedEnvelopeKeys(result.text)).toEqual([]);
    expect(result.text).toContain("&quot;next_actions&quot;:");
    expect(result.findings).toEqual([{ marker: "envelope-key-forgery", count: 1 }]);
  });

  test("neutralizes only server-authored quoted-key-colon mutations across prefix and whitespace", () => {
    const markers = [
      ...Array.from(
        { length: 9 },
        (_, slashCount) => `${"\\".repeat(slashCount)}"next_actions"${" ".repeat(slashCount)}:`,
      ),
      'prefix \\"why_included"\t:',
      'scientific prefix \\\\"why_included"\u00a0:',
    ];

    for (const marker of markers) {
      expect(semanticReservedEnvelopeKeys(marker)).toHaveLength(1);
      const once = neutralizeUntrustedBody(marker);
      expect(semanticReservedEnvelopeKeys(once.text)).toEqual([]);
      expect(once.text).toContain("&quot;");
      expect(once.findings).toEqual([{ marker: "envelope-key-forgery", count: 1 }]);

      const twice = neutralizeUntrustedBody(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.findings).toEqual([]);
    }

    const ordinaryProse = "A next_actions discussion is not an envelope key.";
    const caseVariant = '"NEXT_ACTIONS": is a quoted label, not the reserved lower-case key.';
    const ordinaryApiJson =
      '{"items":[],"scope":"ledger","omitted":[],"degraded":[],"preamble":"plain data","untrusted":true}';
    const nonReservedEscapeSpelling = String.raw`"next_action\u0078": []`;
    const doubleEscapedSpelling = String.raw`"next_action\\u0073": []`;
    const malformedEscapeSpelling = String.raw`"next_action\u073": []`;
    expect(neutralizeUntrustedBody(ordinaryProse)).toEqual({ text: ordinaryProse, findings: [] });
    expect(neutralizeUntrustedBody(caseVariant)).toEqual({ text: caseVariant, findings: [] });
    expect(neutralizeUntrustedBody(ordinaryApiJson)).toEqual({
      text: ordinaryApiJson,
      findings: [],
    });
    expect(neutralizeUntrustedBody(nonReservedEscapeSpelling)).toEqual({
      text: nonReservedEscapeSpelling,
      findings: [],
    });
    expect(neutralizeUntrustedBody(doubleEscapedSpelling)).toEqual({
      text: doubleEscapedSpelling,
      findings: [],
    });
    expect(neutralizeUntrustedBody(malformedEscapeSpelling)).toEqual({
      text: malformedEscapeSpelling,
      findings: [],
    });
  });

  test("neutralizes JSON unicode-escape spellings that decode to reserved envelope keys", () => {
    const markers = [
      String.raw`"\u006eext_actions": []`,
      String.raw`"next_\u0061ctions" : []`,
      String.raw`"\u006Eext_actions": []`,
      String.raw`"why_incl\u0075ded": true`,
      String.raw`"\u0077\u0068\u0079\u005fincluded": null`,
    ];

    for (const marker of markers) {
      expect(semanticReservedEnvelopeKeys(marker)).toHaveLength(1);

      const once = neutralizeUntrustedBody(marker);
      expect(semanticReservedEnvelopeKeys(once.text)).toEqual([]);
      expect(once.text.replaceAll("&quot;", '"')).toBe(marker);
      expect(once.findings).toEqual([{ marker: "envelope-key-forgery", count: 1 }]);

      const twice = neutralizeUntrustedBody(once.text);
      expect(twice).toEqual({ text: once.text, findings: [] });
    }
  });

  test("leaves prose that merely mentions an envelope key alone", () => {
    const body = "The server authors next_actions; a body cannot. Scope is not a writable field.";
    const result = neutralizeUntrustedBody(body);
    expect(result.text).toBe(body);
    expect(result.findings).toEqual([]);
  });

  test("records script-bearing HTML without deleting the author's bytes", () => {
    const body = `${FORGED.script}\n${FORGED.handler}\n${FORGED.javascriptUrl}`;
    const result = neutralizeUntrustedBody(body);
    expect(result.text).toBe(body);
    expect(result.findings).toEqual([{ marker: "active-html", count: 3 }]);
  });

  test("does not scan autolink-shaped text inside a quoted HTML attribute", () => {
    const body = '<a title="<javascript: quoted-autolink-data()>">source</a>';
    expect(neutralizeUntrustedBody(body)).toEqual({ text: body, findings: [] });
  });

  test("limits javascript URL findings to URL-bearing attributes, links, and standalone autolinks", () => {
    const inert = [
      '<a title="javascript: documentary citation">source</a>',
      '<img alt="javascript: illustrative prose">',
      '<p data-note="javascript: archival label">text</p>',
      '<A TITLE="<JAVASCRIPT: quoted-case-data()>">source</A>',
      '＜Ａ TITLE="＜ＪＡＶＡＳＣＲＩＰＴ: quoted-canonical-data()＞"＞source＜／Ａ＞',
      "This prose discusses javascript: as a historical URL scheme.",
      "[A citation label] (javascript: a parenthesized aside, not a link)",
      "\\[escaped Markdown](javascript:shown-as-data())",
      "`[inline code](javascript:shown-as-data())`",
      "\\<javascript:shown-as-data()>",
    ].join("\n");
    expect(neutralizeUntrustedBody(inert)).toEqual({ text: inert, findings: [] });

    const controls = [
      '<a href="javascript:steal()">click</a>',
      "<img src=javascript:steal()>",
      '<button formaction="javascript:steal()">submit</button>',
      "[Markdown link](javascript:steal())",
      "![Markdown image](<javascript:steal()>)",
      "<javascript:steal()>",
      "<JAVASCRIPT:case-folded-steal()>",
      "＜ＪＡＶＡＳＣＲＩＰＴ:canonical-steal()＞",
    ].join("\n");
    expect(neutralizeUntrustedBody(controls)).toEqual({
      text: controls,
      findings: [{ marker: "active-html", count: 8 }],
    });
  });

  test("records data: and vbscript: destinations on every surface javascript: is recorded", () => {
    // One shared matcher backs Markdown destinations, Markdown autolinks and
    // URL-bearing HTML attributes, so the three paths cannot drift apart.
    const controls = [
      '<a href="data:text/html,<script>steal()</script>">click</a>',
      "<img src=data:text/html,steal()>",
      '<button formaction="vbscript:steal()">submit</button>',
      "[Markdown link](data:text/html;base64,PHN2Zz4=)",
      "![Markdown image](<vbscript:steal()>)",
      "<data:text/html,steal()>",
      "<VBSCRIPT:case-folded-steal()>",
      "＜ＤＡＴＡ:canonical-steal()＞",
    ];

    for (const body of controls) {
      expect(neutralizeUntrustedBody(body)).toEqual({
        text: body,
        findings: [{ marker: "active-html", count: 1 }],
      });
    }
  });

  test("resolves dangerous reference-style Markdown URLs at each rendered use", () => {
    const body = [
      "[full use][target]",
      "[target][]",
      "[TARGET]",
      "![image][target]",
      "",
      "[target]: javascript:steal() 'documentary title'",
    ].join("\n");

    expect(neutralizeUntrustedBody(body)).toEqual({
      text: body,
      findings: [{ marker: "active-html", count: 4 }],
    });
  });

  test("covers the CommonMark sharp-S fold, whitespace, escapes, and character bounds", () => {
    const astralLabel = "🧪".repeat(999);
    const controls = [
      "[ẞ]\n\n[SS]: javascript:unicode-fold()",
      "[spaced label]\n\n[  spaced\t label  ]: javascript:whitespace-fold()",
      "[a!b]\n\n[a\\!b]: javascript:punctuation-escape()",
      `[${astralLabel}]\n\n[${astralLabel}]: javascript:astral-label()`,
    ];
    for (const body of controls) {
      expect(neutralizeUntrustedBody(body).findings).toEqual([{ marker: "active-html", count: 1 }]);
    }

    const nonPunctuationEscape = "[aq]\n\n[a\\q]: javascript:not-the-same-label()";
    const overlongLabel = "x".repeat(1_000);
    const overlong = `[${overlongLabel}]\n\n[${overlongLabel}]: javascript:overlong-label()`;
    expect(neutralizeUntrustedBody(nonPunctuationEscape).findings).toEqual([]);
    expect(neutralizeUntrustedBody(overlong).findings).toEqual([]);
  });

  test("decodes Markdown punctuation escapes before classifying destination schemes", () => {
    const controls = [
      "[inline](javascript\\:steal())",
      "![angle](<data\\:text/html,steal()>)",
      "[reference][target]\n\n[target]: vbscript\\:steal()",
    ];

    for (const body of controls) {
      expect(neutralizeUntrustedBody(body)).toEqual({
        text: body,
        findings: [{ marker: "active-html", count: 1 }],
      });
    }
  });

  test("supports angle and continued reference destinations without counting definitions", () => {
    const controls = [
      "[angle][a]\n\n[a]: <data:text/html,steal()>",
      "[continued][b]\n\n[b]:\n   vbscript:steal()",
    ];

    for (const body of controls) {
      expect(neutralizeUntrustedBody(body)).toEqual({
        text: body,
        findings: [{ marker: "active-html", count: 1 }],
      });
    }
  });

  test("does not report unused, shadowed, escaped, or code-only reference definitions", () => {
    const inert = [
      "[unused]: javascript:not-rendered()",
      "[safe use][first]\n\n[first]: https://example.test/\n[first]: javascript:shadowed()",
      "\\[escaped\\]\\[target\\]\n[target]: javascript:not-a-link()",
      "`[inline][target]`\n[target]: javascript:not-a-link()",
      "```md\n[target]: javascript:not-a-definition()\n[inside][target]\n```",
      '[titled][target]\n\n[target]: https://example.test/\n  "<javascript:title-data()>"',
    ];

    for (const body of inert) {
      expect(neutralizeUntrustedBody(body)).toEqual({ text: body, findings: [] });
    }
  });

  test("does not let a reference definition interrupt a paragraph", () => {
    const body = "paragraph\n[target]: <javascript:visible-autolink()>\n\n[target]";

    // The definition-shaped line remains paragraph content. Its angle URI is
    // therefore the one rendered dangerous URL; the later shortcut has no
    // valid definition and must not add a second finding.
    expect(neutralizeUntrustedBody(body)).toEqual({
      text: body,
      findings: [{ marker: "active-html", count: 1 }],
    });
  });

  test("reads an attribute destination scheme the way a URL parser would", () => {
    // The WHATWG basic URL parser strips leading C0-control-or-space and removes
    // ASCII tab, LF and CR from anywhere in the input, so each of these executes.
    const TAB = String.fromCharCode(9);
    const LINE_FEED = String.fromCharCode(10);
    const CARRIAGE_RETURN = String.fromCharCode(13);
    const controls = [
      '<a href=" javascript:steal()">leading space</a>',
      `<a href="java${TAB}script:steal()">tab inside the scheme</a>`,
      `<a href="vb${LINE_FEED}script:steal()">line feed inside the scheme</a>`,
      `<a href="da${CARRIAGE_RETURN}ta:text/html,steal()">carriage return inside the scheme</a>`,
      '<a HREF="DaTa:text/html,steal()">mixed case</a>',
    ];

    for (const body of controls) {
      expect(neutralizeUntrustedBody(body)).toEqual({
        text: body,
        findings: [{ marker: "active-html", count: 1 }],
      });
    }
  });

  test("leaves a dangerous scheme spelled inside an ordinary URL's path or query alone", () => {
    // Rule A4: reporting a benign link as neutralized would be pretending. Only
    // the scheme the browser actually resolves counts, never one mentioned later.
    const inert = [
      '<a href="https://example.test/?note=data:text/html">source</a>',
      '<a href="https://example.test/javascript:not-a-scheme">source</a>',
      '<img src="https://example.test/p?u=vbscript:archival()">',
      "[Markdown link](https://example.test/?u=data:text/html,x)",
      '<a href="/p/claim.md">relative</a>',
      "This prose discusses data: and vbscript: as historical URL schemes.",
      "`[inline code](data:text/html,shown-as-data())`",
      "\\<vbscript:shown-as-data()>",
      '<a title="data:text/html documentary citation">source</a>',
    ];

    for (const body of inert) {
      expect(neutralizeUntrustedBody(body)).toEqual({ text: body, findings: [] });
    }
  });

  test("keeps Markdown URL surfaces in code and escaped tags inert", () => {
    const inert = [
      "\\<script>shown as escaped text</script>",
      "`[shown as inline code](data:text/html,not-a-link)`",
      "```md\n[shown in a backtick fence](javascript:not-a-link)\n```",
      "~~~md\n[shown in a tilde fence](vbscript:not-a-link)\n~~~",
      "```md\r\n[shown in a CRLF fence](data:text/html,not-a-link)\r\n```\r\n",
      "~~~md\r[shown in a CR-only fence](javascript:not-a-link)\r~~~\r",
      // Form feed is HTML whitespace, but CommonMark permits only space/tab
      // after a closing fence. This line is content, so the unclosed fence
      // remains inert through the end of the document.
      "```md\n```\f\n[still fenced](javascript:not-a-link)",
      // A longer backtick run is not an inline-code closer, but a later exact
      // run is; everything between the exact pair remains code.
      "``[still inline code](javascript:not-a-link)```then``",
    ];

    for (const body of inert) {
      expect(neutralizeUntrustedBody(body)).toEqual({ text: body, findings: [] });
    }
  });

  test("retains the lexical active-HTML signal inside Markdown code examples", () => {
    const controls = [
      "`<script>lexically dangerous HTML</script>`",
      "```html\n<img src=x onerror=steal()>\n```",
    ];

    for (const body of controls) {
      expect(neutralizeUntrustedBody(body)).toEqual({
        text: body,
        findings: [{ marker: "active-html", count: 1 }],
      });
    }
  });

  test("does not hide active markup behind a nonmatching code-span run", () => {
    const body = "``<script>not actually inline code</script>```";

    expect(neutralizeUntrustedBody(body)).toEqual({
      text: body,
      findings: [{ marker: "active-html", count: 1 }],
    });
  });

  test("scans after one body-sized unmatched backtick run without suffix rescans", () => {
    const body = `prose${"`".repeat(20_000)}<script>still active</script>`;

    expect(neutralizeUntrustedBody(body)).toEqual({
      text: body,
      findings: [{ marker: "active-html", count: 1 }],
    });
  });

  test("keeps unmatched Markdown labels linear at the 20,000-character contract bound", () => {
    const body = "[".repeat(20_000);
    const started = performance.now();

    expect(neutralizeUntrustedBody(body)).toEqual({ text: body, findings: [] });

    // The former per-opener suffix scan was quadratic and took roughly half a
    // second on this corpus. A one-pass bracket map leaves ample host variance.
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("documents the HTML character-reference decoding limit without claiming a finding", () => {
    const body = '<a href="&#106;avascript:shown-as-escaped-text()">source</a>';

    // The matcher intentionally does not implement the HTML entity parser.
    // Every current face still renders this body as data: Markdown fences it
    // and the HTML face escapes the ampersand before it could decode.
    expect(neutralizeUntrustedBody(body)).toEqual({ text: body, findings: [] });
    expect(escapeHtml(body)).toContain("&amp;#106;avascript:");
  });

  test("detects slash-separated handlers that the old whitespace-only arm misses", () => {
    const controls = ["<svg/onload=steal(1)>", "<IMG/ONERROR =steal(2)>", "<svg /onload=steal(3)>"];

    for (const body of controls) {
      expect(OLD_WHITESPACE_ONLY_HANDLER.test(body)).toBe(false);
      expect(neutralizeUntrustedBody(body)).toEqual({
        text: body,
        findings: [{ marker: "active-html", count: 1 }],
      });
    }
  });

  test("recognizes tokenizer separators, case, and canonical Unicode handler forms", () => {
    const controls = [
      "<svg/onload=steal(1)>",
      "<IMG/ONERROR =steal(2)>",
      "<svg /onload=steal(3)>",
      "<svg/ onload=steal(4)>",
      "<svg / / onload=steal(5)>",
      "<svg\f/\tonload =steal(6)>",
      "<ＳＶＧ／ＯＮＬＯＡＤ＝steal(7)＞",
      "<s\u200dvg/o\u034fnload=steal(8)>",
      '<img title="x"/onerror=steal(9)>',
      "<img src=x /onerror=steal(10)>",
      '<img title=">" onerror=steal(11)>',
      '<img title="<!--" onerror=steal(12)>',
      "<x.y/onload=steal(13)>",
      "<x_y/onload=steal(14)>",
      "<xé/onload=steal(15)>",
    ];

    for (const body of controls) {
      expect(neutralizeUntrustedBody(body)).toEqual({
        text: body,
        findings: [{ marker: "active-html", count: 1 }],
      });
    }
  });

  test("canonical punctuation cannot suppress a raw-tokenizer handler", () => {
    const controls = [
      "＜！－－ <img/onerror=x> －－＞",
      "＜!-- <img/onerror=x> --＞",
      "<！－－ <img/onerror=x> －－>",
      "<img title=＂foo onerror=x＂>",
      "<img title=＇foo onerror=x＇>",
      "<img title=x＞ onerror=y>",
      "<img foo=bar＞ /onerror=y>",
    ];

    for (const body of controls) {
      expect(neutralizeUntrustedBody(body).findings).toEqual([{ marker: "active-html", count: 1 }]);
    }

    const independentRawAndCanonical = "＜！－－ <img/onerror=a> －－＞ <ＳＶＧ／ＯＮＬＯＡＤ=b>";
    expect(neutralizeUntrustedBody(independentRawAndCanonical).findings).toEqual([
      { marker: "active-html", count: 2 },
    ]);
  });

  test("deduplicates raw and canonical findings by original occurrence across a large body", () => {
    const scientificLine =
      "For m >= 2, \u03a3_i a_i < 2^m; onerror = a coefficient name, not an attribute.";
    const body =
      `${Array.from({ length: 4096 }, () => scientificLine).join("\n")}\n` +
      "<svg/onload=record(raw)>\n<\uff33\uff36\uff27\uff0f\uff2f\uff2e\uff2c\uff2f\uff21\uff24=record(canonical)\uff1e>";

    const result = neutralizeUntrustedBody(body);
    expect(result.text).toBe(body);
    // Each tag is seen by both interpretations, but source offsets identify
    // the two original tags rather than reporting four derived matches.
    expect(result.findings).toEqual([{ marker: "active-html", count: 2 }]);
  });

  test("maps decomposed Hangul prefixes without losing or duplicating later tags", () => {
    // These are literal Hangul Jamo, not precomposed syllables. They prove that
    // source recovery advances by source code point even when normalization
    // could otherwise recompose adjacent non-ASCII characters.
    const composableHangulJamo = "가".repeat(8);

    expect(neutralizeUntrustedBody(`${composableHangulJamo}<script>`).findings).toEqual([
      { marker: "active-html", count: 1 },
    ]);

    // The raw tag must still deduplicate while the fullwidth tag is retained
    // as a distinct Unicode-canonical finding.
    expect(
      neutralizeUntrustedBody(`${composableHangulJamo}<script>＜ＳＣＲＩＰＴ＞`).findings,
    ).toEqual([{ marker: "active-html", count: 2 }]);

    // The exported diagnostic retains its historical whole-string NFKC view:
    // eight Jamo pairs compose to eight UTF-16 Hangul syllables, followed by
    // the eight UTF-16 units in `<script>`.
    expect(
      activeHtmlScanDiagnostics(`${composableHangulJamo}<script>`).canonical
        .transformed_utf16_units,
    ).toBe(16);
  });

  test("maps every canonical finding in one pass at the 20,000-character contract bound", () => {
    const body = "＜ＳＣＲＩＰＴ＞".repeat(2_500);
    const started = performance.now();

    expect(neutralizeUntrustedBody(body)).toEqual({
      text: body,
      findings: [{ marker: "active-html", count: 2_500 }],
    });

    // The former per-finding binary search repeatedly normalized prefixes and
    // took several seconds here. The forward source replay is linear in input
    // plus findings; one second keeps this an algorithmic, not machine, gate.
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("keeps benign Unicode-normalization metadata proportional to findings, not source code points", () => {
    // U+FDFA expands to many UTF-16 units under NFKD. This deliberately
    // checks the allocation shape rather than a timing or RSS threshold that
    // would depend on the host runtime.
    // U+FDFA is three UTF-8 bytes, so this exercises the reported 300 KB
    // attack shape without asserting a host-specific RSS ceiling.
    const sourceCodePoints = 100_000;
    const body = "\ufdfa".repeat(sourceCodePoints);
    const diagnostics = activeHtmlScanDiagnostics(body);

    expect(diagnostics.canonical.transformed_utf16_units).toBeGreaterThan(sourceCodePoints * 10);
    expect(diagnostics.raw.finding_offsets).toBe(0);
    expect(diagnostics.raw.source_mapping_entries).toBe(0);
    expect(diagnostics.canonical.finding_offsets).toBe(0);
    expect(diagnostics.canonical.source_mapping_entries).toBe(0);

    const canonicalFinding = activeHtmlScanDiagnostics("<ＳＶＧ／ＯＮＬＯＡＤ=record()＞");
    expect(canonicalFinding.canonical.finding_offsets).toBe(1);
    expect(canonicalFinding.canonical.source_mapping_entries).toBe(1);
  });

  test("does not mistake prose, math, comments, tag names, or attribute values for handlers", () => {
    const controls = [
      "one = 1; done = false; only = true; onerror = a variable, not markup.",
      "svg/onload = a lemma, not markup",
      "x < y/onload = z",
      "<!-- <svg/onload=steal(1)> -->",
      "<!-- <img/onerror=steal(2)>",
      "<section>/<caption>/<onload=lemma>/<svgonload=lemma>/<custom-onload>",
      '<img title="foo onerror=x">',
      '<img alt="/onerror=prose">',
      "<img src=https://example.test/onerror=x>",
      // Chromium keeps the slash in an unquoted value; it does not begin an
      // `onerror` attribute after `src=x`.
      "<img src=x/onerror=x>",
    ];

    for (const body of controls) {
      expect(neutralizeUntrustedBody(body)).toEqual({ text: body, findings: [] });
    }

    expect(neutralizeUntrustedBody('<img src=x onerror="record()">').findings).toEqual([
      { marker: "active-html", count: 1 },
    ]);
  });

  test("resumes scanning after every HTML comment closer the tokenizer accepts", () => {
    const controls = [
      "<!-- inert --><img/onerror=steal(1)>",
      "<!-- inert --!><img/onerror=steal(2)>",
      "<!--><img/onerror=steal(3)>",
      "<!---><img/onerror=steal(4)>",
    ];

    for (const body of controls) {
      expect(neutralizeUntrustedBody(body).findings).toEqual([{ marker: "active-html", count: 1 }]);
    }
  });

  test("is idempotent: neutralizing twice equals neutralizing once", () => {
    const once = neutralizeUntrustedBody(`${FORGED.itemHeader}\n${FORGED.nextActions}`);
    const twice = neutralizeUntrustedBody(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.findings).toEqual([]);
  });

  test("reports every marker present in one hostile body", () => {
    const body = [FORGED.itemHeader, FORGED.nextActions, FORGED.script].join("\n");
    const markers = neutralizeUntrustedBody(body).findings.map((finding) => finding.marker);
    expect(markers).toEqual(["asimp-control-comment", "envelope-key-forgery", "active-html"]);
  });
});

describe("fenceFor", () => {
  test("uses three backticks when the body has none", () => {
    expect(fenceFor("plain text")).toEqual({ delimiter: "```", extended: false });
  });

  test("outgrows a body that carries its own three-backtick fence", () => {
    expect(fenceFor("```\nbreak out\n```")).toEqual({ delimiter: "````", extended: true });
  });

  test("outgrows the longest run, not the first one", () => {
    expect(fenceFor("``a\n`````b\n```c")).toEqual({ delimiter: "``````", extended: true });
  });

  test("longestBacktickRun counts the longest contiguous run", () => {
    expect(longestBacktickRun("no ticks")).toBe(0);
    expect(longestBacktickRun("a `b` c")).toBe(1);
    expect(longestBacktickRun("a ```` b ``` c")).toBe(4);
  });
});

describe("escapeHtml", () => {
  test("escapes every character that could start markup or close an attribute", () => {
    expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;",
    );
  });

  test("escapes the ampersand first so escapes are not double-encoded into markup", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("isSafeHeaderValue", () => {
  test("accepts ordinary envelope metadata", () => {
    expect(isSafeHeaderValue("asimposium.pack.v1")).toBe(true);
    expect(isSafeHeaderValue("smooth-poincare-4d")).toBe(true);
  });

  test("rejects values that could close or forge the control comment", () => {
    expect(isSafeHeaderValue("pack --> <!-- asimp")).toBe(false);
    expect(isSafeHeaderValue("pack\nprofile=working")).toBe(false);
    expect(isSafeHeaderValue("pack>")).toBe(false);
  });
});

describe("Unicode scalar and Worker-path guards", () => {
  test("identifies exactly the first unpaired UTF-16 surrogate without rejecting Unicode scalars", () => {
    const cases: readonly [string, string, number | undefined][] = [
      ["ordinary Unicode, math, and a valid astral pair", "∀ k ∈ ℕ; 𝕊(k) ≤ 2ᵏ; 😀", undefined],
      ["an NFKD-expanding scalar", "ﷺ", undefined],
      ["a high surrogate at the beginning", "\ud800", 0],
      ["a low surrogate at the beginning", "\udc00", 0],
      ["a high surrogate at the end", "a\ud800", 1],
      ["a low surrogate after ordinary text", "a\udc00", 1],
      ["a valid pair followed by a lone low surrogate", "😀\udc00", 2],
      ["a lone high surrogate before a valid pair", "\ud800😀", 0],
    ];

    for (const [label, value, expected] of cases) {
      expect(firstUnpairedUtf16SurrogateOffset(value), label).toBe(expected);
    }
  });

  test("accepts safe origin-relative Worker paths and keeps ordinary /v1 queries", () => {
    const longPath = `/v1/${"x".repeat(20_001)}?profile=working`;
    for (const value of [
      "/",
      "/inoculation.md",
      "/p/demo-bounded-sums.md",
      "/cursor",
      "/v1",
      "/v1/hello",
      "/v1/sessions/SES-demo/pack?profile=working&cursor=41",
      longPath,
    ]) {
      expect(isSafeWorkerPath(value), value).toBe(true);
    }
  });

  test("rejects external, traversing, encoded-path, and unsafe Worker paths exactly", () => {
    const rejected = [
      "//attacker.example/v1/hello",
      "//user:secret@attacker.example/v1/hello",
      "https://user:secret@attacker.example/v1/hello",
      "javascript:alert(1)",
      "mailto:fellow@example.org",
      "/v1/hello#fragment",
      "/v1\\hello",
      "/v1/hello`code`",
      "/v1/hello\r\nX-Forged: yes",
      "/v1/hello with-space",
      "/v1/hello\u007f",
      "/v1/hello%00",
      "/v1/hello%0a",
      "/v1/hello%7F",
      "/v1/%5chello",
      "/v1/hello%60code%60",
      "/v1/../outside",
      "/p/./claim.md",
      "/p/%2e%2e/private.md",
      "/p/%2E/claim.md",
      "/p/%252e%252e/private.md",
      "/p/%252E%252E/private.md",
      "/p/%250a-log",
      "/p/%250A-log",
      "/p/%255c-log",
      "/p/%255C-log",
    ];

    for (const value of rejected) expect(isSafeWorkerPath(value), value).toBe(false);
  });

  test("allows percent-encoded query data but never an encoded pathname segment", () => {
    expect(
      isSafeWorkerPath(
        "/v1/sessions/SES-demo/pack?profile=working%20set&cursor=%2Fnext%60&note=%0A%5C",
      ),
    ).toBe(true);
    expect(isSafeWorkerPath("/p/%64emo.md?profile=working")).toBe(false);
  });
});
