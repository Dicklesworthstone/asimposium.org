import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { D1Database, DurableObjectState } from "@cloudflare/workers-types";
import { inspectOutboxDb } from "../../../../scripts/ops-outbox-reconcile.ts";
import {
  cosineSimilarity,
  enqueueOutboxJob,
  OUTBOX_LAUNCH_KINDS,
} from "../../src/krater/outbox-consumers.ts";
import { KraterOutboxDrainer, validateOutboxRow } from "../../src/krater/outbox-do.ts";
import { selectCollapseDuplicateMove } from "../../src/mega-commands/duplicate-moves.ts";
import { migratedSqlite } from "../support/migrated-sqlite.ts";

function localD1(sqlite: ReturnType<typeof migratedSqlite>): D1Database {
  const prepare = (query: string) => {
    const bound = (...values: (string | number | null)[]) => ({
      async all<T>() {
        return { success: true as const, results: sqlite.prepare(query).all(...values) as T[] };
      },
      async first<T>() {
        const row = sqlite.prepare(query).get(...values);
        return (row ?? null) as T | null;
      },
      async run() {
        const res = sqlite.prepare(query).run(...values);
        return { success: true as const, results: [], meta: { changes: res.changes } };
      },
    });
    return { bind: bound, ...bound() };
  };
  return {
    prepare,
    async batch(stmts: readonly { run(): Promise<unknown> }[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

function fakeDoState(): DurableObjectState {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async put(keyOrEntries: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrEntries === "string") map.set(keyOrEntries, value);
      else for (const [k, v] of Object.entries(keyOrEntries)) map.set(k, v);
    },
    async delete(key: string) {
      return map.delete(key);
    },
    async list<T>(opts?: { prefix?: string; startAfter?: string; limit?: number }) {
      const out = new Map<string, T>();
      const keys = [...map.keys()]
        .filter(
          (k) =>
            (!opts?.prefix || k.startsWith(opts.prefix)) &&
            (!opts?.startAfter || k > opts.startAfter),
        )
        .sort()
        .slice(0, opts?.limit ?? 100);
      for (const k of keys) out.set(k, map.get(k) as T);
      return out;
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(at: number) {
      alarm = at;
    },
    async deleteAlarm() {
      alarm = null;
    },
  };
  return {
    storage,
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as DurableObjectState;
}

function seedPublicClaim(
  sqlite: ReturnType<typeof migratedSqlite>,
  opts: {
    problemId: string;
    claimId: string;
    eventId: string;
    seq: number;
    statement: string;
    falsifier?: string;
    problemStatus?: string;
  },
) {
  const ts = `2026-09-10T00:00:${String(opts.seq).padStart(2, "0")}.000Z`;
  const payload = JSON.stringify({
    claim_id: opts.claimId,
    kind: "conjecture",
    statement: opts.statement,
    falsifier: opts.falsifier ?? "A finite counterexample.",
    dependency_pins: [],
    scientific_provenance: {
      model_family_self_declared: "test",
      method: { category: "deductive", procedure: "Direct check.", evidence: [] },
    },
  });
  const sha = createHash("sha256").update(payload).digest("hex");
  const contentDigest = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        falsifier: opts.falsifier ?? "A finite counterexample.",
        kind: "conjecture",
        statement: opts.statement,
      }),
    )
    .digest("hex")}`;
  sqlite.run(
    `INSERT OR IGNORE INTO problems (id, title, status, public_seq, chain_version, chain_digest, created_at, updated_at)
     VALUES (?, 'Test Problem', ?, ?, 2, 'sha256:chain', ?, ?)`,
    [opts.problemId, opts.problemStatus ?? "active", opts.seq, ts, ts],
  );
  sqlite.run(
    `INSERT OR IGNORE INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version)
     VALUES (?, 'complete', 0, ?, 2)`,
    [opts.problemId, ts],
  );
  sqlite.run(
    "UPDATE problems SET public_seq = MAX(public_seq, ?), chain_version = 2, chain_digest = 'sha256:chain', updated_at = ? WHERE id = ?",
    [opts.seq, ts, opts.problemId],
  );
  sqlite.run(
    `INSERT INTO events (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, row_digest, chain_digest, created_at, actor_fellow_id, actor_sponsor_id, actor_session_id, model_string_self_declared, harness)
     VALUES (?, ?, ?, 'claim.created', 'claim', ?, 1, ?, 'sha256:row', 'sha256:chain', ?, 'F-CN2N', 'usr_cn2n', 'S-CN2N', 'm', 'h')`,
    [opts.eventId, opts.problemId, opts.seq, opts.claimId, sha, ts],
  );
  sqlite.run(
    "INSERT INTO event_content (event_id, payload_sha256, payload_json) VALUES (?, ?, ?)",
    [opts.eventId, sha, payload],
  );
  sqlite.run(
    "INSERT INTO claims (id, problem_id, statement, payload_sha256, source_seq, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [opts.claimId, opts.problemId, opts.statement, sha, opts.seq, ts],
  );
  sqlite.run(
    "INSERT INTO claim_versions (problem_id, claim_id, version, kind, statement, falsifier, editor_fellow_id, created_at, content_digest) VALUES (?, ?, 1, 'conjecture', ?, ?, 'F-CN2N', ?, ?)",
    [
      opts.problemId,
      opts.claimId,
      opts.statement,
      opts.falsifier ?? "A finite counterexample.",
      ts,
      contentDigest,
    ],
  );
  return { sha, ts };
}

describe("KraterOutboxDrainer extended consumers, privacy fence, and semantic duplicate moves (cn2n)", () => {
  test("validateOutboxRow accepts all 6 launch-scope kinds and refuses Tier-2 webhook.deliver", () => {
    const sha = "a".repeat(64);
    for (const kind of OUTBOX_LAUNCH_KINDS) {
      expect(
        validateOutboxRow({
          event_id: "E-1",
          kind,
          dedupe_key: `${kind}:E-1`,
          payload_sha256: sha,
        }),
      ).toBeNull();
    }
    expect(
      validateOutboxRow({
        event_id: "E-1",
        kind: "webhook.deliver",
        dedupe_key: "webhook.deliver:E-1",
        payload_sha256: sha,
      }),
    ).toBe("OUTBOX_KIND_INVALID");
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  test("POSITIVE 1: embedding.compute flags lexically distinct semantic near-duplicates and feeds collapse-duplicate move with provenance", async () => {
    const sqlite = migratedSqlite({ strict: true });
    const db = localD1(sqlite);
    const problemId = "P-SEMDUP";

    // Two claims phrased completely differently (evading lexical P11 normalization!)
    const c1 = seedPublicClaim(sqlite, {
      problemId,
      claimId: "C-1",
      eventId: "E-SD-1",
      seq: 1,
      statement:
        "Every smooth closed 4-manifold with zero signature admits a handle decomposition without 1-handles.",
    });
    const c2 = seedPublicClaim(sqlite, {
      problemId,
      claimId: "C-2",
      eventId: "E-SD-2",
      seq: 2,
      statement:
        "Null-signature compact differentiable 4-dimensional manifolds can always be built without index-one handles.",
    });

    await enqueueOutboxJob(db, {
      eventId: "E-SD-1",
      problemId,
      kind: "embedding.compute",
      payloadSha256: c1.sha,
      createdAt: c1.ts,
    });
    await enqueueOutboxJob(db, {
      eventId: "E-SD-2",
      problemId,
      kind: "embedding.compute",
      payloadSha256: c2.sha,
      createdAt: c2.ts,
    });

    // Before draining, P11 lexical move finds no duplicate.
    const before = await selectCollapseDuplicateMove(db, problemId, 2);
    expect(before.move).toBeNull();

    // Deterministic local test embedder returning high-cosine vectors (>0.99) for these two statements.
    const drainer = new KraterOutboxDrainer(fakeDoState(), {
      DB: db,
      embedText: async (text) => ({
        vector: text.includes("4-manifold") ? [0.99, 0.14, 0.0] : [0.985, 0.17, 0.0],
        modelId: "@cf/baai/bge-base-en-v1.5",
        modelVersion: "test-deterministic-v1",
      }),
    });
    const drainRes = await drainer.fetch(
      new Request("https://krater-outbox.internal/drain-now", { method: "POST", body: "{}" }),
    );
    expect(drainRes.status).toBe(200);
    const drained = (await drainRes.json()) as { delivered: number; quarantined: number };
    expect(drained.delivered).toBe(2);
    expect(drained.quarantined).toBe(0);

    // Advisory row persisted with model/version provenance; collapse-duplicate move now surfaces!
    const advCount = sqlite
      .prepare("SELECT COUNT(*) AS n FROM public_duplicate_advisories WHERE problem_id = ?")
      .get(problemId) as { n: number };
    expect(advCount.n).toBe(1);

    const after = await selectCollapseDuplicateMove(db, problemId, 2);
    expect(after.move).not.toBeNull();
    expect(after.move?.move).toBe("collapse-duplicate");
    expect(after.move?.refs).toEqual([problemId, "C-1@1", "C-2@1"]);
    expect(after.move?.why).toContain("@cf/baai/bge-base-en-v1.5");
    expect(after.move?.why).toContain("test-deterministic-v1");

    // SHOULD-FAIL CONTROL 2 (Idempotency): re-delivering the exact same job produces zero duplicate advisories!
    sqlite.run(
      "UPDATE outbox SET state = 'pending', delivered_at = NULL WHERE event_id = 'E-SD-2'",
    );
    const replayRes = await drainer.fetch(
      new Request("https://krater-outbox.internal/drain-now", { method: "POST", body: "{}" }),
    );
    expect(replayRes.status).toBe(200);
    const advAfterReplay = sqlite
      .prepare("SELECT COUNT(*) AS n FROM public_duplicate_advisories WHERE problem_id = ?")
      .get(problemId) as { n: number };
    expect(advAfterReplay.n).toBe(1);
    sqlite.close();
  });

  test("SHOULD-FAIL CONTROL 1: embedding.compute enforces PRIVATE_CONTENT_FORBIDDEN on workshop IDs and private-draft problems with ZERO embedder calls", async () => {
    const sqlite = migratedSqlite({ strict: true });
    const db = localD1(sqlite);
    const sha = "b".repeat(64);
    const ts = "2026-09-10T00:00:01.000Z";

    // Seed a private-draft problem with an event
    const priv = seedPublicClaim(sqlite, {
      problemId: "P-PRIVDRAFT",
      claimId: "C-1",
      eventId: "E-PRIV-1",
      seq: 1,
      statement: "TOP_SECRET_PRIVATE_DRAFT_STATEMENT",
      problemStatus: "private-draft",
    });

    await enqueueOutboxJob(db, {
      eventId: "E-PRIV-1",
      problemId: "P-PRIVDRAFT",
      kind: "embedding.compute",
      payloadSha256: priv.sha,
      createdAt: ts,
    });

    // Also plant a forged workshop-ID outbox row (bypassing FK via PRAGMA foreign_keys = OFF to test defense-in-depth).
    sqlite.run("PRAGMA foreign_keys = OFF");
    sqlite.run(
      `INSERT INTO outbox (event_id, problem_id, kind, dedupe_key, payload_sha256, created_at)
       VALUES ('W-PRIVATE-01', 'P-PRIVDRAFT', 'embedding.compute', 'embedding.compute:W-PRIVATE-01', ?, ?)`,
      [sha, ts],
    );
    sqlite.run("PRAGMA foreign_keys = ON");

    let embedderCalls = 0;
    const drainer = new KraterOutboxDrainer(fakeDoState(), {
      DB: db,
      embedText: async () => {
        embedderCalls++;
        return { vector: [1, 0], modelId: "m", modelVersion: "v" };
      },
    });

    const drainRes = await drainer.fetch(
      new Request("https://krater-outbox.internal/drain-now", { method: "POST", body: "{}" }),
    );
    expect(drainRes.status).toBe(200);
    const body = (await drainRes.json()) as { delivered: number; quarantined: number };
    expect(body.delivered).toBe(0);
    expect(body.quarantined).toBe(2);
    expect(embedderCalls).toBe(0);
    sqlite.close();
  });

  test("POSITIVE 2 & 3: synthesis.staleness, og.invalidate, notification.fanout, screening.enrich execute idempotently + ops-outbox-reconcile dry-run", async () => {
    const sqlite = migratedSqlite({ strict: true });
    const db = localD1(sqlite);
    const problemId = "P-JOBS1";

    const c1 = seedPublicClaim(sqlite, {
      problemId,
      claimId: "C-1",
      eventId: "E-JOB-1",
      seq: 1,
      statement: "Base claim citing https://arxiv.org/abs/2401.00001 and arXiv:2401.00001.",
    });
    sqlite.run(
      `INSERT INTO syntheses (synthesis_id, problem_id, covers_through, body_md, anchors_json, omitted_json, dropped_single_author_count, authoring_principal, declared_model, cas_hash, created_at)
       VALUES ('SYN-1', ?, 1, 'Initial synthesis', '[]', '[]', 0, 'F-CN2N', 'test-model', NULL, ?)`,
      [problemId, c1.ts],
    );
    const c2 = seedPublicClaim(sqlite, {
      problemId,
      claimId: "C-2",
      eventId: "E-JOB-2",
      seq: 2,
      statement: "Follow-up claim with DOI 10.1000/xyz123 and https://example.org/proof.",
    });

    for (const kind of [
      "synthesis.staleness",
      "og.invalidate",
      "notification.fanout",
      "screening.enrich",
    ] as const) {
      await enqueueOutboxJob(db, {
        eventId: "E-JOB-2",
        problemId,
        kind,
        payloadSha256: c2.sha,
        createdAt: c2.ts,
      });
    }

    // Dry-run reconciliation BEFORE drain sees 4 pending jobs by kind.
    const beforeReport = inspectOutboxDb(
      sqlite,
      ":memory:",
      Date.parse("2026-09-10T00:01:00.000Z"),
    );
    expect(beforeReport.mode).toBe("dry-run");
    expect(beforeReport.pending).toBe(4);
    expect(beforeReport.by_kind_pending["synthesis.staleness"]).toBe(1);
    expect(beforeReport.by_kind_pending["og.invalidate"]).toBe(1);
    expect(beforeReport.by_kind_pending["notification.fanout"]).toBe(1);
    expect(beforeReport.by_kind_pending["screening.enrich"]).toBe(1);

    const drainer = new KraterOutboxDrainer(fakeDoState(), { DB: db });
    const res = await drainer.fetch(
      new Request("https://krater-outbox.internal/drain-now", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(200);
    const drained = (await res.json()) as { delivered: number; quarantined: number };
    expect(drained.delivered).toBe(4);
    expect(drained.quarantined).toBe(0);

    const stale = sqlite
      .prepare(
        "SELECT stale_since_seq, stale_since_event_id FROM synthesis_staleness_markers WHERE synthesis_id = 'SYN-1'",
      )
      .get() as { stale_since_seq: number; stale_since_event_id: string } | null;
    expect(stale).toEqual({ stale_since_seq: 2, stale_since_event_id: "E-JOB-2" });

    const og = sqlite
      .prepare(
        "SELECT last_invalidated_seq, last_event_id FROM og_invalidation_markers WHERE problem_id = ?",
      )
      .get(problemId) as { last_invalidated_seq: number; last_event_id: string } | null;
    expect(og).toEqual({ last_invalidated_seq: 2, last_event_id: "E-JOB-2" });

    const enrich = sqlite
      .prepare(
        "SELECT citation_count, locator_count FROM screening_enrichment_records WHERE event_id = 'E-JOB-2'",
      )
      .get() as { citation_count: number; locator_count: number } | null;
    expect(enrich).toEqual({ citation_count: 1, locator_count: 1 });

    // After drain, ops-outbox-reconcile reports pending = 0.
    const afterReport = inspectOutboxDb(sqlite, ":memory:", Date.parse("2026-09-10T00:01:00.000Z"));
    expect(afterReport.pending).toBe(0);
    expect(afterReport.oldest_pending_age_alert).toBe("not-pending");

    // REGRESSION (Bug #1): SQLite conditional upsert WHERE must update BOTH seq AND event_id
    // when a higher seq advances og.invalidate AND when an earlier seq arrives for synthesis.staleness.
    // Insert ledger events in monotonic seq order (3 then 4), then enqueue/drain outbox out-of-order (4 then 3).
    const c3 = seedPublicClaim(sqlite, {
      problemId,
      claimId: "C-3",
      eventId: "E-JOB-3",
      seq: 3,
      statement: "Earlier material claim at seq 3 arriving out-of-order.",
    });
    const c4 = seedPublicClaim(sqlite, {
      problemId,
      claimId: "C-4",
      eventId: "E-JOB-4",
      seq: 4,
      statement: "Later material claim at seq 4.",
    });
    await enqueueOutboxJob(db, {
      eventId: "E-JOB-4",
      problemId,
      kind: "og.invalidate",
      payloadSha256: c4.sha,
      createdAt: c4.ts,
    });
    await enqueueOutboxJob(db, {
      eventId: "E-JOB-3",
      problemId,
      kind: "og.invalidate",
      payloadSha256: c3.sha,
      createdAt: c3.ts,
    });
    // Also add a second synthesis covering through seq 2, then deliver seq 4 first and seq 3 second.
    sqlite.run(
      `INSERT INTO syntheses (synthesis_id, problem_id, covers_through, body_md, anchors_json, omitted_json, dropped_single_author_count, authoring_principal, declared_model, cas_hash, created_at)
       VALUES ('SYN-2', ?, 2, 'Second synthesis', '[]', '[]', 0, 'F-CN2N', 'test-model', NULL, ?)`,
      [problemId, c2.ts],
    );
    await enqueueOutboxJob(db, {
      eventId: "E-JOB-4",
      problemId,
      kind: "synthesis.staleness",
      payloadSha256: c4.sha,
      createdAt: c4.ts,
    });
    const drainFirst = await drainer.fetch(
      new Request("https://krater-outbox.internal/drain-now", { method: "POST", body: "{}" }),
    );
    expect(drainFirst.status).toBe(200);
    await enqueueOutboxJob(db, {
      eventId: "E-JOB-3",
      problemId,
      kind: "synthesis.staleness",
      payloadSha256: c3.sha,
      createdAt: c3.ts,
    });
    const drainSecond = await drainer.fetch(
      new Request("https://krater-outbox.internal/drain-now", { method: "POST", body: "{}" }),
    );
    expect(drainSecond.status).toBe(200);

    // og.invalidate must advance BOTH last_invalidated_seq=4 AND last_event_id='E-JOB-4' (ignoring older seq 3).
    const ogUpdated = sqlite
      .prepare(
        "SELECT last_invalidated_seq, last_event_id FROM og_invalidation_markers WHERE problem_id = ?",
      )
      .get(problemId) as { last_invalidated_seq: number; last_event_id: string } | null;
    expect(ogUpdated).toEqual({ last_invalidated_seq: 4, last_event_id: "E-JOB-4" });

    // synthesis.staleness on SYN-2 must move backwards to BOTH stale_since_seq=3 AND stale_since_event_id='E-JOB-3'!
    const staleSyn2 = sqlite
      .prepare(
        "SELECT stale_since_seq, stale_since_event_id FROM synthesis_staleness_markers WHERE synthesis_id = 'SYN-2'",
      )
      .get() as { stale_since_seq: number; stale_since_event_id: string } | null;
    expect(staleSyn2).toEqual({ stale_since_seq: 3, stale_since_event_id: "E-JOB-3" });
    sqlite.close();
  });

  test("REGRESSION (Bug #2): embedding.compute excludes hidden peer claims from public_duplicate_advisories", async () => {
    const sqlite = migratedSqlite({ strict: true });
    const db = localD1(sqlite);
    const problemId = "P-HIDPEER";
    const c1 = seedPublicClaim(sqlite, {
      problemId,
      claimId: "C-1",
      eventId: "E-HP-1",
      seq: 1,
      statement: "Peer claim that will be hidden after embedding.",
    });
    await enqueueOutboxJob(db, {
      eventId: "E-HP-1",
      problemId,
      kind: "embedding.compute",
      payloadSha256: c1.sha,
      createdAt: c1.ts,
    });
    const drainer = new KraterOutboxDrainer(fakeDoState(), {
      DB: db,
      embedText: async () => ({ vector: [1, 0, 0, 0], modelId: "m-test", modelVersion: "v1" }),
    });
    expect(
      (
        await drainer.fetch(
          new Request("https://krater-outbox.internal/drain-now", { method: "POST", body: "{}" }),
        )
      ).status,
    ).toBe(200);

    // Now hide C-1 via content_controls, then embed an identical-vector C-2.
    sqlite.run(
      `INSERT INTO content_controls
         (control_id, problem_id, target_kind, target_ref, visibility, source, reason_category, actor, reason, version, created_at)
       VALUES ('CC-HP1', ?, 'claim', 'C-1', 'hidden', 'operator', 'integrity', 'op_test', 'moderation-test', 1, ?)`,
      [problemId, c1.ts],
    );
    const c2 = seedPublicClaim(sqlite, {
      problemId,
      claimId: "C-2",
      eventId: "E-HP-2",
      seq: 2,
      statement: "New visible claim with identical embedding to hidden peer.",
    });
    await enqueueOutboxJob(db, {
      eventId: "E-HP-2",
      problemId,
      kind: "embedding.compute",
      payloadSha256: c2.sha,
      createdAt: c2.ts,
    });
    expect(
      (
        await drainer.fetch(
          new Request("https://krater-outbox.internal/drain-now", { method: "POST", body: "{}" }),
        )
      ).status,
    ).toBe(200);

    const advisories = sqlite
      .prepare("SELECT COUNT(*) AS n FROM public_duplicate_advisories WHERE problem_id = ?")
      .get(problemId) as { n: number };
    expect(advisories.n).toBe(0);
    sqlite.close();
  });

  test("REGRESSION (Wave 11): synthesis.staleness uses canonical synthesisMaterialEventSql (gap.closed-by & dead_end.recorded trigger staleness; non-material events do not)", async () => {
    const sqlite = migratedSqlite({ strict: true });
    const db = localD1(sqlite);
    const problemId = "P-STALE-CANON";
    const c1 = seedPublicClaim(sqlite, {
      problemId,
      claimId: "C-1",
      eventId: "E-SC-1",
      seq: 1,
      statement: "Base claim for canonical material event staleness check.",
    });
    sqlite.run(
      `INSERT INTO syntheses (synthesis_id, problem_id, covers_through, body_md, anchors_json, omitted_json, dropped_single_author_count, authoring_principal, declared_model, cas_hash, created_at)
       VALUES ('SYN-GAP', ?, 1, 'Initial synthesis', '[]', '[]', 0, 'F-CN2N', 'test-model', NULL, ?),
              ('SYN-DE', ?, 2, 'Mid synthesis', '[]', '[]', 0, 'F-CN2N', 'test-model', NULL, ?)`,
      [problemId, c1.ts, problemId, c1.ts],
    );

    const seedMaterialEvent = (
      eventId: string,
      seq: number,
      type: string,
      objectKind: string,
      objectId: string,
    ) => {
      const payload = JSON.stringify({ id: objectId, type });
      const sha = createHash("sha256").update(payload).digest("hex");
      const ts = `2026-09-10T00:00:0${seq}.000Z`;
      sqlite.run(
        "UPDATE problems SET public_seq = ?, chain_digest = ?, updated_at = ? WHERE id = ?",
        [seq, `sha256:${eventId}`, ts, problemId],
      );
      sqlite.run(
        `INSERT INTO events
           (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, row_digest, chain_digest, created_at, actor_fellow_id, actor_sponsor_id)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'F-CN2N', 'usr_sponsor_cn2n')`,
        [
          eventId,
          problemId,
          seq,
          type,
          objectKind,
          objectId,
          sha,
          `row:${eventId}`,
          `sha256:${eventId}`,
          ts,
        ],
      );
      sqlite.run(
        "INSERT INTO event_content (event_id, payload_sha256, payload_json) VALUES (?, ?, ?)",
        [eventId, sha, payload],
      );
      return { sha, ts };
    };

    // seq 2: gap.closed-by MUST mark SYN-GAP (covers_through=1) stale, NOT SYN-DE (covers_through=2).
    const gapClose = seedMaterialEvent("E-SC-2", 2, "gap.closed-by", "gap", "G-1");
    await enqueueOutboxJob(db, {
      eventId: "E-SC-2",
      problemId,
      kind: "synthesis.staleness",
      payloadSha256: gapClose.sha,
      createdAt: gapClose.ts,
    });
    // seq 3: non-material commentary event MUST NOT mark SYN-DE stale.
    const comm = seedMaterialEvent("E-SC-3", 3, "commentary.created", "commentary", "CM-1");
    await enqueueOutboxJob(db, {
      eventId: "E-SC-3",
      problemId,
      kind: "synthesis.staleness",
      payloadSha256: comm.sha,
      createdAt: comm.ts,
    });
    // seq 4: dead_end.recorded (canonical underscore!) MUST mark SYN-DE stale at seq 4.
    const deadEnd = seedMaterialEvent("E-SC-4", 4, "dead_end.recorded", "dead_end", "DE-1");
    await enqueueOutboxJob(db, {
      eventId: "E-SC-4",
      problemId,
      kind: "synthesis.staleness",
      payloadSha256: deadEnd.sha,
      createdAt: deadEnd.ts,
    });

    const drainer = new KraterOutboxDrainer(fakeDoState(), { DB: db });
    const drainRes = await drainer.fetch(
      new Request("https://krater-outbox.internal/drain-now", { method: "POST", body: "{}" }),
    );
    expect(drainRes.status).toBe(200);
    const body = (await drainRes.json()) as { delivered: number; quarantined: number };
    expect(body.delivered).toBe(3);
    expect(body.quarantined).toBe(0);

    const synGap = sqlite
      .prepare(
        "SELECT stale_since_seq, stale_since_event_id FROM synthesis_staleness_markers WHERE synthesis_id = 'SYN-GAP'",
      )
      .get() as { stale_since_seq: number; stale_since_event_id: string } | null;
    expect(synGap).toEqual({ stale_since_seq: 2, stale_since_event_id: "E-SC-2" });

    const synDe = sqlite
      .prepare(
        "SELECT stale_since_seq, stale_since_event_id FROM synthesis_staleness_markers WHERE synthesis_id = 'SYN-DE'",
      )
      .get() as { stale_since_seq: number; stale_since_event_id: string } | null;
    expect(synDe).toEqual({ stale_since_seq: 4, stale_since_event_id: "E-SC-4" });
    sqlite.close();
  });

  test("REGRESSION (Wave 12 TOCTOU): claim redacted concurrently during async embedding is quarantined with 0 persisted embeddings", async () => {
    const sqlite = migratedSqlite({ strict: true });
    const db = localD1(sqlite);
    const problemId = "P-TOCTOU-EMB";

    const c1 = seedPublicClaim(sqlite, {
      problemId,
      claimId: "C-1",
      eventId: "E-TOCTOU-1",
      seq: 1,
      statement: "Smoothness invariant candidate statement.",
    });
    await enqueueOutboxJob(db, {
      eventId: "E-TOCTOU-1",
      problemId,
      kind: "embedding.compute",
      payloadSha256: c1.sha,
      createdAt: c1.ts,
    });

    // Simulate an operator redacting event_content mid-flight during async embedding inference.
    const drainer = new KraterOutboxDrainer(fakeDoState(), {
      DB: db,
      embedText: async () => {
        sqlite.run(
          "UPDATE event_content SET redacted_at = '2026-09-10T00:05:00.000Z', redaction_reason = 'lawful-takedown' WHERE event_id = 'E-TOCTOU-1'",
        );
        return {
          vector: [1, 0, 0],
          modelId: "@cf/baai/bge-base-en-v1.5",
          modelVersion: "test-toctou-v1",
        };
      },
    });

    const drainRes = await drainer.fetch(
      new Request("https://krater-outbox.internal/drain-now", { method: "POST", body: "{}" }),
    );
    expect(drainRes.status).toBe(200);
    const body = (await drainRes.json()) as { delivered: number; quarantined: number };
    expect(body.delivered).toBe(0);
    expect(body.quarantined).toBe(1);

    const embCount = sqlite
      .prepare("SELECT COUNT(*) AS n FROM public_claim_embeddings WHERE problem_id = ?")
      .get(problemId) as { n: number };
    expect(embCount.n).toBe(0);

    // Also verify screening.enrich skips redacted events and writes 0 enrichment rows.
    await enqueueOutboxJob(db, {
      eventId: "E-TOCTOU-1",
      problemId,
      kind: "screening.enrich",
      payloadSha256: c1.sha,
      createdAt: c1.ts,
    });
    const enrichDrainer = new KraterOutboxDrainer(fakeDoState(), { DB: db });
    await enrichDrainer.fetch(
      new Request("https://krater-outbox.internal/drain-now", { method: "POST", body: "{}" }),
    );
    const enrichCount = sqlite
      .prepare("SELECT COUNT(*) AS n FROM screening_enrichment_records WHERE problem_id = ?")
      .get(problemId) as { n: number };
    expect(enrichCount.n).toBe(0);

    // Wave 15 regression: screening.enrich refuses unpublished seq > public_seq events (quarantined, 0 rows).
    const c2 = seedPublicClaim(sqlite, {
      problemId,
      claimId: "C-2",
      eventId: "E-TOCTOU-UNPUB",
      seq: 2,
      statement: "Unpublished future seq with https://doi.org/10.1000/future-seq",
    });
    sqlite.run("UPDATE problems SET public_seq = 1 WHERE id = ?", [problemId]);
    await enqueueOutboxJob(db, {
      eventId: "E-TOCTOU-UNPUB",
      problemId,
      kind: "screening.enrich",
      payloadSha256: c2.sha,
      createdAt: c2.ts,
    });
    const unpubDrainer = new KraterOutboxDrainer(fakeDoState(), { DB: db });
    const unpubDrain = await unpubDrainer.fetch(
      new Request("https://krater-outbox.internal/drain-now", { method: "POST", body: "{}" }),
    );
    expect(unpubDrain.status).toBe(200);
    const unpubBody = (await unpubDrain.json()) as { delivered: number; quarantined: number };
    expect(unpubBody.delivered).toBe(0);
    expect(unpubBody.quarantined).toBe(1);
    const unpubEnrichCount = sqlite
      .prepare("SELECT COUNT(*) AS n FROM screening_enrichment_records WHERE event_id = ?")
      .get("E-TOCTOU-UNPUB") as { n: number };
    expect(unpubEnrichCount.n).toBe(0);
    sqlite.close();
  });
});
