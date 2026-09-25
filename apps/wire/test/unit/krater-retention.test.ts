import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { type BackupBucket, backupProblem } from "../../src/krater/backup.ts";
import { checkpointSigningKey } from "../../src/krater/checkpoint-signing.ts";
import {
  canonicalJson,
  checkpointDigest,
  eventChainDigest,
  eventEnvelopeRowDigest,
  genesisChainDigest,
  sha256Hex,
} from "../../src/krater/krater.ts";
import { KraterRestoreRefusedError } from "../../src/krater/restore.ts";
import {
  createRetentionControlRecord,
  deletionSafeRestore,
  expireSecurityRecords,
  hardDeletePrivateDraft,
  parseAndVerifyDeletionJournal,
  RetentionError,
  readDeletionJournalRecords,
  serializeDeletionJournal,
  validateScratchTarget,
  verifyRetentionControlRecord,
} from "../../src/krater/retention.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");
const NOW = "2026-08-20T00:00:00Z";
const DATE = "2026-08-20";

async function journalKeys(seedByte = "11", kid = "journal-test-1") {
  const signing = await checkpointSigningKey(JSON.stringify({ kid, seedHex: seedByte.repeat(32) }));
  if (signing === null) throw new Error("test signing key did not parse");
  return { signing, verify: [{ kid, publicKeyHex: signing.publicKeyHex }] };
}

function localD1(sqlite: Database) {
  return {
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
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
    prepare: (query: string) => {
      const bound = (...values: unknown[]) => ({
        all: async <T>() => ({ results: sqlite.prepare(query).all(...(values as never)) as T[] }),
        first: async <T>() => (sqlite.prepare(query).get(...(values as never)) as T) ?? null,
        run: async () => {
          const result = sqlite.prepare(query).run(...(values as never));
          return { meta: { changes: result.changes } };
        },
      });
      return { ...bound(), bind: bound };
    },
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

async function seedClaimProblem(
  db: ReturnType<typeof localD1>,
  problemId: string,
  eventCount: number,
) {
  const genesis = await genesisChainDigest(problemId);
  const insert = (q: string, ...v: unknown[]) =>
    (
      db as unknown as {
        prepare: (q: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown> } };
      }
    )
      .prepare(q)
      .bind(...v)
      .run();

  await insert(
    "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_digest, chain_version, status, sponsor_id) VALUES (?, 0, ?, ?, ?, 2, 'active', 'usr_sponsor_1')",
    problemId,
    NOW,
    NOW,
    genesis,
  );
  await insert(
    "INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version) VALUES (?, 'complete', 0, ?, 2)",
    problemId,
    NOW,
  );

  let previous = genesis;
  for (let seq = 1; seq <= eventCount; seq += 1) {
    const eventId = `E-${seq}-${problemId}`;
    const claimId = `C-${seq}-${problemId}`;
    const statement = `retention test claim ${seq} for ${problemId}`;
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
      "UPDATE problems SET public_seq = ?, chain_digest = ?, updated_at = ? WHERE id = ?",
      seq,
      chain,
      NOW,
      problemId,
    );
    await insert(
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
      "INSERT INTO event_content (event_id, payload_sha256, payload_json) VALUES (?, ?, ?)",
      eventId,
      payloadSha256,
      payloadJson,
    );
    await insert(
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

describe("W2.8 Retention enforcement and deletion-safe restore", () => {
  describe("validateScratchTarget", () => {
    test("accepts valid scratch and quarantine target identifiers", () => {
      expect(() => validateScratchTarget("scratch_local_d1")).not.toThrow();
      expect(() => validateScratchTarget("quarantine-db-2")).not.toThrow();
      expect(() => validateScratchTarget("test-scratch-restore")).not.toThrow();
      expect(() => validateScratchTarget("drill-20260820")).not.toThrow();
      expect(() => validateScratchTarget(":memory:")).not.toThrow();
      expect(() => validateScratchTarget("local-scratch-restore-target")).not.toThrow();
    });

    test("refuses production and staging targets", () => {
      expect(() => validateScratchTarget("prod-d1-database")).toThrow(KraterRestoreRefusedError);
      expect(() => validateScratchTarget("production_asimp")).toThrow(KraterRestoreRefusedError);
      expect(() => validateScratchTarget("staging-asimp-d1")).toThrow(KraterRestoreRefusedError);
      expect(() => validateScratchTarget("live-cluster")).toThrow(KraterRestoreRefusedError);
      expect(() => validateScratchTarget("primary-db")).toThrow(KraterRestoreRefusedError);
      expect(() => validateScratchTarget("main-d1")).toThrow(KraterRestoreRefusedError);
    });

    test("refuses empty or non-scratch identifiers", () => {
      expect(() => validateScratchTarget("")).toThrow(KraterRestoreRefusedError);
      expect(() => validateScratchTarget("   ")).toThrow(KraterRestoreRefusedError);
      expect(() => validateScratchTarget("customer-d1")).toThrow(KraterRestoreRefusedError);
    });
  });

  describe("Retention Control Records and Deletion Journal", () => {
    test("creates, canonicalizes, and verifies retention control records", async () => {
      const record = await createRetentionControlRecord({
        action: "delete-private-draft",
        targetId: "P-DRAFT-123",
        targetType: "problem",
        payload: { sponsor_id: "usr_sponsor_1", note: "abandoned test" },
        issuedAt: NOW,
      });

      expect(record.controlId.startsWith("RC-")).toBe(true);
      expect(record.controlDigest).toMatch(/^[a-f0-9]{64}$/);

      const verification = await verifyRetentionControlRecord(record);
      expect(verification.valid).toBe(true);

      // Tampered digest fails verification
      const tamperedRecord = { ...record, controlDigest: "0".repeat(64) };
      const failedVerification = await verifyRetentionControlRecord(tamperedRecord);
      expect(failedVerification.valid).toBe(false);
      if (!failedVerification.valid) {
        expect(failedVerification.reason).toContain("tampered");
      }
    });

    test("serializes and parses deletion journals round-trip", async () => {
      const rec1 = await createRetentionControlRecord({
        action: "delete-private-draft",
        targetId: "P-DRAFT-1",
        targetType: "problem",
        issuedAt: NOW,
      });
      const rec2 = await createRetentionControlRecord({
        action: "revoke-credential",
        targetId: "cred_tok_456",
        targetType: "credential",
        issuedAt: NOW,
      });

      const keys = await journalKeys();
      const journal = await serializeDeletionJournal([rec1, rec2], NOW, keys.signing);
      expect(journal).toContain("deletion_journal_header");
      expect(journal).toContain("deletion_journal_end");

      const parsed = await parseAndVerifyDeletionJournal(journal, keys.verify);
      expect(parsed.valid).toBe(true);
      if (parsed.valid) {
        expect(parsed.records.length).toBe(2);
        expect(parsed.records[0]?.targetId).toBe("P-DRAFT-1");
        expect(parsed.records[1]?.targetId).toBe("cred_tok_456");
      }
    });

    test("fails closed on tampered journal records or corrupt trailer", async () => {
      const rec = await createRetentionControlRecord({
        action: "delete-private-draft",
        targetId: "P-TAMPER",
        targetType: "problem",
        issuedAt: NOW,
      });
      const keys = await journalKeys();
      const journal = await serializeDeletionJournal([rec], NOW, keys.signing);

      // Tamper a payload in the journal line
      const tamperedJournal = journal.replace("P-TAMPER", "P-HACKED");
      const result = await parseAndVerifyDeletionJournal(tamperedJournal, keys.verify);
      expect(result.valid).toBe(false);

      // Truncated journal missing trailer fails
      const lines = journal.trim().split("\n");
      const truncatedJournal = `${lines[0]}\n${lines[1]}\n`;
      const truncatedResult = await parseAndVerifyDeletionJournal(truncatedJournal, keys.verify);
      expect(truncatedResult.valid).toBe(false);
    });

    test("PLANTED: an unkeyed journal rebuilt without a record is refused", async () => {
      const kept = await createRetentionControlRecord({
        action: "delete-private-draft",
        targetId: "P-KEPT",
        targetType: "problem",
        issuedAt: NOW,
      });
      const dropped = await createRetentionControlRecord({
        action: "delete-private-draft",
        targetId: "P-DROPPED",
        targetType: "problem",
        issuedAt: NOW,
      });
      const keys = await journalKeys();
      const signed = await serializeDeletionJournal([kept, dropped], NOW, keys.signing);
      expect((await parseAndVerifyDeletionJournal(signed, keys.verify)).valid).toBe(true);
      // The chain is unkeyed, so an attacker can recompute it over fewer
      // records. Without the signing key the result is unsigned and refused.
      const shortened = await serializeDeletionJournal([kept], NOW);
      const refused = await parseAndVerifyDeletionJournal(shortened, keys.verify);
      expect(refused).toEqual({ valid: false, reason: "journal is unsigned" });
      // A signature from a key that is not configured is refused.
      const stranger = await journalKeys("22", "journal-test-1");
      const forged = await serializeDeletionJournal([kept], NOW, stranger.signing);
      expect((await parseAndVerifyDeletionJournal(forged, keys.verify)).valid).toBe(false);
      // No configured verify key refuses everything.
      expect((await parseAndVerifyDeletionJournal(signed, [])).valid).toBe(false);
      // A shortened journal cannot reuse the old signature.
      const trailer = JSON.parse(signed.trim().split("\n").at(-1) ?? "{}");
      const splice = shortened
        .trim()
        .split("\n")
        .map((line, i, all) =>
          i === all.length - 1
            ? JSON.stringify({
                ...JSON.parse(line),
                key_id: trailer.key_id,
                signature: trailer.signature,
              })
            : line,
        )
        .join("\n");
      expect((await parseAndVerifyDeletionJournal(`${splice}\n`, keys.verify)).valid).toBe(false);
    });
  });

  describe("hardDeletePrivateDraft", () => {
    test("successfully hard-deletes never-published private draft and issues receipt", async () => {
      const { sqlite, db } = freshDb();
      const problemId = "P-PRIVATE-DRAFT-1";
      const sponsorId = "usr_sponsor_alpha";

      // Seed private draft problem with statement version and workshop objects
      sqlite.run(
        `INSERT INTO problems (id, public_seq, status, unlisted, sponsor_id, created_by_fellow_id, title, current_statement_version, chain_version, chain_digest, created_at, updated_at)
         VALUES (?, 0, 'private-draft', 1, ?, 'fel_1', 'Private Exploration', 1, 2, 'genesis-chain', ?, ?)`,
        [problemId, sponsorId, NOW, NOW],
      );
      sqlite.run(
        `INSERT INTO problem_statement_versions (problem_id, version, statement, norm_hash, falsifier, motivation, created_at)
         VALUES (?, 1, 'Draft hypothesis statement', 'hash123', 'Falsifier test', 'Motivation test', ?)`,
        [problemId, NOW],
      );
      sqlite.run(
        `INSERT INTO problem_stewards (problem_id, sponsor_id, is_founding, created_at)
         VALUES (?, ?, 1, ?)`,
        [problemId, sponsorId, NOW],
      );

      // Check pre-state
      const preCount = sqlite
        .prepare("SELECT COUNT(*) AS n FROM problems WHERE id = ?")
        .get(problemId) as { n: number };
      expect(preCount.n).toBe(1);

      // Execute hard delete
      const result = await hardDeletePrivateDraft(db, problemId, sponsorId, { now: NOW });
      expect(result.ok).toBe(true);
      expect(result.problemId).toBe(problemId);
      expect(result.receipt.backupRetentionWindowDays).toBe(90);
      expect(result.receipt.legalHoldException).toBe(false);
      expect(result.receipt.sharedPublicHashConsequence).toBe(
        "private-bytes-purged-shared-public-hashes-retained",
      );
      expect(result.receipt.expectedPhysicalErasureDeadline).toBe("2026-11-18T00:00:00.000Z");

      // Verify post-state: completely removed
      const postProblem = sqlite
        .prepare("SELECT COUNT(*) AS n FROM problems WHERE id = ?")
        .get(problemId) as { n: number };
      expect(postProblem.n).toBe(0);

      const postVersions = sqlite
        .prepare("SELECT COUNT(*) AS n FROM problem_statement_versions WHERE problem_id = ?")
        .get(problemId) as { n: number };
      expect(postVersions.n).toBe(0);

      const postStewards = sqlite
        .prepare("SELECT COUNT(*) AS n FROM problem_stewards WHERE problem_id = ?")
        .get(problemId) as { n: number };
      expect(postStewards.n).toBe(0);

      // The deletion committed its journal row in the same batch, and the
      // journal is append-only.
      const journal = await readDeletionJournalRecords(db);
      expect(journal).toHaveLength(1);
      expect(journal[0]?.controlId).toBe(result.controlRecord.controlId);
      expect(journal[0]?.targetId).toBe(problemId);
      expect(() => sqlite.run("DELETE FROM deletion_journal")).toThrow("append-only");
      expect(() => sqlite.run("UPDATE deletion_journal SET target_id = 'x'")).toThrow(
        "append-only",
      );
    });

    test("refuses deletion of public problems or problems with committed events", async () => {
      const { db } = freshDb();
      const publicProblemId = "P-PUBLIC-IMMUTABLE";
      await seedClaimProblem(db, publicProblemId, 2);

      await expect(
        hardDeletePrivateDraft(db, publicProblemId, "usr_sponsor_1", { now: NOW }),
      ).rejects.toThrow(RetentionError);

      try {
        await hardDeletePrivateDraft(db, publicProblemId, "usr_sponsor_1", { now: NOW });
      } catch (err) {
        expect(err instanceof RetentionError).toBe(true);
        if (err instanceof RetentionError) {
          expect(err.code).toBe("CANNOT_DELETE_NON_DRAFT_PROBLEM");
        }
      }
    });

    test("refuses deletion by unauthorized sponsor", async () => {
      const { sqlite, db } = freshDb();
      const problemId = "P-PRIVATE-DRAFT-2";
      sqlite.run(
        `INSERT INTO problems (id, public_seq, status, unlisted, sponsor_id, created_by_fellow_id, title, current_statement_version, chain_version, chain_digest, created_at, updated_at)
         VALUES (?, 0, 'private-draft', 1, 'usr_sponsor_owner', 'fel_1', 'Private Exploration', 1, 2, 'genesis-chain', ?, ?)`,
        [problemId, NOW, NOW],
      );

      await expect(
        hardDeletePrivateDraft(db, problemId, "usr_sponsor_attacker", { now: NOW }),
      ).rejects.toThrow(RetentionError);

      try {
        await hardDeletePrivateDraft(db, problemId, "usr_sponsor_attacker", { now: NOW });
      } catch (err) {
        expect(err instanceof RetentionError).toBe(true);
        if (err instanceof RetentionError) {
          expect(err.code).toBe("GOVERNANCE_NOT_AUTHORIZED");
        }
      }
    });

    test("refuses deletion when subject to legal hold", async () => {
      const { sqlite, db } = freshDb();
      const problemId = "P-PRIVATE-DRAFT-LEGAL";
      sqlite.run(
        `INSERT INTO problems (id, public_seq, status, unlisted, sponsor_id, created_by_fellow_id, title, current_statement_version, chain_version, chain_digest, created_at, updated_at)
         VALUES (?, 0, 'private-draft', 1, 'usr_sponsor_1', 'fel_1', 'Draft', 1, 2, 'genesis-chain', ?, ?)`,
        [problemId, NOW, NOW],
      );

      await expect(
        hardDeletePrivateDraft(db, problemId, "usr_sponsor_1", { now: NOW, legalHold: true }),
      ).rejects.toThrow("LEGAL_HOLD_EXCLUSION");
    });
  });

  describe("expireSecurityRecords", () => {
    test("cleans up expired nonces, lookup attempts, and device codes", async () => {
      const { sqlite, db } = freshDb();
      const nowMs = 1724112000000; // 2026-08-20T00:00:00.000Z

      // Nonces are epoch SECONDS, as auth/nonce.ts writes them. PLANTED: a
      // live nonce 60s ahead must survive (a ms comparison deletes it).
      const nowS = Math.floor(nowMs / 1000);
      sqlite.run(
        "INSERT INTO auth_envelope_nonces (nonce_hash, expires_at, claimed_at) VALUES (?, ?, ?)",
        ["a".repeat(64), nowS - 1, nowS - 60],
      );
      sqlite.run(
        "INSERT INTO auth_envelope_nonces (nonce_hash, expires_at, claimed_at) VALUES (?, ?, ?)",
        ["b".repeat(64), nowS + 60, nowS],
      );

      // Seed old device lookup attempt (> 24 hours ago) and fresh attempt
      sqlite.run(
        "INSERT INTO device_lookup_attempts (sponsor_id, attempted_at, success) VALUES ('sp1', ?, 0)",
        [nowMs - 25 * 3600 * 1000],
      );
      sqlite.run(
        "INSERT INTO device_lookup_attempts (sponsor_id, attempted_at, success) VALUES ('sp1', ?, 0)",
        [nowMs - 3600 * 1000],
      );

      const result = await expireSecurityRecords(db, { nowMs });
      expect(result.expiredNonces).toBe(1);
      expect(result.expiredLookupAttempts).toBe(1);

      // Nonce table has only the active nonce remaining
      const remainingNonces = sqlite
        .prepare("SELECT COUNT(*) AS n FROM auth_envelope_nonces")
        .get() as { n: number };
      expect(remainingNonces.n).toBe(1);
      expect(
        sqlite.prepare("SELECT nonce_hash FROM auth_envelope_nonces").get() as {
          nonce_hash: string;
        },
      ).toEqual({ nonce_hash: "b".repeat(64) });

      // Lookups table has only the fresh lookup remaining
      const remainingLookups = sqlite
        .prepare("SELECT COUNT(*) AS n FROM device_lookup_attempts")
        .get() as { n: number };
      expect(remainingLookups.n).toBe(1);
    });
  });

  describe("deletionSafeRestore", () => {
    test("restores into scratch database and replays deletion controls", async () => {
      const origin = freshDb();
      const bucket = fakeBucket();
      const problemId = "P-DEL-SAFE-1";
      await seedClaimProblem(origin.db, problemId, 2);

      const backup = await backupProblem(origin.db, bucket, problemId, "title", DATE);
      expect(backup).not.toBeNull();
      const snapshotNdjson = bucket.writes.get(backup?.key ?? "") ?? "";

      // Also create a deletion journal that deleted a private draft
      const draftDeleteControl = await createRetentionControlRecord({
        action: "delete-private-draft",
        targetId: "P-DRAFT-PURGED",
        targetType: "problem",
        issuedAt: NOW,
      });
      const keys = await journalKeys();
      const journalNdjson = await serializeDeletionJournal([draftDeleteControl], NOW, keys.signing);

      const scratch = freshDb();
      // Plant the draft in scratch as if an older snapshot had it
      scratch.sqlite.run(
        `INSERT INTO problems (id, public_seq, status, unlisted, sponsor_id, created_by_fellow_id, title, current_statement_version, chain_version, chain_digest, created_at, updated_at)
         VALUES ('P-DRAFT-PURGED', 0, 'private-draft', 1, 'usr_sponsor_1', 'fel_1', 'To Be Purged', 1, 2, 'genesis-chain', ?, ?)`,
        [NOW, NOW],
      );
      expect(
        (
          scratch.sqlite
            .prepare("SELECT COUNT(*) AS n FROM problems WHERE id = 'P-DRAFT-PURGED'")
            .get() as { n: number }
        ).n,
      ).toBe(1);

      const restoreResult = await deletionSafeRestore({
        db: scratch.db,
        targetIdentifier: "scratch_verified_d1",
        snapshotNdjson,
        deletionJournalNdjson: journalNdjson,
        verifyKeys: keys.verify,
      });

      expect(restoreResult.restored).toBe(problemId);
      expect(restoreResult.eventCount).toBe(2);
      expect(restoreResult.appliedControlsCount).toBe(1);

      // The deleted draft was purged by the replay
      const draftCheck = scratch.sqlite
        .prepare("SELECT COUNT(*) AS n FROM problems WHERE id = 'P-DRAFT-PURGED'")
        .get() as { n: number };
      expect(draftCheck.n).toBe(0);

      // The restored public problem exists with its events intact
      const publicCheck = scratch.sqlite
        .prepare("SELECT COUNT(*) AS n FROM problems WHERE id = ?")
        .get(problemId) as { n: number };
      expect(publicCheck.n).toBe(1);
    });

    test("refuses deletionSafeRestore on non-scratch target", async () => {
      const { db } = freshDb();
      await expect(
        deletionSafeRestore({
          db,
          targetIdentifier: "production-live-d1",
          snapshotNdjson: "",
          deletionJournalNdjson: null,
          verifyKeys: [],
        }),
      ).rejects.toThrow("RESTORE_NON_SCRATCH_TARGET_REFUSED");
    });

    test("PLANTED: a restore without the deletion journal refuses before any write", async () => {
      const origin = freshDb();
      const bucket = fakeBucket();
      await seedClaimProblem(origin.db, "P-NO-JOURNAL", 2);
      const backup = await backupProblem(origin.db, bucket, "P-NO-JOURNAL", "title", DATE);
      const snapshotNdjson = bucket.writes.get(backup?.key ?? "") ?? "";
      const scratch = freshDb();
      const keys = await journalKeys();
      await expect(
        deletionSafeRestore({
          db: scratch.db,
          targetIdentifier: "scratch_no_journal",
          snapshotNdjson,
          deletionJournalNdjson: undefined,
          verifyKeys: keys.verify,
        }),
      ).rejects.toThrow("DELETION_JOURNAL_MISSING");
      const rows = scratch.sqlite.prepare("SELECT COUNT(*) AS n FROM problems").get() as {
        n: number;
      };
      expect(rows.n).toBe(0);
    });
  });
});
