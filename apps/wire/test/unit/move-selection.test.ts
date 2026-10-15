import { test } from "bun:test";
import assert from "node:assert/strict";
import type { MoveKind, NextMoveCandidate } from "@asimposium/contracts";
import type { ReviewQueueItem } from "@asimposium/contracts/review-queue";
import { rankReviewQueue } from "../../src/discovery/review-queue-selection.ts";
import {
  compareMovePriority,
  MOVE_PRIORITY_TIER,
  selectTriageMove,
  uniqueMoves,
} from "../../src/mega-commands/move-selection.ts";

// Selection fixtures exercise only ranking, identity and contract preservation.
// They are not a substitute for request-schema, authorization or scientific-fold tests.
function move(kind: MoveKind, problem = "P-ONE", target = "C-1@1"): NextMoveCandidate {
  return {
    move: kind,
    refs: [problem, target],
    why: "An already authorized scientific need.",
    contract: { preparation: { problem_id: problem, captured_cursor: 10 } },
  } as NextMoveCandidate;
}
function item(overrides: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    problem_id: "P-ONE", claim_id: "C-1", version: 1, cursor: 10,
    author_sponsor_id: "SP-ONE", created_at: "2026-10-01T00:00:00.000Z",
    direct_dependents: 0, need: "independent-review", ...overrides,
  } as ReviewQueueItem;
}

test("empty or metadata-only triage never invents a move", () => {
  assert.equal(selectTriageMove([], []), null);
  assert.equal(selectTriageMove([], [item({ direct_dependents: 32 })]), null);
});

test("all existing move tiers agree between next and triage", () => {
  const kinds = Object.keys(MOVE_PRIORITY_TIER) as MoveKind[];
  assert.equal(kinds.length, 18);
  for (let i = 0; i < kinds.length; i++) {
    for (let j = i + 1; j < kinds.length; j++) {
      const higher = move(kinds[i]!);
      const lower = move(kinds[j]!);
      assert.ok(compareMovePriority(higher, lower) < 0);
      assert.equal(selectTriageMove([lower, higher], []), higher);
    }
  }
});

test("high-consequence review cannot displace a higher-priority integrity or lifecycle move", () => {
  const review = move("review", "P-TWO");
  const queue = [item({ problem_id: "P-TWO", direct_dependents: 32 })];
  for (const kind of ["back-to-the-object", "idle-close", "sharpen-statement",
    "add-refuter-from-friction", "kill-or-stand", "add-refuter"] as const) {
    const urgent = move(kind);
    assert.equal(selectTriageMove([review, urgent], queue), urgent);
    assert.equal(selectTriageMove([urgent, review], queue), urgent);
  }
});

test("review and formalize of the same claim retain their distinct contracts", () => {
  const review = move("review");
  const formalize = move("formalize");
  const reanchor = move("re-anchor");
  assert.deepEqual(uniqueMoves([review, formalize, reanchor]), [review, formalize, reanchor]);
  assert.equal(selectTriageMove([review, reanchor, formalize], [item()]), review);
  assert.equal(selectTriageMove([formalize, reanchor, review], [item()]), review);
  assert.equal(selectTriageMove([review, formalize], [item()])?.contract, review.contract);
});

test("move identity includes every reference and preserves first identical candidate", () => {
  const first = move("close-gap", "P-ONE", "G-2");
  first.refs.push("C-1@1");
  const anotherPin = { ...first, refs: ["P-ONE", "G-2", "C-1@2"] };
  const duplicate = { ...first, refs: [...first.refs], why: "Later duplicate." };
  assert.deepEqual(uniqueMoves([first, anotherPin, duplicate]), [first, anotherPin]);
  // Strings are not parsed as delimiters by the internal identity function.
  const comma = { ...first, refs: ["P-ONE", "G-2,C-1@1"] };
  assert.equal(uniqueMoves([first, comma]).length, 2);
});

test("review tiers use canonical consequence, missing-check and age ranking", () => {
  const rows = [
    item({ problem_id: "P-ONE", direct_dependents: 2 }),
    item({ problem_id: "P-TWO", direct_dependents: 3, need: "full-write-up-review" }),
    item({ problem_id: "P-THREE", direct_dependents: 3, need: "resolve-dispute" }),
    item({ problem_id: "P-FOUR", direct_dependents: 3, need: "resolve-dispute",
      created_at: "2026-09-01T00:00:00.000Z" }),
  ];
  const candidates = rows.map((row) => move("review", row.problem_id));
  const expected = rankReviewQueue(rows)[0]!;
  assert.equal(selectTriageMove(candidates, rows), candidates.find((m) => m.refs[0] === expected.problem_id));
  assert.equal(selectTriageMove([...candidates].reverse(), [...rows].reverse()), candidates[3]);
});

test("refuter ranking uses only falsification needs within the refuter tier", () => {
  const first = move("add-refuter");
  const second = move("add-refuter", "P-TWO");
  const unrelated = move("review", "P-THREE");
  const rows = [
    item({ need: "falsification-attempt", direct_dependents: 1 }),
    item({ problem_id: "P-TWO", need: "falsification-attempt", direct_dependents: 3 }),
    item({ problem_id: "P-THREE", need: "resolve-dispute", direct_dependents: 32 }),
  ];
  assert.equal(selectTriageMove([unrelated, first, second], rows), second);
});

test("queue metadata cannot float to another version, problem, or move kind", () => {
  const first = move("review");
  const second = move("review", "P-TWO", "C-2@2");
  for (const mismatched of [
    item({ problem_id: "P-TWO", claim_id: "C-2", version: 1, direct_dependents: 32 }),
    item({ problem_id: "P-OTHER", claim_id: "C-2", version: 2, direct_dependents: 32 }),
    item({ problem_id: "P-TWO", claim_id: "C-2", version: 2,
      need: "falsification-attempt", direct_dependents: 32 }),
  ]) {
    assert.equal(selectTriageMove([first, second], [mismatched]), first);
  }
});

test("permission-filtered missing candidates cannot return through metadata", () => {
  const permitted = move("review");
  const excluded = item({ problem_id: "P-OTHER", direct_dependents: 32 });
  assert.equal(selectTriageMove([permitted], [excluded, item()]), permitted);
  assert.equal(selectTriageMove([move("formalize")], [excluded, item()])?.move, "formalize");
});

test("a non-review contract never substitutes for a missing queue-selected review", () => {
  const actual = move("review", "P-TWO");
  const sameTargetOtherNeed = move("formalize");
  const rows = [item({ direct_dependents: 32 }), item({ problem_id: "P-TWO" })];
  assert.equal(selectTriageMove([actual, sameTargetOtherNeed], rows), actual);
});

test("a move with additional pins is not mistaken for a plain review target", () => {
  const first = move("review");
  const extended = move("review", "P-TWO");
  extended.refs.push("G-2");
  assert.equal(selectTriageMove([first, extended], [item({ problem_id: "P-TWO", direct_dependents: 32 })]), first);
});

test("equal non-review tiers preserve stable source ordering", () => {
  const first = move("close-gap", "P-ONE", "G-2");
  const second = move("close-gap", "P-TWO", "G-3");
  assert.equal(selectTriageMove([first, second], []), first);
  assert.equal(selectTriageMove([second, first], []), second);
});

test("selection leaves caller arrays, candidates and contracts untouched", () => {
  const candidate = move("review");
  Object.freeze(candidate.refs);
  Object.freeze(candidate.contract);
  Object.freeze(candidate);
  const candidates = Object.freeze([candidate]);
  const rows = Object.freeze([Object.freeze(item())]);
  assert.equal(selectTriageMove(candidates, rows), candidate);
  assert.deepEqual(uniqueMoves(candidates), [candidate]);
  assert.equal(candidates[0]?.contract, candidate.contract);
});
