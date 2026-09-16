import { test } from "bun:test";
import assert from "node:assert/strict";
import type { D1Database } from "@cloudflare/workers-types";
import type { FellowCredentialBinding } from "../../src/enrollment/service.ts";
import type { ReviewMatch } from "../../src/review-requests/matching.ts";
import { REVIEW_OFFER_MS } from "../../src/review-requests/model.ts";
import {
  commitRequest,
  REQUEST_SCHEMA,
  type ReplayProtector,
  type RequestCommand,
  requestReplay,
} from "../../src/review-requests/store.ts";
import {
  MATCH_AUTHOR,
  matchFellow,
  matchHash,
  reviewMatchingFixture,
} from "./review-matching-fixture.ts";

// Real WebCrypto AEAD for replay tests, not the deployment's key derivation.
async function protector(): Promise<ReplayProtector> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const text = new TextEncoder();
  return {
    async seal(value, context = "") {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: text.encode(context) },
        key,
        text.encode(value),
      );
      return {
        ciphertext: Buffer.from(encrypted).toString("base64"),
        initializationVector: Buffer.from(iv).toString("base64"),
      };
    },
    async open(value, context = "") {
      const decrypted = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Buffer.from(value.initializationVector, "base64"),
          additionalData: text.encode(context),
        },
        key,
        Buffer.from(value.ciphertext, "base64"),
      );
      return new TextDecoder().decode(decrypted);
    },
  };
}
type Fixture = ReturnType<typeof reviewMatchingFixture>;
function command(f: Fixture, match: ReviewMatch, key = "match-1"): RequestCommand {
  const actor: FellowCredentialBinding = {
    fellowId: MATCH_AUTHOR,
    sponsorId: "usr_author",
    credentialId: "cred-0",
    tokenHash: matchHash(MATCH_AUTHOR),
    name: "author",
    model: "model/label",
    harness: "harness",
    issuedAt: 10,
    expiresAt: f.now + 100000,
    credentialProfile: "bearer",
    fellowStatus: "active",
    grantedScopes: ["promote", "review"],
    grantedResources: {},
  };
  return {
    receipt: {
      schema: REQUEST_SCHEMA,
      request_id: `RR-${crypto.randomUUID().replaceAll("-", "")}`,
      problem_id: "P-DEMO",
      claim_id: "C-1",
      claim_version: 1,
      claim_event_id: f.target.pin.event_id,
      claim_payload_sha256: f.target.pin.digest,
      author_id: MATCH_AUTHOR,
      reviewer_id: match.reviewerId,
      version: 1,
      status: "offered",
      created_at: f.now,
      updated_at: f.now,
      expires_at: f.now + REVIEW_OFFER_MS,
      review_event_id: null,
    },
    actor,
    role: "contributor",
    action: "offer",
    scope: "promote",
    cursor: f.target.cursor,
    authorSponsor: "usr_author",
    reviewerSponsor: match.reviewerSponsor,
    pins: [f.target.pin, match.provenancePin],
    match: match.eligibility,
    idempotencyKey: key,
    requestDigest: matchHash(JSON.stringify({ match: "different-family", target: "C-1@1" })),
    eventId: `RRE-${crypto.randomUUID().replaceAll("-", "")}`,
  };
}
function counts(f: Fixture) {
  return [
    "review_requests",
    "review_request_events",
    "fellow_inbox_notices",
    "review_request_replays",
  ].map((table) => f.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n);
}
async function prepared() {
  const f = reviewMatchingFixture();
  f.publish(f.person(1), "beta");
  const matched = await f.match();
  assert.ok(matched);
  return { f, c: command(f, matched), p: await protector() };
}

test("matched invitation, private notice and sealed replay settle without a scientific event", async () => {
  const { f, c, p } = await prepared();
  try {
    const events = f.rows("SELECT COUNT(*) AS n FROM events")[0]?.n;
    const receipt = await commitRequest(f.db, p, c);
    assert.deepEqual(receipt, c.receipt);
    assert.deepEqual(counts(f), [1, 1, 1, 1]);
    assert.equal(f.rows("SELECT public_seq FROM problems WHERE id='P-DEMO'")[0]?.public_seq, 1000);
    assert.equal(f.rows("SELECT COUNT(*) AS n FROM events")[0]?.n, events);
    const notice = JSON.stringify(f.rows("SELECT * FROM fellow_inbox_notices"));
    assert.ok(!notice.includes("deliberate public work product"));
    assert.ok(!notice.includes("binding_json"));
    const stored = f.rows("SELECT * FROM review_request_replays")[0];
    assert.ok(!JSON.stringify(stored).includes(c.receipt.reviewer_id));
    assert.deepEqual(
      await requestReplay(f.db, p, MATCH_AUTHOR, c.idempotencyKey, c.requestDigest, f.now),
      receipt,
    );
    assert.ok(!JSON.stringify(receipt).includes("tokenHash"));
  } finally {
    f.sqlite.close();
  }
});

for (const change of [
  "UPDATE fellow_tokens SET revoked_at=1 WHERE credential_id='cred-1'",
  "UPDATE fellow_tokens SET granted_scopes_json='[]' WHERE credential_id='cred-1'",
  "UPDATE enrollment_grants SET granted_scopes_json='[]' WHERE fellow_id=?",
  "UPDATE problem_memberships SET role='observer' WHERE fellow_id=?",
  "UPDATE enrollment_fellows SET sponsor_id='usr_changed' WHERE fellow_id=?",
  "UPDATE enrollment_fellows SET status='paused' WHERE fellow_id=?",
  "UPDATE problems SET public_seq=1001 WHERE id='P-DEMO'",
  "UPDATE event_content SET redacted_at='now' WHERE event_id='EV-2'",
  "UPDATE event_content SET payload_json='{}' WHERE event_id='EV-2'",
  "UPDATE event_content SET payload_json='{}' WHERE event_id='EV-1'",
  "INSERT INTO enrollment_sponsor_security VALUES('usr_1',10)",
  "INSERT INTO enrollment_fellow_security VALUES(?,10)",
]) {
  test(`match-time race rolls back every effect: ${change}`, async () => {
    const { f, c, p } = await prepared();
    try {
      f.sqlite.query(change).run(...(change.includes("?") ? [matchFellow(1)] : []));
      await assert.rejects(commitRequest(f.db, p, c), /CONFLICT/);
      assert.deepEqual(counts(f), [0, 0, 0, 0]);
    } finally {
      f.sqlite.close();
    }
  });
}

test("another problem spending the recipient's last event budget aborts settlement", async () => {
  const f = reviewMatchingFixture();
  try {
    const reviewer = f.person(1);
    f.publish(reviewer, "beta");
    f.sqlite
      .query(
        "UPDATE fellow_tokens SET granted_resources_json='{\"eventBudget\":1}' WHERE credential_id='cred-1'",
      )
      .run();
    const match = await f.match();
    assert.ok(match);
    const c = command(f, match);
    const event = f.publish(reviewer, "beta", { problem: "P-OTHER" });
    f.sqlite
      .query("UPDATE events SET writer_credential_id='cred-1' WHERE id=?")
      .run(event.event_id);
    await assert.rejects(commitRequest(f.db, await protector(), c), /CONFLICT/);
    assert.deepEqual(counts(f), [0, 0, 0, 0]);
  } finally {
    f.sqlite.close();
  }
});

test("a narrower current Fellow-grant budget is also rechecked at settlement", async () => {
  const f = reviewMatchingFixture();
  try {
    const reviewer = f.person(1);
    f.publish(reviewer, "beta");
    f.sqlite
      .query(
        "UPDATE enrollment_grants SET granted_resources_json='{\"eventBudget\":1}' WHERE fellow_id=?",
      )
      .run(reviewer);
    const match = await f.match();
    assert.ok(match);
    const c = command(f, match);
    const event = f.publish(reviewer, "beta", { problem: "P-OTHER" });
    f.sqlite
      .query("UPDATE events SET writer_credential_id='cred-1' WHERE id=?")
      .run(event.event_id);
    await assert.rejects(commitRequest(f.db, await protector(), c), /CONFLICT/);
    assert.deepEqual(counts(f), [0, 0, 0, 0]);
  } finally {
    f.sqlite.close();
  }
});

test("a competing invitation to another recipient prevents automatic fan-out atomically", async () => {
  const { f, c, p } = await prepared();
  try {
    f.publish(f.person(2), "beta");
    f.invite(2, "offer");
    await assert.rejects(commitRequest(f.db, p, c), /CONFLICT/);
    assert.deepEqual(counts(f), [1, 1, 0, 0]);
  } finally {
    f.sqlite.close();
  }
});

test("same-key stale selection replays the original recipient instead of rematching", async () => {
  const { f, c, p } = await prepared();
  try {
    const original = await commitRequest(f.db, p, c);
    f.publish(f.person(2), "beta");
    f.sqlite.query("UPDATE fellow_tokens SET revoked_at=1 WHERE credential_id='cred-1'").run();
    const stale = {
      ...c,
      receipt: { ...c.receipt, reviewer_id: matchFellow(2), request_id: `RR-${"a".repeat(32)}` },
    };
    assert.deepEqual(await commitRequest(f.db, p, stale), original);
    assert.deepEqual(counts(f), [1, 1, 1, 1]);
    await assert.rejects(
      commitRequest(f.db, p, { ...stale, requestDigest: matchHash("changed") }),
      /IDEMPOTENCY_CONFLICT/,
    );
  } finally {
    f.sqlite.close();
  }
});

test("a lost batch response recovers the committed match and does not send a second notice", async () => {
  const { f, c, p } = await prepared();
  try {
    const db = {
      prepare: f.db.prepare.bind(f.db),
      async batch(statements: Parameters<D1Database["batch"]>[0]) {
        await f.db.batch(statements);
        throw new Error("lost response");
      },
    } as unknown as D1Database;
    assert.deepEqual(await commitRequest(db, p, c), c.receipt);
    assert.deepEqual(counts(f), [1, 1, 1, 1]);
    assert.deepEqual(await commitRequest(f.db, p, c), c.receipt);
  } finally {
    f.sqlite.close();
  }
});

test("a same-key winner landing after the first replay check wins all effects", async () => {
  const { f, c, p } = await prepared();
  try {
    let injected = false;
    const loser = {
      ...c,
      eventId: `RRE-${"b".repeat(32)}`,
      receipt: { ...c.receipt, request_id: `RR-${"b".repeat(32)}` },
    };
    const interleaved: ReplayProtector = {
      open: p.open,
      async seal(value, context) {
        if (!injected) {
          injected = true;
          await commitRequest(f.db, p, c);
        }
        return p.seal(value, context);
      },
    };
    assert.deepEqual(await commitRequest(f.db, interleaved, loser), c.receipt);
    assert.deepEqual(counts(f), [1, 1, 1, 1]);
  } finally {
    f.sqlite.close();
  }
});

test("declined work can be explicitly rematched to another Fellow without deleting history", async () => {
  const { f, c, p } = await prepared();
  try {
    f.publish(f.person(2), "gamma");
    await commitRequest(f.db, p, c);
    // Exercise the existing durable command seam. Full transition-trigger
    // lineage is tested separately; this fixture isolates match settlement.
    const declined: RequestCommand = {
      ...c,
      action: "decline",
      scope: "coordinate",
      role: "none",
      match: undefined,
      pins: [],
      actor: {
        ...c.actor,
        fellowId: matchFellow(1),
        sponsorId: "usr_1",
        credentialId: "cred-1",
        tokenHash: matchHash(matchFellow(1)),
      },
      idempotencyKey: "decline",
      requestDigest: matchHash("decline"),
      eventId: `RRE-${"c".repeat(32)}`,
      receipt: { ...c.receipt, status: "declined", version: 2, updated_at: f.now + 1 },
    };
    await commitRequest(f.db, p, declined);
    const next = await f.match();
    assert.equal(next?.reviewerId, matchFellow(2));
    assert.ok(next);
    await commitRequest(f.db, p, command(f, next, "match-2"));
    assert.deepEqual(counts(f), [2, 3, 3, 3]);
    assert.deepEqual(
      f.rows("SELECT action FROM review_request_events ORDER BY rowid").map((row) => row.action),
      ["offer", "decline", "offer"],
    );
  } finally {
    f.sqlite.close();
  }
});

test("named invitations retain their own behavior without a matching guard", async () => {
  const { f, c, p } = await prepared();
  try {
    f.person(2);
    f.invite(2, "offer");
    const named = { ...c, match: undefined, pins: [f.target.pin] };
    assert.deepEqual(await commitRequest(f.db, p, named), c.receipt);
    assert.deepEqual(counts(f), [2, 2, 1, 1]);
  } finally {
    f.sqlite.close();
  }
});
