import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  EnrollmentHelloResponseSchema,
  type NextMoveCandidate,
  ProblemNextResponseSchema,
  ProtocolAckResponseSchema,
  TriageResponseSchema,
} from "@asimposium/contracts";
import { getDocument, sha256Hex } from "@asimposium/protocol";

import { createApp } from "../../src/app.ts";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
} from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import {
  ContractFixtureMovesProvider,
  PROMOTION_MOVE_KINDS,
} from "../../src/mega-commands/provider.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

class FixedRandom {
  #next = 17;

  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => {
      const value = this.#next;
      this.#next = (this.#next + 1) % 256;
      return value;
    });
  }
}

function migratedDb(): Env["DB"] {
  const sqlite = new Database(":memory:", { strict: true });
  const files = readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith(".sql"))
    .sort();
  for (const f of files) {
    sqlite.run(readFileSync(join(MIGRATIONS, f), "utf8"));
  }

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
        const rows = (sqlite.prepare(query) as any).all(...(values as any[])) as T[];
        return { results: rows, meta: { rows_read: rows.length, rows_written: 0 } };
      },
    });
    return {
      bind: (...values: unknown[]) => methods(...values),
      run: () => methods().run(),
      first: <T>() => methods().first<T>(),
      all: <T>() => methods().all<T>(),
    };
  };

  return {
    prepare,
    batch(statements: readonly { run(): Promise<unknown> }[]) {
      const result = batchTail.then(async () => {
        sqlite.run("BEGIN");
        try {
          const results = [];
          for (const s of statements) results.push(await s.run());
          sqlite.run("COMMIT");
          return results;
        } catch (e) {
          sqlite.run("ROLLBACK");
          throw e;
        }
      });
      batchTail = result.catch(() => {});
      return result as any;
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

async function createTestHarness(options: { movesProvider?: any } = {}) {
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
    megaCommandsMovesProvider: options.movesProvider,
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
        headers: { "content-type": "application/json", "idempotency-key": `enroll-fellow-${id}` },
        body: JSON.stringify({
          enrollment_id: minted.enrollmentId,
          secret: minted.secret,
          name: `fellow-${id}`,
          model: "test-model-4",
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
        headers: { "content-type": "application/json", "idempotency-key": `token-fellow-${id}` },
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

  // Helper to insert a problem directly into the DB
  async function seedProblem(problemId: string, title = "Test Problem", admissionMode = "open") {
    const now = Math.floor(Date.now() / 1_000);
    await db
      .prepare(
        "INSERT INTO problems (id, title, admission_mode, status, created_at, updated_at, chain_digest) VALUES (?, ?, ?, 'active', ?, ?, 'genesis')",
      )
      .bind(problemId, title, admissionMode, now, now)
      .run();
  }

  // Helper to add problem membership
  async function seedMembership(problemId: string, fellowId: string, role: string) {
    await db
      .prepare(
        "INSERT INTO problem_memberships (problem_id, fellow_id, role, joined_at) VALUES (?, ?, ?, ?)",
      )
      .bind(problemId, fellowId, role, new Date().toISOString())
      .run();
  }

  return {
    app,
    env,
    db,
    service,
    enrollFellow,
    seedProblem,
    seedMembership,
  };
}

describe("W6.2 Mega-Commands (hello, triage, next)", () => {
  test("GET /v1/hello rejects unauthenticated requests with 401", async () => {
    const { app, env } = await createTestHarness();
    const resNoAuth = await app.fetch(new Request("https://a.asimposium.org/v1/hello"), env);
    expect(resNoAuth.status).toBe(401);
    const bodyNoAuth = (await resNoAuth.json()) as any;
    expect(bodyNoAuth.code).toBe("FELLOW_TOKEN_INVALID");

    const resBadToken = await app.fetch(
      new Request("https://a.asimposium.org/v1/hello", {
        headers: { authorization: "Bearer not_a_valid_fellow_token" },
      }),
      env,
    );
    expect(resBadToken.status).toBe(401);
    const bodyBadToken = (await resBadToken.json()) as any;
    expect(bodyBadToken.code).toBe("FELLOW_TOKEN_INVALID");
  });

  test("GET /v1/hello returns identity, assignments, sessions, and protocol ACK status", async () => {
    const { app, env, enrollFellow, seedProblem, seedMembership, db } = await createTestHarness();
    const fellow = await enrollFellow();

    await seedProblem("P-TEST1", "First Problem");
    await seedProblem("P-TEST2", "Second Problem");
    await seedMembership("P-TEST1", fellow.fellowId, "contributor");
    await seedMembership("P-TEST2", fellow.fellowId, "observer");

    // Open a session on P-TEST1
    const nowIso = new Date().toISOString();
    const sessionId = "S-01H00000000000000000000001";
    await db
      .prepare(
        "INSERT INTO sessions (session_id, problem_id, fellow_id, intent, opened_at, last_heartbeat_at, idle_close_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        sessionId,
        "P-TEST1",
        fellow.fellowId,
        "explore",
        nowIso,
        nowIso,
        new Date(Date.now() + 3600000).toISOString(),
      )
      .run();

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/hello", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    const parsed = EnrollmentHelloResponseSchema.parse(data);

    expect(parsed.fellow.fellow_id).toBe(fellow.fellowId);
    expect(parsed.protocol_acknowledged).toBe(false);
    expect(parsed.protocol_digest).toBeDefined();

    // Check assignments
    expect(parsed.assignments).toBeDefined();
    expect(parsed.assignments?.length).toBe(2);
    const p1 = parsed.assignments?.find((a) => a.problem_id === "P-TEST1");
    expect(p1?.role).toBe("contributor");
    const p2 = parsed.assignments?.find((a) => a.problem_id === "P-TEST2");
    expect(p2?.role).toBe("observer");

    // Check open sessions
    expect(parsed.open_sessions).toBeDefined();
    expect(parsed.open_sessions?.length).toBe(1);
    expect(parsed.open_sessions?.[0]?.session_id).toBe(sessionId);
    expect(parsed.open_sessions?.[0]?.problem_id).toBe("P-TEST1");

    // Check unread reviews is empty array
    expect(parsed.unread_reviews).toEqual([]);

    // Check next_actions includes protocol ACK when not acknowledged
    expect(parsed.next_actions.some((a) => a.action === "protocol.ack")).toBe(true);
  });

  test("POST /v1/protocol/ack validates digest and persists acknowledgment", async () => {
    const { app, env, enrollFellow } = await createTestHarness();
    const fellow = await enrollFellow();

    const expectedDigest = sha256Hex(getDocument("protocol").body);

    // Initial hello: protocol_acknowledged is false
    const helloBefore = await app.fetch(
      new Request("https://a.asimposium.org/v1/hello", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    const helloBeforeData = (await helloBefore.json()) as any;
    expect(helloBeforeData.protocol_acknowledged).toBe(false);
    expect(helloBeforeData.protocol_digest).toBe(expectedDigest);

    // Mismatched digest returns 409
    const ackMismatch = await app.fetch(
      new Request("https://a.asimposium.org/v1/protocol/ack", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fellow.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocol_digest: "0000000000000000000000000000000000000000000000000000000000000000",
        }),
      }),
      env,
    );
    expect(ackMismatch.status).toBe(409);
    const mismatchBody = (await ackMismatch.json()) as any;
    expect(mismatchBody.code).toBe("PROTOCOL_DIGEST_MISMATCH");

    // Correct digest returns 200 and acknowledges
    const ackSuccess = await app.fetch(
      new Request("https://a.asimposium.org/v1/protocol/ack", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fellow.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ protocol_digest: expectedDigest }),
      }),
      env,
    );
    expect(ackSuccess.status).toBe(200);
    const ackBody = await ackSuccess.json();
    const parsedAck = ProtocolAckResponseSchema.parse(ackBody);
    expect(parsedAck.acknowledged).toBe(true);
    expect(parsedAck.fellow_id).toBe(fellow.fellowId);
    expect(parsedAck.protocol_digest).toBe(expectedDigest);
    expect(Date.parse(parsedAck.acknowledged_at)).toBeGreaterThan(0);

    // Subsequent hello shows protocol_acknowledged: true and omits ack_protocol next_action
    const helloAfter = await app.fetch(
      new Request("https://a.asimposium.org/v1/hello", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    const helloAfterData = (await helloAfter.json()) as any;
    expect(helloAfterData.protocol_acknowledged).toBe(true);
    expect(helloAfterData.next_actions.some((a: any) => a.action === "protocol.ack")).toBe(false);

    // Re-acking the same digest is idempotent
    const ackReplay = await app.fetch(
      new Request("https://a.asimposium.org/v1/protocol/ack", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fellow.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ protocol_digest: expectedDigest }),
      }),
      env,
    );
    expect(ackReplay.status).toBe(200);
    const parsedReplay = ProtocolAckResponseSchema.parse(await ackReplay.json());
    expect(parsedReplay.acknowledged).toBe(true);
  });

  test("GET /v1/triage returns hello and a real first-claim move for an empty board", async () => {
    const { app, env, enrollFellow, seedProblem, seedMembership } = await createTestHarness();
    const fellow = await enrollFellow();
    await seedProblem("P-TRIAGE1", "Triage Problem");
    await seedMembership("P-TRIAGE1", fellow.fellowId, "contributor");

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/triage", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    const parsed = TriageResponseSchema.parse(data);

    expect(parsed.hello.fellow.fellow_id).toBe(fellow.fellowId);
    expect(parsed.hello.assignments?.length).toBe(1);
    expect(parsed.degraded).toBe(false);
    expect(parsed.degraded_reason).toBeUndefined();
    expect(parsed.move?.move).toBe("state-claim");
    expect(parsed.move?.refs).toEqual(["P-TRIAGE1"]);
    expect(parsed.selection_boundary).toContain("not a global optimum");
  });

  test("GET /v1/triage with custom provider returns selected move", async () => {
    const candidate: NextMoveCandidate = {
      move: "sharpen-statement",
      why: "The statement needs clearer boundary conditions.",
      refs: ["P-CUSTOM1"],
      contract: { action: "statement_review", schema: "problems:statement_review_request" },
    };
    const fixtureProvider = new ContractFixtureMovesProvider({
      triageMoves: {
        "FL-test-fellow": candidate,
      },
    });

    const { app, env, enrollFellow, seedProblem, seedMembership } = await createTestHarness({
      movesProvider: fixtureProvider,
    });
    const fellow = await enrollFellow();
    await seedProblem("P-CUSTOM1", "Custom Problem");
    await seedMembership("P-CUSTOM1", fellow.fellowId, "contributor");

    // Override the fellow id in triageMoves to match actual fellow
    (fixtureProvider as any).fixtures.triageMoves[fellow.fellowId] = candidate;

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/triage", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    const parsed = TriageResponseSchema.parse(data);

    expect(parsed.degraded).toBe(false);
    expect(parsed.move).toEqual(candidate);
  });

  test("GET /v1/triage.md and Accept: text/markdown return Markdown face with YAML frontmatter", async () => {
    const { app, env, enrollFellow } = await createTestHarness();
    const fellow = await enrollFellow();

    // 1. Via .md URL path
    const resMd = await app.fetch(
      new Request("https://a.asimposium.org/v1/triage.md", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(resMd.status).toBe(200);
    expect(resMd.headers.get("content-type")).toContain("text/markdown");
    const textMd = await resMd.text();
    expect(textMd.startsWith("---")).toBe(true);
    expect(textMd).toContain(`fellow_id: ${fellow.fellowId}`);
    expect(textMd).toContain("# Triage");

    // 2. Via Accept header
    const resAccept = await app.fetch(
      new Request("https://a.asimposium.org/v1/triage", {
        headers: {
          authorization: `Bearer ${fellow.token}`,
          accept: "text/markdown",
        },
      }),
      env,
    );
    expect(resAccept.status).toBe(200);
    expect(resAccept.headers.get("content-type")).toContain("text/markdown");
    const textAccept = await resAccept.text();
    expect(textAccept.startsWith("---")).toBe(true);
  });

  test("GET /v1/p/:id/next returns 404 for unknown problem", async () => {
    const { app, env, enrollFellow } = await createTestHarness();
    const fellow = await enrollFellow();

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-NONEXISTENT/next", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.code).toBe("PROBLEM_NOT_FOUND");
  });

  test("GET /v1/p/:id/next production default returns a workshop-first claim contract", async () => {
    const { app, env, enrollFellow, seedProblem, seedMembership } = await createTestHarness();
    const fellow = await enrollFellow();
    await seedProblem("P-PROD1", "Production Moves Problem");
    await seedMembership("P-PROD1", fellow.fellowId, "contributor");

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-PROD1/next", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    const parsed = ProblemNextResponseSchema.parse(data);

    expect(parsed.problem_id).toBe("P-PROD1");
    expect(parsed.viewer.role).toBe("contributor");
    expect(parsed.viewer.effective_permissions.promote).toBe(true);
    expect(parsed.viewer.effective_permissions.workshop_push).toBe(true);
    expect(parsed.degraded).toBe(false);
    expect(parsed.degraded_reason).toBeUndefined();
    expect(parsed.primary_move?.move).toBe("state-claim");
    expect(parsed.primary_move?.contract.target_contract).toBe("/schemas/sessions.v1.json#/properties/promote_request");
    expect(JSON.stringify(parsed.primary_move?.contract.preparation)).toContain("workshop_first");
    expect(parsed.alternatives).toEqual([]);
  });

  test("GET /v1/p/:id/next filters promotion moves for observer role", async () => {
    const candidates: NextMoveCandidate[] = [
      {
        move: "state-claim",
        why: "A novel lemma can be asserted.",
        refs: ["P-OBS1"],
        contract: { schema: "sessions:promote_request", body: {} },
      },
      {
        move: "review",
        why: "Review unverified claim.",
        refs: ["P-OBS1", "C-1"],
        contract: { schema: "sessions:promote_request", body: {} },
      },
      {
        move: "idle-close",
        why: "No immediate work needed.",
        refs: ["P-OBS1"],
        contract: { schema: "sessions:close_request", body: {} },
      },
    ];

    const fixtureProvider = new ContractFixtureMovesProvider({
      problemMoves: {
        "P-OBS1": candidates,
      },
    });

    const { app, env, enrollFellow, seedProblem, seedMembership } = await createTestHarness({
      movesProvider: fixtureProvider,
    });
    const fellow = await enrollFellow();
    await seedProblem("P-OBS1", "Observer Problem");
    await seedMembership("P-OBS1", fellow.fellowId, "observer");

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-OBS1/next", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    const parsed = ProblemNextResponseSchema.parse(data);

    expect(parsed.viewer.role).toBe("observer");
    // Observers cannot promote claims, but may review under their review scope.
    expect(parsed.viewer.effective_permissions.promote).toBe(false);
    expect(parsed.viewer.effective_permissions.review).toBe(true);

    // Claim-promotion moves MUST be filtered out; review is a separate effect.
    if (parsed.primary_move !== null) {
      expect(PROMOTION_MOVE_KINDS.has(parsed.primary_move.move)).toBe(false);
    }
    for (const alt of parsed.alternatives) {
      expect(PROMOTION_MOVE_KINDS.has(alt.move)).toBe(false);
    }

    // Alphabetical fixture ordering keeps idle-close first, review second.
    expect(parsed.primary_move?.move).toBe("idle-close");
    expect(parsed.alternatives.length).toBe(1);
    expect(parsed.alternatives[0]?.move).toBe("review");
  });

  test("GET /v1/p/:id/next preserves promotion moves for contributor role and caps alternatives at 2", async () => {
    const candidates: NextMoveCandidate[] = [
      {
        move: "state-claim",
        why: "State a new conjecture.",
        refs: ["P-CONTRIB1"],
        contract: { schema: "sessions:promote_request", body: {} },
      },
      {
        move: "add-refuter",
        why: "Propose a refuter.",
        refs: ["P-CONTRIB1"],
        contract: { schema: "sessions:promote_request", body: {} },
      },
      {
        move: "review",
        why: "Review claim C-1.",
        refs: ["P-CONTRIB1", "C-1"],
        contract: { schema: "sessions:promote_request", body: {} },
      },
      {
        move: "idle-close",
        why: "Close idle session.",
        refs: ["P-CONTRIB1"],
        contract: { schema: "sessions:close_request", body: {} },
      },
    ];

    const fixtureProvider = new ContractFixtureMovesProvider({
      problemMoves: {
        "P-CONTRIB1": candidates,
      },
    });

    const { app, env, enrollFellow, seedProblem, seedMembership } = await createTestHarness({
      movesProvider: fixtureProvider,
    });
    const fellow = await enrollFellow();
    await seedProblem("P-CONTRIB1", "Contributor Problem");
    await seedMembership("P-CONTRIB1", fellow.fellowId, "contributor");

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-CONTRIB1/next", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    const parsed = ProblemNextResponseSchema.parse(data);

    expect(parsed.viewer.role).toBe("contributor");
    expect(parsed.viewer.effective_permissions.promote).toBe(true);

    // Candidates are sorted alphabetically by move:
    // 1. add-refuter (primary)
    // 2. idle-close (alternative 1)
    // 3. review (alternative 2)
    // 4. state-claim (dropped because max 2 alternatives)
    expect(parsed.primary_move?.move).toBe("add-refuter");
    expect(parsed.alternatives.length).toBe(2);
    expect(parsed.alternatives[0]?.move).toBe("idle-close");
    expect(parsed.alternatives[1]?.move).toBe("review");
  });

  test("GET /v1/p/:id/next.md returns markdown with effective_permissions in YAML frontmatter", async () => {
    const candidate: NextMoveCandidate = {
      move: "sharpen-statement",
      why: "Sharpen hypotheses.",
      refs: ["P-MD1"],
      contract: { action: "statement_review", schema: "problems:statement_review_request" },
    };
    const fixtureProvider = new ContractFixtureMovesProvider({
      problemMoves: {
        "P-MD1": [candidate],
      },
    });

    const { app, env, enrollFellow, seedProblem, seedMembership } = await createTestHarness({
      movesProvider: fixtureProvider,
    });
    const fellow = await enrollFellow();
    await seedProblem("P-MD1", "Markdown Problem");
    await seedMembership("P-MD1", fellow.fellowId, "contributor");

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-MD1/next.md", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const md = await res.text();

    expect(md.startsWith("---")).toBe(true);
    expect(md).toContain("problem_id: P-MD1");
    expect(md).toContain("effective_permissions:");
    expect(md).toContain("promote: true");
    expect(md).toContain("# Next Recommended Moves for P-MD1");
    expect(md).toContain("## Primary Move: sharpen-statement");
    expect(md).toContain("Sharpen hypotheses.");
  });
});

test("production next accepts canonical hyphenated IDs without inventing scope grants", async () => {
  const { app, env, enrollFellow, seedProblem, seedMembership } = await createTestHarness();
  const fellow = await enrollFellow({ scopes: ["review"] });
  await seedProblem("P-WITH-DASH");
  await seedMembership("P-WITH-DASH", fellow.fellowId, "contributor");
  const response = await app.fetch(new Request("https://a.asimposium.org/v1/p/P-WITH-DASH/next", {
    headers: { authorization: `Bearer ${fellow.token}` },
  }), env);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body = ProblemNextResponseSchema.parse(await response.json());
  expect(body.viewer.effective_permissions.promote).toBe(false);
  expect(body.viewer.effective_permissions.review).toBe(true);
  expect(body.primary_move).toBeNull();
});

test("next does not distinguish a private draft from an unknown public problem", async () => {
  const { app, env, enrollFellow, seedProblem, db } = await createTestHarness();
  const fellow = await enrollFellow();
  await seedProblem("P-PRIVATE");
  await db.prepare("UPDATE problems SET status='private-draft' WHERE id=?").bind("P-PRIVATE").run();
  const bodies = [];
  for (const id of ["P-PRIVATE", "P-ABSENT"]) {
    const response = await app.fetch(new Request(`https://a.asimposium.org/v1/p/${id}/next`, {
      headers: { authorization: `Bearer ${fellow.token}` },
    }), env);
    expect(response.status).toBe(404);
    bodies.push(await response.json());
  }
  expect(bodies[0]).toEqual(bodies[1]);
});
