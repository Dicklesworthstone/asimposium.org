import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Scheduled security-record expiry (bead asimposiumorg-p4b retention) on real
// local Workerd/D1, run as one production cron tick. It must remove expired
// nonces, keep append-only proposal history, keep every live nonce (nonces
// are epoch SECONDS; a milliseconds comparison would delete them all and
// reopen the signed-envelope replay window), and leave sponsor writes working.

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, fixtures, env }) => {
  const SPONSOR = "usr_retention_sponsor";
  await enroll("retention-fellow", SPONSOR);
  // A signed sponsor call records a live nonce.
  await sponsorCall(SPONSOR, "GET", "/v1/sponsors/account/export", "sponsor.account.export");
  const nowS = Math.floor(Date.now() / 1000);
  const liveBefore = Number(
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_envelope_nonces WHERE expires_at > ?")
        .bind(nowS)
        .first()
    ).n,
  );
  assert.ok(liveBefore >= 1, "a live nonce exists");
  await env.DB.prepare(
    "INSERT INTO auth_envelope_nonces (nonce_hash, expires_at, claimed_at) VALUES (?, ?, ?)",
  )
    .bind("e".repeat(64), nowS - 5, nowS - 65)
    .run();

  // A claimed, never-approved proposal: append-only history the sweep must
  // not try to delete (a trigger forbids it and would abort the batch).
  const minted = await fixtures.mint(SPONSOR);
  await call(
    "/v1/fellows",
    {
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "retention-unapproved",
      model: "synthetic-problem-model",
      harness: "local-problem-lifecycle-proof",
    },
    undefined,
    202,
  );
  await fixtures.execRaw(
    "UPDATE enrollment_proposals SET status = 'denied' WHERE enrollment_id = ? AND status = 'pending'",
    [minted.enrollmentId],
  );

  const tick = await fixtures.expireSecurityTick();
  assert.ok(Number(tick.expiredNonces) >= 1, "the expired nonce is removed");
  const liveAfter = Number(
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_envelope_nonces WHERE expires_at > ?")
        .bind(nowS)
        .first()
    ).n,
  );
  assert.equal(liveAfter, liveBefore, "every live nonce survives the sweep");
  assert.equal(
    Number(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM enrollment_proposals WHERE enrollment_id = ?",
        )
          .bind(minted.enrollmentId)
          .first()
      ).n,
    ),
    1,
    "proposal history is kept",
  );
  // Approved enrollments and sponsor writes are untouched.
  await sponsorCall(SPONSOR, "GET", "/v1/sponsors/account/export", "sponsor.account.export");

  console.log(
    JSON.stringify({
      stage: "security-retention-journey-passed",
      kind: "security-retention-real-bindings",
      status: "pass",
      boundary: "real local Workerd/D1; one cron tick; no provider schedule",
    }),
  );
});
