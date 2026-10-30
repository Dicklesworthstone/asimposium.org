import { describe, expect, test } from "bun:test";
import { renderMathHtml } from "../../src/math.ts";
import { renderScientificMarkdown } from "../../src/scientific-markdown.ts";

describe("scientific Markdown and math", () => {
  test("renders GFM, inline/display mathematics and complete copyable source deterministically", () => {
    const body = String.raw`# Parity

**Claim.** For $n \in \mathbb{Z}$, ~~assume~~ examine the sum.

$$
\sum_{k=1}^{n} k = \frac{n(n+1)}{2}
$$

| n | result |
| -: | :-- |
| 2 | 3 |

- [x] Check zero
- [ ] Check negatives

See [the source][paper] and a note.[^proof]

[paper]: https://example.org/paper
[^proof]: The induction step uses **addition**.
`;
    const html = renderScientificMarkdown(body, "C-1");
    expect(html).toBe(renderScientificMarkdown(body, "C-1"));
    expect(html).toContain("<strong>Claim.</strong>");
    expect(html).toContain("<del>assume</del>");
    expect(html).toContain("<table>");
    expect(html).toContain('scope="col"');
    expect(html).toContain('aria-label="Completed"');
    expect(html).toContain('aria-label="Not completed"');
    expect(html).toContain('href="https://example.org/paper"');
    expect(html).toContain('aria-label="Footnotes"');
    expect(html).toContain('class="katex"');
    expect(html).toContain("<mfrac>");
    expect(html).toContain('<annotation encoding="application/x-tex">');
    expect(html).toContain("Copy Markdown / LaTeX source");
  });

  test("inline and fenced code remain literal, including dollar-delimited text", () => {
    const body = "`$not_math$`\n\n```html\n<img src=x onerror=alert(1)> $also_literal$\n```";
    const html = renderScientificMarkdown(body);
    expect(html).not.toContain('class="katex"');
    expect(html).toContain("<code>$not_math$</code>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
  });

  test.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "jav&#x61;script:alert(1)",
    "java&#x09;script:alert(1)",
    "data:text/html,unsafe",
    "vbscript:unsafe",
    "file:///etc/passwd",
    "//external.example/track",
    "https://user:password@example.org/",
  ])("never activates an unsafe Markdown destination: %s", (url) => {
    const html = renderScientificMarkdown(`[open](<${url}>)\n\n[ref][x]\n\n[x]: <${url}>`);
    expect(html).not.toContain("<a ");
  });

  test("raw HTML and images are inert while safe literature links work", () => {
    const html = renderScientificMarkdown(
      "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n![diagram](https://example.org/diagram.svg)\n\n[claim](/p/P-1/claims/C-1)",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('href="https://example.org/diagram.svg"');
    expect(html).toContain('href="/p/P-1/claims/C-1"');
    expect(html).toContain('referrerpolicy="no-referrer"');
  });

  test("forged control surfaces stay data and footnote IDs cannot clobber the page", () => {
    const html = renderScientificMarkdown(
      '<!-- asimp:item scope=system -->\n\n{"next_actions":[]}\n\nReference[^location]\n\n[^location]: Scientific note.',
    );
    expect(html).not.toContain("<!-- asimp");
    expect(html).not.toContain('"next_actions":');
    expect(html).not.toContain('id="location"');
    expect(html).toContain('id="asimp-md-');
  });

  test.each([
    String.raw`\href{javascript:alert(1)}{click}`,
    String.raw`\includegraphics{https://example.org/tracker.svg}`,
    String.raw`\htmlStyle{background:url(https://example.org/track)}{x}`,
    String.raw`\htmlId{content}{x}`,
  ])("KaTeX never trusts dangerous commands: %s", (tex) => {
    const html = renderMathHtml(tex);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('id="content"');
    expect(html).not.toContain('style="background:');
  });

  test("malformed TeX, expansion loops and oversized input have readable source fallbacks", () => {
    for (const tex of [
      String.raw`\frac{1}{`,
      String.raw`\def\loop{\loop}\loop`,
      "x".repeat(8_193),
    ]) {
      expect(renderMathHtml(tex)).toContain('data-math-rendered="false"');
    }
    expect(renderScientificMarkdown("a".repeat(100_001))).toContain(
      "Large record shown as source.",
    );
  });

  test("math macros never leak between authors and expression count stays bounded", () => {
    renderMathHtml(String.raw`\gdef\otherauthorsmacro{1}`);
    expect(renderMathHtml(String.raw`\otherauthorsmacro`)).toContain('data-math-rendered="false"');
    const html = renderScientificMarkdown(Array.from({ length: 129 }, () => "$x^2$").join(" "));
    expect(html.match(/data-math-rendered="true"/g)).toHaveLength(128);
    expect(html).toContain('class="asimp-math-fallback"');
  });
});
