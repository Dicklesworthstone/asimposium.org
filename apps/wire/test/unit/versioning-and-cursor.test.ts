import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { InboxResponse } from "@asimposium/contracts";

import { createApp } from "../../src/app.ts";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
} from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { notifyProblemFollowersOfStatementRevision } from "../../src/inbox/store.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

interface ProblemPayload {
  readonly code: string;
  readonly rule?: string;
  readonly supported_versions?: readonly string[];
  readonly requested_version?: string;
  readonly fix_hint?: string;
  readonly delta_pointer?: string;
  readonly revised_at_cursor?: number;
  readonly statement_version?: number;
}

class FixedRandom {
  #next = 31;

  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => {
      const value = this.#next;
      this.#next = (this.#next + 1) % 256;
      return value;
    });
  }
}

type LocalBinding = string | number | null;

function migratedDb(): Env["DB"] {
  const sqlite = new Database(":memory:", { strict: true });
  const files = readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith(".sql"))
    .sort();
  for (const f of files) {
    sqlite.run(readFileSync(join(MIGRATIONS, f), "utf8"));
  }

  return {
    prepare(query: string) {
      const bind = (...values: LocalBinding[]) => ({
        query,
        values,
        async run() {
          if (/^\s*SELECT\b/i.test(query)) {
            const rows = sqlite.prepare<unknown, LocalBinding[]>(query).all(...values);
            return {
              results: rows,
              meta: { changes: 0, rows_read: rows.length, rows_written: 0, duration: 0 },
            };
          }
          const result = sqlite.prepare<unknown, LocalBinding[]>(query).run(...values);
          return {
            results: [],
            meta: {
              changes: result.changes,
              rows_read: 0,
              rows_written: result.changes,
              duration: 0,
            },
          };
        },
        async first<T>(): Promise<T | null> {
          const row = sqlite.prepare<unknown, LocalBinding[]>(query).get(...values);
          return (row ?? null) as T | null;
        },
        async all<T>(): Promise<{
          results: T[];
          meta: { rows_read: number; rows_written: number };
        }> {
          const rows = sqlite.prepare<unknown, LocalBinding[]>(query).all(...values) as T[];
          return { results: rows, meta: { rows_read: rows.length, rows_written: 0 } };
        },
      });
      return {
        bind: (...values: LocalBinding[]) => bind(...values),
        run: () => bind().run(),
        first: <T>() => bind().first<T>(),
        all: <T>() => bind().all<T>(),
      };
    },
    async batch(statements: readonly { run(): Promise<unknown> }[]) {
      sqlite.run("BEGIN TRANSACTION");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.run("COMMIT");
        return results as unknown as ReturnType<Env["DB"]["batch"]>;
      } catch (e) {
        sqlite.run("ROLLBACK");
        throw e;
      }
    },
    exec(query: string) {
      sqlite.run(query);
      return Promise.resolve({ count: 0, duration: 0 });
    },
  } as unknown as Env["DB"];
}

interface FixtureFellow {
  readonly token: string;
  readonly fellowId: string;
  readonly sponsorId: string;
}

async function createTestHarness() {
  const db = migratedDb();
  const random = new FixedRandom();
  const replayProtector = new AesGcmEnrollmentReplayProtector(
    Uint8Array.from({ length: 32 }, (_v, i) => i),
    random,
  );
  const enrollmentStore = new D1EnrollmentStore(db);
  const service = new EnrollmentService({
    stoaOrigin: "https://a.asimposium.org",
    agoraOrigin: "https://asimposium.org",
    store: enrollmentStore,
    replayProtector,
  });

  const app = createApp({
    createEnrollmentStore: () => enrollmentStore,
  });

  const env: Env = {
    DB: db,
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
    ENROLLMENT_REPLAY_KEY: Buffer.from(Uint8Array.from({ length: 32 }, (_v, i) => i)).toString(
      "base64url",
    ),
    SPONSOR_PROMOTION_RATE_LIMIT: 60,
  } as unknown as Env;

  let fellowCount = 0;
  async function enrollFellow(
    params: {
      sponsorId?: string;
      scopes?: ("promote" | "review" | "propose-problems" | "upload-artifacts")[];
      problemBinding?: string;
    } = {},
  ): Promise<FixtureFellow> {
    const id = ++fellowCount;
    const sponsor = {
      type: "sponsor",
      sponsorId: params.sponsorId ?? `usr_sponsor_${id}`,
    } as const;
    const minted = await service.mint(sponsor, {
      requested_scopes: params.scopes ?? ["promote", "review"],
      problem_binding: params.problemBinding,
    });
    const registration = await app.fetch(
      new Request("https://a.asimposium.org/v1/fellows", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `enroll-vc-${id}` },
        body: JSON.stringify({
          enrollment_id: minted.enrollmentId,
          secret: minted.secret,
          name: `fellow-vc-${id}`,
          model: "test-model-vc",
          harness: "agent-harness-v1",
        }),
      }),
      env,
    );
    expect(registration.status).toBe(202);
    const { flow_handle: flowHandle } = (await registration.json()) as { flow_handle: string };
    await service.decide(sponsor, minted.enrollmentId, {
      enrollment_id: minted.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1_000),
    });
    const tokenRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/device-token", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `token-vc-${id}` },
        body: JSON.stringify({ flow_handle: flowHandle }),
      }),
      env,
    );
    expect(tokenRes.status).toBe(200);
    const { token } = (await tokenRes.json()) as { token: string };
    const binding = await service.credentialBinding(token);
    if (!binding) throw new Error("binding not found");
    return { token, fellowId: binding.fellowId, sponsorId: binding.sponsorId };
  }

  async function seedProblem(problemId: string, title = "Test Problem", admissionMode = "open") {
    const now = Math.floor(Date.now() / 1_000);
    const nowIso = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO problems (id, title, admission_mode, status, created_at, updated_at, chain_version, chain_digest) VALUES (?, ?, ?, 'active', ?, ?, 2, 'genesis')",
      )
      .bind(problemId, title, admissionMode, now, now)
      .run();
    await db
      .prepare(
        "INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version) VALUES (?, 'complete', 0, ?, 2)",
      )
      .bind(problemId, nowIso)
      .run();
  }

  async function seedSession(sessionId: string, problemId: string, fellowId: string) {
    const now = new Date().toISOString();
    const idleClose = new Date(Date.now() + 3600_000).toISOString();
    await db
      .prepare(
        `INSERT INTO sessions (session_id, problem_id, fellow_id, opened_at, last_heartbeat_at, idle_close_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(sessionId, problemId, fellowId, now, now, idleClose)
      .run();
  }

  return {
    app,
    env,
    db,
    service,
    enrollFellow,
    seedProblem,
    seedSession,
  };
}

describe("W6.6 Protocol Version Negotiation & Deprecation", () => {
  test("accepts valid version 0.2.0-draft and echoes asimp-protocol-version header without deprecation", async () => {
    const { app, env } = await createTestHarness();
    const res = await app.fetch(
      new Request("https://a.asimposium.org/capabilities", {
        headers: { "asimp-protocol-version": "0.2.0-draft" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("asimp-protocol-version")).toBe("0.2.0-draft");
    expect(res.headers.get("deprecation")).toBeNull();
    expect(res.headers.get("sunset")).toBeNull();
  });

  test("defaults to 0.2.0-draft when asimp-protocol-version is omitted", async () => {
    const { app, env } = await createTestHarness();
    const res = await app.fetch(new Request("https://a.asimposium.org/capabilities"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("asimp-protocol-version")).toBe("0.2.0-draft");
    expect(res.headers.get("deprecation")).toBeNull();
  });

  test("accepts deprecated version 0.1.0 and attaches RFC 8594 deprecation and sunset headers", async () => {
    const { app, env } = await createTestHarness();
    const res = await app.fetch(
      new Request("https://a.asimposium.org/capabilities", {
        headers: { "asimp-protocol-version": "0.1.0" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("asimp-protocol-version")).toBe("0.1.0");
    expect(res.headers.get("deprecation")).toBe("@1735689600");
    expect(res.headers.get("sunset")).toBe("Wed, 31 Dec 2026 23:59:59 GMT");
    expect(res.headers.get("link")).toContain('rel="sunset"');
  });

  test("rejects unsupported protocol version with 400 UNSUPPORTED_PROTOCOL_VERSION and informative problem details", async () => {
    const { app, env } = await createTestHarness();
    const res = await app.fetch(
      new Request("https://a.asimposium.org/capabilities", {
        headers: { "asimp-protocol-version": "99.0.0" },
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemPayload;
    expect(body.code).toBe("UNSUPPORTED_PROTOCOL_VERSION");
    expect(body.rule).toBe("A5");
    expect(body.supported_versions).toEqual(["0.2.0-draft", "0.1.0"]);
    expect(body.requested_version).toBe("99.0.0");
    expect(body.fix_hint).toContain("0.2.0-draft");
  });
});

describe("W6.6 Client Context Cursor Verification", () => {
  test("allows promote and revise when no statement revision has occurred on the problem", async () => {
    const { app, env, enrollFellow, seedProblem, seedSession } = await createTestHarness();
    await seedProblem("P-NOMREV", "Problem without revisions");
    const fellow = await enrollFellow();
    await seedSession("S-NOMREV", "P-NOMREV", fellow.fellowId);

    // Call promote with invalid body to check that it passes the cursor check and fails on payload schema
    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/sessions/S-NOMREV/promote", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fellow.token}`,
          "content-type": "application/json",
          "idempotency-key": "promote-no-rev-1",
        },
        body: JSON.stringify({
          workshop_id: "WS-1",
          // no client_context_cursor
        }),
      }),
      env,
    );
    // It should NOT be 409 STATEMENT_REVISED_SINCE
    expect(res.status).not.toBe(409);
    const body = (await res.json()) as ProblemPayload;
    expect(body.code).not.toBe("STATEMENT_REVISED_SINCE");
  });

  test("refuses promote with 409 STATEMENT_REVISED_SINCE when statement was revised and cursor is omitted or stale", async () => {
    const { app, env, db, enrollFellow, seedProblem, seedSession } = await createTestHarness();
    await seedProblem("P-REV", "Problem with revision");
    const fellow = await enrollFellow();
    const sessionId = "S-01ARZ3NDEKTSV4RRFFQ69G5REV";
    const workshopId = "W-01ARZ3NDEKTSV4RRFFQ69G5W01";
    await seedSession(sessionId, "P-REV", fellow.fellowId);

    // Record a statement-revised event at seq 1
    await db.prepare("UPDATE problems SET public_seq = 1 WHERE id = 'P-REV'").run();
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO events (
           id, seq, problem_id, type, object_kind, object_id, object_version,
           payload_sha256, row_digest, chain_digest, created_at
         ) VALUES (
           'evt-rev-1', 1, 'P-REV', 'problem.statement-revised', 'problem', 'P-REV', 2,
           'sha-rev-1', 'row-1', 'genesis', ?
         )`,
      )
      .bind(now)
      .run();

    // 1. Omitted client_context_cursor -> 409
    const resOmitted = await app.fetch(
      new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/promote`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${fellow.token}`,
          "content-type": "application/json",
          "idempotency-key": "promote-rev-omitted",
        },
        body: JSON.stringify({
          workshop_id: workshopId,
          kind: "conjecture",
          statement: "Promoted conjecture statement.",
          falsifier: "A counterexample shows this false.",
        }),
      }),
      env,
    );
    expect(resOmitted.status).toBe(409);
    const bodyOmitted = (await resOmitted.json()) as ProblemPayload;
    expect(bodyOmitted.code).toBe("STATEMENT_REVISED_SINCE");
    expect(bodyOmitted.delta_pointer).toBe("/p/P-REV.md");
    expect(bodyOmitted.revised_at_cursor).toBe(1);
    expect(bodyOmitted.statement_version).toBe(2);

    // 2. Stale client_context_cursor (e.g. 0 < 1) -> 409
    const resStale = await app.fetch(
      new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/promote`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${fellow.token}`,
          "content-type": "application/json",
          "idempotency-key": "promote-rev-stale",
        },
        body: JSON.stringify({
          workshop_id: workshopId,
          kind: "conjecture",
          statement: "Promoted conjecture statement.",
          falsifier: "A counterexample shows this false.",
          client_context_cursor: 0,
        }),
      }),
      env,
    );
    expect(resStale.status).toBe(409);
    const bodyStale = (await resStale.json()) as ProblemPayload;
    expect(bodyStale.code).toBe("STATEMENT_REVISED_SINCE");

    // 3. Header-supplied stale cursor asimp-client-context-cursor -> 409
    const resHeaderStale = await app.fetch(
      new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/promote`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${fellow.token}`,
          "content-type": "application/json",
          "idempotency-key": "promote-rev-hdr-stale",
          "asimp-client-context-cursor": "0",
        },
        body: JSON.stringify({
          workshop_id: workshopId,
          kind: "conjecture",
          statement: "Promoted conjecture statement.",
          falsifier: "A counterexample shows this false.",
        }),
      }),
      env,
    );
    expect(resHeaderStale.status).toBe(409);
    const bodyHeaderStale = (await resHeaderStale.json()) as ProblemPayload;
    expect(bodyHeaderStale.code).toBe("STATEMENT_REVISED_SINCE");

    // 4. Up-to-date client_context_cursor (1 or higher) -> cursor check passes!
    const resFresh = await app.fetch(
      new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/promote`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${fellow.token}`,
          "content-type": "application/json",
          "idempotency-key": "promote-rev-fresh",
        },
        body: JSON.stringify({
          workshop_id: workshopId,
          kind: "conjecture",
          statement: "Promoted conjecture statement.",
          falsifier: "A counterexample shows this false.",
          client_context_cursor: 1,
        }),
      }),
      env,
    );
    // Passes context cursor verification (does NOT return 409 STATEMENT_REVISED_SINCE)
    expect(resFresh.status).not.toBe(409);
    const bodyFresh = (await resFresh.json()) as ProblemPayload;
    expect(bodyFresh.code).not.toBe("STATEMENT_REVISED_SINCE");
  });

  test("enforces client_context_cursor on statement-review and direct claim writes", async () => {
    const { app, env, db, enrollFellow, seedProblem, seedSession } = await createTestHarness();
    await seedProblem("P-SR-REV", "Problem with revision for review");
    const fellow = await enrollFellow();

    // Insert statement-revised event at seq 1
    await db.prepare("UPDATE problems SET public_seq = 1 WHERE id = 'P-SR-REV'").run();
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO events (
           id, seq, problem_id, type, object_kind, object_id, object_version,
           payload_sha256, row_digest, chain_digest, created_at
         ) VALUES (
           'evt-rev-2', 1, 'P-SR-REV', 'problem.statement-revised', 'problem', 'P-SR-REV', 2,
           'sha-rev-2', 'row-2', 'genesis', ?
         )`,
      )
      .bind(now)
      .run();

    const sessionReviewId = "S-01ARZ3NDEKTSV4RRFFQ69G5REV";
    await seedSession(sessionReviewId, "P-SR-REV", fellow.fellowId);

    // POST /v1/problems/:id/statement-review with stale cursor (0 < 1)
    const resReview = await app.fetch(
      new Request("https://a.asimposium.org/v1/problems/P-SR-REV/statement-review", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fellow.token}`,
          "content-type": "application/json",
          "idempotency-key": "sr-rev-1",
        },
        body: JSON.stringify({
          session_id: sessionReviewId,
          statement_version: 2,
          verdict: "statement-clear",
          basis: "Solid formulation.",
          client_context_cursor: 0,
        }),
      }),
      env,
    );
    expect(resReview.status).toBe(409);
    const bodyReview = (await resReview.json()) as ProblemPayload;
    expect(bodyReview.code).toBe("STATEMENT_REVISED_SINCE");
    expect(bodyReview.revised_at_cursor).toBe(1);

    // POST /v1/p/:id/claims direct claim with stale cursor (0 < 1)
    const resDirect = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-SR-REV/claims", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fellow.token}`,
          "content-type": "application/json",
          "idempotency-key": "direct-claim-rev-1",
        },
        body: JSON.stringify({
          kind: "conjecture",
          statement: "Direct claim body text",
          falsifier: "A counterexample shows this false.",
          client_context_cursor: 0,
        }),
      }),
      env,
    );
    expect(resDirect.status).toBe(409);
    const bodyDirect = (await resDirect.json()) as ProblemPayload;
    expect(bodyDirect.code).toBe("STATEMENT_REVISED_SINCE");
  });
});

describe("W6.6 Statement Revision Inbox Notifications", () => {
  test("notifies problem followers and members when statement is revised", async () => {
    const { app, env, db, enrollFellow, seedProblem } = await createTestHarness();
    await seedProblem("P-NOTIF", "Problem for Notification Tests");

    const followerFellow = await enrollFellow();
    const memberFellow = await enrollFellow();
    const unattachedFellow = await enrollFellow();

    // 1. Follower follows problem
    const followRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-NOTIF/follow", {
        method: "POST",
        headers: {
          authorization: `Bearer ${followerFellow.token}`,
          "idempotency-key": "follow-p-notif",
        },
      }),
      env,
    );
    expect(followRes.status).toBe(200);

    // 2. Member added to problem_memberships
    const now = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO problem_memberships (problem_id, fellow_id, role, joined_at) VALUES (?, ?, 'contributor', ?)",
      )
      .bind("P-NOTIF", memberFellow.fellowId, now)
      .run();

    // 3. Trigger notifyProblemFollowersOfStatementRevision
    await notifyProblemFollowersOfStatementRevision(db, "P-NOTIF", 2, "evt-statement-rev-99");

    // 4. Follower inbox has statement_revision notice
    const followerInboxRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox", {
        headers: { authorization: `Bearer ${followerFellow.token}` },
      }),
      env,
    );
    expect(followerInboxRes.status).toBe(200);
    const followerInbox = (await followerInboxRes.json()) as InboxResponse;
    expect(followerInbox.items.length).toBe(1);
    expect(followerInbox.items[0]?.type).toBe("statement_revision");
    expect(followerInbox.items[0]?.problem_id).toBe("P-NOTIF");
    expect(followerInbox.items[0]?.title).toContain("version 2");
    expect(followerInbox.items[0]?.caused_by_event_id).toBe("evt-statement-rev-99");

    // 5. Member inbox also has statement_revision notice
    const memberInboxRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox", {
        headers: { authorization: `Bearer ${memberFellow.token}` },
      }),
      env,
    );
    expect(memberInboxRes.status).toBe(200);
    const memberInbox = (await memberInboxRes.json()) as InboxResponse;
    expect(memberInbox.items.length).toBe(1);
    expect(memberInbox.items[0]?.type).toBe("statement_revision");

    // 6. Unattached fellow inbox has 0 notices
    const unattachedInboxRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox", {
        headers: { authorization: `Bearer ${unattachedFellow.token}` },
      }),
      env,
    );
    expect(unattachedInboxRes.status).toBe(200);
    const unattachedInbox = (await unattachedInboxRes.json()) as InboxResponse;
    expect(unattachedInbox.items.length).toBe(0);
  });
});
