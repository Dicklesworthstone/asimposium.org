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

  test("a level-three heading does not end the section either", () => {
    const section = extractSection(document, "Rules") ?? "";
    expect(section).toContain("### Hard rules");
    expect(section).toContain("One rule here.");
  });
});

/**
 * A heading-shaped line inside a fenced code block is content: a renderer shows it as code. If the
 * extractor stopped there, the tail of a bloated rules section would go unmeasured and the Rule A8
 * cap would report green on a document that violates it. Each case below is that evasion attempt.
 */
describe("extractSection: fenced code is content, not a section boundary", () => {
  /** `## Versioning` is the real boundary; `tail` must never be measured. */
  function sectionOf(...body: string[]): string {
    const markdown = ["# T", "", "## Rules", "", ...body, "", "## Versioning", "", "tail", ""].join(
      "\n",
    );
    return extractSection(markdown, "Rules") ?? "";
  }

  test("planted negative: a backtick-fenced fake heading does not truncate the section", () => {
    const section = sectionOf("before", "", "```", "## Fake", "```", "", "after");
    expect(section).toContain("after");
    expect(section).toContain("## Fake");
    expect(section).not.toContain("tail");
  });

  test("planted negative: a tilde-fenced fake heading does not truncate the section", () => {
    const section = sectionOf("before", "", "~~~", "## Fake", "~~~", "", "after");
    expect(section).toContain("after");
    expect(section).not.toContain("tail");
  });

  test("planted negative: a longer fence wrapping a shorter one keeps everything inside", () => {
    const section = sectionOf("before", "", "````", "```", "## Fake", "```", "````", "", "after");
    expect(section).toContain("after");
    expect(section).toContain("## Fake");
    expect(section).not.toContain("tail");
  });

  test("a fence closes on a run at least as long as its opener, and not on a shorter one", () => {
    const closedByLonger = sectionOf("````", "## Fake", "`````", "", "after");
    expect(closedByLonger).toContain("after");
    expect(closedByLonger).not.toContain("tail");

    // The three-backtick run cannot close a four-backtick fence, so the real `## Versioning`
    // heading stays inside the code block and the section runs to the end of the document.
    const notClosedByShorter = sectionOf("````", "## Fake", "```", "", "after");
    expect(notClosedByShorter).toContain("tail");
  });

  test("a marker run with trailing content does not close a fence", () => {
    const section = sectionOf("```", "## Fake", "``` still open", "## AlsoFake", "", "after");
    expect(section).toContain("## AlsoFake");
    expect(section).toContain("tail");
  });

  test("a mismatched marker does not close a fence", () => {
    const section = sectionOf("```", "## Fake", "~~~", "## AlsoFake", "", "after");
    expect(section).toContain("## AlsoFake");
    expect(section).toContain("tail");
  });

  test("fences may be indented up to three spaces, and an info string is allowed", () => {
    const section = sectionOf("   ```json", '{"heading": "## Fake"}', "## Fake", "   ```", "after");
    expect(section).toContain("after");
    expect(section).not.toContain("tail");
  });

  test("a tilde fence may carry backticks in its info string, unlike a backtick fence", () => {
    // CommonMark 4.5 forbids backticks in a *backtick* fence's info string only.
    const section = sectionOf("~~~ `lang`", "## Fake", "~~~", "", "after");
    expect(section).toContain("after");
    expect(section).toContain("## Fake");
    expect(section).not.toContain("tail");
  });

  test("a longer tilde opener is not closed by a shorter tilde run", () => {
    const section = sectionOf("~~~~", "## Fake", "~~~", "", "after");
    expect(section).toContain("tail");
  });

  test("a closer may be indented up to three spaces even when the opener is not", () => {
    const section = sectionOf("```", "## Fake", "   ```", "", "after");
    expect(section).toContain("after");
    expect(section).not.toContain("tail");
  });

  test("a four-space indented marker run is code, not a closer", () => {
    const section = sectionOf("```", "## Fake", "    ```", "## AlsoFake", "", "after");
    expect(section).toContain("## AlsoFake");
    expect(section).toContain("tail");
  });

  test("inline code is not a fence: a backtick info string never opens one", () => {
    // ``` `code` ``` would be a fence with a backtick in its info string, which CommonMark forbids.
    const section = sectionOf("``` `inline` ```", "", "after");
    expect(section).toContain("after");
    expect(section).not.toContain("tail");
  });

  test("four-space indented heading-shaped lines are code, so they do not truncate either", () => {
    const section = sectionOf("before", "", "    ## Fake", "", "after");
    expect(section).toContain("after");
    expect(section).not.toContain("tail");
  });

  test("an unclosed fence runs to the end of the document, which over-counts rather than under-counts", () => {
    const section = sectionOf("before", "", "```", "## Fake", "", "after");
    // No closing fence: CommonMark keeps the block open to EOF, so the real `## Versioning`
    // boundary is swallowed. That direction trips the cap loudly instead of hiding words.
    expect(section).toContain("tail");
  });

  test("a fenced `## Rules` in the preamble does not open the section", () => {
    const markdown = [
      "# T",
      "",
      "An example of the heading we measure:",
      "",
      "```markdown",
      "## Rules",
      "decoy body that must never be measured",
      "```",
      "",
      "## Rules",
      "",
      "the real rules",
      "",
      "## Versioning",
      "",
    ].join("\n");
    expect(extractSection(markdown, "Rules")).toBe("the real rules");
  });

  test("a fenced `## Rules` with no real heading is still absent, not a false measurement", () => {
    const markdown = ["# T", "", "```", "## Rules", "decoy", "```", ""].join("\n");
    expect(extractSection(markdown, "Rules")).toBeUndefined();
  });
});

/**
 * JavaScript's `.` never matches `\r`, so a CR-terminated line matches neither the ATX grammar nor
 * a fence delimiter. Splitting on "\n" alone therefore left every heading and every fence
 * delimiter invisible on CRLF input — and, worse, *partly* invisible on mixed input, which is a
 * silent under-count rather than a loud refusal.
 */
describe("extractSection: line endings", () => {
  const lf = [
    "# T",
    "",
    "## Rules",
    "",
    "before",
    "",
    "```",
    "## Fake",
    "```",
    "",
    "after",
    "",
    "## Versioning",
    "",
    "tail",
    "",
  ].join("\n");

  test("planted negative: a CRLF document measures exactly what its LF twin measures", () => {
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(extractSection(crlf, "Rules")).toBe(extractSection(lf, "Rules") ?? "");
    expect(extractSection(crlf, "Rules")).toContain("after");
    expect(extractSection(crlf, "Rules")).not.toContain("tail");
  });

  test("planted negative: a lone-CR document behaves the same", () => {
    expect(extractSection(lf.replace(/\n/g, "\r"), "Rules")).toBe(
      extractSection(lf, "Rules") ?? "",
    );
  });

  test("planted negative: CRLF fence delimiters inside an LF document cannot hide the tail", () => {
    // The editor artifact that matters: only the fence delimiters carry CRLF. Before the fix the
    // fence never opened, so the fenced `## Fake` truncated the section and the words after it
    // went unmeasured.
    const mixed = lf.replace(/^```$/gm, "```\r");
    const section = extractSection(mixed, "Rules") ?? "";
    expect(section).toContain("after");
    expect(section).toContain("## Fake");
    expect(section).not.toContain("tail");
  });

  test("a CRLF heading is found at all, rather than reading as an absent section", () => {
    expect(extractSection("# T\r\n\r\n## Rules\r\n\r\nbody\r\n", "Rules")).toBe("body");
  });

  test("the returned section is LF-normalized, so no \\r reaches a caller", () => {
    expect(extractSection(lf.replace(/\n/g, "\r\n"), "Rules")).not.toContain("\r");
  });

  test("word counts do not depend on the document's line endings", () => {
    const words = (text: string) => countWords(extractSection(text, "Rules") ?? "");
    expect(words(lf.replace(/\n/g, "\r\n"))).toBe(words(lf));
    expect(words(lf.replace(/\n/g, "\r"))).toBe(words(lf));
  });
});

describe("extractSection: ATX heading grammar", () => {
  test("a closing hash sequence is not part of the heading name", () => {
    const markdown = ["# T", "", "## Rules ##", "", "body", "", "## Next ##", "", "tail"].join(
      "\n",
    );
    expect(extractSection(markdown, "Rules")).toBe("body");
  });

  test("a heading may be indented up to three spaces", () => {
    const markdown = ["# T", "", "   ## Rules", "", "body", "", "   ## Next", "", "tail"].join(
      "\n",
    );
    expect(extractSection(markdown, "Rules")).toBe("body");
  });

  test("no space after the hashes is not a heading at all", () => {
    const markdown = ["# T", "", "##Rules", "", "body", ""].join("\n");
    expect(extractSection(markdown, "Rules")).toBeUndefined();
  });

  test("a bare `##` ends a section, as a renderer would show it", () => {
    const markdown = ["# T", "", "## Rules", "", "body", "", "##", "", "tail", ""].join("\n");
    expect(extractSection(markdown, "Rules")).toBe("body");
  });
});
