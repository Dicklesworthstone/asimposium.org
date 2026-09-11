import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ContractProblemSchema,
  OpaqueProblemSchema,
  ProblemDocumentSchema,
  SessionHeartbeatResponseSchema,
} from "@asimposium/contracts";
import { createEnrollmentRouter } from "../../src/enrollment/router.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
  InMemoryEnrollmentStore,
} from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { genesisChainDigest } from "../../src/krater/krater.ts";
import { createSessionRouter, MAX_SESSION_REQUEST_BODY_BYTES } from "../../src/sessions/router.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

class FixedRandom {
  #next = 11;
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

async function createTestFixture() {
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
  });
  const db = migratedDb();
  const sponsor = { type: "sponsor", sponsorId: "usr_sessionsponsor1" } as const;

  // Fellow 1
  const minted1 = await service.mint(sponsor, {
    requested_scopes: ["promote", "review"],
    problem_binding: "P-4DSP",
  });
  const registration1 = await enrollmentRouter.fetch(
    new Request("https://a-staging.asimposium.org/v1/fellows", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "fixture-claim-1" },
      body: JSON.stringify({
        enrollment_id: minted1.enrollmentId,
        secret: minted1.secret,
        name: "session-runner-1",
        model: "test-model",
        harness: "test-harness",
      }),
    }),
  );
  const { flow_handle: flowHandle1 } = (await registration1.json()) as { flow_handle: string };
  await service.decide(sponsor, minted1.enrollmentId, {
    enrollment_id: minted1.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: Math.floor(Date.now() / 1_000),
  });
  const issued1 = await enrollmentRouter.fetch(
    new Request("https://a-staging.asimposium.org/v1/device-token", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "fixture-token-1" },
      body: JSON.stringify({ flow_handle: flowHandle1 }),
    }),
  );
  const { token: token1 } = (await issued1.json()) as { token: string };
  const binding1 = await service.credentialBinding(token1);
  if (binding1 === undefined) throw new Error("binding1 missing");

  // Fellow 2
  const minted2 = await service.mint(sponsor, {
    requested_scopes: ["promote", "review"],
    problem_binding: "P-4DSP",
  });
  const registration2 = await enrollmentRouter.fetch(
    new Request("https://a-staging.asimposium.org/v1/fellows", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "fixture-claim-2" },
      body: JSON.stringify({
        enrollment_id: minted2.enrollmentId,
        secret: minted2.secret,
        name: "session-runner-2",
        model: "test-model",
        harness: "test-harness",
      }),
    }),
  );
  const { flow_handle: flowHandle2 } = (await registration2.json()) as { flow_handle: string };
  await service.decide(sponsor, minted2.enrollmentId, {
    enrollment_id: minted2.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: Math.floor(Date.now() / 1_000),
  });
  const issued2 = await enrollmentRouter.fetch(
    new Request("https://a-staging.asimposium.org/v1/device-token", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "fixture-token-2" },
      body: JSON.stringify({ flow_handle: flowHandle2 }),
    }),
  );
  const { token: token2 } = (await issued2.json()) as { token: string };
  const binding2 = await service.credentialBinding(token2);
  if (binding2 === undefined) throw new Error("binding2 missing");

  const seedFellow = async (binding: typeof binding1) => {
    const grantedScopesJson = JSON.stringify(binding.grantedScopes);
    const grantedResourcesJson = JSON.stringify(binding.grantedResources);
    const createdAt = Math.max(1, binding.issuedAt - 1);
    const enrollmentId = `ASIMP-EN-${binding.fellowId.slice(2)}`;
    const proposalId = `fixture-proposal-${binding.fellowId}`;
    const flowHandleHash = `fixture-flow-${binding.fellowId}`;

    await db
      .prepare(
        `INSERT INTO sponsors (sponsor_id, created_at, last_seen_at)
         SELECT ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM sponsors WHERE sponsor_id = ?)`,
      )
      .bind(binding.sponsorId, createdAt, createdAt, binding.sponsorId)
      .run();

    await db
      .prepare(
        `INSERT INTO enrollment_records
           (enrollment_id, sponsor_id, secret_hash, secret_expires_at,
            requested_scopes_json, requested_resources_json, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM enrollment_records WHERE enrollment_id = ?)`,
      )
      .bind(
        enrollmentId,
        binding.sponsorId,
        binding.tokenHash,
        createdAt + 1,
        grantedScopesJson,
        grantedResourcesJson,
        createdAt,
        enrollmentId,
      )
      .run();

    await db
      .prepare(
        `INSERT INTO enrollment_proposals
           (proposal_id, enrollment_id, fellow_id, flow_handle_hash, name, model, harness,
            created_at, expires_at, status, poll_interval_seconds)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 5
         WHERE NOT EXISTS (SELECT 1 FROM enrollment_proposals WHERE proposal_id = ?)`,
      )
      .bind(
        proposalId,
        enrollmentId,
        binding.fellowId,
        flowHandleHash,
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
        `UPDATE enrollment_proposals
            SET status = 'approved', granted_scopes_json = ?, granted_resources_json = ?
          WHERE proposal_id = ? AND status = 'pending'`,
      )
      .bind(grantedScopesJson, grantedResourcesJson, proposalId)
      .run();

    await db
      .prepare(
        `INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM enrollment_fellows WHERE fellow_id = ?)`,
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
        `INSERT INTO enrollment_grants
           (proposal_id, fellow_id, sponsor_id, granted_scopes_json, granted_resources_json, granted_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM enrollment_grants WHERE fellow_id = ?)`,
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
        `INSERT INTO fellow_tokens
           (credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
            granted_scopes_json, granted_resources_json, issued_at, expires_at,
            credential_origin)
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
  };

  await seedFellow(binding1);
  await seedFellow(binding2);

  const now = new Date().toISOString();
  const genesis = await genesisChainDigest("P-4DSP");
  await db
    .prepare(
      "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_digest, chain_version) VALUES ('P-4DSP', 0, ?, ?, ?, 2)",
    )
    .bind(now, now, genesis)
    .run();

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

  return {
    call,
    db,
    token1,
    binding1,
    token2,
    binding2,
    env,
  };
}

describe("W4.7 Session heartbeat and presence", () => {
  test("heartbeat requires authentication", async () => {
    const f = await createTestFixture();
    const res = await f.call("", "/v1/sessions/S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z/heartbeat", {
      method: "POST",
      headers: { authorization: "Bearer invalid_token" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, any>;
    expect(OpaqueProblemSchema.safeParse(body).success).toBe(true);
    expect(body.code).toBe("FELLOW_TOKEN_INVALID");
  });

  test("heartbeat refuses missing session with 404 SESSION_NOT_FOUND", async () => {
    const f = await createTestFixture();
    const res = await f.call(f.token1, "/v1/sessions/S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z/heartbeat", {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, any>;
    expect(ContractProblemSchema.safeParse(body).success).toBe(true);
    expect(body.code).toBe("SESSION_NOT_FOUND");
  });

  test("heartbeat refuses session of another fellow with 404 SESSION_NOT_FOUND", async () => {
    const f = await createTestFixture();
    const now = new Date(Date.now() - 60_000).toISOString();
    const idle = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    await f.db
      .prepare(
        `INSERT INTO sessions
           (session_id, fellow_id, problem_id, intent, opened_at, last_heartbeat_at, idle_close_at, closed_at)
         VALUES ('S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z', ?, 'P-4DSP', 'prove', ?, ?, ?, NULL)`,
      )
      .bind(f.binding1.fellowId, now, now, idle)
      .run();

    // fellow 2 tries to heartbeat fellow 1's session
    const res = await f.call(f.token2, "/v1/sessions/S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z/heartbeat", {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, any>;
    expect(body.code).toBe("SESSION_NOT_FOUND");
  });

  test("heartbeat refuses closed session with 409 SESSION_CLOSED", async () => {
    const f = await createTestFixture();
    const now = new Date(Date.now() - 60_000).toISOString();
    const idle = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    await f.db
      .prepare(
        `INSERT INTO sessions
           (session_id, fellow_id, problem_id, intent, opened_at, last_heartbeat_at, idle_close_at, closed_at)
         VALUES ('S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z', ?, 'P-4DSP', 'prove', ?, ?, ?, ?)`,
      )
      .bind(f.binding1.fellowId, now, now, idle, now)
      .run();

    const res = await f.call(f.token1, "/v1/sessions/S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z/heartbeat", {
      method: "POST",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, any>;
    expect(ContractProblemSchema.safeParse(body).success).toBe(true);
    expect(body.code).toBe("SESSION_CLOSED");
  });

  test("heartbeat refuses invalid request body with 422 SESSION_HEARTBEAT_BODY_INVALID", async () => {
    const f = await createTestFixture();
    const now = new Date(Date.now() - 60_000).toISOString();
    const idle = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    await f.db
      .prepare(
        `INSERT INTO sessions
           (session_id, fellow_id, problem_id, intent, opened_at, last_heartbeat_at, idle_close_at, closed_at)
         VALUES ('S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z', ?, 'P-4DSP', 'prove', ?, ?, ?, NULL)`,
      )
      .bind(f.binding1.fellowId, now, now, idle)
      .run();

    const res = await f.call(f.token1, "/v1/sessions/S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unexpected: 123 }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, any>;
    expect(ContractProblemSchema.safeParse(body).success).toBe(true);
    expect(body.code).toBe("SESSION_HEARTBEAT_BODY_INVALID");
    expect(body.rule).toBe("A5");
    expect(body.schema).toBe("https://a.asimposium.org/schemas/sessions.v1.json");
  });

  test("heartbeat refuses oversized request body with 413 REQUEST_BODY_TOO_LARGE", async () => {
    const f = await createTestFixture();
    const res = await f.call(f.token1, "/v1/sessions/S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(MAX_SESSION_REQUEST_BODY_BYTES + 10),
    });
    expect(res.status).toBe(413);
  });

  test("heartbeat succeeds with empty body, updates last_heartbeat_at and idle_close_at, and preserves invariants", async () => {
    const f = await createTestFixture();
    const openedAt = new Date(Date.now() - 120_000).toISOString();
    const oldHeartbeat = openedAt;
    const oldIdle = new Date(Date.now() - 60_000).toISOString();
    await f.db
      .prepare(
        `INSERT INTO sessions
           (session_id, fellow_id, problem_id, intent, opened_at, last_heartbeat_at, idle_close_at, closed_at)
         VALUES ('S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z', ?, 'P-4DSP', 'prove', ?, ?, ?, NULL)`,
      )
      .bind(f.binding1.fellowId, openedAt, oldHeartbeat, oldIdle)
      .run();

    const beforeEvents = await f.db
      .prepare("SELECT count(*) as count FROM events")
      .first<{ count: number }>();
    expect(beforeEvents?.count).toBe(0);

    const res = await f.call(f.token1, "/v1/sessions/S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const json = await res.json();
    const parsed = SessionHeartbeatResponseSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.session_id).toBe("S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z");
    expect(parsed.data.renewed_leases).toEqual([]);
    expect(new Date(parsed.data.last_heartbeat_at).getTime()).toBeGreaterThan(
      new Date(oldHeartbeat).getTime(),
    );
    expect(new Date(parsed.data.idle_close_at).getTime()).toBeGreaterThan(
      new Date(oldIdle).getTime(),
    );

    // Verify DB update
    const sessionInDb = await f.db
      .prepare("SELECT * FROM sessions WHERE session_id = 'S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z'")
      .first<{ last_heartbeat_at: string; idle_close_at: string }>();
    expect(sessionInDb?.last_heartbeat_at).toBe(parsed.data.last_heartbeat_at);
    expect(sessionInDb?.idle_close_at).toBe(parsed.data.idle_close_at);

    // Invariant: Heartbeat does NOT append to events table
    const afterEvents = await f.db
      .prepare("SELECT count(*) as count FROM events")
      .first<{ count: number }>();
    expect(afterEvents?.count).toBe(0);

    // Invariant: Public sequence on problems is untouched
    const problem = await f.db
      .prepare("SELECT public_seq FROM problems WHERE id = 'P-4DSP'")
      .first<{ public_seq: number }>();
    expect(problem?.public_seq).toBe(0);
  });

  test("heartbeat renews active leases for this fellow on this problem and ignores expired or foreign leases", async () => {
    const f = await createTestFixture();
    const nowMs = Date.now();
    const openedAt = new Date(nowMs - 120_000).toISOString();
    await f.db
      .prepare(
        `INSERT INTO sessions
           (session_id, fellow_id, problem_id, intent, opened_at, last_heartbeat_at, idle_close_at, closed_at)
         VALUES ('S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z', ?, 'P-4DSP', 'prove', ?, ?, ?, NULL)`,
      )
      .bind(f.binding1.fellowId, openedAt, openedAt, new Date(nowMs + 3600_000).toISOString())
      .run();

    // 1. Active lease owned by fellow 1
    const activeExpiry = new Date(nowMs + 600_000).toISOString();
    await f.db
      .prepare(
        `INSERT INTO questions
           (question_id, problem_id, seq, body_md, author_fellow_id, status, leased_by, leased_until, created_at)
         VALUES ('Q-ACTIVE', 'P-4DSP', 1, 'Question active body', ?, 'leased', ?, ?, ?)`,
      )
      .bind(f.binding1.fellowId, f.binding1.fellowId, activeExpiry, openedAt)
      .run();

    // 2. Expired lease owned by fellow 1
    const expiredExpiry = new Date(nowMs - 600_000).toISOString();
    await f.db
      .prepare(
        `INSERT INTO questions
           (question_id, problem_id, seq, body_md, author_fellow_id, status, leased_by, leased_until, created_at)
         VALUES ('Q-EXPIRED', 'P-4DSP', 2, 'Question expired body', ?, 'leased', ?, ?, ?)`,
      )
      .bind(f.binding1.fellowId, f.binding1.fellowId, expiredExpiry, openedAt)
      .run();

    // 3. Active lease owned by fellow 2
    await f.db
      .prepare(
        `INSERT INTO questions
           (question_id, problem_id, seq, body_md, author_fellow_id, status, leased_by, leased_until, created_at)
         VALUES ('Q-FOREIGN', 'P-4DSP', 3, 'Question foreign body', ?, 'leased', ?, ?, ?)`,
      )
      .bind(f.binding2.fellowId, f.binding2.fellowId, activeExpiry, openedAt)
      .run();

    const res = await f.call(f.token1, "/v1/sessions/S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z/heartbeat", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    const parsed = SessionHeartbeatResponseSchema.parse(json);

    // Only Q-ACTIVE should be renewed
    expect(parsed.renewed_leases).toEqual(["Q-ACTIVE"]);

    // Verify Q-ACTIVE has lease extended to ~now + 2h
    const qActive = await f.db
      .prepare("SELECT leased_until FROM questions WHERE question_id = 'Q-ACTIVE'")
      .first<{ leased_until: string }>();
    expect(new Date(qActive!.leased_until).getTime()).toBeGreaterThan(nowMs + 7000 * 1000);

    // Verify Q-EXPIRED was NOT extended
    const qExpired = await f.db
      .prepare("SELECT leased_until FROM questions WHERE question_id = 'Q-EXPIRED'")
      .first<{ leased_until: string }>();
    expect(qExpired?.leased_until).toBe(expiredExpiry);

    // Verify Q-FOREIGN was NOT touched
    const qForeign = await f.db
      .prepare("SELECT leased_until FROM questions WHERE question_id = 'Q-FOREIGN'")
      .first<{ leased_until: string }>();
    expect(qForeign?.leased_until).toBe(activeExpiry);
  });
});
