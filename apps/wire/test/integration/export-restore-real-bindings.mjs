import assert from "node:assert/strict";
import { verifyExportOffline } from "../../../../scripts/verify-export.ts";
import {
  CHECKPOINT_KEY_ID,
  CHECKPOINT_PUBLIC_KEY_HEX,
  runLocalWorkerJourney,
} from "./problem-lifecycle-real-bindings.mjs";

// Backup, export and deletion-safe restore (bead asimposiumorg-p4b) on real
// local Workerd, D1 and R2. The production backup writer puts one problem's
// export into a BACKUPS bucket. Restore reads it back and lands only in a
// separately migrated SCRATCH_DB, after verifying the chain and the signed
// deletion journal. Refused restores write nothing, and the restored log
// matches the source byte for byte. Private workshop and draft bytes never
// enter the export.
//
// Not covered: the production backups bucket and its 90-day lifecycle rule,
// D1 Time Travel, cron scheduling (OPS.6), multi-problem runs.

const WORKSHOP_MARKER = "PRIVATE-WORKSHOP-MARKER-5c1e";
const DRAFT_MARKER = "PRIVATE-DRAFT-MARKER-9b2d";
const TARGET = "scratch-restore-proof";

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, fixtures }) => {
    const SPONSOR = "usr_restore_author";
    const author = await enroll("restore-author", SPONSOR);
    const reviewer = await enroll("restore-reviewer", "usr_restore_reviewer");
    const title = "Restorable parity problem";
    const created = await call(
      "/v1/problems",
      {
        title,
        statement: "Every integer in 0..60 has a square of the same parity.",
        falsifier: "An integer in 0..60 whose square has the opposite parity.",
        motivation: "Exercise export and deletion-safe restore.",
        areas: ["number-theory"],
      },
      author,
      201,
    );
    const problem = created.problem.id;
    await sponsorCall(
      SPONSOR,
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      {
        action: "publish",
      },
    );
    const reviewSession = (
      await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
    ).session_id;
    await call(
      `/v1/problems/${problem}/statement-review`,
      {
        session_id: reviewSession,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "Exact range.",
      },
      reviewer,
    );
    const session = (
      await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
    ).session_id;
    for (const statement of ["Zero squared is even.", "One squared is odd."]) {
      const draft = await call(
        `/v1/sessions/${session}/workshop`,
        { type: "claim-draft", title: "Draft", body_md: "Private." },
        author,
        201,
      );
      await call(
        `/v1/sessions/${session}/promote`,
        {
          workshop_id: draft.workshop_id,
          kind: "conjecture",
          statement,
          falsifier: "A counterexample in range.",
        },
        author,
        201,
      );
    }
    // Private state that must never reach an export: an unpromoted workshop
    // draft, and a never-published draft problem that is then deleted.
    await call(
      `/v1/sessions/${session}/workshop`,
      { type: "claim-draft", title: "Scratch", body_md: `${WORKSHOP_MARKER} unfinished idea.` },
      author,
      201,
    );
    const privateDraft = (
      await call(
        "/v1/problems",
        {
          title: "Private draft problem",
          statement: `${DRAFT_MARKER}: every integer in 0..9 is small.`,
          falsifier: "An integer in 0..9 that is not small.",
          motivation: "Never published.",
          areas: ["number-theory"],
        },
        author,
        201,
      )
    ).problem.id;
    await sponsorCall(
      SPONSOR,
      "DELETE",
      `/v1/sponsors/problems/${privateDraft}`,
      "delete-problem-draft",
    );

    // 1. The production backup writer puts a verified export into R2, with
    //    the signed checkpoint face beside it (signed first, as the cron does).
    assert.equal((await fixtures.signCheckpointsTick()).enabled, true);
    const backup = await fixtures.backupToR2(problem, title, "2026-09-26");
    assert.ok(backup, "a problem with events is backed up");
    assert.match(backup.key, new RegExp(`^backups/2026-09-26/${problem}/[0-9a-f]{32}\\.jsonl$`));
    assert.ok(backup.eventCount >= 3, "publish plus two promotions");
    const exported = await fixtures.readBackup(backup.key);
    assert.ok(exported?.includes(problem));
    assert.ok(!exported.includes(WORKSHOP_MARKER), "workshop bytes never enter an export");
    assert.ok(!exported.includes(DRAFT_MARKER), "private draft bytes never enter an export");
    assert.ok(!exported.includes("Private."), "no workshop body reaches the export");
    assert.equal(backup.signaturesKey, backup.key.replace(/\.jsonl$/, ".checkpoints.json"));
    const signatures = JSON.parse(await fixtures.readBackup(backup.signaturesKey));
    const pinned = [{ key_id: CHECKPOINT_KEY_ID, public_key: CHECKPOINT_PUBLIC_KEY_HEX }];
    const offline = await verifyExportOffline({
      ndjson: exported,
      signatures,
      trustedKeys: pinned,
    });
    assert.equal(offline.ok, true, `backup verifies offline: ${JSON.stringify(offline)}`);
    const foreign = [{ key_id: CHECKPOINT_KEY_ID, public_key: "ab".repeat(32) }];
    assert.equal(
      (await verifyExportOffline({ ndjson: exported, signatures, trustedKeys: foreign })).ok,
      false,
      "an unpinned key never verifies the backup",
    );

    const scratchEvents = async () =>
      (
        await fixtures.compareRows("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?", [
          problem,
        ])
      ).scratch[0].n;
    assert.equal(await scratchEvents(), 0);

    // 2. Every refusal happens before any write.
    const missingJournal = await fixtures.restoreIntoScratch({
      key: backup.key,
      targetIdentifier: TARGET,
      journal: null,
    });
    assert.equal(missingJournal.ok, false);
    assert.match(missingJournal.message, /DELETION_JOURNAL_MISSING/);
    assert.equal((await fixtures.publishDeletionJournalTick()).published, true);
    const journal = await fixtures.fetchDeletionJournal();
    assert.ok(journal?.includes(privateDraft), "the deleted draft is journaled");
    const wrongTarget = await fixtures.restoreIntoScratch({
      key: backup.key,
      targetIdentifier: "production-d1",
      journal,
    });
    assert.equal(wrongTarget.ok, false);
    assert.match(wrongTarget.message, /RESTORE_NON_SCRATCH_TARGET_REFUSED/);
    const tampered = await fixtures.restoreIntoScratch({
      key: backup.key,
      targetIdentifier: TARGET,
      journal,
      tamper: { from: "Zero squared is even.", to: "Zero squared is odd." },
    });
    assert.equal(tampered.ok, false, "a tampered snapshot is refused");
    const badJournal = await fixtures.restoreIntoScratch({
      key: backup.key,
      targetIdentifier: TARGET,
      journal: journal.replace(privateDraft, `${privateDraft}X`),
    });
    assert.equal(badJournal.ok, false);
    assert.match(badJournal.message, /DELETION_JOURNAL_VERIFICATION_FAILED/);
    assert.equal(await scratchEvents(), 0, "refused restores wrote nothing");

    // 3. The verified restore lands only in the scratch database.
    const restored = await fixtures.restoreIntoScratch({
      key: backup.key,
      targetIdentifier: TARGET,
      journal,
    });
    assert.equal(restored.ok, true, restored.message);
    assert.equal(restored.restored, problem);
    assert.equal(restored.eventCount, backup.eventCount);

    // 4. The restored log equals the source.
    const same = async (label, query) => {
      const rows = await fixtures.compareRows(query, [problem]);
      assert.ok(rows.primary.length > 0, `${label}: the source has rows`);
      assert.deepEqual(rows.scratch, rows.primary, `${label} match`);
    };
    await same(
      "events",
      "SELECT id, seq, type, object_kind, object_id, object_version, payload_sha256, row_digest, chain_digest, created_at FROM events WHERE problem_id = ? ORDER BY seq",
    );
    await same(
      "event content",
      "SELECT c.event_id, c.payload_sha256, c.payload_json FROM event_content c JOIN events e ON e.id = c.event_id WHERE e.problem_id = ? ORDER BY e.seq",
    );
    await same("chain head", "SELECT id, chain_digest FROM problems WHERE id = ?");
    const privateInScratch = await fixtures.compareRows(
      "SELECT (SELECT COUNT(*) FROM workshop_objects) AS workshop, (SELECT COUNT(*) FROM problems WHERE id <> ?) AS other_problems",
      [problem],
    );
    assert.deepEqual(privateInScratch.scratch, [{ workshop: 0, other_problems: 0 }]);

    // 5. Running the restore again never duplicates the log.
    await fixtures.restoreIntoScratch({ key: backup.key, targetIdentifier: TARGET, journal });
    assert.equal(await scratchEvents(), backup.eventCount);

    console.log(
      JSON.stringify({
        stage: "export-restore-journey-passed",
        kind: "export-restore-real-bindings",
        status: "pass",
        events: backup.eventCount,
        boundary:
          "local Workerd/D1/R2; production backup writer into a BACKUPS bucket; deletion-safe restore into a separately migrated SCRATCH_DB; no production bucket, lifecycle rule, Time Travel or cron",
      }),
    );
  },
  { scratch: true },
);
