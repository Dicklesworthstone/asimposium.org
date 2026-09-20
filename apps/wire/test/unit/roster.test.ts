import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createEnrollmentRouter } from "../../src/enrollment/router.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
  InMemoryEnrollmentStore,
} from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { genesisChainDigest } from "../../src/krater/krater.ts";
import {
  computeRoleSuggestion,
  determineJoinRole,
  logRosterDiagnostic,
} from "../../src/problems/roster.ts";
import { createSessionRouter } from "../../src/sessions/router.ts";
import { syntheticScreeningObservation } from "../support/screening.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

class FixedRandom {
  #next = 23;
  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => {
      const value = this.#next;
      this.#next = (this.#next + 1) % 256;
      return value;
    });
  }
}

function localD1(sqlite: Database): Env["DB"] {
  let batchTail: Promise<unknown> = Promise.resolve();
  const prepare = (query: string) => {
    const methods = (...values: unknown[]) => ({
      async run() {
        const statement = sqlite.prepare(query);
        if (/^\s*SELECT\b/i.test(query)) {
          const rows = statement.all(...(values as any[]));
          return { results: rows, meta: { changes: 0, rows_read: rows.length, rows_written: 0 } };
        }
        const result = statement.run(...(values as any[]));
        return {
          results: [],
          meta: { changes: result.changes, rows_read: 0, rows_written: result.changes },
        };
      },
      async first<T>(): Promise<T | null> {
        const row = (sqlite.prepare(query) as any).get(...(values as any[]));
        return (row ?? null) as T | null;
      },
      async all<T>(): Promise<{ results: T[]; meta: { rows_read: number; rows_written: number } }> {
        const rows = (sqlite.prepare(query) as any).all(...(values as any[]));
        return { results: rows as T[], meta: { rows_read: rows.length, rows_written: 0 } };
      },
    });
    return {
      bind: (...values: unknown[]) => methods(...values),
      run: () => methods().run(),
      first: <T>() => methods().first<T>(),
      all: <T>() => methods().all<T>(),
    };
  };

  const runBatch = async (
    statements: readonly {
      run(): Promise<{ results?: readonly unknown[]; meta: { changes: number } }>;
    }[],
  ) => {
    const result = batchTail.then(async () => {
      sqlite.run("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.run("COMMIT");
        return results;
      } catch (error) {
        sqlite.run("ROLLBACK");
        throw error;
      }
    });
    batchTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    prepare,
    batch(
      statements: readonly {
        run(): Promise<{ results?: readonly unknown[]; meta: { changes: number } }>;
      }[],
    ) {
      return runBatch(statements);
    },
  } as unknown as Env["DB"];
}

function migratedDb(): Env["DB"] {
  const sqlite = new Database(":memory:", { strict: true });
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.run(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return localD1(sqlite);
}

describe("W9.5 Writer slots + roster unit tests (asimposiumorg-1ar)", () => {
  describe("Pure role suggestions matrix (computeRoleSuggestion)", () => {
    test("suggests 'worker' for headcount <= 1", () => {
      expect(
        computeRoleSuggestion({ headcount: 0, unreviewedClaimsCount: 0, writerCap: 8 }),
      ).toEqual({
        suggested_role: "worker",
        reason: "First contributor: sharpen statement, promote first claim or falsifier.",
      });
      expect(
        computeRoleSuggestion({ headcount: 1, unreviewedClaimsCount: 2, writerCap: 8 }),
      ).toEqual({
        suggested_role: "worker",
        reason: "First contributor: sharpen statement, promote first claim or falsifier.",
      });
    });

    test("suggests 'critic' for 2nd arrival when unreviewed claims exist", () => {
      const res = computeRoleSuggestion({ headcount: 2, unreviewedClaimsCount: 1, writerCap: 8 });
      expect(res.suggested_role).toBe("critic");
      expect(res.reason).toContain("unreviewed claims exist");
    });

    test("suggests 'worker' for 2nd arrival when no unreviewed claims exist", () => {
      const res = computeRoleSuggestion({ headcount: 2, unreviewedClaimsCount: 0, writerCap: 8 });
      expect(res.suggested_role).toBe("worker");
      expect(res.reason).toContain("no unreviewed claims");
    });

    test("suggests 'investigator' for 3rd arrival", () => {
      const res = computeRoleSuggestion({ headcount: 3, unreviewedClaimsCount: 0, writerCap: 8 });
      expect(res.suggested_role).toBe("investigator");
      expect(res.reason).toContain("investigate alternative hypotheses");
    });

    test("suggests 'critic' for 4th arrival if unreviewed claims exist, else 'investigator'", () => {
      const criticRes = computeRoleSuggestion({
        headcount: 4,
        unreviewedClaimsCount: 3,
        writerCap: 8,
      });
      expect(criticRes.suggested_role).toBe("critic");

      const invRes = computeRoleSuggestion({
        headcount: 4,
        unreviewedClaimsCount: 0,
        writerCap: 8,
      });
      expect(invRes.suggested_role).toBe("investigator");
    });

    test("suggests 'synthesizer' for 5th arrival", () => {
      const res = computeRoleSuggestion({ headcount: 5, unreviewedClaimsCount: 2, writerCap: 8 });
      expect(res.suggested_role).toBe("synthesizer");
      expect(res.reason).toContain("close statement drift");
    });

    test("suggests 'critic' or 'investigator' for headcount >= 6 under cap", () => {
      const withUnreviewed = computeRoleSuggestion({
        headcount: 6,
        unreviewedClaimsCount: 2,
        writerCap: 8,
      });
      expect(withUnreviewed.suggested_role).toBe("critic");

      const withoutUnreviewed = computeRoleSuggestion({
        headcount: 7,
        unreviewedClaimsCount: 0,
        writerCap: 8,
      });
      expect(withoutUnreviewed.suggested_role).toBe("investigator");
    });

    test("suggests 'observer' when headcount reaches or exceeds writer cap for caps 8 through 16", () => {
      for (let cap = 8; cap <= 16; cap++) {
        const atCap = computeRoleSuggestion({
          headcount: cap,
          unreviewedClaimsCount: 0,
          writerCap: cap,
        });
        expect(atCap.suggested_role).toBe("observer");
        expect(atCap.reason).toContain(`Writer slots are full (${cap}/${cap})`);

        const overCap = computeRoleSuggestion({
          headcount: cap + 2,
          unreviewedClaimsCount: 3,
          writerCap: cap,
        });
        expect(overCap.suggested_role).toBe("observer");
        expect(overCap.reason).toContain(`Writer slots are full (${cap + 2}/${cap})`);
      }
    });

    test("uncapped problem (writerCap: null) never suggests 'observer'", () => {
      for (let headcount = 1; headcount <= 25; headcount++) {
        const res = computeRoleSuggestion({ headcount, unreviewedClaimsCount: 1, writerCap: null });
        expect(res.suggested_role).not.toBe("observer");
      }
    });
  });

  describe("Pure join role determination (determineJoinRole)", () => {
    test("determines 'contributor' vs 'observer' across caps 8 through 16", () => {
      for (let cap = 8; cap <= 16; cap++) {
        // Under cap
        for (let count = 0; count < cap; count++) {
          expect(determineJoinRole(count, cap)).toBe("contributor");
        }
        // At cap
        expect(determineJoinRole(cap, cap)).toBe("observer");
        // Beyond cap
        expect(determineJoinRole(cap + 1, cap)).toBe("observer");
        expect(determineJoinRole(cap + 10, cap)).toBe("observer");
      }
    });

    test("uncapped problem (writerCap: null) always admits as contributor", () => {
      const testCounts = [0, 1, 7, 8, 9, 15, 16, 17, 50, 100, 1000];
      for (const count of testCounts) {
        expect(determineJoinRole(count, null)).toBe("contributor");
      }
    });
  });

  describe("OPS.2a structured diagnostic logger (logRosterDiagnostic)", () => {
    test("emits well-formed JSON conforming to OPS.2a and contains zero secret leakage", () => {
      const logs: string[] = [];
      const originalInfo = console.info;
      console.info = (msg: string) => {
        logs.push(msg);
      };

      try {
        logRosterDiagnostic({
          problemId: "P-TEST-ROSTER",
          rosterVersion: "2026-09-20T16:00:00.000Z",
          requestedRole: "contributor",
          effectiveRole: "observer",
          cap: 8,
          aggregateCounts: { contributors: 8, observers: 2 },
          decisionCode: "ROSTER_OVERFLOW_OBSERVER",
          requestId: "req-12345",
          timingMs: 4.2,
        });

        expect(logs.length).toBe(1);
        const log0 = logs[0];
        expect(log0).toBeDefined();
        if (!log0) throw new Error("logs[0] undefined");
        const parsed = JSON.parse(log0);
        expect(parsed.facility).toBe("OPS.2a");
        expect(parsed.stage).toBe("problem-roster");
        expect(parsed.problem_id).toBe("P-TEST-ROSTER");
        expect(parsed.effective_role).toBe("observer");
        expect(parsed.cap).toBe(8);
        expect(parsed.aggregate_counts).toEqual({ contributors: 8, observers: 2 });
        expect(parsed.decision_code).toBe("ROSTER_OVERFLOW_OBSERVER");
        expect(parsed.request_id).toBe("req-12345");
        expect(parsed.timing_ms).toBe(4.2);

        // Negative check: ensure no sensitive keys exist
        expect(logs[0]).not.toContain("token");
        expect(logs[0]).not.toContain("bearer");
        expect(logs[0]).not.toContain("secret");
        expect(logs[0]).not.toContain("body");
      } finally {
        console.info = originalInfo;
      }
    });
  });

  describe("Real D1 database integration: 8 default cap, observer overflow, permissions & slot release", () => {
    async function setupHarness(writerCap: number | null = 8) {
      const random = new FixedRandom();
      const replayProtector = new AesGcmEnrollmentReplayProtector(
        Uint8Array.from({ length: 32 }, (_v, i) => i),
        random,
      );
      const enrollmentStore = new InMemoryEnrollmentStore();
      const service = new EnrollmentService({
        stoaOrigin: "https://a-staging.asimposium.org",
        agoraOrigin: "https://staging.asimposium.org",
        store: enrollmentStore,
        replayProtector,
      });
      const enrollmentRouter = createEnrollmentRouter({ service });
      const sessionRouter = createSessionRouter({
        service,
        replayProtector,
        screenPromotion: async (input) => {
          return syntheticScreeningObservation(input, {
            decision: "pass",
            coarse_category: "benign-context",
            provider_status: "ok",
          });
        },
      });
      const db = migratedDb();
      const sponsor = { type: "sponsor", sponsorId: "usr_rostersponsor" } as const;

      const now = new Date().toISOString();
      const problemId = "P-ROSTER";
      const genesis = await genesisChainDigest(problemId);

      await db
        .prepare(
          `INSERT INTO problems (id, sponsor_id, public_seq, created_at, updated_at, chain_digest, chain_version, writer_cap, status)
           VALUES (?, ?, 0, ?, ?, ?, 2, ?, 'active')`,
        )
        .bind(problemId, sponsor.sponsorId, now, now, genesis, writerCap)
        .run();

      await db
        .prepare(
          "INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version) VALUES (?, 'complete', 0, ?, 2)",
        )
        .bind(problemId, now)
        .run();

      const enrollFellow = async (name: string, model = "test-model") => {
        const fellowSponsor = { type: "sponsor", sponsorId: `usr_sponsor_${name}` } as const;
        const minted = await service.mint(fellowSponsor, {
          requested_scopes: ["promote", "review"],
          problem_binding: problemId,
        });
        const registration = await enrollmentRouter.fetch(
          new Request("https://a-staging.asimposium.org/v1/fellows", {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": `mint-${name}` },
            body: JSON.stringify({
              enrollment_id: minted.enrollmentId,
              secret: minted.secret,
              name,
              model,
              harness: "test-harness",
            }),
          }),
        );
        const { flow_handle: flowHandle } = (await registration.json()) as { flow_handle: string };
        await service.decide(fellowSponsor, minted.enrollmentId, {
          enrollment_id: minted.enrollmentId,
          decision: "approve",
          step_up_authenticated_at: Math.floor(Date.now() / 1_000),
        });
        const issued = await enrollmentRouter.fetch(
          new Request("https://a-staging.asimposium.org/v1/device-token", {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": `token-${name}` },
            body: JSON.stringify({ flow_handle: flowHandle }),
          }),
        );
        const { token } = (await issued.json()) as { token: string };
        const binding = await service.credentialBinding(token);
        if (!binding) throw new Error(`binding missing for ${name}`);

        const createdAt = Math.max(1, binding.issuedAt - 1);
        const proposalId = `prop-${binding.fellowId}`;
        const grantedScopesJson = JSON.stringify(binding.grantedScopes);
        const grantedResourcesJson = JSON.stringify(binding.grantedResources);

        await db
          .prepare(
            `INSERT INTO sponsors (sponsor_id, created_at, last_seen_at)
             SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM sponsors WHERE sponsor_id = ?)`,
          )
          .bind(binding.sponsorId, createdAt, createdAt, binding.sponsorId)
          .run();

        await db
          .prepare(
            `INSERT INTO enrollment_records (enrollment_id, sponsor_id, secret_hash, secret_expires_at, requested_scopes_json, requested_resources_json, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM enrollment_records WHERE enrollment_id = ?)`,
          )
          .bind(
            minted.enrollmentId,
            binding.sponsorId,
            binding.tokenHash,
            createdAt + 1,
            grantedScopesJson,
            grantedResourcesJson,
            createdAt,
            minted.enrollmentId,
          )
          .run();

        await db
          .prepare(
            `INSERT INTO enrollment_proposals (proposal_id, enrollment_id, fellow_id, flow_handle_hash, name, model, harness, created_at, expires_at, status, poll_interval_seconds)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 5 WHERE NOT EXISTS (SELECT 1 FROM enrollment_proposals WHERE proposal_id = ?)`,
          )
          .bind(
            proposalId,
            minted.enrollmentId,
            binding.fellowId,
            `hash-${name}`,
            binding.name,
            binding.model,
            binding.harness,
            createdAt,
            createdAt + 86_400_000,
            proposalId,
          )
          .run();

        await db
          .prepare(
            `UPDATE enrollment_proposals SET status = 'approved', granted_scopes_json = ?, granted_resources_json = ?
             WHERE proposal_id = ? AND status = 'pending'`,
          )
          .bind(grantedScopesJson, grantedResourcesJson, proposalId)
          .run();

        await db
          .prepare(
            `INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at)
             SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM enrollment_fellows WHERE fellow_id = ?)`,
          )
          .bind(
            binding.fellowId,
            binding.sponsorId,
            binding.name,
            binding.model,
            binding.harness,
            createdAt,
            binding.fellowId,
          )
          .run();

        await db
          .prepare(
            `INSERT INTO enrollment_grants (proposal_id, fellow_id, sponsor_id, granted_scopes_json, granted_resources_json, granted_at)
             SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM enrollment_grants WHERE fellow_id = ?)`,
          )
          .bind(
            proposalId,
            binding.fellowId,
            binding.sponsorId,
            grantedScopesJson,
            grantedResourcesJson,
            binding.issuedAt,
            binding.fellowId,
          )
          .run();

        await db
          .prepare(
            `INSERT INTO fellow_tokens (credential_id, proposal_id, fellow_id, sponsor_id, token_hash, granted_scopes_json, granted_resources_json, issued_at, expires_at, credential_origin)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'harness-migration')`,
          )
          .bind(
            binding.credentialId,
            binding.fellowId,
            binding.sponsorId,
            binding.tokenHash,
            grantedScopesJson,
            grantedResourcesJson,
            binding.issuedAt,
            binding.expiresAt,
          )
          .run();

        return { token, binding };
      };

      const env = { DB: db } as unknown as Env;

      const call = (token: string, path: string, init: RequestInit = {}) =>
        sessionRouter.fetch(
          new Request(`https://a-staging.asimposium.org${path}`, {
            ...init,
            headers: {
              authorization: `Bearer ${token}`,
              "idempotency-key": crypto.randomUUID(),
              ...(init.headers ?? {}),
            },
          }),
          env,
        );

      return { db, sponsor, enrollFellow, call, problemId };
    }

    test("first 8 joiners become contributors, 9th joiner becomes observer", async () => {
      const h = await setupHarness(8);

      const fellows = [];
      for (let i = 1; i <= 9; i++) {
        fellows.push(await h.enrollFellow(`fellow-${i}`));
      }

      // First 8 fellows open sessions
      for (let i = 0; i < 8; i++) {
        const fi = fellows[i];
        expect(fi).toBeDefined();
        if (!fi) throw new Error(`fellows[${i}] undefined`);
        const res = await h.call(fi.token, "/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ problem_id: h.problemId, intent: "explore" }),
        });
        expect(res.status).toBe(201);
      }

      // Check problem_memberships in DB: exactly 8 contributors
      const countRes = await h.db
        .prepare(
          "SELECT COUNT(*) as c FROM problem_memberships WHERE problem_id = ? AND role = 'contributor'",
        )
        .bind(h.problemId)
        .first<{ c: number }>();
      expect(countRes?.c).toBe(8);

      // 9th fellow opens session
      const fellow9 = fellows[8];
      expect(fellow9).toBeDefined();
      if (!fellow9) throw new Error("fellow9 undefined");

      const res9 = await h.call(fellow9.token, "/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ problem_id: h.problemId, intent: "explore" }),
      });
      expect(res9.status).toBe(201);

      // 9th fellow should be an observer!
      const member9 = await h.db
        .prepare("SELECT role FROM problem_memberships WHERE problem_id = ? AND fellow_id = ?")
        .bind(h.problemId, fellow9.binding.fellowId)
        .first<{ role: string }>();
      expect(member9?.role).toBe("observer");
    });

    test("observer capability matrix: can workshop, review, dead-end, evidence; CANNOT promote claims", async () => {
      const h = await setupHarness(8);

      // Enroll fellow 1 (contributor) and fellow 2 (overflow -> observer by seeding 8 contributors first)
      const contributorFellow = await h.enrollFellow("contributor-f1");
      const contributorOpen = await h.call(contributorFellow.token, "/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ problem_id: h.problemId, intent: "explore" }),
      });
      expect(contributorOpen.status).toBe(201);
      const contributorSession = (await contributorOpen.json()) as { session_id: string };

      // Contributor promotes a claim so there is an object to review
      const draftRes = await h.call(
        contributorFellow.token,
        `/v1/sessions/${contributorSession.session_id}/workshop`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "claim-draft",
            title: "Even Numbers",
            body_md: "Two is an even prime integer.",
            relates_to: [],
          }),
        },
      );
      expect(draftRes.status).toBe(201);
      const draft = (await draftRes.json()) as { workshop_id: string };

      const promoteRes = await h.call(
        contributorFellow.token,
        `/v1/sessions/${contributorSession.session_id}/promote`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workshop_id: draft.workshop_id,
            kind: "conjecture",
            statement: "Two is an even prime integer.",
            falsifier: "Finding an odd factor of two.",
            relates_to: [],
          }),
        },
      );
      expect(promoteRes.status).toBe(201);
      const claim = (await promoteRes.json()) as { claim_id: string };

      // Fill remaining 7 contributor slots (total 8)
      for (let i = 2; i <= 8; i++) {
        const dummy = await h.enrollFellow(`filler-${i}`);
        await h.call(dummy.token, "/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ problem_id: h.problemId, intent: "explore" }),
        });
      }

      // Now enroll Observer Fellow
      const observerFellow = await h.enrollFellow("observer-f9", "observer-model");
      const observerOpen = await h.call(observerFellow.token, "/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ problem_id: h.problemId, intent: "explore" }),
      });
      expect(observerOpen.status).toBe(201);
      const observerSession = (await observerOpen.json()) as { session_id: string };

      // 1. Observer CAN push to workshop
      const obsWorkshop = await h.call(
        observerFellow.token,
        `/v1/sessions/${observerSession.session_id}/workshop`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "claim-draft",
            title: "Observer Draft",
            body_md: "Scratch notes in private workshop.",
            relates_to: [],
          }),
        },
      );
      expect(obsWorkshop.status).toBe(201);
      const obsDraft = (await obsWorkshop.json()) as { workshop_id: string };

      // 2. Observer CANNOT promote claim -> ROSTER_FULL
      const obsPromote = await h.call(
        observerFellow.token,
        `/v1/sessions/${observerSession.session_id}/promote`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workshop_id: obsDraft.workshop_id,
            kind: "conjecture",
            statement: "Three is odd.",
            falsifier: "Finding an even factor of three.",
            relates_to: [],
          }),
        },
      );
      expect(obsPromote.status).toBe(422);
      const obsPromoteErr = (await obsPromote.json()) as {
        code: string;
        rule: string;
        fix_hint: string;
      };
      expect(obsPromoteErr.code).toBe("ROSTER_FULL");
      expect(obsPromoteErr.rule).toBe("A5");
      expect(obsPromoteErr.fix_hint).toContain("review");

      // 3. Observer CANNOT directly post claim -> ROSTER_FULL
      const obsDirectClaim = await h.call(observerFellow.token, `/v1/p/${h.problemId}/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "conjecture",
          statement: "Three is odd.",
          falsifier: "Finding an even factor of three.",
          relates_to: [],
        }),
      });
      expect(obsDirectClaim.status).toBe(422);
      const obsDirectErr = (await obsDirectClaim.json()) as { code: string };
      expect(obsDirectErr.code).toBe("ROSTER_FULL");

      // 4. Observer CAN post a dead end
      const obsDeadEnd = await h.call(
        observerFellow.token,
        `/v1/sessions/${observerSession.session_id}/dead-ends`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            approach: "Exhaustive search of 2-adic valuations across modular branching classes.",
            why_it_fails:
              "Valuation accumulation diverges exponentially along odd multipliers beyond depth sixteen.",
            retry_predicate:
              "Worth retrying if an analytic non-archimedean bound constrains the branch width.",
          }),
        },
      );
      expect(obsDeadEnd.status).toBe(201);

      // 5. Observer CAN post evidence
      const obsEvidence = await h.call(
        observerFellow.token,
        `/v1/sessions/${observerSession.session_id}/evidence`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bears_on_kind: "claim",
            bears_on_id: claim.claim_id,
            bears_on_version: 1,
            direction: "supports",
            kind: "argument",
            source: { kind: "model_memory" },
            mode: "confirmatory",
            body_md: "A step changes parity in this synthetic example.",
          }),
        },
      );
      expect(obsEvidence.status).toBe(201);

      // 6. Observer CAN review contributor's claim
      const obsReview = await h.call(
        observerFellow.token,
        `/v1/sessions/${observerSession.session_id}/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            target_claim_id: claim.claim_id,
            target_version: 1,
            verdict: "confirm",
            basis: "Checked line-by-line against axioms.",
            capable_of_failure: "Any counterexample satisfying the premise.",
            rubric: ["soundness-of-inference"],
            body_md: "All steps verified successfully.",
          }),
        },
      );
      expect(obsReview.status).toBe(201);

      // 7. Contributor CANNOT review their own claim -> REVIEWER_IS_AUTHOR
      const selfReview = await h.call(
        contributorFellow.token,
        `/v1/sessions/${contributorSession.session_id}/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            target_claim_id: claim.claim_id,
            target_version: 1,
            verdict: "confirm",
            basis: "I wrote it and I like it.",
            capable_of_failure: "None.",
            rubric: ["soundness-of-inference"],
            body_md: "Self review.",
          }),
        },
      );
      expect(selfReview.status).toBe(422);
      const selfReviewErr = (await selfReview.json()) as { code: string };
      expect(selfReviewErr.code).toBe("REVIEWER_IS_AUTHOR");
    });

    test("slot release: removing contributor or changing role opens slot for observer", async () => {
      const h = await setupHarness(8);

      const contributors = [];
      for (let i = 1; i <= 8; i++) {
        const f = await h.enrollFellow(`c-${i}`);
        contributors.push(f);
        await h.call(f.token, "/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ problem_id: h.problemId, intent: "explore" }),
        });
      }

      // Observer joins
      const observer = await h.enrollFellow("overflow-observer");
      await h.call(observer.token, "/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ problem_id: h.problemId, intent: "explore" }),
      });

      // Confirm observer role
      const memberBefore = await h.db
        .prepare("SELECT role FROM problem_memberships WHERE problem_id = ? AND fellow_id = ?")
        .bind(h.problemId, observer.binding.fellowId)
        .first<{ role: string }>();
      expect(memberBefore?.role).toBe("observer");

      // Sponsor demotes contributor 8 to observer
      const contributor8 = contributors[7];
      expect(contributor8).toBeDefined();
      if (!contributor8) throw new Error("contributor8 undefined");

      await h.db
        .prepare(
          "UPDATE problem_memberships SET role = 'observer' WHERE problem_id = ? AND fellow_id = ?",
        )
        .bind(h.problemId, contributor8.binding.fellowId)
        .run();

      // Check contributors count is now 7
      const countAfter = await h.db
        .prepare(
          "SELECT COUNT(*) as c FROM problem_memberships WHERE problem_id = ? AND role = 'contributor'",
        )
        .bind(h.problemId)
        .first<{ c: number }>();
      expect(countAfter?.c).toBe(7);

      // Sponsor explicitly promotes observer to contributor (or slot is claimed)
      await h.db
        .prepare(
          "UPDATE problem_memberships SET role = 'contributor' WHERE problem_id = ? AND fellow_id = ?",
        )
        .bind(h.problemId, observer.binding.fellowId)
        .run();

      const memberAfter = await h.db
        .prepare("SELECT role FROM problem_memberships WHERE problem_id = ? AND fellow_id = ?")
        .bind(h.problemId, observer.binding.fellowId)
        .first<{ role: string }>();
      expect(memberAfter?.role).toBe("contributor");
    });

    test("uncapped problem: all arrivals receive contributor role and can promote claims", async () => {
      const h = await setupHarness(null); // writer_cap = null

      const fellows = [];
      const sessions = [];
      for (let i = 1; i <= 10; i++) {
        const f = await h.enrollFellow(`uncapped-${i}`);
        fellows.push(f);
        const openRes = await h.call(f.token, "/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ problem_id: h.problemId, intent: "explore" }),
        });
        expect(openRes.status).toBe(201);
        sessions.push((await openRes.json()) as { session_id: string });
      }

      // Verify all 10 in problem_memberships are 'contributor'
      const rows = await h.db
        .prepare("SELECT role FROM problem_memberships WHERE problem_id = ?")
        .bind(h.problemId)
        .all<{ role: string }>();
      expect(rows.results.length).toBe(10);
      expect(rows.results.every((r) => r.role === "contributor")).toBe(true);

      // Fellow 10 can promote a claim without ROSTER_FULL
      const s10 = sessions[9];
      const f10 = fellows[9];
      expect(s10).toBeDefined();
      expect(f10).toBeDefined();
      if (!s10 || !f10) throw new Error("s10 or f10 undefined");

      const draft10 = await h.call(f10.token, `/v1/sessions/${s10.session_id}/workshop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "claim-draft",
          title: "Uncapped Claim",
          body_md: "Body in uncapped problem.",
          relates_to: [],
        }),
      });
      const draft = (await draft10.json()) as { workshop_id: string };

      const promote10 = await h.call(f10.token, `/v1/sessions/${s10.session_id}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workshop_id: draft.workshop_id,
          kind: "conjecture",
          statement: "Uncapped problem allows writes beyond 8.",
          falsifier: "Any cap error.",
          relates_to: [],
        }),
      });
      expect(promote10.status).toBe(201);
    });

    test("concurrent joins cannot oversubscribe writer slots (D1 atomicity)", async () => {
      const h = await setupHarness(8);

      const count = 16;
      const fellows = [];
      for (let i = 1; i <= count; i++) {
        fellows.push(await h.enrollFellow(`concurrent-${i}`));
      }

      // Simultaneously open sessions with Promise.all
      const responses = await Promise.all(
        fellows.map((f) =>
          h.call(f.token, "/v1/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ problem_id: h.problemId, intent: "explore" }),
          }),
        ),
      );

      // All 16 session opens should succeed (201)
      for (const res of responses) {
        expect(res.status).toBe(201);
      }

      // Check problem_memberships in DB: EXACTLY 8 contributors and 8 observers
      const counts = await h.db
        .prepare(
          `SELECT
             COUNT(CASE WHEN role = 'contributor' THEN 1 END) as contributors,
             COUNT(CASE WHEN role = 'observer' THEN 1 END) as observers
           FROM problem_memberships WHERE problem_id = ?`,
        )
        .bind(h.problemId)
        .first<{ contributors: number; observers: number }>();

      expect(counts?.contributors).toBe(8);
      expect(counts?.observers).toBe(8);
    });
  });
});
