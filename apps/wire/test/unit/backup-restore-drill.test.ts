import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { type BackupBucket, backupProblem } from "../../src/krater/backup.ts";
import {
  parseExportHeader,
  parseExportTrailer,
  verifyProblemExportChain,
} from "../../src/krater/export.ts";
import {
  canonicalJson,
  checkpointDigest,
  eventChainDigest,
  eventEnvelopeRowDigest,
  genesisChainDigest,
  sha256Hex,
} from "../../src/krater/krater.ts";
import { KraterRestoreRefusedError, restoreProblemExport } from "../../src/krater/restore.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");
const DATE = "2026-08-20";
const NOW = "2026-08-20T00:00:00Z";
const BOUNDARY = "staged D1/R2 restore not claimed - provider execution remains an ops item";

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

function freshDb() {
  const sqlite = new Database(":memory:");
  for (const f of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    sqlite.run(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  return { sqlite, db: localD1(sqlite) };
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

function insert(db: ReturnType<typeof localD1>, query: string, ...values: unknown[]) {
  return (
    db as unknown as {
      prepare: (q: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown> } };
    }
  )
    .prepare(query)
    .bind(...values)
    .run();
}

/**
 * Seed a problem with `eventCount` chain-valid claim events exactly the way
 * the canonical write path would land them: one problems head advanced per
 * event, event + event_content + per-event checkpoint rows, v2 sidecars
 * installed by the schema's own after-insert triggers.
 */
async function seedClaimProblem(
  db: ReturnType<typeof localD1>,
  problemId: string,
  eventCount: number,
) {
  const genesis = await genesisChainDigest(problemId);
  await insert(
    db,
    "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_digest, chain_version) VALUES (?, 0, ?, ?, ?, 2)",
    problemId,
    NOW,
    NOW,
    genesis,
  );
  await insert(
    db,
    "INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version) VALUES (?, 'complete', 0, ?, 2)",
    problemId,
    NOW,
  );

  let previous = genesis;
  for (let seq = 1; seq <= eventCount; seq += 1) {
    const eventId = `E-${seq}-${problemId}`;
    const claimId = `C-${seq}-${problemId}`;
    const statement = `drill claim ${seq} for ${problemId}`;
    const payloadJson = canonicalJson({ claim_id: claimId, kind: "claim", statement });
    const payloadSha256 = await sha256Hex(payloadJson);
    const rowDigest = await eventEnvelopeRowDigest({
      eventId,
      problemId,
      seq,
      type: "claim.created",
      objectKind: "claim",
      objectId: claimId,
      objectVersion: 1,
      payloadSha256,
      createdAt: NOW,
      actorFellowId: null,
      actorSponsorId: null,
      actorSessionId: null,
      modelStringSelfDeclared: null,
      harness: null,
      writerCredentialId: null,
    });
    const chain = await eventChainDigest(problemId, seq, payloadSha256, rowDigest, previous);
    const checkpoint = await checkpointDigest(problemId, seq, chain);

    await insert(
      db,
      "UPDATE problems SET public_seq = ?, chain_digest = ?, updated_at = ? WHERE id = ?",
      seq,
      chain,
      NOW,
      problemId,
    );
    await insert(
      db,
      "INSERT INTO events (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, created_at, row_digest, chain_digest) VALUES (?, ?, ?, 'claim.created', 'claim', ?, 1, ?, ?, ?, ?)",
      eventId,
      problemId,
      seq,
      claimId,
      payloadSha256,
      NOW,
      rowDigest,
      chain,
    );
    await insert(
      db,
      "INSERT INTO event_content (event_id, payload_sha256, payload_json) VALUES (?, ?, ?)",
      eventId,
      payloadSha256,
      payloadJson,
    );
    await insert(
      db,
      "INSERT INTO integrity_checkpoints (problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest, checkpoint_version, checkpoint_mode, created_at) VALUES (?, ?, ?, ?, 1, 'unsigned-v0', ?)",
      problemId,
      seq,
      chain,
      checkpoint,
      NOW,
    );
    previous = chain;
  }
}

/** The event ledger rows both databases expose for the row-for-row diff. */
type LedgerRow = {
  event_id: string;
  seq: number;
  row_digest: string;
  chain_digest: string;
  payload_sha256: string;
  payload_json: string;
};

function ledgerRows(sqlite: Database, problemId: string): LedgerRow[] {
  return sqlite
    .prepare(
      `SELECT e.id AS event_id, e.seq, c.row_digest, c.chain_digest,
              ct.payload_sha256, ct.payload_json
       FROM events e
       JOIN event_chain_v2 c ON c.event_id = e.id
       JOIN event_content ct ON ct.event_id = e.id
       WHERE e.problem_id = ? ORDER BY e.seq ASC`,
    )
    .all(problemId) as LedgerRow[];
}

function checkpointRows(
  sqlite: Database,
  problemId: string,
): { checkpoint_seq: number; root_chain_digest: string; checkpoint_digest: string }[] {
  return sqlite
    .prepare(
      `SELECT checkpoint_seq, root_chain_digest, checkpoint_digest
       FROM integrity_checkpoints WHERE problem_id = ? ORDER BY checkpoint_seq ASC`,
    )
    .all(problemId) as {
    checkpoint_seq: number;
    root_chain_digest: string;
    checkpoint_digest: string;
  }[];
}

function receipt(status: "pass" | "fail", extra: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ status, receipt: "backup-restore-drill.v1", mode: "local", ...extra }),
  );
}

describe("the W2.8 backup restore drill", () => {
  test("a backed-up problem restores row for row into a fresh database", async () => {
    const origin = freshDb();
    const bucket = fakeBucket();
    const problems = ["P-DRILL-A", "P-DRILL-B"];
    for (const problemId of problems) await seedClaimProblem(origin.db, problemId, 2);

    const bundles = new Map<string, string>();
    for (const problemId of problems) {
      const result = await backupProblem(origin.db, bucket, problemId, `title ${problemId}`, DATE);
      expect(result).not.toBeNull();
      const ndjson = bucket.writes.get(result?.key ?? "");
      expect(typeof ndjson).toBe("string");
      bundles.set(problemId, ndjson ?? "");
      // The stored bundle self-verifies before it is trusted for restore.
      expect((await verifyProblemExportChain(ndjson ?? "")).intact).toBe(true);
    }

    for (const problemId of problems) {
      const ndjson = bundles.get(problemId) ?? "";
      const lines = ndjson.trim().split("\n");
      const header = parseExportHeader(lines[0] ?? "");
      const trailer = parseExportTrailer(lines[lines.length - 1] ?? "");
      expect(header.ok).toBe(true);
      expect(trailer.ok).toBe(true);

      const scratch = freshDb();
      // The negative pre-state: a fresh database starts with no problem rows.
      expect(scratch.sqlite.prepare("SELECT COUNT(*) AS n FROM problems").get()).toEqual({ n: 0 });

      const result = await restoreProblemExport(scratch.db, ndjson);
      expect(result.restored).toBe(problemId);
      expect(result.eventCount).toBe(2);
      expect(result.finalSeq).toBe(trailer.ok ? trailer.finalCursor : -1);
      // problems.public_seq equals the bundle's final cursor, and the head
      // digest is the last event's chain digest.
      const restoredProblem = scratch.sqlite
        .prepare(
          "SELECT public_seq, chain_digest, created_at, updated_at FROM problems WHERE id = ?",
        )
        .get(problemId) as
        | { public_seq: number; chain_digest: string; created_at: string; updated_at: string }
        | undefined;
      expect(restoredProblem?.public_seq).toBe(trailer.ok ? trailer.finalCursor : -1);
      expect(restoredProblem?.chain_digest).toBe(result.chainDigest);
      expect(restoredProblem?.created_at).toBe(NOW);
      expect(restoredProblem?.updated_at).toBe(NOW);

      // Row-for-row: events, chain sidecars, and payload bytes are identical.
      expect(ledgerRows(scratch.sqlite, problemId)).toEqual(ledgerRows(origin.sqlite, problemId));
      // Checkpoint rows restore byte for byte.
      expect(checkpointRows(scratch.sqlite, problemId)).toEqual(
        checkpointRows(origin.sqlite, problemId),
      );
      // The claims projection rows rebuild from the restored payloads.
      const claims = scratch.sqlite
        .prepare(
          "SELECT id, statement, source_seq FROM claims WHERE problem_id = ? ORDER BY source_seq",
        )
        .all(problemId) as { id: string; statement: string; source_seq: number }[];
      expect(claims.map((c) => c.source_seq)).toEqual([1, 2]);
      expect(claims[0]?.statement).toBe(`drill claim 1 for ${problemId}`);

      // Closing the loop: re-backing up the restored database produces the
      // exact same bundle bytes (the export is a lossless function of state).
      const rebacked = fakeBucket();
      const reResult = await backupProblem(
        scratch.db,
        rebacked,
        problemId,
        `title ${problemId}`,
        DATE,
      );
      expect(rebacked.writes.get(reResult?.key ?? "")).toBe(ndjson);
    }

    receipt("pass", {
      problems,
      boundary: BOUNDARY,
    });
  });

  test("PLANTED: one flipped payload byte refuses the restore before any write", async () => {
    const origin = freshDb();
    const bucket = fakeBucket();
    await seedClaimProblem(origin.db, "P-DRILL-TAMPER", 2);
    const result = await backupProblem(origin.db, bucket, "P-DRILL-TAMPER", "t", DATE);
    const ndjson = bucket.writes.get(result?.key ?? "") ?? "";
    expect((await verifyProblemExportChain(ndjson)).intact).toBe(true);

    // Flip exactly one byte inside the first event's payload_json bytes.
    const lines = ndjson.trim().split("\n");
    const tamperedLine = (lines[1] ?? "").replace("drill claim 1", "drill clbim 1");
    expect(tamperedLine).not.toBe(lines[1]);
    lines[1] = tamperedLine;
    const tampered = `${lines.join("\n")}\n`;

    const scratch = freshDb();
    let refusalCode = "";
    try {
      await restoreProblemExport(scratch.db, tampered);
    } catch (error) {
      if (error instanceof KraterRestoreRefusedError) refusalCode = error.code;
    }
    expect(refusalCode).toBe("KRATER_RESTORE_REFUSED");
    // Verify-first law: not one row was written by the refused restore.
    expect(scratch.sqlite.prepare("SELECT COUNT(*) AS n FROM problems").get()).toEqual({ n: 0 });
    expect(scratch.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });

    receipt("fail", {
      case: "tampered payload byte",
      refusal_code: refusalCode,
      boundary: BOUNDARY,
    });
  });

  test("PLANTED: a bundle missing its terminal record refuses before any write", async () => {
    const origin = freshDb();
    const bucket = fakeBucket();
    await seedClaimProblem(origin.db, "P-DRILL-TRUNC", 2);
    const result = await backupProblem(origin.db, bucket, "P-DRILL-TRUNC", "t", DATE);
    const ndjson = bucket.writes.get(result?.key ?? "") ?? "";
    const truncated = `${ndjson.trim().split("\n").slice(0, -1).join("\n")}\n`;

    const scratch = freshDb();
    let refusalCode = "";
    try {
      await restoreProblemExport(scratch.db, truncated);
    } catch (error) {
      if (error instanceof KraterRestoreRefusedError) refusalCode = error.code;
    }
    expect(refusalCode).toBe("KRATER_RESTORE_REFUSED");
    expect(scratch.sqlite.prepare("SELECT COUNT(*) AS n FROM problems").get()).toEqual({ n: 0 });
  });
});
