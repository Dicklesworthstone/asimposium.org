import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import {
  checkpointDigest,
  eventChainDigest,
  eventChainMatches,
  eventEnvelopeRowDigest,
  genesisChainDigest,
  type KraterEvent,
} from "./krater";
import worker from "./worker";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const HARNESS_CAPABILITY = "a".repeat(64);
const HARNESS_RUN_ID = "b".repeat(32);
const NON_MATCHING_VALUE = "malformed";

function context(): ExecutionContext {
  return {
    passThroughOnException() {},
    waitUntil() {},
  } as unknown as ExecutionContext;
}

function databaseThatMustNotBeTouched(): D1Database {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("S2_TEST_DATABASE_TOUCHED");
      },
    },
  ) as D1Database;
}

function databaseWithCursor(cursor: number): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            first: async () => ({ public_seq: cursor }),
          };
        },
      };
    },
  } as unknown as D1Database;
}

function databaseWithEvents(events: readonly Record<string, unknown>[]): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          if (sql.includes("SELECT public_seq, chain_digest, chain_version FROM problems")) {
            return {
              first: async () => ({
                public_seq: events.length,
                chain_digest: "a".repeat(64),
                chain_version: 2,
              }),
            };
          }
          return {
            all: async () => ({ results: events }),
          };
        },
      };
    },
  } as unknown as D1Database;
}

interface ChangedBuilderReplayFixture {
  readonly body: Readonly<{ readonly problem_id: string }>;
  readonly eventBody: Readonly<{ readonly event_id: string; readonly statement: string }>;
  readonly event: KraterEvent;
  readonly eventRows: readonly Record<string, unknown>[];
  readonly projectionRows: readonly Record<string, unknown>[];
  readonly outboxRows: readonly Record<string, unknown>[];
  readonly cursor: number;
  readonly checkpointDigest: string;
}

async function changedBuilderReplayFixture(): Promise<ChangedBuilderReplayFixture> {
  const body = Object.freeze({ problem_id: "P-v2-builder" });
  const payloadSha256 = "a".repeat(64);
  const eventDraft = {
    eventId: "E-v2-builder",
    problemId: body.problem_id,
    seq: 1,
    type: "claim.created",
    objectKind: "claim",
    objectId: "C-v2-builder",
    objectVersion: 1,
    payloadSha256,
    createdAt: "2026-08-20T00:00:00.000Z",
    actorFellowId: null,
    actorSponsorId: null,
    actorSessionId: null,
    modelStringSelfDeclared: null,
    harness: null,
    writerCredentialId: null,
  } as const;
  const rowDigest = await eventEnvelopeRowDigest(eventDraft);
  const chainDigest = await eventChainDigest(
    body.problem_id,
    1,
    payloadSha256,
    rowDigest,
    await genesisChainDigest(body.problem_id),
  );
  const event: KraterEvent = {
    ...eventDraft,
    rowDigest,
    chainDigest,
    chainVersion: 2,
  };
  const integrityCheckpointDigest = await checkpointDigest(body.problem_id, 1, chainDigest);
  return {
    body,
    eventBody: Object.freeze({
      event_id: event.eventId,
      statement:
        "The durable event body stays identical while a V2 projection builder changes its projection digest.",
    }),
    event,
    eventRows: [
      {
        id: event.eventId,
        problem_id: event.problemId,
        seq: event.seq,
        type: event.type,
        object_kind: event.objectKind,
        object_id: event.objectId,
        object_version: event.objectVersion,
        payload_sha256: event.payloadSha256,
        row_digest: event.rowDigest,
        chain_digest: event.chainDigest,
        chain_version: event.chainVersion,
        created_at: event.createdAt,
        actor_fellow_id: event.actorFellowId,
        actor_sponsor_id: event.actorSponsorId,
        actor_session_id: event.actorSessionId,
        model_string_self_declared: event.modelStringSelfDeclared,
        harness: event.harness,
        writer_credential_id: event.writerCredentialId,
      },
    ],
    // Independently specified V2 output: never call the production projection
    // replay/builder to construct this persisted row or its digest.
    projectionRows: [
      {
        claim_id: "C-v2-builder",
        problem_id: body.problem_id,
        source_seq: 1,
        projection_version: 2,
        build_digest: "v2:independently-specified-projection-digest",
        stale: 0,
      },
    ],
    outboxRows: [{ event_id: event.eventId, kind: "search.index", state: "pending" }],
    cursor: 1,
    checkpointDigest: integrityCheckpointDigest,
  };
}

function replayReadOnlyDatabase(fixture: ChangedBuilderReplayFixture): {
  readonly db: D1Database;
  readonly writeAttempts: () => number;
} {
  let writes = 0;
  const db = {
    prepare(sql: string) {
      if (!sql.trimStart().startsWith("SELECT")) {
        writes += 1;
        throw new Error("S2_TEST_REPLAY_WRITE_FORBIDDEN");
      }
      return {
        bind(...bindings: unknown[]) {
          if (sql.includes("FROM events e") && sql.includes("e.seq > ?")) {
            if (bindings[0] !== fixture.body.problem_id || bindings[1] !== 0) {
              throw new Error("S2_TEST_REPLAY_EVENT_QUERY_MISMATCH");
            }
            return { all: async () => ({ results: fixture.eventRows }) };
          }
          if (sql.includes("SELECT public_seq, chain_digest, chain_version FROM problems")) {
            if (bindings[0] !== fixture.body.problem_id) {
              throw new Error("S2_TEST_REPLAY_HEAD_QUERY_MISMATCH");
            }
            return {
              first: async () => ({
                public_seq: fixture.cursor,
                chain_digest: fixture.event.chainDigest,
                chain_version: 2,
              }),
            };
          }
          if (sql.includes("LEFT JOIN checkpoint_chain_v2 c")) {
            if (bindings[0] !== fixture.body.problem_id) {
              throw new Error("S2_TEST_REPLAY_CHECKPOINT_QUERY_MISMATCH");
            }
            return {
              first: async () => ({
                problem_id: fixture.body.problem_id,
                checkpoint_digest: fixture.checkpointDigest,
                chain_version: 2,
                checkpoint_seq: fixture.cursor,
                root_chain_digest: fixture.event.chainDigest,
                checkpoint_version: 1,
                checkpoint_mode: "unsigned-v0",
              }),
            };
          }
          if (sql.includes("FROM claim_projections WHERE problem_id = ?")) {
            if (bindings[0] !== fixture.body.problem_id) {
              throw new Error("S2_TEST_REPLAY_PROJECTION_QUERY_MISMATCH");
            }
            return { all: async () => ({ results: fixture.projectionRows }) };
          }
          if (sql.includes("SELECT public_seq FROM problems WHERE id = ?")) {
            if (bindings[0] !== fixture.body.problem_id) {
              throw new Error("S2_TEST_REPLAY_CURSOR_QUERY_MISMATCH");
            }
            return { first: async () => ({ public_seq: fixture.cursor }) };
          }
          throw new Error(`S2_TEST_REPLAY_UNEXPECTED_READ: ${sql}`);
        },
      };
    },
    batch() {
      writes += 1;
      throw new Error("S2_TEST_REPLAY_WRITE_FORBIDDEN");
    },
  } as unknown as D1Database;
  return { db, writeAttempts: () => writes };
}

function databaseTouchCounter(): { readonly db: D1Database; readonly touches: () => number } {
  let count = 0;
  return {
    db: new Proxy(
      {},
      {
        get() {
          count += 1;
          throw new Error("S2_TEST_DATABASE_TOUCHED");
        },
      },
    ) as D1Database,
    touches: () => count,
  };
}

interface HarnessEnvOptions {
  capability?: string;
  token?: string;
  runId?: string;
}

function harnessEnv(options: HarnessEnvOptions = {}): Parameters<typeof worker.fetch>[1] {
  const env: Parameters<typeof worker.fetch>[1] = { DB: databaseThatMustNotBeTouched() };
  if (options.capability !== undefined) env.S2_LOCAL_HARNESS = options.capability;
  if (options.token !== undefined) env.S2_HARNESS_TOKEN = options.token;
  if (options.runId !== undefined) env.S2_HARNESS_RUN_ID = options.runId;
  return env;
}

function harnessRequest(
  pathname: string,
  token: string | null = HARNESS_CAPABILITY,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set("x-s2-harness-token", token);
  return new Request(`https://public.example${pathname}`, { ...init, headers });
}

function wranglerConfigs(directory: string): string[] {
  const configs: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const pathname = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") configs.push(...wranglerConfigs(pathname));
      continue;
    }
    if (entry.isFile() && entry.name.includes("wrangler") && entry.name.endsWith(".toml")) {
      configs.push(relative(REPOSITORY_ROOT, pathname));
    }
  }
  return configs;
}

describe("S2 local harness boundary", () => {
  test("capability-absent requests are rejected before body parsing or D1", async () => {
    const env = harnessEnv({ token: HARNESS_CAPABILITY, runId: HARNESS_RUN_ID });
    expect("S2_LOCAL_HARNESS" in env).toBe(false);
    const response = await worker.fetch(
      harnessRequest("/__s2/write", HARNESS_CAPABILITY, {
        method: "POST",
        body: "not-json",
      }),
      env,
      context(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("enabled harness rejects a wrong token before body parsing or D1", async () => {
    const response = await worker.fetch(
      harnessRequest("/__s2/write", "c".repeat(64), {
        method: "POST",
        body: "not-json",
      }),
      harnessEnv({ capability: "enabled", token: HARNESS_CAPABILITY, runId: HARNESS_RUN_ID }),
      context(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("enabled harness rejects a missing per-worker token before body parsing or D1", async () => {
    const response = await worker.fetch(
      harnessRequest("/__s2/write", null, { method: "POST", body: "not-json" }),
      harnessEnv({ capability: "enabled", token: HARNESS_CAPABILITY, runId: HARNESS_RUN_ID }),
      context(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("a static capability with a truly absent token binding is still absent before D1", async () => {
    const env = harnessEnv({ capability: "enabled", runId: HARNESS_RUN_ID });
    expect("S2_HARNESS_TOKEN" in env).toBe(false);
    const response = await worker.fetch(
      harnessRequest("/__s2/write", HARNESS_CAPABILITY, { method: "POST", body: "not-json" }),
      env,
      context(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("a malformed token binding keeps the harness absent before D1", async () => {
    const response = await worker.fetch(
      harnessRequest("/__s2/write", NON_MATCHING_VALUE, { method: "POST", body: "not-json" }),
      harnessEnv({ capability: "enabled", token: NON_MATCHING_VALUE, runId: HARNESS_RUN_ID }),
      context(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("a missing run-id binding keeps the harness absent before D1", async () => {
    const env = harnessEnv({ capability: "enabled", token: HARNESS_CAPABILITY });
    expect("S2_HARNESS_RUN_ID" in env).toBe(false);
    const response = await worker.fetch(harnessRequest("/__s2/ready"), env, context());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("a malformed run-id binding keeps the harness absent before D1", async () => {
    const response = await worker.fetch(
      harnessRequest("/__s2/ready"),
      harnessEnv({ capability: "enabled", token: HARNESS_CAPABILITY, runId: "not-a-run-id" }),
      context(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("an empty run-id binding keeps the harness absent before D1", async () => {
    const response = await worker.fetch(
      harnessRequest("/__s2/ready"),
      harnessEnv({ capability: "enabled", token: HARNESS_CAPABILITY, runId: "" }),
      context(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "KRATER_HARNESS_DISABLED" });
  });

  test("a matching token returns this worker's readiness identifier without D1", async () => {
    const response = await worker.fetch(
      harnessRequest("/__s2/ready"),
      harnessEnv({ capability: "enabled", token: HARNESS_CAPABILITY, runId: HARNESS_RUN_ID }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", run_id: HARNESS_RUN_ID });
  });

  test("a timed-out pre-commit plant needs a correlated Worker acceptance observation", async () => {
    const env = harnessEnv({
      capability: "enabled",
      token: HARNESS_CAPABILITY,
      runId: HARNESS_RUN_ID,
    });
    const observationId = "AB-s2-worker-observation-001";
    const aborted = await worker.fetch(
      harnessRequest("/__s2/write", HARNESS_CAPABILITY, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          problem_id: "P-s2-observation",
          claim_id: "C-s2-observation",
          event_id: "E-s2-observation",
          idempotency_key: "IK-s2-observation",
          statement: "A local abort observation must precede the transaction.",
          created_at: "2026-08-16T00:00:00.000Z",
          s2_abort_before_commit: true,
          s2_harness_request_id: observationId,
        }),
      }),
      env,
      context(),
    );
    expect(aborted.status).toBe(499);
    const observation = await worker.fetch(
      harnessRequest(`/__s2/abort-observation?request_id=${encodeURIComponent(observationId)}`),
      env,
      context(),
    );
    expect(observation.status).toBe(200);
    expect(await observation.json()).toEqual({
      request_id: observationId,
      accepted_before_commit: true,
      transaction_entered: false,
    });
  });

  test("a matching token reaches the local route, whose diagnostic dialect stays non-public", async () => {
    const response = await worker.fetch(
      harnessRequest("/__s2/cursor?problem_id=P-example"),
      harnessEnv({ capability: "enabled", token: HARNESS_CAPABILITY, runId: HARNESS_RUN_ID }),
      context(),
    );

    // The proxy throws on D1 access. A 400 proves the request passed the token gate rather than
    // treating a client-controlled Host value as the access-control decision.
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
    const diagnostic: unknown = await response.json();
    expect(diagnostic).toMatchObject({
      code: "KRATER_READ_INVALID",
      rule: "K-S2-READ",
      schema: "krater.v0.read",
    });
    expect(ProblemDocumentSchema.safeParse(diagnostic).success).toBe(false);
  });

  test("cursor ingress rejects lossy decimals and unsafe integers before D1", async () => {
    const observed = databaseTouchCounter();
    const env = harnessEnv({
      capability: "enabled",
      token: HARNESS_CAPABILITY,
      runId: HARNESS_RUN_ID,
    });
    env.DB = observed.db;

    for (const since of ["9007199254740993", "1.5"]) {
      const response = await worker.fetch(
        harnessRequest(`/__s2/events?problem_id=P-example&since=${since}&limit=1`),
        env,
        context(),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "KRATER_READ_INVALID" });
    }
    expect(observed.touches()).toBe(0);
  });

  test("cursor ingress retains exact safe maxima and rejects unsafe D1 cursor and event rows", async () => {
    const environment = {
      capability: "enabled",
      token: HARNESS_CAPABILITY,
      runId: HARNESS_RUN_ID,
    } as const;
    for (const since of [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
      const env = harnessEnv(environment);
      env.DB = databaseWithEvents([]);
      const response = await worker.fetch(
        harnessRequest(`/__s2/events?problem_id=P-example&since=${since}&limit=1`),
        env,
        context(),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ events: [], next_cursor: since, has_more: false });
    }

    const unsafeCursorEnv = harnessEnv(environment);
    unsafeCursorEnv.DB = databaseWithCursor(Number.MAX_SAFE_INTEGER + 1);
    const unsafeCursor = await worker.fetch(
      harnessRequest("/__s2/cursor?problem_id=P-example"),
      unsafeCursorEnv,
      context(),
    );
    expect(unsafeCursor.status).toBe(400);
    expect(await unsafeCursor.json()).toMatchObject({ code: "KRATER_READ_INVALID" });

    const unsafeEventEnv = harnessEnv(environment);
    unsafeEventEnv.DB = databaseWithEvents([
      {
        id: "E-unsafe-sequence",
        problem_id: "P-example",
        seq: Number.MAX_SAFE_INTEGER + 1,
        type: "claim.created",
        object_id: "C-unsafe-sequence",
        payload_sha256: "a".repeat(64),
        row_digest: "b".repeat(64),
        chain_digest: "c".repeat(64),
        created_at: "2026-08-16T00:00:00.000Z",
      },
    ]);
    const unsafeEvent = await worker.fetch(
      harnessRequest("/__s2/events?problem_id=P-example&since=0&limit=1"),
      unsafeEventEnv,
      context(),
    );
    expect(unsafeEvent.status).toBe(400);
    expect(await unsafeEvent.json()).toMatchObject({ code: "KRATER_READ_INVALID" });
  });

  test("PLANTED: mounted replay reports the independently literal V1 projection as true without mutating persisted rows", async () => {
    const fixture = await changedBuilderReplayFixture();
    const v1Fixture: ChangedBuilderReplayFixture = {
      ...fixture,
      // Independently literal V1 persistence contract: do not ask the production
      // replay/builder to construct this row. V1's build digest is the event row digest.
      projectionRows: [
        {
          claim_id: "C-v2-builder",
          problem_id: "P-v2-builder",
          source_seq: 1,
          projection_version: 1,
          build_digest: fixture.event.rowDigest,
          stale: 0,
        },
      ],
    };
    const readonlyDb = replayReadOnlyDatabase(v1Fixture);
    const before = JSON.stringify({
      request: v1Fixture.body,
      eventBody: v1Fixture.eventBody,
      events: v1Fixture.eventRows,
      projections: v1Fixture.projectionRows,
      outbox: v1Fixture.outboxRows,
      cursor: v1Fixture.cursor,
    });
    expect(await eventChainMatches([v1Fixture.event])).toBe(true);

    const env = harnessEnv({
      capability: "enabled",
      token: HARNESS_CAPABILITY,
      runId: HARNESS_RUN_ID,
    });
    env.DB = readonlyDb.db;
    const response = await worker.fetch(
      harnessRequest("/__s2/replay", HARNESS_CAPABILITY, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(v1Fixture.body),
      }),
      env,
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      matches: true,
      cursor: 1,
      event_count: 1,
      chain_digest: v1Fixture.event.chainDigest,
      chain_version: 2,
      checkpoint_digest: v1Fixture.checkpointDigest,
    });
    expect(readonlyDb.writeAttempts()).toBe(0);
    expect(
      JSON.stringify({
        request: v1Fixture.body,
        eventBody: v1Fixture.eventBody,
        events: v1Fixture.eventRows,
        projections: v1Fixture.projectionRows,
        outbox: v1Fixture.outboxRows,
        cursor: v1Fixture.cursor,
      }),
    ).toBe(before);
  });

  test("PLANTED: mounted replay reports a changed V2 builder as false without mutating persisted rows", async () => {
    const fixture = await changedBuilderReplayFixture();
    const readonlyDb = replayReadOnlyDatabase(fixture);
    const before = JSON.stringify({
      request: fixture.body,
      eventBody: fixture.eventBody,
      events: fixture.eventRows,
      projections: fixture.projectionRows,
      outbox: fixture.outboxRows,
      cursor: fixture.cursor,
    });
    expect(await eventChainMatches([fixture.event])).toBe(true);

    const env = harnessEnv({
      capability: "enabled",
      token: HARNESS_CAPABILITY,
      runId: HARNESS_RUN_ID,
    });
    env.DB = readonlyDb.db;
    const response = await worker.fetch(
      harnessRequest("/__s2/replay", HARNESS_CAPABILITY, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fixture.body),
      }),
      env,
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      matches: false,
      cursor: 1,
      event_count: 1,
      chain_digest: fixture.event.chainDigest,
      chain_version: 2,
      checkpoint_digest: fixture.checkpointDigest,
    });
    expect(readonlyDb.writeAttempts()).toBe(0);
    expect(
      JSON.stringify({
        request: fixture.body,
        eventBody: fixture.eventBody,
        events: fixture.eventRows,
        projections: fixture.projectionRows,
        outbox: fixture.outboxRows,
        cursor: fixture.cursor,
      }),
    ).toBe(before);
  });

  test("PLANTED: a one-field build_digest drift alone flips the mounted replay to false", async () => {
    // z4ai's exact corruption class: the persisted projection keeps its V1
    // version and every other field, and ONLY build_digest leaves the replayed
    // event rowDigest. The mount must answer matches:false — never true —
    // through the same read-only path as the positive control above.
    const fixture = await changedBuilderReplayFixture();
    const drifted: ChangedBuilderReplayFixture = {
      ...fixture,
      projectionRows: [
        {
          claim_id: "C-v2-builder",
          problem_id: "P-v2-builder",
          source_seq: 1,
          projection_version: 1,
          build_digest: "c".repeat(64),
          stale: 0,
        },
      ],
    };
    const readonlyDb = replayReadOnlyDatabase(drifted);
    const before = JSON.stringify({
      request: drifted.body,
      eventBody: drifted.eventBody,
      events: drifted.eventRows,
      projections: drifted.projectionRows,
      outbox: drifted.outboxRows,
      cursor: drifted.cursor,
    });

    const env = harnessEnv({
      capability: "enabled",
      token: HARNESS_CAPABILITY,
      runId: HARNESS_RUN_ID,
    });
    env.DB = readonlyDb.db;
    const response = await worker.fetch(
      harnessRequest("/__s2/replay", HARNESS_CAPABILITY, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(drifted.body),
      }),
      env,
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      matches: false,
      cursor: 1,
      event_count: 1,
      chain_digest: drifted.event.chainDigest,
      chain_version: 2,
      checkpoint_digest: drifted.checkpointDigest,
    });
    expect(readonlyDb.writeAttempts()).toBe(0);
    expect(
      JSON.stringify({
        request: drifted.body,
        eventBody: drifted.eventBody,
        events: drifted.eventRows,
        projections: drifted.projectionRows,
        outbox: drifted.outboxRows,
        cursor: drifted.cursor,
      }),
    ).toBe(before);
  });

  test("the harness capability is declared only by local S2 Wrangler configurations", () => {
    const configs = [
      ...wranglerConfigs(join(REPOSITORY_ROOT, "apps", "wire")),
      ...wranglerConfigs(join(REPOSITORY_ROOT, "infra")),
    ].sort();
    const capabilityConfigs = configs.filter((config) =>
      readFileSync(join(REPOSITORY_ROOT, config), "utf8").includes('S2_LOCAL_HARNESS = "enabled"'),
    );

    expect(capabilityConfigs).toEqual([
      "apps/wire/src/krater/wrangler.s2-legacy.toml",
      "apps/wire/src/krater/wrangler.s2-upgrade.toml",
      "apps/wire/src/krater/wrangler.s2.toml",
    ]);
    for (const config of configs) {
      const source = readFileSync(join(REPOSITORY_ROOT, config), "utf8");
      expect(source).not.toContain("S2_HARNESS_TOKEN");
      if (capabilityConfigs.includes(config)) {
        expect(source).toContain('main = "worker.ts"');
      }
    }

    const runner = readFileSync(join(REPOSITORY_ROOT, "scripts", "e2e-s2-krater.sh"), "utf8");
    expect(runner).toContain('readonly S2_BIND_IP="127.0.0.1"');
    expect(runner).toContain('token="$(random_hex 32)" || return 1'); // ubs:ignore — shell-source assertion proves fresh randomness; it contains no token value.
    expect(runner).toContain(`env "\${S2_WRANGLER}" dev apps/wire/src/krater/worker.ts`);
    expect(runner).toContain(`--ip "\${S2_BIND_IP}"`);
    expect(runner).toContain(`--var "S2_HARNESS_TOKEN:\${token}"`);
  });

  test("PLANTED: every deployable remote config and production entrypoint excludes the S2 worker", () => {
    const environmentConfigs = wranglerConfigs(
      join(REPOSITORY_ROOT, "infra", "environments"),
    ).sort();
    const deployedConfigs = environmentConfigs.filter(
      (config) => config !== "infra/environments/local.wrangler.toml",
    );
    expect(deployedConfigs).toEqual([
      "infra/environments/production.deploy.wrangler.toml",
      "infra/environments/production.wrangler.toml",
      "infra/environments/staging.wrangler.toml",
    ]);
    for (const config of deployedConfigs) {
      const source = readFileSync(join(REPOSITORY_ROOT, config), "utf8");
      expect(source).toContain('main = "../../apps/wire/src/index.ts"');
      expect(source).not.toContain("S2_LOCAL_HARNESS");
      expect(source).not.toContain("krater/worker");
      expect(source).not.toContain('main = "worker.ts"');
    }

    for (const pathname of ["apps/wire/src/index.ts", "apps/wire/src/app.ts"]) {
      const source = readFileSync(join(REPOSITORY_ROOT, pathname), "utf8");
      expect(source).not.toContain("krater/worker");
      expect(source).not.toContain("/__s2/");
      expect(source).not.toContain("S2_LOCAL_HARNESS");
    }
  });

  test("the local scheduled event independently re-arms the durable outbox", async () => {
    const requests: Request[] = [];
    const env = harnessEnv({
      capability: "enabled",
      token: HARNESS_CAPABILITY,
      runId: HARNESS_RUN_ID,
    });
    Object.assign(env, {
      KRATER_OUTBOX: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (request: Request) => {
            requests.push(request);
            return new Response(JSON.stringify({ accepted: true }), { status: 202 });
          },
        }),
      },
    });

    await worker.scheduled({}, env, context());

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? "https://invalid.example").pathname).toBe("/nudge");
    expect(requests[0]?.method).toBe("POST");
  });

  test("the scheduled recovery authority is absent when the local capability is absent", async () => {
    const env = harnessEnv({ token: HARNESS_CAPABILITY, runId: HARNESS_RUN_ID });
    Object.assign(env, {
      KRATER_OUTBOX: new Proxy(
        {},
        {
          get() {
            throw new Error("S2_TEST_OUTBOX_TOUCHED");
          },
        },
      ),
    });

    await expect(worker.scheduled({}, env, context())).resolves.toBeUndefined();
  });
});
