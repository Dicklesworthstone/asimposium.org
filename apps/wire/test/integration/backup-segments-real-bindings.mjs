import assert from "node:assert/strict";
import { assembleLedgerBackup } from "../../../../scripts/assemble-ledger-backup.ts";
import { verifyExportOffline } from "../../../../scripts/verify-export.ts";
import { BACKUP_RUN_KEY } from "../../src/krater/backup-scheduler.ts";
import { backupManifestKey, backupSegmentKey } from "../../src/krater/backup-segments.ts";
import { deletionSafeRestore } from "../../src/krater/retention.ts";
import {
  CHECKPOINT_KEY_ID,
  CHECKPOINT_PUBLIC_KEY_HEX,
  runLocalWorkerJourney,
} from "./problem-lifecycle-real-bindings.mjs";

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, fixtures, env }) => {
    const sponsor = "usr_segmented_backup";
    const fellow = await enroll("segmented-backup", sponsor);
    const { problem } = await call(
      "/v1/problems",
      {
        title: "Recover a mature ledger",
        statement: "Every even integer has an even square.",
        falsifier: "An even integer whose square is odd.",
        motivation: "Exercise bounded archive continuation and verified recovery.",
        areas: ["number-theory"],
      },
      fellow,
      201,
    );
    await sponsorCall(
      sponsor,
      "POST",
      `/v1/sponsors/problems/${problem.id}/lifecycle`,
      "problem-lifecycle",
      { action: "publish" },
    );
    // Volume fixture through production Krater on real D1. This lane certifies
    // backup/recovery, not the public admission of these synthetic comments.
    for (let remaining = 1001; remaining > 0; remaining -= 50) {
      await fixtures.appendBackupHistory(problem.id, Math.min(50, remaining));
    }
    console.log(JSON.stringify({ stage: "segmented-backup-count-history-ready" }));
    // Individually valid structured ledger payloads can exceed 16 KiB; the
    // export grammar must retain the same 512 KiB byte cap as Krater ingress.
    for (let remaining = 200; remaining > 0; remaining -= 25) {
      await fixtures.appendBackupHistory(problem.id, Math.min(25, remaining), 22000);
    }
    console.log(JSON.stringify({ stage: "segmented-backup-payload-history-ready" }));
    const now = Date.now() + 1000;
    const date = new Date(now).toISOString().slice(0, 10);
    const state = async () => JSON.parse(await (await env.ARTIFACTS.get(BACKUP_RUN_KEY)).text());
    assert.equal((await fixtures.backupSchedulerTick(now)).status, "waiting-for-signature");
    const pinned = (await state()).pending;
    assert.ok(pinned.cursor > 1000);
    const identity = { problem_id: problem.id, date, chain_digest: pinned.chainDigest };
    const manifestKey = backupManifestKey(identity);
    await fixtures.appendBackupHistory(problem.id, 1);
    for (let round = 0; round < 30; round++) {
      const signed = await fixtures.signCheckpointsTick();
      if (signed.signed === 0) break;
    }
    console.log(JSON.stringify({ stage: "segmented-backup-checkpoints-signed" }));
    const raced = await fixtures.raceBackupSchedulerTicks(now + 1);
    assert.equal(raced.filter((result) => result.status === "segment-written").length, 1);
    assert.equal(raced.filter((result) => result.status === "busy").length, 1);
    const first = await state();
    assert.equal(first.pending.segmented.after, 1000, "one tick stops at its event budget");
    assert.equal(first.written, 0, "partial segments are not a completed archive");
    assert.equal(await env.ARTIFACTS.get(manifestKey), null);
    assert.equal((await fixtures.backupSchedulerTick(now + 2)).status, "segment-written");
    const second = await state();
    assert.ok(second.pending.segmented.after > 1000);
    assert.ok(
      second.pending.segmented.after < pinned.cursor,
      "payload budget also splits a segment",
    );
    const secondKey = backupSegmentKey(identity, 2);
    const secondBody = await (await env.ARTIFACTS.get(secondKey)).text();
    assert.ok(Buffer.byteLength(secondBody) <= 12 * 1024 * 1024);
    // Crash after a segment was stored but before its conditional cursor write.
    await env.ARTIFACTS.put(BACKUP_RUN_KEY, JSON.stringify(first));
    assert.equal((await fixtures.backupSchedulerTick(now + 3)).status, "segment-written");
    assert.equal(await (await env.ARTIFACTS.get(secondKey)).text(), secondBody);
    assert.deepEqual((await state()).pending.segmented, second.pending.segmented);
    assert.equal(await env.ARTIFACTS.get(manifestKey), null);
    const final = await fixtures.backupSchedulerTick(now + 4);
    assert.equal(final.status, "advanced");
    assert.equal(final.written, 1);
    assert.equal((await fixtures.backupSchedulerTick(now + 5)).status, "complete");
    const manifest = JSON.parse(await (await env.ARTIFACTS.get(manifestKey)).text());
    assert.equal(
      manifest.cursor,
      pinned.cursor,
      "later appends do not extend the captured archive",
    );
    assert.equal(manifest.segments, 3);
    console.log(JSON.stringify({ stage: "segmented-backup-manifest-complete" }));
    const trustedKeys = [{ key_id: CHECKPOINT_KEY_ID, public_key: CHECKPOINT_PUBLIC_KEY_HEX }];
    const readSegment = async (key) => (await env.ARTIFACTS.get(key))?.text() ?? null;
    const assembled = await assembleLedgerBackup({ manifest, trustedKeys, readSegment });
    assert.equal(assembled.eventCount, pinned.cursor);
    const verified = await verifyExportOffline({ ...assembled, trustedKeys });
    assert.equal(verified.ok, true, JSON.stringify(verified.failures));
    await assert.rejects(
      () =>
        assembleLedgerBackup({
          manifest,
          trustedKeys,
          readSegment: async (key) => (key === secondKey ? null : readSegment(key)),
        }),
      /BACKUP_SEGMENT_MISSING/,
    );
    await assert.rejects(
      () =>
        assembleLedgerBackup({
          manifest,
          trustedKeys,
          readSegment: async (key) =>
            key === secondKey ? secondBody.replace('"seq":1001', '"seq":1002') : readSegment(key),
        }),
      /BACKUP_SEGMENT_CHAIN_INVALID/,
    );
    assert.deepEqual((await env.PUBLIC_ARTIFACTS.list({ prefix: "backups/" })).objects, []);
    console.log(JSON.stringify({ stage: "segmented-backup-assembly-verified" }));

    // Full recovery is an offline host operation using the existing guarded
    // importer and real scratch D1. It is not a large Worker restore RPC.
    const recoveryKey = `assembled/${date}/${problem.id}.jsonl`;
    await env.BACKUPS.put(recoveryKey, assembled.ndjson);
    const missingJournal = await fixtures.restoreIntoScratch({
      key: recoveryKey,
      targetIdentifier: "scratch-restore-proof",
      journal: null,
    });
    assert.equal(missingJournal.ok, false);
    assert.match(missingJournal.message, /DELETION_JOURNAL_MISSING/);
    const privateDraft = (
      await call(
        "/v1/problems",
        {
          title: "Private deletion witness",
          statement: "This draft was never published.",
          falsifier: "A published copy of this draft.",
          motivation: "Exercise the current deletion journal.",
          areas: ["number-theory"],
        },
        fellow,
        201,
      )
    ).problem.id;
    await sponsorCall(
      sponsor,
      "DELETE",
      `/v1/sponsors/problems/${privateDraft}`,
      "delete-problem-draft",
    );
    assert.equal((await fixtures.publishDeletionJournalTick()).published, true);
    const journal = await fixtures.fetchDeletionJournal();
    console.log(JSON.stringify({ stage: "segmented-backup-deletion-journal-ready" }));
    const restored = await deletionSafeRestore({
      db: env.SCRATCH_DB,
      targetIdentifier: "scratch-restore-proof",
      snapshotNdjson: await (await env.BACKUPS.get(recoveryKey)).text(),
      deletionJournalNdjson: journal,
      verifyKeys: [{ kid: CHECKPOINT_KEY_ID, publicKeyHex: CHECKPOINT_PUBLIC_KEY_HEX }],
    });
    assert.ok("inserted" in restored.projections, JSON.stringify(restored.projections));
    assert.equal(restored.eventCount, pinned.cursor);
    const target = await env.SCRATCH_DB.prepare(
      "SELECT public_seq, chain_digest FROM problems WHERE id = ?",
    )
      .bind(problem.id)
      .first();
    assert.deepEqual(target, { public_seq: pinned.cursor, chain_digest: pinned.chainDigest });
    const count = await env.SCRATCH_DB.prepare("SELECT COUNT(*) AS n FROM event_content").first();
    assert.equal(count.n, pinned.cursor);
    console.log(
      JSON.stringify({
        kind: "segmented-backup-real-bindings",
        status: "pass",
        events: pinned.cursor,
        segments: manifest.segments,
        bounded_event_and_payload_work: true,
        conditional_lease_race: true,
        interrupted_segment_replayed: true,
        pinned_prefix: true,
        canonical_export_verified: true,
        deletion_safe_scratch_restore: true,
        restore_runtime: "offline-node-host",
        boundary:
          "local Workerd/D1/R2; synthetic bulk history through production Krater; no cloud backup or full SQL recovery claim",
      }),
    );
  },
  { scratch: true },
);
