import assert from "node:assert/strict";
import { test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import type { ClaimDependencySnapshot } from "../../src/ledger/claim-dependency-snapshot.ts";
import { computeDependencyCeilings, type CeilingNode } from "../../src/ledger/dependency-ceiling.ts";
import { readClaimGraphPack } from "../../src/sessions/claim-graph-pack.ts";
import { composePack, composePackWithLegacyEstimatorForTest } from "../../../../packages/render/src/pack-composer.ts";

const problem = "P-GRAPH", cursor = 20;
function node(target: string, dependencies: string[] = [], overrides: Partial<CeilingNode["standing"]> = {}): CeilingNode {
  return { target, dependencies, standing: { complete: true, disposition: "corroborated",
    review_state: "independently-checked", stale: false,
    latest_version: Number(target.split("@")[1]), own_ceiling: "computation", ...overrides } };
}
function snapshot(target: string, nodes: CeilingNode[]): ClaimDependencySnapshot {
  const map = new Map(nodes.map(n => [n.target, n]));
  const reached = [target], seen = new Set(reached);
  for (let i = 0; i < reached.length; i++) for (const next of map.get(reached[i]!)?.dependencies ?? []) {
    if (!seen.has(next)) { seen.add(next); reached.push(next); }
  }
  const chosen = reached.map(pin => map.get(pin)!);
  const chains = computeDependencyCeilings(chosen);
  return { problem, target, through: cursor,
    closure: { root_available: true, complete: true, unavailable: [],
      nodes: chosen.slice(1).map(n => ({ target: n.target, pins: [] })) as ClaimDependencySnapshot["closure"]["nodes"],
      edges: chosen.flatMap(n => n.dependencies!.map(to => ({ from: n.target, to, available: true }))) },
    assessments: new Map(chosen.map(n => [n.target, { scope: "publication-pins", problem, target: n.target,
      through: cursor, standing: n.standing, chain: chains.get(n.target)! }])) };
}
function fixture(nodes = [node("C-2@1", ["C-1@1"]), node("C-1@1", [], { own_ceiling: "citation" })]) {
  const calls: string[] = [];
  const db = { prepare(sql: string) {
    assert.ok(sql.includes("heads AS MATERIALIZED"));
    return { bind(input: string) {
      assert.deepEqual(JSON.parse(input), { problem, cursor });
      return { async all() { return { results: nodes.length ? nodes.slice(0,5).map((n, index) => ({
        problem_id: problem, through: cursor, event_id: `EV-${cursor-index}`, seq: cursor-index,
        claim_id: n.target.split("@")[0], version: Number(n.target.split("@")[1]), publications: 1, available: 1,
      })) : [{ problem_id: problem, through: cursor, event_id: null }] }; } };
    } };
  } } as unknown as D1Database;
  const load = async (_db: D1Database, scope: string, through: number, target: string) => {
    assert.equal(scope, problem); assert.equal(through, cursor); calls.push(target);
    return snapshot(target, nodes);
  };
  return { db, load, calls, read: () => readClaimGraphPack(db, problem, cursor, load) };
}
function compose(section: Awaited<ReturnType<typeof readClaimGraphPack>>, budget=4000) {
  return composePack({ schema: "asimposium.pack.v1", session: "S-TEST", problem,
    cursor, profile: "claim-graph", requested_max_tokens: budget,
    viewer: { audience: "session", membership: "contributor", effective_permissions: [] },
    candidates: section.candidates, action_candidates: [],
    omitted: [...section.omitted, { reason: "profile_section_not_composed", detail: "weakest-link-paths" }] });
}

test("graph packs carry canonical paths, separate source data from policy, and retire the old unimplemented notice", async () => {
  const f = fixture(), section = await f.read(), pack = compose(section);
  const context = section.candidates[0]!;
  assert.equal(context.scope, "system"); assert.equal(context.untrusted, false);
  assert.deepEqual(context.composed_section, { profile: "claim-graph", name: "weakest-link-paths" });
  const paths = pack.items.filter(item => item.kind === "claim-graph-path");
  assert.equal(paths.length, 2);
  const root = JSON.parse(paths[0]!.body);
  assert.deepEqual(root.chain.weakest_path, ["C-2@1", "C-1@1"]);
  assert.equal(root.chain.ceiling, "citation"); assert.equal(root.standing.own_ceiling, "computation");
  assert.equal(root.limiting_premise.read_url, "/p/P-GRAPH/claims/C-1@1.md?through=20");
  for (const item of paths) { assert.equal(item.scope, "ledger"); assert.equal(item.untrusted, true); }
  assert.ok(!pack.omitted.some(o => o.reason === "profile_section_not_composed"));
  assert.ok(!pack.canonical_json.includes("composed_section"));
});

for (const state of [{ disposition: "withdrawn" }, { disposition: "disputed", review_state: "contested" }, { latest_version: 2 }] as const) {
  test(`closed or disputed premises remain visible without positive evidence: ${JSON.stringify(state)}`, async () => {
    const f = fixture([node("C-2@1", ["C-1@1"]), node("C-1@1", [], state)]);
    const section = await f.read(), pack = compose(section);
    const parent = pack.items.filter(i => i.kind === "claim-graph-path").map(i => JSON.parse(i.body)).find(g => g.target === "C-2@1");
    assert.ok(parent); assert.equal(parent.chain.ceiling, null);
    assert.equal(parent.standing.disposition, "corroborated");
    assert.ok(pack.omitted.some(o => o.reason === "premise_assessment_unavailable"));
    assert.ok(!pack.omitted.some(o => o.reason === "profile_section_not_composed"));
  });
}

test("a weak unreviewed premise does not inherit the root's review standing", async () => {
  const f = fixture([node("C-2@1", ["C-1@1"]), node("C-1@1", [], { disposition: "open", review_state: "unreviewed", own_ceiling: "assertion" })]);
  const section = await f.read(); const root = JSON.parse(section.candidates[1]!.body);
  assert.equal(root.chain.ceiling, "assertion");
  assert.equal(root.limiting_premise.standing.disposition, "open");
  assert.equal(root.limiting_premise.standing.review_state, "unreviewed");
});

test("available empty scope has a truthful baseline, not an unimplemented feature warning", async () => {
  const f = fixture([]), section = await f.read(), pack = compose(section);
  assert.match(section.candidates[0]!.body, /No published claim heads/);
  assert.equal(pack.items.filter(i => i.kind === "claim-graph-path").length, 0);
  assert.ok(!pack.omitted.some(o => o.reason === "profile_section_not_composed"));
  assert.equal(f.calls.length, 0);
});

test("storage failures disclose unavailable graph data while not echoing internal error details", async () => {
  const db = { prepare() { throw new Error("PRIVATE-QUERY-DATA"); } } as unknown as D1Database;
  const section = await readClaimGraphPack(db, problem, cursor), pack = compose(section);
  assert.ok(pack.omitted.some(o => o.reason === "content_unavailable"));
  assert.ok(!pack.omitted.some(o => o.reason === "profile_section_not_composed"));
  assert.ok(!JSON.stringify(pack).includes("PRIVATE-QUERY-DATA"));
  assert.match(section.candidates[0]!.body, /temporarily unavailable/);
});

test("whole path summaries are budgeted as records, not cut into apparently complete paths", async () => {
  const nodes = Array.from({length:64}, (_,i) => node(`C-${64-i}@1`, i<63 ? [`C-${63-i}@1`] : [], {own_ceiling:i<63?'computation':'assertion'}));
  const section = await fixture(nodes).read();
  const original = new Map(section.candidates.map(i => [i.id, i.body]));
  for (const budget of [800,1500,2500,4000,8000]) {
    const pack = compose(section,budget);
    assert.ok(pack.tokens_estimate <= budget);
    for (const item of pack.items) assert.equal(item.body,original.get(item.id));
    if (pack.items.length < section.candidates.length) assert.ok(pack.omitted.some(o=>o.reason==='budget_exceeded'));
    assert.ok(!pack.omitted.some(o=>o.reason==='profile_section_not_composed'));
  }
});

test("long exact targets still have bounded unique renderer item IDs", async () => {
  const target = `C-${'1'.repeat(45)}@${Number.MAX_SAFE_INTEGER}`;
  const section = await fixture([node(target)]).read();
  assert.equal(section.candidates[1]!.id.length,38);
  assert.match(section.candidates[1]!.id,/^GRAPH-[a-f0-9]{32}$/);
  assert.equal(JSON.parse(section.candidates[1]!.body).target,target);
  assert.ok(compose(section).items.some(i=>i.kind==='claim-graph-path'));
});

test("record identity does not shift when other selected roots disappear", async () => {
  const both = await fixture().read(), leafOnly = await fixture([node('C-1@1',[],{own_ceiling:'citation'})]).read();
  const leaf = both.candidates.find(i=>i.kind==='claim-graph-path'&&JSON.parse(i.body).target==='C-1@1')!;
  assert.equal(leaf.id,leafOnly.candidates[1]!.id);
});

test("all four selected roots and root-limit omissions survive composition when the budget permits", async () => {
  const nodes = Array.from({length:6},(_,i)=>node(`C-${6-i}@1`));
  const section = await fixture(nodes).read(), pack = compose(section,8000);
  assert.equal(pack.items.filter(i=>i.kind==='claim-graph-path').length,4);
  assert.ok(pack.omitted.some(o=>o.reason==='candidate_limit'));
});

test("graph candidates remain deterministic and both canonical budget estimators agree", async () => {
  const f = fixture(), section = await f.read(); assert.deepEqual(section,await f.read());
  const input = { schema:'asimposium.pack.v1',session:'S-TEST',problem,cursor,profile:'claim-graph',
    requested_max_tokens:2500,viewer:{audience:'session' as const,membership:'contributor' as const,effective_permissions:[]},
    candidates:section.candidates,action_candidates:[],omitted:[{reason:'profile_section_not_composed',detail:'weakest-link-paths'}] };
  assert.deepEqual(composePack(input),composePackWithLegacyEstimatorForTest(input));
});
