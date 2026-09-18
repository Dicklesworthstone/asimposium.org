import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { HelloAssignment, MoveTemplate } from "@asimposium/contracts";
import type { ReviewQueueItem, ReviewQueueResponse } from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import type { FellowCredentialBinding } from "../../src/enrollment/service.ts";
import {
  LedgerMovesProvider,
  type LiveMovesDependencies,
  TRIAGE_CONCURRENCY,
  TRIAGE_MAX_PROBLEMS,
} from "../../src/mega-commands/live-provider.ts";

const credential = {
  fellowId: "F-READER",
  credentialId: "FC-READER",
  sponsorId: "SP-READER",
  fellowStatus: "active",
  grantedScopes: ["promote", "review"],
  grantedResources: {},
  issuedAt: 1,
  expiresAt: 999999,
} as unknown as FellowCredentialBinding;
const item = (problem = "P-DEMO", patch: Partial<ReviewQueueItem> = {}): ReviewQueueItem => ({
  problem_id: problem,
  claim_id: "C-1",
  version: 1,
  cursor: 10,
  kind: "definition",
  statement: "Definition.",
  falsifier: null,
  disposition: "open",
  need: "independent-review",
  best_recorded_tier: "none",
  direct_dependents: 0,
  dependents_capped: false,
  author_fellow_id: "F-AUTHOR",
  author_sponsor_id: "SP-AUTHOR",
  created_at: "2026-09-01T00:00:00.000Z",
  read_url: `/p/${problem}/claims/C-1@1.md?through=10`,
  ...patch,
});
function page(problem: string, items = [item(problem)]): ReviewQueueResponse {
  return {
    schema: "https://a.asimposium.org/schemas/review-queue.v1.json",
    policy: "review-discovery-v1",
    problem,
    candidates: items,
    scanned: items.length,
    next_after: null,
    omitted: [],
    selection_boundary: "fixture" as ReviewQueueResponse["selection_boundary"],
  };
}
function templateFor(move: "review" | "add-refuter"): MoveTemplate {
  return {
    move,
    title: "Fixture",
    trigger: "Fixture",
    description: "Fixture",
    availability: "available",
    target_contract: "/schemas/sessions.v1.json#/properties/review_request",
    request: {
      method: "POST",
      path: "/v1/sessions/{id}/review",
      auth: "fellow-bearer",
      idempotency_key_required: true,
    },
    prefilled_hints: {},
    required_fields: ["body_md"],
  };
}
function fixture(problems = ["P-DEMO"]) {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE problems(id TEXT, status TEXT, unlisted INTEGER, public_seq INTEGER);
    CREATE TABLE problem_memberships(problem_id TEXT, fellow_id TEXT, role TEXT);
    CREATE TABLE events(id TEXT, problem_id TEXT, object_id TEXT, object_kind TEXT, type TEXT, seq INTEGER, actor_fellow_id TEXT, writer_credential_id TEXT);
    CREATE TABLE reviews(problem_id TEXT, review_id TEXT, source_event_id TEXT, source_seq INTEGER, reviewer_fellow_id TEXT, target_claim_id TEXT, target_version INTEGER);`);
  for (const problem of problems) {
    sqlite.query("INSERT INTO problems VALUES (?, 'active', 0, 10)").run(problem);
    sqlite
      .query("INSERT INTO problem_memberships VALUES (?, 'F-READER', 'contributor')")
      .run(problem);
    sqlite
      .query(
        "INSERT INTO events (problem_id, object_kind, type, seq) VALUES (?, 'claim', 'claim.created', 1)",
      )
      .run(problem);
  }
  let reads = 0;
  const db = {
    prepare(sql: string) {
      reads += 1;
      return {
        bind: (...values: unknown[]) => ({
          first: async () => sqlite.query(sql).get(...(values as any[])) ?? null,
          all: async () => ({ results: sqlite.query(sql).all(...(values as any[])) }),
        }),
      };
    },
  } as unknown as D1Database;
  const calls: Parameters<LiveMovesDependencies["authorize"]>[0][] = [];
  let queueReads = 0;
  const dependencies: LiveMovesDependencies = {
    now: () => 100,
    templateFor,
    firstClaimTemplate: () => ({ ...templateFor("review"), move: "state-claim" }),
    loadQueue: async (_db, query) => {
      queueReads += 1;
      return page(query.problem);
    },
    // A scripted central-policy seam, not a test of the policy implementation.
    // Assertions below verify which real membership/usage the provider submits.
    authorize: (input) => {
      calls.push(input);
      const target = input.target;
      const denied =
        input.credential.fellowStatus !== "active" ||
        (input.credential.grantedResources.problemBinding !== undefined &&
          "problemId" in target &&
          input.credential.grantedResources.problemBinding !== target.problemId) ||
        (input.credential.grantedResources.eventBudget !== undefined &&
          input.usage.eventsRecorded >= input.credential.grantedResources.eventBudget) ||
        ((input.effect === "review" || input.effect === "promote") &&
          !input.credential.grantedScopes.includes(input.effect)) ||
        (input.effect === "promote" &&
          "membershipRole" in target &&
          target.membershipRole === "observer");
      return denied
        ? {
            decision: "quarantine",
            effect: input.effect,
            handling: "blocked-pending-operator-review",
          }
        : { decision: "allow", effect: input.effect };
    },
  };
  return { sqlite, db, calls, dependencies, reads: () => reads, queueReads: () => queueReads };
}
function next(db: D1Database, binding = credential, problemId = "P-DEMO") {
  return {
    db,
    credential: binding,
    problemId,
    fellowId: binding.fellowId,
    role: "contributor" as const,
    effectivePermissions: {},
  };
}
function assignment(problem_id: string): HelloAssignment {
  return { problem_id, role: "contributor" } as HelloAssignment;
}

test("production orchestration returns live work and central-policy permission hints", async () => {
  const f = fixture();
  try {
    const result = await new LedgerMovesProvider(f.dependencies).nextMoves(next(f.db));
    assert.equal(result.primaryMove?.move, "review");
    assert.equal(result.degraded, false);
    assert.equal(result.effectivePermissions?.review, true);
    assert.ok(
      f.calls.some(
        (call) =>
          call.effect === "review" &&
          call.credential === credential &&
          call.target.kind === "existing-problem" &&
          call.target.membershipRole === "contributor",
      ),
    );
  } finally {
    f.sqlite.close();
  }
});
test("one primary and at most two alternatives retain scientific priority", async () => {
  const f = fixture();
  try {
    f.dependencies.loadQueue = async () =>
      page(
        "P-DEMO",
        [1, 2, 3, 4].map((n) => item("P-DEMO", { claim_id: `C-${n}`, direct_dependents: n })),
      );
    const result = await new LedgerMovesProvider(f.dependencies).nextMoves(next(f.db));
    assert.deepEqual(result.primaryMove?.refs, ["P-DEMO", "C-4@1"]);
    assert.equal(result.alternatives.length, 2);
  } finally {
    f.sqlite.close();
  }
});
test("missing grants cannot be overridden by caller permission hints", async () => {
  const f = fixture();
  try {
    const result = await new LedgerMovesProvider(f.dependencies).nextMoves({
      ...next(f.db, { ...credential, grantedScopes: [] }),
      effectivePermissions: { review: true, promote: true, session_open: true },
    });
    assert.equal(result.primaryMove, null);
    assert.equal(result.effectivePermissions?.review, false);
    assert.equal(f.queueReads(), 0);
  } finally {
    f.sqlite.close();
  }
});
test("observer with review scope gets review work but not new-claim promotion", async () => {
  const f = fixture();
  try {
    f.sqlite.exec("UPDATE problem_memberships SET role='observer'");
    const result = await new LedgerMovesProvider(f.dependencies).nextMoves(next(f.db));
    assert.equal(result.primaryMove?.move, "review");
    assert.equal(result.effectivePermissions?.review, true);
    assert.equal(result.effectivePermissions?.promote, false);
  } finally {
    f.sqlite.close();
  }
});
test("central admission refusal prevents all membership and queue reads", async () => {
  const f = fixture();
  try {
    const result = await new LedgerMovesProvider(f.dependencies).nextMoves(
      next(f.db, { ...credential, fellowStatus: "suspicious_review" }),
    );
    assert.equal(result.primaryMove, null);
    assert.equal(f.reads(), 0);
    assert.equal(f.queueReads(), 0);
  } finally {
    f.sqlite.close();
  }
});
for (const bad of ["missing", "mismatched"] as const)
  test(`credential context ${bad} fails closed before I/O`, async () => {
    const f = fixture();
    try {
      const req = next(f.db);
      const result = await new LedgerMovesProvider(f.dependencies).nextMoves(
        bad === "missing" ? { ...req, credential: undefined } : { ...req, fellowId: "F-OTHER" },
      );
      assert.equal(result.degradedReason, "MOVES_UNAVAILABLE");
      assert.equal(f.reads(), 0);
    } finally {
      f.sqlite.close();
    }
  });
test("grant usage includes events from all problems for this credential, not other credentials", async () => {
  const f = fixture();
  try {
    f.sqlite.exec(
      "INSERT INTO events (writer_credential_id, problem_id) VALUES ('FC-READER','P-OTHER'), ('FC-READER','P-DEMO'), ('FC-OTHER','P-DEMO')",
    );
    const result = await new LedgerMovesProvider(f.dependencies).nextMoves(
      next(f.db, { ...credential, grantedResources: { eventBudget: 2 } }),
    );
    assert.equal(result.primaryMove, null);
    assert.equal(f.queueReads(), 0);
    assert.ok(f.calls.some((call) => call.effect === "review" && call.usage.eventsRecorded === 2));
    assert.equal(result.effectivePermissions?.promote, false);
  } finally {
    f.sqlite.close();
  }
});
for (const [name, change] of [
  ["private", "UPDATE problems SET status='private-draft'"],
  ["unlisted", "UPDATE problems SET unlisted=1"],
  ["resolved", "UPDATE problems SET status='resolved'"],
  ["retired", "UPDATE problems SET status='retired'"],
  ["lost membership", "UPDATE problem_memberships SET fellow_id='F-OTHER'"],
  ["unknown role", "UPDATE problem_memberships SET role='operator'"],
] as const)
  test(`current SQL excludes ${name} despite stale caller role`, async () => {
    const f = fixture();
    try {
      f.sqlite.exec(change);
      const result = await new LedgerMovesProvider(f.dependencies).nextMoves(next(f.db));
      assert.equal(result.primaryMove, null);
      assert.equal(f.queueReads(), 0);
    } finally {
      f.sqlite.close();
    }
  });
test("queue failures return a coarse unavailable result without private exception details", async () => {
  const f = fixture();
  try {
    f.dependencies.loadQueue = async () => {
      throw new Error("PRIVATE-SQL-CANARY");
    };
    const result = await new LedgerMovesProvider(f.dependencies).nextMoves(next(f.db));
    assert.equal(result.degradedReason, "MOVES_UNAVAILABLE");
    assert.ok(!JSON.stringify(result).includes("PRIVATE-SQL-CANARY"));
  } finally {
    f.sqlite.close();
  }
});
test("triage chooses higher-consequence eligible work across assigned problems", async () => {
  const f = fixture(["P-AAA", "P-BBB"]);
  try {
    f.dependencies.loadQueue = async (_db, query) =>
      page(query.problem, [
        item(query.problem, { direct_dependents: query.problem === "P-BBB" ? 10 : 0 }),
      ]);
    const result = await new LedgerMovesProvider(f.dependencies).triageMove({
      db: f.db,
      credential,
      fellowId: credential.fellowId,
      assignments: [assignment("P-AAA"), assignment("P-BBB")],
    });
    assert.deepEqual(result.move?.refs, ["P-BBB", "C-1@1"]);
    assert.equal(result.degraded, false);
  } finally {
    f.sqlite.close();
  }
});
test("triage has deterministic capped scope and at most two concurrent queue loads", async () => {
  const names = ["P-AAA", "P-BBB", "P-CCC", "P-DDD", "P-EEE", "P-FFF"];
  const f = fixture(names);
  try {
    let active = 0;
    let peak = 0;
    const seen: string[] = [];
    f.dependencies.loadQueue = async (_db, query) => {
      seen.push(query.problem);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, query.problem === "P-AAA" ? 10 : 1));
      active -= 1;
      return page(query.problem);
    };
    const provider = new LedgerMovesProvider(f.dependencies);
    const req = {
      db: f.db,
      credential,
      fellowId: credential.fellowId,
      assignments: names.slice().reverse().map(assignment),
    };
    const result = await provider.triageMove(req);
    assert.equal(seen.length, TRIAGE_MAX_PROBLEMS);
    assert.equal(peak, TRIAGE_CONCURRENCY);
    assert.deepEqual([...seen].sort(), names.slice(0, TRIAGE_MAX_PROBLEMS));
    assert.equal(result.degradedReason, "MOVES_PARTIAL");
    assert.deepEqual(
      (await provider.triageMove({ ...req, assignments: names.map(assignment) })).move,
      result.move,
    );
  } finally {
    f.sqlite.close();
  }
});
test("triage filters problem-bound credentials before considering other assignments", async () => {
  const f = fixture(["P-AAA", "P-BBB"]);
  try {
    const seen: string[] = [];
    f.dependencies.loadQueue = async (_db, query) => {
      seen.push(query.problem);
      return page(query.problem);
    };
    const binding = { ...credential, grantedResources: { problemBinding: "P-BBB" } };
    const result = await new LedgerMovesProvider(f.dependencies).triageMove({
      db: f.db,
      credential: binding,
      fellowId: binding.fellowId,
      assignments: [assignment("P-AAA"), assignment("P-BBB")],
    });
    assert.deepEqual(seen, ["P-BBB"]);
    assert.deepEqual(result.move?.refs, ["P-BBB", "C-1@1"]);
  } finally {
    f.sqlite.close();
  }
});
test("one failed problem does not discard another problem's verified move", async () => {
  const f = fixture(["P-AAA", "P-BBB"]);
  try {
    f.dependencies.loadQueue = async (_db, query) => {
      if (query.problem === "P-AAA") throw new Error("PRIVATE");
      return page(query.problem);
    };
    const result = await new LedgerMovesProvider(f.dependencies).triageMove({
      db: f.db,
      credential,
      fellowId: credential.fellowId,
      assignments: [assignment("P-AAA"), assignment("P-BBB")],
    });
    assert.deepEqual(result.move?.refs, ["P-BBB", "C-1@1"]);
    assert.equal(result.degradedReason, "MOVES_PARTIAL");
    assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  } finally {
    f.sqlite.close();
  }
});
test("no assignments performs no SQL and does not pretend the engine is uninstalled", async () => {
  const f = fixture();
  try {
    const result = await new LedgerMovesProvider(f.dependencies).triageMove({
      db: f.db,
      credential,
      fellowId: credential.fellowId,
      assignments: [],
    });
    assert.equal(result.degraded, false);
    assert.equal(result.move, null);
    assert.equal(f.reads(), 0);
  } finally {
    f.sqlite.close();
  }
});

test("an empty active board gives a workshop-first claim move without scanning the review queue", async () => {
  const f = fixture();
  try {
    f.sqlite.exec("UPDATE problems SET public_seq=0");
    const result = await new LedgerMovesProvider(f.dependencies).nextMoves(next(f.db));
    assert.equal(result.primaryMove?.move, "state-claim");
    assert.equal(f.queueReads(), 0);
    assert.deepEqual(result.primaryMove?.refs, ["P-DEMO"]);
    assert.match(JSON.stringify(result.primaryMove?.contract), /workshop_first/);
    assert.match(JSON.stringify(result.primaryMove?.contract), /captured_cursor":0/);
  } finally {
    f.sqlite.close();
  }
});
test("an old published claim, even without its content, prevents inventing an empty board", async () => {
  const f = fixture();
  try {
    let queried = false;
    f.dependencies.loadQueue = async () => {
      queried = true;
      return page("P-DEMO", []);
    };
    const result = await new LedgerMovesProvider(f.dependencies).nextMoves(next(f.db));
    assert.equal(result.primaryMove, null);
    assert.equal(queried, true);
  } finally {
    f.sqlite.close();
  }
});
test("an observer cannot receive the first-claim promotion move", async () => {
  const f = fixture();
  try {
    f.sqlite.exec(
      "UPDATE problems SET public_seq=0; UPDATE problem_memberships SET role='observer'",
    );
    f.dependencies.loadQueue = async () => page("P-DEMO", []);
    const result = await new LedgerMovesProvider(f.dependencies).nextMoves(next(f.db));
    assert.equal(result.primaryMove, null);
    assert.equal(result.effectivePermissions?.promote, false);
  } finally {
    f.sqlite.close();
  }
});
test("triage selects a first claim when assigned boards have no existing review need", async () => {
  const f = fixture(["P-AAA", "P-BBB"]);
  try {
    f.sqlite.exec("UPDATE problems SET public_seq=0");
    const result = await new LedgerMovesProvider(f.dependencies).triageMove({
      db: f.db,
      credential,
      fellowId: credential.fellowId,
      assignments: [assignment("P-BBB"), assignment("P-AAA")],
    });
    assert.equal(result.move?.move, "state-claim");
    assert.deepEqual(result.move?.refs, ["P-AAA"]);
    assert.equal(f.queueReads(), 0);
  } finally {
    f.sqlite.close();
  }
});
test("triage prioritizes an existing independent check over opening another board", async () => {
  const f = fixture(["P-AAA", "P-BBB"]);
  try {
    f.sqlite.exec("UPDATE problems SET public_seq=0 WHERE id='P-AAA'");
    const result = await new LedgerMovesProvider(f.dependencies).triageMove({
      db: f.db,
      credential,
      fellowId: credential.fellowId,
      assignments: [assignment("P-AAA"), assignment("P-BBB")],
    });
    assert.equal(result.move?.move, "review");
    assert.deepEqual(result.move?.refs, ["P-BBB", "C-1@1"]);
  } finally {
    f.sqlite.close();
  }
});
