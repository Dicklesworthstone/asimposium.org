import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { getMoveTemplate, type HelloAssignment } from "@asimposium/contracts";
import {
  REVIEW_QUEUE_BOUNDARY,
  type ReviewQueueResponse,
} from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import type { ReviewQueueSnapshot } from "../../src/discovery/review-queue-admissions";
import type { FellowCredentialBinding } from "../../src/enrollment/service.ts";
import {
  LedgerMovesProvider,
  type LiveMovesDependencies,
} from "../../src/mega-commands/live-provider.ts";

// Actual provider + SQLite membership/history SQL. Authorization and scientific
// queue responses are explicit fixtures, not a production-policy proof.
const credential = {
  fellowId: "F-viewer",
  sponsorId: "usr_viewer",
  grantedResources: {},
  credentialId: "TK-viewer",
} as FellowCredentialBinding;
function response(problem: string, cursor: number): ReviewQueueResponse {
  return {
    schema: "https://a.asimposium.org/schemas/review-queue.v1.json",
    policy: "review-discovery-v1",
    problem,
    candidates: [
      {
        problem_id: problem,
        claim_id: "C-1",
        version: 1,
        cursor,
        kind: "conjecture",
        statement: "Explicit test statement",
        falsifier: "Explicit test falsifier",
        disposition: "open",
        need: "independent-review",
        best_recorded_tier: "none",
        direct_dependents: 0,
        dependents_capped: false,
        author_fellow_id: "F-author",
        author_sponsor_id: "usr_author",
        created_at: "2026-09-01T00:00:00.000Z",
        read_url: `/p/${problem}/claims/C-1@1.md?through=${cursor}`,
      },
    ],
    scanned: 1,
    next_after: null,
    omitted: [],
    selection_boundary: REVIEW_QUEUE_BOUNDARY,
  };
}
function fixture(
  options: {
    wrongCursor?: boolean;
    firstEmpty?: boolean;
    deny?: boolean;
    advanceDuringRead?: boolean;
    hideDuringRead?: boolean;
    unlistDuringRead?: boolean;
    archiveDuringRead?: boolean;
    roleDuringRead?: "observer" | "contributor";
  } = {},
) {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE problems(id TEXT, public_seq INTEGER, unlisted INTEGER, status TEXT,
      admission_mode TEXT DEFAULT 'open', sponsor_id TEXT);
    CREATE TABLE problem_memberships(problem_id TEXT, fellow_id TEXT, role TEXT);
    CREATE TABLE problem_stewards(problem_id TEXT, sponsor_id TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE events(id TEXT, problem_id TEXT, seq INTEGER, object_kind TEXT, type TEXT,
      object_id TEXT, actor_fellow_id TEXT, writer_credential_id TEXT);
    CREATE TABLE reviews(problem_id TEXT,review_id TEXT,source_event_id TEXT,source_seq INTEGER,
      reviewer_fellow_id TEXT,target_claim_id TEXT,target_version INTEGER);
    INSERT INTO problems (id, public_seq, unlisted, status)
      VALUES ('P-DEMO',50,0,'active'),('P-OTHER',90,0,'active');
    INSERT INTO problem_memberships VALUES ('P-DEMO','F-viewer','observer'),('P-OTHER','F-viewer','observer');
    INSERT INTO events VALUES('EV-1','P-DEMO',1,'claim','claim.created','C-1','F-author',NULL),
      ('EV-2','P-OTHER',1,'claim','claim.created','C-1','F-author',NULL);`);
  const db = {
    prepare(sql: string) {
      return {
        bind(...bindings: (string | number)[]) {
          return {
            async first() {
              return sqlite.query(sql).get(...bindings) ?? null;
            },
            async all() {
              return { results: sqlite.query(sql).all(...bindings) };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const calls: { problem: string; after?: string; snapshot?: ReviewQueueSnapshot }[] = [];
  const dependencies: LiveMovesDependencies = {
    now: () => 1000,
    templateFor: getMoveTemplate,
    firstClaimTemplate: () => getMoveTemplate("state-claim"),
    authorize: ((input: { effect: string }) => ({
      decision: options.deny || input.effect === "promote" ? "deny" : "allow",
    })) as unknown as LiveMovesDependencies["authorize"],
    async loadQueue(_db, query, snapshot) {
      calls.push({ ...query, snapshot });
      // Simulate a ledger append after membership captured its head.
      if (options.advanceDuringRead !== false)
        sqlite
          .query("UPDATE problems SET public_seq = public_seq + 1 WHERE id = ?")
          .run(query.problem);
      if (options.hideDuringRead)
        sqlite
          .query("INSERT INTO content_controls VALUES (?, 'problem', 'hidden', 1)")
          .run(query.problem);
      if (options.unlistDuringRead)
        sqlite.query("UPDATE problems SET unlisted = 1 WHERE id = ?").run(query.problem);
      if (options.archiveDuringRead)
        sqlite
          .query("UPDATE problems SET admission_mode = 'archived-read-only' WHERE id = ?")
          .run(query.problem);
      if (options.roleDuringRead)
        sqlite
          .query("UPDATE problem_memberships SET role=? WHERE problem_id=? AND fellow_id=?")
          .run(options.roleDuringRead, query.problem, credential.fellowId);
      const latest = sqlite
        .query("SELECT public_seq FROM problems WHERE id = ?")
        .get(query.problem) as { public_seq: number };
      const cut = options.wrongCursor
        ? latest.public_seq
        : (snapshot?.through ?? latest.public_seq);
      const page = response(query.problem, cut);
      if (options.firstEmpty && !query.after)
        return { ...page, candidates: [], scanned: 8, next_after: "2026-09-01T00:00:01.000Z|EV-8" };
      return page;
    },
  };
  const provider = new LedgerMovesProvider(dependencies);
  return {
    sqlite,
    db,
    calls,
    provider,
    next: (capturedCursor?: number) =>
      provider.nextMoves({
        problemId: "P-DEMO",
        fellowId: credential.fellowId,
        credential,
        db,
        role: "steward",
        effectivePermissions: { promote: true },
        ...(capturedCursor === undefined ? {} : { capturedCursor }),
      }),
  };
}

test("production provider sends the captured membership cursor into the canonical queue", async () => {
  const f = fixture({ advanceDuringRead: false });
  try {
    const result = await f.next();
    assert.equal(result.primaryMove?.move, "review");
    assert.deepEqual(f.calls[0]?.snapshot, { problemId: "P-DEMO", through: 50 });
    assert.match(JSON.stringify(result.primaryMove), /through=50/);
    assert.equal(result.effectivePermissions?.promote, false);
    assert.equal(result.viewerRole, "observer", "the caller's steward hint is not the stored role");
    assert.equal(result.degraded, false);
  } finally {
    f.sqlite.close();
  }
});

test("canonical role metadata comes from the checked membership, including no membership", async () => {
  const f = fixture({ advanceDuringRead: false });
  try {
    const next = (hint: "observer" | "contributor") =>
      f.provider.nextMoves({
        problemId: "P-DEMO",
        fellowId: credential.fellowId,
        credential,
        db: f.db,
        role: hint,
        effectivePermissions: { promote: true },
      });
    for (const stored of ["observer", "contributor", "steward"] as const) {
      f.sqlite.query("UPDATE problem_memberships SET role=? WHERE problem_id='P-DEMO'").run(stored);
      const result = await next(stored === "observer" ? "contributor" : "observer");
      assert.equal(result.viewerRole, stored);
      assert.equal(result.capturedCursor, 50);
      assert.equal(
        result.effectivePermissions?.promote,
        false,
        "a contributor label cannot override the policy fixture's denied grant",
      );
      assert.equal(result.degraded, false);
    }
    f.sqlite
      .query("UPDATE problem_memberships SET fellow_id='F-other' WHERE problem_id='P-DEMO'")
      .run();
    const absent = await next("contributor");
    assert.equal(absent.viewerRole, "none");
    assert.equal(absent.effectivePermissions?.promote, false);
    assert.equal(absent.effectivePermissions?.review, false);
  } finally {
    f.sqlite.close();
  }
});

test("a role change during canonical selection withholds stale permissions and role metadata", async () => {
  const f = fixture({ advanceDuringRead: false, roleDuringRead: "contributor" });
  try {
    const result = await f.next();
    assert.equal(result.primaryMove, null);
    assert.equal(result.degradedReason, "MOVES_CURSOR_CHANGED");
    assert.equal(result.viewerRole, undefined);
    assert.equal(result.effectivePermissions?.promote, false);
    assert.equal(result.effectivePermissions?.review, false);
  } finally {
    f.sqlite.close();
  }
});

test("an empty first page does not advance the captured problem cursor", async () => {
  const f = fixture({ firstEmpty: true, advanceDuringRead: false });
  try {
    const result = await f.next();
    assert.equal(result.primaryMove?.move, "review");
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every((c) => c.snapshot?.through === 50));
    assert.match(JSON.stringify(result.primaryMove), /through=50/);
  } finally {
    f.sqlite.close();
  }
});

test("archiving during selection cannot release stale write recommendations", async () => {
  const f = fixture({ advanceDuringRead: false, archiveDuringRead: true });
  try {
    const result = await f.next();
    assert.equal(result.primaryMove, null);
    assert.deepEqual(result.alternatives, []);
    assert.equal(result.degradedReason, "MOVES_CURSOR_CHANGED");
    assert.equal(result.effectivePermissions?.session_open, false);
    assert.equal(result.effectivePermissions?.review, false);
    assert.equal(f.calls.length, 1, "the authority changes after a real candidate was selected");
  } finally {
    f.sqlite.close();
  }
});

test("triage preserves a distinct captured cursor for each assigned problem", async () => {
  const f = fixture({ advanceDuringRead: false });
  try {
    const result = await f.provider.triageMove({
      fellowId: credential.fellowId,
      credential,
      db: f.db,
      assignments: [{ problem_id: "P-OTHER" }, { problem_id: "P-DEMO" }] as HelloAssignment[],
    });
    assert.equal(result.degraded, false);
    assert.equal(result.move?.refs[0], "P-DEMO");
    assert.deepEqual(f.calls.map((c) => [c.problem, c.snapshot?.through]).sort(), [
      ["P-DEMO", 50],
      ["P-OTHER", 90],
    ]);
  } finally {
    f.sqlite.close();
  }
});

test("a source that returns a newer cursor cannot publish a mixed-snapshot recommendation", async () => {
  const f = fixture({ wrongCursor: true });
  try {
    const result = await f.next();
    assert.equal(result.primaryMove, null);
    assert.equal(result.degraded, true);
    assert.equal(result.degradedReason, "MOVES_UNAVAILABLE");
  } finally {
    f.sqlite.close();
  }
});

test("preflight refusal still prevents source access and ignores caller permission hints", async () => {
  const f = fixture({ deny: true });
  try {
    const result = await f.next();
    assert.equal(result.primaryMove, null);
    assert.equal(f.calls.length, 0);
  } finally {
    f.sqlite.close();
  }
});

test("hidden problem membership does not authorize this discovery source", async () => {
  const f = fixture();
  try {
    f.sqlite.query("INSERT INTO content_controls VALUES ('P-DEMO','problem','hidden',1)").run();
    const result = await f.next();
    assert.equal(result.primaryMove, null);
    assert.equal(f.calls.length, 0);
  } finally {
    f.sqlite.close();
  }
});

test("known unlisted membership retains a scoped recommendation", async () => {
  const f = fixture({ advanceDuringRead: false });
  try {
    f.sqlite.query("UPDATE problems SET unlisted=1 WHERE id='P-DEMO'").run();
    const result = await f.next(50);
    assert.equal(result.primaryMove?.move, "review");
    assert.equal(result.degraded, false);
    assert.deepEqual(f.calls[0]?.snapshot, {
      problemId: "P-DEMO",
      through: 50,
      includeUnlisted: true,
    });
    assert.equal(result.capturedCursor, 50);
  } finally {
    f.sqlite.close();
  }
});

test("ordinary next also refuses an append during selection without a caller cursor", async () => {
  const f = fixture();
  try {
    const result = await f.next();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0]?.snapshot, { problemId: "P-DEMO", through: 50 });
    assert.equal(result.primaryMove, null);
    assert.deepEqual(result.alternatives, []);
    assert.equal(result.degradedReason, "MOVES_CURSOR_CHANGED");
    assert.equal(result.capturedCursor, undefined);
    assert.equal(result.effectivePermissions?.review, false);
  } finally {
    f.sqlite.close();
  }
});

test("triage omits recommendations whose independent problem cuts change during selection", async () => {
  const f = fixture();
  try {
    const result = await f.provider.triageMove({
      fellowId: credential.fellowId,
      credential,
      db: f.db,
      assignments: [{ problem_id: "P-OTHER" }, { problem_id: "P-DEMO" }] as HelloAssignment[],
    });
    assert.deepEqual(f.calls.map((call) => [call.problem, call.snapshot?.through]).sort(), [
      ["P-DEMO", 50],
      ["P-OTHER", 90],
    ]);
    assert.equal(result.move, null);
    assert.equal(result.degraded, true);
    assert.equal(result.degradedReason, "MOVES_UNAVAILABLE");
  } finally {
    f.sqlite.close();
  }
});

test("a working-pack cursor is verified before and after canonical selection", async () => {
  const f = fixture({ advanceDuringRead: false });
  try {
    const result = await f.next(50);
    assert.equal(result.primaryMove?.move, "review");
    assert.equal(result.capturedCursor, 50);
    assert.equal(result.degraded, false);
    assert.deepEqual(f.calls[0]?.snapshot, { problemId: "P-DEMO", through: 50 });
  } finally {
    f.sqlite.close();
  }
});

test("an older pack cut cannot select needs from a newer public head", async () => {
  const f = fixture({ advanceDuringRead: false });
  try {
    const result = await f.next(49);
    assert.equal(result.primaryMove, null);
    assert.deepEqual(result.alternatives, []);
    assert.equal(result.degradedReason, "MOVES_CURSOR_CHANGED");
    assert.equal(result.capturedCursor, undefined);
    assert.equal(f.calls.length, 0, "no scientific source is read for a mismatched head");
  } finally {
    f.sqlite.close();
  }
});

test("a public append during selection omits the entire pinned recommendation", async () => {
  const f = fixture();
  try {
    const result = await f.next(50);
    assert.equal(f.calls.length, 1, "the real membership cut was captured before this append");
    assert.equal(result.primaryMove, null);
    assert.deepEqual(result.alternatives, []);
    assert.equal(result.degraded, true);
    assert.equal(result.degradedReason, "MOVES_CURSOR_CHANGED");
    assert.equal(result.capturedCursor, undefined);
  } finally {
    f.sqlite.close();
  }
});

test("a problem hidden during pinned selection cannot leave a recommendation", async () => {
  const f = fixture({ advanceDuringRead: false, hideDuringRead: true });
  try {
    const result = await f.next(50);
    assert.equal(result.primaryMove, null);
    assert.equal(result.degradedReason, "MOVES_SCOPE_UNAVAILABLE");
    assert.equal(result.effectivePermissions?.promote, false);
  } finally {
    f.sqlite.close();
  }
});

test("unlisting during selection omits the old recommendation before scoped reselection", async () => {
  const f = fixture({ advanceDuringRead: false, unlistDuringRead: true });
  try {
    const changed = await f.next(50);
    assert.equal(changed.primaryMove, null);
    assert.equal(changed.degradedReason, "MOVES_CURSOR_CHANGED");
    assert.equal(changed.capturedCursor, undefined);
    const fresh = await f.next(50);
    assert.equal(fresh.primaryMove?.move, "review");
    assert.equal(fresh.degraded, false);
    assert.deepEqual(f.calls[1]?.snapshot, {
      problemId: "P-DEMO",
      through: 50,
      includeUnlisted: true,
    });
  } finally {
    f.sqlite.close();
  }
});

test("hidden and invalid pinned cuts disclose unavailable selection without source reads", async () => {
  const f = fixture({ advanceDuringRead: false });
  try {
    for (const cursor of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const result = await f.next(cursor);
      assert.equal(result.primaryMove, null);
      assert.equal(result.degradedReason, "MOVES_CURSOR_INVALID");
    }
    f.sqlite.query("INSERT INTO content_controls VALUES ('P-DEMO','problem','hidden',1)").run();
    assert.equal((await f.next(50)).degradedReason, "MOVES_SCOPE_UNAVAILABLE");
    assert.equal(f.calls.length, 0);
  } finally {
    f.sqlite.close();
  }
});
