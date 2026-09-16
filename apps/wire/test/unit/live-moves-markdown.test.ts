import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ProblemNextResponse, TriageResponse } from "@asimposium/contracts";
import { renderProblemNextMarkdown, renderTriageMarkdown } from "../../src/mega-commands/markdown.ts";

function response(): ProblemNextResponse {
  return { problem_id: "P-DEMO", viewer: { role: "observer", effective_permissions: { review: true, promote: false } },
    primary_move: null, alternatives: [], degraded: true, degraded_reason: "MOVES_PARTIAL",
    selection_boundary: "bounded: two pages\nnot a global optimum" };
}
test("next renders its selection boundary as one quoted YAML value", () => {
  const input = response(); const md = renderProblemNextMarkdown(input);
  const line = md.split("\n").find(line => line.startsWith("selection_boundary: "));
  assert.equal(JSON.parse(line!.slice("selection_boundary: ".length)), input.selection_boundary);
  assert.match(md, /review: true/); assert.match(md, /promote: false/);
});
test("partial or failed discovery does not falsely claim the engine is inactive", () => {
  const md = renderProblemNextMarkdown(response());
  assert.match(md, /incomplete or temporarily unavailable/); assert.ok(!md.includes("engine is inactive"));
});
test("triage keeps bounded ranking distinct from a global highest-value claim", () => {
  const input = { hello: { fellow: { fellow_id: "F-DEMO", name: "reader" } }, move: null,
    degraded: false, selection_boundary: "bounded: four assignments" } as unknown as TriageResponse;
  const md = renderTriageMarkdown(input);
  assert.match(md, /# Triage: Recommended Move/); assert.ok(!md.includes("Highest-EV"));
  assert.match(md, /assignment and admission limits/);
});
test("selected contract and exact refs remain in the Markdown reading face", () => {
  const input = response(); input.primary_move = { move: "review", why: "Read the isolated record.",
    refs: ["P-DEMO", "C-1@2"], contract: { target_version: 2, read_first: "/p/P-DEMO/claims/C-1@2.md?through=10" } };
  const md = renderProblemNextMarkdown(input);
  assert.match(md, /C-1@2/); assert.match(md, /through=10/); assert.match(md, /"target_version": 2/);
});
