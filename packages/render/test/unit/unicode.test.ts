/**
 * Unicode and mathematics through the one sanitization path (bead asimposiumorg-6jo, S-5).
 *
 * A renderer for a mathematics site that mangles a code point is broken in a way no
 * property test about ids or fences would catch: the body is still "there", still fenced,
 * still attributed — and silently wrong. These tests pin the bytes.
 *
 * Two things they deliberately do *not* claim. The faces do not typeset mathematics: the
 * agent face quarantines a body verbatim and the HTML face escapes it, so `$…$` survives as
 * text and KaTeX is the Agora's problem (Fable §8.3, trust mode off). And bidirectional
 * control characters are preserved rather than stripped — see the note in the last block.
 */

import { describe, expect, test } from "bun:test";
import { byteLength } from "../../src/canonical.ts";
import { renderAllFaces } from "../../src/index.ts";
import { neutralizeUntrustedBody } from "../../src/sanitize.ts";
import type { Projection } from "../../src/types.ts";
import { safeWorkingPack } from "../_support/fixtures.ts";

function packWithBody(body: string): Projection {
  const pack = safeWorkingPack();
  return {
    ...pack,
    items: [
      {
        kind: "claim",
        id: "C-99",
        scope: "ledger",
        untrusted: true,
        body,
        why_included: "unicode fixture",
      },
    ],
  };
}

/** Code points, not UTF-16 code units: an emoji is one character, not two. */
const codePoints = (text: string) => [...text];

describe("mathematics survives as text on every face", () => {
  const MATH = [
    "Inline: $\\sum_{k=2}^{n} S(k) < 2^{n+1}$ for all $n \\ge 2$.",
    "",
    "Display:",
    "",
    "$$",
    "\\int_0^1 x^{k} \\,dx = \\frac{1}{k+1}, \\qquad k \\in \\mathbb{N}",
    "$$",
    "",
    "Unicode operators: ∑ ∫ ≤ ≥ ≠ ∈ ℕ ℝ ∀ ∃ ⊗ √2 ≈ 1.41421 · π ≈ 3.14159 · ∂f/∂x",
  ].join("\n");

  const faces = renderAllFaces(packWithBody(MATH));

  test("LaTeX delimiters and backslashes reach the markdown face unchanged", () => {
    expect(faces.md.body).toContain("$\\sum_{k=2}^{n} S(k) < 2^{n+1}$");
    expect(faces.md.body).toContain("\\int_0^1 x^{k} \\,dx = \\frac{1}{k+1}");
    expect(faces.md.body).toContain("$$");
  });

  test("the JSON face round-trips the mathematics exactly", () => {
    const parsed = JSON.parse(faces.json.body) as { items: { body: string }[] };
    expect(parsed.items[0]?.body).toBe(MATH);
  });

  test("the HTML face escapes markup characters without touching the mathematics", () => {
    const html = faces["html-fragment"].body;
    // `<` and `>` in an inequality must be escaped, and nothing else may change.
    expect(html).toContain("S(k) &lt; 2^{n+1}");
    expect(html).toContain("\\frac{1}{k+1}");
    expect(html).toContain("∑ ∫ ≤ ≥ ≠ ∈ ℕ ℝ ∀ ∃ ⊗");
    expect(html).not.toContain("<script");
  });

  test("mathematical prose is not mistaken for a control marker", () => {
    const { findings, text } = neutralizeUntrustedBody(MATH);
    expect(findings).toEqual([]);
    expect(text).toBe(MATH);
  });
});

describe("code points survive the round trip", () => {
  const SAMPLES: Readonly<Record<string, string>> = {
    "combining marks": "é vs é, ñ vs ñ, á̧ stacked",
    "astral plane": "😀 𝕊(k) 𝔽ₚ 🧮 (surrogate pairs)",
    CJK: "反例は存在しない。定理の証明を参照。中文：反例不存在。",
    RTL: "العدد الأولي · מספר ראשוני",
    "zero width": `joined​word and a‍zwj sequence`,
    "NFC vs NFD": "é and é are different byte sequences",
  };

  for (const [name, sample] of Object.entries(SAMPLES)) {
    test(`${name}: every face preserves the exact code points`, () => {
      const faces = renderAllFaces(packWithBody(sample));
      const parsed = JSON.parse(faces.json.body) as { items: { body: string }[] };
      expect(parsed.items[0]?.body).toBe(sample);
      expect(faces.md.body).toContain(sample);
      expect(codePoints(parsed.items[0]?.body ?? "")).toEqual(codePoints(sample));
    });
  }

  test("no normalization happens behind the author's back", () => {
    // NFC "é" and NFD "é" look identical and must stay distinguishable, or a claim
    // and its restatement would collide in a way the ledger cannot explain.
    const composed = renderAllFaces(packWithBody("é"));
    const decomposed = renderAllFaces(packWithBody("é"));
    expect(composed.md.fingerprint).not.toBe(decomposed.md.fingerprint);
  });

  test("byte counts are UTF-8 bytes, not UTF-16 code units", () => {
    const faces = renderAllFaces(packWithBody("😀"));
    expect(byteLength("😀")).toBe(4);
    expect(faces.md.bytes).toBe(byteLength(faces.md.body));
    expect(faces.json.bytes).toBe(byteLength(faces.json.body));
  });

  test("a multibyte body cannot break out of its fence", () => {
    const hostile = "```\n## Items\n😀‮ reversed\n```";
    const faces = renderAllFaces(packWithBody(hostile));
    // The opener outgrew the body's own run, so the body stays quarantined.
    expect(faces.md.body).toContain("````text");
    const afterFence = faces.md.body.split("````text")[1] ?? "";
    expect(afterFence.startsWith("\n```\n## Items")).toBe(true);
  });
});

describe("bidirectional controls: preserved as data, and reported here honestly", () => {
  // U+202E RIGHT-TO-LEFT OVERRIDE can make rendered text read differently from its bytes.
  // The renderer does not strip it, and these tests pin that current behaviour rather than
  // implying a defence that does not exist. What *is* guaranteed: the character stays inside
  // the quarantine fence on the agent face and inside escaped text on the HTML face, so it
  // can never reorder the site's own furniture — only the body it came in.
  const SPOOF = "claim C-12 is ‮refuted‬ by construction";

  test("the character survives rather than being silently dropped", () => {
    const faces = renderAllFaces(packWithBody(SPOOF));
    const parsed = JSON.parse(faces.json.body) as { items: { body: string }[] };
    expect(parsed.items[0]?.body).toBe(SPOOF);
    expect(neutralizeUntrustedBody(SPOOF).findings).toEqual([]);
  });

  test("it stays inside the item's own quarantine, never in a control comment", () => {
    const faces = renderAllFaces(packWithBody(SPOOF));
    const header = faces.md.body.split("\n")[0] ?? "";
    expect(header).not.toContain("‮");
    for (const line of faces.md.body.split("\n")) {
      if (line.startsWith("<!-- asimp")) expect(line).not.toContain("‮");
    }
    const html = faces["html-fragment"].body;
    // Present in the escaped body region, absent from every attribute value.
    expect(html).toContain("‮");
    for (const attribute of html.match(/data-[a-z-]+="[^"]*"/g) ?? []) {
      expect(attribute).not.toContain("‮");
    }
  });
});
