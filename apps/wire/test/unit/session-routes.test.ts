import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createEnrollmentRouter } from "../../src/enrollment/router.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
  InMemoryEnrollmentStore,
} from "../../src/enrollment/service.ts";
import { genesisChainDigest } from "../../src/krater/krater.ts";
import { createSessionRouter } from "../../src/sessions/router.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

type LocalBinding = string | number | null;

/** A D1 shim over bun:sqlite, following the enrollment-atomicity lane's pattern. */
function localD1(sqlite: Database) {
  const prepare = (query: string) => {
    const methods = (...values: LocalBinding[]) => ({
      async run() {
        const statement = sqlite.prepare<unknown, LocalBinding[]>(query);
        if (/^\s*SELECT\b/i.test(query)) {
          const rows = statement.all(...values);
          return {
            results: rows,
            meta: { changes: 0, rows_read: rows.length, rows_written: 0 },
          };
        }
        const result = statement.run(...values);
        return {
          results: [],
          meta: { changes: result.changes, rows_read: 0, rows_written: result.changes },
        };
      },
      async first<T>(): Promise<T | null> {
        const row = sqlite.prepare<T, LocalBinding[]>(query).get(...values);
        return (row ?? null) as T | null;
      },
      async all<T>(): Promise<{ results: T[]; meta: { rows_read: number } }> {
        const rows = sqlite.prepare<T, LocalBinding[]>(query).all(...values) as T[];
        return { results: rows, meta: { rows_read: rows.length } };
      },
    });
    return {
      bind(...values: LocalBinding[]) {
        return methods(...values);
      },
      ...methods(),
    };
  };
  return {
    prepare,
    async batch(
      statements: readonly {
        run(): Promise<{ results?: readonly unknown[]; meta: { changes: number } }>;
      }[],
    ) {
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
  } as unknown as import("../../src/env.ts").Env["DB"];
}

function migratedDb(): import("../../src/env.ts").Env["DB"] {
  const sqlite = new Database(":memory:", { strict: true });
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.run(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return localD1(sqlite);
}

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

async function fixture() {
  const random = new FixedRandom();
  const replayProtector = new AesGcmEnrollmentReplayProtector(
    Uint8Array.from({ length: 32 }, (_v, i) => i),
    random,
  );
  const service = new EnrollmentService({
    stoaOrigin: "https://a-staging.asimposium.org",
    agoraOrigin: "https://staging.asimposium.org",
    store: new InMemoryEnrollmentStore(),
    replayProtector,
  });
  const enrollmentRouter = createEnrollmentRouter({ service });
  const sessionRouter = createSessionRouter({ service, replayProtector });
  const db = migratedDb();
  const sponsor = { type: "sponsor", sponsorId: "usr_sessionsponsor1" } as const;
  const minted = await service.mint(sponsor, {
    requested_scopes: ["promote", "review"],
    problem_binding: "P-4DSP",
  });
  const registration = await enrollmentRouter.fetch(
    new Request("https://a-staging.asimposium.org/v1/fellows", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "fixture-claim-1" },
      body: JSON.stringify({
        enrollment_id: minted.enrollmentId,
        secret: minted.secret,
        name: "session-runner",
        model: "test-model",
        harness: "test-harness",
      }),
    }),
  );
  const { flow_handle: flowHandle } = (await registration.json()) as { flow_handle: string };
  await service.decide(sponsor, minted.enrollmentId, {
    enrollment_id: minted.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: Math.floor(Date.now() / 1_000),
  });
  const issued = await enrollmentRouter.fetch(
    new Request("https://a-staging.asimposium.org/v1/device-token", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "fixture-token-1" },
      body: JSON.stringify({ flow_handle: flowHandle }),
    }),
  );
  const issuedBody = (await issued.json()) as { status: string; token?: string };
  if (issuedBody.token === undefined) throw new Error("fixture token was not issued");
  // The seed problem exists so session open finds it.
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO problems (id, public_seq, created_at, updated_at) VALUES ('P-4DSP', 0, ?, ?)",
    )
    .bind(now, now)
    .run();
  const genesis = await genesisChainDigest("P-4DSP");
  await db.prepare("UPDATE problems SET chain_digest = ? WHERE id = 'P-4DSP'").bind(genesis).run();
  await db
    .prepare(
      "INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at) VALUES ('P-4DSP', 'complete', 0, ?)",
    )
    .bind(now)
    .run();
  const token = issuedBody.token;
  // The enrollment fixture runs on the in-memory store; the D1-side FK from
  // sessions/workshop_objects needs the fellow row in the same database.
  const binding = await service.credentialBinding(token);
  if (binding === undefined) throw new Error("fixture binding missing");
  await db
    .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
    .bind(binding.sponsorId, Date.now(), Date.now())
    .run();
  await db
    .prepare(
      "INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      binding.fellowId,
      binding.sponsorId,
      binding.name,
      binding.model,
      binding.harness,
      Date.now(),
    )
    .run();
  const env = { DB: db } as unknown as import("../../src/env.ts").Env;
  const call = (path: string, init: RequestInit = {}) =>
    sessionRouter.fetch(
      new Request(`https://a-staging.asimposium.org${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
      }),
      env,
    );
  return { call, db, token, router: sessionRouter, env, binding, service, replayProtector };
}

describe("session protocol routes", () => {
  test("open → pack → workshop → promote → close runs the loop with cursors correct", async () => {
    const { call, db } = await fixture();

    const opened = await call("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "open-1" },
      body: JSON.stringify({ problem_id: "P-4DSP", intent: "prove" }),
    });
    expect(opened.status).toBe(201);
    const session = (await opened.json()) as { session_id: string };

    // A second open against the same problem is SESSION_EXISTS.
    const duplicate = await call("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "open-2" },
      body: JSON.stringify({ problem_id: "P-4DSP", intent: "prove" }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "SESSION_EXISTS" });

    // Idempotent replay of the first open returns the same session.
    const replay = await call("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "open-1" },
      body: JSON.stringify({ problem_id: "P-4DSP", intent: "prove" }),
    });
    expect((await replay.json()) as { session_id: string }).toMatchObject({
      session_id: session.session_id,
    });

    const pack = await call(`/v1/sessions/${session.session_id}/pack?profile=working`);
    expect(pack.status).toBe(200);
    const packBody = (await pack.json()) as { profile: string; omitted: unknown[] };
    expect(packBody.profile).toBe("working");
    expect(Array.isArray(packBody.omitted)).toBe(true);

    const pushed = await call(`/v1/sessions/${session.session_id}/workshop`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "push-1" },
      body: JSON.stringify({
        type: "draft",
        title: "Orbit count under toggles",
        body_md: "Burnside average over the eight toggles.",
        relates_to: [],
      }),
    });
    expect(pushed.status).toBe(201);
    const workshop = (await pushed.json()) as { workshop_id: string; workshop_seq: number };

    // The workshop push must not move the public cursor.
    const cursorBefore = await (await call("/cursor")).text();
    expect(cursorBefore).toBe("0");

    // P3: a conjecture without a falsifier is a teaching refusal.
    const refused = await call(`/v1/sessions/${session.session_id}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "promote-1" },
      body: JSON.stringify({
        workshop_id: workshop.workshop_id,
        kind: "conjecture",
        statement: "Every toggle-invariant labeling factors through the quotient.",
        relates_to: [],
      }),
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: "MISSING_FALSIFIER", rule: "P3" });

    // P2/P4: author-writable disposition is refused with the rule citation.
    const selfCertified = await call(`/v1/sessions/${session.session_id}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "promote-selfcert" },
      body: JSON.stringify({
        workshop_id: workshop.workshop_id,
        kind: "conjecture",
        statement: "Every toggle-invariant labeling factors through the quotient.",
        falsifier: "A toggle-invariant labeling that does not factor.",
        disposition: "proved",
        relates_to: [],
      }),
    });
    expect(selfCertified.status).toBe(422);
    expect(await selfCertified.json()).toMatchObject({ code: "SCHEMA_INVALID", rule: "P2/P4" });

    const promoted = await call(`/v1/sessions/${session.session_id}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "promote-2" },
      body: JSON.stringify({
        workshop_id: workshop.workshop_id,
        kind: "conjecture",
        statement: "Every toggle-invariant labeling factors through the quotient.",
        falsifier: "A toggle-invariant labeling that does not factor.",
        relates_to: [],
      }),
    });
    expect(promoted.status).toBe(201);
    const promotion = (await promoted.json()) as { claim_id: string; seq: number };
    expect(promotion.claim_id).toBe("C-1");

    // The public cursor moved exactly once.
    const cursorAfter = await (await call("/cursor")).text();
    expect(cursorAfter).toBe("1");

    // P11: the same statement normalized is a near-duplicate refusal naming
    // the existing claim.
    const dupPromote = await call(`/v1/sessions/${session.session_id}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "promote-dup" },
      body: JSON.stringify({
        workshop_id: workshop.workshop_id,
        kind: "conjecture",
        statement: "Every  toggle-invariant   labeling factors through the quotient.",
        falsifier: "A toggle-invariant labeling that does not factor.",
        relates_to: [],
      }),
    });
    expect(dupPromote.status).toBe(409);
    expect(await dupPromote.json()).toMatchObject({ code: "DUPLICATE_CLAIM", rule: "P11" });

    const closed = await call(`/v1/sessions/${session.session_id}/close`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "close-1" },
      body: JSON.stringify({ handback: "C-1 promoted; odd-length case open.", promote: [] }),
    });
    expect(closed.status).toBe(201);
    const closedBody = await closed.text();

    const closeReplay = await call(`/v1/sessions/${session.session_id}/close`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "close-1" },
      body: JSON.stringify({ handback: "C-1 promoted; odd-length case open.", promote: [] }),
    });
    expect(closeReplay.status).toBe(200);
    expect(await closeReplay.text()).toBe(closedBody);

    // The closed session refuses further workshop pushes.
    const afterClose = await call(`/v1/sessions/${session.session_id}/workshop`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "push-2" },
      body: JSON.stringify({ type: "note", title: "x", body_md: "y", relates_to: [] }),
    });
    expect(afterClose.status).toBe(409);

    // The ledger really holds the claim.
    const claim = await db
      .prepare("SELECT statement FROM claims WHERE id = 'C-1'")
      .first<{ statement: string }>();
    expect(claim?.statement).toContain("toggle-invariant");
  });

  test("two working packs at the same cursor byte-compare identical (prompt-cache money)", async () => {
    const { call } = await fixture();
    const opened = await call("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "det-open" },
      body: JSON.stringify({ problem_id: "P-4DSP", intent: "explore" }),
    });
    const session = (await opened.json()) as { session_id: string };
    const first = await call(`/v1/sessions/${session.session_id}/pack?profile=working`);
    const second = await call(`/v1/sessions/${session.session_id}/pack?profile=working`);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(await second.text());
    // The ETag honors a conditional request with a 304.
    const etag = second.headers.get("etag");
    expect(etag).not.toBeNull();
    const conditional = await call(`/v1/sessions/${session.session_id}/pack?profile=working`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(conditional.status).toBe(304);
  });

  test("the sponsor workshop view is private and never shared-cacheable", async () => {
    const { call, db, binding, service, replayProtector } = await fixture();
    const opened = await call("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "sponsor-open" },
      body: JSON.stringify({ problem_id: "P-4DSP", intent: "explore" }),
    });
    const session = (await opened.json()) as { session_id: string };
    const pushed = await call(`/v1/sessions/${session.session_id}/workshop`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "sponsor-push" },
      body: JSON.stringify({
        type: "note",
        title: "Private sponsor note",
        body_md: "Only the Fellow and sponsor may read these bytes.",
        relates_to: [],
      }),
    });
    expect(pushed.status).toBe(201);

    const sponsorRouter = createSessionRouter({
      service,
      replayProtector,
      verifiedSponsor: async () => ({
        principal: { type: "sponsor", sponsorId: binding.sponsorId },
        rawBody: new Uint8Array(),
      }),
    });
    const response = await sponsorRouter.fetch(
      new Request(
        `https://a-staging.asimposium.org/v1/sponsors/workshop?problem_id=P-4DSP&fellow_id=${binding.fellowId}`,
      ),
      { DB: db } as import("../../src/env.ts").Env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      problem_id: "P-4DSP",
      fellow_id: binding.fellowId,
      objects: [{ title: "Private sponsor note" }],
    });
  });

  test("a missing bearer is 401 and an unknown pack profile teaches the list", async () => {
    const { call, router, env } = await fixture();

    const refused = await router.fetch(
      new Request("https://a-staging.asimposium.org/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "x" },
        body: JSON.stringify({ problem_id: "P-4DSP" }),
      }),
      env,
    );
    expect(refused.status).toBe(401);

    const opened = await call("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "open-profile-test" },
      body: JSON.stringify({ problem_id: "P-4DSP", intent: "explore" }),
    });
    const session = (await opened.json()) as { session_id: string };
    const unknownProfile = await call(`/v1/sessions/${session.session_id}/pack?profile=all`);
    expect(unknownProfile.status).toBe(400);
    expect(await unknownProfile.json()).toMatchObject({ code: "UNKNOWN_PROFILE" });
  });
});
