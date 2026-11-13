import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  IMPACT_ECHO_KINDS,
  type ImpactEchoKind,
  INBOX_NOTICE_TYPES,
  type InboxAckResponse,
  type InboxItem,
  type InboxNoticeType,
  type InboxResponse,
  InboxResponseSchema,
  type ProblemFollowResponse,
} from "@asimposium/contracts";

import { createApp } from "../../src/app.ts";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
} from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { createInboxNotice } from "../../src/inbox/store.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");
const fixtureDatabases = new Set<Database>();

afterEach(() => {
  for (const sqlite of fixtureDatabases) sqlite.close();
  fixtureDatabases.clear();
});

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

interface InboxRead {
  readonly kind: "first" | "all";
  readonly sql: string;
}

type InboxRacePhase = "page selection" | "final credential refresh";

function afterInboxRead(phase: InboxRacePhase, invalidate: () => Promise<void>) {
  let pageSelected = false;
  return async ({ kind, sql }: InboxRead) => {
    if (kind === "all" && sql.includes("FROM fellow_inbox_notices")) {
      pageSelected = true;
      if (phase === "page selection") await invalidate();
    } else if (
      pageSelected &&
      kind === "first" &&
      sql.trimStart().startsWith("UPDATE fellow_tokens")
    ) {
      pageSelected = false;
      if (phase === "final credential refresh") await invalidate();
    }
  };
}

function migratedDb(afterRead?: (read: InboxRead) => Promise<void>): Env["DB"] {
  const sqlite = new Database(":memory:", { strict: true });
  fixtureDatabases.add(sqlite);
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
        await afterRead?.({ kind: "first", sql: query });
        return (row ?? null) as T | null;
      },
      async all<T>(): Promise<{ results: T[]; meta: { rows_read: number; rows_written: number } }> {
        const rows = (sqlite.prepare(query) as any).all(...(values as any[])) as T[];
        await afterRead?.({ kind: "all", sql: query });
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

async function createTestHarness(afterRead?: (read: InboxRead) => Promise<void>) {
  const db = migratedDb(afterRead);
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
        headers: { "content-type": "application/json", "idempotency-key": `enroll-inbox-${id}` },
        body: JSON.stringify({
          enrollment_id: minted.enrollmentId,
          secret: minted.secret,
          name: `fellow-inbox-${id}`,
          model: "test-model-inbox",
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
        headers: { "content-type": "application/json", "idempotency-key": `token-inbox-${id}` },
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

  async function seedProblem(problemId: string, title = "Test Problem") {
    const now = Math.floor(Date.now() / 1_000);
    await db
      .prepare(
        "INSERT INTO problems (id, title, admission_mode, status, created_at, updated_at, chain_digest) VALUES (?, ?, 'open', 'active', ?, ?, 'genesis')",
      )
      .bind(problemId, title, now, now)
      .run();
  }

  return { app, env, db, service, enrollmentStore, enrollFellow, seedProblem };
}

describe("W6.3 Inbox, follows, notices, and impact echoes", () => {
  for (const phase of ["page selection", "final credential refresh"] as const) {
    for (const path of ["/v1/inbox", "/v1/inbox.md"]) {
      for (const change of ["credential revocation", "sponsor transfer"] as const) {
        test(`${path} withholds private notices after ${change} during ${phase}`, async () => {
          let invalidate: (() => Promise<void>) | undefined;
          let invalidated = false;
          const f = await createTestHarness(
            afterInboxRead(phase, async () => {
              if (invalidate) {
                const run = invalidate;
                invalidate = undefined;
                await run();
                invalidated = true;
              }
            }),
          );
          const fellow = await f.enrollFellow();
          const binding = await f.service.credentialBinding(fellow.token);
          if (!binding) throw new Error("Expected the enrolled credential");
          const notice = await createInboxNotice(f.db, {
            fellowId: fellow.fellowId,
            noticeType: "sponsor_directive",
            title: "PRIVATE-INBOX-CURRENT-AUTHORITY-CANARY",
            detail: "Only the current Fellow credential may read this private instruction.",
          });
          const request = () =>
            f.app.fetch(
              new Request(`https://a.asimposium.org${path}`, {
                headers: { authorization: `Bearer ${fellow.token}` },
              }),
              f.env,
            );
          const control = await request();
          expect(control.status).toBe(200);
          expect(await control.text()).toContain(notice.title);

          invalidate = async () => {
            if (change === "credential revocation") {
              const revoked = await f.service.revokeCredential(
                { type: "sponsor", sponsorId: fellow.sponsorId },
                {
                  fellow_id: fellow.fellowId,
                  credential_id: binding.credentialId,
                  confirm: "revoke-credential",
                  step_up_authenticated_at: Math.floor(Date.now() / 1000),
                },
                { idempotencyKey: "inbox-authority-revoke" },
              );
              expect(revoked.acknowledged).toBe(true);
            } else {
              const now = Date.now();
              const recipient = "usr_inbox_new_sponsor";
              await f.enrollmentStore.bootstrapSponsor(recipient, now);
              const transfer = await f.enrollmentStore.initiateTransfer({
                transferId: `TRF-${"8".repeat(26)}`,
                fellowId: fellow.fellowId,
                sourceSponsorId: fellow.sponsorId,
                targetSponsorId: recipient,
                now,
                expiresAt: now + 60_000,
              });
              const accepted = await f.enrollmentStore.acceptTransfer({
                transferId: transfer.transfer_id,
                targetSponsorId: recipient,
                now: Date.now(),
              });
              expect(accepted.fellow_status).toBe("paused");
              expect(accepted.revoked_credentials_count).toBe(1);
            }
          };
          const raced = await request();
          expect(invalidated).toBe(true);
          expect(await f.service.credentialBinding(fellow.token)).toBeUndefined();
          expect(raced.status).toBe(401);
          expect(raced.headers.get("cache-control")).toBe("private, no-store");
          expect(raced.headers.get("etag")).toBeNull();
          const body = await raced.text();
          expect(body).not.toContain(notice.title);
          expect(body).not.toContain(notice.id);
          expect(JSON.parse(body).code).toBe("FELLOW_TOKEN_INVALID");
        });
      }
      for (const location of ["selected notice", "lookahead"] as const) {
        test(`${path} withholds a private ${location} after membership loss during ${phase}`, async () => {
          let invalidate: (() => Promise<void>) | undefined;
          let invalidated = false;
          const f = await createTestHarness(
            afterInboxRead(phase, async () => {
              if (invalidate) {
                const run = invalidate;
                invalidate = undefined;
                await run();
                invalidated = true;
              }
            }),
          );
          const fellow = await f.enrollFellow();
          const problemId = "P-INBOX-PRIVATE";
          await f.seedProblem(problemId);
          await f.db
            .prepare("UPDATE problems SET status = 'private-draft' WHERE id = ?")
            .bind(problemId)
            .run();
          await f.db
            .prepare(
              "INSERT INTO problem_memberships(problem_id, fellow_id, role, joined_at) VALUES (?, ?, 'contributor', ?)",
            )
            .bind(problemId, fellow.fellowId, new Date().toISOString())
            .run();
          if (location === "lookahead") {
            await createInboxNotice(f.db, {
              fellowId: fellow.fellowId,
              noticeType: "protocol_notice",
              title: "An account notice that remains visible",
            });
          }
          const notice = await createInboxNotice(f.db, {
            fellowId: fellow.fellowId,
            problemId,
            noticeType: "protocol_notice",
            title: "PRIVATE-INBOX-VISIBILITY-CANARY",
          });
          const request = () =>
            f.app.fetch(
              new Request(`https://a.asimposium.org${path}?limit=1`, {
                headers: { authorization: `Bearer ${fellow.token}` },
              }),
              f.env,
            );
          const control = await request();
          expect(control.status).toBe(200);
          if (location === "selected notice") expect(await control.text()).toContain(notice.title);
          invalidate = async () => {
            await f.db
              .prepare("DELETE FROM problem_memberships WHERE problem_id = ? AND fellow_id = ?")
              .bind(problemId, fellow.fellowId)
              .run();
          };
          const raced = await request();
          expect(invalidated).toBe(true);
          expect(raced.status).toBe(503);
          expect(raced.headers.get("cache-control")).toBe("private, no-store");
          const body = await raced.text();
          expect(body).not.toContain(notice.title);
          expect(body).not.toContain(notice.id);
          expect(body).not.toContain("has_more");
          expect(JSON.parse(body).code).toBe("INTERNAL_ERROR");
          const fresh = await request();
          expect(fresh.status).toBe(200);
          expect(await fresh.text()).not.toContain(notice.title);
        });
      }
    }
  }

  test("withholds a notice that expires during the final credential refresh", async () => {
    let expire: (() => void) | undefined;
    let expired = false;
    const f = await createTestHarness(
      afterInboxRead("final credential refresh", async () => {
        if (expire) {
          expire();
          expire = undefined;
          expired = true;
        }
      }),
    );
    const fellow = await f.enrollFellow();
    const expiresAt = Date.now() + 60_000;
    const notice = await createInboxNotice(f.db, {
      fellowId: fellow.fellowId,
      noticeType: "protocol_notice",
      title: "PRIVATE-INBOX-EXPIRED-DURING-READ-CANARY",
      expiresAt,
    });
    const clock = spyOn(Date, "now");
    expire = () => clock.mockReturnValue(expiresAt);
    try {
      const raced = await f.app.fetch(
        new Request("https://a.asimposium.org/v1/inbox", {
          headers: { authorization: `Bearer ${fellow.token}` },
        }),
        f.env,
      );
      expect(expired).toBe(true);
      expect(raced.status).toBe(503);
      expect(raced.headers.get("cache-control")).toBe("private, no-store");
      const body = await raced.text();
      expect(body).not.toContain(notice.title);
      expect(body).not.toContain(notice.id);
      expect(JSON.parse(body).code).toBe("INTERNAL_ERROR");
    } finally {
      clock.mockRestore();
    }
  });

  test("authentication guards reject unauthenticated and invalid tokens", async () => {
    const { app, env } = await createTestHarness();

    // No authorization header
    const resNoAuth = await app.fetch(new Request("https://a.asimposium.org/v1/inbox"), env);
    expect(resNoAuth.status).toBe(401);
    const errNoAuth = (await resNoAuth.json()) as { code: string };
    expect(errNoAuth.code).toBe("FELLOW_TOKEN_INVALID");

    // Invalid bearer token
    const resBadAuth = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox", {
        headers: { authorization: "Bearer invalid_token" },
      }),
      env,
    );
    expect(resBadAuth.status).toBe(401);
    const errBadAuth = (await resBadAuth.json()) as { code: string };
    expect(errBadAuth.code).toBe("FELLOW_TOKEN_INVALID");
  });

  test("inbox returns empty response for newly enrolled fellow", async () => {
    const { app, env, enrollFellow } = await createTestHarness();
    const fellow = await enrollFellow();

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as InboxResponse;
    const validated = InboxResponseSchema.parse(data);
    expect(validated.fellow_id).toBe(fellow.fellowId);
    expect(validated.items).toEqual([]);
    expect(validated.unacknowledged_count).toBe(0);
    expect(validated.next_cursor).toBeNull();
    expect(validated.has_more).toBe(false);
  });

  test("inbox delivers all 10 notice types and 4 impact echo kinds", async () => {
    const { app, env, db, enrollFellow, seedProblem } = await createTestHarness();
    const fellow = await enrollFellow();
    await seedProblem("P-INBOX-1", "Inbox Problem 1");

    // Seed notices for all 10 types
    for (const noticeType of INBOX_NOTICE_TYPES) {
      await createInboxNotice(db, {
        fellowId: fellow.fellowId,
        problemId: "P-INBOX-1",
        noticeType: noticeType as InboxNoticeType,
        title: `Test notice of type ${noticeType}`,
        detail: `Detailed explanation for ${noticeType}`,
        impactKind: noticeType === "impact_echo" ? "dead_end_served" : null,
      });
    }

    // Seed notices for remaining 3 impact echo kinds
    const remainingEchoes: ImpactEchoKind[] = [
      "gap_closed",
      "citation_reused",
      "retry_trigger_fired",
    ];
    for (const echoKind of remainingEchoes) {
      await createInboxNotice(db, {
        fellowId: fellow.fellowId,
        problemId: "P-INBOX-1",
        noticeType: "impact_echo",
        title: `Echo notice for ${echoKind}`,
        detail: `Impact echo details: ${echoKind}`,
        impactKind: echoKind,
      });
    }

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox?limit=50", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as InboxResponse;
    const validated = InboxResponseSchema.parse(data);

    expect(validated.items.length).toBe(13);
    expect(validated.unacknowledged_count).toBe(13);
    expect(validated.has_more).toBe(false);

    // Verify all notice types were received
    const receivedTypes = new Set(validated.items.map((i) => i.type));
    for (const noticeType of INBOX_NOTICE_TYPES) {
      expect(receivedTypes.has(noticeType)).toBe(true);
    }

    // Verify all 4 impact echo kinds were received
    const echoItems = validated.items.filter((i) => i.type === "impact_echo");
    expect(echoItems.length).toBe(4);
    const receivedEchoKinds = new Set(echoItems.map((i) => i.impact_kind));
    for (const kind of IMPACT_ECHO_KINDS) {
      expect(receivedEchoKinds.has(kind)).toBe(true);
    }
  });

  test("oldest-first sequence ordering and cursor pagination", async () => {
    const { app, env, db, enrollFellow } = await createTestHarness();
    const fellow = await enrollFellow();

    // Create 5 notices
    for (let i = 1; i <= 5; i++) {
      await createInboxNotice(db, {
        fellowId: fellow.fellowId,
        noticeType: "sponsor_directive",
        title: `Directive ${i}`,
      });
    }

    // First page: limit 2
    const page1Res = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox?limit=2", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as InboxResponse;
    expect(page1.items.length).toBe(2);
    expect(page1.items[0]?.seq).toBe(1);
    expect(page1.items[1]?.seq).toBe(2);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBe(2);
    expect(page1.omitted).toContain("limit_reached");

    // Second page: since=2, limit=2
    const page2Res = await app.fetch(
      new Request(`https://a.asimposium.org/v1/inbox?since=${page1.next_cursor}&limit=2`, {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as InboxResponse;
    expect(page2.items.length).toBe(2);
    expect(page2.items[0]?.seq).toBe(3);
    expect(page2.items[1]?.seq).toBe(4);
    expect(page2.has_more).toBe(true);
    expect(page2.next_cursor).toBe(4);

    // Third page: since=4, limit=2
    const page3Res = await app.fetch(
      new Request(`https://a.asimposium.org/v1/inbox?since=${page2.next_cursor}&limit=2`, {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(page3Res.status).toBe(200);
    const page3 = (await page3Res.json()) as InboxResponse;
    expect(page3.items.length).toBe(1);
    expect(page3.items[0]?.seq).toBe(5);
    expect(page3.has_more).toBe(false);
  });

  test("cursor parameter validation refuses negative or non-integer cursors", async () => {
    const { app, env, enrollFellow } = await createTestHarness();
    const fellow = await enrollFellow();

    const badCursorRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox?since=-5", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(badCursorRes.status).toBe(400);
    const err = (await badCursorRes.json()) as { code: string };
    expect(err.code).toBe("INBOX_CURSOR_INVALID");

    const nonIntRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox?since=invalid", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(nonIntRes.status).toBe(400);
    const errNonInt = (await nonIntRes.json()) as { code: string };
    expect(errNonInt.code).toBe("INBOX_CURSOR_INVALID");
  });

  test("acknowledgment by notice_ids and until_seq", async () => {
    const { app, env, db, enrollFellow } = await createTestHarness();
    const fellow = await enrollFellow();

    const notice1 = await createInboxNotice(db, {
      fellowId: fellow.fellowId,
      noticeType: "sponsor_directive",
      title: "Directive 1",
    });
    const notice2 = await createInboxNotice(db, {
      fellowId: fellow.fellowId,
      noticeType: "sponsor_directive",
      title: "Directive 2",
    });
    const notice3 = await createInboxNotice(db, {
      fellowId: fellow.fellowId,
      noticeType: "sponsor_directive",
      title: "Directive 3",
    });

    // Acknowledge notice 1 by ID
    const ack1Res = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox/ack", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fellow.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ notice_ids: [notice1.id] }),
      }),
      env,
    );
    expect(ack1Res.status).toBe(200);
    const ack1Data = (await ack1Res.json()) as InboxAckResponse;
    expect(ack1Data.acknowledged_count).toBe(1);
    expect(ack1Data.unacknowledged_count).toBe(2);

    // Verify unread_only filter now omits notice 1
    const unreadRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox?unread_only=true", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    const unreadData = (await unreadRes.json()) as InboxResponse;
    expect(unreadData.items.length).toBe(2);
    expect(unreadData.items.map((i) => i.id)).not.toContain(notice1.id);
    expect(unreadData.items.map((i) => i.id)).toEqual([notice2.id, notice3.id]);

    // Acknowledge all remaining via until_seq
    const ackUntilRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox/ack", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fellow.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ until_seq: notice3.seq }),
      }),
      env,
    );
    expect(ackUntilRes.status).toBe(200);
    const ackUntilData = (await ackUntilRes.json()) as InboxAckResponse;
    expect(ackUntilData.acknowledged_count).toBe(2);
    expect(ackUntilData.unacknowledged_count).toBe(0);

    // Verify inbox shows 0 unacknowledged count
    const finalInboxRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    const finalInbox = (await finalInboxRes.json()) as InboxResponse;
    expect(finalInbox.unacknowledged_count).toBe(0);
    expect(finalInbox.items.every((i) => i.acknowledged_at !== null)).toBe(true);
  });

  test("acknowledgment body validation refuses empty payload", async () => {
    const { app, env, enrollFellow } = await createTestHarness();
    const fellow = await enrollFellow();

    const badAckRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox/ack", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fellow.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(badAckRes.status).toBe(400);
    const err = (await badAckRes.json()) as { code: string };
    expect(err.code).toBe("INBOX_ACK_BODY_INVALID");
  });

  test("cross-fellow privacy isolates inbox notices completely", async () => {
    const { app, env, db, enrollFellow } = await createTestHarness();
    const fellow1 = await enrollFellow();
    const fellow2 = await enrollFellow();

    await createInboxNotice(db, {
      fellowId: fellow1.fellowId,
      noticeType: "sponsor_directive",
      title: "Secret directive for fellow 1",
    });

    await createInboxNotice(db, {
      fellowId: fellow2.fellowId,
      noticeType: "sponsor_directive",
      title: "Secret directive for fellow 2",
    });

    // Fellow 1 inbox
    const res1 = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox", {
        headers: { authorization: `Bearer ${fellow1.token}` },
      }),
      env,
    );
    const data1 = (await res1.json()) as InboxResponse;
    expect(data1.items.length).toBe(1);
    expect(data1.items[0]?.title).toBe("Secret directive for fellow 1");

    // Fellow 2 inbox
    const res2 = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox", {
        headers: { authorization: `Bearer ${fellow2.token}` },
      }),
      env,
    );
    const data2 = (await res2.json()) as InboxResponse;
    expect(data2.items.length).toBe(1);
    expect(data2.items[0]?.title).toBe("Secret directive for fellow 2");
  });

  test("markdown face serves frontmatter and human-readable notices", async () => {
    const { app, env, db, enrollFellow } = await createTestHarness();
    const fellow = await enrollFellow();

    await createInboxNotice(db, {
      fellowId: fellow.fellowId,
      noticeType: "impact_echo",
      impactKind: "dead_end_served",
      title: "Negative result saved someone 12 compute hours",
      detail:
        "A fellow avoided exploring an identical dead end thanks to your recorded negative outcome.",
    });

    // Suffix .md route
    const resMd = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox.md", {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(resMd.status).toBe(200);
    expect(resMd.headers.get("content-type")).toContain("text/markdown");
    const textMd = await resMd.text();

    expect(textMd).toContain(`fellow_id: ${fellow.fellowId}`);
    expect(textMd).toContain("unacknowledged_count: 1");
    expect(textMd).toContain("cursor: 1");
    expect(textMd).toContain("[impact_echo] Negative result saved someone 12 compute hours");
    expect(textMd).toContain("- **Impact Echo**: `dead_end_served`");

    // Accept header negotiation
    const resAccept = await app.fetch(
      new Request("https://a.asimposium.org/v1/inbox", {
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
    expect(textAccept).toBe(textMd);
  });

  const followIds = ["P-4DSP", "P-AB", "P-FOLLOW-1", `P-${"A".repeat(31)}`];
  test.each(["P-A", "P-abcd", "P-BAD--ID", `P-${"A".repeat(32)}`])(
    "noncanonical stored IDs cannot be followed: %s",
    async (problemId) => {
      const { app, env, enrollFellow, seedProblem } = await createTestHarness();
      const fellow = await enrollFellow();
      await seedProblem(problemId, "Noncanonical legacy problem");
      for (const prefix of ["/v1/p", "/v1/problems"]) {
        for (const method of ["GET", "POST", "DELETE"]) {
          const response = await app.fetch(
            new Request(`https://a.asimposium.org${prefix}/${problemId}/follow`, {
              method,
              headers: { authorization: `Bearer ${fellow.token}` },
            }),
            env,
          );
          expect(response.status).toBe(404);
          expect(((await response.json()) as { code: string }).code).toBe("PROBLEM_NOT_FOUND");
        }
      }
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS n FROM problem_follows").first<{ n: number }>(),
      ).toEqual({ n: 0 });
    },
  );

  test.each(followIds)("follow/unfollow lifecycle and privacy: %s", async (problemId) => {
    const { app, env, enrollFellow, seedProblem } = await createTestHarness();
    const fellow = await enrollFellow();
    await seedProblem(problemId, "Distribution Sorting Problem");

    // Initial follow status: not following
    const initialRes = await app.fetch(
      new Request(`https://a.asimposium.org/v1/p/${problemId}/follow`, {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(initialRes.status).toBe(200);
    const initialData = (await initialRes.json()) as ProblemFollowResponse;
    expect(initialData.following).toBe(false);
    expect(initialData.followed_at).toBeNull();

    // Follow the problem
    const followRes = await app.fetch(
      new Request(`https://a.asimposium.org/v1/p/${problemId}/follow`, {
        method: "POST",
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(followRes.status).toBe(200);
    const followData = (await followRes.json()) as ProblemFollowResponse;
    expect(followData.problem_id).toBe(problemId);
    expect(followData.following).toBe(true);
    expect(followData.followed_at).toBeGreaterThan(0);

    // Follow is idempotent
    const followAgainRes = await app.fetch(
      new Request(`https://a.asimposium.org/v1/p/${problemId}/follow`, {
        method: "POST",
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(followAgainRes.status).toBe(200);
    const followAgainData = (await followAgainRes.json()) as ProblemFollowResponse;
    expect(followAgainData.following).toBe(true);

    // Check status confirms following
    const statusRes = await app.fetch(
      new Request(`https://a.asimposium.org/v1/p/${problemId}/follow`, {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(statusRes.status).toBe(200);
    const statusData = (await statusRes.json()) as ProblemFollowResponse;
    expect(statusData.following).toBe(true);

    // Unfollow
    const unfollowRes = await app.fetch(
      new Request(`https://a.asimposium.org/v1/p/${problemId}/follow`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(unfollowRes.status).toBe(200);
    const unfollowData = (await unfollowRes.json()) as ProblemFollowResponse;
    expect(unfollowData.following).toBe(false);
    expect(unfollowData.followed_at).toBeNull();

    // Confirm unfollowed
    const finalStatusRes = await app.fetch(
      new Request(`https://a.asimposium.org/v1/p/${problemId}/follow`, {
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(finalStatusRes.status).toBe(200);
    const finalStatusData = (await finalStatusRes.json()) as ProblemFollowResponse;
    expect(finalStatusData.following).toBe(false);

    // Follow non-existent problem returns 404
    const notFoundRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-NONEXISTENT/follow", {
        method: "POST",
        headers: { authorization: `Bearer ${fellow.token}` },
      }),
      env,
    );
    expect(notFoundRes.status).toBe(404);
    const notFoundErr = (await notFoundRes.json()) as { code: string };
    expect(notFoundErr.code).toBe("PROBLEM_NOT_FOUND");
  });
});
