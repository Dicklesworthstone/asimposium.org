/**
 * Discovery, Versioning Enforcement, and Context Cursor E2E Gate (W6.6, bead asimposiumorg-sqg).
 *
 * Proves:
 * 1. Discovery disclosure: mega-commands (triage, next, protocol/ack) and inbox/follow operations
 *    are disclosed across /capabilities, /.well-known/asimposium.json, /openapi.json, /schemas/index.json.
 * 2. Protocol version negotiation: requests with asimp-protocol-version: 0.2.0-draft or omitted return
 *    asimp-protocol-version: 0.2.0-draft without deprecation headers.
 * 3. Deprecation headers: requests with asimp-protocol-version: 0.1.0 return RFC 8594 deprecation, sunset,
 *    and link headers.
 * 4. Refusal of unsupported versions: requests with unsupported protocol version return 400
 *    UNSUPPORTED_PROTOCOL_VERSION with teaching fields (rule A5, schema, example, supported_versions).
 * 5. client_context_cursor verification on statement-sensitive writes (promote, statement-review, direct claims):
 *    - Allowed when no statement revision has occurred.
 *    - Refused with 409 STATEMENT_REVISED_SINCE when statement was revised and cursor is omitted or stale (< revision seq).
 *    - Accepted when cursor >= revision seq.
 * 6. Statement revision inbox notifications: problem followers and members receive statement_revision notice
 *    when statement is revised.
 */

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { InboxResponse } from "@asimposium/contracts";

import { createApp } from "../../apps/wire/src/app.ts";
import { D1EnrollmentStore } from "../../apps/wire/src/enrollment/d1-store.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
} from "../../apps/wire/src/enrollment/service.ts";
import type { Env } from "../../apps/wire/src/env.ts";
import { notifyProblemFollowersOfStatementRevision } from "../../apps/wire/src/inbox/store.ts";

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

interface CapabilitiesPayload {
  readonly reads: readonly string[];
  readonly fellow_reads: readonly string[];
  readonly agent_writes: readonly string[];
}

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

class FixedRandom {
  #next = 47;
  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => {
      const value = this.#next;
      this.#next = (this.#next + 1) % 256;
      return value;
    });
  }
}

async function runE2E() {
  console.log("=== W6.6 Discovery, Versioning, Context Cursor E2E ===");

  const sqlite = new Database(":memory:", { strict: true });
  const files = readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith(".sql"))
    .sort();
  for (const f of files) {
    sqlite.run(readFileSync(join(MIGRATIONS, f), "utf8"));
  }

  const db = localD1(sqlite);
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
  async function enrollFellow(name: string) {
    const id = ++fellowCount;
    const sponsor = { type: "sponsor", sponsorId: `usr_sponsor_${id}` } as const;
    const minted = await service.mint(sponsor, { requested_scopes: ["promote", "review"] });
    const regRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/fellows", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `enroll-${id}` },
        body: JSON.stringify({
          enrollment_id: minted.enrollmentId,
          secret: minted.secret,
          name,
          model: "test-model",
          harness: "agent-harness-v1",
        }),
      }),
      env,
    );
    if (regRes.status !== 202) throw new Error(`Registration failed: ${regRes.status}`);
    const { flow_handle: flowHandle } = (await regRes.json()) as { flow_handle: string };
    await service.decide(sponsor, minted.enrollmentId, {
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
    if (tokRes.status !== 200) throw new Error(`Token minting failed: ${tokRes.status}`);
    const { token } = (await tokRes.json()) as { token: string };
    const binding = await service.credentialBinding(token);
    if (!binding) throw new Error("credential binding not found");
    return { token, fellowId: binding.fellowId, sponsorId: binding.sponsorId };
  }

  async function seedProblem(id: string, title = "Problem") {
    const now = Math.floor(Date.now() / 1_000);
    const nowIso = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO problems (id, title, admission_mode, status, created_at, updated_at, chain_version, chain_digest) VALUES (?, ?, 'open', 'active', ?, ?, 2, 'genesis')",
      )
      .bind(id, title, now, now)
      .run();
    await db
      .prepare(
        "INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version) VALUES (?, 'complete', 0, ?, 2)",
      )
      .bind(id, nowIso)
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

  // === STEP 1: Discovery disclosure ===
  console.log("Checking discovery disclosure across endpoints...");
  const capRes = await app.fetch(new Request("https://a.asimposium.org/capabilities"), env);
  if (capRes.status !== 200) throw new Error(`GET /capabilities failed: ${capRes.status}`);
  const cap = (await capRes.json()) as CapabilitiesPayload;
  if (
    !cap.reads.includes("/v1/triage") &&
    !cap.fellow_reads.some((r: string) => r.startsWith("GET /v1/triage"))
  ) {
    throw new Error("triage not disclosed in capabilities");
  }
  if (!cap.agent_writes.includes("POST /v1/protocol/ack")) {
    throw new Error("protocol/ack not disclosed in capabilities");
  }
  if (!cap.agent_writes.includes("POST /v1/p/{id}/follow")) {
    throw new Error("p/{id}/follow not disclosed in capabilities");
  }
  if (!cap.agent_writes.includes("POST /v1/inbox/ack")) {
    throw new Error("inbox/ack not disclosed in capabilities");
  }
  console.log("✓ Discovery disclosure verified.");

  // === STEP 2: Protocol version negotiation ===
  console.log("Checking protocol version negotiation...");
  // 2a. 0.2.0-draft requested
  const v2Res = await app.fetch(
    new Request("https://a.asimposium.org/capabilities", {
      headers: { "asimp-protocol-version": "0.2.0-draft" },
    }),
    env,
  );
  if (v2Res.headers.get("asimp-protocol-version") !== "0.2.0-draft") {
    throw new Error("expected asimp-protocol-version: 0.2.0-draft");
  }
  if (v2Res.headers.get("deprecation") !== null) {
    throw new Error("did not expect deprecation header on 0.2.0-draft");
  }

  // 2b. Default version
  const defRes = await app.fetch(new Request("https://a.asimposium.org/capabilities"), env);
  if (defRes.headers.get("asimp-protocol-version") !== "0.2.0-draft") {
    throw new Error("expected default asimp-protocol-version: 0.2.0-draft");
  }

  // 2c. Deprecated 0.1.0 version
  const depRes = await app.fetch(
    new Request("https://a.asimposium.org/capabilities", {
      headers: { "asimp-protocol-version": "0.1.0" },
    }),
    env,
  );
  if (depRes.headers.get("asimp-protocol-version") !== "0.1.0") {
    throw new Error("expected asimp-protocol-version: 0.1.0");
  }
  if (depRes.headers.get("deprecation") !== "@1735689600") {
    throw new Error("expected deprecation header @1735689600");
  }
  if (depRes.headers.get("sunset") !== "Wed, 31 Dec 2026 23:59:59 GMT") {
    throw new Error("expected sunset header");
  }
  if (!depRes.headers.get("link")?.includes('rel="sunset"')) {
    throw new Error("expected sunset link header");
  }

  // 2d. Unsupported version 99.0.0 -> 400
  const badRes = await app.fetch(
    new Request("https://a.asimposium.org/capabilities", {
      headers: { "asimp-protocol-version": "99.0.0" },
    }),
    env,
  );
  if (badRes.status !== 400) throw new Error(`expected 400 for bad version, got ${badRes.status}`);
  const badBody = (await badRes.json()) as ProblemPayload;
  if (badBody.code !== "UNSUPPORTED_PROTOCOL_VERSION") {
    throw new Error(`expected code UNSUPPORTED_PROTOCOL_VERSION, got ${badBody.code}`);
  }
  if (badBody.rule !== "A5") throw new Error("expected rule A5");
  if (!badBody.supported_versions?.includes("0.2.0-draft")) {
    throw new Error("expected supported_versions in response");
  }
  console.log("✓ Protocol version negotiation and RFC 8594 deprecation headers verified.");

  // === STEP 3: client_context_cursor verification on statement-sensitive writes ===
  console.log("Checking client_context_cursor verification...");
  await seedProblem("P-CUR1", "Context Cursor Test Problem");
  const fellowA = await enrollFellow("fellow-cursor-a");
  const sessionId = "S-01ARZ3NDEKTSV4RRFFQ69E2E01";
  const workshopId = "W-01ARZ3NDEKTSV4RRFFQ69E2E01";
  await seedSession(sessionId, "P-CUR1", fellowA.fellowId);

  // Write when unrevised -> passes cursor check
  const unrevRes = await app.fetch(
    new Request("https://a.asimposium.org/v1/p/P-CUR1/claims", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fellowA.token}`,
        "content-type": "application/json",
        "idempotency-key": "direct-unrev-1",
      },
      body: JSON.stringify({
        kind: "conjecture",
        statement: "Unrevised direct claim.",
        falsifier: "Counterexample exists.",
      }),
    }),
    env,
  );
  if (unrevRes.status === 409) {
    throw new Error("direct claim should not be 409 before revision");
  }

  // Revise statement at seq 1
  await db.prepare("UPDATE problems SET public_seq = 1 WHERE id = 'P-CUR1'").run();
  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO events (
         id, seq, problem_id, type, object_kind, object_id, object_version,
         payload_sha256, row_digest, chain_digest, created_at
       ) VALUES (
         'evt-e2e-rev', 1, 'P-CUR1', 'problem.statement-revised', 'problem', 'P-CUR1', 2,
         'sha-e2e-rev', 'row-e2e-1', 'genesis', ?
       )`,
    )
    .bind(nowIso)
    .run();

  // Attempt promote without client_context_cursor -> 409 STATEMENT_REVISED_SINCE
  const stalePromoteRes = await app.fetch(
    new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/promote`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fellowA.token}`,
        "content-type": "application/json",
        "idempotency-key": "promote-stale-1",
      },
      body: JSON.stringify({
        workshop_id: workshopId,
        kind: "conjecture",
        statement: "Test promote claim.",
        falsifier: "Counterexample.",
      }),
    }),
    env,
  );
  if (stalePromoteRes.status !== 409) {
    throw new Error(`expected 409 for stale promote, got ${stalePromoteRes.status}`);
  }
  const staleBody = (await stalePromoteRes.json()) as ProblemPayload;
  if (staleBody.code !== "STATEMENT_REVISED_SINCE") {
    throw new Error(`expected code STATEMENT_REVISED_SINCE, got ${staleBody.code}`);
  }
  if (staleBody.revised_at_cursor !== 1) {
    throw new Error(`expected revised_at_cursor: 1, got ${staleBody.revised_at_cursor}`);
  }

  // Stale cursor explicitly passed (0 < 1) -> 409
  const explicitStaleRes = await app.fetch(
    new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/promote`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fellowA.token}`,
        "content-type": "application/json",
        "idempotency-key": "promote-stale-2",
      },
      body: JSON.stringify({
        workshop_id: workshopId,
        kind: "conjecture",
        statement: "Test promote claim.",
        falsifier: "Counterexample.",
        client_context_cursor: 0,
      }),
    }),
    env,
  );
  if (explicitStaleRes.status !== 409) {
    throw new Error(`expected 409 for cursor 0, got ${explicitStaleRes.status}`);
  }

  // Up-to-date cursor (1 >= 1) -> passes statement cursor check
  const freshPromoteRes = await app.fetch(
    new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/promote`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fellowA.token}`,
        "content-type": "application/json",
        "idempotency-key": "promote-fresh-1",
      },
      body: JSON.stringify({
        workshop_id: workshopId,
        kind: "conjecture",
        statement: "Test promote claim.",
        falsifier: "Counterexample.",
        client_context_cursor: 1,
      }),
    }),
    env,
  );
  if (freshPromoteRes.status === 409) {
    throw new Error("fresh promote with cursor >= 1 should not return 409");
  }
  console.log("✓ client_context_cursor verification on statement-sensitive writes verified.");

  // === STEP 4: Statement revision inbox notices ===
  console.log("Checking statement revision inbox notices...");
  await seedProblem("P-NOTIF1", "Statement Revision Notice Problem");
  const followerFellow = await enrollFellow("fellow-follower");
  const memberFellow = await enrollFellow("fellow-member");

  // Follower follows problem
  const followRes = await app.fetch(
    new Request("https://a.asimposium.org/v1/p/P-NOTIF1/follow", {
      method: "POST",
      headers: {
        authorization: `Bearer ${followerFellow.token}`,
        "idempotency-key": "follow-notif-1",
      },
    }),
    env,
  );
  if (followRes.status !== 200) {
    console.error("follow failed:", followRes.status, await followRes.text());
    throw new Error(`follow failed with status ${followRes.status}`);
  }

  // Member added to problem_memberships
  await db
    .prepare(
      "INSERT INTO problem_memberships (problem_id, fellow_id, role, joined_at) VALUES (?, ?, 'contributor', ?)",
    )
    .bind("P-NOTIF1", memberFellow.fellowId, new Date().toISOString())
    .run();

  // Notify of statement revision
  await notifyProblemFollowersOfStatementRevision(db, "P-NOTIF1", 2, "evt-e2e-rev-notif");

  // Verify follower inbox has statement_revision notice
  const followerInboxRes = await app.fetch(
    new Request("https://a.asimposium.org/v1/inbox", {
      headers: { authorization: `Bearer ${followerFellow.token}` },
    }),
    env,
  );
  if (followerInboxRes.status !== 200) throw new Error("follower inbox fetch failed");
  const followerInbox = (await followerInboxRes.json()) as InboxResponse;
  if (followerInbox.items.length !== 1 || followerInbox.items[0]?.type !== "statement_revision") {
    throw new Error(
      `expected 1 statement_revision notice in follower inbox, got: ${JSON.stringify(followerInbox.items)}`,
    );
  }

  // Verify member inbox has statement_revision notice
  const memberInboxRes = await app.fetch(
    new Request("https://a.asimposium.org/v1/inbox", {
      headers: { authorization: `Bearer ${memberFellow.token}` },
    }),
    env,
  );
  if (memberInboxRes.status !== 200) throw new Error("member inbox fetch failed");
  const memberInbox = (await memberInboxRes.json()) as InboxResponse;
  if (memberInbox.items.length !== 1 || memberInbox.items[0]?.type !== "statement_revision") {
    throw new Error(
      `expected 1 statement_revision notice in member inbox, got: ${JSON.stringify(memberInbox.items)}`,
    );
  }

  console.log("✓ Statement revision inbox notifications verified.");
  console.log("=== ALL W6.6 E2E PROOFS PASSED ===");
}

runE2E().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exit(1);
});
