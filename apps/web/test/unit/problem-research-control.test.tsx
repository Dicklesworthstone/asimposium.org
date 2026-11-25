import { expect, mock, test } from "bun:test";
import { SYNTHESES_SCHEMA_ID, type SynthesesListResponse } from "@asimposium/contracts/syntheses";
import { CLAIMS_LIST_SCHEMA_ID, type ClaimsListResponse } from "@asimposium/contracts/claims-list";
import { parseResultClaimConsoleQuery, resultClaimConsolePath } from "../../lib/result-claim-view";
import { ResultClaimChoices, ResultClaimReview } from "../../components/result-claim-selection";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { synthesisSelectionPage } from "../../lib/synthesis-view";
import { researchClaimPreview, researchPreview, researchSynthesis } from "../fixtures/problem-research";

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

test("ordinary warned synthesis choices retain their public notice without becoming closing candidates", () => {
  const notice = { category: "dual-use-boundary", action: "published-with-warning",
    notice: "screening-warning" } as const;
  const synthesis = { ...researchSynthesis, synthesis_id: "SYNTH-ORDINARY",
    closing_resolution: undefined, screening_notice: notice };
  const page = synthesisSelectionPage({
    schema: SYNTHESES_SCHEMA_ID, problem_id: "P-RESEARCH", cursor: 40,
    before: null, next_before: null, omitted: [], syntheses: [synthesis],
  });
  expect(page.choices[0]?.screening_notice).toEqual(notice);
  expect(JSON.stringify(page)).not.toContain(researchSynthesis.body_md);
  const content = PublishedSynthesisChoices({ problemId: "P-RESEARCH", page,
    query: {}, selected: "", disabled: false, onSelect: () => {} });
  const html = renderToStaticMarkup(content);
  expect(html).toContain('data-screening-notice="screening-warning"');
  expect(html).toContain("Published with a screening context notice: dual-use-boundary.");
  expect(html).toContain("No structured closing declaration was recorded");
  expect(html).not.toContain(researchSynthesis.body_md);
  expect(callbacks(content)).toHaveLength(0);
});

test("result claim discovery selects an exact publication without submitting a lifecycle command", () => {
  const page: ClaimsListResponse = {
    schema: CLAIMS_LIST_SCHEMA_ID, problem_id: "P-RESEARCH", cursor: 40,
    after: 8, scanned_through: 12, next_after: 12, count: 1, omitted: ["page_limit"],
    claims: [{
      id: "C-3", version: 2, kind: "lemma",
      statement: "The two cases cover every integer $n$.",
      source_seq: 9, created_at: "2026-11-24T12:00:00.000Z", stale: false,
    }],
  };
  const selected: [string, number][] = [];
  const props = { problemId: page.problem_id, page, selected: "C-3@2",
    onSelect: (id: string, version: number) => { selected.push([id, version]); } };
  const content = ResultClaimChoices({ ...props, disabled: false });
  const html = renderToStaticMarkup(content);
  expect(html).toContain("Load exact preview of C-3@2");
  expect(html).toContain("katex");
  expect(html).toContain("/p/P-RESEARCH/claims/C-3%402?through=40");
  expect(html).toContain("/console/problems/P-RESEARCH?claim=C-3%402&amp;claim_through=40&amp;claim_after=12");
  expect(html).not.toContain("Enter result review for this claim");
  callbacks(content)[0]?.();
  expect(selected).toEqual([["C-3", 2]]);
  callbacks(ResultClaimChoices({ ...props, disabled: true }))[0]?.();
  expect(selected).toEqual([["C-3", 2]]);
});

test("unavailable claim ranges preserve collection progress and never imply a clear scientific result", () => {
  const page: ClaimsListResponse = {
    schema: CLAIMS_LIST_SCHEMA_ID, problem_id: "P-RESEARCH", cursor: 40,
    after: 8, scanned_through: 12, next_after: 12, count: 0, claims: [],
    omitted: ["page_limit", "content_unavailable", "standing_unavailable"],
  };
  const html = renderToStaticMarkup(<ResultClaimChoices
    problemId={page.problem_id} page={page} disabled={false} onSelect={() => {}} />);
  expect(html).toContain("could not be read");
  expect(html).toContain("claim_after=12");
  expect(html).toContain("Some scientific standing could not be established");
  expect(html).not.toContain("This range returned no claims");
  const unavailable = renderToStaticMarkup(<ResultClaimChoices
    problemId={page.problem_id} page={null} disabled={false} onSelect={() => {}} />);
  expect(unavailable).toContain("Published claim choices are unavailable");
  expect(unavailable).not.toContain("No claims");
});

test("result review displays the complete exact formulation and its current recorded limitations", () => {
  const html = renderToStaticMarkup(<ResultClaimReview preview={{
    ...researchClaimPreview,
    state: { ...researchClaimPreview.state, stale: true, latest_version: 2, directive_disclosure: "missing" },
  }} />);
  expect(html).toContain("Exact result claim C-3@1");
  expect(html).toContain("An integer outside the two parity classes.");
  expect(html).toContain("F-RESEARCH-AUTHOR");
  expect(html).toContain("katex");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("marked stale");
  expect(html).toContain("A later claim version is available");
  expect(html).toContain("required sponsor disclosures are incomplete");
  expect(html).toContain("claim=C-3&amp;version=1");
  expect(html).toContain("/p/P-RESEARCH/claims/C-3%401?through=12");
});

test("result selection navigation retains exact safe cursors and rejects ambiguous selections", () => {
  expect(parseResultClaimConsoleQuery({ claim: "C-3@2", claim_through: "40", claim_after: "12" }))
    .toEqual({ selected: "C-3@2", list: { through: 40, after: 12 } });
  expect(resultClaimConsolePath("P-RESEARCH", "C-3@2", { through: 40, after: 12 }))
    .toBe("/console/problems/P-RESEARCH?claim=C-3%402&claim_through=40&claim_after=12");
  for (const query of [
    { claim: ["C-3@2", "C-4@1"] }, { claim: "C-3" }, { claim: "C-3@2\n" },
    { claim: "C-3@9007199254740992" }, { claim_through: "4", claim_after: "5" },
    { claim_through: ["4", "5"] }, { claim: "C-3@1", synthesis: "SYNTH-1" },
    { claim_after: "12", untrusted: "text" },
  ]) expect(parseResultClaimConsoleQuery(query)).toBeNull();
});
