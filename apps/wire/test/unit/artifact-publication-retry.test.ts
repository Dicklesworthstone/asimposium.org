import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  ArtifactPublicationRetryReceiptSchema,
  ArtifactPublicationStatusSchema,
} from "@asimposium/contracts/artifact-publications";
import { deliverArtifactPublication } from "../../src/krater/artifact-publication-outbox.ts";
import { retryArtifactPublication } from "../../src/krater/artifact-publication-retry.ts";
import {
  publicationStatus,
  readPublicationJob,
  requestArtifactPublication,
} from "../../src/krater/artifact-publication-store.ts";
import { readArtifactManifest } from "../../src/krater/artifact-store.ts";
import { publicationFixture } from "./artifact-publication-fixture.ts";

type Fixture = Awaited<ReturnType<typeof queued>>;
function control(
  f: Awaited<ReturnType<typeof publicationFixture>>,
  target = f.targetId,
  visibility = "hidden",
) {
  f.sql
    .query(`INSERT INTO content_controls SELECT ?,?,?,COALESCE(MAX(version),0)+1
    FROM content_controls WHERE problem_id=? AND target_ref=?`)
    .run(f.problem, target, visibility, f.problem, target);
}
async function queued(kind: "claim" | "hypothesis" = "claim") {
  const f = await publicationFixture(kind);
  const receipt = await requestArtifactPublication(
    f.options,
    f.actor,
    f.upload,
    f.input,
    "publish",
  );
  const options = {
    ...f.options,
    readUpload: (owner: typeof f.actor, id: string, at: number) =>
      readArtifactManifest(f.db, owner, id, at),
  };
  const retryInput = { session_id: f.session, expected_retry_generation: 0 };
  return { ...f, id: receipt.publication_id, receipt, options, retryInput };
}
async function held(kind: "claim" | "hypothesis" = "claim") {
  const f = await queued(kind);
  control(f);
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "held");
  control(f, f.targetId, "visible");
  f.advance(1);
  return f;
}
const job = async (f: Fixture) => {
  const row = await readPublicationJob(f.db, f.id);
  assert.ok(row);
  return row;
};
const retry = (f: Fixture, key = "recover", generation = 0) =>
  retryArtifactPublication(
    f.options,
    f.actor,
    f.id,
    { ...f.retryInput, expected_retry_generation: generation },
    key,
  );
const publishedRows = (f: Fixture) =>
  f.sql.query("SELECT * FROM artifact_publications ORDER BY publication_id").all();
const oldAudit = (f: Fixture) =>
  f.sql.query("SELECT * FROM artifact_publication_audit ORDER BY seq").all();
const recoveryAudit = (f: Fixture) =>
  f.sql
    .query(
      "SELECT retry_generation,state,screen_attempts FROM artifact_publication_retry_audit ORDER BY seq",
    )
    .all();
const unchanged = (f: Fixture) => ({
  publications: publishedRows(f),
  events: f.sql.query("SELECT * FROM events ORDER BY seq").all(),
  reservations: f.sql.query("SELECT * FROM public_write_attempt_reservations").all(),
  cursor: f.sql.query("SELECT * FROM public_cursor").all(),
});

for (const kind of ["claim", "hypothesis"] as const) {
  test(`${kind} source restoration requeues the same consent, then publishes with the original quota`, async () => {
    const f = await held(kind),
      before = unchanged(f),
      audit = oldAudit(f),
      heldJob = await job(f);
    const action = ArtifactPublicationStatusSchema.parse(publicationStatus(heldJob));
    assert.equal(action.delivery, "held");
    assert.deepEqual(action.recovery, {
      retry_path: `/v1/artifact-publications/${f.id}/retry`,
      expected_retry_generation: 0,
    });
    const accepted = ArtifactPublicationRetryReceiptSchema.parse(await retry(f));
    assert.equal(accepted.publication_id, f.id);
    assert.equal(accepted.retry_generation, 1);
    assert.deepEqual(unchanged(f), before);
    assert.deepEqual(oldAudit(f), audit);
    const requeued = await job(f);
    assert.equal(requeued.state, "queued");
    assert.equal(requeued.attempts, heldJob.attempts);
    assert.equal(requeued.screen_attempts, 0);
    assert.equal(requeued.last_screen_json, heldJob.last_screen_json);
    assert.equal(publicationStatus(requeued).recovery, null);
    assert.equal(await deliverArtifactPublication(f.drainer, f.id), "published");
    assert.equal(f.screens(), 1);
    assert.equal(f.reservations(), 1);
    assert.equal(f.count("artifact_publications"), 1);
    assert.deepEqual(publishedRows(f), before.publications);
    assert.deepEqual(recoveryAudit(f), [
      { retry_generation: 1, state: "queued", screen_attempts: 0 },
      { retry_generation: 1, state: "release-authorized", screen_attempts: 1 },
      { retry_generation: 1, state: "published", screen_attempts: 1 },
    ]);
    assert.deepEqual(await retry(f), accepted);
    assert.equal(f.count("artifact_publication_retries"), 1);
  });
}

test("thirty identical recovery requests share one immutable generation and receipt", async () => {
  const f = await held();
  const receipts = await Promise.all(Array.from({ length: 30 }, () => retry(f)));
  assert.equal(new Set(receipts.map((receipt) => JSON.stringify(receipt))).size, 1);
  assert.equal(f.count("artifact_publication_retries"), 1);
  assert.equal((await job(f)).retry_generation, 1);
  assert.equal(f.screens(), 0);
  assert.equal(f.reservations(), 1);
});

test("competing keys cannot consume the same recovery generation", async () => {
  const f = await held();
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) => retry(f, `recovery-${i}`)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results) if (r.status === "rejected") assert.equal(r.reason.code, "CONFLICT");
  assert.equal(f.count("artifact_publication_retries"), 1);
  assert.equal(f.count("artifact_publication_retry_audit"), 1);
});

test("an old key replays after another hold while a new key with the old generation refuses", async () => {
  const f = await held(),
    receipt = await retry(f);
  control(f);
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "held");
  control(f, f.targetId, "visible");
  f.advance(1);
  assert.deepEqual(await retry(f), receipt);
  await assert.rejects(() => retry(f, "stale", 0), { code: "CONFLICT" });
  const next = await retry(f, "next", 1);
  assert.equal(next.retry_generation, 2);
  assert.deepEqual(recoveryAudit(f), [
    { retry_generation: 1, state: "queued", screen_attempts: 0 },
    { retry_generation: 1, state: "held", screen_attempts: 0 },
    { retry_generation: 2, state: "queued", screen_attempts: 0 },
  ]);
  await assert.rejects(
    () =>
      retryArtifactPublication(
        f.options,
        f.actor,
        f.id,
        { ...f.retryInput, session_id: `S-${"B".repeat(26)}` },
        "recover",
      ),
    { code: "CONFLICT" },
  );
});

test("eight recoveries bound receipt storage even when no paid screen was consumed", async () => {
  const f = await held(),
    originalAudit = oldAudit(f);
  for (let generation = 0; generation < 8; generation++) {
    assert.equal(
      (await retry(f, `retry-${generation}`, generation)).retry_generation,
      generation + 1,
    );
    control(f);
    assert.equal(await deliverArtifactPublication(f.drainer, f.id), "held");
    control(f, f.targetId, "visible");
    f.advance(1);
  }
  const capped = await job(f);
  assert.equal(capped.retry_generation, 8);
  assert.equal(capped.screen_attempts, 0);
  assert.equal(publicationStatus(capped).recovery, null);
  await assert.rejects(() => retry(f, "beyond-limit", 7), { code: "CONFLICT" });
  assert.equal(f.count("artifact_publication_retries"), 8);
  assert.equal(f.count("artifact_publication_retry_audit"), 16);
  assert.deepEqual(oldAudit(f), originalAudit);
  assert.equal(f.reservations(), 1);
});

test("retry retains previous provider receipt and paid attempts", async () => {
  const f = await queued();
  assert.equal(
    await deliverArtifactPublication(
      {
        ...f.drainer,
        screen: async (...args) => ({
          ...(await f.drainer.screen(...args)),
          decision: "quarantine",
          provider_status: "timeout",
        }),
      },
      f.id,
    ),
    "retry",
  );
  f.advance(60_000);
  control(f);
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "held");
  control(f, f.targetId, "visible");
  f.advance(1);
  const before = await job(f);
  assert.equal(before.screen_attempts, 1);
  assert.ok(before.last_screen_json);
  await retry(f);
  const after = await job(f);
  assert.equal(after.last_screen_json, before.last_screen_json);
  assert.equal(after.screen_attempts, before.screen_attempts);
  assert.equal(after.attempts, before.attempts);
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "published");
  assert.equal(f.screens(), 2);
  assert.equal(f.reservations(), 1);
});

test("three screens consumed by source races cannot be replenished", async () => {
  const f = await held();
  for (let generation = 0; generation < 3; generation++) {
    await retry(f, `retry-${generation}`, generation);
    const options = {
      ...f.drainer,
      screen: async (...args: Parameters<typeof f.drainer.screen>) => {
        const result = await f.drainer.screen(...args);
        control(f);
        return result;
      },
    };
    assert.equal(await deliverArtifactPublication(options, f.id), "held");
    control(f, f.targetId, "visible");
    f.advance(1);
  }
  const exhausted = await job(f);
  assert.equal(exhausted.failure_code, "binding-unavailable");
  assert.equal(exhausted.screen_attempts, 3);
  assert.equal(publicationStatus(exhausted).recovery, null);
  await assert.rejects(() => retry(f, "exhausted", 3), { code: "CONFLICT" });
  assert.equal(f.screens(), 3);
  assert.equal(f.publicStore.writes(), 0);
});

for (const decision of ["reject", "quarantine", "allow-with-warning"] as const) {
  test(`${decision} policy holds cannot be retried or relabeled`, async () => {
    const f = await queued();
    assert.equal(
      await deliverArtifactPublication(
        {
          ...f.drainer,
          screen: async (...args) => ({
            ...(await f.drainer.screen(...args)),
            decision,
          }),
        },
        f.id,
      ),
      "held",
    );
    const before = await job(f);
    assert.equal(publicationStatus(before).recovery, null);
    await assert.rejects(() => retry(f), { code: "CONFLICT" });
    assert.deepEqual(await job(f), before);
    assert.equal(f.count("artifact_publication_retries"), 0);
    assert.throws(() =>
      f.sql.exec("UPDATE artifact_publication_jobs SET failure_code='binding-unavailable'"),
    );
  });
}

test("content errors and already authorized/public jobs never acquire recovery authority", async () => {
  const bad = await queued();
  // Seed the valid durable outbox error state. This unit checks recovery
  // admission; full byte-inspection behavior has its own production tests.
  bad.sql.exec(
    "UPDATE artifact_publication_jobs SET state='held',failure_code='content-unavailable'",
  );
  assert.equal((await job(bad)).failure_code, "content-unavailable");
  await assert.rejects(() => retry(bad), { code: "CONFLICT" });
  const f = await queued();
  f.publicStore.hooks.put = () => {
    throw new Error("storage-outage");
  };
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "retry");
  const released = await job(f);
  assert.equal(released.state, "release-authorized");
  await assert.rejects(() => retry(f), { code: "CONFLICT" });
  assert.deepEqual(await job(f), released);
  f.publicStore.hooks.put = undefined;
  f.advance(60_000);
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "published");
  const published = await job(f);
  await assert.rejects(() => retry(f), { code: "CONFLICT" });
  assert.deepEqual(await job(f), published);
  assert.equal(f.count("artifact_publication_retries"), 0);
  assert.equal(f.screens(), 1);
});

for (const mutation of ["source-hide", "publication-hide", "source-bytes", "withdrawal"] as const) {
  test(`a late ${mutation} prevents requeue and retry receipt together`, async () => {
    const f = await held(),
      before = await job(f);
    f.hooks.beforeRun = (sql) => {
      if (!sql.startsWith("INSERT INTO artifact_publication_retries")) return;
      if (mutation === "source-hide") control(f, `${f.targetId}@1`);
      if (mutation === "publication-hide") control(f, f.id);
      if (mutation === "source-bytes")
        f.sql
          .query("UPDATE event_content SET payload_json='{}' WHERE event_id=?")
          .run(f.targetEvent);
      if (mutation === "withdrawal")
        f.sql.query("INSERT INTO scientific_withdrawals VALUES('EV-1')").run();
    };
    await assert.rejects(() => retry(f), { code: "CONFLICT" });
    assert.deepEqual(await job(f), before);
    assert.equal(f.count("artifact_publication_retries"), 0);
    assert.equal(f.count("artifact_publication_retry_audit"), 0);
    assert.equal(f.reservations(), 1);
  });
}

for (const mutation of [
  "membership",
  "session",
  "revocation",
  "grant-scope",
  "grant-binding",
  "grant-expiry",
  "panic",
  "grant-shape",
] as const) {
  test(`D1 refuses a late ${mutation} change without receipt or state drift`, async () => {
    const f = await held(),
      before = await job(f);
    f.hooks.beforeRun = (sql) => {
      if (!sql.startsWith("INSERT INTO artifact_publication_retries")) return;
      if (mutation === "membership") f.sql.exec("UPDATE problem_memberships SET role='none'");
      if (mutation === "session")
        f.sql.query("UPDATE sessions SET closed_at=?").run(new Date(f.clock()).toISOString());
      if (mutation === "revocation")
        f.sql.query("UPDATE fellow_tokens SET revoked_at=?").run(f.clock());
      if (mutation === "grant-scope")
        f.sql.exec("UPDATE enrollment_grants SET granted_scopes_json='[]'");
      if (mutation === "grant-binding")
        f.sql.exec(
          `UPDATE enrollment_grants SET granted_resources_json='{"problemBinding":"P-OTHER"}'`,
        );
      if (mutation === "grant-expiry")
        f.sql.query("UPDATE fellow_tokens SET expires_at=?").run(f.clock());
      if (mutation === "panic")
        f.sql
          .query("INSERT INTO enrollment_sponsor_security VALUES(?,?)")
          .run(f.actor.sponsorId, f.clock());
      if (mutation === "grant-shape") {
        f.sql.exec("UPDATE enrollment_grants SET granted_resources_json='[]'");
        f.sql.exec("UPDATE fellow_tokens SET granted_resources_json='[]'");
      }
    };
    await assert.rejects(() => retry(f), { code: "CONFLICT" });
    assert.deepEqual(await job(f), before);
    assert.equal(f.count("artifact_publication_retries"), 0);
    assert.equal(f.count("artifact_publication_retry_audit"), 0);
  });
}

test("an owner may use a new session and replay after its closure and eventual publication", async () => {
  const f = await held(),
    next = `S-${"B".repeat(26)}`;
  f.sql.query("UPDATE sessions SET closed_at=?").run(new Date(f.clock()).toISOString());
  f.sql
    .query("INSERT INTO sessions VALUES(?,?,?,?,?,NULL)")
    .run(
      next,
      f.actor.fellowId,
      f.problem,
      new Date(f.clock()).toISOString(),
      new Date(f.clock() + 3_600_000).toISOString(),
    );
  const input = { ...f.retryInput, session_id: next };
  const accepted = await retryArtifactPublication(f.options, f.actor, f.id, input, "new-session");
  f.sql.query("UPDATE sessions SET closed_at=?").run(new Date(f.clock()).toISOString());
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "published");
  assert.deepEqual(
    await retryArtifactPublication(f.options, f.actor, f.id, input, "new-session"),
    accepted,
  );
  assert.equal((await job(f)).session_id, f.session);
});

for (const mutation of ["membership", "revocation"] as const) {
  test(`receipt replay rechecks current owner access after an asynchronous ${mutation} loss`, async () => {
    const f = await held();
    await retry(f);
    const before = await job(f);
    f.hooks.afterRead = (sql) => {
      if (!sql.includes("FROM artifact_publication_retries r")) return;
      if (mutation === "membership")
        f.sql.query("UPDATE problem_memberships SET fellow_id='removed'").run();
      else f.sql.query("UPDATE fellow_tokens SET revoked_at=?").run(f.clock());
    };
    await assert.rejects(() => retry(f), { code: "NOT_FOUND" });
    assert.deepEqual(await job(f), before);
    assert.equal(f.count("artifact_publication_retries"), 1);
  });
}

test("at-budget recovery keeps the original event and byte totals", async () => {
  const f = await held(),
    usage = { eventBudget: f.count("events"), artifactBudgetBytes: f.bytes.length };
  const resources = JSON.stringify(usage);
  f.sql.query("UPDATE enrollment_grants SET granted_resources_json=?").run(resources);
  f.sql.query("UPDATE fellow_tokens SET granted_resources_json=?").run(resources);
  const owner = { ...f.actor, grantedResources: usage };
  const before = unchanged(f);
  await retryArtifactPublication(f.options, owner, f.id, f.retryInput, "at-budget");
  assert.deepEqual(unchanged(f), before);
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "published");
  assert.equal(f.reservations(), 1);
});

test("the retry receipt and both generations of audit history cannot be changed or removed", async () => {
  const f = await held();
  await retry(f);
  for (const statement of [
    "UPDATE artifact_publication_retries SET prior_screen_attempts=2",
    "DELETE FROM artifact_publication_retries",
    "UPDATE artifact_publication_retry_audit SET screen_attempts=2",
    "DELETE FROM artifact_publication_retry_audit",
    "UPDATE artifact_publication_audit SET state='changed'",
    "DELETE FROM artifact_publication_audit",
    "UPDATE artifact_publication_jobs SET retry_generation=0",
  ])
    assert.throws(() => f.sql.exec(statement));
  assert.equal(f.count("artifact_publication_retries"), 1);
});
