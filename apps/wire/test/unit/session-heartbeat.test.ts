import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AskQuestionResponseSchema,
  ContractProblemSchema,
  LeaseAcquireResponseSchema,
  LeaseChallengeResponseSchema,
  OpaqueProblemSchema,
  ProblemDocumentSchema,
  SessionHeartbeatResponseSchema,
  SessionOpenResponseSchema,
} from "@asimposium/contracts";
import { createEnrollmentRouter } from "../../src/enrollment/router.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
  InMemoryEnrollmentStore,
} from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { genesisChainDigest } from "../../src/krater/krater.ts";
import {
  createSessionRouter,
  MAX_SESSION_REQUEST_BODY_BYTES,
  type PromotionScreener,
} from "../../src/sessions/router.ts";
import { normHash } from "../../src/split/policy.ts";
import { syntheticScreeningObservation } from "../support/screening.ts";

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

interface FixtureOptions {
  screenPromotion?: PromotionScreener;
  beforeBatch?: (queries: readonly string[]) => Promise<void>;
}

function localD1(sqlite: Database, beforeBatch?: FixtureOptions["beforeBatch"]): Env["DB"] {
  let batchTail: Promise<unknown> = Promise.resolve();
  const prepare = (query: string) => {
    const methods = (...values: unknown[]) => ({
      query,
      async run() {
        const statement = sqlite.prepare(query);
        if (/^\s*SELECT\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
          const rows = statement.all(...(values as any[]));
          const changes = /^\s*SELECT\b/i.test(query)
            ? 0
            : (sqlite.query("SELECT changes() AS n").get() as { n: number }).n;
          return {
            success: true,
            results: rows,
            meta: { changes, rows_read: rows.length, rows_written: changes },
          };
        }
        const result = statement.run(...(values as any[]));
        return {
          success: true,
          results: [],
          meta: { changes: result.changes, rows_read: 0, rows_written: result.changes },
        };
      },
      async first<T>(): Promise<T | null> {
        const row = (sqlite.prepare(query) as any).get(...(values as any[]));
        return (row ?? null) as T | null;
      },
      async all<T>(): Promise<{
        success: boolean;
        results: T[];
        meta: { rows_read: number; rows_written: number };
      }> {
        const rows = (sqlite.prepare(query) as any).all(...(values as any[]));
        return {
          success: true,
          results: rows as T[],
          meta: { rows_read: rows.length, rows_written: 0 },
        };
      },
    });
    return {
      query,
      bind: (...values: unknown[]) => methods(...values),
      run: () => methods().run(),
      first: <T>() => methods().first<T>(),
      all: <T>() => methods().all<T>(),
    };
  };

  const runBatch = async (
    statements: readonly {
      query: string;
      run(): Promise<{ results?: readonly unknown[]; meta: { changes: number } }>;
    }[],
  ) => {
    // A competing mounted request commits before this transaction begins.
    // Run outside batchTail so its own batch can finish without a test deadlock.
    await beforeBatch?.(statements.map((statement) => statement.query));
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
        query: string;
        run(): Promise<{ results?: readonly unknown[]; meta: { changes: number } }>;
      }[],
    ) {
      return runBatch(statements);
    },
  } as unknown as Env["DB"];
}

function migratedDb(beforeBatch?: FixtureOptions["beforeBatch"]): Env["DB"] {
  const sqlite = new Database(":memory:", { strict: true });
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.run(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return localD1(sqlite, beforeBatch);
}

async function createTestFixture(options: FixtureOptions = {}) {
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
    screenPromotion: options.screenPromotion,
  });
  const db = migratedDb(options.beforeBatch);
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
  test("heartbeat migration preserves existing sealed responses and uniqueness", () => {
    const sqlite = new Database(":memory:", { strict: true });
    try {
      for (const file of readdirSync(MIGRATIONS)
        .filter((name) => name.endsWith(".sql") && name < "0058_")
        .sort()) {
        sqlite.run(readFileSync(join(MIGRATIONS, file), "utf8"));
      }
      sqlite.run(
        "INSERT INTO session_write_replays VALUES ('session_close','F-existing','same-key','digest','ciphertext','nonce',9000000000,'R-existing')",
      );
      const before = sqlite.query("SELECT * FROM session_write_replays").all();
      sqlite.run(readFileSync(join(MIGRATIONS, "0058_heartbeat_replay_scope.sql"), "utf8"));
      expect(sqlite.query("SELECT * FROM session_write_replays").all()).toEqual(before);
      sqlite.run(
        "INSERT INTO session_write_replays VALUES ('session_heartbeat','F-existing','same-key','digest','other-ciphertext','other-nonce',9000000000,'R-heartbeat')",
      );
      expect(() =>
        sqlite.run(
          "INSERT INTO session_write_replays VALUES ('session_heartbeat','F-existing','same-key','digest','x','y',9000000000,'R-another')",
        ),
      ).toThrow();
      expect(() =>
        sqlite.run(
          "INSERT INTO session_write_replays VALUES ('session_heartbeat','F-existing','other-key','digest','x','y',9000000000,'R-heartbeat')",
        ),
      ).toThrow();
    } finally {
      sqlite.close();
    }
  });
  test("heartbeat requires a valid retained key before reading its body", async () => {
    const f = await createTestFixture();
    for (const key of ["", "bad key", "x".repeat(161)]) {
      const response = await f.call(
        f.token1,
        "/v1/sessions/S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z/heartbeat",
        {
          method: "POST",
          headers: { "idempotency-key": key },
          body: "not-json",
        },
      );
      expect(response.status).toBe(400);
      const problem = ContractProblemSchema.parse(await response.json());
      expect(problem.code).toBe("IDEMPOTENCY_KEY_INVALID");
    }
  });
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
    expect(body.schema).toBe(
      "https://a.asimposium.org/schemas/sessions.v1/session_heartbeat_request.json",
    );
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
    const oldIdle = new Date(Date.now() + 60_000).toISOString();
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

  test("heartbeat cannot revive an idle-expired session before the close sweep", async () => {
    const f = await createTestFixture();
    const openedAt = new Date(Date.now() - 13 * 3600_000).toISOString();
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    const sessionId = "S-01JXYZ4K6Q7R8S9T0V1W2X3Y4Z";
    await f.db
      .prepare(
        `INSERT INTO sessions
       (session_id, fellow_id, problem_id, intent, opened_at, last_heartbeat_at, idle_close_at, closed_at)
       VALUES (?, ?, 'P-4DSP', 'prove', ?, ?, ?, NULL)`,
      )
      .bind(sessionId, f.binding1.fellowId, openedAt, openedAt, expiredAt)
      .run();
    const res = await f.call(f.token1, `/v1/sessions/${sessionId}/heartbeat`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("WRITE_REFUSED");
    const session = await f.db
      .prepare("SELECT last_heartbeat_at, idle_close_at FROM sessions WHERE session_id = ?")
      .bind(sessionId)
      .first();
    expect(session).toEqual({ last_heartbeat_at: openedAt, idle_close_at: expiredAt });
    const replay = await f.db
      .prepare(
        "SELECT count(*) AS count FROM session_write_replays WHERE scope = 'session_heartbeat'",
      )
      .first<{ count: number }>();
    expect(replay?.count).toBe(0);
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

  test("a heartbeat winning at challenge commit preserves the lease and allows a later same-key retry", async () => {
    let beforeChallengeCommit: (() => Promise<void>) | undefined;
    let challengeScreens = 0;
    const f = await createTestFixture({
      screenPromotion: async (input) => {
        if (input.kind === "lease-challenge") challengeScreens++;
        return syntheticScreeningObservation(input, {
          decision: "pass",
          coarse_category: "benign-context",
          provider_status: "ok",
        });
      },
      beforeBatch: async (queries) => {
        if (!queries.some((query) => /UPDATE leases\s+SET status = 'challenged'/.test(query)))
          return;
        const compete = beforeChallengeCommit;
        beforeChallengeCommit = undefined;
        await compete?.();
      },
    });
    // All shipped migrations and production routes execute on native SQLite.
    // Only provider classification is synthetic; this is not deployed D1 proof.
    const createdAt = new Date().toISOString();
    const statement = "For every integer n, n squared and n have the same parity.";
    await f.db
      .prepare(`INSERT INTO problem_statement_versions
        (problem_id, version, statement, norm_hash, falsifier, motivation, created_at)
        VALUES ('P-4DSP', 1, ?, ?, ?, ?, ?)`)
      .bind(
        statement,
        await normHash(statement),
        "An integer whose square and original value have different parity.",
        "Check the two exhaustive residue classes modulo two.",
        createdAt,
      )
      .run();
    await f.db
      .prepare(`INSERT INTO krater_integrity_backfill
        (problem_id, state, legacy_event_count, completed_at, chain_version)
        VALUES ('P-4DSP', 'complete', 0, ?, 2)`)
      .bind(createdAt)
      .run();

    const post = async (
      token: string,
      path: string,
      body: unknown,
      expectedStatus = 200,
      key: string = crypto.randomUUID(),
    ) => {
      const response = await f.call(token, path, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      });
      expect(response.status, await response.clone().text()).toBe(expectedStatus);
      return response;
    };
    const open = async (token: string) =>
      SessionOpenResponseSchema.parse(
        await (await post(token, "/v1/sessions", { problem_id: "P-4DSP" }, 201)).json(),
      ).session_id;
    const holder = await open(f.token1);
    const challenger = await open(f.token2);
    const holderPath = `/v1/sessions/${holder}`;
    const challengerPath = `/v1/sessions/${challenger}`;
    const question = AskQuestionResponseSchema.parse(
      await (
        await post(
          f.token1,
          `${holderPath}/questions`,
          {
            body_md:
              "Can checking the two residue classes modulo two establish that n squared and n have the same parity for every integer n?",
          },
          201,
        )
      ).json(),
    );
    const lease = LeaseAcquireResponseSchema.parse(
      await (
        await post(
          f.token1,
          `${holderPath}/leases`,
          {
            object: question.question_id,
            objective: "Check both residue classes modulo two.",
            deliverable: "A public answer with the exhaustive calculation.",
            ttl_seconds: 600,
          },
          201,
        )
      ).json(),
    ).lease;
    await f.db
      .prepare("UPDATE sessions SET last_heartbeat_at = ? WHERE session_id = ?")
      .bind(new Date(Date.now() - 31 * 60_000).toISOString(), holder)
      .run();

    const publicState = () =>
      f.db
        .prepare(`SELECT public_seq, chain_digest,
      (SELECT cursor FROM public_cursor WHERE singleton = 1) AS cursor,
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM event_content) AS bodies,
      (SELECT COUNT(*) FROM outbox) AS outbox,
      (SELECT COUNT(*) FROM screening_publications) AS screenings
      FROM problems WHERE id = 'P-4DSP'`)
        .first();
    const before = await publicState();
    let renewedUntil: string | undefined;
    beforeChallengeCommit = async () => {
      const heartbeat = SessionHeartbeatResponseSchema.parse(
        await (await post(f.token1, `${holderPath}/heartbeat`, {})).json(),
      );
      expect(heartbeat.renewed_leases).toContain(lease.object);
      renewedUntil = (
        await f.db
          .prepare("SELECT leased_until FROM leases WHERE lease_id = ?")
          .bind(lease.lease_id)
          .first<{ leased_until: string }>()
      )?.leased_until;
      expect(renewedUntil).not.toBe(lease.leased_until);
    };
    const challengePath = `${challengerPath}/leases/${lease.lease_id}/challenge`;
    const challengeBody = { reason: "The holder has been idle for more than thirty minutes." };
    const challengeKey = "challenge-renewed-at-commit";
    const refused = ContractProblemSchema.parse(
      await (await post(f.token2, challengePath, challengeBody, 409, challengeKey)).json(),
    );
    expect(refused.code).toBe("LEASE_NOT_STALE");
    expect(refused.fix_hint).toContain("same Idempotency-Key");
    expect(refused.example).toMatchObject({ lease_id: lease.lease_id, leased_until: renewedUntil });
    expect(challengeScreens).toBe(1);
    expect(await publicState()).toEqual(before);
    expect(
      await f.db
        .prepare(`SELECT status, challenge_reason, challenged_by_fellow_id,
      challenged_at FROM leases WHERE lease_id = ?`)
        .bind(lease.lease_id)
        .first<{ status: string; challenge_reason: string | null; challenged_by_fellow_id: string | null; challenged_at: string | null }>(),
    ).toEqual({
      status: "active",
      challenge_reason: null,
      challenged_by_fellow_id: null,
      challenged_at: null,
    });
    expect(
      await f.db
        .prepare(`SELECT COUNT(*) AS n FROM session_write_replays
      WHERE scope = 'challenge_lease' AND idempotency_key = ?`)
        .bind(challengeKey)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    expect(
      await f.db
        .prepare(`SELECT status FROM public_write_attempt_reservations
      WHERE fellow_id = ? AND route = 'leases/challenge' AND idempotency_key = ?`)
        .bind(f.binding2.fellowId, challengeKey)
        .first<{ status: string }>(),
    ).toEqual({ status: "settled_failed" });

    // The failed challenge cannot steal the fresh exclusive lease.
    const blocked = ContractProblemSchema.parse(
      await (
        await post(
          f.token2,
          `${challengerPath}/leases`,
          {
            object: lease.object,
            objective: "Independently check the parity calculation.",
            deliverable: "A second exhaustive calculation.",
          },
          409,
        )
      ).json(),
    );
    expect(blocked.code).toBe("LEASED");

    // A genuinely expired lease remains challengeable despite a recent heartbeat;
    // the failed attempt did not poison its caller's idempotency key.
    await f.db
      .prepare("UPDATE leases SET leased_until = ? WHERE lease_id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), lease.lease_id)
      .run();
    const accepted = LeaseChallengeResponseSchema.parse(
      await (await post(f.token2, challengePath, challengeBody, 200, challengeKey)).json(),
    );
    expect(accepted.status).toBe("challenged");
    expect(challengeScreens).toBe(2);
    const after = await publicState();
    expect(
      await (await post(f.token2, challengePath, challengeBody, 200, challengeKey)).json(),
    ).toEqual(accepted);
    expect(challengeScreens).toBe(2);
    expect(await publicState()).toEqual(after);
    expect(
      await f.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'lease.challenged'")
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
  });
});
