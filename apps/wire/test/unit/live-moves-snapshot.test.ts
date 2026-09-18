import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { HelloAssignment, MoveTemplate } from "@asimposium/contracts";
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
const template = (move: string) =>
  ({ move, availability: "available", prefilled_hints: {} }) as MoveTemplate;
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
function fixture(options: { wrongCursor?: boolean; firstEmpty?: boolean; deny?: boolean } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE problems(id TEXT, public_seq INTEGER, unlisted INTEGER, status TEXT);
    CREATE TABLE problem_memberships(problem_id TEXT, fellow_id TEXT, role TEXT);
    CREATE TABLE events(id TEXT, problem_id TEXT, seq INTEGER, object_kind TEXT, type TEXT,
      object_id TEXT, actor_fellow_id TEXT, writer_credential_id TEXT);
    CREATE TABLE reviews(problem_id TEXT,review_id TEXT,source_event_id TEXT,source_seq INTEGER,
      reviewer_fellow_id TEXT,target_claim_id TEXT,target_version INTEGER);
    INSERT INTO problems VALUES ('P-DEMO',50,0,'active'),('P-OTHER',90,0,'active');
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
    templateFor: template,
    firstClaimTemplate: () => template("state-claim"),
    authorize: ((input: { effect: string }) => ({
      decision: options.deny || input.effect === "promote" ? "deny" : "allow",
    })) as unknown as LiveMovesDependencies["authorize"],
    async loadQueue(_db, query, snapshot) {
      calls.push({ ...query, snapshot });
      // Simulate a ledger append after membership captured its head.
      sqlite
        .query("UPDATE problems SET public_seq = public_seq + 1 WHERE id = ?")
        .run(query.problem);
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
    next: () =>
      provider.nextMoves({
        problemId: "P-DEMO",
        fellowId: credential.fellowId,
        credential,
        db,
        role: "steward",
        effectivePermissions: { promote: true },
      }),
  };
}

test("production provider sends the captured membership cursor into the canonical queue", async () => {
  const f = fixture();
  try {
    const result = await f.next();
    assert.equal(result.primaryMove?.move, "review");
    assert.deepEqual(f.calls[0]?.snapshot, { problemId: "P-DEMO", through: 50 });
    assert.match(JSON.stringify(result.primaryMove), /through=50/);
    assert.equal(result.effectivePermissions?.promote, false);
    assert.equal(result.degraded, false);
  } finally {
    f.sqlite.close();
  }
});

test("an empty first page does not advance the captured problem cursor", async () => {
  const f = fixture({ firstEmpty: true });
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

test("triage preserves a distinct captured cursor for each assigned problem", async () => {
  const f = fixture();
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

test("unlisted problem membership does not authorize this discovery source", async () => {
  const f = fixture();
  try {
    f.sqlite.query("UPDATE problems SET unlisted=1 WHERE id='P-DEMO'").run();
    const result = await f.next();
    assert.equal(result.primaryMove, null);
    assert.equal(f.calls.length, 0);
  } finally {
    f.sqlite.close();
  }
});
