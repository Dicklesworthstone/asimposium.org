import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ClaimFaceResponse, ProblemFaceResponse } from "@asimposium/contracts";
import { type ClaimBoardReader, loadClaimBoard } from "../../lib/claim-board.ts";

const ORIGIN = "https://a.asimposium.org";

function problem(count = 3): ProblemFaceResponse {
  return {
    schema: "asimposium.problem-face.v1",
    face: "json",
    kind: "problem-face",
    problem: "P-BOARD",
    problem_status: "active",
    profile: "face",
    cursor: 42,
    fingerprint: "fnv1a64:0000000000000000",
    title: "A public problem",
    preamble: "Public ledger, not a declaration of truth.",
    items: Array.from({ length: count }, (_, index) => ({
      kind: "claim" as const,
      id: `C-${index + 1}`,
      scope: "ledger" as const,
      untrusted: true as const,
      why_included: "Public claim in ledger order",
      body: `Statement ${index + 1}`,
      neutralized: [],
    })),
    omitted: [{ reason: "digest_profile" }],
    next_actions: [],
    degraded: [],
  };
}

function claim(target: string): ClaimFaceResponse {
  return {
    schema: "asimposium.claim-face.v1",
    face: "json",
    kind: "claim-face",
    problem: "P-BOARD",
    profile: "claim",
    cursor: 42,
    fingerprint: "fnv1a64:0000000000000000",
    title: target,
    preamble: "Exact public claim",
    claim_state: {
      claim_id: target,
      version: 2,
      latest_version: 2,
      disposition: "open",
      unchallenged: true,
      stale: false,
      recorded_refutation_attempts: 0,
      certified_artifact: false,
      legacy_reviews: 0,
    },
    items: [
      {
        kind: "claim-detail",
        id: `${target}@2`,
        scope: "ledger",
        untrusted: true,
        why_included: "Exact version",
        body: "Published statement",
        neutralized: [],
      },
    ],
    omitted: [{ reason: "private_workshop" }],
    next_actions: [],
    degraded: [],
  };
}

const successfulRead: ClaimBoardReader = async (_problem, target) => ({
  state: "ok",
  origin: ORIGIN,
  data: claim(target),
});

test("every standing and exact link uses the problem digest snapshot", async () => {
  const calls: unknown[] = [];
  const rows = await loadClaimBoard(problem(), ORIGIN, async (...args) => {
    calls.push(args);
    return successfulRead(...args);
  });
  assert.deepEqual(
    calls,
    [1, 2, 3].map((id) => ["P-BOARD", `C-${id}`, ORIGIN, { through: "42" }]),
  );
  assert.equal(rows[0]?.href, "/p/P-BOARD/claims/C-1%402?through=42");
  assert.equal(rows[0]?.standing.state, "ok");
  assert.equal(rows[0]?.item.body, "Published statement");
});

test("a 200-claim digest dispatches exactly eight reads and retains every row", async () => {
  let calls = 0;
  const rows = await loadClaimBoard(problem(200), ORIGIN, async (...args) => {
    calls += 1;
    return successfulRead(...args);
  });
  assert.equal(calls, 8);
  assert.equal(rows.length, 200);
  assert.equal(rows.filter((row) => row.standing.state === "ok").length, 8);
  assert.equal(rows.filter((row) => row.standing.state === "not_loaded").length, 192);
  assert.equal(rows[199]?.href, "/p/P-BOARD/claims/C-200?through=42");
});

test("bounded parallel reads preserve ledger order after out-of-order completion", async () => {
  const pending: (() => void)[] = [];
  const loading = loadClaimBoard(problem(3), ORIGIN, async (_problem, target) => {
    await new Promise<void>((resolve) => pending.push(resolve));
    return { state: "ok", origin: ORIGIN, data: claim(target) };
  });
  assert.equal(pending.length, 3);
  for (const resolve of pending.reverse()) resolve();
  const rows = await loading;
  assert.deepEqual(
    rows.map((row) => row.item.id),
    ["C-1", "C-2", "C-3"],
  );
});

for (const mismatch of ["problem", "claim", "cursor", "origin"] as const) {
  test(`a mismatched ${mismatch} cannot lend another record its scientific standing`, async () => {
    const rows = await loadClaimBoard(problem(1), ORIGIN, async (_problem, target) => {
      const data = claim(target);
      data.claim_state.disposition = "strongly-supported";
      data.claim_state.unchallenged = false;
      data.claim_state.recorded_refutation_attempts = 1;
      if (mismatch === "problem") data.problem = "P-OTHER";
      if (mismatch === "claim") data.claim_state.claim_id = "C-99";
      if (mismatch === "cursor") data.cursor = 43;
      return {
        state: "ok",
        origin: mismatch === "origin" ? "https://a-staging.asimposium.org" : ORIGIN,
        data,
      };
    });
    assert.deepEqual(rows[0]?.standing, { state: "unavailable" });
    assert.equal(rows[0]?.href, "/p/P-BOARD/claims/C-1?through=42");
  });
}

test("missing, failed and throwing reads are unknown, with no replacement fan-out", async () => {
  let calls = 0;
  const rows = await loadClaimBoard(problem(20), ORIGIN, async (_problem, target) => {
    calls += 1;
    if (target === "C-1") return { state: "not_found", origin: ORIGIN };
    if (target === "C-2") throw new Error("transport failure");
    return { state: "unavailable", reason: "timeout" };
  });
  assert.equal(calls, 8);
  assert.equal(rows.filter((row) => row.standing.state === "unavailable").length, 8);
  assert.equal(rows.filter((row) => row.standing.state === "not_loaded").length, 12);
  assert.equal(rows[0]?.item.body, "Statement 1");
});

test("a failed row does not hide successful sibling standing", async () => {
  const rows = await loadClaimBoard(problem(2), ORIGIN, async (...args) => {
    if (args[1] === "C-1") throw new Error("unavailable");
    return successfulRead(...args);
  });
  assert.equal(rows[0]?.standing.state, "unavailable");
  assert.equal(rows[1]?.standing.state, "ok");
});

test("empty or formulation-only digests perform no standing reads", async () => {
  const face = problem(0);
  face.items.push({
    kind: "problem-statement",
    id: "S@1-statement",
    scope: "ledger",
    untrusted: true,
    why_included: "Current formulation",
    body: "The problem statement",
    neutralized: [],
  });
  let calls = 0;
  const read: ClaimBoardReader = async (...args) => {
    calls += 1;
    return successfulRead(...args);
  };
  assert.deepEqual(await loadClaimBoard(problem(0), ORIGIN, read), []);
  assert.deepEqual(await loadClaimBoard(face, ORIGIN, read), []);
  assert.equal(calls, 0);
});

test("canonical stale and strong standing is preserved rather than recomputed", async () => {
  const data = claim("C-1");
  data.claim_state = {
    ...data.claim_state,
    disposition: "strongly-supported",
    unchallenged: false,
    stale: true,
    recorded_refutation_attempts: 2,
    certified_artifact: true,
    legacy_reviews: 3,
  };
  const rows = await loadClaimBoard(problem(1), ORIGIN, async () => ({
    state: "ok",
    origin: ORIGIN,
    data,
  }));
  const standing = rows[0]?.standing;
  assert.equal(standing?.state, "ok");
  if (standing?.state === "ok") {
    assert.deepEqual(standing.value, data.claim_state);
    assert.equal(standing.sourceUnavailable, false);
  }
});

for (const source of ["degraded", "content_unavailable"] as const) {
  test(`${source} material remains visible as a standing caveat`, async () => {
    const data = claim("C-1");
    if (source === "degraded") data.degraded.push("Supporting source unavailable");
    else data.omitted.push({ reason: "content_unavailable" });
    const rows = await loadClaimBoard(problem(1), ORIGIN, async () => ({
      state: "ok",
      origin: ORIGIN,
      data,
    }));
    const standing = rows[0]?.standing;
    assert.equal(standing?.state, "ok");
    if (standing?.state === "ok") assert.equal(standing.sourceUnavailable, true);
  });
}

test("standing is paired with exact-version text, never an older digest excerpt", async () => {
  const digest = problem(1);
  const before = structuredClone(digest);
  const data = claim("C-1");
  const exact = data.items[0];
  assert.ok(exact);
  exact.body = "A revised statement with a different domain.";
  exact.why_included = "The exact reviewed statement version";
  data.claim_state.disposition = "corroborated";
  data.claim_state.unchallenged = false;
  data.claim_state.recorded_refutation_attempts = 1;
  const rows = await loadClaimBoard(digest, ORIGIN, async () => ({
    state: "ok",
    origin: ORIGIN,
    data,
  }));
  assert.equal(rows[0]?.standing.state, "ok");
  assert.equal(rows[0]?.item.body, exact.body);
  assert.equal(rows[0]?.item.why_included, exact.why_included);
  assert.equal(rows[0]?.item.neutralized, exact.neutralized);
  assert.equal(rows[0]?.href, "/p/P-BOARD/claims/C-1%402?through=42");
  assert.deepEqual(digest, before);
});

for (const defect of ["missing", "wrong_version", "wrong_kind"] as const) {
  test(`${defect} exact text cannot borrow digest prose to display a disposition`, async () => {
    const data = claim("C-1");
    const exact = data.items[0];
    assert.ok(exact);
    if (defect === "missing") {
      data.items = [];
      data.omitted.push({ reason: "content_unavailable" });
    }
    if (defect === "wrong_version") exact.id = "C-1@1";
    if (defect === "wrong_kind") exact.kind = "claim-review";
    const rows = await loadClaimBoard(problem(1), ORIGIN, async () => ({
      state: "ok",
      origin: ORIGIN,
      data,
    }));
    assert.deepEqual(rows[0]?.standing, { state: "unavailable" });
    assert.equal(rows[0]?.item.body, "Statement 1");
    assert.equal(rows[0]?.href, "/p/P-BOARD/claims/C-1?through=42");
  });
}
