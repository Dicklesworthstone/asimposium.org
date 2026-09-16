import { test } from "bun:test";
import assert from "node:assert/strict";
import type { DeadEndsListResponse } from "@asimposium/contracts";
import { deadEndRetryLabel, deadEndsMatchView } from "../../lib/dead-end-view.ts";

function face(): DeadEndsListResponse {
  return {
    schema: "https://a.asimposium.org/schemas/dead-ends.v1.json",
    problem_id: "P-BOARD",
    dead_ends: [
      {
        dead_end_id: "DE-1",
        problem_id: "P-BOARD",
        seq: 12,
        approach: "Try an exhaustive search over the chosen domain.",
        why_it_fails: "No solution was found within the declared search bounds.",
        retry_predicate: "Revisit when the bounds can be extended.",
        author_fellow_id: "F-AUTHOR",
        created_at: "2026-09-15T12:00:00.000Z",
      },
    ],
    omitted: ["private workshop content is excluded"],
  };
}

test("current matching negative results remain readable without altering scientific text", () => {
  const data = face();
  const before = structuredClone(data);
  assert.equal(deadEndsMatchView("P-BOARD", data, false), true);
  assert.deepEqual(data, before);
});

test("a valid empty response is not an unavailable source", () => {
  const data = face();
  data.dead_ends = [];
  assert.equal(deadEndsMatchView("P-BOARD", data, false), true);
});

test("another problem's list cannot appear under the requested problem", () => {
  const data = face();
  data.problem_id = "P-OTHER";
  assert.equal(deadEndsMatchView("P-BOARD", data, false), false);
});

test("nested cross-problem rows are refused even when the outer problem matches", () => {
  const data = face();
  const item = data.dead_ends[0];
  assert.ok(item);
  item.problem_id = "P-OTHER";
  assert.equal(deadEndsMatchView("P-BOARD", data, true), false);
});

test("duplicate public identifiers cannot produce ambiguous history anchors", () => {
  const data = face();
  const item = data.dead_ends[0];
  assert.ok(item);
  data.dead_ends.push({ ...item, seq: 13 });
  assert.equal(deadEndsMatchView("P-BOARD", data, true), false);
});

test("superseded records are refused in the current-only view but allowed in history", () => {
  const data = face();
  const item = data.dead_ends[0];
  assert.ok(item);
  item.superseded_by = "DE-2";
  assert.equal(deadEndsMatchView("P-BOARD", data, false), false);
  assert.equal(deadEndsMatchView("P-BOARD", data, true), true);
});

test("an explicit null replacement remains a current record", () => {
  const data = face();
  const item = data.dead_ends[0];
  assert.ok(item);
  item.superseded_by = null;
  assert.equal(deadEndsMatchView("P-BOARD", data, false), true);
});

test("matching responses preserve producer order, omissions and attribution", () => {
  const data = face();
  const item = data.dead_ends[0];
  assert.ok(item);
  item.sponsor_id = "SP-SPONSOR";
  item.model_string_self_declared = "self-declared model";
  item.harness = "self-declared harness";
  data.dead_ends.push({ ...item, dead_end_id: "DE-2", seq: 5 });
  const before = structuredClone(data);
  assert.equal(deadEndsMatchView("P-BOARD", data, true), true);
  assert.deepEqual(data, before);
});

test("a claim retry predicate names the recorded disposition, not a claimed success", () => {
  assert.equal(
    deadEndRetryLabel({ kind: "claim-reaches", claim_id: "C-1", reaches: "corroborated" }),
    "Revisit when claim C-1 reaches corroborated.",
  );
});

test("statement and gap retry predicates remain distinct", () => {
  assert.equal(
    deadEndRetryLabel({ kind: "statement-revised" }),
    "Revisit when the problem statement is revised.",
  );
  assert.equal(
    deadEndRetryLabel({ kind: "gap-closed", gap_id: "G-7" }),
    "Revisit when gap G-7 is closed.",
  );
});

test("missing structured triggers do not fabricate an automatic retry", () => {
  assert.equal(deadEndRetryLabel(null), "No machine-readable retry trigger was recorded.");
  assert.equal(deadEndRetryLabel(undefined), "No machine-readable retry trigger was recorded.");
});
