/**
 * The word cap is only a fence if the measurement is stable, so the measurement gets its own tests
 * rather than being trusted through the documents that use it.
 */

import { describe, expect, test } from "bun:test";
import { countWords, estimateTokens, extractSection, normalizeServedText } from "../src/text.ts";

describe("normalizeServedText", () => {
  test("CRLF and CR become LF", () => {
    expect(normalizeServedText("a\r\nb\rc")).toBe("a\nb\nc\n");
  });

  test("exactly one trailing newline, whether there were none or many", () => {
    expect(normalizeServedText("no newline")).toBe("no newline\n");
    expect(normalizeServedText("many\n\n\n")).toBe("many\n");
  });

  test("interior blank lines survive", () => {
    expect(normalizeServedText("a\n\nb")).toBe("a\n\nb\n");
  });
});

describe("countWords", () => {
  test("counts whitespace-separated runs containing a letter or digit", () => {
    expect(countWords("one two three")).toBe(3);
    expect(countWords("  leading and trailing  ")).toBe(3);
  });

  test("bare punctuation and list bullets do not inflate the count", () => {
    expect(countWords("- item")).toBe(1);
    expect(countWords("— … ///")).toBe(0);
  });

  test("hyphenated and marked-up words count once", () => {
    expect(countWords("**self-certification**")).toBe(1);
  });

  test("an empty section measures zero, which is what makes the floor meaningful", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("\n\n")).toBe(0);
  });
});

describe("estimateTokens", () => {
  test("labelled heuristic: UTF-8 bytes over four, rounded up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  test("multibyte text costs more than its character count suggests", () => {
    expect(estimateTokens("😀😀😀😀")).toBe(4);
    expect(estimateTokens("aaaa")).toBe(1);
  });

  test("longer text never estimates fewer tokens", () => {
    const short = "statement";
    const long = `${short} and falsifier`;
    expect(estimateTokens(long)).toBeGreaterThanOrEqual(estimateTokens(short));
  });
});

describe("extractSection", () => {
  const document = [
    "# Title",
    "",
    "Preamble words that must not be measured.",
    "",
    "## Rules",
    "",
    "### Hard rules",
    "",
    "One rule here.",
    "",
    "## Versioning",
    "",
    "Not part of the rules.",
    "",
  ].join("\n");

  test("returns the section body up to the next level-two heading", () => {
    const section = extractSection(document, "Rules");
    expect(section).toContain("One rule here.");
    expect(section).toContain("### Hard rules");
    expect(section).not.toContain("Not part of the rules.");
    expect(section).not.toContain("Preamble words");
  });

  test("heading match is case-insensitive and whitespace-tolerant", () => {
    expect(extractSection(document, "  rules  ")).toBe(extractSection(document, "Rules") ?? "");
  });

  test("returns undefined when the heading is absent, instead of an empty measurement", () => {
    expect(extractSection(document, "Nonexistent")).toBeUndefined();
  });

  test("a level-three heading of the same name does not open a section", () => {
    const tricky = ["# T", "", "### Rules", "", "decoy", ""].join("\n");
    expect(extractSection(tricky, "Rules")).toBeUndefined();
  });
});
