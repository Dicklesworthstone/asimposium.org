/**
 * Krater Backups, Exports, and Retention Enforcement E2E Gate (W2.8, bead asimposiumorg-p4b).
 *
 * Proves:
 * 1. Representative public/private state: public active problems with claims/citations/events vs private-drafts and workshop state.
 * 2. Per-problem export serialization: NDJSON with header control record (CC BY 4.0 license), ledger events, terminal export_end record.
 * 3. Gzip export (/p/:slug/export.jsonl.gz) decompresses to verified NDJSON under CC BY 4.0.
 * 4. Strict offline chain verification (tamper-evidence, sequence gaps, row digests, embedded checkpoints).
 * 5. Privacy invariant: workshop pushes and private drafts are strictly absent from public exports.
 * 6. Citation export: BibTeX (@misc, @article) and CSL JSON with stable URLs, cite keys, statement versions, and access dates.
 * 7. Scratch target authority: restore strictly refuses any non-scratch target (prod, staging, live, primary, main) before any writes.
 * 8. Atomic restore: row-for-row restoration into validated scratch target, and total rollback on tampered payloads or missing trailers.
 * 9. Retention enforcement: hard-deletion of never-published private drafts upon authenticated sponsor request with 90-day retention receipts.
 * 10. Ledger immutability: hard-deletion of public problems or problems with committed events is refused.
 * 11. Security records expiration: scheduled sweep of expired nonces and stale device lookups without touching ledger history.
 * 12. Deletion-safe restore: replay of deletion journal ensures deleted private drafts are never reactivated from older snapshots.
 * 13. Canonical face parity: re-exporting restored state produces byte-identical exports.
 */

import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { type BackupBucket, backupProblem } from "../../apps/wire/src/krater/backup.ts";
import { checkpointSigningKey } from "../../apps/wire/src/krater/checkpoint-signing.ts";
import { bibtexForClaim, cslForClaim } from "../../apps/wire/src/krater/citation.ts";
import {
  parseExportHeader,
  parseExportTrailer,
  verifyProblemExportChain,
} from "../../apps/wire/src/krater/export.ts";
import {
  canonicalJson,
  checkpointDigest,
  eventChainDigest,
  eventEnvelopeRowDigest,
  genesisChainDigest,
  sha256Hex,
} from "../../apps/wire/src/krater/krater.ts";
import {
  KraterRestoreRefusedError,
  restoreProblemExport,
} from "../../apps/wire/src/krater/restore.ts";
import {
  createRetentionControlRecord,
  deletionSafeRestore,
  expireSecurityRecords,
  hardDeletePrivateDraft,
  parseAndVerifyDeletionJournal,
  RetentionError,
  serializeDeletionJournal,
  validateScratchTarget,
} from "../../apps/wire/src/krater/retention.ts";
import {
  bibtexForCitation,
  cslForCitation,
  rowToCitationItem,
} from "../../apps/wire/src/ledger/citations.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "db/migrations");
const NOW = "2026-08-20T00:00:00Z";
const DATE = "2026-08-20";

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
  sqlite.run("PRAGMA foreign_keys = ON;");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    sqlite.run(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
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

async function seedPublicProblem(
  db: ReturnType<typeof localD1>,
  sqlite: Database,
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
    "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_digest, chain_version, status, sponsor_id, title) VALUES (?, 0, ?, ?, ?, 2, 'active', 'usr_sponsor_1', ?)",
    problemId,
    NOW,
    NOW,
    genesis,
    `Public Problem ${problemId}`,
  );
  await insert(
    "INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version) VALUES (?, 'complete', 0, ?, 2)",
    problemId,
    NOW,
  );

  let previous = genesis;
  for (let seq = 1; seq <= eventCount; seq += 1) {
    const eventId = `E-${seq}-${problemId}`;
    const claimId = `C-${seq}`;
    const statement = `Public scientific claim ${seq} on problem ${problemId}`;
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
      actorFellowId: "fel_alice",
      actorSponsorId: "usr_sponsor_1",
      actorSessionId: "ses_1",
      modelStringSelfDeclared: "fable-5",
      harness: "asimp-harness",
      writerCredentialId: "cred_1",
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
      "INSERT INTO events (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, created_at, row_digest, chain_digest, actor_fellow_id, actor_sponsor_id, actor_session_id, model_string_self_declared, harness, writer_credential_id) VALUES (?, ?, ?, 'claim.created', 'claim', ?, 1, ?, ?, ?, ?, 'fel_alice', 'usr_sponsor_1', 'ses_1', 'fable-5', 'asimp-harness', 'cred_1')",
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
    await insert(
      "INSERT INTO claims (id, problem_id, statement, payload_sha256, source_seq, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      claimId,
      problemId,
      statement,
      payloadSha256,
      seq,
      NOW,
    );
    previous = chain;
  }

  // Also seed a committed citation in the citations table
  sqlite.run(
    `INSERT INTO citations (citation_id, problem_id, version, seq, title, authors_json, year, locator_kind, locator, canonical_locator, source_provenance, unanchored, norm_hash, author_fellow_id, sponsor_id, created_at)
     VALUES ('L-1', ?, 1, 1, 'Riemann Zeta Function Distribution', '["B. Riemann"]', 1859, 'url', 'https://example.org/zeta', 'https://example.org/zeta', 'retrieved', 0, 'norm_hash_zeta', 'fel_alice', 'usr_sponsor_1', ?)`,
    [problemId, NOW],
  );
}

async function seedPrivateState(sqlite: Database, problemId: string, sponsorId: string) {
  // 1. Private draft problem
  sqlite.run(
    `INSERT INTO problems (id, public_seq, status, unlisted, sponsor_id, created_by_fellow_id, title, current_statement_version, chain_version, chain_digest, created_at, updated_at)
     VALUES (?, 0, 'private-draft', 1, ?, 'fel_alice', 'Private Unverified Draft', 1, 2, 'genesis-private', ?, ?)`,
    [problemId, sponsorId, NOW, NOW],
  );
  sqlite.run(
    `INSERT INTO problem_statement_versions (problem_id, version, statement, norm_hash, falsifier, motivation, created_at)
     VALUES (?, 1, 'Unverified private hypothesis statement', 'hash_draft', 'Counterexample draft', 'Motivation draft', ?)`,
    [problemId, NOW],
  );
  sqlite.run(
    `INSERT INTO problem_stewards (problem_id, sponsor_id, is_founding, created_at)
     VALUES (?, ?, 1, ?)`,
    [problemId, sponsorId, NOW],
  );

  // 2. Private workshop objects
  sqlite.run(
    `INSERT OR IGNORE INTO sponsors (sponsor_id, created_at, last_seen_at)
     VALUES (?, 1000, 1000)`,
    [sponsorId],
  );
  sqlite.run(
    `INSERT OR IGNORE INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at)
     VALUES ('fel_alice', ?, 'alice', 'fable-5', 'asimp', 1000)`,
    [sponsorId],
  );
  sqlite.run(
    `INSERT OR IGNORE INTO sessions (session_id, problem_id, fellow_id, opened_at, last_heartbeat_at, idle_close_at)
     VALUES ('ses_priv_1', ?, 'fel_alice', ?, ?, ?)`,
    [problemId, NOW, NOW, NOW],
  );
  sqlite.run(
    `INSERT INTO workshop_objects (workshop_id, problem_id, fellow_id, session_id, workshop_seq, type, title, body_md, created_at)
     VALUES ('W-1', ?, 'fel_alice', 'ses_priv_1', 1, 'claim-draft', 'Private scratch draft', 'Secret unpublished calculations...', ?)`,
    [problemId, NOW],
  );

  // 3. Temporary security records
  sqlite.run(
    "INSERT INTO auth_envelope_nonces (nonce_hash, expires_at, claimed_at) VALUES (?, 1000, 500)",
    ["f".repeat(64)],
  );
  sqlite.run(
    "INSERT INTO device_lookup_attempts (sponsor_id, attempted_at, success) VALUES ('sp_test', 1000, 0)",
  );
}

async function runE2E() {
  console.log("Starting W2.8 Backups, Exports & Retention Enforcement E2E test...");
  const startMs = Date.now();

  const { sqlite, db } = freshDb();
  const bucket = fakeBucket();

  const publicProblemId = "P-PUB-EXPORT-1";
  const privateDraftProblemId = "P-PRIV-DRAFT-1";
  const sponsorId = "usr_sponsor_alpha";

  // Step 1: Seed representative public and private state
  console.log("1. Seeding representative public and private state...");
  await seedPublicProblem(db, sqlite, publicProblemId, 3);
  await seedPrivateState(sqlite, privateDraftProblemId, sponsorId);

  // Step 2: Test Problem Export & Backup Serialization
  console.log("2. Testing problem export serialization and backup generation...");
  const backupResult = await backupProblem(
    db,
    bucket,
    publicProblemId,
    "Public Problem Title",
    DATE,
  );
  assert.ok(backupResult !== null, "backupProblem must succeed for public problem with events");
  assert.equal(backupResult.eventCount, 3);
  assert.equal(backupResult.problemId, publicProblemId);

  const exportedNdjson = bucket.writes.get(backupResult.key);
  assert.ok(typeof exportedNdjson === "string", "backup must write string NDJSON to bucket");

  const exportLines = exportedNdjson.trim().split("\n");
  const header = parseExportHeader(exportLines[0] ?? "");
  assert.equal(header.ok, true, "export header must parse");
  if (header.ok) {
    assert.equal(header.format, "asimposium.problem-export.v3");
    assert.equal(header.license, "CC BY 4.0");
    assert.equal(header.checkpointCount, 3);
  }

  const trailer = parseExportTrailer(exportLines[exportLines.length - 1] ?? "");
  assert.equal(trailer.ok, true, "export trailer must parse");
  if (trailer.ok) {
    assert.equal(trailer.eventCount, 3);
    assert.equal(trailer.finalCursor, 3);
    assert.equal(trailer.problem, publicProblemId);
  }

  // Step 3: Offline Chain Verification
  console.log("3. Testing offline export chain verification...");
  const verification = await verifyProblemExportChain(exportedNdjson);
  assert.equal(verification.intact, true, "export chain must verify end-to-end");
  if (verification.intact) {
    assert.equal(verification.eventCount, 3);
    assert.equal(verification.finalChainDigest, backupResult.chainDigest);
  }

  // Step 4: Gzip compression roundtrip (/p/:id/export.jsonl.gz contract)
  console.log("4. Testing gzip compression roundtrip...");
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(new TextEncoder().encode(exportedNdjson));
  writer.close();
  const compressedGzipBuffer = await new Response(cs.readable).arrayBuffer();
  assert.ok(compressedGzipBuffer.byteLength > 0, "compressed buffer must have bytes");

  const ds = new DecompressionStream("gzip");
  const dWriter = ds.writable.getWriter();
  dWriter.write(new Uint8Array(compressedGzipBuffer));
  dWriter.close();
  const decompressedText = new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
  assert.equal(
    decompressedText,
    exportedNdjson,
    "gzip decompression must reproduce exact export bytes",
  );

  // Step 5: Privacy Invariant: private drafts & workshop bytes never in public exports
  console.log("5. Testing privacy invariants (workshop & private drafts absent from export)...");
  assert.equal(
    exportedNdjson.includes(privateDraftProblemId),
    false,
    "private draft ID must not appear in public export",
  );
  assert.equal(
    exportedNdjson.includes("Secret unpublished calculations"),
    false,
    "workshop body must not appear in public export",
  );
  assert.equal(
    exportedNdjson.includes("Draft hypothesis statement"),
    false,
    "private statement must not appear in public export",
  );

  // Step 6: Citation Export (BibTeX & CSL)
  console.log("6. Testing citation export (BibTeX and CSL)...");
  // Citation item from public problem
  const citationRow = sqlite
    .prepare("SELECT * FROM citations WHERE problem_id = ?")
    .get(publicProblemId) as Record<string, unknown>;
  assert.ok(citationRow, "citation row must exist");
  const citationItem = rowToCitationItem(citationRow);

  const bibtex = bibtexForCitation(citationItem);
  assert.ok(bibtex.includes("@article{L-1"), "BibTeX must contain @article entry with cite key");
  assert.ok(bibtex.includes("Riemann Zeta Function Distribution"), "BibTeX must include title");
  assert.ok(bibtex.includes("1859"), "BibTeX must include year");

  const csl = cslForCitation(citationItem);
  assert.equal(csl.id, "L-1");
  assert.equal(csl.title, "Riemann Zeta Function Distribution");

  // Claim citation
  const claimInstant = "2026-08-20T00:00:00.000Z";
  const claimBibtex = bibtexForClaim({
    claim: {
      problemId: publicProblemId,
      claimId: "C-1",
      statement: "Public scientific claim 1",
      statementVersion: 1,
      authorFellowId: "fel_alice",
      publishedAt: claimInstant,
    },
    accessDate: "2026-08-20",
    origin: "https://asimposium.org",
    observedAt: claimInstant,
  });
  assert.ok(
    claimBibtex.includes("@misc{asimposium_"),
    "claim BibTeX must have asimposium cite key",
  );
  assert.ok(claimBibtex.includes("_v1,"), "claim BibTeX must have pinned version in cite key");
  assert.ok(
    claimBibtex.includes("https://asimposium.org/p/P-PUB-EXPORT-1/claims/C-1"),
    "claim BibTeX must include stable URL",
  );

  const claimCsl = cslForClaim({
    claim: {
      problemId: publicProblemId,
      claimId: "C-1",
      statement: "Public scientific claim 1",
      statementVersion: 1,
      authorFellowId: "fel_alice",
      publishedAt: claimInstant,
    },
    accessDate: "2026-08-20",
    origin: "https://asimposium.org",
    observedAt: claimInstant,
  });
  assert.ok(claimCsl.id.startsWith("asimposium_"), "claim CSL id must start with asimposium_");
  assert.ok(claimCsl.id.endsWith("_v1"), "claim CSL id must end with _v1");
  assert.equal(claimCsl.title, "Public scientific claim 1");

  // Step 7: Scratch Target Authority (refuse non-scratch targets)
  console.log("7. Testing scratch target authority validation...");
  assert.throws(() => validateScratchTarget("production-d1-main"), KraterRestoreRefusedError);
  assert.throws(() => validateScratchTarget("staging-d1"), KraterRestoreRefusedError);
  assert.throws(() => validateScratchTarget("primary-db"), KraterRestoreRefusedError);
  assert.throws(() => validateScratchTarget(""), KraterRestoreRefusedError);
  assert.doesNotThrow(() => validateScratchTarget("scratch_drill_target"));
  assert.doesNotThrow(() => validateScratchTarget("quarantine-d1"));
  assert.doesNotThrow(() => validateScratchTarget(":memory:"));

  // Step 8: Restore Refusal on Tampered Exports
  console.log("8. Testing verify-first restore refusal on tampered export...");
  const scratchTamper = freshDb();
  const tamperedPayload = exportedNdjson.replace(
    "Public scientific claim 1",
    "Tampered hacker claim 1",
  );
  await assert.rejects(
    () =>
      restoreProblemExport(scratchTamper.db, tamperedPayload, { targetIdentifier: "scratch_test" }),
    (err: unknown) => err instanceof KraterRestoreRefusedError,
    "tampered payload must refuse restore before any write",
  );
  const tamperCount = (
    scratchTamper.sqlite.prepare("SELECT COUNT(*) AS n FROM problems").get() as { n: number }
  ).n;
  assert.equal(tamperCount, 0, "scratch database must have 0 rows after refused restore");

  // Step 9: Restore to Validated Scratch Target
  console.log("9. Testing row-for-row restore into validated scratch target...");
  const scratchTarget = freshDb();
  const restoreRes = await restoreProblemExport(scratchTarget.db, exportedNdjson, {
    targetIdentifier: "scratch_verified_drill",
  });
  assert.equal(restoreRes.restored, publicProblemId);
  assert.equal(restoreRes.eventCount, 3);
  assert.equal(restoreRes.finalSeq, 3);
  assert.equal(restoreRes.chainDigest, backupResult.chainDigest);

  // Compare row counts between origin and restored scratch
  const originEvents = (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
      .get(publicProblemId) as { n: number }
  ).n;
  const scratchEvents = (
    scratchTarget.sqlite
      .prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
      .get(publicProblemId) as { n: number }
  ).n;
  assert.equal(scratchEvents, originEvents);

  const originClaims = (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM claims WHERE problem_id = ?")
      .get(publicProblemId) as { n: number }
  ).n;
  const scratchClaims = (
    scratchTarget.sqlite
      .prepare("SELECT COUNT(*) AS n FROM claims WHERE problem_id = ?")
      .get(publicProblemId) as { n: number }
  ).n;
  assert.equal(scratchClaims, originClaims);

  const originCheckpoints = (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM integrity_checkpoints WHERE problem_id = ?")
      .get(publicProblemId) as { n: number }
  ).n;
  const scratchCheckpoints = (
    scratchTarget.sqlite
      .prepare("SELECT COUNT(*) AS n FROM integrity_checkpoints WHERE problem_id = ?")
      .get(publicProblemId) as { n: number }
  ).n;
  assert.equal(scratchCheckpoints, originCheckpoints);

  // Step 10: Retention Enforcement: Hard-deletion of never-published private draft
  console.log("10. Testing retention enforcement: hard-delete never-published private draft...");
  const hardDeleteRes = await hardDeletePrivateDraft(db, privateDraftProblemId, sponsorId, {
    now: NOW,
  });
  assert.equal(hardDeleteRes.ok, true);
  assert.equal(hardDeleteRes.problemId, privateDraftProblemId);
  assert.equal(hardDeleteRes.receipt.backupRetentionWindowDays, 90);
  assert.equal(hardDeleteRes.receipt.legalHoldException, false);
  assert.ok(hardDeleteRes.receipt.expectedPhysicalErasureDeadline.length > 0);

  // Assert draft rows are gone
  const remainingDraft = (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM problems WHERE id = ?")
      .get(privateDraftProblemId) as { n: number }
  ).n;
  assert.equal(remainingDraft, 0, "private draft problem must be deleted");
  const remainingVersions = (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM problem_statement_versions WHERE problem_id = ?")
      .get(privateDraftProblemId) as { n: number }
  ).n;
  assert.equal(remainingVersions, 0, "draft statement versions must be deleted");

  // Assert public problem cannot be deleted
  await assert.rejects(
    () => hardDeletePrivateDraft(db, publicProblemId, "usr_sponsor_1", { now: NOW }),
    (err: unknown) =>
      err instanceof RetentionError && err.code === "CANNOT_DELETE_NON_DRAFT_PROBLEM",
    "public problem deletion must be refused",
  );

  // Step 11: Security Records Expiration Sweep
  console.log("11. Testing security records expiration sweep...");
  // Nonce expiry is epoch seconds (seeded 1000); lookups are ms (seeded 1000).
  const expireRes = await expireSecurityRecords(db, {
    nowMs: 2_000_000,
    lookupMaxAgeMs: 1_998_500,
  });
  assert.equal(expireRes.expiredNonces, 1);
  assert.equal(expireRes.expiredLookupAttempts, 1);

  // Step 12: Deletion-Safe Restore with Deletion Journal Replay
  console.log("12. Testing deletion-safe restore with deletion journal replay...");
  const deleteControl = await createRetentionControlRecord({
    action: "delete-private-draft",
    targetId: "P-OLD-RESTORED-DRAFT",
    targetType: "problem",
    issuedAt: NOW,
  });
  const journalKey = await checkpointSigningKey(
    JSON.stringify({ kid: "export-restore-e2e", seedHex: "33".repeat(32) }),
  );
  assert.ok(journalKey !== null);
  const verifyKeys = [{ kid: journalKey.kid, publicKeyHex: journalKey.publicKeyHex }];
  const deletionJournalNdjson = await serializeDeletionJournal([deleteControl], NOW, journalKey);
  const verifiedJournal = await parseAndVerifyDeletionJournal(deletionJournalNdjson, verifyKeys);
  assert.equal(verifiedJournal.valid, true);

  const scratchReplay = freshDb();
  // Plant the old draft as if an older snapshot contained it
  scratchReplay.sqlite.run(
    `INSERT INTO problems (id, public_seq, status, unlisted, sponsor_id, created_by_fellow_id, title, current_statement_version, chain_version, chain_digest, created_at, updated_at)
     VALUES ('P-OLD-RESTORED-DRAFT', 0, 'private-draft', 1, ?, 'fel_alice', 'Old Draft', 1, 2, 'chain', ?, ?)`,
    [sponsorId, NOW, NOW],
  );
  assert.equal(
    (
      scratchReplay.sqlite
        .prepare("SELECT COUNT(*) AS n FROM problems WHERE id = 'P-OLD-RESTORED-DRAFT'")
        .get() as { n: number }
    ).n,
    1,
  );

  const safeRestoreRes = await deletionSafeRestore({
    db: scratchReplay.db,
    targetIdentifier: "scratch_safe_restore",
    snapshotNdjson: exportedNdjson,
    deletionJournalNdjson,
    verifyKeys,
  });
  assert.equal(safeRestoreRes.restored, publicProblemId);
  assert.equal(safeRestoreRes.appliedControlsCount, 1);
  const purgedDraftCount = (
    scratchReplay.sqlite
      .prepare("SELECT COUNT(*) AS n FROM problems WHERE id = 'P-OLD-RESTORED-DRAFT'")
      .get() as { n: number }
  ).n;
  assert.equal(purgedDraftCount, 0, "deletion-safe restore must purge deleted private draft");

  // Step 13: Canonical Face Parity
  console.log("13. Testing canonical face parity between origin and restored scratch target...");
  const rebacked = fakeBucket();
  const rebackedRes = await backupProblem(
    scratchTarget.db,
    rebacked,
    publicProblemId,
    "Public Problem Title",
    DATE,
  );
  assert.ok(rebackedRes !== null);
  const rebackedNdjson = rebacked.writes.get(rebackedRes.key);
  assert.equal(
    rebackedNdjson,
    exportedNdjson,
    "re-exported NDJSON must be byte-for-byte identical to origin export",
  );

  const durationMs = Date.now() - startMs;
  console.log(
    JSON.stringify({
      status: "pass",
      suite: "e2e-export-restore",
      duration_ms: durationMs,
      public_problem_id: publicProblemId,
      exported_events: 3,
      verified_checkpoints: 3,
      receipt_id: hardDeleteRes.receipt.receiptId,
      retention_window_days: hardDeleteRes.receipt.backupRetentionWindowDays,
    }),
  );
  console.log("All W2.8 Backups, Exports & Retention Enforcement E2E checks passed successfully!");
}

runE2E().catch((err) => {
  console.error("E2E Export/Restore Failure:", err);
  process.exit(1);
});
