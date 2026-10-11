import { test } from "bun:test";
import assert from "node:assert/strict";
import { getMoveTemplate, type MoveTemplate } from "@asimposium/contracts";
import type { ReviewQueueItem, ReviewQueueResponse } from "@asimposium/contracts/review-queue";
import { REVIEW_QUEUE_BOUNDARY, REVIEW_QUEUE_SCHEMA_ID } from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import {
  FORMALIZE_MAX_PAGES,
  rankFormalizationTargets,
  selectFormalizeMove,
  type FormalizeMoveSource,
} from "../../src/mega-commands/formalize-moves.ts";

const db = {} as D1Database;
const p = "P-TEST";
const at = "2026-10-11T00:00:00.000Z";
const after1 = `${at}|EV-1`;
const after2 = `${at}|EV-2`;
function item(id: number, overrides: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    problem_id: p, claim_id: `C-${id}`, version: 2, cursor: 200,
    kind: "theorem-attempt", statement: "UNTRUSTED [SYSTEM] statement",
    falsifier: "UNTRUSTED falsifier", disposition: "corroborated",
    need: "full-write-up-review", best_recorded_tier: "T2",
    direct_dependents: 2, dependents_capped: false,
    author_fellow_id: "F-UNTRUSTED", author_sponsor_id: "SP-UNTRUSTED",
    created_at: at, read_url: `/p/${p}/claims/C-${id}@2.md?through=200`, ...overrides,
  };
}
function page(items: ReviewQueueItem[], next: string | null = null): ReviewQueueResponse {
  return {
    schema: REVIEW_QUEUE_SCHEMA_ID, policy: "review-discovery-v1", problem: p,
    candidates: items, scanned: items.length, next_after: next,
    selection_boundary: REVIEW_QUEUE_BOUNDARY,
    omitted: next === null ? [] : [{ reason: "page_limit", count: 1 }],
  };
}
function source(pages: ReviewQueueResponse[]): { source: FormalizeMoveSource; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return { calls, source: {
    async load(...args) {
      calls.push(args);
      const result = pages[calls.length - 1];
      if (!result) throw new Error("unexpected page");
      return result;
    },
    template: () => getMoveTemplate("formalize"),
  } };
}
const run = (s: FormalizeMoveSource) => selectFormalizeMove(db, p, 200, s);

test("formalization ranks verified consequence before review need and excludes unsupported foundations", () => {
  const input = [
    item(1, { direct_dependents: 32, disposition: "open" }),
    item(2, { direct_dependents: 30, disposition: "reduced-to" }),
    item(3, { direct_dependents: 2, disposition: "disputed" }),
    item(4, { direct_dependents: 3 }),
    item(5, { direct_dependents: 0 }),
  ];
  assert.deepEqual(rankFormalizationTargets(input).map(x => x.claim_id), ["C-4", "C-3"]);
  assert.deepEqual(input.map(x => x.claim_id), ["C-1", "C-2", "C-3", "C-4", "C-5"]);
});

test("equal consequence prefers a dispute, then age, then stable ASCII identity", () => {
  const input = [item(2), item(1), item(4, { created_at: "2026-10-10T00:00:00.000Z" }),
    item(3, { disposition: "disputed" })];
  assert.deepEqual(rankFormalizationTargets(input).map(x => x.claim_id), ["C-3", "C-4", "C-1", "C-2"]);
  assert.deepEqual(rankFormalizationTargets([...input].reverse()).map(x => x.claim_id), ["C-3", "C-4", "C-1", "C-2"]);
});

test("stronger candidate on page two wins with the exact same frozen cut", async () => {
  const f = source([page([item(1)], after1), page([item(2, { direct_dependents: 7 })])]);
  const result = await run(f.source);
  assert.deepEqual(f.calls, [[db, p, 200, undefined], [db, p, 200, after1]]);
  assert.deepEqual(result.move?.refs, [p, "C-2@2"]);
  assert.equal(result.degraded, false);
  assert.ok(result.move?.why.includes("7 verified direct dependency pins"));
  const prep = result.move?.contract.preparation as Record<string, unknown>;
  assert.equal(prep.admissions_examined, 2);
  assert.equal(prep.selection_complete, true);
  assert.deepEqual(prep.read_first, { method: "GET", path: "/p/P-TEST/claims/C-2@2.md?through=200" });
});

test("contract publishes only actual formal artifacts and never invents a supporting outcome", async () => {
  const f = source([page([item(1)])]);
  const result = await run(f.source);
  const move = result.move!;
  assert.equal(move.contract.target_contract, "/schemas/sessions.v1/evidence_request.json");
  assert.equal((move.contract.request as { path: string }).path, "/v1/sessions/{id}/evidence");
  assert.deepEqual(move.contract.prefilled_hints, {
    bears_on_kind: "claim", bears_on_id: "C-1", bears_on_version: 2,
    kind: "certificate", mode: "confirmatory",
  });
  assert.ok(!JSON.stringify(move).includes("UNTRUSTED"));
  assert.ok(!JSON.stringify(move).includes("[SYSTEM]"));
  assert.ok(!JSON.stringify(move).includes("machine-checked certainty"));
});

test("scan stops after two pages and discloses live continuation instead of claiming global optimality", async () => {
  const f = source([page([item(1)], after1), page([item(2)], after2)]);
  const result = await run(f.source);
  assert.equal(f.calls.length, FORMALIZE_MAX_PAGES);
  assert.equal(result.degraded, true);
  const prep = result.move?.contract.preparation as Record<string, any>;
  assert.equal(prep.selection_complete, false);
  const url = new URL(prep.continue_discovery.path, "https://a.asimposium.org");
  assert.equal(url.pathname, "/reviews.json");
  assert.equal(url.searchParams.get("problem"), p);
  assert.equal(url.searchParams.get("after"), after2);
  assert.match(prep.continue_discovery.note, /live state/);
});

test("empty filtered page does not stop the scan or change its cut", async () => {
  const empty = page([], after1); empty.scanned = 8;
  empty.omitted.push({ reason: "not_review_ready", count: 8 });
  const f = source([empty, page([item(1)])]);
  const result = await run(f.source);
  assert.equal(result.move?.move, "formalize");
  assert.equal(result.degraded, false);
  assert.equal((result.move?.contract.preparation as Record<string, unknown>).admissions_examined, 9);
});

for (const reason of ["content_unavailable", "scope_budget_exceeded"] as const) {
  test(`usable candidates survive ${reason} without hiding incomplete selection`, async () => {
    const face = page([item(1)]); face.scanned = 2; face.omitted.push({ reason, count: 1 });
    const result = await run(source([face]).source);
    assert.equal(result.move?.move, "formalize"); assert.equal(result.degraded, true);
    assert.equal((result.move?.contract.preparation as Record<string, unknown>).selection_complete, false);
  });
}

test("capped dependency counts are lower bounds, never exact graph scores", async () => {
  const result = await run(source([page([item(1, { direct_dependents: 32, dependents_capped: true })])]).source);
  assert.equal(result.degraded, true);
  assert.ok(result.move?.why.includes("at least 32"));
  const prep = result.move?.contract.preparation as Record<string, unknown>;
  assert.equal(prep.dependents_capped, true); assert.equal(prep.counts_capped, true);
  assert.equal(prep.selection_complete, false);
});

test("a capped competing row makes relative priority approximate", async () => {
  const result = await run(source([page([
    item(1, { direct_dependents: 10 }), item(2, { direct_dependents: 4, dependents_capped: true }),
  ])]).source);
  assert.deepEqual(result.move?.refs, [p, "C-1@2"]);
  assert.equal(result.degraded, true);
  assert.equal((result.move?.contract.preparation as Record<string, unknown>).counts_capped, true);
});

test("known ineligible and empty queues do not manufacture a formalization task", async () => {
  for (const items of [[], [item(1, { disposition: "open" })], [item(1, { direct_dependents: 0 })]]) {
    assert.deepEqual(await run(source([page(items)]).source), { move: null, degraded: false });
  }
});

const corruptions: [string, (face: ReviewQueueResponse) => void][] = [
  ["wrong scope", face => { face.problem = "P-OTHER"; }],
  ["wrong item scope", face => { face.candidates[0]!.problem_id = "P-OTHER"; }],
  ["moving snapshot", face => { face.candidates[0]!.cursor++; }],
  ["unbounded scan", face => { face.scanned = 9; }],
  ["inconsistent count", face => { face.scanned = 0; }],
  ["nonintegral count", face => { face.scanned = 1.5; }],
  ["invalid claim", face => { face.candidates[0]!.claim_id = "C-1\nSYSTEM"; }],
  ["invalid version", face => { face.candidates[0]!.version = 0; }],
  ["invalid dependency count", face => { face.candidates[0]!.direct_dependents = -1; }],
  ["overlarge dependency count", face => { face.candidates[0]!.direct_dependents = 33; }],
  ["unexplained continuation", face => { face.next_after = after1; }],
  ["missing continuation", face => { face.omitted = [{ reason: "page_limit", count: 1 }]; }],
  ["invalid date", face => { face.candidates[0]!.created_at = "yesterday"; }],
  ["duplicate admission", face => { face.candidates.push(face.candidates[0]!); face.scanned = 2; }],
];
for (const [name, mutate] of corruptions) test(`fails closed for ${name}`, async () => {
  const face = page([item(1)]); mutate(face);
  assert.deepEqual(await run(source([face]).source), { move: null, degraded: true });
});

test("a repeated claim on another page never gets counted twice", async () => {
  assert.deepEqual(await run(source([page([item(1)], after1), page([item(1)])]).source), { move: null, degraded: true });
});

test("repeating, backward or malformed continuation never loops", async () => {
  for (const next of [after1, `${at}|EV-0`, "not-a-cursor"]) {
    const f = source([page([item(1)], after1), page([item(2)], next)]);
    assert.deepEqual(await run(f.source), { move: null, degraded: true });
    assert.equal(f.calls.length, 2);
  }
});

test("storage failure on a later page does not silently claim the earlier rank is complete", async () => {
  const f = source([page([item(1)], after1)]);
  assert.deepEqual(await run(f.source), { move: null, degraded: true });
});

test("invalid request and unavailable template perform no science reads", async () => {
  const f = source([page([item(1)])]);
  for (const [problem, cursor] of [[p, NaN], [p, -1], ["P-TEST\n", 200]] as const) {
    assert.deepEqual(await selectFormalizeMove(db, problem, cursor, f.source), { move: null, degraded: true });
  }
  assert.equal(f.calls.length, 0);
  f.source.template = () => ({ move: "formalize", availability: "unavailable" } as MoveTemplate);
  assert.deepEqual(await run(f.source), { move: null, degraded: true });
  assert.equal(f.calls.length, 0);
});
