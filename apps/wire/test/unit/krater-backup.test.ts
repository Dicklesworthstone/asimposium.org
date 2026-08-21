import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { type BackupBucket, backupKeyFor, backupProblem } from "../../src/krater/backup.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

function localD1(sqlite: Database) {
  return {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        all: async <T>() => ({ results: sqlite.prepare(query).all(...(values as never)) as T[] }),
        first: async <T>() => (sqlite.prepare(query).get(...(values as never)) as T) ?? null,
        run: async () => {
          const result = sqlite.prepare(query).run(...(values as never));
          return { meta: { changes: result.changes } };
        },
      }),
    }),
  } as never;
}

function freshDb(): ReturnType<typeof localD1> {
  const sqlite = new Database(":memory:");
  for (const f of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    sqlite.run(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  return localD1(sqlite);
}

function fakeBucket(): BackupBucket & { readonly writes: Map<string, string> } {
  const writes = new Map<string, string>();
  return {
    writes,
    put: async (key, body) => {
      writes.set(key, body);
      return {};
    },
  };
}

/** Seed a problem + one chain-valid event directly, computing the chain. */
async function seedClaimProblem(db: ReturnType<typeof localD1>, problemId: string) {
  const { genesisChainDigest, eventChainDigest, eventRowDigest } = await import(
    "../../src/krater/krater.ts"
  );
  const genesis = await genesisChainDigest(problemId);
  const payloadSha256 = "ab".repeat(32);
  const chain = await eventChainDigest(problemId, 1, payloadSha256, genesis);
  const now = "2026-08-20T00:00:00Z";
  const rowDigest = await eventRowDigest(
    {
      problemId,
      claimId: "C-1",
      eventId: `E-1-${problemId}`,
      idempotencyKey: `test-${problemId}`,
      statement: "seeded",
      createdAt: now,
    },
    1,
    payloadSha256,
  );
  const insert = (query: string, ...values: unknown[]) =>
    (
      db as unknown as {
        prepare: (q: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown> } };
      }
    )
      .prepare(query)
      .bind(...values)
      .run();
  await insert(
    "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_digest) VALUES (?, 1, ?, ?, ?)",
    problemId,
    now,
    now,
    chain,
  );
  // Mark the integrity backfill complete so the chain-head trigger is satisfied.
  await insert(
    "INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at) VALUES (?, 'complete', 0, ?)",
    problemId,
    now,
  );
  await insert(
    "INSERT INTO events (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, created_at, row_digest, chain_digest) VALUES (?, ?, 1, 'claim.created', 'claim', 'C-1', 1, ?, ?, ?, ?)",
    `E-1-${problemId}`,
    problemId,
    payloadSha256,
    now,
    rowDigest,
    chain,
  );
}

describe("the W2.8 backup export", () => {
  test("a problem with no events writes nothing", async () => {
    const db = freshDb();
    const bucket = fakeBucket();
    const result = await backupProblem(db as never, bucket, "P-EMPTY", "empty", "2026-08-20");
    expect(result).toBeNull();
    expect(bucket.writes.size).toBe(0);
  });

  test("a problem's backup verifies its own chain before writing", async () => {
    const db = freshDb();
    const bucket = fakeBucket();
    await seedClaimProblem(db, "P-4DSP");
    const result = await backupProblem(db as never, bucket, "P-4DSP", "t", "2026-08-20");
    expect(result).not.toBeNull();
    expect(result?.eventCount).toBe(1);
    expect(bucket.writes.size).toBe(1);
    const written = bucket.writes.values().next().value as string;
    // The written bytes are a self-verifying export.
    const { verifyProblemExportChain } = await import("../../src/krater/export.ts");
    const reverify = await verifyProblemExportChain(written);
    expect(reverify.intact).toBe(true);
  });

  test("the backup key is dated and content-addressed", async () => {
    const key = backupKeyFor("2026-08-20", "P-4DSP", "sha256:" + "ab".repeat(32));
    expect(key).toMatch(/^backups\/2026-08-20\/P-4DSP\/[a-f0-9]{32}\.jsonl$/);
  });
});
