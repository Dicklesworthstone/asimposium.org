import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "asimp-ops-vpx-"));
    sqlitePath = join(workDir, "local-d1.sqlite");
    exportPath = join(workDir, "problem-export.ndjson");
    auditLogPath = join(workDir, "ops-audit.ndjson");

    const db = new Database(sqlitePath);
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
        checkpoint_digest TEXT NOT NULL
      );
      CREATE TABLE claims (
        id TEXT NOT NULL,
        problem_id TEXT NOT NULL,
        source_seq INTEGER NOT NULL,
        projection_version INTEGER NOT NULL,
        build_digest TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (problem_id, id)
      );
      CREATE TABLE artifacts (
        r2_key TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL
      );
      CREATE TABLE fellow_credentials (
        id TEXT PRIMARY KEY,
        revoked_at TEXT
      );
      CREATE TABLE workshop_objects (
        id TEXT PRIMARY KEY,
        deleted_at TEXT
      );
      CREATE TABLE sponsors (
        id TEXT PRIMARY KEY,
        deleted_at TEXT
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
    db.prepare(`INSERT INTO claims VALUES (?, ?, ?, ?, ?, ?)`).run(
      "C-1",
      problemId,
      1,
      1,
      buildDigest,
      0,
    );

    const artBody = Buffer.from("proof artifact bytes\n", "utf8");
    const artSha = createHash("sha256").update(artBody).digest("hex");
    db.prepare(`INSERT INTO artifacts VALUES (?, ?, ?)`).run(
      `cas/${artSha}`,
      artSha,
      artBody.byteLength,
    );
    db.prepare(`INSERT INTO fellow_credentials VALUES (?, ?)`).run("CR-REVOKED-1", createdAt);
    db.prepare(`INSERT INTO workshop_objects VALUES (?, ?)`).run("W-DELETED-1", createdAt);
    db.prepare(`INSERT INTO sponsors VALUES (?, ?)`).run("SP-DELETED-1", createdAt);
    db.close();

    const r2Dir = join(workDir, "r2-mirror", "cas");
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

  test("ops:event-verify passes on sound chain and fails closed on tampered chain digest", async () => {
    const okReport = await runEventVerify({
      sqlitePath,
      problemId: "P-OPS5",
      auditLogPath,
    });
    expect(okReport.overall_sound).toBe(true);
    expect(okReport.results[0]?.event_count).toBe(1);
    expect(okReport.results[0]?.checkpoints_valid).toBe(true);

    // Plant a tampered chain digest in a scratch copy.
    const badPath = join(workDir, "tampered-chain.sqlite");
    writeFileSync(badPath, readFileSync(sqlitePath));
    const badDb = new Database(badPath);
    badDb.exec(`UPDATE event_chain_v2 SET chain_digest = '${"f".repeat(64)}' WHERE seq = 1`);
    badDb.close();

    const badReport = await runEventVerify({ sqlitePath: badPath, problemId: "P-OPS5" });
    expect(badReport.overall_sound).toBe(false);
    expect(badReport.results[0]?.chain_valid).toBe(false);
  });

  test("ops:projection-rebuild detects drift in dry-run, enforces reason+step-up on --apply, and heals from log", () => {
    const driftPath = join(workDir, "drifted-proj.sqlite");
    writeFileSync(driftPath, readFileSync(sqlitePath));
    const db = new Database(driftPath);
    db.exec(
      `UPDATE claims SET build_digest = 'stale-corrupted-digest', stale = 1 WHERE id = 'C-1'`,
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

    // Resurrected revoked credential fails negative probe and holds target quarantined.
    const resurrectedDb = join(workDir, "resurrected.sqlite");
    writeFileSync(resurrectedDb, readFileSync(sqlitePath));
    const db = new Database(resurrectedDb);
    db.exec(`UPDATE fellow_credentials SET revoked_at = NULL WHERE id = 'CR-REVOKED-1'`);
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
