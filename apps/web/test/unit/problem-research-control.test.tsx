import { expect, mock, test } from "bun:test";
import { SYNTHESES_SCHEMA_ID, type SynthesesListResponse } from "@asimposium/contracts/syntheses";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { synthesisSelectionPage } from "../../lib/synthesis-view";
import { researchPreview, researchSynthesis } from "../fixtures/problem-research";

mock.module("server-only", () => ({}));
const { ClosingSynthesisReview, PublishedSynthesisChoices } = await import("../../components/problem-research-control");

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

test("closing inspection has a safe human source even when no trusted Stoa origin is configured", () => {
  for (const stoaOrigin of [undefined, "https://attacker.example", "javascript:alert(1)"]) {
    const html = renderToStaticMarkup(
      <ClosingSynthesisReview preview={researchPreview} stoaOrigin={stoaOrigin} />,
    );
    expect(html).toContain('href="/p/P-RESEARCH/syntheses/SYNTH-CLOSING%401"');
    expect(html).not.toContain('href="https://');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("Complete closing summary");
    expect(html).toContain("SYNTH-CLOSING");
  }
});

function callbacks(node: ReactNode): (() => void)[] {
  const result: (() => void)[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
    if (child.type === "button" && child.props.onClick) result.push(child.props.onClick);
    result.push(...callbacks(child.props.children));
  });
  return result;
}

test("published candidates select only their exact identifier and respect pending-recovery controls", () => {
  const page = synthesisSelectionPage({
    schema: SYNTHESES_SCHEMA_ID, problem_id: "P-RESEARCH", cursor: 40,
    before: 20, next_before: 12, omitted: ["page_limit"], syntheses: [researchSynthesis],
  });
  const selected: string[] = [];
  const props = { problemId: "P-RESEARCH", page, query: { through: 40, before: 20, limit: 2 },
    selected: "SYNTH-CLOSING", onSelect: (id: string) => { selected.push(id); } };
  const enabled = PublishedSynthesisChoices({ ...props, disabled: false });
  const html = renderToStaticMarkup(enabled);
  expect(html).toContain("Load exact preview of SYNTH-CLOSING");
  expect(html).toContain("Closing declaration for");
  expect(html).toContain("C-3@1");
  expect(html).toContain("/console/problems/P-RESEARCH?through=40&amp;before=12&amp;limit=2&amp;synthesis=SYNTH-CLOSING");
  expect(html).not.toContain(researchSynthesis.body_md);
  expect(html).not.toContain("Resolve using this exact synthesis");
  const actions = callbacks(enabled);
  expect(actions).toHaveLength(1);
  actions[0]?.();
  expect(selected).toEqual(["SYNTH-CLOSING"]);
  const blocked = PublishedSynthesisChoices({ ...props, disabled: true });
  expect(renderToStaticMarkup(blocked)).toContain('disabled=""');
  callbacks(blocked)[0]?.();
  expect(selected).toEqual(["SYNTH-CLOSING"]);
});

test("withheld candidate pages retain progress and unsupported closing records cannot be selected", () => {
  const base: Omit<SynthesesListResponse, "syntheses"> = {
    schema: SYNTHESES_SCHEMA_ID, problem_id: "P-RESEARCH", cursor: 40,
    before: 20, next_before: 12, omitted: ["page_limit", "content_unavailable"],
  };
  const empty = renderToStaticMarkup(<PublishedSynthesisChoices
    problemId="P-RESEARCH" page={synthesisSelectionPage({ ...base, syntheses: [] })}
    query={{ through: 40, before: 20 }} selected="" disabled={false} onSelect={() => {}} />);
  expect(empty).toContain("No readable publications were returned on this page");
  expect(empty).toContain("through=40&amp;before=12");
  expect(empty).not.toContain("No syntheses were returned in this range");
  const missing = { ...researchSynthesis, synthesis_id: "SYNTH-ORDINARY", closing_resolution: undefined };
  const tooLong = { ...researchSynthesis, body_md: "x".repeat(8193) };
  const content = PublishedSynthesisChoices({
    problemId: "P-RESEARCH", page: synthesisSelectionPage({ ...base, syntheses: [missing, tooLong] }),
    query: {}, selected: "", disabled: false, onSelect: () => {},
  });
  expect(callbacks(content)).toHaveLength(0);
  const html = renderToStaticMarkup(content);
  expect(html).toContain("No structured closing declaration was recorded");
  expect(html).toContain("complete summary exceeds the closing-control limit");
  expect(html).not.toContain("x".repeat(100));
});
