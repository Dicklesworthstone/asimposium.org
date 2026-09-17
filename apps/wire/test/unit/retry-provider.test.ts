import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  getMoveTemplate,
  type HelloAssignment,
  type NextMoveCandidate,
} from "@asimposium/contracts";
import {
  REVIEW_QUEUE_BOUNDARY,
  REVIEW_QUEUE_SCHEMA_ID,
  type ReviewQueueItem,
  ReviewQueueResponseSchema,
} from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import type { FellowCredentialBinding } from "../../src/enrollment/service.ts";
import {
  LedgerMovesProvider,
  type LiveMovesDependencies,
} from "../../src/mega-commands/live-provider.ts";
import { retryMoveFor } from "../../src/mega-commands/retry-moves.ts";

// Actual provider, ranking helpers and SQLite membership/history/usage queries.
// Authorization decisions and scientific source outputs are explicit fixtures;
// these are not full enrollment, evaluator, route or migration-lineage tests.
const plainMove = (move: NextMoveCandidate["move"], problem = "P-DEMO"): NextMoveCandidate => ({
  move,
  refs: [problem, move === "close-gap" ? "G-2" : "C-1@1"],
  why: "Fixture scientific need",
  contract: {},
});
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, unlisted INTEGER, status TEXT);
    CREATE TABLE problem_memberships(problem_id TEXT,fellow_id TEXT,role TEXT);
    CREATE TABLE events(id TEXT,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,object_id TEXT,
      actor_fellow_id TEXT,writer_credential_id TEXT);
    CREATE TABLE reviews(target_claim_id TEXT,target_version INTEGER,source_event_id TEXT,problem_id TEXT,
      review_id TEXT,source_seq INTEGER,reviewer_fellow_id TEXT);`);
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      return {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          this.args = args;
          return this;
        },
        async first() {
          queries.push(query);
          return sql.query(query).get(...(this.args as never[])) ?? null;
        },
        async all() {
          queries.push(query);
          return { results: sql.query(query).all(...(this.args as never[])) };
        },
      };
    },
  } as unknown as D1Database;
  const credential: FellowCredentialBinding = {
    fellowId: "F-VIEWER",
    sponsorId: "usr_viewer",
    credentialId: ["cred", "viewer"].join("-"),
    name: "viewer",
    model: "self-declared",
    harness: "harness",
    tokenHash: "a".repeat(64),
    issuedAt: 1,
    expiresAt: 100000,
    credentialProfile: "bearer",
    fellowStatus: "active",
    grantedScopes: ["promote", "review"],
    grantedResources: {},
  };
  const denied = new Set<string>();
  const retryReads: { problem: string; cursor: number; fellow: string }[] = [];
  const queue: ReviewQueueItem[] = [];
  const deps: { -readonly [K in keyof LiveMovesDependencies]: LiveMovesDependencies[K] } = {
    now: () => 100,
    firstClaimTemplate: () => getMoveTemplate("state-claim"),
    templateFor: getMoveTemplate,
    authorize(input) {
      const role = "membershipRole" in input.target ? input.target.membershipRole : undefined;
      const restricted =
        denied.has(input.effect) ||
        (input.effect === "promote" && role === "observer") ||
        (input.effect === "promote" &&
          input.credential.grantedResources.eventBudget !== undefined &&
          input.usage.eventsRecorded >= input.credential.grantedResources.eventBudget);
      // The exact policy result vocabulary is outside this fixture's assertions.
      return { decision: restricted ? "refuse" : "allow", effect: input.effect } as ReturnType<
        LiveMovesDependencies["authorize"]
      >;
    },
    async loadQueue(_db, query) {
      const candidates = queue.filter((item) => item.problem_id === query.problem);
      return ReviewQueueResponseSchema.parse({
        problem: query.problem,
        candidates,
        next_after: null,
        omitted: [],
        schema: REVIEW_QUEUE_SCHEMA_ID,
        policy: "review-discovery-v1",
        scanned: candidates.length,
        selection_boundary: REVIEW_QUEUE_BOUNDARY,
      });
    },
    retries: {
      async load(_db, problem, cursor, fellow) {
        retryReads.push({ problem, cursor, fellow });
        return {
          degraded: false,
          move: retryMoveFor(
            {
              problem_id: problem,
              cursor,
              dead_end_id: "DE-1",
              author_fellow_id: "F-ORIGINAL",
              source: {
                approach: "source work",
                why_it_fails: "failure work",
                retry_predicate: "retry condition",
                retry_when: { kind: "statement-revised" },
              },
              publication: { event_id: "SOURCE", seq: 1, payload_sha256: "a".repeat(64) },
              firing: { event_id: "FIRING", seq: 3, payload_sha256: "b".repeat(64) },
            },
            fellow,
            getMoveTemplate("retry-dead-end"),
          ),
        };
      },
    },
  };
  const provider = new LedgerMovesProvider(deps);
  function problem(id = "P-DEMO", claims = true, role = "contributor") {
    sql.query("INSERT INTO problems VALUES(?,20,0,'active')").run(id);
    sql.query("INSERT INTO problem_memberships VALUES(?,'F-VIEWER',?)").run(id, role);
    if (claims)
      sql
        .query("INSERT INTO events VALUES(?,?,1,'claim.created','claim','C-1','F-AUTHOR',NULL)")
        .run(`claim-${id}`, id);
  }
  function review(problem = "P-DEMO", n = 1) {
    queue.push({
      problem_id: problem,
      cursor: 20,
      claim_id: `C-${n}`,
      version: 1,
      kind: "conjecture",
      statement: "Every object in the finite domain has the stated property.",
      falsifier: "An object in the domain without the property.",
      disposition: "open",
      best_recorded_tier: "none",
      dependents_capped: false,
      read_url: `/p/${encodeURIComponent(problem)}/claims/C-${n}@1.md?through=20`,
      author_fellow_id: "F-AUTHOR",
      author_sponsor_id: "usr_author",
      need: "independent-review",
      direct_dependents: 1,
      created_at: "2026-01-01T00:00:00.000Z",
    });
  }
  const request = (problemId = "P-DEMO") => ({
    db,
    credential,
    problemId,
    fellowId: credential.fellowId,
    role: "steward" as const,
    effectivePermissions: { promote: true, review: true, session_open: true, workshop_push: true },
  });
  const next = (id = "P-DEMO") => provider.nextMoves(request(id));
  const triage = (ids: string[]) =>
    provider.triageMove({
      db,
      credential,
      fellowId: credential.fellowId,
      assignments: ids.map((problem_id) => ({
        problem_id,
        role: "contributor",
      })) as HelloAssignment[],
    });
  return {
    sql,
    db,
    queries,
    credential,
    denied,
    retryReads,
    deps,
    provider,
    problem,
    review,
    request,
    next,
    triage,
  };
}

test("next selects a retry at the same authenticated problem cursor", async () => {
  const f = fixture();
  try {
    f.problem();
    const result = await f.next();
    assert.equal(result.primaryMove?.move, "retry-dead-end");
    assert.equal(result.degraded, false);
    assert.deepEqual(f.retryReads, [{ problem: "P-DEMO", cursor: 20, fellow: "F-VIEWER" }]);
    const prepared = result.primaryMove!.contract.preparation as Record<string, unknown>;
    assert.equal(prepared.author_may_supersede, false);
    assert.equal(prepared.captured_cursor, 20);
  } finally {
    f.sql.close();
  }
});

test("retry conditions on an otherwise empty claim board precede starting a new claim", async () => {
  const f = fixture();
  try {
    f.problem("P-DEMO", false);
    const result = await f.next();
    assert.equal(result.primaryMove?.move, "retry-dead-end");
    assert.equal(result.alternatives[0]?.move, "state-claim");
    assert.ok(!f.queries.some((query) => query.includes("FROM reviews")));
  } finally {
    f.sql.close();
  }
});

test("independent review and unowned gaps keep priority over retry work", async () => {
  const f = fixture();
  try {
    f.problem();
    f.review();
    f.deps.gaps = {
      async load() {
        return { move: plainMove("close-gap"), degraded: false };
      },
    };
    const result = await f.next();
    assert.equal(result.primaryMove?.move, "review");
    assert.deepEqual(
      result.alternatives.map((move) => move.move),
      ["close-gap", "retry-dead-end"],
    );
  } finally {
    f.sql.close();
  }
});

for (const denied of ["promote", "workshop.push", "session.open"])
  test(`central ${denied} denial overrides supplied permission hints`, async () => {
    const f = fixture();
    try {
      f.problem();
      f.denied.add(denied);
      await f.next();
      assert.equal(f.retryReads.length, 0);
    } finally {
      f.sql.close();
    }
  });

test("observers can receive independent review but do not get retry-publication work", async () => {
  const f = fixture();
  try {
    f.problem("P-DEMO", true, "observer");
    f.review();
    const result = await f.next();
    assert.equal(result.primaryMove?.move, "review");
    assert.equal(f.retryReads.length, 0);
    assert.equal(result.effectivePermissions?.promote, false);
  } finally {
    f.sql.close();
  }
});

test("grant-wide recorded usage prevents retry selection after another problem spent the budget", async () => {
  const f = fixture();
  try {
    f.problem();
    Object.assign(f.credential, { grantedResources: { eventBudget: 1 } });
    f.sql.exec(
      `INSERT INTO events VALUES('spent','P-OTHER',1,'claim.created','claim','C-1','F-VIEWER','${f.credential.credentialId}')`,
    );
    await f.next();
    assert.equal(f.retryReads.length, 0);
    assert.ok(f.queries.some((query) => query.includes("writer_credential_id = ?")));
  } finally {
    f.sql.close();
  }
});

test("a review-source outage does not erase independently readable retry work", async () => {
  const f = fixture();
  try {
    f.problem();
    f.deps.loadQueue = async () => {
      throw new Error("PRIVATE-DATABASE-DETAIL");
    };
    const result = await f.next();
    assert.equal(result.primaryMove?.move, "retry-dead-end");
    assert.ok(result.degraded);
    assert.equal(result.degradedReason, "MOVES_PARTIAL");
    assert.ok(!JSON.stringify(result).includes("PRIVATE-DATABASE"));
  } finally {
    f.sql.close();
  }
});

test("a retry-source outage leaves existing reviews or first-claim work intact", async () => {
  for (const hasClaims of [true, false]) {
    const f = fixture();
    try {
      f.problem("P-DEMO", hasClaims);
      if (hasClaims) f.review();
      f.deps.retries = {
        async load() {
          throw new Error("source unavailable");
        },
      };
      const result = await f.next();
      assert.equal(result.primaryMove?.move, hasClaims ? "review" : "state-claim");
      assert.ok(result.degraded);
    } finally {
      f.sql.close();
    }
  }
});

test("triage chooses changed conditions before an empty board and keeps per-problem cursors", async () => {
  const f = fixture();
  try {
    f.problem("P-AA", false);
    f.problem("P-BB");
    f.sql.exec("UPDATE problems SET public_seq=30 WHERE id='P-BB'");
    const original = f.deps.retries!.load;
    f.deps.retries = {
      async load(db, p, c, who) {
        if (p === "P-AA") return { move: null, degraded: false };
        return original(db, p, c, who);
      },
    };
    const result = await f.triage(["P-BB", "P-AA"]);
    assert.equal(result.move?.move, "retry-dead-end");
    assert.equal(result.move?.refs[0], "P-BB");
    assert.deepEqual(f.retryReads, [{ problem: "P-BB", cursor: 30, fellow: "F-VIEWER" }]);
  } finally {
    f.sql.close();
  }
});

test("triage retains review priority across problems even when retry completion order differs", async () => {
  const f = fixture();
  try {
    f.problem("P-AA");
    f.problem("P-BB");
    f.review("P-BB");
    const original = f.deps.retries!.load;
    f.deps.retries = {
      async load(db, p, c, who) {
        await new Promise((resolve) => setTimeout(resolve, p === "P-AA" ? 5 : 0));
        return original(db, p, c, who);
      },
    };
    const result = await f.triage(["P-AA", "P-BB"]);
    assert.equal(result.move?.move, "review");
    assert.equal(result.move?.refs[0], "P-BB");
  } finally {
    f.sql.close();
  }
});

test("triage retry scans remain bounded to four assigned problems and two concurrent readers", async () => {
  const f = fixture();
  try {
    const ids = ["P-AA", "P-BB", "P-CC", "P-DD", "P-EE"];
    for (const id of ids) f.problem(id);
    let active = 0,
      max = 0;
    const original = f.deps.retries!.load;
    f.deps.retries = {
      async load(db, p, c, who) {
        active++;
        max = Math.max(max, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        const result = await original(db, p, c, who);
        active--;
        return result;
      },
    };
    const result = await f.triage(ids.reverse());
    assert.equal(f.retryReads.length, 4);
    assert.equal(max, 2);
    assert.ok(result.degraded);
    assert.equal(result.move?.refs[0], "P-AA");
  } finally {
    f.sql.close();
  }
});

test("missing membership, private and terminal problems cannot be used for retry discovery", async () => {
  for (const change of [
    "DELETE FROM problem_memberships",
    "UPDATE problems SET status='private-draft'",
    "UPDATE problems SET unlisted=1",
    "UPDATE problems SET status='retired'",
    "UPDATE problems SET status='resolved'",
  ]) {
    const f = fixture();
    try {
      f.problem();
      f.sql.exec(change);
      const result = await f.next();
      assert.equal(result.primaryMove, null);
      assert.equal(f.retryReads.length, 0);
    } finally {
      f.sql.close();
    }
  }
});

test("mismatched authenticated identity cannot trigger any database or retry-source read", async () => {
  const f = fixture();
  try {
    f.problem();
    const request = { ...f.request(), fellowId: "F-OTHER" };
    const result = await f.provider.nextMoves(request);
    assert.equal(result.primaryMove, null);
    assert.equal(f.queries.length, 0);
    assert.equal(f.retryReads.length, 0);
  } finally {
    f.sql.close();
  }
});
