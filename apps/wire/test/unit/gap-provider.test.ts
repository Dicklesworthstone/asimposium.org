import { test } from "bun:test";
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import type { MoveTemplate, NextMoveCandidate } from "@asimposium/contracts";
import type { ReviewQueueResponse } from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import type { FellowCredentialBinding } from "../../src/enrollment/service.ts";
import { LedgerMovesProvider, type LiveMovesDependencies } from "../../src/mega-commands/live-provider.ts";

const NOW = Date.parse("2026-09-03T00:00:00.000Z");
const actor = { fellowId: "F-reader", sponsorId: "usr-reader", credentialId: "CR-reader",
  fellowStatus: "active", grantedResources: {} } as FellowCredentialBinding;
function move(problem: string): NextMoveCandidate {
  return { move: "close-gap", refs: [problem, "G-2", "C-1@1"], why: "A recorded unowned obligation.",
    contract: { captured_cursor: 12 }, selection_boundary: "explicit-gap-fixture" };
}
function template(kind: "review" | "add-refuter" | "state-claim"): MoveTemplate {
  return { move: kind, availability: "available", title: kind, trigger: "recorded need", description: "Investigate recorded work.",
    request: { method: "POST", path: "/v1/sessions/{id}/review", auth: "fellow-bearer", idempotency_key_required: true },
    target_contract: "/schemas/sessions.v1.json#/properties/review_request", required_fields: ["target_claim_id"], prefilled_hints: {} };
}
function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE problems(id TEXT,public_seq INTEGER,status TEXT,unlisted INTEGER);
    CREATE TABLE problem_memberships(problem_id TEXT,fellow_id TEXT,role TEXT);
    CREATE TABLE events(problem_id TEXT,seq INTEGER,object_kind TEXT,type TEXT,writer_credential_id TEXT);
    CREATE TABLE reviews(source_event_id TEXT,problem_id TEXT,review_id TEXT,source_seq INTEGER,target_claim_id TEXT,target_version INTEGER,reviewer_fellow_id TEXT);
    INSERT INTO problems VALUES('P-DEMO',12,'active',0);
    INSERT INTO problem_memberships VALUES('P-DEMO','F-reader','contributor');
    INSERT INTO events VALUES('P-DEMO',1,'claim','claim.created','CR-author');`);
  let prepares = 0;
  const db = { prepare(text: string) { prepares++; return { bind(...args: (string | number)[]) {
    return { async first() { return sqlite.query(text).get(...args) ?? null; },
      async all() {
        // No reviews exist in this fixture. Other suites execute the actual
        // history joins against full attributed tables; this tests composition.
        if (text.includes("SELECT DISTINCT r.target_claim_id")) return { results: [] };
        return { results: sqlite.query(text).all(...args) };
      } };
  } }; } } as unknown as D1Database;
  const calls: { problem: string; cursor: number; now: number }[] = [];
  const authCalls: unknown[] = [];
  let review = false, queueFails = false, gapFails = false, deny = false;
  const dependencies: LiveMovesDependencies = {
    now: () => NOW,
    // Explicit policy-decision fixture, not a replacement for canonical auth.
    // Assertions below prove the provider supplies current role and usage.
    authorize: ((input: any) => {
      authCalls.push(input);
      const blocked = deny || input.credential.fellowStatus !== "active" ||
        (input.effect === "promote" && input.target.membershipRole === "observer") ||
        (input.credential.grantedResources.eventBudget !== undefined &&
          input.usage.eventsRecorded >= input.credential.grantedResources.eventBudget);
      return { decision: blocked ? "deny" : "allow" };
    }) as LiveMovesDependencies["authorize"],
    firstClaimTemplate: () => template("state-claim"), templateFor: template,
    loadQueue: async (_db, query, snapshot) => {
      if (queueFails) throw new Error("source-private-details");
      return { problem: query.problem, candidates: review ? [{ problem_id: query.problem, claim_id: "C-9", version: 1,
        cursor: snapshot!.through, need: "independent-review", author_fellow_id: "F-author", author_sponsor_id: "usr-author",
        direct_dependents: 0, created_at: "2026-09-01T00:00:00.000Z" }] : [], next_after: null, omitted: [] } as unknown as ReviewQueueResponse;
    },
    gaps: { load: async (_db, problem, cursor, now) => {
      calls.push({ problem, cursor, now }); if (gapFails) throw new Error("gap-private-details");
      return { move: move(problem), degraded: false };
    } },
  };
  const provider = new LedgerMovesProvider(dependencies);
  const request = (credential = actor) => ({ db, credential, fellowId: actor.fellowId, problemId: "P-DEMO", role: "steward" as const,
    effectivePermissions: { promote: true, review: true, session_open: true } });
  return { sqlite, db, provider, dependencies, calls, authCalls, request, prepares: () => prepares,
    set(patch: { review?: boolean; queueFails?: boolean; gapFails?: boolean; deny?: boolean }) {
      review = patch.review ?? review; queueFails = patch.queueFails ?? queueFails;
      gapFails = patch.gapFails ?? gapFails; deny = patch.deny ?? deny;
    }, close() { sqlite.close(); } };
}

test("production provider passes its current membership snapshot and clock into gap selection", async () => {
  const f = fixture(); try { const result = await f.provider.nextMoves(f.request());
    assert.equal(result.primaryMove?.move, "close-gap"); assert.equal(result.degraded, false);
    assert.deepEqual(f.calls, [{ problem: "P-DEMO", cursor: 12, now: NOW }]);
    assert.match(result.selectionBoundary ?? "", /close-gap/);
  } finally { f.close(); }
});
test("caller permission hints do not make an observer eligible for gap work", async () => {
  const f = fixture(); try { f.sqlite.exec("UPDATE problem_memberships SET role='observer'");
    const result = await f.provider.nextMoves(f.request());
    assert.equal(result.primaryMove, null); assert.equal(result.effectivePermissions?.promote, false); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
test("preflight denial suppresses all gap and membership discovery", async () => {
  const f = fixture(); try { f.set({ deny: true });
    assert.equal((await f.provider.nextMoves(f.request())).primaryMove, null);
    assert.equal(f.prepares(), 0); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
test("removal from the durable roster overrides a caller's steward hint", async () => {
  const f = fixture(); try { f.sqlite.exec("DELETE FROM problem_memberships");
    assert.equal((await f.provider.nextMoves(f.request())).primaryMove, null); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
test("credential-wide usage is supplied before authorizing gap work", async () => {
  const f = fixture(); try { f.sqlite.exec("INSERT INTO events VALUES('P-OTHER',1,'claim','claim.created','CR-reader')");
    const result = await f.provider.nextMoves(f.request({ ...actor, grantedResources: { eventBudget: 1 } }));
    assert.equal(result.primaryMove, null); assert.equal(f.calls.length, 0);
    assert.ok(f.authCalls.some((value: any) => value.effect === "promote" && value.usage.eventsRecorded === 1));
  } finally { f.close(); }
});
test("existing review work remains primary with an unowned gap as an alternative", async () => {
  const f = fixture(); try { f.set({ review: true }); const result = await f.provider.nextMoves(f.request());
    assert.equal(result.primaryMove?.move, "review"); assert.equal(result.alternatives[0]?.move, "close-gap");
  } finally { f.close(); }
});
test("review source outage does not erase independently readable gap work", async () => {
  const f = fixture(); try { f.set({ queueFails: true }); const result = await f.provider.nextMoves(f.request());
    assert.equal(result.primaryMove?.move, "close-gap"); assert.equal(result.degraded, true);
    assert.doesNotMatch(JSON.stringify(result), /source-private-details/);
  } finally { f.close(); }
});
test("gap source outage preserves independent review work", async () => {
  const f = fixture(); try { f.set({ review: true, gapFails: true }); const result = await f.provider.nextMoves(f.request());
    assert.equal(result.primaryMove?.move, "review"); assert.equal(result.degraded, true);
    assert.doesNotMatch(JSON.stringify(result), /gap-private-details/);
  } finally { f.close(); }
});
test("a board without any published claim never invents a claim-bound gap", async () => {
  const f = fixture(); try { f.sqlite.exec("DELETE FROM events");
    assert.equal((await f.provider.nextMoves(f.request())).primaryMove?.move, "state-claim");
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
test("triage chooses gap work ahead of empty boards and bounds per-problem concurrency", async () => {
  const f = fixture(); try {
    f.sqlite.exec("DELETE FROM problems; DELETE FROM problem_memberships; DELETE FROM events");
    const ids = ["P-AA", "P-BB", "P-CC", "P-DD", "P-EE"];
    for (const id of ids) {
      f.sqlite.query("INSERT INTO problems VALUES(?,12,'active',0)").run(id);
      f.sqlite.query("INSERT INTO problem_memberships VALUES(?,'F-reader','contributor')").run(id);
      if (id !== "P-AA") f.sqlite.query("INSERT INTO events VALUES(?,1,'claim','claim.created','CR-author')").run(id);
    }
    let active = 0, peak = 0;
    f.dependencies.gaps!.load = async (_db, problem, cursor, now) => {
      f.calls.push({ problem, cursor, now }); active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      return { move: move(problem), degraded: false };
    };
    const triage = await f.provider.triageMove({ db: f.db, credential: actor, fellowId: actor.fellowId,
      assignments: ids.reverse().map(problem_id => ({ problem_id })) as any });
    assert.equal(triage.move?.move, "close-gap"); assert.equal(triage.move?.refs[0], "P-BB");
    assert.equal(triage.degraded, true); assert.ok(peak <= 2);
    assert.deepEqual(f.calls.map(call => call.problem).sort(), ["P-BB", "P-CC", "P-DD"]);
  } finally { f.close(); }
});
