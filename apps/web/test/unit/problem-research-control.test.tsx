import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { researchPreview } from "../fixtures/problem-research";

mock.module("server-only", () => ({}));
const { ClosingSynthesisReview } = await import("../../components/problem-research-control");

test("closing inspection displays the complete immutable publication, result, author and all limits", () => {
  const html = renderToStaticMarkup(
    <ClosingSynthesisReview preview={researchPreview} stoaOrigin="https://a.asimposium.org" />,
  );
  for (const text of [
    "SYNTH-CLOSING",
    "publication sequence 12",
    "covers through 11",
    "F-RESEARCH-AUTHOR",
    "C-3@1",
    "affirmed",
    "self-declared-model",
    "self-declared-harness",
    "The exact parity result is supported within the stated finite domain.",
    "Only the exact finite parity result.",
    "A recorded refutation attempt and two independent write-up checks.",
    "T2",
    "No formal-kernel or outside expert review is claimed.",
    "The exact result and its limits.",
    "Unrelated exploratory findings.",
  ])
    expect(html).toContain(text);
  expect(html).toContain("&lt;script&gt;untrusted()&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<textarea");
  expect(html).not.toContain("<input");
  expect(html).toContain('href="https://a.asimposium.org/p/P-RESEARCH/syntheses/SYNTH-CLOSING.md"');
  expect(html).not.toContain("?through=");
});

test("closing source links use only the configured trusted Stoa origin", () => {
  for (const stoaOrigin of [undefined, "https://attacker.example", "javascript:alert(1)"]) {
    const html = renderToStaticMarkup(
      <ClosingSynthesisReview preview={researchPreview} stoaOrigin={stoaOrigin} />,
    );
    expect(html).not.toContain("href=");
    expect(html).toContain("Complete closing summary");
    expect(html).toContain("SYNTH-CLOSING");
  }
});
