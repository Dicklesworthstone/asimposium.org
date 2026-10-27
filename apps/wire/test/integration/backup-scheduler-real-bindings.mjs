import assert from "node:assert/strict";
import { verifyExportOffline } from "../../../../scripts/verify-export.ts";
import {
  BACKUP_LEASE_MS,
  BACKUP_RUN_KEY,
  BACKUP_SIGNATURE_WAIT_MS,
} from "../../src/krater/backup-scheduler.ts";
import {
  CHECKPOINT_KEY_ID,
  CHECKPOINT_PUBLIC_KEY_HEX,
  runLocalWorkerJourney,
} from "./problem-lifecycle-real-bindings.mjs";

// Production scheduler with real Workerd, D1 and R2 conditional writes.
// The clock and abandoned lease are deliberate fault plants; cloud cron
// delivery, provider lifecycle policies and full SQL recovery are not claimed.
await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, fixtures, env, worker }) => {
  const owners = new Map();
  for (const [name, statement] of [
    ["first", "Every integer in 0..10 has a square of the same parity."],
    ["second", "Adding two even integers gives an even integer."],
  ]) {
    const sponsor = `usr_backup_${name}`;
    const fellow = await enroll(`backup-${name}`, sponsor);
    const { problem } = await call(
      "/v1/problems",
      {
        title: `${name} recoverable problem`,
        statement,
        falsifier: "A counterexample within the stated domain.",
        motivation: "Preserve a bounded, independently verifiable ledger archive.",
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
    owners.set(problem.id, sponsor);
  }
  const privateFellow = await enroll("backup-private", "usr_backup_private");
  const marker = "PRIVATE-BACKUP-EXCLUSION-91b5";
  await call(
    "/v1/problems",
    {
      title: "Never published",
      statement: `${marker}: a private exploratory statement.`,
      falsifier: "A failed private check.",
      motivation: "Keep private drafts outside ledger archives.",
      areas: ["number-theory"],
    },
    privateFellow,
    201,
  );

  const now = Date.now() + 1000;
  const date = new Date(now).toISOString().slice(0, 10);
  const readState = async () => JSON.parse(await (await env.ARTIFACTS.get(BACKUP_RUN_KEY)).text());
  const objects = async (prefix) => (await env.ARTIFACTS.list({ prefix })).objects;
  const archiveKeys = async () =>
    (await objects(`backups/${date}/`))
      .map((object) => object.key)
      .filter((key) => key.endsWith(".jsonl"))
      .sort();

  // An unsigned root cannot be published, and the prefix is durably pinned.
  const waiting = await fixtures.backupSchedulerTick(now);
  assert.equal(waiting.status, "waiting-for-signature");
  assert.equal(waiting.written, 0);
  assert.deepEqual(await archiveKeys(), []);
  const waitingState = await readState();
  const pending = waitingState.pending;
  assert.ok(pending?.id);
  const pinnedCursor = pending.cursor;
  await sponsorCall(
    owners.get(pending.id),
    "POST",
    `/v1/sponsors/problems/${pending.id}/lifecycle`,
    "problem-lifecycle",
    { action: "set-writer-cap", writer_cap: 7 },
  );
  assert.ok(
    (
      await env.DB.prepare("SELECT public_seq AS n FROM problems WHERE id = ?")
        .bind(pending.id)
        .first()
    ).n > pinnedCursor,
  );
  await fixtures.signCheckpointsTick();

  // Simultaneous real R2 etag acquisitions have one winner. Neither call can
  // consume two problems or advance over the other worker's cursor.
  const competing = await fixtures.raceBackupSchedulerTicks(now + 1000);
  assert.equal(competing.filter((tick) => tick.status === "advanced").length, 1);
  assert.equal(competing.filter((tick) => tick.status === "busy").length, 1);
  const first = await readState();
  assert.equal(first.after, pending.id);
  assert.equal(first.written, 1);
  assert.equal(first.pending, null);
  const [key] = await archiveKeys();
  const body = await (await env.ARTIFACTS.get(key)).text();
  const signatures = JSON.parse(
    await (await env.ARTIFACTS.get(key.replace(/\.jsonl$/, ".checkpoints.json"))).text(),
  );
  const verified = await verifyExportOffline({
    ndjson: body,
    signatures,
    trustedKeys: [{ key_id: CHECKPOINT_KEY_ID, public_key: CHECKPOINT_PUBLIC_KEY_HEX }],
  });
  assert.equal(verified.ok, true, JSON.stringify(verified.failures));
  assert.equal(
    signatures.signatures[0].checkpoint_seq,
    pinnedCursor,
    "new appends cannot move the prefix while it waits for signing",
  );
  assert.ok(!body.includes(marker));
  assert.equal((await objects("backups/")).length > 0, true);
  assert.deepEqual((await env.PUBLIC_ARTIFACTS.list({ prefix: "backups/" })).objects, []);

  // Plant an abandoned but unexpired lease. Only its expiry authorizes a
  // different tick to recover, then the second problem is archived once.
  const stranded = {
    ...first,
    lease: { owner: crypto.randomUUID(), expiresAt: now + BACKUP_LEASE_MS },
  };
  await env.ARTIFACTS.put(BACKUP_RUN_KEY, JSON.stringify(stranded));
  assert.equal((await fixtures.backupSchedulerTick(now + 2000)).status, "busy");
  const recovered = await fixtures.backupSchedulerTick(now + BACKUP_LEASE_MS + 1);
  assert.equal(recovered.status, "advanced");
  assert.equal(recovered.totalWritten, 2);
  const beforeReplay = await archiveKeys();

  // Crash after archive publication but before cursor advance: retain the
  // prior cursor and expired lease while leaving the R2 objects in place.
  await env.ARTIFACTS.put(BACKUP_RUN_KEY, JSON.stringify(stranded));
  const replayed = await fixtures.backupSchedulerTick(now + BACKUP_LEASE_MS + 2);
  assert.equal(replayed.totalWritten, 2, "replayed archive is not double-counted");
  assert.deepEqual(await archiveKeys(), beforeReplay, "retries reuse content-addressed archives");
  const complete = await fixtures.backupSchedulerTick(now + BACKUP_LEASE_MS + 3);
  assert.equal(complete.status, "complete");
  assert.equal(complete.totalFailed, 0);
  const finishedState = await readState();
  assert.equal(finishedState.written, 2, "private drafts are outside the captured sweep");
  const report = JSON.parse(await (await env.ARTIFACTS.get(finishedState.reportKey)).text());
  assert.equal(report.status, "complete");
  assert.equal(report.scope, "published-problem-ledger-only");
  const finishedKeys = (await objects("backups/")).map((object) => object.key).sort();
  assert.equal((await fixtures.backupSchedulerTick(now + BACKUP_LEASE_MS + 4)).status, "complete");
  assert.deepEqual(
    (await objects("backups/")).map((object) => object.key).sort(),
    finishedKeys,
    "a completed daily run does not keep exporting on each five-minute tick",
  );

  // Exercise the deployed entrypoint as a scheduled event, not just the helper.
  assert.equal((await worker.scheduled({ cron: "*/5 * * * *" })).outcome, "ok");

  // A real content redaction makes a whole-content archive unavailable. The
  // next daily sweep records failure and still archives the other problem;
  // it must never call that run complete or leak the old bytes into a new file.
  const redacted = await env.DB.prepare(
    "SELECT id FROM events WHERE problem_id = ? ORDER BY seq LIMIT 1",
  )
    .bind(pending.id)
    .first();
  await fixtures.redactPublicContent(redacted.id);
  const tomorrow = now + 24 * 60 * 60 * 1000;
  const nextDate = new Date(tomorrow).toISOString().slice(0, 10);
  const failed = await fixtures.backupSchedulerTick(tomorrow);
  assert.equal(failed.status, "advanced");
  assert.equal(failed.failed, 1);
  assert.equal(failed.totalFailed, 1);
  const continued = await fixtures.backupSchedulerTick(tomorrow + 1000);
  assert.equal(continued.written, 1, "a failed problem does not starve other backups");
  const incomplete = await fixtures.backupSchedulerTick(tomorrow + 2000);
  assert.equal(incomplete.status, "incomplete");
  assert.deepEqual(
    await objects(`backups/${nextDate}/${pending.id}/`),
    [],
    "no partial or redacted-payload archive was published",
  );

  // A corrupt progress marker is refused, never reset to a false empty run.
  const durable = await (await env.ARTIFACTS.get(BACKUP_RUN_KEY)).text();
  await env.ARTIFACTS.put(BACKUP_RUN_KEY, '{"version":99}');
  await assert.rejects(
    async () => await fixtures.backupSchedulerTick(tomorrow + 3000),
    /BACKUP_RUN_STATE_INVALID/,
  );
  await env.ARTIFACTS.put(BACKUP_RUN_KEY, durable);

  // An unsigned scope cannot hold the entire sweep forever. No signer tick
  // runs after this new publication; advance only the scheduler's real clock.
  const unsignedProblem = (
    await call(
      "/v1/problems",
      {
        title: "Unsigned residue problem",
        statement: "The residue of n modulo three equals the residue of n plus three.",
        falsifier: "An integer whose residue changes on adding three.",
        motivation: "An unavailable signature must not starve other archives.",
        areas: ["number-theory"],
      },
      privateFellow,
      201,
    )
  ).problem.id;
  await sponsorCall(
    "usr_backup_private",
    "POST",
    `/v1/sponsors/problems/${unsignedProblem}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
  );
  let waitingAt = tomorrow + 24 * 60 * 60 * 1000;
  let unsignedWait;
  for (let tick = 0; tick < 3; tick++) {
    unsignedWait = await fixtures.backupSchedulerTick(waitingAt);
    if (unsignedWait.status === "waiting-for-signature") break;
    assert.equal(unsignedWait.status, "advanced");
    waitingAt += 1000;
  }
  assert.equal(unsignedWait.status, "waiting-for-signature");
  const unsignedState = await readState();
  assert.equal(unsignedState.pending.id, unsignedProblem);
  assert.equal(unsignedState.pending.waitingSince, waitingAt);
  assert.equal(
    (await fixtures.backupSchedulerTick(waitingAt + BACKUP_SIGNATURE_WAIT_MS - 1)).status,
    "waiting-for-signature",
  );
  assert.equal(
    (await readState()).pending.waitingSince,
    waitingAt,
    "a retry cannot reset the durable signature deadline",
  );
  const expiredWait = await fixtures.backupSchedulerTick(waitingAt + BACKUP_SIGNATURE_WAIT_MS);
  assert.equal(expiredWait.status, "advanced");
  assert.equal(expiredWait.failed, 1);
  const unsignedReceipts = await objects(
    `backups/receipts/${unsignedState.date}/${unsignedProblem}/`,
  );
  assert.equal(unsignedReceipts.length, 1);
  const timeoutReceipt = JSON.parse(
    await (await env.ARTIFACTS.get(unsignedReceipts[0].key)).text(),
  );
  assert.equal(timeoutReceipt.code, "BACKUP_SIGNATURE_UNAVAILABLE");
  let drained;
  for (let tick = 0; tick < 4; tick++) {
    drained = await fixtures.backupSchedulerTick(waitingAt + BACKUP_SIGNATURE_WAIT_MS + tick + 1);
    if (drained.status === "incomplete") break;
    assert.equal(drained.status, "advanced");
  }
  assert.equal(drained.status, "incomplete");
  assert.equal(drained.totalWritten, 1);
  assert.equal(
    drained.totalFailed,
    2,
    "redacted and permanently unsigned scopes remain explicit failures",
  );
  assert.deepEqual(await objects(`backups/${unsignedState.date}/${unsignedProblem}/`), []);
  assert.deepEqual((await env.PUBLIC_ARTIFACTS.list({ prefix: "backups/" })).objects, []);
  console.log(
    JSON.stringify({
      kind: "backup-scheduler-real-bindings",
      status: "pass",
      conditional_lease: "real-R2",
      signed_archive: true,
      interrupted_resume: true,
      failure_does_not_skip_other_scopes: true,
      signature_wait_is_bounded: true,
      boundary: "local Workerd/D1/R2; no cloud cron or bucket-lifecycle claim",
    }),
  );
});
