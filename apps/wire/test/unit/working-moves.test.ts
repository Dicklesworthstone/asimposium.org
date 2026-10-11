import { test } from "bun:test";
import assert from "node:assert/strict";
import { getMoveTemplate, type MoveKind, type NextMoveCandidate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { FellowCredentialBinding } from "../../src/enrollment/service.ts";
import type {
  MegaCommandsMoveProvider,
  ProblemMovesRequest,
  ProblemMovesResult,
} from "../../src/mega-commands/provider.ts";
import {
  readWorkingMovesPack,
  type WorkingMovesPackInput,
} from "../../src/sessions/working-moves.ts";

// Pure adaptation proof with explicit canonical-output fixtures. Real selector
// SQL and HTTP are exercised by live-moves-snapshot and the Workerd moves lanes.
const permissions = {
  read: true,
  session_open: true,
  workshop_push: true,
  promote: true,
  review: true,
};
const input: WorkingMovesPackInput = {
  db: {} as D1Database,
  problemId: "P-DEMO",
  sessionId: "S-owned-session",
  cursor: 50,
  credential: {
    fellowId: "F-reader",
    sponsorId: "usr_reader",
    credentialId: "TK-reader",
    grantedResources: {},
  } as FellowCredentialBinding,
  role: "contributor",
  effectivePermissions: permissions,
};

function move(kind: MoveKind, cursor = 50): NextMoveCandidate {
  return {
    move: kind,
    why: "A canonical scientific need is eligible at the captured public cursor.",
    refs: ["P-DEMO", "C-1@1"],
    contract: {
      ...getMoveTemplate(kind),
      preparation: {
        problem_id: "P-DEMO",
        captured_cursor: cursor,
        read_first: { method: "GET", path: `/p/P-DEMO/claims/C-1@1.md?through=${cursor}` },
      },
    },
    selection_boundary: "Explicit bounded canonical-output fixture.",
  };
}

function fixture(overrides: Partial<ProblemMovesResult> = {}) {
  const calls: ProblemMovesRequest[] = [];
  const result: ProblemMovesResult = {
    primaryMove: move("discriminate"),
    alternatives: [move("formalize"), move("record-dead-end")],
    capturedCursor: 50,
    degraded: false,
    effectivePermissions: permissions,
    selectionBoundary: "One canonical bounded selection; authored work is read as data.",
    ...overrides,
  };
  const provider: MegaCommandsMoveProvider = {
    async nextMoves(request) {
      calls.push(request);
      return result;
    },
    async triageMove() {
      throw new Error("Working packs must use the problem selector.");
    },
  };
  return { provider, calls, result };
}

test("working pack carries one canonical primary and two alternatives as one indivisible item", async () => {
  const f = fixture();
  const section = await readWorkingMovesPack(input, f.provider);
  assert.equal(section.candidates.length, 1);
  const candidate = section.candidates[0];
  assert.ok(candidate);
  assert.equal(candidate.kind, "move");
  assert.equal(candidate.scope, "system");
  assert.equal(candidate.untrusted, false);
  assert.deepEqual(JSON.parse(candidate.body), {
    captured_cursor: 50,
    primary_move: f.result.primaryMove,
    alternatives: f.result.alternatives,
    degraded: false,
    selection_boundary: f.result.selectionBoundary,
  });
  assert.deepEqual(section.primaryMove, f.result.primaryMove);
  assert.deepEqual(section.alternatives, f.result.alternatives);
  assert.deepEqual(section.omitted, []);
  assert.equal(f.calls[0]?.capturedCursor, 50);
  assert.equal(f.calls[0]?.credential, input.credential);
  assert.equal(f.calls[0]?.fellowId, input.credential.fellowId);
});

test("working pack refuses mismatched cuts and mixed-cursor candidate contracts", async () => {
  for (const override of [
    { capturedCursor: 51 },
    { capturedCursor: undefined },
    { primaryMove: move("discriminate", 51) },
    { alternatives: [move("formalize", 49)] },
  ]) {
    const section = await readWorkingMovesPack(input, fixture(override).provider);
    assert.equal(section.primaryMove, null);
    assert.deepEqual(section.candidates, []);
    assert.equal(section.degraded, true);
    const omission = section.omitted[0];
    assert.ok(omission);
    assert.match(omission.detail, /refresh this working pack/);
  }
});

test("only permissions shared by the route and current central policy can authorize a move", async () => {
  const f = fixture({
    primaryMove: move("review"),
    alternatives: [move("discriminate")],
    effectivePermissions: { ...permissions, promote: false },
  });
  const section = await readWorkingMovesPack(input, f.provider);
  assert.equal(section.primaryMove?.move, "review");
  assert.deepEqual(section.alternatives, []);
  assert.ok(section.omitted.some((item) => item.reason === "moves_permission_filtered"));
  const denied = await readWorkingMovesPack(
    { ...input, effectivePermissions: { ...permissions, review: false } },
    f.provider,
  );
  assert.equal(denied.primaryMove, null);
  assert.equal(denied.candidates[0]?.kind, "standing-context");
});

test("public-write quota removes direct reviews while preserving a permitted private investigation", async () => {
  const f = fixture({ primaryMove: move("review"), alternatives: [move("discriminate")] });
  const section = await readWorkingMovesPack({ ...input, promotionLimited: true }, f.provider);
  assert.equal(section.primaryMove?.move, "discriminate");
  assert.deepEqual(section.alternatives, []);
  assert.equal(f.calls[0]?.publicWritesLimited, true);
  assert.ok(section.omitted.some((item) => item.reason === "moves_permission_filtered"));
  const noWorkshop = await readWorkingMovesPack(
    {
      ...input,
      promotionLimited: true,
      effectivePermissions: { ...permissions, workshop_push: false },
    },
    f.provider,
  );
  assert.equal(noWorkshop.primaryMove, null);
});

test("partial canonical selection remains usable and discloses its incompleteness", async () => {
  const f = fixture({ degraded: true, degradedReason: "MOVES_PARTIAL" });
  const section = await readWorkingMovesPack(input, f.provider);
  assert.equal(section.primaryMove?.move, "discriminate");
  assert.equal(section.degraded, true);
  assert.ok(section.omitted.some((item) => item.reason === "moves_degraded"));
  const candidate = section.candidates[0];
  assert.ok(candidate);
  assert.equal(JSON.parse(candidate.body).degraded, true);
});

test("invalid cardinality and unavailable selection never produce a misleading recommendation", async () => {
  for (const override of [
    { primaryMove: null },
    { alternatives: [move("review"), move("formalize"), move("record-dead-end")] },
    { primaryMove: null, alternatives: [], degraded: true, degradedReason: "SQL PRIVATE-SECRET" },
    { primaryMove: null, alternatives: [], degraded: true, degradedReason: "constructor" },
  ]) {
    const section = await readWorkingMovesPack(input, fixture(override).provider);
    assert.equal(section.primaryMove, null);
    assert.deepEqual(section.candidates, []);
    assert.equal(section.degraded, true);
    assert.ok(!JSON.stringify(section).includes("PRIVATE-SECRET"));
    assert.equal(typeof section.omitted[0]?.detail, "string");
  }
});

test("selector exceptions and oversized complete contracts become explicit omissions", async () => {
  const f = fixture();
  f.provider.nextMoves = async () => {
    throw new Error("SQL references private F-SECRET with bearer SECRET");
  };
  const failed = await readWorkingMovesPack(input, f.provider);
  assert.equal(failed.degraded, true);
  assert.ok(!JSON.stringify(failed).includes("SECRET"));

  const oversized = move("discriminate");
  oversized.contract.large_fixture = "x".repeat(18001);
  const section = await readWorkingMovesPack(input, fixture({ primaryMove: oversized }).provider);
  assert.equal(section.primaryMove, null);
  assert.equal(section.omitted[0]?.reason, "item_too_large");
});

test("an empty healthy selection is explicit without inventing a scientific task", async () => {
  const section = await readWorkingMovesPack(
    input,
    fixture({ primaryMove: null, alternatives: [] }).provider,
  );
  assert.equal(section.degraded, false);
  assert.equal(section.primaryMove, null);
  assert.equal(section.candidates[0]?.id, "SYS-working-moves-empty");
  const candidate = section.candidates[0];
  assert.ok(candidate);
  assert.equal(JSON.parse(candidate.body).primary_move, null);
});
