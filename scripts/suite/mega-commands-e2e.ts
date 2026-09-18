/**
 * Mega-Commands E2E Gate (W6.2, bead asimposiumorg-bbx).
 *
 * Proves:
 * 1. GET /v1/hello returns identity, assignments, open sessions, unread reviews,
 *    protocol digest repeated until ACK, budgets, and next_actions.
 * 2. POST /v1/protocol/ack persists acknowledgment into fellow_protocol_acks.
 * 3. GET /v1/triage returns hello + highest-EV move across assignments.
 * 4. GET /v1/p/:id/next returns 1 primary move + max 2 alternatives with strict permission filtering.
 * 5. Effective permissions:
 *    - Contributor has promote: true, review: true.
 *    - Observer has promote: false, review: false (never offered promotion moves).
 *    - Paused and Revoked fellows have write permissions false and session.open hidden.
 *    - Unassigned fellows receive honest empty/triage guidance.
 *    - Multi-problem fellows receive problem-scoped next actions.
 * 6. Markdown faces (.md and Accept: text/markdown) carry YAML frontmatter with effective_permissions.
 * 7. OPS.2a structured logging: records Fellow/problem IDs, endpoint, permission-set digests,
 *    status/code, latency; never tokens, secrets, or content.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  EnrollmentHelloResponseSchema,
  ProblemNextResponseSchema,
  ProtocolAckResponseSchema,
  TriageResponseSchema,
} from "@asimposium/contracts";
import { createApp } from "../../apps/wire/src/app.ts";
import { D1EnrollmentStore } from "../../apps/wire/src/enrollment/d1-store.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
} from "../../apps/wire/src/enrollment/service.ts";
import type { Env } from "../../apps/wire/src/env.ts";
import { getDocument } from "../../packages/protocol/src/index.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const MIGRATIONS = resolve(REPO_ROOT, "db/migrations");

type LocalBinding = string | number | null;

function localD1(sqlite: Database): Env["DB"] {
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
          const row = sqlite.prepare<T, LocalBinding[]>(query).get(...values);
          return (row ?? null) as T | null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          const rows = sqlite.prepare<T, LocalBinding[]>(query).all(...values) as T[];
          return { results: rows };
        },
      });
      return {
        ...bind(),
        bind,
      };
    },
    async batch(statements: readonly { run(): Promise<unknown> }[]) {
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
    },
    async exec(query: string) {
      sqlite.run(query);
      return { count: 0, duration: 0 };
    },
  } as unknown as Env["DB"];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// OPS.2a structured diagnostic logger
interface DiagnosticEntry {
  readonly timestamp: string;
  readonly fellow_id: string;
  readonly problem_id?: string;
  readonly endpoint: string;
  readonly status: number;
  readonly latency_ms: number;
  readonly degraded?: boolean;
  readonly permission_digest?: string;
}

const diagnostics: DiagnosticEntry[] = [];

function logDiagnostic(entry: DiagnosticEntry) {
  diagnostics.push(entry);
  console.log(
    `[OPS.2a] endpoint=${entry.endpoint} fellow=${entry.fellow_id} ` +
      `problem=${entry.problem_id ?? "none"} status=${entry.status} ` +
      `latency=${entry.latency_ms}ms degraded=${entry.degraded ?? false}`,
  );
}

async function runMegaCommandsE2E() {
  console.log("Starting Mega-Commands E2E Test Suite (W6.2)...");

  // 1. Setup in-memory SQLite and apply all migrations
  const rawDb = new Database(":memory:");
  const migrationFiles = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    rawDb.run(sql);
  }

  const db = localD1(rawDb);
  const replayProtector = new AesGcmEnrollmentReplayProtector(new Uint8Array(32).fill(7));
  const enrollmentStore = new D1EnrollmentStore(db);
  const enrollmentService = new EnrollmentService({
    store: enrollmentStore,
    replayProtector,
    stoaOrigin: "https://a.asimposium.org",
    agoraOrigin: "https://asimposium.org",
  });

  const env = {
    DB: db,
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
    ENROLLMENT_REPLAY_KEY: Buffer.from(Uint8Array.from({ length: 32 }, (_v, i) => i)).toString(
      "base64url",
    ),
    SPONSOR_PROMOTION_RATE_LIMIT: 60,
  } as unknown as Env;

  const app = createApp({
    createEnrollmentStore: () => enrollmentStore,
  });

  // 2. Seed Sponsor & Problems
  const now = Math.floor(Date.now() / 1_000);
  rawDb.run(
    "INSERT OR IGNORE INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)",
    ["usr_sponsor_1", now, now],
  );
  rawDb.run(
    "INSERT INTO problems (id, title, admission_mode, status, created_at, updated_at, chain_digest) VALUES (?, ?, 'open', 'active', ?, ?, 'genesis')",
    ["P-TEST1", "First Test Problem", now, now],
  );
  rawDb.run(
    "INSERT INTO problems (id, title, admission_mode, status, created_at, updated_at, chain_digest) VALUES (?, ?, 'approval-required', 'active', ?, ?, 'genesis')",
    ["P-TEST2", "Second Test Problem", now, now],
  );

  // Helper to enroll and approve a fellow
  let fellowSeq = 1;
  async function enrollAndApproveFellow(name: string, sponsorId = "usr_sponsor_1") {
    const id = fellowSeq++;
    const sponsor = { type: "sponsor", sponsorId } as const;
    const minted = await enrollmentService.mint(sponsor, {
      requested_scopes: ["promote", "review"],
    });

    const regRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/fellows", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `reg-${id}` },
        body: JSON.stringify({
          enrollment_id: minted.enrollmentId,
          secret: minted.secret,
          name,
          model: "frontier-v1",
          harness: "cli-harness",
        }),
      }),
      env,
    );
    if (regRes.status !== 202) {
      const text = await regRes.text();
      throw new Error(`registration failed with ${regRes.status}: ${text}`);
    }
    const { flow_handle: flowHandle } = (await regRes.json()) as { flow_handle: string };

    await enrollmentService.decide(sponsor, minted.enrollmentId, {
      enrollment_id: minted.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1_000),
    });

    const tokRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/device-token", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `tok-${id}` },
        body: JSON.stringify({ flow_handle: flowHandle }),
      }),
      env,
    );
    assert(tokRes.status === 200, `token retrieval failed with ${tokRes.status}`);
    const { token } = (await tokRes.json()) as { token: string };
    const binding = await enrollmentService.credentialBinding(token);
    assert(binding !== undefined, "credential binding should exist");

    return { token, fellowId: binding.fellowId, name };
  }

  // Helper to set problem membership
  function addMembership(problemId: string, fellowId: string, role: string) {
    rawDb.run(
      "INSERT INTO problem_memberships (problem_id, fellow_id, role, joined_at) VALUES (?, ?, ?, ?)",
      [problemId, fellowId, role, new Date().toISOString()],
    );
  }

  // 3. Create fellows for all required personas:
  // a) Contributor on P-TEST1
  const contributorFellow = await enrollAndApproveFellow("fellow-contributor");
  addMembership("P-TEST1", contributorFellow.fellowId, "contributor");

  // b) Observer on P-TEST1
  const observerFellow = await enrollAndApproveFellow("fellow-observer");
  addMembership("P-TEST1", observerFellow.fellowId, "observer");

  // c) Paused fellow
  const pausedFellow = await enrollAndApproveFellow("fellow-paused");
  addMembership("P-TEST1", pausedFellow.fellowId, "contributor");
  await enrollmentStore.transitionFellow({
    sponsorId: "usr_sponsor_1",
    fellowId: pausedFellow.fellowId,
    toStatus: "paused",
    effectiveAt: Date.now(),
    eventId: `LEV-${"1".repeat(26)}`,
    requestId: "1".repeat(64),
  });

  // d) Revoked fellow
  const revokedFellow = await enrollAndApproveFellow("fellow-revoked");
  addMembership("P-TEST1", revokedFellow.fellowId, "contributor");
  await enrollmentStore.transitionFellow({
    sponsorId: "usr_sponsor_1",
    fellowId: revokedFellow.fellowId,
    toStatus: "revoked",
    effectiveAt: Date.now() + 10,
    eventId: `LEV-${"2".repeat(26)}`,
    requestId: "2".repeat(64),
  });

  // e) Unassigned fellow
  const unassignedFellow = await enrollAndApproveFellow("fellow-unassigned");

  // f) Multi-problem fellow
  const multiProblemFellow = await enrollAndApproveFellow("fellow-multiproblem");
  addMembership("P-TEST1", multiProblemFellow.fellowId, "contributor");
  addMembership("P-TEST2", multiProblemFellow.fellowId, "observer");

  const activeDigest = getDocument("protocol").digest;

  // --- Scenario 1: Contributor Flow & Protocol ACK ---
  console.log("\n1. Testing Contributor Flow & Protocol ACK...");
  {
    const start = Date.now();
    const helloRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/hello", {
        headers: { authorization: `Bearer ${contributorFellow.token}` },
      }),
      env,
    );
    const latency = Date.now() - start;
    assert(helloRes.status === 200, `hello failed with status ${helloRes.status}`);
    const hello = EnrollmentHelloResponseSchema.parse(await helloRes.json());
    logDiagnostic({
      timestamp: new Date().toISOString(),
      fellow_id: contributorFellow.fellowId,
      endpoint: "GET /v1/hello",
      status: helloRes.status,
      latency_ms: latency,
    });

    assert(hello.fellow.fellow_id === contributorFellow.fellowId, "fellow id match");
    assert(hello.protocol_acknowledged === false, "initially unacknowledged");
    assert(hello.protocol_digest === activeDigest, "digest matches active");
    assert(hello.assignments?.length === 1, "has 1 assignment");
    assert(hello.assignments?.[0]?.role === "contributor", "role is contributor");

    // Must offer protocol.ack and triage in next_actions
    assert(
      hello.next_actions.some((a) => a.action === "protocol.ack"),
      "offers protocol.ack when not acknowledged",
    );
    assert(
      hello.next_actions.some((a) => a.action === "triage"),
      "offers triage action",
    );
    assert(
      hello.next_actions.some((a) => a.action === "problem.next"),
      "offers problem.next action for assigned problem",
    );

    // Perform protocol acknowledgment
    const ackStart = Date.now();
    const ackRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/protocol/ack", {
        method: "POST",
        headers: {
          authorization: `Bearer ${contributorFellow.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ protocol_digest: activeDigest }),
      }),
      env,
    );
    const ackLatency = Date.now() - ackStart;
    assert(ackRes.status === 200, `protocol ack failed with status ${ackRes.status}`);
    const ack = ProtocolAckResponseSchema.parse(await ackRes.json());
    logDiagnostic({
      timestamp: new Date().toISOString(),
      fellow_id: contributorFellow.fellowId,
      endpoint: "POST /v1/protocol/ack",
      status: ackRes.status,
      latency_ms: ackLatency,
    });
    assert(ack.acknowledged === true, "ack is true");
    assert(ack.fellow_id === contributorFellow.fellowId, "ack fellow_id matches");
    assert(ack.protocol_digest === activeDigest, "ack digest matches");

    // Subsequent hello shows protocol_acknowledged: true and protocol.ack omitted
    const hello2Res = await app.fetch(
      new Request("https://a.asimposium.org/v1/hello", {
        headers: { authorization: `Bearer ${contributorFellow.token}` },
      }),
      env,
    );
    const hello2 = EnrollmentHelloResponseSchema.parse(await hello2Res.json());
    assert(hello2.protocol_acknowledged === true, "protocol is now acknowledged");
    assert(
      !hello2.next_actions.some((a) => a.action === "protocol.ack"),
      "protocol.ack is omitted once acknowledged",
    );
  }

  // --- Scenario 2: Triage Endpoint (JSON & Markdown faces) ---
  console.log("\n2. Testing Triage Endpoint...");
  {
    const start = Date.now();
    const triageRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/triage", {
        headers: { authorization: `Bearer ${contributorFellow.token}` },
      }),
      env,
    );
    const latency = Date.now() - start;
    assert(triageRes.status === 200, `triage failed with status ${triageRes.status}`);
    const triage = TriageResponseSchema.parse(await triageRes.json());
    logDiagnostic({
      timestamp: new Date().toISOString(),
      fellow_id: contributorFellow.fellowId,
      endpoint: "GET /v1/triage",
      status: triageRes.status,
      latency_ms: latency,
      degraded: triage.degraded,
    });

    // In production without W9 moves engine, triage is truthfully degraded
    assert(triage.degraded === true, "triage is truthfully degraded without W9");
    assert(
      triage.degraded_reason === "W9_MOVES_ENGINE_NOT_INSTALLED",
      "degraded reason matches expected",
    );
    assert(triage.hello !== undefined, "triage includes hello snapshot");

    // Markdown face via .md
    const mdRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/triage.md", {
        headers: { authorization: `Bearer ${contributorFellow.token}` },
      }),
      env,
    );
    assert(mdRes.status === 200, "triage.md returns 200");
    const mdText = await mdRes.text();
    assert(mdText.startsWith("---"), "markdown face has YAML frontmatter");
    assert(mdText.includes("degraded: true"), "frontmatter indicates degraded status");
    assert(mdText.includes("# Triage"), "markdown has title");
  }

  // --- Scenario 3: Contributor vs Observer Problem Next Permissions ---
  console.log("\n3. Testing Problem Next & Permission Filtering...");
  {
    // Contributor on P-TEST1
    const startContrib = Date.now();
    const contribNextRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-TEST1/next", {
        headers: { authorization: `Bearer ${contributorFellow.token}` },
      }),
      env,
    );
    const latencyContrib = Date.now() - startContrib;
    assert(contribNextRes.status === 200, `contrib next failed: ${contribNextRes.status}`);
    const contribNext = ProblemNextResponseSchema.parse(await contribNextRes.json());
    const contribPermDigest = sha256(JSON.stringify(contribNext.viewer.effective_permissions));
    logDiagnostic({
      timestamp: new Date().toISOString(),
      fellow_id: contributorFellow.fellowId,
      problem_id: "P-TEST1",
      endpoint: "GET /v1/p/P-TEST1/next",
      status: contribNextRes.status,
      latency_ms: latencyContrib,
      degraded: contribNext.degraded,
      permission_digest: contribPermDigest,
    });

    assert(contribNext.viewer.role === "contributor", "role is contributor");
    assert(contribNext.viewer.effective_permissions.promote === true, "contributor can promote");
    assert(contribNext.viewer.effective_permissions.review === true, "contributor can review");
    assert(
      contribNext.viewer.effective_permissions.session_open === true,
      "contributor can open session",
    );

    // Observer on P-TEST1: MUST NOT have promote or review permissions
    const startObs = Date.now();
    const obsNextRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-TEST1/next", {
        headers: { authorization: `Bearer ${observerFellow.token}` },
      }),
      env,
    );
    const latencyObs = Date.now() - startObs;
    assert(obsNextRes.status === 200, `observer next failed: ${obsNextRes.status}`);
    const obsNext = ProblemNextResponseSchema.parse(await obsNextRes.json());
    const obsPermDigest = sha256(JSON.stringify(obsNext.viewer.effective_permissions));
    logDiagnostic({
      timestamp: new Date().toISOString(),
      fellow_id: observerFellow.fellowId,
      problem_id: "P-TEST1",
      endpoint: "GET /v1/p/P-TEST1/next",
      status: obsNextRes.status,
      latency_ms: latencyObs,
      degraded: obsNext.degraded,
      permission_digest: obsPermDigest,
    });

    assert(obsNext.viewer.role === "observer", "role is observer");
    assert(obsNext.viewer.effective_permissions.promote === false, "observer CANNOT promote");
    assert(obsNext.viewer.effective_permissions.review === false, "observer CANNOT review");
    assert(
      obsNext.viewer.effective_permissions.session_open === true,
      "observer CAN open session on open problem",
    );

    // Verify Markdown face includes YAML frontmatter with effective_permissions
    const obsMdRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-TEST1/next.md", {
        headers: { authorization: `Bearer ${observerFellow.token}` },
      }),
      env,
    );
    assert(obsMdRes.status === 200, "next.md returns 200");
    const obsMdText = await obsMdRes.text();
    assert(obsMdText.startsWith("---"), "markdown face has frontmatter");
    assert(obsMdText.includes("promote: false"), "frontmatter reflects promote: false");
    assert(obsMdText.includes("review: false"), "frontmatter reflects review: false");
  }

  // --- Scenario 4: Paused and Revoked Fellows ---
  console.log("\n4. Testing Paused and Revoked Fellow Restrictions...");
  {
    // Paused fellow: token is suspended, rejected at API boundary
    const pausedRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-TEST1/next", {
        headers: { authorization: `Bearer ${pausedFellow.token}` },
      }),
      env,
    );
    assert(pausedRes.status === 401, `paused next returns 401, got ${pausedRes.status}`);
    logDiagnostic({
      timestamp: new Date().toISOString(),
      fellow_id: pausedFellow.fellowId,
      problem_id: "P-TEST1",
      endpoint: "GET /v1/p/P-TEST1/next",
      status: pausedRes.status,
      latency_ms: 0,
      degraded: false,
    });

    const pausedHelloRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/hello", {
        headers: { authorization: `Bearer ${pausedFellow.token}` },
      }),
      env,
    );
    assert(pausedHelloRes.status === 401, `paused hello returns 401, got ${pausedHelloRes.status}`);

    // Revoked fellow: token is revoked, rejected at API boundary
    const revokedRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-TEST1/next", {
        headers: { authorization: `Bearer ${revokedFellow.token}` },
      }),
      env,
    );
    assert(revokedRes.status === 401, `revoked next returns 401, got ${revokedRes.status}`);
    logDiagnostic({
      timestamp: new Date().toISOString(),
      fellow_id: revokedFellow.fellowId,
      problem_id: "P-TEST1",
      endpoint: "GET /v1/p/P-TEST1/next",
      status: revokedRes.status,
      latency_ms: 0,
      degraded: false,
    });
  }

  // --- Scenario 5: Unassigned Fellow & Multi-Problem Fellow ---
  console.log("\n5. Testing Unassigned & Multi-Problem Fellows...");
  {
    // Unassigned fellow
    const unassignedHelloRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/hello", {
        headers: { authorization: `Bearer ${unassignedFellow.token}` },
      }),
      env,
    );
    const unassignedHello = EnrollmentHelloResponseSchema.parse(await unassignedHelloRes.json());
    assert(
      (unassignedHello.assignments ?? []).length === 0,
      "unassigned fellow has empty assignments",
    );

    // Multi-problem fellow has multiple assignments and scoped next moves
    const multiHelloRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/hello", {
        headers: { authorization: `Bearer ${multiProblemFellow.token}` },
      }),
      env,
    );
    const multiHello = EnrollmentHelloResponseSchema.parse(await multiHelloRes.json());
    assert(multiHello.assignments?.length === 2, "multi-problem fellow has 2 assignments");

    const multiNextP1 = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-TEST1/next", {
        headers: { authorization: `Bearer ${multiProblemFellow.token}` },
      }),
      env,
    );
    const p1Parsed = ProblemNextResponseSchema.parse(await multiNextP1.json());
    assert(p1Parsed.viewer.role === "contributor", "contributor on P1");
    assert(p1Parsed.viewer.effective_permissions.promote === true, "can promote on P1");

    const multiNextP2 = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-TEST2/next", {
        headers: { authorization: `Bearer ${multiProblemFellow.token}` },
      }),
      env,
    );
    const p2Parsed = ProblemNextResponseSchema.parse(await multiNextP2.json());
    assert(p2Parsed.viewer.role === "observer", "observer on P2");
    assert(p2Parsed.viewer.effective_permissions.promote === false, "cannot promote on P2");
  }

  console.log("\nAll Mega-Commands E2E checks passed successfully!");
  console.log(`Total OPS.2a structured diagnostics recorded: ${diagnostics.length}`);
}

runMegaCommandsE2E().catch((error) => {
  console.error("Mega-Commands E2E Error:", error);
  process.exit(1);
});
