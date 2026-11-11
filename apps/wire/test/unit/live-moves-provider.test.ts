import { Database } from "bun:sqlite";
import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { getMoveTemplate, type HelloAssignment, type MoveTemplate } from "@asimposium/contracts";
import type { ReviewQueueItem, ReviewQueueResponse } from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import {
  authorizeFellowWrite,
  type FellowCredentialBinding,
} from "../../src/enrollment/service.ts";
import { selectRecordDeadEndMove } from "../../src/mega-commands/dead-end-moves.ts";
import {
  LedgerMovesProvider,
  type LiveMovesDependencies,
  TRIAGE_CONCURRENCY,
  TRIAGE_MAX_PROBLEMS,
} from "../../src/mega-commands/live-provider.ts";
import { sha256Hex } from "../../src/split/policy.ts";

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
    target_contract: "/schemas/sessions.v1/review_request.json",
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
  sqlite.exec(`CREATE TABLE problems(id TEXT, status TEXT, unlisted INTEGER, public_seq INTEGER,
      admission_mode TEXT DEFAULT 'open', sponsor_id TEXT);
    CREATE TABLE problem_memberships(problem_id TEXT, fellow_id TEXT, role TEXT);
    CREATE TABLE problem_stewards(problem_id TEXT, sponsor_id TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE events(id TEXT, problem_id TEXT, object_id TEXT, object_kind TEXT, type TEXT, seq INTEGER, actor_fellow_id TEXT, writer_credential_id TEXT);
    CREATE TABLE reviews(problem_id TEXT, review_id TEXT, source_event_id TEXT, source_seq INTEGER, reviewer_fellow_id TEXT, target_claim_id TEXT, target_version INTEGER);`);
  for (const problem of problems) {
    sqlite
      .query("INSERT INTO problems (id, status, unlisted, public_seq) VALUES (?, 'active', 0, 10)")
      .run(problem);
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
  const problemId = "P-LIVE-MOVE-HASH";
  const f = fixture([problemId]);
  const diagnostic = spyOn(console, "info");
  try {
    const result = await new LedgerMovesProvider(f.dependencies).nextMoves(
      next(f.db, credential, problemId),
    );
    assert.equal(result.primaryMove?.move, "review");
    assert.equal(result.degraded, false);
    assert.equal(result.effectivePermissions?.review, true);
    const entry = diagnostic.mock.calls.find(
      ([line]) => typeof line === "string" && line.includes('"problem_id":"P-LIVE-MOVE-HASH"'),
    );
    const record = JSON.parse(String(entry?.[0]));
    assert.equal(record.problem_id, problemId);
    assert.equal(record.score_components.candidates_count, 1);
    // Independent sha256sum vector; the unique problem scopes the captured log.
    assert.equal(
      record.public_input_digest,
      "9be181837691734f10be618220239aea8c51bbc7cc717817ac4ee8b5576ffc30",
    );
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
    diagnostic.mockRestore();
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

test("public-write quota is filtered before ranking truncation so private investigation remains reachable", async () => {
  const f = fixture();
  try {
    f.dependencies.loadQueue = async () =>
      page(
        "P-DEMO",
        [1, 2, 3].map((n) => item("P-DEMO", { claim_id: `C-${n}` })),
      );
    const discriminate: NonNullable<LiveMovesDependencies["discriminate"]> = {
      load: async () => ({
        degraded: false,
        move: {
          move: "discriminate",
          why: "Compare the three route predictions in a private investigation.",
          refs: ["P-DEMO", "H-1", "H-2", "H-3"],
          contract: {
            ...getMoveTemplate("discriminate"),
            preparation: { problem_id: "P-DEMO", captured_cursor: 10 },
          },
        },
      }),
    };
    const provider = new LedgerMovesProvider({ ...f.dependencies, discriminate });
    const ordinary = await provider.nextMoves(next(f.db));
    assert.deepEqual(
      [ordinary.primaryMove, ...ordinary.alternatives].map((move) => move?.move),
      ["review", "review", "review"],
    );
    const limited = await provider.nextMoves({ ...next(f.db), publicWritesLimited: true });
    assert.equal(limited.primaryMove?.move, "discriminate");
    assert.deepEqual(limited.alternatives, []);
    assert.equal(limited.degraded, false);
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
test("central observer authority feeds evidence and dead-end work into next and triage", async () => {
  const f = fixture();
  try {
    f.sqlite.exec("UPDATE problem_memberships SET role='observer'");
    // The real dead-end selector now requires an actual assertion plateau;
    // role permission alone cannot invent a scientific need.
    f.sqlite.exec(`ALTER TABLE events ADD COLUMN object_version INTEGER;
      ALTER TABLE events ADD COLUMN payload_sha256 TEXT;
      CREATE TABLE event_content(event_id TEXT, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);`);
    const claimPayload = JSON.stringify({ claim_id: "C-1", statement: "A recorded claim." });
    const claimDigest = await sha256Hex(claimPayload);
    f.sqlite
      .query("UPDATE events SET id='EV-1',object_id='C-1',object_version=1,payload_sha256=?")
      .run(claimDigest);
    f.sqlite
      .query("INSERT INTO event_content VALUES('EV-1',?,?,NULL)")
      .run(claimDigest, claimPayload);
    for (const index of [2, 3, 4]) {
      const raw = JSON.stringify({
        bears_on_kind: "claim",
        bears_on_id: "C-1",
        bears_on_version: 1,
        kind: "argument",
        direction: "supports",
        source: { kind: "model_memory" },
        mode: "exploratory",
        body_md: `Distinct observation ${index}.`,
        computed_class: "assertion",
        coercion_flags: ["p8_model_memory_caps_at_assertion"],
      });
      const digest = await sha256Hex(raw);
      f.sqlite
        .query(
          "INSERT INTO events(id,problem_id,object_id,object_kind,type,seq,object_version,payload_sha256) VALUES(?,'P-DEMO',?,'evidence','evidence.created',?,1,?)",
        )
        .run(`EV-${index}`, `E-${index}`, index, digest);
      f.sqlite
        .query("INSERT INTO event_content VALUES(?,?,?,NULL)")
        .run(`EV-${index}`, digest, raw);
    }
    const provider = new LedgerMovesProvider({
      ...f.dependencies,
      authorize: authorizeFellowWrite,
      templateFor: getMoveTemplate,
      loadQueue: async () => page("P-DEMO", [item("P-DEMO", { need: "falsification-attempt" })]),
      deadEnds: { load: selectRecordDeadEndMove },
    });
    const request = { ...next(f.db), role: "observer" as const };
    const result = await provider.nextMoves(request);
    assert.equal(result.degraded, false);
    assert.equal(result.effectivePermissions?.promote, false);
    assert.equal(result.effectivePermissions?.evidence, true);
    assert.equal(result.effectivePermissions?.dead_end, true);
    assert.equal(result.primaryMove?.move, "add-refuter");
    const refuterTemplate = getMoveTemplate("add-refuter");
    assert.ok(refuterTemplate.availability === "available");
    assert.deepEqual(result.primaryMove?.contract.request, refuterTemplate.request);
    assert.deepEqual(
      result.alternatives.map((move) => move.move),
      ["record-dead-end"],
    );
    const triage = await provider.triageMove({
      db: f.db,
      credential,
      fellowId: credential.fellowId,
      assignments: [{ ...assignment("P-DEMO"), role: "observer" }],
    });
    assert.deepEqual(triage.move, result.primaryMove);

    const reviewOnly = await provider.nextMoves({
      ...request,
      credential: { ...credential, grantedScopes: ["review"] },
      effectivePermissions: { promote: true, evidence: true, dead_end: true },
    });
    assert.equal(reviewOnly.primaryMove, null);
    assert.deepEqual(reviewOnly.alternatives, []);
    assert.equal(reviewOnly.effectivePermissions?.evidence, false);
    assert.equal(reviewOnly.effectivePermissions?.dead_end, false);
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
  ["malformed listing", "UPDATE problems SET unlisted=2"],
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
for (const mode of ["open", "approval-required", "invite-only", "archived-read-only"] as const)
  for (const authority of ["outsider", "owner", "steward"] as const)
    test(`nonmember ${authority} receives truthful session admission on ${mode}`, async () => {
      const f = fixture();
      try {
        f.sqlite.exec("UPDATE problem_memberships SET fellow_id='F-OTHER'");
        f.sqlite
          .query("UPDATE problems SET admission_mode = ?, sponsor_id = ?")
          .run(mode, authority === "owner" ? credential.sponsorId : "SP-OWNER");
        if (authority === "steward")
          f.sqlite
            .query("INSERT INTO problem_stewards VALUES ('P-DEMO', ?)")
            .run(credential.sponsorId);
        const result = await new LedgerMovesProvider(f.dependencies).nextMoves(next(f.db));
        assert.equal(result.degraded, false);
        assert.equal(
          result.effectivePermissions?.session_open,
          mode !== "archived-read-only" && (mode === "open" || authority !== "outsider"),
        );
        for (const operation of ["workshop_push", "promote", "evidence", "dead_end", "review"])
          assert.equal(result.effectivePermissions?.[operation], false);
        assert.equal(result.primaryMove, null);
        assert.deepEqual(result.alternatives, []);
        assert.equal(f.queueReads(), 0);
      } finally {
        f.sqlite.close();
      }
    });

test("a nonmember cannot spend an exhausted credential grant by opening a new problem", async () => {
  const f = fixture();
  try {
    f.sqlite.exec(`UPDATE problem_memberships SET fellow_id='F-OTHER';
      INSERT INTO events (writer_credential_id, problem_id) VALUES ('FC-READER','P-OTHER')`);
    const result = await new LedgerMovesProvider(f.dependencies).nextMoves(
      next(f.db, { ...credential, grantedResources: { eventBudget: 1 } }),
    );
    assert.equal(result.degraded, false);
    assert.equal(result.effectivePermissions?.session_open, false);
    assert.equal(f.queueReads(), 0);
    assert.ok(
      f.calls.some((call) => call.effect === "session.open" && call.usage.eventsRecorded === 1),
      "new admission uses the credential's actual committed usage",
    );
  } finally {
    f.sqlite.close();
  }
});

test("archiving a member's workspace preserves private drafting without scientific moves", async () => {
  const f = fixture();
  try {
    f.sqlite.exec("UPDATE problems SET admission_mode='archived-read-only'");
    const provider = new LedgerMovesProvider(f.dependencies);
    const result = await provider.nextMoves({ ...next(f.db), capturedCursor: 10 });
    assert.equal(result.degraded, false);
    assert.equal(result.capturedCursor, 10);
    assert.equal(result.primaryMove, null);
    assert.deepEqual(result.alternatives, []);
    assert.deepEqual(result.effectivePermissions, {
      read: true,
      session_open: false,
      workshop_push: true,
      promote: false,
      evidence: false,
      dead_end: false,
      review: false,
    });
    const triage = await provider.triageMove({
      db: f.db,
      credential,
      fellowId: credential.fellowId,
      assignments: [assignment("P-DEMO")],
    });
    assert.equal(triage.move, null);
    assert.equal(triage.degraded, false);
    assert.equal(f.queueReads(), 0, "read-only work does not enter scientific move selection");
    f.sqlite.exec(
      "INSERT INTO events (writer_credential_id, problem_id) VALUES ('FC-READER','P-OTHER')",
    );
    const exhausted = await provider.nextMoves(
      next(f.db, { ...credential, grantedResources: { eventBudget: 1 } }),
    );
    assert.equal(exhausted.effectivePermissions?.workshop_push, false);
    assert.equal(f.queueReads(), 0);
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

test("next and triage select statement review for review-only observers while the claims board is locked", async () => {
  const f = fixture();
  try {
    f.sqlite.exec("UPDATE problems SET status='sharpening',public_seq=0");
    f.sqlite.exec("UPDATE problem_memberships SET role='observer'");
    const reviewCredential = {
      ...credential,
      grantedScopes: ["review"],
    } as FellowCredentialBinding;
    let selections = 0;
    const provider = new LedgerMovesProvider({
      ...f.dependencies,
      sharpen: {
        async load(_db, problem, cursor, viewer) {
          selections++;
          assert.equal(viewer?.fellowId, credential.fellowId);
          assert.equal(viewer?.sponsorId, credential.sponsorId);
          return {
            move: {
              move: "sharpen-statement",
              why: "Inspect the exact current formulation before deciding a verdict.",
              refs: [problem, "S@1"],
              contract: {
                ...getMoveTemplate("sharpen-statement"),
                preparation: { problem_id: problem, captured_cursor: cursor },
              },
            },
            degraded: false,
          };
        },
      },
    });
    const result = await provider.nextMoves(next(f.db, reviewCredential));
    assert.equal(result.primaryMove?.move, "sharpen-statement");
    assert.equal(result.effectivePermissions?.review, true);
    assert.equal(result.effectivePermissions?.promote, false);
    assert.deepEqual(result.alternatives, []);
    assert.equal(f.queueReads(), 0);
    const triage = await provider.triageMove({
      db: f.db,
      credential: reviewCredential,
      fellowId: reviewCredential.fellowId,
      assignments: [assignment("P-DEMO")],
    });
    assert.equal(triage.move?.move, "sharpen-statement");
    const denied = await provider.nextMoves(next(f.db, { ...reviewCredential, grantedScopes: [] }));
    assert.equal(denied.primaryMove, null);
    assert.equal(selections, 3);
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
