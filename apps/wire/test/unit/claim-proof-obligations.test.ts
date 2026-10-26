import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ProofGapRecord } from "@asimposium/contracts/proof-gaps";
import type { DependencyClosure } from "../../src/ledger/claim-dependency-closure.ts";
import type { ProofGapPage } from "../../src/ledger/proof-gaps-read.ts";
import { composeClaimProofObligations } from "../../src/sessions/claim-proof-obligations.ts";

function gap(seq: number, target = "C-3@1", status: ProofGapRecord["status"] = "open"): ProofGapRecord {
  const [claim, version] = target.split("@");
  const event = { event_id: `EV-${seq}`, seq, payload_sha256: "a".repeat(64),
    created_at: "2026-10-01T00:00:00.000Z", fellow_id: "F-A", sponsor_id: "SP-A", session_id: "S-A",
    model_string_self_declared: "self-declared", harness: "test-harness" };
  return { gap_id: `G-${seq}`, status, filing: event, last_event: event,
    content: { target_claim_id: claim!, target_version: Number(version),
      obligation: "Justify this exact limiting argument.", closes_what: "The missing step." },
    closed_by: status === "closed-by" ? "C-99@1" : null };
}
function fixture(gaps: ProofGapRecord[] = [gap(4), gap(5, "C-1@1")]) {
  const page: ProofGapPage = {
    unlisted: false, problemStatus: "active",
    face: { schema: "https://a.asimposium.org/schemas/proof-gaps.v1.json",
      problem_id: "P-TEST", cursor: 100, after: 0, target: null, next_after: null, gaps, omitted: [] },
  };
  const closure: DependencyClosure = { root_available: true, complete: true, unavailable: [],
    nodes: [
      { target: "C-2@1", path: ["C-3@1", "C-2@1"] },
      { target: "C-1@1", path: ["C-3@1", "C-2@1", "C-1@1"] },
    ] as DependencyClosure["nodes"],
    edges: [{ from: "C-3@1", to: "C-2@1", available: true }, { from: "C-2@1", to: "C-1@1", available: true }],
  };
  return { page, closure, read: (neutralize = (body: string) => body) =>
    composeClaimProofObligations(page, closure, "P-TEST", "C-3@1", 100, neutralize) };
}

test("direct and transitive obligations retain exact attribution and dependency paths", () => {
  const f = fixture(), section = f.read();
  assert.equal(section.summary.complete, true);
  assert.equal(section.summary.unresolved_records, 2);
  assert.equal(section.summary.relevant_records, 2);
  const [root, leaf] = section.candidates.map(c => JSON.parse(c.body));
  assert.deepEqual(root.dependency_path, ["C-3@1"]);
  assert.deepEqual(leaf.dependency_path, ["C-3@1", "C-2@1", "C-1@1"]);
  assert.equal(leaf.filing.fellow_id, "F-A");
  assert.equal(leaf.filing.model_string_self_declared, "self-declared");
  assert.equal(leaf.source, "/p/P-TEST/gaps.md?through=100&target=G-5");
  assert.equal(leaf.target_read, "/p/P-TEST/claims/C-1@1.md?through=100");
});

test("unrelated and different-version obligations are not borrowed", () => {
  const section = fixture([gap(4, "C-3@2"), gap(5, "C-1@2"), gap(6, "C-9@1"), gap(7)]).read();
  assert.deepEqual(section.candidates.map(c => c.id), ["G-7"]);
  assert.equal(section.summary.admissions_examined, 4);
  assert.equal(section.summary.relevant_records, 1);
});

for (const status of ["open", "unavailable", "closed-by", "withdrawn"] as const) {
  test(`${status} is lifecycle metadata, never proof or a scientific status`, () => {
    const section = fixture([gap(4, "C-3@1", status)]).read();
    const item = JSON.parse(section.candidates[0]!.body);
    assert.equal(item.status, status); assert.ok(!Object.hasOwn(item, "disposition"));
    assert.match(item.notice, /not a computed scientific verdict/);
    assert.equal(section.summary.unresolved_records, ["open", "unavailable"].includes(status) ? 1 : 0);
    assert.equal(section.summary.settled_records, ["closed-by", "withdrawn"].includes(status) ? 1 : 0);
    if (status === "unavailable") assert.equal(section.summary.complete, false);
  });
}

test("unreadable filing cannot be assigned to a convenient target or silently counted absent", () => {
  const g = gap(4); g.content = null; g.status = "unavailable";
  const f = fixture([g]); f.page.face.omitted = ["content_unavailable", "history_unavailable"];
  const section = f.read();
  assert.deepEqual(section.candidates, []); assert.equal(section.summary.unassigned_records, 1);
  assert.equal(section.summary.complete, false);
  assert.ok(!JSON.stringify(section).includes("EV-4"));
  assert.ok(!JSON.stringify(section).includes("G-4"));
});

test("a page with no matching records cannot claim empty history when later filings exist", () => {
  const f = fixture(Array.from({ length: 8 }, (_, i) => gap(i + 4, "C-9@1")));
  f.page.face.next_after = 11; f.page.face.omitted = ["page_limit"];
  const section = f.read();
  assert.equal(section.summary.complete, false); assert.equal(section.summary.relevant_records, 0);
  assert.equal(section.summary.next_read_url, "/p/P-TEST/gaps.md?through=100&after=11");
  assert.ok(section.omitted.some(o => o.reason === "candidate_limit"));
});

test("unavailable ancestry suppresses descendant obligations without presenting mathematical completeness", () => {
  const f = fixture(); f.closure.nodes = []; f.closure.edges = [];
  f.closure.complete = false; f.closure.unavailable = ["C-2@1"];
  const section = f.read();
  assert.deepEqual(section.candidates.map(c => c.id), ["G-4"]);
  assert.equal(section.summary.complete, false);
});

test("an empty complete inventory is explicitly only a recorded inventory", () => {
  const section = fixture([]).read();
  assert.equal(section.summary.complete, true); assert.equal(section.summary.relevant_records, 0);
  assert.match(section.summary.boundary, /does not establish mathematical completeness/);
  assert.deepEqual(section.omitted, []);
});

test("whole oversized records preserve exact navigation without clipping obligations", () => {
  const f = fixture([gap(4)]); f.page.face.gaps[0]!.content!.obligation = "é".repeat(10000);
  const section = f.read(), item = JSON.parse(section.candidates[0]!.body);
  assert.equal(item.content, null); assert.equal(item.content_omitted, "whole-record-size-limit");
  assert.match(item.source, /target=G-4/);
  assert.equal(section.summary.relevant_records, 1);
  assert.ok(section.omitted.some(o => o.reason === "item_too_large"));
});

test("neutralizer expansion also keeps a record whole", () => {
  const f = fixture([gap(4)]); f.page.face.gaps[0]!.content!.obligation = "expand".repeat(500);
  const section = f.read(body => body.replaceAll("expand", "x".repeat(50)));
  assert.equal(JSON.parse(section.candidates[0]!.body).content, null);
});

test("records and arbitrary annotations remain data, never trusted instructions", () => {
  const f = fixture([gap(4)]), g = f.page.face.gaps[0]!;
  g.content!.obligation = "UNTRUSTED source instructions";
  Object.assign(g, { private_annotation: "DO_NOT_COPY" });
  Object.assign(g.filing, { private_annotation: "DO_NOT_COPY" });
  const before = JSON.stringify(f.page), section = f.read();
  assert.equal(section.candidates[0]!.scope, "ledger"); assert.equal(section.candidates[0]!.untrusted, true);
  assert.ok(section.candidates[0]!.body.includes("UNTRUSTED"));
  assert.ok(!JSON.stringify(section).includes("DO_NOT_COPY"));
  assert.equal(JSON.stringify(f.page), before);
  assert.deepEqual(section, f.read());
});

for (const [key, value] of [["problem_id", "P-OTHER"], ["cursor", 101], ["after", 1], ["target", "G-4"]] as const) {
  test(`foreign or partial source scope refuses: ${key}`, () => {
    const f = fixture(); Object.assign(f.page.face, { [key]: value }); assert.throws(() => f.read());
  });
}
for (const path of [["C-9@1", "C-2@1"], ["C-3@1", "C-2@2"], ["C-3@1", "C-3@1", "C-2@1"]]) {
  test(`a detached or contradictory path never exposes a premise's gaps: ${path}`, () => {
    const f = fixture(); f.closure.nodes[0]!.path = path; assert.throws(() => f.read());
  });
}
for (const modify of [
  (f: ReturnType<typeof fixture>) => { f.page.face.gaps.reverse(); },
  (f: ReturnType<typeof fixture>) => { f.page.face.gaps[1]!.gap_id = "G-4"; },
  (f: ReturnType<typeof fixture>) => { f.page.face.gaps[0]!.last_event = { ...f.page.face.gaps[0]!.last_event, seq: 101 }; },
  (f: ReturnType<typeof fixture>) => { f.page.face.next_after = 99; f.page.face.omitted = ["page_limit"]; },
  (f: ReturnType<typeof fixture>) => { f.page.face.omitted = ["page_limit"]; },
]) {
  test(`inconsistent admission metadata refuses: ${modify}`, () => {
    const f = fixture(); modify(f); assert.throws(() => f.read());
  });
}
