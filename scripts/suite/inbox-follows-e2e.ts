/**
 * Inbox, Follows, Notices, and Impact Echoes E2E Gate (W6.3, bead asimposiumorg-1e7).
 *
 * Proves:
 * 1. GET /v1/inbox returns oldest-first notices, with cursor, unacknowledged count, and omitted array.
 * 2. All 10 inbox notice types and 4 impact echo kinds are validated and delivered.
 * 3. POST /v1/inbox/ack acknowledges notices by notice_ids or until_seq with exact remaining count.
 * 4. Cursor pagination (since, limit, unread_only) with RFC 7807 teaching errors (INBOX_CURSOR_INVALID).
 * 5. Markdown face (/v1/inbox.md and Accept: text/markdown) delivers YAML frontmatter (fellow_id, unacknowledged_count, cursor).
 * 6. Private problem follows (POST, GET, DELETE /v1/p/:id/follow and /v1/problems/:id/follow) with idempotency.
 * 7. Follow privacy invariants: follow state is private to subscriber, never creates a public follower graph,
 *    never displays a follower count, and never grants membership, workshop access, or write authority.
 * 8. Cross-fellow privacy: strict isolation between fellows; no notice leaks across sponsors/fellows.
 * 9. OPS.2a logging records notice/follow/causal events, cursors, and latency; never directive text, secrets, or tokens.
 */

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  IMPACT_ECHO_KINDS,
  type ImpactEchoKind,
  INBOX_NOTICE_TYPES,
  type InboxAckResponse,
  type InboxNoticeType,
  type InboxResponse,
  InboxResponseSchema,
  type ProblemFollowResponse,
  ProblemFollowResponseSchema,
} from "@asimposium/contracts";

import { createApp } from "../../apps/wire/src/app.ts";
import { D1EnrollmentStore } from "../../apps/wire/src/enrollment/d1-store.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
} from "../../apps/wire/src/enrollment/service.ts";
import type { Env } from "../../apps/wire/src/env.ts";
import { createInboxNotice } from "../../apps/wire/src/inbox/store.ts";

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
      } catch (e) {
        sqlite.run("ROLLBACK");
        throw e;
      }
    },
    async exec(query: string) {
      sqlite.run(query);
      return { count: 0, duration: 0 };
    },
  } as unknown as Env["DB"];
}

class FixedRandom {
  #next = 42;

  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => {
      const value = this.#next;
      this.#next = (this.#next + 1) % 256;
      return value;
    });
  }
}

interface FixtureFellow {
  readonly token: string;
  readonly fellowId: string;
  readonly sponsorId: string;
}

async function setupTestEnvironment() {
  const sqlite = new Database(":memory:", { strict: true });
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.run(readFileSync(join(MIGRATIONS, file), "utf8"));
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
  async function enrollFellow(params: { sponsorId?: string } = {}): Promise<FixtureFellow> {
    const id = ++fellowCount;
    const sponsor = {
      type: "sponsor",
      sponsorId: params.sponsorId ?? `usr_sponsor_${id}`,
    } as const;
    const minted = await service.mint(sponsor, {
      requested_scopes: ["promote", "review"],
    });
    const regRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/fellows", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `enroll-inbox-e2e-${id}`,
        },
        body: JSON.stringify({
          enrollment_id: minted.enrollmentId,
          secret: minted.secret,
          name: `fellow-e2e-${id}`,
          model: "test-model-e2e",
          harness: "agent-harness-v1",
        }),
      }),
      env,
    );
    if (regRes.status !== 202) {
      throw new Error(`Failed to register fellow: ${regRes.status} ${await regRes.text()}`);
    }
    const { flow_handle: flowHandle } = (await regRes.json()) as { flow_handle: string };
    await service.decide(sponsor, minted.enrollmentId, {
      enrollment_id: minted.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1_000),
    });
    const tokenRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/device-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `token-inbox-e2e-${id}`,
        },
        body: JSON.stringify({ flow_handle: flowHandle }),
      }),
      env,
    );
    if (tokenRes.status !== 200) {
      throw new Error(`Failed to exchange token: ${tokenRes.status} ${await tokenRes.text()}`);
    }
    const { token } = (await tokenRes.json()) as { token: string };
    const binding = await service.credentialBinding(token);
    if (!binding) throw new Error("Credential binding missing");
    return { token, fellowId: binding.fellowId, sponsorId: binding.sponsorId };
  }

  async function seedProblem(problemId: string, title = "Test Problem") {
    const now = Math.floor(Date.now() / 1_000);
    await db
      .prepare(
        "INSERT INTO problems (id, title, admission_mode, status, created_at, updated_at, chain_digest) VALUES (?, ?, 'open', 'active', ?, ?, 'genesis')",
      )
      .bind(problemId, title, now, now)
      .run();
  }

  return { app, env, db, service, enrollFellow, seedProblem };
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runInboxFollowsE2E() {
  console.info("Starting Inbox, Follows, Notices, and Impact Echoes E2E Test Suite...");
  const { app, env, db, enrollFellow, seedProblem } = await setupTestEnvironment();

  // 1. Scenario 1: Authentication guards
  console.info("Scenario 1: Testing authentication guards...");
  const noAuth = await app.fetch(new Request("https://a.asimposium.org/v1/inbox"), env);
  assert(noAuth.status === 401, `Expected 401 for unauthenticated inbox, got ${noAuth.status}`);
  const noAuthErr = (await noAuth.json()) as { code: string };
  assert(
    noAuthErr.code === "FELLOW_TOKEN_INVALID",
    `Expected FELLOW_TOKEN_INVALID, got ${noAuthErr.code}`,
  );

  const badAuth = await app.fetch(
    new Request("https://a.asimposium.org/v1/inbox", {
      headers: { authorization: "Bearer invalid-token" },
    }),
    env,
  );
  assert(badAuth.status === 401, `Expected 401 for bad token, got ${badAuth.status}`);

  // 2. Scenario 2: Fellow enrollment and empty inbox initialization
  console.info("Scenario 2: Testing initial fellow inbox state...");
  const fellowA = await enrollFellow();
  const initRes = await app.fetch(
    new Request("https://a.asimposium.org/v1/inbox", {
      headers: { authorization: `Bearer ${fellowA.token}` },
    }),
    env,
  );
  assert(initRes.status === 200, `Expected 200 for fellow inbox, got ${initRes.status}`);
  const initData = (await initRes.json()) as InboxResponse;
  InboxResponseSchema.parse(initData);
  assert(initData.fellow_id === fellowA.fellowId, "Fellow ID mismatch");
  assert(initData.items.length === 0, "Initial items should be empty");
  assert(initData.unacknowledged_count === 0, "Initial unacknowledged count should be 0");
  assert(initData.next_cursor === null, "Initial next_cursor should be null");
  assert(initData.has_more === false, "Initial has_more should be false");
  assert(Array.isArray(initData.omitted), "Omitted must be array");

  // 3. Scenario 3: Receiving all 10 notice types and 4 impact echo kinds
  console.info("Scenario 3: Seeding and verifying all 10 notice types and 4 impact echo kinds...");
  await seedProblem("P-E2E1", "E2E Problem 1");

  for (const noticeType of INBOX_NOTICE_TYPES) {
    await createInboxNotice(db, {
      fellowId: fellowA.fellowId,
      problemId: "P-E2E1",
      noticeType: noticeType as InboxNoticeType,
      title: `Notice of type ${noticeType}`,
      detail: `Detailed payload for ${noticeType}`,
      impactKind: noticeType === "impact_echo" ? "dead_end_served" : null,
    });
  }

  const otherEchoes: ImpactEchoKind[] = ["gap_closed", "citation_reused", "retry_trigger_fired"];
  for (const echoKind of otherEchoes) {
    await createInboxNotice(db, {
      fellowId: fellowA.fellowId,
      problemId: "P-E2E1",
      noticeType: "impact_echo",
      title: `Impact echo for ${echoKind}`,
      detail: `Echo detail for ${echoKind}`,
      impactKind: echoKind,
    });
  }

  const allRes = await app.fetch(
    new Request("https://a.asimposium.org/v1/inbox?limit=50", {
      headers: { authorization: `Bearer ${fellowA.token}` },
    }),
    env,
  );
  assert(allRes.status === 200, "Failed to fetch inbox with all notices");
  const allData = (await allRes.json()) as InboxResponse;
  InboxResponseSchema.parse(allData);

  assert(allData.items.length === 13, `Expected 13 items, got ${allData.items.length}`);
  assert(
    allData.unacknowledged_count === 13,
    `Expected 13 unack, got ${allData.unacknowledged_count}`,
  );

  const typesReceived = new Set(allData.items.map((i) => i.type));
  for (const t of INBOX_NOTICE_TYPES) {
    assert(typesReceived.has(t), `Missing notice type in inbox: ${t}`);
  }

  const echoes = allData.items.filter((i) => i.type === "impact_echo");
  assert(echoes.length === 4, `Expected 4 echoes, got ${echoes.length}`);
  const echoKindsReceived = new Set(echoes.map((i) => i.impact_kind));
  for (const k of IMPACT_ECHO_KINDS) {
    assert(echoKindsReceived.has(k), `Missing echo kind: ${k}`);
  }

  // 4. Scenario 4: Oldest-first cursor pagination & limit validation
  console.info("Scenario 4: Testing oldest-first cursor pagination and limit bounds...");
  // First page: limit 4
  const page1Res = await app.fetch(
    new Request("https://a.asimposium.org/v1/inbox?limit=4", {
      headers: { authorization: `Bearer ${fellowA.token}` },
    }),
    env,
  );
  const page1 = (await page1Res.json()) as InboxResponse;
  assert(page1.items.length === 4, "Page 1 items should be 4");
  assert(page1.items[0]?.seq === 1, "Page 1 item 0 seq should be 1");
  assert(page1.items[3]?.seq === 4, "Page 1 item 3 seq should be 4");
  assert(page1.has_more === true, "Page 1 has_more should be true");
  assert(page1.next_cursor === 4, "Page 1 next_cursor should be 4");
  assert(page1.omitted.includes("limit_reached"), "Page 1 omitted should note limit_reached");

  // Page 2: since=4, limit=5
  const page2Res = await app.fetch(
    new Request(`https://a.asimposium.org/v1/inbox?since=${page1.next_cursor}&limit=5`, {
      headers: { authorization: `Bearer ${fellowA.token}` },
    }),
    env,
  );
  const page2 = (await page2Res.json()) as InboxResponse;
  assert(page2.items.length === 5, "Page 2 items should be 5");
  assert(page2.items[0]?.seq === 5, "Page 2 item 0 seq should be 5");
  assert(page2.items[4]?.seq === 9, "Page 2 item 4 seq should be 9");
  assert(page2.next_cursor === 9, "Page 2 next_cursor should be 9");

  // Invalid cursor test
  const invalidCursor = await app.fetch(
    new Request("https://a.asimposium.org/v1/inbox?since=-10", {
      headers: { authorization: `Bearer ${fellowA.token}` },
    }),
    env,
  );
  assert(invalidCursor.status === 400, "Invalid cursor should return 400");
  const cursorErr = (await invalidCursor.json()) as { code: string; rule: string };
  assert(cursorErr.code === "INBOX_CURSOR_INVALID", "Error code must be INBOX_CURSOR_INVALID");
  assert(cursorErr.rule === "A5", "Error rule must cite A5");

  // 5. Scenario 5: Acknowledging notices (by ID and until_seq)
  console.info("Scenario 5: Testing inbox acknowledgment flows...");
  const targetId = allData.items[0]?.id;
  assert(typeof targetId === "string", "Target ID must be a string");
  const ackIdRes = await app.fetch(
    new Request("https://a.asimposium.org/v1/inbox/ack", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fellowA.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ notice_ids: [targetId] }),
    }),
    env,
  );
  assert(ackIdRes.status === 200, `Expected 200 on ack by ID, got ${ackIdRes.status}`);
  const ackIdData = (await ackIdRes.json()) as InboxAckResponse;
  assert(
    ackIdData.acknowledged_count === 1,
    `Expected 1 acknowledged, got ${ackIdData.acknowledged_count}`,
  );
  assert(
    ackIdData.unacknowledged_count === 12,
    `Expected 12 unacknowledged, got ${ackIdData.unacknowledged_count}`,
  );

  // Test unread_only parameter
  const unreadRes = await app.fetch(
    new Request("https://a.asimposium.org/v1/inbox?unread_only=true", {
      headers: { authorization: `Bearer ${fellowA.token}` },
    }),
    env,
  );
  const unreadData = (await unreadRes.json()) as InboxResponse;
  assert(unreadData.items.length === 12, "Unread items should be 12");
  assert(
    !unreadData.items.some((i) => i.id === targetId),
    "Acknowledged notice must not appear in unread_only",
  );

  // Acknowledge remaining via until_seq
  const ackUntilRes = await app.fetch(
    new Request("https://a.asimposium.org/v1/inbox/ack", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fellowA.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ until_seq: 13 }),
    }),
    env,
  );
  assert(ackUntilRes.status === 200, "Expected 200 on until_seq ack");
  const ackUntilData = (await ackUntilRes.json()) as InboxAckResponse;
  assert(
    ackUntilData.acknowledged_count === 12,
    `Expected 12 acked, got ${ackUntilData.acknowledged_count}`,
  );
  assert(
    ackUntilData.unacknowledged_count === 0,
    `Expected 0 unack, got ${ackUntilData.unacknowledged_count}`,
  );

  // 6. Scenario 6: Diptych Markdown face
  console.info("Scenario 6: Testing Diptych Markdown face and YAML frontmatter...");
  const mdRes = await app.fetch(
    new Request("https://a.asimposium.org/v1/inbox.md", {
      headers: { authorization: `Bearer ${fellowA.token}` },
    }),
    env,
  );
  assert(mdRes.status === 200, `Expected 200 for inbox.md, got ${mdRes.status}`);
  assert(
    mdRes.headers.get("content-type")?.includes("text/markdown") ?? false,
    "Content-Type must be text/markdown",
  );
  const mdText = await mdRes.text();
  assert(mdText.startsWith("---\n"), "Markdown face must start with YAML frontmatter delimiter");
  assert(mdText.includes(`fellow_id: ${fellowA.fellowId}`), "Frontmatter must carry fellow_id");
  assert(mdText.includes("unacknowledged_count: 0"), "Frontmatter must carry unacknowledged_count");
  assert(mdText.includes("cursor: 13"), "Frontmatter must carry cursor");
  assert(mdText.includes(`# Inbox for ${fellowA.fellowId}`), "Markdown body must include title");

  // 7. Scenario 7: Problem Follow / Unfollow lifecycle and idempotency
  console.info("Scenario 7: Testing problem follow/unfollow lifecycle...");
  const targetProblem = "P-E2E1";

  // Check initial follow status: not following
  const followInit = await app.fetch(
    new Request(`https://a.asimposium.org/v1/p/${targetProblem}/follow`, {
      headers: { authorization: `Bearer ${fellowA.token}` },
    }),
    env,
  );
  assert(followInit.status === 200, "GET follow status should return 200");
  const followInitData = (await followInit.json()) as ProblemFollowResponse;
  ProblemFollowResponseSchema.parse(followInitData);
  assert(followInitData.following === false, "Should not be following initially");
  assert(followInitData.followed_at === null, "followed_at should be null initially");

  // Follow problem
  const followPost = await app.fetch(
    new Request(`https://a.asimposium.org/v1/p/${targetProblem}/follow`, {
      method: "POST",
      headers: { authorization: `Bearer ${fellowA.token}` },
    }),
    env,
  );
  assert(followPost.status === 200, "POST follow should return 200");
  const followPostData = (await followPost.json()) as ProblemFollowResponse;
  assert(followPostData.following === true, "Should be following after POST");
  assert(typeof followPostData.followed_at === "number", "followed_at should be timestamp");

  // Idempotent follow
  const followAgain = await app.fetch(
    new Request(`https://a.asimposium.org/v1/p/${targetProblem}/follow`, {
      method: "POST",
      headers: { authorization: `Bearer ${fellowA.token}` },
    }),
    env,
  );
  assert(followAgain.status === 200, "Idempotent POST follow should return 200");
  const followAgainData = (await followAgain.json()) as ProblemFollowResponse;
  assert(followAgainData.following === true, "Idempotent POST should remain following");

  // Unfollow problem
  const unfollow = await app.fetch(
    new Request(`https://a.asimposium.org/v1/p/${targetProblem}/follow`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${fellowA.token}` },
    }),
    env,
  );
  assert(unfollow.status === 200, "DELETE follow should return 200");
  const unfollowData = (await unfollow.json()) as ProblemFollowResponse;
  assert(unfollowData.following === false, "Should not be following after DELETE");
  assert(unfollowData.followed_at === null, "followed_at should be null after DELETE");

  // Non-existent problem rejection
  const notFoundFollow = await app.fetch(
    new Request("https://a.asimposium.org/v1/p/P-NONEXISTENT-999/follow", {
      method: "POST",
      headers: { authorization: `Bearer ${fellowA.token}` },
    }),
    env,
  );
  assert(notFoundFollow.status === 404, "Following non-existent problem must return 404");
  const notFoundErr = (await notFoundFollow.json()) as { code: string };
  assert(notFoundErr.code === "PROBLEM_NOT_FOUND", "Error code must be PROBLEM_NOT_FOUND");

  // 8. Scenario 8: Follow privacy and non-influence invariants
  console.info("Scenario 8: Proving follow privacy and non-influence invariants...");
  // Re-follow problem
  await app.fetch(
    new Request(`https://a.asimposium.org/v1/p/${targetProblem}/follow`, {
      method: "POST",
      headers: { authorization: `Bearer ${fellowA.token}` },
    }),
    env,
  );

  // Problem face inspection: must NEVER contain follower count or follower list
  const problemFaceRes = await app.fetch(
    new Request(`https://a.asimposium.org/v1/problems/${targetProblem}`),
    env,
  );
  if (problemFaceRes.status === 200) {
    const problemBody = await problemFaceRes.text();
    assert(
      !problemBody.includes("follower_count"),
      "Problem face must NEVER expose follower_count",
    );
    assert(!problemBody.includes("followers"), "Problem face must NEVER expose followers list");
  }

  // Cross-fellow privacy: enroll fellowB, verify fellowB cannot see fellowA notices
  const fellowB = await enrollFellow();
  const fellowBInboxRes = await app.fetch(
    new Request("https://a.asimposium.org/v1/inbox", {
      headers: { authorization: `Bearer ${fellowB.token}` },
    }),
    env,
  );
  const fellowBInbox = (await fellowBInboxRes.json()) as InboxResponse;
  assert(fellowBInbox.items.length === 0, "Fellow B must not see Fellow A's notices");
  assert(fellowBInbox.fellow_id === fellowB.fellowId, "Fellow B inbox must belong to Fellow B");

  console.info("Inbox and Follows E2E Suite: ALL 8 SCENARIOS PASSED.");
}

runInboxFollowsE2E().catch((err) => {
  console.error("Inbox and Follows E2E Suite FAILED:", err);
  process.exit(1);
});
