import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EnrollmentHelloResponseSchema, PackResponseSchema } from "@asimposium/contracts";
import { createApp } from "../../src/app";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
  InMemoryEnrollmentStore,
} from "../../src/enrollment/service";
import type { Env } from "../../src/env";
import { genesisChainDigest } from "../../src/krater/krater";
import { syntheticScreeningObservation } from "../support/screening";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

class FixedRandom {
  #next = 11;
  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => {
      const val = this.#next;
      this.#next = (this.#next + 1) % 256;
      return val;
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
        } catch (err) {
          sqlite.run("ROLLBACK");
          throw err;
        }
      });
      batchTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  } as unknown as Env["DB"];
}

interface TestHarnessOptions {
  readonly sponsorLimit?: string | number;
  readonly screenDecision?: "pass" | "reject" | "quarantine";
}

async function createQuotaTestHarness(options: TestHarnessOptions = {}) {
  let classifierInvocations = 0;
  const db = migratedDb();
  const now = Date.now();
  const genesis = await genesisChainDigest("P-4DSP");
  await db
    .prepare(
      "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_digest, chain_version) VALUES ('P-4DSP', 0, ?, ?, ?, 2)",
    )
    .bind(now, now, genesis)
    .run();
  await db
    .prepare(
      "INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version) VALUES ('P-4DSP', 'complete', 0, ?, 2)",
    )
    .bind(now)
    .run();

  const random = new FixedRandom();
  const replayProtector = new AesGcmEnrollmentReplayProtector(
    Uint8Array.from({ length: 32 }, (_, i) => i),
    random,
  );
  const store = new InMemoryEnrollmentStore();
  const service = new EnrollmentService({
    stoaOrigin: "https://a-staging.asimposium.org",
    agoraOrigin: "https://staging.asimposium.org",
    store,
    replayProtector,
  });

  const screenPromotion = async (input: any) => {
    classifierInvocations++;
    const decision = options.screenDecision ?? "pass";
    const observation = await syntheticScreeningObservation(input, {
      decision,
      coarse_category: decision === "pass" ? "benign-context" : "operational-harm",
      provider_status: "ok",
    });
    return observation;
  };

  const env: Env = {
    DB: db,
    STOA_ORIGIN: "https://a-staging.asimposium.org",
    AGORA_ORIGIN: "https://staging.asimposium.org",
    ENROLLMENT_REPLAY_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString(
      "base64url",
    ),
    SPONSOR_PROMOTION_RATE_LIMIT: options.sponsorLimit,
  } as unknown as Env;

  const app = createApp({
    screenPromotion,
  });

  async function registerFellow(suffix: string, sponsorId: string = "usr_quota_test") {
    const sponsor = { type: "sponsor" as const, sponsorId };
    const minted = await service.mint(sponsor, {
      requested_scopes: ["promote", "review"],
      problem_binding: "P-4DSP",
    });

    const regRes = await enrollmentRouter.fetch(
      new Request("https://a-staging.asimposium.org/v1/fellows", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `${suffix}-reg` },
        body: JSON.stringify({
          enrollment_id: minted.enrollmentId,
          secret: minted.secret,
          name: `${suffix}-fellow`,
          model: "synthetic-model-v1",
          harness: "synthetic-harness-v1",
        }),
      }),
      env,
    );
    expect(regRes.status).toBe(202);
    const { flow_handle } = (await regRes.json()) as { flow_handle: string };

    await service.decide(sponsor, minted.enrollmentId, {
      enrollment_id: minted.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });

    const tokenRes = await enrollmentRouter.fetch(
      new Request("https://a-staging.asimposium.org/v1/device-token", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `${suffix}-tok` },
        body: JSON.stringify({ flow_handle }),
      }),
      env,
    );
    expect(tokenRes.status).toBe(200);
    const { token } = (await tokenRes.json()) as { token: string };

    // Seed credential in D1
    const binding = await service.credentialBinding(token);
    if (!binding) throw new Error("binding missing");

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
            granted_scopes_json, granted_resources_json, issued_at, expires_at, credential_origin)
         SELECT ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'harness-migration'
         WHERE NOT EXISTS (
           SELECT 1 FROM fellow_tokens WHERE credential_id = ? OR token_hash = ?
         )`,
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
        binding.credentialId,
        binding.tokenHash,
      )
      .run();

    const call = (path: string, init: RequestInit = {}) =>
      app.fetch(
        new Request(`https://a-staging.asimposium.org${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${token}`,
            ...(init.headers ?? {}),
          },
        }),
        env,
      );

    return { token, binding, call };
  }

  return {
    db,
    env,
    app,
    registerFellow,
    getClassifierInvocations: () => classifierInvocations,
  };
}

describe("integration: mounted public-write rate limiting with durable budgets", () => {
  test("20 promotions allowed, 21st rejected with 429, synthetic classifier called 0 times on 21st", async () => {
    const harness = await createQuotaTestHarness();
    const fellow = await harness.registerFellow("quota-producer");

    // Open session
    const openRes = await fellow.call("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "ses-open" },
      body: JSON.stringify({ problem_id: "P-4DSP", intent: "prove" }),
    });
    if (openRes.status !== 201) {
      console.error("openRes failed:", openRes.status, await openRes.text());
    }
    expect(openRes.status).toBe(201);
    const { session_id } = (await openRes.json()) as { session_id: string };

    // Execute 20 successful promotions
    for (let i = 0; i < 20; i++) {
      const draftRes = await fellow.call(`/v1/sessions/${session_id}/workshop`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `draft-${i}` },
        body: JSON.stringify({
          type: "draft",
          title: `Draft ${i}`,
          body_md: `Content ${i}`,
          relates_to: [],
        }),
      });
      expect(draftRes.status).toBe(201);
      const { workshop_id } = (await draftRes.json()) as { workshop_id: string };

      const promRes = await fellow.call(`/v1/sessions/${session_id}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `promote-${i}` },
        body: JSON.stringify({
          workshop_id,
          kind: "theorem",
          statement: `Statement ${i}`,
          relates_to: [],
        }),
      });
      expect(promRes.status).toBe(201);
    }

    // Classifier was invoked exactly 20 times
    expect(harness.getClassifierInvocations()).toBe(20);

    // 21st promotion must return 429 PROMOTION_RATE_LIMITED
    const draft21Res = await fellow.call(`/v1/sessions/${session_id}/workshop`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "draft-21" },
      body: JSON.stringify({
        type: "draft",
        title: "Draft 21",
        body_md: "Content 21",
        relates_to: [],
      }),
    });
    expect(draft21Res.status).toBe(201);
    const draft21 = (await draft21Res.json()) as { workshop_id: string };

    const overLimitRes = await fellow.call(`/v1/sessions/${session_id}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "promote-21" },
      body: JSON.stringify({
        workshop_id: draft21.workshop_id,
        kind: "theorem",
        statement: "Statement 21 over limit",
        relates_to: [],
      }),
    });

    expect(overLimitRes.status).toBe(429);
    expect(overLimitRes.headers.get("retry-after")).toBeDefined();
    expect(overLimitRes.headers.get("ratelimit-remaining")).toBe("0");

    const problemJson = (await overLimitRes.json()) as Record<string, unknown>;
    expect(problemJson.code).toBe("PROMOTION_RATE_LIMITED");
    expect(problemJson.rule).toBe("A5");
    expect(problemJson.fix_hint).toContain("Keep using the workshop");

    // Proves the synthetic classifier was NOT invoked on the 21st attempt (called 0 times on denied request)
    expect(harness.getClassifierInvocations()).toBe(20);
  });

  test("concurrent contenders for the last slot: exactly 1 succeeds, other gets 429 before classifier", async () => {
    const harness = await createQuotaTestHarness();
    const fellow = await harness.registerFellow("last-slot-producer");

    // Open session
    const openRes = await fellow.call("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "open-slot" },
      body: JSON.stringify({ problem_id: "P-4DSP", intent: "prove" }),
    });
    const { session_id } = (await openRes.json()) as { session_id: string };

    // Consume 19 slots
    for (let i = 0; i < 19; i++) {
      const draftRes = await fellow.call(`/v1/sessions/${session_id}/workshop`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `slot-draft-${i}` },
        body: JSON.stringify({ type: "draft", title: `D ${i}`, body_md: `B ${i}`, relates_to: [] }),
      });
      const { workshop_id } = (await draftRes.json()) as { workshop_id: string };

      const promRes = await fellow.call(`/v1/sessions/${session_id}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `slot-prom-${i}` },
        body: JSON.stringify({ workshop_id, kind: "theorem", statement: `S ${i}`, relates_to: [] }),
      });
      expect(promRes.status).toBe(201);
    }
    expect(harness.getClassifierInvocations()).toBe(19);

    // Prepare 2 drafts for concurrent race to the 20th slot
    const d1Res = await fellow.call(`/v1/sessions/${session_id}/workshop`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "race-draft-1" },
      body: JSON.stringify({ type: "draft", title: "R1", body_md: "B1", relates_to: [] }),
    });
    const d2Res = await fellow.call(`/v1/sessions/${session_id}/workshop`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "race-draft-2" },
      body: JSON.stringify({ type: "draft", title: "R2", body_md: "B2", relates_to: [] }),
    });
    const w1 = ((await d1Res.json()) as { workshop_id: string }).workshop_id;
    const w2 = ((await d2Res.json()) as { workshop_id: string }).workshop_id;

    // Race two promotions concurrently
    const [res1, res2] = await Promise.all([
      fellow.call(`/v1/sessions/${session_id}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "race-prom-1" },
        body: JSON.stringify({
          workshop_id: w1,
          kind: "theorem",
          statement: "Contender 1",
          relates_to: [],
        }),
      }),
      fellow.call(`/v1/sessions/${session_id}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "race-prom-2" },
        body: JSON.stringify({
          workshop_id: w2,
          kind: "theorem",
          statement: "Contender 2",
          relates_to: [],
        }),
      }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 429]);

    // Classifier was invoked exactly 1 more time (for the winning contender)
    expect(harness.getClassifierInvocations()).toBe(20);
  });

  test("concurrent contenders across different fellows under configured sponsor limit", async () => {
    // Set sponsor limit to 1
    const harness = await createQuotaTestHarness({ sponsorLimit: 1 });
    const sharedSponsor = "usr_shared_race";
    const fellowA = await harness.registerFellow("fellow-a", sharedSponsor);
    const fellowB = await harness.registerFellow("fellow-b", sharedSponsor);

    const sesARes = await fellowA.call("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "open-a" },
      body: JSON.stringify({ problem_id: "P-4DSP", intent: "prove" }),
    });
    const sesBRes = await fellowB.call("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "open-b" },
      body: JSON.stringify({ problem_id: "P-4DSP", intent: "prove" }),
    });
    const sesA = (await sesARes.json()) as { session_id: string };
    const sesB = (await sesBRes.json()) as { session_id: string };

    const dARes = await fellowA.call(`/v1/sessions/${sesA.session_id}/workshop`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "da" },
      body: JSON.stringify({ type: "draft", title: "DA", body_md: "BA", relates_to: [] }),
    });
    const dBRes = await fellowB.call(`/v1/sessions/${sesB.session_id}/workshop`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "db" },
      body: JSON.stringify({ type: "draft", title: "DB", body_md: "BB", relates_to: [] }),
    });
    const wA = ((await dARes.json()) as { workshop_id: string }).workshop_id;
    const wB = ((await dBRes.json()) as { workshop_id: string }).workshop_id;

    // Both fellows race for the single sponsor slot
    const [resA, resB] = await Promise.all([
      fellowA.call(`/v1/sessions/${sesA.session_id}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "prom-a" },
        body: JSON.stringify({
          workshop_id: wA,
          kind: "theorem",
          statement: "Fellow A",
          relates_to: [],
        }),
      }),
      fellowB.call(`/v1/sessions/${sesB.session_id}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "prom-b" },
        body: JSON.stringify({
          workshop_id: wB,
          kind: "theorem",
          statement: "Fellow B",
          relates_to: [],
        }),
      }),
    ]);

    expect([resA.status, resB.status].sort()).toEqual([201, 429]);
    expect(harness.getClassifierInvocations()).toBe(1);
  });

  test("replays of completed writes do not consume quota or invoke classifier", async () => {
    const harness = await createQuotaTestHarness();
    const fellow = await harness.registerFellow("replay-fellow");

    const openRes = await fellow.call("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "open-replay" },
      body: JSON.stringify({ problem_id: "P-4DSP", intent: "prove" }),
    });
    const { session_id } = (await openRes.json()) as { session_id: string };

    const draftRes = await fellow.call(`/v1/sessions/${session_id}/workshop`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "draft-replay" },
      body: JSON.stringify({ type: "draft", title: "DR", body_md: "BR", relates_to: [] }),
    });
    const { workshop_id } = (await draftRes.json()) as { workshop_id: string };

    // First promotion commits (201)
    const promRes1 = await fellow.call(`/v1/sessions/${session_id}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "prom-replay-key" },
      body: JSON.stringify({ workshop_id, kind: "theorem", statement: "Original", relates_to: [] }),
    });
    expect(promRes1.status).toBe(201);
    expect(harness.getClassifierInvocations()).toBe(1);

    // Check budget in pack: remaining should be 19
    const pack1 = await fellow.call(`/v1/sessions/${session_id}/pack?profile=working`);
    const packJson1 = PackResponseSchema.parse(await pack1.json());
    expect(packJson1.promotion_budget?.remaining).toBe(19);

    // Exact replay (200)
    const promRes2 = await fellow.call(`/v1/sessions/${session_id}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "prom-replay-key" },
      body: JSON.stringify({ workshop_id, kind: "theorem", statement: "Original", relates_to: [] }),
    });
    expect(promRes2.status).toBe(200);

    // Classifier was NOT invoked again
    expect(harness.getClassifierInvocations()).toBe(1);

    // Budget remains at 19 (did not decrement)
    const pack2 = await fellow.call(`/v1/sessions/${session_id}/pack?profile=working`);
    const packJson2 = PackResponseSchema.parse(await pack2.json());
    expect(packJson2.promotion_budget?.remaining).toBe(19);
  });

  test("rejected requests consume attempt capacity", async () => {
    const harness = await createQuotaTestHarness({ screenDecision: "reject" });
    const fellow = await harness.registerFellow("reject-fellow");

    const openRes = await fellow.call("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "open-rej" },
      body: JSON.stringify({ problem_id: "P-4DSP", intent: "prove" }),
    });
    const { session_id } = (await openRes.json()) as { session_id: string };

    const draftRes = await fellow.call(`/v1/sessions/${session_id}/workshop`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "draft-rej" },
      body: JSON.stringify({ type: "draft", title: "DRJ", body_md: "BRJ", relates_to: [] }),
    });
    const { workshop_id } = (await draftRes.json()) as { workshop_id: string };

    // Promote returns 403 because classifier rejected with policy refusal
    const promRes = await fellow.call(`/v1/sessions/${session_id}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "prom-rej" },
      body: JSON.stringify({ workshop_id, kind: "theorem", statement: "Rejected", relates_to: [] }),
    });
    expect(promRes.status).toBe(403);

    // Pack budget reflects the consumed attempt: remaining is 19
    const packRes = await fellow.call(`/v1/sessions/${session_id}/pack?profile=working`);
    const pack = PackResponseSchema.parse(await packRes.json());
    expect(pack.promotion_budget?.remaining).toBe(19);
  });

  test("hello and pack disclose promotion_budget, and pack omits promote when budget exhausted", async () => {
    const harness = await createQuotaTestHarness();
    const fellow = await harness.registerFellow("budget-visible-fellow");

    // Check GET /v1/hello
    const helloRes = await fellow.call("/v1/hello");
    expect(helloRes.status).toBe(200);
    const hello = EnrollmentHelloResponseSchema.parse(await helloRes.json());
    expect(hello.promotion_budget).toBeDefined();
    expect(hello.promotion_budget?.limit).toBe(20);
    expect(hello.promotion_budget?.remaining).toBe(20);

    // Open session
    const openRes = await fellow.call("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "open-pack-test" },
      body: JSON.stringify({ problem_id: "P-4DSP", intent: "prove" }),
    });
    const { session_id } = (await openRes.json()) as { session_id: string };

    // Initial pack includes promote in next_actions
    const packInitialRes = await fellow.call(`/v1/sessions/${session_id}/pack?profile=working`);
    const packInitial = PackResponseSchema.parse(await packInitialRes.json());
    expect(packInitial.promotion_budget?.remaining).toBe(20);
    expect(packInitial.next_actions.some((a) => a.url.endsWith("/promote"))).toBe(true);

    // Exhaust all 20 attempts
    for (let i = 0; i < 20; i++) {
      const dRes = await fellow.call(`/v1/sessions/${session_id}/workshop`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `d-${i}` },
        body: JSON.stringify({ type: "draft", title: `D${i}`, body_md: `B${i}`, relates_to: [] }),
      });
      const { workshop_id } = (await dRes.json()) as { workshop_id: string };
      await fellow.call(`/v1/sessions/${session_id}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `p-${i}` },
        body: JSON.stringify({ workshop_id, kind: "theorem", statement: `S${i}`, relates_to: [] }),
      });
    }

    // Now pack must show remaining = 0 and OMIT promote from next_actions
    const packExhaustedRes = await fellow.call(`/v1/sessions/${session_id}/pack?profile=working`);
    const packExhausted = PackResponseSchema.parse(await packExhaustedRes.json());
    expect(packExhausted.promotion_budget?.remaining).toBe(0);
    expect(packExhausted.next_actions.some((a) => a.url.endsWith("/promote"))).toBe(false);
    expect(packExhausted.next_actions.some((a) => a.url.endsWith("/workshop"))).toBe(true);
  });
});
