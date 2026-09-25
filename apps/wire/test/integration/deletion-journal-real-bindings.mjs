import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Deletion-safe restore (beads asimposiumorg-p4b / asimposiumorg-10lz) on real
// local Workerd HTTP, D1 and R2. Deletions go through the real sponsor routes;
// the journal publisher runs as one production cron tick; a point-in-time
// restore is simulated by writing the pre-deletion rows back directly, as a
// provider restore would. The replay must refuse without a valid signed
// journal and must remove every resurrected target when given one.
//
// Not covered: Cloudflare D1 Time Travel itself, the production R2 bucket,
// key provisioning, or restoring a whole database into a separate binding.

const DRAFT_TABLES = [
  ["problems", "id"],
  ["problem_statement_versions", "problem_id"],
  ["problem_memberships", "problem_id"],
  ["problem_stewards", "problem_id"],
  ["sessions", "problem_id"],
  ["workshop_objects", "problem_id"],
  ["workshop_revisions", "problem_id"],
  ["claims", "problem_id"],
];

// Workerd RPC returns proxies; copy the fields the assertions compare.
const tick = async (fixtures) => {
  const t = await fixtures.publishDeletionJournalTick();
  return { enabled: t.enabled, recordCount: t.recordCount, published: t.published };
};
const targets = async (fixtures, ndjson) =>
  Array.from(await fixtures.resurrectedTargets(ndjson), String);

async function snapshotDraft(fixtures, problemId) {
  const snapshot = [];
  for (const [table, column] of DRAFT_TABLES) {
    snapshot.push([table, await fixtures.snapshotRows(table, column, problemId)]);
  }
  return snapshot;
}

async function restoreDraft(fixtures, snapshot) {
  let rows = 0;
  for (const [table, tableRows] of snapshot) rows += await fixtures.restoreRows(table, tableRows);
  return rows;
}

async function createDraft(call, token, title) {
  const created = await call(
    "/v1/problems",
    {
      title,
      statement: "Every integer in 0..40 has a square of the same parity.",
      falsifier: "An integer in 0..40 whose square has the opposite parity.",
      motivation: "Exercise deletion-safe restore.",
      areas: ["number-theory"],
    },
    token,
    201,
  );
  return created.problem.id;
}

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, fixtures, env }) => {
  const SPONSOR = "usr_journal_sponsor";
  const author = await enroll("journal-author", SPONSOR);
  const draft = await createDraft(call, author, "Draft that will be deleted");
  const snapshot = await snapshotDraft(fixtures, draft);
  assert.equal(snapshot[0][1].length, 1, "the draft exists before deletion");

  assert.equal(await fixtures.deletionJournalRowCount(), 0);
  const idle = await tick(fixtures);
  assert.deepEqual(idle, { enabled: true, recordCount: 0, published: false });

  // 1. Real route: the deletion and its journal row commit together.
  const deleted = await sponsorCall(
    SPONSOR,
    "DELETE",
    `/v1/sponsors/problems/${draft}`,
    "delete-problem-draft",
  );
  assert.equal(deleted.deleted, true);
  assert.equal(await fixtures.deletionJournalRowCount(), 1);
  assert.equal((await fixtures.snapshotRows("problems", "id", draft)).length, 0);

  // 2. Cron publishes the signed journal to R2 once per record count.
  const published = await tick(fixtures);
  assert.deepEqual(published, { enabled: true, recordCount: 1, published: true });
  const again = await tick(fixtures);
  assert.equal(again.published, false, "a second tick rewrites nothing");
  const journal = await fixtures.fetchDeletionJournal();
  assert.ok(journal?.includes(draft), "the R2 journal names the deleted draft");
  assert.match(journal, /"signature":"[0-9a-f]{128}"/);

  // 3. A restore from a snapshot taken before the deletion brings it back.
  assert.ok((await restoreDraft(fixtures, snapshot)) >= 1);
  assert.deepEqual(await targets(fixtures, journal), [`problem:${draft}`]);

  // 4. Replay refuses before writing when the journal is missing, tampered or unsigned.
  const missing = await fixtures.replayDeletionJournal(null);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /DELETION_JOURNAL_MISSING/);
  const tampered = await fixtures.replayDeletionJournal(journal.replace(draft, `${draft}X`));
  assert.equal(tampered.ok, false);
  assert.match(tampered.message, /DELETION_JOURNAL_VERIFICATION_FAILED/);
  const unsigned = await fixtures.replayDeletionJournal(
    journal.replace(/,"key_id":"[^"]*","signature":"[0-9a-f]{128}"/, ""),
  );
  assert.equal(unsigned.ok, false);
  assert.match(unsigned.message, /journal is unsigned/);
  assert.equal(
    (await fixtures.snapshotRows("problems", "id", draft)).length,
    1,
    "a refused replay writes nothing",
  );

  // 5. The verified replay removes the resurrected draft and passes the gate.
  const replayed = await fixtures.replayDeletionJournal(journal);
  assert.equal(replayed.ok, true, replayed.message);
  assert.equal(replayed.appliedControlsCount, 1);
  assert.deepEqual(await targets(fixtures, journal), []);
  assert.equal((await fixtures.snapshotRows("problems", "id", draft)).length, 0);

  // 5b. Credential revocation is journaled in the same batch as the
  //     lifecycle event, so a pre-revocation snapshot cannot reactivate it.
  const revokedFellow = await enroll("journal-revoked-fellow", SPONSOR);
  const credential = await env.DB.prepare(
    "SELECT credential_id, fellow_id FROM fellow_tokens WHERE sponsor_id = ? AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1",
  )
    .bind(SPONSOR)
    .first();
  const before5b = await fixtures.deletionJournalRowCount();
  await sponsorCall(SPONSOR, "POST", "/v1/fellows/credentials/revoke", "fellow.credential.revoke", {
    credential_id: credential.credential_id,
    fellow_id: credential.fellow_id,
    confirm: "revoke-credential",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  assert.equal(await fixtures.deletionJournalRowCount(), before5b + 1, "revocation journaled");
  await call("/v1/hello", undefined, revokedFellow, 401);
  const revokedPublished = await tick(fixtures);
  assert.equal(revokedPublished.published, true);
  const revokedJournal = await fixtures.fetchDeletionJournal();
  assert.ok(revokedJournal.includes(`"targetId":"${credential.credential_id}"`));
  assert.ok(revokedJournal.includes('"action":"revoke-credential"'));
  const revokedReplay = await fixtures.replayDeletionJournal(revokedJournal);
  assert.equal(revokedReplay.ok, true, revokedReplay.message);

  // 5c/5d. Fellow revocation and sponsor panic journal one revoke-credential
  //        control per credential live at that moment, in the command's batch.
  const liveCredentials = async (sponsor, fellow) =>
    (
      await env.DB.prepare(
        "SELECT credential_id FROM fellow_tokens WHERE sponsor_id = ? AND revoked_at IS NULL AND (? IS NULL OR fellow_id = ?) ORDER BY credential_id",
      )
        .bind(sponsor, fellow ?? null, fellow ?? null)
        .all()
    ).results.map((row) => row.credential_id);

  const retiredFellow = await enroll("journal-retired-fellow", SPONSOR);
  const retiredRow = await env.DB.prepare(
    "SELECT fellow_id FROM fellow_tokens WHERE sponsor_id = ? AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1",
  )
    .bind(SPONSOR)
    .first();
  const retiredCredentials = await liveCredentials(SPONSOR, retiredRow.fellow_id);
  assert.ok(retiredCredentials.length >= 1);
  const before5c = await fixtures.deletionJournalRowCount();
  await sponsorCall(SPONSOR, "POST", "/v1/fellows/lifecycle", "fellow.lifecycle.change", {
    fellow_id: retiredRow.fellow_id,
    status: "revoked",
    confirm: "change-fellow-lifecycle",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  assert.equal(
    await fixtures.deletionJournalRowCount(),
    before5c + retiredCredentials.length,
    "Fellow revocation journals each live credential",
  );
  // Fellow revocation gates on Fellow status and leaves the token rows live,
  // so a restore that reverts the status would re-enable them: the journaled
  // controls re-revoke the tokens themselves on replay (checked below).
  await call("/v1/hello", undefined, retiredFellow, 401);

  const PANIC = "usr_journal_panic";
  const panicA = await enroll("journal-panic-a", PANIC);
  const panicB = await enroll("journal-panic-b", PANIC);
  const panicCredentials = await liveCredentials(PANIC);
  assert.ok(panicCredentials.length >= 2, "two Fellows, two live credentials");
  const before5d = await fixtures.deletionJournalRowCount();
  await sponsorCall(PANIC, "POST", "/v1/sponsors/panic", "sponsor.panic", {
    confirm: "revoke-all-fellow-credentials",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  assert.equal(
    await fixtures.deletionJournalRowCount(),
    before5d + panicCredentials.length,
    "panic journals every live credential of the sponsor",
  );
  await call("/v1/hello", undefined, panicA, 401);
  await call("/v1/hello", undefined, panicB, 401);
  const panicPublished = await tick(fixtures);
  assert.equal(panicPublished.published, true);
  const panicJournal = await fixtures.fetchDeletionJournal();
  for (const id of [...retiredCredentials, ...panicCredentials])
    assert.ok(panicJournal.includes(`"targetId":"${id}"`), `credential ${id} is journaled`);
  const panicReplay = await fixtures.replayDeletionJournal(panicJournal);
  assert.equal(panicReplay.ok, true, panicReplay.message);
  assert.deepEqual(await targets(fixtures, panicJournal), []);
  assert.deepEqual(await liveCredentials(SPONSOR, retiredRow.fellow_id), []);

  // 6. Account deletion: tombstone, revoked credentials and the sponsor's
  //    drafts are journaled in the same batch and replayed after a restore.
  const ACCOUNT = "usr_journal_account";
  const accountFellow = await enroll("journal-account-fellow", ACCOUNT);
  const accountDraft = await createDraft(call, accountFellow, "Account draft");
  const accountSnapshot = await snapshotDraft(fixtures, accountDraft);
  const liveTokens = await fixtures.snapshotRows("fellow_tokens", "sponsor_id", ACCOUNT);
  assert.ok(liveTokens.length >= 1);
  const beforeAccount = await fixtures.deletionJournalRowCount();
  await sponsorCall(ACCOUNT, "POST", "/v1/sponsors/account/delete", "sponsor.account.delete", {
    confirm: "delete-sponsor-account-and-revoke-all-fellows",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  const journalRecords = await fixtures.deletionJournalRowCount();
  assert.equal(journalRecords, beforeAccount + 2, "account + its draft journaled");
  await call("/v1/hello", undefined, accountFellow, 401);
  const accountPublished = await tick(fixtures);
  assert.deepEqual(accountPublished, {
    enabled: true,
    recordCount: journalRecords,
    published: true,
  });
  const accountJournal = await fixtures.fetchDeletionJournal();

  // Restore the pre-deletion state: live sponsor and the draft. Token
  // un-revocation cannot be simulated here (a D1 trigger makes revocation
  // monotonic); step 5c covers replay against a token that is still live.
  const untombstoned = await fixtures.execRaw(
    "UPDATE sponsors SET tombstoned_at = NULL WHERE sponsor_id = ?",
    [ACCOUNT],
  );
  assert.equal(untombstoned, 1);
  await restoreDraft(fixtures, accountSnapshot);
  const resurrected = await targets(fixtures, accountJournal);
  assert.ok(resurrected.includes(`sponsor:${ACCOUNT}`));
  assert.ok(!resurrected.includes(`credentials-of:${ACCOUNT}`));
  assert.ok(resurrected.includes(`problem:${accountDraft}`));

  const accountReplay = await fixtures.replayDeletionJournal(accountJournal);
  assert.equal(accountReplay.ok, true, accountReplay.message);
  assert.deepEqual(await targets(fixtures, accountJournal), []);

  console.log(
    JSON.stringify({
      stage: "deletion-journal-journey-passed",
      kind: "deletion-journal-real-bindings",
      status: "pass",
      journal_records: journalRecords,
      boundary:
        "real local Workerd/D1/R2; restore simulated by direct row writes; credential replay exercised on a Fellow-revoked live token, token un-revocation not simulated; no Time Travel or production bucket",
    }),
  );
});
