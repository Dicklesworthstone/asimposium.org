import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import { retentionCredentialRevoker } from "../../src/enrollment/service.ts";
import { type BackupBucket, backupProblem } from "../../src/krater/backup.ts";
import {
  type CheckpointVerifyKey,
  checkpointSigningKey,
} from "../../src/krater/checkpoint-signing.ts";
import {
  CONTENT_CONTROL_COLUMNS,
  prepareContentControlReplay,
} from "../../src/krater/content-control-retention.ts";
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
  applyDeletionJournal,
  computeRetentionControlDigest,
  createRetentionControlRecord,
  deletionJournalObjectKey,
  deletionSafeRestore,
  expireSecurityRecords,
  fetchLatestDeletionJournal,
  findResurrectedTargets,
  hardDeletePrivateDraft,
  parseAndVerifyDeletionJournal,
  publishDeletionJournal,
  type ReadCurrentDeletionJournal,
  RetentionError,
  readDeletionJournalRecords,
  serializeDeletionJournal,
  sponsorAccountDeletionStatements,
  validateScratchTarget,
  verifyRetentionControlRecord,
} from "../../src/krater/retention.ts";
import { hideSponsorProblem } from "../../src/moderation/problem-hide.ts";
import { applyOperatorControl, fileReport, resolveReport } from "../../src/moderation/store.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");
const NOW = "2026-08-20T00:00:00Z";
const DATE = "2026-08-20";

async function journalKeys(seedByte = "11", kid = "journal-test-1") {
  const signing = await checkpointSigningKey(JSON.stringify({ kid, seedHex: seedByte.repeat(32) }));
  if (signing === null) throw new Error("test signing key did not parse");
  return { signing, verify: [{ kid, publicKeyHex: signing.publicKeyHex }] };
}

/** Static authority for the existing isolated SQL unit fixtures. Native
 * journeys acquire this independently from the current private R2 binding. */
async function fixedJournalReader(
  sourceJournal: string,
  keys: readonly CheckpointVerifyKey[],
): Promise<ReadCurrentDeletionJournal> {
  const verified = await parseAndVerifyDeletionJournal(sourceJournal, keys);
  if (!verified.valid) throw new Error(verified.reason);
  return async () => verified.head;
}

/** Storage-shaped unit fixture only. The native journey uses real R2. */
function journalBucket() {
  const bodies = new Map<string, string>();
  const bucket = {
    async list(options: { prefix: string }) {
      return {
        objects: [...bodies.keys()]
          .filter((key) => key.startsWith(options.prefix))
          .sort()
          .map((key) => ({ key })),
        truncated: false,
      };
    },
    async get(key: string) {
      const body = bodies.get(key);
      return body === undefined ? null : { text: async () => body };
    },
    async head(key: string) {
      return bodies.has(key) ? { key } : null;
    },
    async put(key: string, body: string) {
      if (bodies.has(key)) return null;
      bodies.set(key, body);
      return { key };
    },
  } as unknown as R2Bucket;
  return { bucket, bodies };
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
        all: async <T>() => ({
          success: true,
          results: sqlite.prepare(query).all(...(values as never)) as T[],
          meta: { changes: 0 },
        }),
        first: async <T>() => (sqlite.prepare(query).get(...(values as never)) as T) ?? null,
        run: async () => {
          if (/^\s*SELECT\b/i.test(query)) {
            return {
              success: true,
              results: sqlite.prepare(query).all(...(values as never)),
              meta: { changes: 0 },
            };
          }
          const result = sqlite.prepare(query).run(...(values as never));
          return { success: true, results: [], meta: { changes: result.changes } };
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

function seedBriefReceipt(
  sqlite: Database,
  sponsorId: string,
  keyDigit: string,
  expiresAt: number,
) {
  const createdAt = expiresAt - 24 * 60 * 60 * 1000;
  sqlite.run(
    "INSERT OR IGNORE INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)",
    [sponsorId, createdAt, createdAt],
  );
  sqlite.run(
    `INSERT INTO sponsor_brief_command_receipts
      (sponsor_id,key_digest,operation,request_digest,brief_id,brief_version,
       brief_created_at,brief_updated_at,created_at,expires_at)
     VALUES (?, ?, 'save', ?, ?, 1, ?, ?, ?, ?)`,
    [
      sponsorId,
      keyDigit.repeat(64),
      "f".repeat(64),
      `${sponsorId}-brief-${keyDigit}`,
      NOW,
      NOW,
      createdAt,
      expiresAt,
    ],
  );
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
      sqlite.run("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, 1, 1)", [
        sponsorId,
      ]);

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
      expect(result.rowsDeleted).toEqual({
        workshopObjects: 0,
        workshopRevisions: 0,
        sessions: 0,
        statementVersions: 1,
        memberships: 0,
        stewards: 1,
        claims: 0,
        problem: 1,
      });
      expect(result.receipt.backupRetentionWindowDays).toBe(90);
      expect(result.receipt.legalHoldException).toBe(false);
      expect(result.receipt.sharedPublicHashConsequence).toBe(
        "artifact-bytes-follow-retention-policy-shared-public-hashes-retained",
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

    test("refuses deletion of a missing problem without writing an erasure journal", async () => {
      const { db } = freshDb();
      await expect(
        hardDeletePrivateDraft(db, "P-ABSENT-DRAFT", "usr_sponsor_1", { now: NOW }),
      ).rejects.toThrow("PROBLEM_NOT_FOUND");
      expect(await readDeletionJournalRecords(db)).toEqual([]);
    });
  });

  describe("expireSecurityRecords", () => {
    test("expires sponsor brief receipts at their millisecond boundary and keeps live receipts", async () => {
      const { sqlite, db } = freshDb();
      const nowMs = Date.parse(NOW);
      seedBriefReceipt(sqlite, "usr_receipt_expiry", "a", nowMs - 1);
      seedBriefReceipt(sqlite, "usr_receipt_expiry", "b", nowMs);
      seedBriefReceipt(sqlite, "usr_receipt_expiry", "c", nowMs + 1);

      const result = await expireSecurityRecords(db, { nowMs });
      expect(result.expiredSponsorBriefReceipts).toBe(2);
      expect(
        sqlite.prepare("SELECT key_digest, expires_at FROM sponsor_brief_command_receipts").all(),
      ).toEqual([{ key_digest: "c".repeat(64), expires_at: nowMs + 1 }]);

      const later = await expireSecurityRecords(db, { nowMs: nowMs + 1 });
      expect(later.expiredSponsorBriefReceipts).toBe(1);
      expect(
        sqlite.prepare("SELECT COUNT(*) AS n FROM sponsor_brief_command_receipts").get(),
      ).toEqual({ n: 0 });
    });

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

  describe("sponsor brief receipt account erasure", () => {
    test("account deletion removes only the intended sponsor's receipts and keeps the sponsor tombstone", async () => {
      const { sqlite, db } = freshDb();
      const nowMs = Date.parse(NOW);
      const owner = "usr_receipt_deleted";
      const other = "usr_receipt_retained";
      seedBriefReceipt(sqlite, owner, "a", nowMs + 60_000);
      seedBriefReceipt(sqlite, owner, "b", nowMs + 60_000);
      // Identical key hashes in different sponsor scopes are independent.
      seedBriefReceipt(sqlite, other, "a", nowMs + 60_000);
      const retained = sqlite
        .prepare("SELECT * FROM sponsor_brief_command_receipts WHERE sponsor_id = ?")
        .all(other);

      const results = await (db as D1Database).batch(
        sponsorAccountDeletionStatements(db, owner, nowMs),
      );
      expect(results[0]?.meta.changes).toBe(1);
      expect(
        sqlite.prepare("SELECT tombstoned_at FROM sponsors WHERE sponsor_id = ?").get(owner),
      ).toEqual({ tombstoned_at: nowMs });
      expect(
        sqlite.prepare("SELECT tombstoned_at FROM sponsors WHERE sponsor_id = ?").get(other),
      ).toEqual({ tombstoned_at: null });
      expect(
        sqlite
          .prepare("SELECT * FROM sponsor_brief_command_receipts WHERE sponsor_id = ?")
          .all(owner),
      ).toEqual([]);
      expect(sqlite.prepare("SELECT * FROM sponsor_brief_command_receipts").all()).toEqual(
        retained,
      );
    });

    test("deletion journal replay erases restored receipts even when the sponsor is already tombstoned", async () => {
      const { sqlite, db } = freshDb();
      const nowMs = Date.parse(NOW);
      const owner = "usr_receipt_restored";
      const other = "usr_receipt_untouched";
      seedBriefReceipt(sqlite, owner, "a", nowMs + 60_000);
      sqlite.run("UPDATE sponsors SET tombstoned_at = ? WHERE sponsor_id = ?", [nowMs, owner]);
      seedBriefReceipt(sqlite, other, "a", nowMs + 60_000);
      const retained = sqlite
        .prepare("SELECT * FROM sponsor_brief_command_receipts WHERE sponsor_id = ?")
        .all(other);
      const control = await createRetentionControlRecord({
        action: "delete-account-private-data",
        targetId: owner,
        targetType: "user_private_data",
        payload: { sponsor_id: owner, deleted_at: NOW },
        issuedAt: NOW,
      });
      const keys = await journalKeys();
      const journal = await serializeDeletionJournal([control], NOW, keys.signing);

      const replay = await applyDeletionJournal({
        db,
        targetIdentifier: "scratch_brief_receipt_erasure",
        deletionJournalNdjson: journal,
        verifyKeys: keys.verify,
        readCurrentJournal: await fixedJournalReader(journal, keys.verify),
      });
      expect(replay.appliedControlsCount).toBe(1);
      expect(sqlite.prepare("SELECT * FROM sponsor_brief_command_receipts").all()).toEqual(
        retained,
      );
      expect(
        sqlite.prepare("SELECT tombstoned_at FROM sponsors WHERE sponsor_id = ?").get(owner),
      ).toEqual({ tombstoned_at: nowMs });
      expect(await findResurrectedTargets(db, [control])).toEqual([]);
    });
  });

  describe("current deletion-journal authority", () => {
    test("publishes and authenticates an empty head once instead of treating absence as authority", async () => {
      const { db } = freshDb();
      const store = journalBucket();
      const keys = await journalKeys();
      const rawKey = JSON.stringify({ kid: keys.signing.kid, seedHex: "11".repeat(32) });
      expect(await publishDeletionJournal(db, store.bucket, rawKey, () => NOW)).toEqual({
        enabled: true,
        recordCount: 0,
        published: true,
      });
      expect(await publishDeletionJournal(db, store.bucket, rawKey, () => NOW)).toEqual({
        enabled: true,
        recordCount: 0,
        published: false,
      });
      const latest = await fetchLatestDeletionJournal(store.bucket, keys.verify);
      expect(latest?.head).toEqual({
        recordCount: 0,
        finalDigest: await sha256Hex("genesis-deletion-journal"),
      });
    });

    test("binds the authenticated count to a canonical storage key", async () => {
      const keys = await journalKeys();
      const empty = await serializeDeletionJournal([], NOW, keys.signing);
      const store = journalBucket();
      expect(await fetchLatestDeletionJournal(store.bucket, keys.verify)).toBeNull();
      store.bodies.set(deletionJournalObjectKey(1), empty);
      await expect(fetchLatestDeletionJournal(store.bucket, keys.verify)).rejects.toThrow(
        "DELETION_JOURNAL_HEAD_MISMATCH",
      );
      store.bodies.clear();
      store.bodies.set("journal/deletion/v1/1.ndjson", empty);
      await expect(fetchLatestDeletionJournal(store.bucket, keys.verify)).rejects.toThrow(
        "DELETION_JOURNAL_KEY_INVALID",
      );
      for (const count of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 10_000_000_000]) {
        expect(() => deletionJournalObjectKey(count)).toThrow("DELETION_JOURNAL_KEY_INVALID");
      }
    });

    test("does not fall back to a historical journal when the newest object is missing or invalid", async () => {
      const keys = await journalKeys();
      const store = journalBucket();
      store.bodies.set(
        deletionJournalObjectKey(0),
        await serializeDeletionJournal([], NOW, keys.signing),
      );
      store.bodies.set(deletionJournalObjectKey(1), "not a signed journal\n");
      await expect(fetchLatestDeletionJournal(store.bucket, keys.verify)).rejects.toThrow(
        "DELETION_JOURNAL_VERIFICATION_FAILED",
      );
      const missing = {
        list: store.bucket.list.bind(store.bucket),
        get: async () => null,
      } as unknown as R2Bucket;
      await expect(fetchLatestDeletionJournal(missing, keys.verify)).rejects.toThrow(
        "DELETION_JOURNAL_OBJECT_MISSING",
      );
    });

    test("refuses a publication racing acquisition instead of returning a known stale head", async () => {
      const keys = await journalKeys();
      const empty = await serializeDeletionJournal([], NOW, keys.signing);
      const control = await createRetentionControlRecord({
        action: "delete-private-draft",
        targetId: "P-ACQUISITION-RACE",
        targetType: "problem",
        issuedAt: NOW,
      });
      const current = await serializeDeletionJournal([control], NOW, keys.signing);
      const store = journalBucket();
      store.bodies.set(deletionJournalObjectKey(0), empty);
      const racing = {
        list: store.bucket.list.bind(store.bucket),
        get: async (key: string) => {
          const object = await store.bucket.get(key);
          store.bodies.set(deletionJournalObjectKey(1), current);
          return object;
        },
      } as unknown as R2Bucket;
      await expect(fetchLatestDeletionJournal(racing, keys.verify)).rejects.toThrow(
        "DELETION_JOURNAL_CHANGED",
      );
      expect((await fetchLatestDeletionJournal(store.bucket, keys.verify))?.ndjson).toBe(current);
    });

    test.each(["journal replay", "problem restore"] as const)(
      "%s refuses authentic old or divergent journals before any writes, then accepts the current head",
      async (operation) => {
        const first = await createRetentionControlRecord({
          action: "delete-private-draft",
          targetId: "P-OLD-CONTROL",
          targetType: "problem",
          issuedAt: NOW,
          payload: { sponsor_id: "usr_sponsor_1" },
        });
        const second = await createRetentionControlRecord({
          action: "delete-private-draft",
          targetId: "P-NEW-CONTROL",
          targetType: "problem",
          issuedAt: NOW,
          payload: { sponsor_id: "usr_sponsor_1" },
        });
        const different = await createRetentionControlRecord({
          action: "delete-private-draft",
          targetId: "P-DIFFERENT-CONTROL",
          targetType: "problem",
          issuedAt: NOW,
          payload: { sponsor_id: "usr_sponsor_1" },
        });
        const keys = await journalKeys();
        const old = await serializeDeletionJournal([first], NOW, keys.signing);
        const current = await serializeDeletionJournal([first, second], NOW, keys.signing);
        const divergent = await serializeDeletionJournal([first, different], NOW, keys.signing);
        expect((await parseAndVerifyDeletionJournal(old, keys.verify)).valid).toBe(true);
        expect((await parseAndVerifyDeletionJournal(divergent, keys.verify)).valid).toBe(true);
        const store = journalBucket();
        store.bodies.set(deletionJournalObjectKey(1), old);
        store.bodies.set(deletionJournalObjectKey(2), current);
        const readCurrentJournal = async () =>
          (await fetchLatestDeletionJournal(store.bucket, keys.verify))?.head ?? null;

        let snapshotNdjson = "";
        if (operation === "problem restore") {
          const origin = freshDb();
          const backupBucket = fakeBucket();
          await seedClaimProblem(origin.db, "P-CURRENT-JOURNAL", 2);
          const backup = await backupProblem(
            origin.db,
            backupBucket,
            "P-CURRENT-JOURNAL",
            "Current journal restore",
            DATE,
          );
          snapshotNdjson = backupBucket.writes.get(backup?.key ?? "") ?? "";
        }
        const scratch = freshDb();
        for (const id of [first.targetId, second.targetId]) {
          scratch.sqlite.run(
            `INSERT INTO problems
              (id, public_seq, status, unlisted, sponsor_id, title, created_at, updated_at)
             VALUES (?, 0, 'private-draft', 1, 'usr_sponsor_1', 'Restored private draft', ?, ?)`,
            [id, NOW, NOW],
          );
        }
        const restore = (
          deletionJournalNdjson: string,
          reader: ReadCurrentDeletionJournal = readCurrentJournal,
        ) => {
          const options = {
            db: scratch.db,
            targetIdentifier: "scratch_current_journal",
            deletionJournalNdjson,
            verifyKeys: keys.verify,
            readCurrentJournal: reader,
          };
          return operation === "journal replay"
            ? applyDeletionJournal(options)
            : deletionSafeRestore({ ...options, snapshotNdjson });
        };
        const before = scratch.sqlite.prepare("SELECT total_changes() AS n").get();
        await expect(restore(old)).rejects.toThrow("DELETION_JOURNAL_STALE");
        await expect(restore(divergent)).rejects.toThrow("DELETION_JOURNAL_STALE");
        await expect(restore(current, async () => null)).rejects.toThrow(
          "DELETION_JOURNAL_CURRENT_HEAD_MISSING",
        );
        await expect(
          restore(current, async () => ({ recordCount: -1, finalDigest: "a".repeat(64) })),
        ).rejects.toThrow("DELETION_JOURNAL_CURRENT_HEAD_INVALID");
        await expect(restore(current, async () => undefined as never)).rejects.toThrow(
          "DELETION_JOURNAL_CURRENT_HEAD_INVALID",
        );
        await expect(restore(current, async () => ({}) as never)).rejects.toThrow(
          "DELETION_JOURNAL_CURRENT_HEAD_INVALID",
        );
        // JavaScript callers can omit or corrupt the new authority field;
        // the required TypeScript field is not the runtime enforcement.
        for (const reader of [undefined, null, "not-a-reader", {}]) {
          const missingReader = {
            db: scratch.db,
            targetIdentifier: "scratch_current_journal",
            deletionJournalNdjson: current,
            verifyKeys: keys.verify,
            readCurrentJournal: reader as unknown as ReadCurrentDeletionJournal,
          };
          await expect(
            operation === "journal replay"
              ? applyDeletionJournal(missingReader)
              : deletionSafeRestore({ ...missingReader, snapshotNdjson }),
          ).rejects.toThrow("DELETION_JOURNAL_CURRENT_HEAD_REQUIRED");
        }
        expect(scratch.sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(before);
        expect(scratch.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
        expect(scratch.sqlite.prepare("SELECT COUNT(*) AS n FROM problems").get()).toEqual({
          n: 2,
        });

        expect((await restore(current)).appliedControlsCount).toBe(2);
        expect(
          scratch.sqlite.prepare("SELECT id FROM problems WHERE status = 'private-draft'").all(),
        ).toEqual([]);
        expect(scratch.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({
          n: operation === "problem restore" ? 2 : 0,
        });
        expect((await restore(current)).appliedControlsCount).toBe(2);
      },
    );

    test("withholds completion when a newer journal is published during replay, and permits retry", async () => {
      const first = await createRetentionControlRecord({
        action: "delete-private-draft",
        targetId: "P-DURING-REPLAY-1",
        targetType: "problem",
        issuedAt: NOW,
        payload: { sponsor_id: "usr_sponsor_1" },
      });
      const second = await createRetentionControlRecord({
        action: "delete-private-draft",
        targetId: "P-DURING-REPLAY-2",
        targetType: "problem",
        issuedAt: NOW,
        payload: { sponsor_id: "usr_sponsor_1" },
      });
      const keys = await journalKeys();
      const old = await serializeDeletionJournal([first], NOW, keys.signing);
      const current = await serializeDeletionJournal([first, second], NOW, keys.signing);
      const store = journalBucket();
      store.bodies.set(deletionJournalObjectKey(1), old);
      const scratch = freshDb();
      let reads = 0;
      const readCurrentJournal = async () => {
        // The independently held journal advances between preflight and the
        // final serviceability decision, after replay has applied its controls.
        if (++reads === 2) store.bodies.set(deletionJournalObjectKey(2), current);
        return (await fetchLatestDeletionJournal(store.bucket, keys.verify))?.head ?? null;
      };
      const options = {
        db: scratch.db,
        targetIdentifier: "scratch_concurrent_journal",
        verifyKeys: keys.verify,
        readCurrentJournal,
      };
      await expect(
        applyDeletionJournal({ ...options, deletionJournalNdjson: old }),
      ).rejects.toThrow("DELETION_JOURNAL_STALE");
      expect(reads).toBe(2);
      expect(scratch.sqlite.prepare("SELECT problem_id FROM private_draft_erasures").all()).toEqual(
        [{ problem_id: first.targetId }],
      );
      const replay = await applyDeletionJournal({ ...options, deletionJournalNdjson: current });
      expect(replay.appliedControlsCount).toBe(2);
      expect(
        scratch.sqlite
          .prepare("SELECT problem_id FROM private_draft_erasures ORDER BY problem_id")
          .all(),
      ).toEqual([{ problem_id: first.targetId }, { problem_id: second.targetId }]);
    });
  });

  describe("visibility control recovery", () => {
    const problem = "P-VISIBILITY-RECOVERY";
    const reason = "PRIVATE-CONTROL-RATIONALE: withdraw these bytes pending review.";
    const control = (visibility: "hidden" | "visible", targetRef = "problem") => ({
      problemId: problem,
      targetKind: targetRef === "problem" ? "problem" : "claim",
      targetRef,
      visibility,
      reason,
    });
    const rows = (sqlite: Database) =>
      sqlite
        .prepare(`SELECT ${CONTENT_CONTROL_COLUMNS.join(", ")} FROM content_controls
        ORDER BY problem_id, target_ref, version`)
        .all();

    test("every visibility writer journals its exact control and journal failure rolls back the decision", async () => {
      const source = freshDb();
      await seedClaimProblem(source.db, problem, 2);
      await applyOperatorControl(source.db, "operator-fixture", control("hidden"));
      await applyOperatorControl(source.db, "operator-fixture", control("visible"));
      const claim = `C-1-${problem}`;
      const reports = [];
      for (let index = 0; index < 3; index += 1) {
        reports.push(
          await fileReport(source.db, {
            problemId: problem,
            targetKind: "claim",
            targetRef: claim,
            reason: "unsafe-content",
            note: null,
            reporterClass: "sponsor",
            reporterFellowId: null,
            reporterSponsorId: `usr_reporter_${index}`,
          }),
        );
      }
      expect(reports.at(-1)?.targetHidden).toBe(true);
      const firstReport = reports[0];
      if (!firstReport) throw new Error("Expected the first independent report");
      expect(
        await resolveReport(source.db, "operator-fixture", {
          reportId: firstReport.reportId,
          resolution: "dismiss",
          reason: "Reviewed the reported source and dismissed this concern.",
        }),
      ).toMatchObject({ ok: true });
      source.sqlite.run(
        "INSERT INTO sponsors(sponsor_id,created_at,last_seen_at) VALUES('usr_sponsor_1',?,?)",
        [Date.now(), Date.now()],
      );
      await hideSponsorProblem(
        source.db,
        "usr_sponsor_1",
        {
          problem_id: problem,
          reason,
          step_up_authenticated_at: Math.floor(Date.now() / 1000),
        },
        "recovery-sponsor-hide",
      );
      const records = await readDeletionJournalRecords(source.db);
      expect(records).toHaveLength(5);
      for (const row of rows(source.sqlite) as Record<string, unknown>[]) {
        const record = records.find((entry) => entry.targetId === row.control_id);
        expect(record?.payload).toEqual(row);
        expect((await verifyRetentionControlRecord(record)).valid).toBe(true);
      }
      expect(
        JSON.stringify(source.sqlite.prepare("SELECT * FROM moderation_log").all()),
      ).not.toContain(reason);
      const before = rows(source.sqlite);
      const beforeCursor = source.sqlite.prepare("SELECT cursor FROM public_cursor").all();
      source.sqlite.run(`CREATE TRIGGER refuse_visibility_journal BEFORE INSERT ON deletion_journal
        BEGIN SELECT RAISE(ABORT, 'PLANTED_JOURNAL_FAILURE'); END`);
      await expect(
        applyOperatorControl(source.db, "operator-fixture", control("visible")),
      ).rejects.toThrow("PLANTED_JOURNAL_FAILURE");
      expect(rows(source.sqlite)).toEqual(before);
      expect(source.sqlite.prepare("SELECT cursor FROM public_cursor").all()).toEqual(beforeCursor);
      expect(await readDeletionJournalRecords(source.db)).toEqual(records);
    });

    test("a pre-hide snapshot replays exact decisions and a later authenticated restore remains visible", async () => {
      const source = freshDb();
      await seedClaimProblem(source.db, problem, 2);
      const backups = fakeBucket();
      const backup = await backupProblem(source.db, backups, problem, "Visibility recovery", DATE);
      expect(backup).not.toBeNull();
      if (!backup) throw new Error("Expected a completed pre-hide snapshot");
      const snapshotNdjson = backups.writes.get(backup.key);
      if (!snapshotNdjson) throw new Error("Expected the pre-hide snapshot bytes");
      await applyOperatorControl(source.db, "operator-fixture", control("hidden"));
      await applyOperatorControl(
        source.db,
        "operator-fixture",
        control("hidden", `C-1-${problem}`),
      );
      const keys = await journalKeys();
      const store = journalBucket();
      const signing = JSON.stringify({ kid: keys.signing.kid, seedHex: "11".repeat(32) });
      await publishDeletionJournal(source.db, store.bucket, signing, () => NOW);
      const current = await fetchLatestDeletionJournal(store.bucket, keys.verify);
      if (!current) throw new Error("Expected current signed visibility controls");
      const scratch = freshDb();
      const options = {
        db: scratch.db,
        targetIdentifier: "scratch-visibility-recovery",
        verifyKeys: keys.verify,
        readCurrentJournal: async () =>
          (await fetchLatestDeletionJournal(store.bucket, keys.verify))?.head ?? null,
      };
      await deletionSafeRestore({
        ...options,
        snapshotNdjson,
        deletionJournalNdjson: current.ndjson,
      });
      expect(rows(scratch.sqlite)).toEqual(rows(source.sqlite));
      expect(
        await findResurrectedTargets(scratch.db, await readDeletionJournalRecords(source.db)),
      ).toEqual([]);
      await applyOperatorControl(source.db, "operator-fixture", control("visible"));
      await publishDeletionJournal(source.db, store.bucket, signing, () => NOW);
      const newer = await fetchLatestDeletionJournal(store.bucket, keys.verify);
      if (!newer) throw new Error("Expected the authenticated restoration decision");
      await applyDeletionJournal({ ...options, deletionJournalNdjson: newer.ndjson });
      await applyDeletionJournal({ ...options, deletionJournalNdjson: newer.ndjson });
      expect(rows(scratch.sqlite)).toEqual(rows(source.sqlite));
      expect(
        scratch.sqlite
          .prepare(`SELECT visibility FROM content_controls
        WHERE target_ref = 'problem' ORDER BY version DESC LIMIT 1`)
          .get(),
      ).toEqual({ visibility: "visible" });
      const before = scratch.sqlite.prepare("SELECT total_changes() AS n").get();
      await expect(
        applyDeletionJournal({ ...options, deletionJournalNdjson: current.ndjson }),
      ).rejects.toThrow("DELETION_JOURNAL_STALE");
      expect(scratch.sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    });

    test("conflicting source identities refuse before any writes and concurrent controls roll back the whole replay batch", async () => {
      const source = freshDb();
      await seedClaimProblem(source.db, problem, 2);
      await applyOperatorControl(source.db, "source-operator", control("hidden"));
      await applyOperatorControl(source.db, "source-operator", control("hidden", `C-1-${problem}`));
      const records = await readDeletionJournalRecords(source.db);
      const scratch = freshDb();
      await seedClaimProblem(scratch.db, problem, 2);
      const replay = await prepareContentControlReplay(scratch.db, records);
      await applyOperatorControl(
        scratch.db,
        "scratch-operator",
        control("hidden", `C-1-${problem}`),
      );
      const before = rows(scratch.sqlite);
      // The problem group precedes the claim group, so a later predecessor
      // conflict must undo even the earlier group's successful INSERT.
      await expect(replay.apply()).rejects.toThrow();
      expect(rows(scratch.sqlite)).toEqual(before);
      const keys = await journalKeys();
      const journal = await serializeDeletionJournal(records, NOW, keys.signing);
      const beforeChanges = scratch.sqlite.prepare("SELECT total_changes() AS n").get();
      await expect(
        applyDeletionJournal({
          db: scratch.db,
          targetIdentifier: "scratch-conflicting-visibility",
          deletionJournalNdjson: journal,
          verifyKeys: keys.verify,
          readCurrentJournal: await fixedJournalReader(journal, keys.verify),
        }),
      ).rejects.toThrow("CONTENT_CONTROL_RECOVERY_CONFLICT");
      expect(scratch.sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(beforeChanges);
    });

    test("publication rejects matching metadata that conceals a different authenticated journal action", async () => {
      const source = freshDb();
      await seedClaimProblem(source.db, problem, 1);
      const legacy = {
        control_id: "CC-ENVELOPE-MISMATCH",
        problem_id: problem,
        target_kind: "problem",
        target_ref: "problem",
        visibility: "hidden",
        source: "operator",
        reason_category: "operator-review",
        actor: "historic-operator",
        reason,
        version: 1,
        created_at: NOW,
        actor_kind: null,
      };
      source.sqlite.run(
        `INSERT INTO content_controls (${CONTENT_CONTROL_COLUMNS.join(", ")})
        VALUES (${CONTENT_CONTROL_COLUMNS.map(() => "?").join(", ")})`,
        CONTENT_CONTROL_COLUMNS.map((column) => legacy[column]),
      );
      const concealed = {
        ...(await createRetentionControlRecord({
          action: "cancel-enrollment",
          targetId: legacy.control_id,
          targetType: "enrollment",
          issuedAt: NOW,
          payload: legacy,
        })),
        controlId: `RC-${legacy.control_id}`,
      };
      concealed.controlDigest = await computeRetentionControlDigest(concealed);
      expect((await verifyRetentionControlRecord(concealed)).valid).toBe(true);
      source.sqlite.run(
        `INSERT INTO deletion_journal
        (control_id,action,target_type,target_id,control_digest,record_json,created_at)
        VALUES (?,'content-control','content_control',?,?,?,?)`,
        [
          concealed.controlId,
          legacy.control_id,
          concealed.controlDigest,
          JSON.stringify(concealed),
          NOW,
        ],
      );
      const store = journalBucket();
      const before = source.sqlite.prepare("SELECT total_changes() AS n").get();
      await expect(
        publishDeletionJournal(
          source.db,
          store.bucket,
          JSON.stringify({ kid: "journal-test-1", seedHex: "11".repeat(32) }),
          () => NOW,
        ),
      ).rejects.toThrow("CONTENT_CONTROL_JOURNAL_CONFLICT");
      expect(store.bodies.size).toBe(0);
      expect(source.sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    });

    test("publication backfills historical decisions in bounded steps and never publishes partial coverage", async () => {
      const source = freshDb();
      await seedClaimProblem(source.db, problem, 1);
      // Historical controls precede journaling support, but remain immutable
      // source authority. Do not remove or disable the journal's own guards.
      for (let version = 1; version <= 101; version += 1) {
        source.sqlite.run(
          `INSERT INTO content_controls
          (control_id,problem_id,target_kind,target_ref,visibility,source,
           reason_category,actor,reason,version,created_at)
          VALUES (?,?,'problem','problem','hidden','operator','operator-review',
            'historic-operator',?,?,?)`,
          [`CC-HISTORICAL-${version}`, problem, reason, version, NOW],
        );
      }
      const store = journalBucket();
      const keys = await journalKeys();
      const signing = JSON.stringify({ kid: keys.signing.kid, seedHex: "11".repeat(32) });
      await expect(
        publishDeletionJournal(source.db, store.bucket, signing, () => NOW),
      ).rejects.toThrow("CONTENT_CONTROL_JOURNAL_BACKFILL_PENDING");
      expect(store.bodies.size).toBe(0);
      expect(await readDeletionJournalRecords(source.db)).toHaveLength(100);
      expect(
        await publishDeletionJournal(source.db, store.bucket, signing, () => NOW),
      ).toMatchObject({ published: true, recordCount: 101 });
      expect((await fetchLatestDeletionJournal(store.bucket, keys.verify))?.head.recordCount).toBe(
        101,
      );
      expect(
        await publishDeletionJournal(source.db, store.bucket, signing, () => NOW),
      ).toMatchObject({ published: false, recordCount: 101 });
      expect(rows(source.sqlite)).toHaveLength(101);
    });
  });

  describe("restore action support", () => {
    test.each(["journal replay", "problem restore"] as const)(
      "%s refuses a signed unsupported action before any supported control or snapshot write",
      async (operation) => {
        const draftId = "P-DRAFT-BEFORE-UNSUPPORTED";
        const publicId = "P-UNSUPPORTED-RESTORE";
        const supported = await createRetentionControlRecord({
          action: "delete-private-draft",
          targetId: draftId,
          targetType: "problem",
          payload: { sponsor_id: "usr_sponsor_1" },
          issuedAt: NOW,
        });
        const unsupported = await createRetentionControlRecord({
          action: "unbind-private-cas",
          targetId: "a".repeat(64),
          targetType: "cas_artifact",
          issuedAt: NOW,
        });
        // The supported mutation deliberately precedes the unsupported action:
        // refusing only when replay reaches that action would be too late.
        const controls = [supported, unsupported];
        const keys = await journalKeys();
        const signed = await serializeDeletionJournal(controls, NOW, keys.signing);
        const verified = await parseAndVerifyDeletionJournal(signed, keys.verify);
        expect(verified.valid).toBe(true);
        if (verified.valid) expect(verified.records).toEqual(controls);

        let snapshotNdjson = "";
        if (operation === "problem restore") {
          const origin = freshDb();
          const bucket = fakeBucket();
          await seedClaimProblem(origin.db, publicId, 2);
          const backup = await backupProblem(origin.db, bucket, publicId, "title", DATE);
          expect(backup).not.toBeNull();
          snapshotNdjson = bucket.writes.get(backup?.key ?? "") ?? "";
        }

        const scratch = freshDb();
        scratch.sqlite.run(
          `INSERT INTO problems (id, public_seq, status, unlisted, sponsor_id, title, created_at, updated_at)
           VALUES (?, 0, 'private-draft', 1, 'usr_sponsor_1', 'Retained on refused restore', ?, ?)`,
          [draftId, NOW, NOW],
        );
        const changesBefore = scratch.sqlite.prepare("SELECT total_changes() AS n").get();
        const readCurrentJournal = await fixedJournalReader(signed, keys.verify);
        const restore = (deletionJournalNdjson: string) => {
          const options = {
            db: scratch.db,
            targetIdentifier: "scratch_unsupported_action",
            deletionJournalNdjson,
            verifyKeys: keys.verify,
            readCurrentJournal,
          };
          return operation === "journal replay"
            ? applyDeletionJournal(options)
            : deletionSafeRestore({ ...options, snapshotNdjson });
        };

        // Authenticity is still checked first; unsupported actions remain
        // parseable and exportable, but cannot authorize a successful restore.
        const unsigned = await serializeDeletionJournal(controls, NOW);
        await expect(restore(unsigned)).rejects.toThrow(
          "DELETION_JOURNAL_VERIFICATION_FAILED: journal is unsigned",
        );
        await expect(restore(signed)).rejects.toThrow(
          "DELETION_CONTROL_UNSUPPORTED: this restore cannot replay or verify 'unbind-private-cas'",
        );
        expect(scratch.sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(changesBefore);
        expect(scratch.sqlite.prepare("SELECT id, title FROM problems").all()).toEqual([
          { id: draftId, title: "Retained on refused restore" },
        ]);
        expect(scratch.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
        expect(await readDeletionJournalRecords(scratch.db)).toEqual([]);
      },
    );

    test("resurrection readback cannot clear a journal with an unsupported action", async () => {
      const supported = await createRetentionControlRecord({
        action: "delete-private-draft",
        targetId: "P-READBACK-SUPPORTED",
        targetType: "problem",
        issuedAt: NOW,
      });
      const unsupported = await createRetentionControlRecord({
        action: "unbind-private-cas",
        targetId: "b".repeat(64),
        targetType: "cas_artifact",
        issuedAt: NOW,
      });
      const db = {
        prepare() {
          throw new Error("The complete action set must be checked before reading any target");
        },
      } as never;
      await expect(findResurrectedTargets(db, [supported, unsupported])).rejects.toThrow(
        "DELETION_CONTROL_UNSUPPORTED",
      );
    });
  });

  describe("credential revocation replay", () => {
    test("a restored snapshot's live credential is re-revoked by the journal, else refused", async () => {
      // Model a restore from a snapshot taken BEFORE the revocation: the token
      // row exists unrevoked. The disposable in-memory schema drops only the
      // fellow_tokens INSERT triggers so the snapshot row can be seeded; the
      // UPDATE guard that demands a credential-revoked lifecycle event stays,
      // so the replay must go through the real command path.
      const { sqlite, db } = freshDb();
      const triggers = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'fellow_tokens' AND sql LIKE '%BEFORE INSERT ON fellow_tokens%'",
        )
        .all() as { name: string }[];
      expect(triggers.length).toBeGreaterThan(0);
      for (const { name } of triggers) sqlite.run(`DROP TRIGGER "${name}"`);
      sqlite.run("PRAGMA foreign_keys = OFF");
      sqlite.run(
        "INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES ('usr_s', 1, 1)",
      );
      sqlite.run(
        `INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at)
         VALUES ('F-1', 'usr_s', 'snapshot-fellow', 'm', 'h', 1000)`,
      );
      sqlite.run(
        `INSERT INTO fellow_tokens (credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
           granted_scopes_json, granted_resources_json, issued_at, expires_at)
         VALUES ('CR-SNAPSHOT', 'PR-1', 'F-1', 'usr_s', ?, '["promote"]', '{}', 1000, 99999999999999)`,
        ["a".repeat(64)],
      );
      sqlite.run("PRAGMA foreign_keys = ON");
      expect(() =>
        sqlite.run(
          "UPDATE fellow_tokens SET revoked_at = 2000 WHERE credential_id = 'CR-SNAPSHOT'",
        ),
      ).toThrow(/credential revocation lacks event/);
      const control = await createRetentionControlRecord({
        action: "revoke-credential",
        targetId: "CR-SNAPSHOT",
        targetType: "credential",
        payload: { fellow_id: "F-1", sponsor_id: "usr_s" },
        issuedAt: "2026-09-25T00:00:00.000Z",
      });
      const keys = await journalKeys();
      const journal = await serializeDeletionJournal([control], NOW, keys.signing);

      // Without the enrollment command path the replay refuses rather than
      // leaving a journaled credential live.
      await expect(
        applyDeletionJournal({
          db,
          targetIdentifier: "scratch_credential_replay",
          deletionJournalNdjson: journal,
          verifyKeys: keys.verify,
          readCurrentJournal: await fixedJournalReader(journal, keys.verify),
        }),
      ).rejects.toThrow(/CREDENTIAL_REVOKER_REQUIRED/);
      const replay = await applyDeletionJournal({
        db,
        targetIdentifier: "scratch_credential_replay",
        deletionJournalNdjson: journal,
        verifyKeys: keys.verify,
        readCurrentJournal: await fixedJournalReader(journal, keys.verify),
        revokeCredential: retentionCredentialRevoker(
          new D1EnrollmentStore(
            db as unknown as ConstructorParameters<typeof D1EnrollmentStore>[0],
          ),
        ),
      });
      expect(replay.appliedControlsCount).toBe(1);
      const row = sqlite
        .prepare("SELECT revoked_at FROM fellow_tokens WHERE credential_id = 'CR-SNAPSHOT'")
        .get() as { revoked_at: number | null };
      expect(row.revoked_at).not.toBeNull();
      const event = sqlite
        .prepare(
          "SELECT action, credential_id, sponsor_seq FROM fellow_lifecycle_events WHERE credential_id = 'CR-SNAPSHOT'",
        )
        .get();
      expect(event).toEqual({
        action: "credential-revoked",
        credential_id: "CR-SNAPSHOT",
        sponsor_seq: 1,
      });
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
        payload: { sponsor_id: "usr_sponsor_1" },
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
        readCurrentJournal: await fixedJournalReader(journalNdjson, keys.verify),
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
          readCurrentJournal: async () => null,
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
          readCurrentJournal: async () => null,
        }),
      ).rejects.toThrow("DELETION_JOURNAL_MISSING");
      const rows = scratch.sqlite.prepare("SELECT COUNT(*) AS n FROM problems").get() as {
        n: number;
      };
      expect(rows.n).toBe(0);
    });
  });
});
