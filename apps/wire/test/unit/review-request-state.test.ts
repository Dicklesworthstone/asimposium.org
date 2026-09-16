import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  effectiveReviewRequestStatus,
  REVIEW_ACCEPTED_MS,
  REVIEW_OFFER_MS,
  transitionReviewRequest,
} from "../../src/review-requests/model.ts";

const now = 1_800_000_000_000;
const offered = {
  version: 1,
  status: "offered" as const,
  occurred_at: now,
  expires_at: now + REVIEW_OFFER_MS,
};

test("an offer expires at the exact boundary without pretending a transition was recorded", () => {
  assert.equal(effectiveReviewRequestStatus(offered, offered.expires_at - 1), "offered");
  assert.equal(effectiveReviewRequestStatus(offered, offered.expires_at), "expired");
  assert.equal(offered.status, "offered");
});
test("recipient accepts once; accepting does not award a scientific tier", () => {
  assert.deepEqual(transitionReviewRequest(offered, "accept", 1, "reviewer", now + 1), {
    version: 2,
    status: "accepted",
    occurred_at: now + 1,
    expires_at: now + 1 + REVIEW_ACCEPTED_MS,
  });
});
for (const [action, participant] of [
  ["accept", "author"],
  ["decline", "author"],
  ["cancel", "reviewer"],
  ["complete", "author"],
] as const) {
  test(`${participant} cannot ${action} somebody else's role`, () => {
    assert.throws(() => transitionReviewRequest(offered, action, 1, participant, now + 1));
  });
}
test("stale versions and backward clocks cannot change request state", () => {
  assert.throws(() => transitionReviewRequest(offered, "accept", 2, "reviewer", now + 1));
  assert.throws(() => transitionReviewRequest(offered, "accept", 1, "reviewer", now - 1));
  assert.throws(() =>
    transitionReviewRequest(offered, "accept", 1, "reviewer", offered.expires_at),
  );
});
test("late opt-out is allowed, but terminal requests cannot be revived", () => {
  const declined = transitionReviewRequest(
    offered,
    "decline",
    1,
    "reviewer",
    offered.expires_at + 1,
  );
  assert.equal(declined.status, "declined");
  assert.throws(() =>
    transitionReviewRequest(declined, "accept", 2, "reviewer", declined.occurred_at),
  );
});
function fixture() {
  const db = new Database(":memory:");
  db.run(`PRAGMA foreign_keys=ON;
    CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER);
    CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, object_id TEXT, type TEXT, object_kind TEXT, actor_fellow_id TEXT);
    CREATE TABLE reviews(review_id TEXT, source_event_id TEXT, problem_id TEXT, source_seq INTEGER, target_claim_id TEXT, target_version INTEGER, reviewer_fellow_id TEXT);
    INSERT INTO problems VALUES ('P-DEMO',10);
    INSERT INTO enrollment_fellows VALUES ('author'),('reviewer'),('stranger');
    INSERT INTO events VALUES ('claim-event','P-DEMO',1,'C-1','claim.created','claim','author');`);
  db.run(
    readFileSync(
      new URL("../../../../db/migrations/0065_review_requests.sql", import.meta.url),
      "utf8",
    ),
  );
  db.query(`INSERT INTO review_requests(request_id,problem_id,claim_id,claim_version,claim_event_id,claim_payload_sha256,author_id,author_sponsor_id,reviewer_id,reviewer_sponsor_id,created_at)
    VALUES('RR-demo','P-DEMO','C-1',1,'claim-event','digest','author','usr_author','reviewer','usr_other',?)`).run(
    now,
  );
  const append = (
    version: number,
    action: string,
    actor = "reviewer",
    at = now + version,
    expiry = now + REVIEW_OFFER_MS,
    review: string | null = null,
  ) =>
    db
      .query("INSERT INTO review_request_events VALUES(?, 'RR-demo', ?, ?, ?, ?, ?, ?, 1)")
      .run(`request-event-${version}`, version, action, actor, at, expiry, review);
  append(1, "offer", "author", now);
  return { db, append };
}
test("SQLite enforces actor, legal transition and compare-and-swap independently of TypeScript", () => {
  const { db, append } = fixture();
  try {
    assert.throws(() => append(2, "accept", "author"));
    assert.throws(() => append(3, "accept"));
    append(2, "accept", "reviewer", now + 2, now + 2 + REVIEW_ACCEPTED_MS);
    assert.throws(() => append(2, "decline"));
    assert.throws(() => append(3, "accept", "reviewer", now + 3, now + 3 + REVIEW_ACCEPTED_MS));
    assert.equal(
      (db.query("SELECT COUNT(*) n FROM review_request_events").get() as { n: number }).n,
      2,
    );
    assert.equal(
      (db.query("SELECT public_seq FROM problems").get() as { public_seq: number }).public_seq,
      10,
    );
  } finally {
    db.close();
  }
});
test("SQLite preserves immutable request identities and audit history", () => {
  const { db } = fixture();
  try {
    for (const sql of [
      "UPDATE review_requests SET claim_version=2",
      "DELETE FROM review_requests",
      "UPDATE review_request_events SET actor_id='stranger'",
      "DELETE FROM review_request_events",
      "INSERT OR REPLACE INTO review_request_events SELECT * FROM review_request_events",
    ]) {
      assert.throws(() => db.run(sql));
    }
  } finally {
    db.close();
  }
});
test("SQLite refuses expiry bypass and duplicate invitations after a decline", () => {
  const { db, append } = fixture();
  try {
    assert.throws(() =>
      append(2, "accept", "reviewer", offered.expires_at, offered.expires_at + REVIEW_ACCEPTED_MS),
    );
    append(2, "decline", "reviewer", offered.expires_at);
    assert.throws(() =>
      db.run(`INSERT INTO review_requests(request_id,problem_id,claim_id,claim_version,claim_event_id,claim_payload_sha256,author_id,author_sponsor_id,reviewer_id,reviewer_sponsor_id,created_at)
      SELECT 'RR-again',problem_id,claim_id,claim_version,claim_event_id,claim_payload_sha256,author_id,author_sponsor_id,reviewer_id,reviewer_sponsor_id,created_at FROM review_requests`),
    );
  } finally {
    db.close();
  }
});
test("completion requires the recipient's exact-version committed review, not a status assertion", () => {
  const { db, append } = fixture();
  try {
    const expiry = now + 2 + REVIEW_ACCEPTED_MS;
    append(2, "accept", "reviewer", now + 2, expiry);
    db.run(`INSERT INTO events VALUES ('review-event','P-DEMO',2,'R-1','review.created','review','reviewer');
      INSERT INTO reviews VALUES ('R-1','review-event','P-DEMO',2,'C-1',2,'reviewer');`);
    assert.throws(() => append(3, "complete", "reviewer", now + 3, expiry, "review-event"));
    db.run("UPDATE reviews SET target_version=1");
    append(3, "complete", "reviewer", now + 3, expiry, "review-event");
    assert.equal(
      (
        db
          .query("SELECT action FROM review_request_events ORDER BY version DESC LIMIT 1")
          .get() as { action: string }
      ).action,
      "complete",
    );
  } finally {
    db.close();
  }
});
test("a replay collision rolls back both a transition and its notice", () => {
  const { db, append } = fixture();
  try {
    db.run("CREATE TABLE notices(id TEXT PRIMARY KEY)");
    db.query(
      "INSERT INTO review_request_replays VALUES('reviewer','same','original','ciphertext','iv',?)",
    ).run(now + 86400000);
    db.run("BEGIN");
    try {
      append(2, "decline");
      db.run("INSERT INTO notices VALUES('notice')");
      db.run(`INSERT INTO review_request_replays VALUES('reviewer','same','different','other','iv',${now + 86400000})
        ON CONFLICT(fellow_id,idempotency_key) DO UPDATE SET request_digest=NULL`);
      assert.fail("collision must abort");
    } catch {
      db.run("ROLLBACK");
    }
    assert.equal(
      (db.query("SELECT COUNT(*) n FROM review_request_events").get() as { n: number }).n,
      1,
    );
    assert.equal((db.query("SELECT COUNT(*) n FROM notices").get() as { n: number }).n, 0);
    assert.equal(
      (
        db.query("SELECT request_digest FROM review_request_replays").get() as {
          request_digest: string;
        }
      ).request_digest,
      "original",
    );
  } finally {
    db.close();
  }
});
