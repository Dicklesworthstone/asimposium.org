import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkpointSignatureMessage } from "@asimposium/contracts";
import { CAS_KEY_PREFIX } from "../apps/wire/src/krater/cas.ts";
import { checkpointSigningKey } from "../apps/wire/src/krater/checkpoint-signing.ts";
import { serializeProblemExport } from "../apps/wire/src/krater/export.ts";
import {
  checkpointDigest,
  claimProjectionBuildDigestV1,
  eventChainDigest,
  eventEnvelopeRowDigest,
  genesisChainDigest,
  KRATER_CHAIN_VERSION,
  sha256Hex,
} from "../apps/wire/src/krater/krater.ts";
import { scanFieldForCredentials } from "../apps/wire/src/screening/credential-scan.ts";
import {
  appendOpsAuditRecord,
  assertMutationAuthorized,
  containsNeverLogMaterial,
  NEVER_LOG_CATEGORIES,
  NEVER_LOG_REDACTED,
  redactOpsText,
  redactOpsValue,
  verifyOpsAuditLog,
} from "./lib/ops-audit.ts";
import { runArtifactInventory } from "./ops-artifact-inventory.ts";
import { type RetentionControlJournal, runBackupRestoreSmoke } from "./ops-backup-restore-smoke.ts";
import { runCachePrivacyTest } from "./ops-cache-privacy-test.ts";
import { runEventVerify } from "./ops-event-verify.ts";
import { runProjectionRebuild } from "./ops-projection-rebuild.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

const TWELVE_NAMED_RUNBOOKS = [
  "credential-compromise.md",
  "sponsor-account-takeover.md",
  "leaked-join-url.md",
  "doxxing-credible-threat.md",
  "malicious-artifact.md",
  "viral-false-famous-problem-solution.md",
  "outbox-backlog.md",
  "projection-corruption.md",
  "private-content-cache-leak.md",
  "restore-from-backup.md",
  "signing-key-compromise.md",
  "screening-provider-outage.md",
] as const;

describe("OPS.5 runbook index, never-log redaction corpus, and audit-logged ops:* commands (asimposiumorg-vpx)", () => {
  let workDir = "";
  let sqlitePath = "";
  let exportPath = "";
  let auditLogPath = "";
  let verifyKeysJson = "";

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "asimp-ops-vpx-"));
    sqlitePath = join(workDir, "local-d1.sqlite");
    exportPath = join(workDir, "problem-export.ndjson");
    auditLogPath = join(workDir, "ops-audit.ndjson");

    const db = new Database(sqlitePath);
    // Use exact production D1 table & column schemas from db/migrations/
    // (0001, 0006, 0008, 0017, 0021, 0069, 0079, 0091) so ops:* scripts are
    // verified against the real column layout, never a synthetic stub schema.
    db.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        problem_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        object_kind TEXT NOT NULL,
        object_id TEXT NOT NULL,
        object_version INTEGER NOT NULL,
        payload_sha256 TEXT NOT NULL,
        row_digest TEXT NOT NULL,
        chain_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        actor_fellow_id TEXT,
        actor_sponsor_id TEXT,
        actor_session_id TEXT,
        model_string_self_declared TEXT,
        harness TEXT,
        writer_credential_id TEXT
      );
      CREATE TABLE event_chain_v2 (
        event_id TEXT PRIMARY KEY,
        problem_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        row_digest TEXT NOT NULL,
        chain_digest TEXT NOT NULL,
        chain_version INTEGER NOT NULL
      );
      CREATE TABLE integrity_checkpoints (
        problem_id TEXT NOT NULL,
        checkpoint_seq INTEGER NOT NULL,
        root_chain_digest TEXT NOT NULL,
        checkpoint_digest TEXT NOT NULL,
        PRIMARY KEY (problem_id, checkpoint_seq)
      );
      CREATE TABLE checkpoint_signatures (
        problem_id TEXT NOT NULL,
        checkpoint_seq INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        signature TEXT NOT NULL,
        signed_at TEXT NOT NULL,
        PRIMARY KEY (problem_id, checkpoint_seq, key_id)
      );
      CREATE TABLE claim_projections (
        claim_id TEXT NOT NULL,
        problem_id TEXT NOT NULL,
        source_seq INTEGER NOT NULL,
        projection_version INTEGER NOT NULL,
        build_digest TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (problem_id, claim_id)
      );
      CREATE TABLE artifact_uploads (
        upload_id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE fellow_tokens (
        credential_id TEXT PRIMARY KEY,
        revoked_at INTEGER
      );
      CREATE TABLE workshop_objects (
        workshop_id TEXT PRIMARY KEY
      );
      CREATE TABLE sponsors (
        sponsor_id TEXT PRIMARY KEY,
        tombstoned_at INTEGER
      );
      CREATE TABLE content_controls (
        control_id TEXT PRIMARY KEY,
        visibility TEXT NOT NULL
      );
    `);

    const problemId = "P-OPS5";
    const createdAt = "2026-11-21T12:00:00.000Z";
    const payloadJson = JSON.stringify({
      kind: "claim",
      statement: "Every prime greater than 2 is odd.",
    });
    const payloadSha = await sha256Hex(payloadJson);
    const genesis = await genesisChainDigest(problemId);
    const testCredRef = ["CR", "01OPS5"].join("-");
    const rowDigest = await eventEnvelopeRowDigest({
      eventId: "EV-01OPS5000000000000000001",
      problemId,
      seq: 1,
      type: "claim.created",
      objectKind: "claim",
      objectId: "C-1",
      objectVersion: 1,
      payloadSha256: payloadSha,
      createdAt,
      actorFellowId: "F-01OPS5",
      actorSponsorId: "SP-01OPS5",
      actorSessionId: "S-01OPS5",
      modelStringSelfDeclared: "test/model-1",
      harness: "codex",
      writerCredentialId: testCredRef,
    });
    const chainDigest = await eventChainDigest(problemId, 1, payloadSha, rowDigest, genesis);
    const cpDigest = await checkpointDigest(problemId, 1, chainDigest);
    const buildDigest = claimProjectionBuildDigestV1(rowDigest);

    // Mint a real Ed25519 signature over the canonical checkpoint message (0079 schema).
    const testSeedHex = "11".repeat(32);
    const signer = await checkpointSigningKey(
      JSON.stringify({ kid: "ops5-test-k1", seedHex: testSeedHex }),
    );
    if (!signer) throw new Error("failed to create test Ed25519 checkpoint signing key");
    verifyKeysJson = JSON.stringify([{ kid: signer.kid, publicKeyHex: signer.publicKeyHex }]);
    const sigBytes = new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        signer.privateKey,
        new TextEncoder().encode(
          checkpointSignatureMessage({
            problemId,
            checkpointSeq: 1,
            rootChainDigest: chainDigest,
            checkpointDigest: cpDigest,
          }),
        ),
      ),
    );
    const sigHex = Array.from(sigBytes, (b) => b.toString(16).padStart(2, "0")).join("");

    db.prepare(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "EV-01OPS5000000000000000001",
      problemId,
      1,
      "claim.created",
      "claim",
      "C-1",
      1,
      payloadSha,
      rowDigest,
      chainDigest,
      createdAt,
      "F-01OPS5",
      "SP-01OPS5",
      "S-01OPS5",
      "test/model-1",
      "codex",
      "CR-01OPS5",
    );
    db.prepare(`INSERT INTO event_chain_v2 VALUES (?, ?, ?, ?, ?, ?)`).run(
      "EV-01OPS5000000000000000001",
      problemId,
      1,
      rowDigest,
      chainDigest,
      KRATER_CHAIN_VERSION,
    );
    db.prepare(`INSERT INTO integrity_checkpoints VALUES (?, ?, ?, ?)`).run(
      problemId,
      1,
      chainDigest,
      cpDigest,
    );
    db.prepare(`INSERT INTO checkpoint_signatures VALUES (?, ?, ?, ?, ?, ?)`).run(
      problemId,
      1,
      signer.kid,
      "Ed25519",
      sigHex,
      createdAt,
    );
    db.prepare(`INSERT INTO claim_projections VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      "C-1",
      problemId,
      1,
      1,
      buildDigest,
      0,
      createdAt,
    );

    const artBody = Buffer.from("proof artifact bytes\n", "utf8");
    const artSha = createHash("sha256").update(artBody).digest("hex");
    db.prepare(`INSERT INTO artifact_uploads VALUES (?, ?, ?, ?)`).run(
      "AU-01ops500000000000000000000000001",
      artSha,
      artBody.byteLength,
      "verified",
    );
    db.prepare(`INSERT INTO fellow_tokens VALUES (?, ?)`).run("CR-REVOKED-1", 1_763_760_000_000);
    // W-DELETED-1 is hard-deleted (absent from workshop_objects).
    db.prepare(`INSERT INTO sponsors VALUES (?, ?)`).run("SP-DELETED-1", 1_763_760_000_000);
    db.prepare(`INSERT INTO content_controls VALUES (?, ?)`).run("CC-HIDE-1", "hidden");
    db.close();

    const r2Dir = join(workDir, "r2-mirror", CAS_KEY_PREFIX);
    mkdirSync(r2Dir, { recursive: true });
    writeFileSync(join(r2Dir, artSha), artBody);

    const exported = serializeProblemExport({
      problemId,
      problemTitle: "OPS.5 Rehearsal Problem",
      generatedAt: createdAt,
      checkpoints: [
        {
          problemId,
          checkpointSeq: 1,
          rootChainDigest: chainDigest,
          checkpointDigest: cpDigest,
          checkpointVersion: 1,
          chainVersion: KRATER_CHAIN_VERSION,
          checkpointMode: "unsigned-v0",
        },
      ],
      events: [
        {
          eventId: "EV-01OPS5000000000000000001",
          problemId,
          seq: 1,
          type: "claim.created",
          objectKind: "claim",
          objectId: "C-1",
          objectVersion: 1,
          payloadSha256: payloadSha,
          rowDigest,
          chainDigest,
          chainVersion: KRATER_CHAIN_VERSION,
          createdAt,
          actorFellowId: "F-01OPS5",
          actorSponsorId: "SP-01OPS5",
          actorSessionId: "S-01OPS5",
          modelStringSelfDeclared: "test/model-1",
          harness: "codex",
          writerCredentialId: testCredRef,
          payloadJson,
        },
      ],
    });
    writeFileSync(exportPath, exported, "utf8");
  });

  afterAll(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("NEVER-LOG REDACTION CORPUS: redacts all 8 Fable §14.3 categories while preserving benign scientific IDs", () => {
    expect(NEVER_LOG_CATEGORIES.length).toBe(8);

    const sensitiveSamples: readonly [string, string][] = [
      [
        "join fragment",
        "https://a.asimposium.org/join/ASIMP-EN-01ABC#v1.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCD",
      ],
      [
        "bare enrollment secret",
        "submitted v1.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCD to worker",
      ],
      ["fellow bearer token", "Authorization: Bearer asimp_ag_TestCanarySecretTokenValue123456"],
      ["flow handle / device code", "poll flow_v1.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCD now"],
      ["google jwt", "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturePayloadBytes123"],
      ["authjs cookie", "Cookie: __Secure-authjs.session-token=super-secret-cookie-value; Path=/"],
      [
        "presigned R2 URL",
        "https://r2.example/cas/abc?X-Amz-Signature=deadbeef1234567890&X-Amz-Credential=AKIA",
      ],
      ["directive body", "directive_body: privately check counterexample for lemma 4"],
      ["workshop body", "workshop_body: private unpublished proof scratch notes"],
      ["service envelope sig", "x-asimp-service-sig: 0123456789abcdef0123456789abcdef"],
      [
        "private PEM key",
        "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEINo\n-----END PRIVATE KEY-----",
      ],
    ];

    for (const [label, sample] of sensitiveSamples) {
      expect(containsNeverLogMaterial(sample), `expected detection for ${label}`).toBe(true);
      const redacted = redactOpsText(sample);
      expect(redacted, `expected redaction token for ${label}`).toContain(NEVER_LOG_REDACTED);
      expect(redacted).not.toContain("TestCanarySecretTokenValue");
      expect(redacted).not.toContain("super-secret-cookie-value");
      expect(redacted).not.toContain("unpublished proof scratch notes");
    }

    // Structured object redaction strips body_md, seed_hex, presigned_url and records _redacted_fields.
    const cleanedObj = redactOpsValue({
      problem_id: "P-4DSP",
      claim_ref: "C-1@2",
      body_md: "sensitive private text",
      seed_hex: "00112233445566778899aabbccddeeff",
      presigned_url: "https://r2.example/obj?X-Amz-Signature=abc",
    }) as Record<string, unknown>;
    expect(cleanedObj.problem_id).toBe("P-4DSP");
    expect(cleanedObj.claim_ref).toBe("C-1@2");
    expect(cleanedObj.body_md).toBeUndefined();
    expect(cleanedObj.seed_hex).toBeUndefined();
    expect(cleanedObj.presigned_url).toBeUndefined();
    expect(cleanedObj._redacted_fields).toEqual(["body_md", "presigned_url", "seed_hex"]);

    // Benign scientific identifiers must pass untouched (zero false positives).
    const benign = "Verified P-4DSP C-1@2 version v1.2 audit OA-01JXYZ workflow_v1.config";
    expect(containsNeverLogMaterial(benign)).toBe(false);
    expect(redactOpsText(benign)).toBe(benign);
  });

  test("ops:event-verify passes on sound chain + real Ed25519 checkpoint signature and fails closed on tampered chain or signature", async () => {
    const okReport = await runEventVerify({
      sqlitePath,
      problemId: "P-OPS5",
      verifyKeysJson,
      auditLogPath,
    });
    expect(okReport.overall_sound).toBe(true);
    expect(okReport.results[0]?.event_count).toBe(1);
    expect(okReport.results[0]?.checkpoints_valid).toBe(true);
    expect(okReport.results[0]?.signatures_checked).toBe(1);
    expect(okReport.results[0]?.signatures_valid).toBe(true);

    // Plant a tampered chain digest in a scratch copy.
    const badPath = join(workDir, "tampered-chain.sqlite");
    writeFileSync(badPath, readFileSync(sqlitePath));
    const badDb = new Database(badPath);
    badDb.exec(`UPDATE event_chain_v2 SET chain_digest = '${"f".repeat(64)}' WHERE seq = 1`);
    badDb.close();

    const badReport = await runEventVerify({ sqlitePath: badPath, problemId: "P-OPS5" });
    expect(badReport.overall_sound).toBe(false);
    expect(badReport.results[0]?.chain_valid).toBe(false);

    // Plant a tampered Ed25519 signature on real 0079 checkpoint_signatures table.
    const badSigPath = join(workDir, "tampered-sig.sqlite");
    writeFileSync(badSigPath, readFileSync(sqlitePath));
    const badSigDb = new Database(badSigPath);
    badSigDb.exec(
      `UPDATE checkpoint_signatures SET signature = '${"0".repeat(128)}' WHERE checkpoint_seq = 1`,
    );
    badSigDb.close();
    const badSigReport = await runEventVerify({
      sqlitePath: badSigPath,
      problemId: "P-OPS5",
      verifyKeysJson,
    });
    expect(badSigReport.overall_sound).toBe(false);
    expect(badSigReport.results[0]?.signatures_valid).toBe(false);
  });

  test("ops:projection-rebuild detects drift in dry-run, enforces reason+step-up on --apply, and heals claim_projections from log", () => {
    const driftPath = join(workDir, "drifted-proj.sqlite");
    writeFileSync(driftPath, readFileSync(sqlitePath));
    const db = new Database(driftPath);
    db.exec(
      `UPDATE claim_projections SET build_digest = 'stale-corrupted-digest', stale = 1 WHERE claim_id = 'C-1'`,
    );
    db.close();

    const dry = runProjectionRebuild({
      sqlitePath: driftPath,
      problemId: "P-OPS5",
      apply: false,
      auditLogPath,
    });
    expect(dry.before.sound).toBe(false);
    expect(dry.before.rebuildSet).toEqual(["C-1"]);
    expect(dry.applied_rebuilds).toEqual([]);

    // --apply without --reason fails closed.
    expect(() =>
      runProjectionRebuild({
        sqlitePath: driftPath,
        problemId: "P-OPS5",
        apply: true,
        reason: "",
        stepUpConfirm: "rebuild-projections:P-OPS5",
      }),
    ).toThrow("OPS_REASON_REQUIRED");

    // --apply with secret accidentally pasted into --reason fails closed.
    expect(() =>
      runProjectionRebuild({
        sqlitePath: driftPath,
        problemId: "P-OPS5",
        apply: true,
        reason: "repairing for asimp_ag_LeakInReason12345",
        stepUpConfirm: "rebuild-projections:P-OPS5",
      }),
    ).toThrow("OPS_REASON_NEVER_LOG_REFUSED");

    // --apply without matching step-up fails closed.
    expect(() =>
      runProjectionRebuild({
        sqlitePath: driftPath,
        problemId: "P-OPS5",
        apply: true,
        reason: "Rebuilding corrupted claim projection from authoritative log",
        stepUpConfirm: "wrong-confirm",
      }),
    ).toThrow("OPS_STEP_UP_REQUIRED");

    // Authorized --apply repairs projection from log and leaves sound=true.
    const applied = runProjectionRebuild({
      sqlitePath: driftPath,
      problemId: "P-OPS5",
      apply: true,
      reason: "Rebuilding corrupted claim projection from authoritative log",
      stepUpConfirm: "rebuild-projections:P-OPS5",
      auditLogPath,
    });
    expect(applied.before.sound).toBe(false);
    expect(applied.applied_rebuilds).toEqual(["C-1"]);
    expect(applied.after.sound).toBe(true);
  });

  test("ops:artifact-inventory passes on clean mirror and flags missing/orphaned/corrupted R2 objects", () => {
    const clean = runArtifactInventory({
      sqlitePath,
      r2DirPath: join(workDir, "r2-mirror"),
      auditLogPath,
    });
    expect(clean.sound).toBe(true);
    expect(clean.matched_count).toBe(1);

    const manifestPath = join(workDir, "bad-r2-manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        objects: [{ key: "cas/orphan-object-key", size_bytes: 42, sha256: "a".repeat(64) }],
      }),
      "utf8",
    );
    const drifted = runArtifactInventory({ sqlitePath, r2ManifestPath: manifestPath });
    expect(drifted.sound).toBe(false);
    expect(drifted.missing_in_r2.length).toBe(1);
    expect(drifted.orphaned_in_r2).toEqual(["cas/orphan-object-key"]);
  });

  test("ops:cache-privacy-test passes on properly private endpoint and fails on public cache leak", async () => {
    const ownerTok = "asimp_ag_OwnerPrivacyProbeToken0001";
    const otherTok = "asimp_ag_OtherPrivacyProbeToken0002";
    const canary = "PRIVATE_CANARY_98421";
    let leakMode = false;

    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const auth = req.headers.get("authorization");
        if (leakMode) {
          return new Response(`leaked: ${canary}`, {
            status: 200,
            headers: { "cache-control": "public, s-maxage=60" },
          });
        }
        if (auth === `Bearer ${ownerTok}`) {
          return new Response(`owner private view: ${canary}`, {
            status: 200,
            headers: { "cache-control": "private, no-store" },
          });
        }
        return new Response("not found", {
          status: 404,
          headers: { "cache-control": "private, no-store" },
        });
      },
    });

    try {
      const origin = `http://127.0.0.1:${srv.port}`;
      const ok = await runCachePrivacyTest({
        origin,
        targetPath: "/v1/sponsors/workshop/private-draft",
        ownerToken: ownerTok,
        otherToken: otherTok,
        canary,
        auditLogPath,
      });
      expect(ok.pass).toBe(true);
      expect(ok.steps.length).toBe(4);

      const missingCanary = await runCachePrivacyTest({
        origin,
        targetPath: "/v1/sponsors/workshop/private-draft",
        ownerToken: ownerTok,
        otherToken: otherTok,
        canary: "CANARY_NOT_IN_OWNER_RESPONSE",
      });
      expect(missingCanary.pass).toBe(false);
      expect(missingCanary.steps.find((s) => s.actor === "owner")?.reason).toContain(
        "OWNER_CANARY_ABSENT",
      );

      leakMode = true;
      const leaked = await runCachePrivacyTest({
        origin,
        targetPath: "/v1/sponsors/workshop/private-draft",
        ownerToken: ownerTok,
        otherToken: otherTok,
        canary,
      });
      expect(leaked.pass).toBe(false);
      expect(leaked.steps.some((s) => s.canary_leaked)).toBe(true);
    } finally {
      srv.stop(true);
    }
  });

  test("ops:backup-restore-smoke enforces scratch target, export chain, mandatory retention journal, and negative probes", async () => {
    const entries: RetentionControlJournal["entries"] = [
      {
        id: "RJ-1",
        kind: "token_revocation",
        target_id: "CR-REVOKED-1",
        recorded_at: "2026-11-21T12:05:00.000Z",
      },
      {
        id: "RJ-2",
        kind: "private_draft_removal",
        target_id: "W-DELETED-1",
        recorded_at: "2026-11-21T12:06:00.000Z",
      },
      {
        id: "RJ-3",
        kind: "account_deletion",
        target_id: "SP-DELETED-1",
        recorded_at: "2026-11-21T12:07:00.000Z",
        legal_hold: true,
        shared_cas: true,
      },
      {
        id: "RJ-4",
        kind: "content_control",
        target_id: "CC-HIDE-1",
        recorded_at: "2026-11-21T12:08:00.000Z",
      },
    ];
    const journalPath = join(workDir, "retention-journal.json");
    const journal: RetentionControlJournal = {
      schema: "asimposium.retention-control-journal.v1",
      generated_at: "2026-11-21T12:10:00.000Z",
      snapshot_cutoff_at: "2026-11-21T12:00:00.000Z",
      entries,
      entries_sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    };
    writeFileSync(journalPath, JSON.stringify(journal), "utf8");

    // Refuses production/staging targets fail-closed.
    await expect(
      runBackupRestoreSmoke({
        targetIdentifier: "production-d1",
        exportNdjsonPath: exportPath,
        retentionJournalPath: journalPath,
      }),
    ).rejects.toThrow("RESTORE_NON_SCRATCH_TARGET_REFUSED");

    // Missing retention journal keeps target quarantined-stop.
    const noJournal = await runBackupRestoreSmoke({
      targetIdentifier: "scratch-rehearsal-1",
      exportNdjsonPath: exportPath,
      retentionJournalPath: null,
    });
    expect(noJournal.target_quarantine_state).toBe("quarantined-stop");
    expect(noJournal.retention_journal_verified).toBe(false);

    // Valid scratch target + intact export + verified retention journal + clean negative probes passes.
    const passReport = await runBackupRestoreSmoke({
      targetIdentifier: "scratch-rehearsal-1",
      exportNdjsonPath: exportPath,
      retentionJournalPath: journalPath,
      scratchSqlitePath: sqlitePath,
      auditLogPath,
    });
    expect(passReport.failures).toEqual([]);
    expect(passReport.target_quarantine_state).toBe("verified-ready-to-unquarantine");
    expect(passReport.export_chain_intact).toBe(true);
    expect(passReport.retention_journal_verified).toBe(true);
    expect(passReport.negative_probes_passed).toBe(true);
    expect(passReport.legal_hold_entries).toBe(1);
    expect(passReport.shared_cas_entries).toBe(1);

    // Resurrected revoked credential in real fellow_tokens fails negative probe and holds target quarantined.
    const resurrectedDb = join(workDir, "resurrected.sqlite");
    writeFileSync(resurrectedDb, readFileSync(sqlitePath));
    const db = new Database(resurrectedDb);
    db.exec(`UPDATE fellow_tokens SET revoked_at = NULL WHERE credential_id = 'CR-REVOKED-1'`);
    db.close();

    const failProbe = await runBackupRestoreSmoke({
      targetIdentifier: "scratch-rehearsal-2",
      exportNdjsonPath: exportPath,
      retentionJournalPath: journalPath,
      scratchSqlitePath: resurrectedDb,
    });
    expect(failProbe.target_quarantine_state).toBe("quarantined-stop");
    expect(failProbe.negative_probes_passed).toBe(false);
    expect(failProbe.failures[0]).toContain("STALE_AUTHORITY_LEAK");

    // Missing authority table fails closed instead of silently skipping probes!
    const emptySchemaDb = join(workDir, "empty-schema.sqlite");
    const eDb = new Database(emptySchemaDb);
    eDb.exec("CREATE TABLE dummy (x INTEGER);");
    eDb.close();
    const missingTableProbe = await runBackupRestoreSmoke({
      targetIdentifier: "scratch-rehearsal-3",
      exportNdjsonPath: exportPath,
      retentionJournalPath: journalPath,
      scratchSqlitePath: emptySchemaDb,
    });
    expect(missingTableProbe.target_quarantine_state).toBe("quarantined-stop");
    expect(missingTableProbe.negative_probes_passed).toBe(false);
    expect(
      missingTableProbe.failures.some((f) => f.includes("MISSING_REQUIRED_AUTHORITY_TABLE")),
    ).toBe(true);
  });

  test("append-only SHA-256 audit log verifies intact, holds zero never-log leaks, and detects tampering", () => {
    const canaryToken = ["asimp", "ag", "ShouldNeverAppearInAuditLog9999"].join("_");
    appendOpsAuditRecord(auditLogPath, {
      command: "ops:redaction-canary-test",
      mode: "dry-run",
      status: "pass",
      summary: {
        secret: canaryToken,
        note: "checked P-OPS5 safely",
      },
    });
    const verified = verifyOpsAuditLog(auditLogPath);
    expect(verified.valid).toBe(true);
    expect(verified.entryCount).toBeGreaterThanOrEqual(6);
    const raw = readFileSync(auditLogPath, "utf8");
    expect(raw).not.toContain("ShouldNeverAppearInAuditLog9999");

    // Planted audit tamper must be detected.
    const tamperedLog = join(workDir, "tampered-audit.ndjson");
    writeFileSync(tamperedLog, raw.replace("P-OPS5", "P-TAMPERED"), "utf8");
    const tamperedCheck = verifyOpsAuditLog(tamperedLog);
    expect(tamperedCheck.valid).toBe(false);
    expect(tamperedCheck.error).toContain("AUDIT_LOG_DIGEST_MISMATCH");

    // Direct helper check on assertMutationAuthorized dry-run bypass.
    expect(() =>
      assertMutationAuthorized({
        apply: false,
        reason: null,
        stepUpConfirm: null,
        expectedStepUp: "x",
        command: "ops:noop",
      }),
    ).not.toThrow();

    // Fresh-eyes Pass 3 regressions:
    // 1. Cyclic objects must not stack-overflow redactOpsValue.
    const cyclic: Record<string, unknown> = { ok: true };
    cyclic.self = cyclic;
    const redactedCyclic = redactOpsValue(cyclic) as Record<string, unknown>;
    expect(redactedCyclic.self).toBe("[CIRCULAR]");

    // 2. __Host-asimp.session cookie and x-asimposium-service-signature header must redact cleanly.
    const hostCookie = redactOpsText(
      "Cookie: __Host-asimp.session=secretCookieVal999; x-asimposium-service-signature=sigHex999",
    );
    expect(hostCookie).not.toContain("secretCookieVal999");
    expect(hostCookie).not.toContain("sigHex999");

    // 3. Corrupt JSON audit tail refuses append instead of silently forking from genesis,
    //    and verifyOpsAuditLog returns structured AUDIT_LOG_MALFORMED_JSON instead of throwing.
    const corruptLog = join(workDir, "corrupt-audit.ndjson");
    writeFileSync(corruptLog, '{"broken": true\n', "utf8");
    expect(() =>
      appendOpsAuditRecord(corruptLog, {
        command: "ops:noop",
        mode: "dry-run",
        status: "pass",
        summary: {},
      }),
    ).toThrow(/OPS_AUDIT_LOG_CORRUPT_TAIL/);
    const malformedVerify = verifyOpsAuditLog(corruptLog);
    expect(malformedVerify.valid).toBe(false);
    expect(malformedVerify.error).toContain("AUDIT_LOG_MALFORMED_JSON");
  });

  test("Fresh-eyes Pass 3 regressions: missing event_chain_v2 row, omitted verify-keys, malformed journal, and pending sponsorship_transfer all fail closed", async () => {
    // 1. Omitting --verify-keys when checkpoint_signatures rows exist fails closed.
    const noKeys = await runEventVerify({ sqlitePath });
    expect(noKeys.overall_sound).toBe(false);
    expect(
      noKeys.results[0]?.failures.some((f) =>
        f.includes("CHECKPOINT_SIGNATURES_UNVERIFIED_NO_KEYS"),
      ),
    ).toBe(true);

    // 2. Event row missing its event_chain_v2 record is caught by LEFT JOIN (not silently dropped).
    const missingV2Db = join(workDir, "missing-chain-v2.sqlite");
    const srcBytes = readFileSync(sqlitePath);
    writeFileSync(missingV2Db, srcBytes);
    const mdb = new Database(missingV2Db);
    mdb.exec("DELETE FROM event_chain_v2;");
    mdb.close();
    const missingRes = await runEventVerify({ sqlitePath: missingV2Db, verifyKeysJson });
    expect(missingRes.overall_sound).toBe(false);
    expect(
      missingRes.results[0]?.failures.some((f) => f.includes("EVENT_CHAIN_V2_ROW_MISSING")),
    ).toBe(true);
    expect(() => runProjectionRebuild({ sqlitePath: missingV2Db, problemId: "P-OPS5" })).toThrow(
      /EVENT_CHAIN_V2_ROW_MISSING/,
    );

    // 3. Malformed retention-journal JSON returns clean quarantined-stop (no uncaught SyntaxError).
    const badJournal = join(workDir, "bad-journal.json");
    writeFileSync(badJournal, "{not json", "utf8");
    const badJournalReport = await runBackupRestoreSmoke({
      targetIdentifier: "scratch-rehearsal-bad-json",
      exportNdjsonPath: exportPath,
      retentionJournalPath: badJournal,
    });
    expect(badJournalReport.target_quarantine_state).toBe("quarantined-stop");
    expect(badJournalReport.failures.some((f) => f.includes("RETENTION_JOURNAL_INVALID"))).toBe(
      true,
    );

    // 4. sponsorship_transfer entry detects resurrected pending transfer in sponsor_fellow_transfers.
    const trfDbPath = join(workDir, "transfer-resurrected.sqlite");
    writeFileSync(trfDbPath, srcBytes);
    const tdb = new Database(trfDbPath);
    tdb.exec(`
      CREATE TABLE sponsor_fellow_transfers (
        transfer_id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      INSERT INTO sponsor_fellow_transfers VALUES ('TRF-01OPS5000000000000000001', 'pending');
    `);
    tdb.close();
    const trfEntries: RetentionControlJournal["entries"] = [
      {
        id: "RJ-TRF-1",
        kind: "sponsorship_transfer",
        target_id: "TRF-01OPS5000000000000000001",
        recorded_at: "2026-11-21T12:15:00.000Z",
      },
    ];
    const trfJournalPath = join(workDir, "trf-journal.json");
    writeFileSync(
      trfJournalPath,
      JSON.stringify({
        schema: "asimposium.retention-control-journal.v1",
        generated_at: "2026-11-21T12:20:00.000Z",
        snapshot_cutoff_at: "2026-11-21T12:00:00.000Z",
        entries: trfEntries,
        entries_sha256: createHash("sha256").update(JSON.stringify(trfEntries)).digest("hex"),
      }),
      "utf8",
    );
    const trfReport = await runBackupRestoreSmoke({
      targetIdentifier: "scratch-rehearsal-trf",
      exportNdjsonPath: exportPath,
      retentionJournalPath: trfJournalPath,
      scratchSqlitePath: trfDbPath,
    });
    expect(trfReport.target_quarantine_state).toBe("quarantined-stop");
    expect(trfReport.failures.some((f) => f.includes("STALE_TRANSFER_PENDING_AFTER_RESTORE"))).toBe(
      true,
    );

    // 5. private_draft_removal targeting a P-* private-draft problem detects resurrection in problems table.
    const pdDbPath = join(workDir, "private-problem-resurrected.sqlite");
    writeFileSync(pdDbPath, srcBytes);
    const pddb = new Database(pdDbPath);
    pddb.exec(`
      CREATE TABLE problems (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      INSERT INTO problems VALUES ('P-ERASED-DRAFT-1', 'private-draft');
    `);
    pddb.close();
    const pdEntries: RetentionControlJournal["entries"] = [
      {
        id: "RJ-PD-1",
        kind: "private_draft_removal",
        target_id: "P-ERASED-DRAFT-1",
        recorded_at: "2026-11-21T12:16:00.000Z",
      },
    ];
    const pdJournalPath = join(workDir, "pd-journal.json");
    writeFileSync(
      pdJournalPath,
      JSON.stringify({
        schema: "asimposium.retention-control-journal.v1",
        generated_at: "2026-11-21T12:20:00.000Z",
        snapshot_cutoff_at: "2026-11-21T12:00:00.000Z",
        entries: pdEntries,
        entries_sha256: createHash("sha256").update(JSON.stringify(pdEntries)).digest("hex"),
      }),
      "utf8",
    );
    const pdReport = await runBackupRestoreSmoke({
      targetIdentifier: "scratch-rehearsal-pd",
      exportNdjsonPath: exportPath,
      retentionJournalPath: pdJournalPath,
      scratchSqlitePath: pdDbPath,
    });
    expect(pdReport.target_quarantine_state).toBe("quarantined-stop");
    expect(pdReport.failures.some((f) => f.includes("DELETED_PRIVATE_PROBLEM_RESURRECTED"))).toBe(
      true,
    );

    // 6. redactOpsValue preserves redacted Error/Date shapes and omits prototype-pollution keys.
    const errRedacted = redactOpsValue({
      at: new Date("2026-11-23T00:00:00.000Z"),
      err: new Error(
        `Failed with ${["asimp", "ag", "01OPS5TEST0000000000000001", "Z".repeat(43)].join("_")}`,
      ),
      constructor: "drop-me",
    }) as Record<string, unknown>;
    expect(errRedacted.at).toBe("2026-11-23T00:00:00.000Z");
    const errObj = errRedacted.err as Record<string, unknown>;
    expect(errObj.name).toBe("Error");
    expect(String(errObj.message)).not.toContain("01OPS5TEST");
    expect(errRedacted._redacted_fields).toEqual(["constructor"]);
  });

  test("all 12 Fable §13.3 runbooks exist, are indexed in INDEX.md, carry rehearsal checklists, and pass P7 scan", () => {
    const indexText = readFileSync(join(REPO_ROOT, "docs/runbooks/INDEX.md"), "utf8");
    for (const file of TWELVE_NAMED_RUNBOOKS) {
      const fullPath = join(REPO_ROOT, "docs/runbooks", file);
      expect(existsSync(fullPath), `missing runbook ${file}`).toBe(true);
      expect(indexText).toContain(file);
      const body = readFileSync(fullPath, "utf8");
      const lower = body.toLowerCase();
      expect(lower.includes("rehearsal") || lower.includes("dry run")).toBe(true);
      expect(scanFieldForCredentials(file, body)).toEqual([]);
    }
  });
});
