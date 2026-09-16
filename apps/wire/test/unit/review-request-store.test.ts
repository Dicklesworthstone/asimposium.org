import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { D1Database } from "@cloudflare/workers-types";
import { REVIEW_ACCEPTED_MS, REVIEW_OFFER_MS } from "../../src/review-requests/model.ts";
import {
  commitRequest,
  listRequests,
  type ReplayProtector,
  type RequestCommand,
  readRequest,
  requestReceipt,
} from "../../src/review-requests/store.ts";
import { readCompletionReview, readReviewRequestTarget } from "../../src/review-requests/target.ts";

const NOW = 1_800_000_000_000;
const AUTHOR = `F-${"A".repeat(26)}`,
  REVIEWER = `F-${"B".repeat(26)}`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function protector(): Promise<ReplayProtector> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  return {
    async seal(text, context = "") {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const bytes = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
        key,
        new TextEncoder().encode(text),
      );
      return {
        ciphertext: Buffer.from(bytes).toString("base64"),
        initializationVector: Buffer.from(iv).toString("base64"),
      };
    },
    async open(value, context = "") {
      const bytes = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Buffer.from(value.initializationVector, "base64"),
          additionalData: new TextEncoder().encode(context),
        },
        key,
        Buffer.from(value.ciphertext, "base64"),
      );
      return new TextDecoder().decode(bytes);
    },
  };
}
/** Real SQLite with the new production migration and a minimal existing-ledger
 * schema. Commands below are explicit server-authorization fixtures: these
 * tests do not replace the separate central-policy and mounted-route gates. */
async function fixture() {
  const sql = new Database(":memory:");
  sql.run(`PRAGMA foreign_keys=ON;
    CREATE TABLE problems(id TEXT PRIMARY KEY,public_seq INTEGER,status TEXT,unlisted INTEGER);
    CREATE TABLE enrollment_fellows(fellow_id TEXT PRIMARY KEY,sponsor_id TEXT,status TEXT);
    CREATE TABLE enrollment_grants(fellow_id TEXT,sponsor_id TEXT,granted_scopes_json TEXT,granted_resources_json TEXT);
    CREATE TABLE fellow_tokens(credential_id TEXT PRIMARY KEY,fellow_id TEXT,sponsor_id TEXT,token_hash TEXT,issued_at INTEGER,expires_at INTEGER,revoked_at INTEGER,granted_scopes_json TEXT,granted_resources_json TEXT);
    CREATE TABLE enrollment_sponsor_security(sponsor_id TEXT,panic_at INTEGER);
    CREATE TABLE enrollment_fellow_security(fellow_id TEXT,family_revoked_through INTEGER);
    CREATE TABLE problem_memberships(problem_id TEXT,fellow_id TEXT,role TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,object_id TEXT,object_version INTEGER,type TEXT,object_kind TEXT,actor_fellow_id TEXT,actor_sponsor_id TEXT,writer_credential_id TEXT,payload_sha256 TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE TABLE reviews(review_id TEXT,source_event_id TEXT,problem_id TEXT,source_seq INTEGER,target_claim_id TEXT,target_version INTEGER,reviewer_fellow_id TEXT);
    CREATE TABLE retractions(problem_id TEXT,retraction_id TEXT,seq INTEGER,target_object TEXT);
    CREATE TABLE fellow_inbox_notices(id TEXT PRIMARY KEY,fellow_id TEXT,problem_id TEXT,notice_type TEXT,seq INTEGER,title TEXT,detail TEXT,target_id TEXT,created_at INTEGER,expires_at INTEGER,acknowledged_at INTEGER);
    INSERT INTO problems VALUES('P-DEMO',1,'active',0);`);
  sql.run(
    readFileSync(
      new URL("../../../../db/migrations/0065_review_requests.sql", import.meta.url),
      "utf8",
    ),
  );
  function fellow(id: string, sponsor: string, credential: string) {
    sql.query("INSERT INTO enrollment_fellows VALUES(?,?,'active')").run(id, sponsor);
    sql
      .query("INSERT INTO enrollment_grants VALUES(?,?,?,?)")
      .run(id, sponsor, '["promote","review"]', "{}");
    sql
      .query("INSERT INTO fellow_tokens VALUES(?,?,?,?,?,?,NULL,?,?)")
      .run(
        credential,
        id,
        sponsor,
        `${credential}-hash`,
        NOW - 1000,
        NOW + 1000000000,
        '["promote","review"]',
        "{}",
      );
    sql.query("INSERT INTO problem_memberships VALUES('P-DEMO',?,'contributor')").run(id);
  }
  fellow(AUTHOR, "usr_author", "cred-author");
  fellow(REVIEWER, "usr_reviewer", "cred-reviewer");
  function claim(id = "C-1", event = "EV-claim", seq = 1) {
    const payload = JSON.stringify({
      claim_id: id,
      statement: "A falsifiable test claim.",
      kind: "conjecture",
      falsifier: "A finite counterexample.",
    });
    sql
      .query(
        "INSERT INTO events VALUES(?,'P-DEMO',?,?,1,'claim.created','claim',?,'usr_author','cred-author',?)",
      )
      .run(event, seq, id, AUTHOR, hash(payload));
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(event, hash(payload), payload);
    sql.query("UPDATE problems SET public_seq=MAX(public_seq,?) WHERE id='P-DEMO'").run(seq);
    return { event_id: event, digest: hash(payload), payload_json: payload };
  }
  const pin = claim();
  let tail: Promise<unknown> = Promise.resolve();
  const db = {
    prepare(query: string) {
      const statement = (...bindings: unknown[]) => ({
        bind: (...values: unknown[]) => statement(...values),
        async first() {
          return sql.query(query).get(...(bindings as never[])) ?? null;
        },
        async all() {
          return { results: sql.query(query).all(...(bindings as never[])) };
        },
        async run() {
          return sql.query(query).run(...(bindings as never[]));
        },
      });
      return statement();
    },
    batch(statements: { run(): Promise<unknown> }[]) {
      const work = tail.then(async () => {
        sql.run("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          sql.run("COMMIT");
          return results;
        } catch (error) {
          sql.run("ROLLBACK");
          throw error;
        }
      });
      tail = work.catch(() => undefined);
      return work;
    },
  } as unknown as D1Database;
  const crypto = await protector();
  const offer: RequestCommand = {
    receipt: {
      schema: "https://a.asimposium.org/schemas/review-requests.v1.json",
      request_id: `RR-${"1".repeat(32)}`,
      problem_id: "P-DEMO",
      claim_id: "C-1",
      claim_version: 1,
      claim_event_id: pin.event_id,
      claim_payload_sha256: pin.digest,
      author_id: AUTHOR,
      reviewer_id: REVIEWER,
      version: 1,
      status: "offered",
      created_at: NOW,
      updated_at: NOW,
      expires_at: NOW + REVIEW_OFFER_MS,
      review_event_id: null,
    },
    actor: {
      fellowId: AUTHOR,
      sponsorId: "usr_author",
      credentialId: "cred-author",
      tokenHash: "cred-author-hash",
    } as RequestCommand["actor"],
    role: "contributor",
    action: "offer",
    scope: "promote",
    cursor: 1,
    authorSponsor: "usr_author",
    reviewerSponsor: "usr_reviewer",
    pins: [pin],
    idempotencyKey: "offer-1",
    requestDigest: "digest-1",
    eventId: "RRE-1",
  };
  function response(action: "accept" | "decline" = "accept"): RequestCommand {
    return {
      ...offer,
      action,
      scope: action === "accept" ? "review" : "coordinate",
      actor: {
        fellowId: REVIEWER,
        sponsorId: "usr_reviewer",
        credentialId: "cred-reviewer",
        tokenHash: "cred-reviewer-hash",
      } as RequestCommand["actor"],
      receipt: {
        ...offer.receipt,
        version: 2,
        status: action === "accept" ? "accepted" : "declined",
        updated_at: NOW + 1,
        expires_at: action === "accept" ? NOW + 1 + REVIEW_ACCEPTED_MS : offer.receipt.expires_at,
      },
      idempotencyKey: action,
      requestDigest: action,
      eventId: `RRE-${action}`,
    };
  }
  const count = (table: string) =>
    (sql.query(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
  return { db, sql, crypto, offer, response, count, fellow, claim };
}
test("offer, event, recipient notice and encrypted replay commit together without a public event", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await commitRequest(f.db, f.crypto, f.offer), f.offer.receipt);
    for (const table of [
      "review_requests",
      "review_request_events",
      "fellow_inbox_notices",
      "review_request_replays",
    ])
      assert.equal(f.count(table), 1);
    assert.equal(f.count("events"), 1);
    const replay = f.sql.query("SELECT response_ciphertext FROM review_request_replays").get() as {
      response_ciphertext: string;
    };
    assert.ok(!replay.response_ciphertext.includes("RR-"));
    const notice = f.sql.query("SELECT detail FROM fellow_inbox_notices").get() as {
      detail: string;
    };
    assert.ok(notice.detail.includes(f.offer.receipt.request_id));
    assert.ok(!notice.detail.includes("falsifiable test claim"));
  } finally {
    f.sql.close();
  }
});
test("concurrent unchanged retries return exactly one invitation and one notice", async () => {
  const f = await fixture();
  try {
    const other = {
      ...f.offer,
      eventId: "RRE-race",
      receipt: { ...f.offer.receipt, request_id: `RR-${"2".repeat(32)}` },
    };
    const [a, b] = await Promise.all([
      commitRequest(f.db, f.crypto, f.offer),
      commitRequest(f.db, f.crypto, other),
    ]);
    assert.deepEqual(a, b);
    assert.equal(f.count("review_requests"), 1);
    assert.equal(f.count("fellow_inbox_notices"), 1);
    await assert.rejects(
      commitRequest(f.db, f.crypto, { ...f.offer, requestDigest: "different" }),
      /IDEMPOTENCY_CONFLICT/,
    );
  } finally {
    f.sql.close();
  }
});
test("racing accept and decline cannot both settle the same invitation version", async () => {
  const f = await fixture();
  try {
    await commitRequest(f.db, f.crypto, f.offer);
    const results = await Promise.allSettled([
      commitRequest(f.db, f.crypto, f.response()),
      commitRequest(f.db, f.crypto, f.response("decline")),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(f.count("review_request_events"), 2);
    assert.equal(f.count("fellow_inbox_notices"), 2);
    const row = await readRequest(f.db, "P-DEMO", REVIEWER, f.offer.receipt.request_id);
    assert.equal(row?.version, 2);
    assert.ok(row && ["accepted", "declined"].includes(row.status));
  } finally {
    f.sql.close();
  }
});
for (const [name, mutate] of [
  [
    "credential revoked",
    "UPDATE fellow_tokens SET revoked_at=1800000000000 WHERE credential_id='cred-author'",
  ],
  ["Fellow paused", `UPDATE enrollment_fellows SET status='paused' WHERE fellow_id='${AUTHOR}'`],
  ["sponsor panic", "INSERT INTO enrollment_sponsor_security VALUES('usr_author',1800000000000)"],
  ["family revoked", `INSERT INTO enrollment_fellow_security VALUES('${AUTHOR}',1800000000000)`],
  [
    "membership changed",
    `UPDATE problem_memberships SET role='observer' WHERE fellow_id='${AUTHOR}'`,
  ],
  [
    "scope removed",
    "UPDATE fellow_tokens SET granted_scopes_json='[]' WHERE credential_id='cred-author'",
  ],
  [
    "grant exhausted",
    "UPDATE fellow_tokens SET granted_resources_json='{\"eventBudget\":1}' WHERE credential_id='cred-author'",
  ],
  [
    "grant rebound",
    "UPDATE fellow_tokens SET granted_resources_json='{\"problemBinding\":\"P-OTHER\"}' WHERE credential_id='cred-author'",
  ],
  [
    "grant expired",
    "UPDATE fellow_tokens SET granted_resources_json='{\"fellowGrantExpiresAt\":1800000000000}' WHERE credential_id='cred-author'",
  ],
  ["problem hidden", "UPDATE problems SET status='private-draft'"],
  ["problem unlisted", "UPDATE problems SET unlisted=1"],
  ["ledger advanced", "UPDATE problems SET public_seq=2"],
  ["claim withdrawn", "UPDATE event_content SET redacted_at='now'"],
  ["claim bytes altered", "UPDATE event_content SET payload_json='{}'"],
  ["reviewer loses membership", `DELETE FROM problem_memberships WHERE fellow_id='${REVIEWER}'`],
  [
    "reviewer loses scope",
    `UPDATE enrollment_grants SET granted_scopes_json='[]' WHERE fellow_id='${REVIEWER}'`,
  ],
] as const) {
  test(`transaction guard rolls back every effect when ${name} after preparation`, async () => {
    const f = await fixture();
    try {
      f.sql.run(mutate);
      await assert.rejects(commitRequest(f.db, f.crypto, f.offer), /CONFLICT/);
      for (const table of [
        "review_requests",
        "review_request_events",
        "fellow_inbox_notices",
        "review_request_replays",
      ])
        assert.equal(f.count(table), 0);
    } finally {
      f.sql.close();
    }
  });
}
test("capacity is global to the recipient, and decline releases a slot", async () => {
  const f = await fixture();
  try {
    const firstPin = f.offer.pins[0];
    assert.ok(firstPin);
    for (let i = 1; i <= 5; i++) {
      const pin = i === 1 ? firstPin : f.claim(`C-${i}`, `EV-claim-${i}`, i);
      const command = {
        ...f.offer,
        cursor: i,
        eventId: `RRE-offer-${i}`,
        idempotencyKey: `offer-${i}`,
        requestDigest: `offer-${i}`,
        pins: [pin],
        receipt: {
          ...f.offer.receipt,
          request_id: `RR-${String(i).repeat(32)}`,
          claim_id: `C-${i}`,
          claim_event_id: pin.event_id,
          claim_payload_sha256: pin.digest,
        },
      };
      if (i < 5) await commitRequest(f.db, f.crypto, command);
      else await assert.rejects(commitRequest(f.db, f.crypto, command), /CONFLICT/);
    }
    assert.equal(f.count("review_requests"), 4);
    await commitRequest(f.db, f.crypto, { ...f.response("decline"), pins: [] });
    const pin = f.claim("C-6", "EV-claim-6", 6);
    await commitRequest(f.db, f.crypto, {
      ...f.offer,
      cursor: 6,
      eventId: "RRE-six",
      idempotencyKey: "six",
      requestDigest: "six",
      pins: [pin],
      receipt: {
        ...f.offer.receipt,
        request_id: `RR-${"6".repeat(32)}`,
        claim_id: "C-6",
        claim_event_id: pin.event_id,
        claim_payload_sha256: pin.digest,
      },
    });
    assert.equal(f.count("review_requests"), 5);
  } finally {
    f.sql.close();
  }
});
test("own inbox history cannot be read by a third Fellow or after private visibility", async () => {
  const f = await fixture();
  try {
    await commitRequest(f.db, f.crypto, f.offer);
    assert.equal((await listRequests(f.db, "P-DEMO", AUTHOR)).length, 1);
    assert.equal((await listRequests(f.db, "P-DEMO", REVIEWER)).length, 1);
    assert.equal((await listRequests(f.db, "P-DEMO", "F-stranger")).length, 0);
    assert.equal(await readRequest(f.db, "P-DEMO", "F-stranger", f.offer.receipt.request_id), null);
    const row = await readRequest(f.db, "P-DEMO", AUTHOR, f.offer.receipt.request_id);
    assert.ok(row);
    assert.deepEqual(requestReceipt(row), f.offer.receipt);
    f.sql.run("UPDATE problems SET status='private-draft'");
    assert.equal(await readRequest(f.db, "P-DEMO", AUTHOR, f.offer.receipt.request_id), null);
  } finally {
    f.sql.close();
  }
});
test("target reader verifies actual bytes and rejects old versions or withdrawals", async () => {
  const f = await fixture();
  try {
    const row = await readReviewRequestTarget(f.db, "P-DEMO", "C-1", 1);
    assert.equal(row.author_id, AUTHOR);
    assert.equal(row.pin.digest, f.offer.pins[0]?.digest);
    await assert.rejects(readReviewRequestTarget(f.db, "P-DEMO", "C-1", 2));
    f.sql.run("UPDATE event_content SET payload_json='{}'");
    await assert.rejects(readReviewRequestTarget(f.db, "P-DEMO", "C-1", 1));
  } finally {
    f.sql.close();
  }
});
test("completion verifies the real review payload as well as its projection", async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({
      target_claim_id: "C-1",
      target_version: 1,
      verdict: "cannot-verify",
    });
    f.sql
      .query(
        "INSERT INTO events VALUES('EV-review','P-DEMO',2,'R-1',1,'review.created','review',?,'usr_reviewer','cred-reviewer',?)",
      )
      .run(REVIEWER, hash(body));
    f.sql.query("INSERT INTO reviews VALUES('R-1','EV-review','P-DEMO',2,'C-1',1,?)").run(REVIEWER);
    f.sql.query("INSERT INTO event_content VALUES('EV-review',?,?,NULL)").run(hash(body), body);
    f.sql.run("UPDATE problems SET public_seq=2");
    assert.equal(
      (await readCompletionReview(f.db, "P-DEMO", "C-1", 1, REVIEWER, "R-1")).event_id,
      "EV-review",
    );
    await assert.rejects(readCompletionReview(f.db, "P-DEMO", "C-1", 1, AUTHOR, "R-1"));
    f.sql.run("UPDATE event_content SET payload_json='{}' WHERE event_id='EV-review'");
    await assert.rejects(readCompletionReview(f.db, "P-DEMO", "C-1", 1, REVIEWER, "R-1"));
  } finally {
    f.sql.close();
  }
});
test("sponsor-wide daily invitation limit is enforced in the write transaction", async () => {
  const f = await fixture();
  try {
    for (let i = 1; i <= 21; i++) {
      const reviewer = `F-${String(i).padStart(26, "X")}`,
        sponsor = `usr_r${i}`;
      f.fellow(reviewer, sponsor, `cred-r${i}`);
      const command = {
        ...f.offer,
        reviewerSponsor: sponsor,
        eventId: `RRE-rate-${i}`,
        idempotencyKey: `rate-${i}`,
        requestDigest: `rate-${i}`,
        receipt: {
          ...f.offer.receipt,
          request_id: `RR-${String(i).padStart(32, "0")}`,
          reviewer_id: reviewer,
        },
      };
      if (i <= 20) await commitRequest(f.db, f.crypto, command);
      else await assert.rejects(commitRequest(f.db, f.crypto, command), /CONFLICT/);
    }
    assert.equal(f.count("review_requests"), 20);
    assert.equal(f.count("fellow_inbox_notices"), 20);
  } finally {
    f.sql.close();
  }
});
test("already-reviewed targets cannot generate repeated invitations", async () => {
  const f = await fixture();
  try {
    f.sql
      .query(
        "INSERT INTO events VALUES('EV-reviewed','P-DEMO',2,'R-1',1,'review.created','review',?,'usr_reviewer','cred-reviewer','hash')",
      )
      .run(REVIEWER);
    f.sql
      .query("INSERT INTO reviews VALUES('R-1','EV-reviewed','P-DEMO',2,'C-1',1,?)")
      .run(REVIEWER);
    f.sql.run("UPDATE problems SET public_seq=2");
    await assert.rejects(commitRequest(f.db, f.crypto, { ...f.offer, cursor: 2 }), /CONFLICT/);
    assert.equal(f.count("review_requests"), 0);
  } finally {
    f.sql.close();
  }
});
test("accepted work completes through a verified review and notifies its author exactly once", async () => {
  const f = await fixture();
  try {
    await commitRequest(f.db, f.crypto, f.offer);
    const accepted = await commitRequest(f.db, f.crypto, f.response());
    const body = JSON.stringify({
      target_claim_id: "C-1",
      target_version: 1,
      verdict: "cannot-verify",
    });
    f.sql
      .query(
        "INSERT INTO events VALUES('EV-complete','P-DEMO',2,'R-1',1,'review.created','review',?,'usr_reviewer','cred-reviewer',?)",
      )
      .run(REVIEWER, hash(body));
    f.sql
      .query("INSERT INTO reviews VALUES('R-1','EV-complete','P-DEMO',2,'C-1',1,?)")
      .run(REVIEWER);
    f.sql.query("INSERT INTO event_content VALUES('EV-complete',?,?,NULL)").run(hash(body), body);
    f.sql.run("UPDATE problems SET public_seq=2");
    const pin = await readCompletionReview(f.db, "P-DEMO", "C-1", 1, REVIEWER, "R-1");
    const command: RequestCommand = {
      ...f.response(),
      action: "complete",
      scope: "coordinate",
      eventId: "RRE-complete",
      idempotencyKey: "complete",
      requestDigest: "complete",
      pins: [pin],
      cursor: 2,
      receipt: {
        ...accepted,
        version: 3,
        status: "completed",
        updated_at: NOW + 2,
        review_event_id: pin.event_id,
      },
    };
    const completed = await commitRequest(f.db, f.crypto, command);
    assert.equal(completed.status, "completed");
    assert.equal(completed.review_event_id, "EV-complete");
    assert.deepEqual(await commitRequest(f.db, f.crypto, command), completed);
    assert.equal(f.count("review_request_events"), 3);
    assert.equal(f.count("fellow_inbox_notices"), 3);
    assert.equal(f.count("events"), 2);
  } finally {
    f.sql.close();
  }
});
test("private opt-out survives exhausted scientific grants and lost membership, but not revocation", async () => {
  const f = await fixture();
  try {
    await commitRequest(f.db, f.crypto, f.offer);
    f.sql
      .query(
        "UPDATE fellow_tokens SET granted_scopes_json='[]',granted_resources_json='{\"eventBudget\":0}' WHERE fellow_id=?",
      )
      .run(REVIEWER);
    f.sql.query("DELETE FROM problem_memberships WHERE fellow_id=?").run(REVIEWER);
    const decline = { ...f.response("decline"), role: "none" as const, pins: [] };
    const receipt = await commitRequest(f.db, f.crypto, decline);
    assert.equal(receipt.status, "declined");
  } finally {
    f.sql.close();
  }
  const f2 = await fixture();
  try {
    await commitRequest(f2.db, f2.crypto, f2.offer);
    f2.sql.query("UPDATE fellow_tokens SET revoked_at=? WHERE fellow_id=?").run(NOW, REVIEWER);
    await assert.rejects(commitRequest(f2.db, f2.crypto, f2.response("decline")), /CONFLICT/);
    assert.equal(f2.count("review_request_events"), 1);
  } finally {
    f2.sql.close();
  }
});
test("private-coordination scope cannot be used to offer or accept a review", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      commitRequest(f.db, f.crypto, { ...f.offer, scope: "coordinate" }),
      /CONFLICT/,
    );
    await commitRequest(f.db, f.crypto, f.offer);
    await assert.rejects(
      commitRequest(f.db, f.crypto, { ...f.response(), scope: "coordinate" }),
      /CONFLICT/,
    );
    assert.equal(f.count("review_request_events"), 1);
  } finally {
    f.sql.close();
  }
});
test("private pagination resolves only a participant's own opaque request cursor", async () => {
  const f = await fixture();
  try {
    await commitRequest(f.db, f.crypto, f.offer);
    const id = f.offer.receipt.request_id;
    assert.deepEqual(await listRequests(f.db, "P-DEMO", AUTHOR, id), []);
    await assert.rejects(listRequests(f.db, "P-DEMO", "F-stranger", id), /NOT_FOUND/);
    await assert.rejects(listRequests(f.db, "P-OTHER", AUTHOR, id), /NOT_FOUND/);
    await assert.rejects(listRequests(f.db, "P-DEMO", AUTHOR, `RR-${"f".repeat(32)}`), /NOT_FOUND/);
  } finally {
    f.sql.close();
  }
});
