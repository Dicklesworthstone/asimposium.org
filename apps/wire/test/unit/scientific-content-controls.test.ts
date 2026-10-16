import { test } from "bun:test";
import assert from "node:assert/strict";
import { PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL } from "../../src/krater/public-content.ts";
import { prepareScientificContentGuards } from "../../src/ledger/scientific-content-guards.ts";
import { scientificContentFixture } from "./scientific-content-controls-fixture.ts";

const scopes = ["problem", "C-1", "C-1@1", "#1"];
for (const target of scopes) {
  test(`current claim availability honors ${target}, including a later restore`, () => {
    const f = scientificContentFixture();
    try {
      f.event(1, "C-1", "claim");
      const visible = () => f.sql.query(
        `SELECT id FROM claims WHERE problem_id = 'P-DEMO' AND ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}`,
      ).all();
      assert.equal(visible().length, 1);
      f.control(target);
      assert.deepEqual(visible(), []);
      f.control(target, "visible");
      assert.equal(visible().length, 1);
      f.control(target);
      assert.deepEqual(visible(), []);
    } finally { f.close(); }
  });

  test(`a late ${target} hide aborts every statement in the publication transaction`, async () => {
    const f = scientificContentFixture();
    try {
      const witness = f.event(1, "C-1", "claim");
      const guards = prepareScientificContentGuards(f.db, [witness]);
      await f.db.batch(guards);
      // A control commits after admission and preparation, before publication.
      f.control(target);
      await assert.rejects(f.db.batch([
        f.db.prepare("INSERT INTO transaction_effects VALUES('before-guard')"),
        f.db.prepare("UPDATE problems SET public_seq = public_seq + 1 WHERE id = 'P-DEMO'"),
        ...guards,
        f.db.prepare("INSERT INTO transaction_effects VALUES('after-guard')"),
      ]), /SCIENTIFIC_REFERENCE_CHANGED/);
      assert.deepEqual(f.sql.query("SELECT * FROM transaction_effects").all(), []);
      assert.equal((f.sql.query("SELECT public_seq FROM problems WHERE id = 'P-DEMO'").get() as {
        public_seq: number;
      }).public_seq, 1000);
      // The previously committed control is not rolled back with this command.
      assert.equal(f.sql.query("SELECT * FROM content_controls").all().length, 1);
      f.control(target, "visible");
      await f.db.batch([
        f.db.prepare("INSERT INTO transaction_effects VALUES('restored')"), ...guards,
      ]);
      assert.equal(f.sql.query("SELECT * FROM transaction_effects").all().length, 1);
    } finally { f.close(); }
  });
}

for (const target of ["C-1@2", "C-2", "#2"]) {
  test(`${target} does not hide a different immutable source`, async () => {
    const f = scientificContentFixture();
    try {
      const witness = f.event(1, "C-1", "claim");
      f.control(target);
      await f.db.batch(prepareScientificContentGuards(f.db, [witness]));
      assert.equal(f.sql.query(`SELECT * FROM claims WHERE ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}`).all().length, 1);
    } finally { f.close(); }
  });
}

for (const target of scopes) {
  test(`foreign-problem ${target} controls cannot affect this source`, async () => {
    const f = scientificContentFixture();
    try {
      const witness = f.event(1, "C-1", "claim");
      f.control(target, "hidden", "P-OTHER");
      await f.db.batch(prepareScientificContentGuards(f.db, [witness]));
      assert.equal(f.sql.query(`SELECT * FROM claims WHERE ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}`).all().length, 1);
    } finally { f.close(); }
  });
}

test("restoring the object cannot override a still-hidden exact version or event", async () => {
  const f = scientificContentFixture();
  try {
    const witness = f.event(1, "C-1", "claim");
    const guards = prepareScientificContentGuards(f.db, [witness]);
    f.control("C-1"); f.control("C-1@1"); f.control("#1");
    f.control("C-1", "visible"); f.control("C-1@1", "visible");
    await assert.rejects(f.db.batch(guards), /SCIENTIFIC_REFERENCE_CHANGED/);
    assert.deepEqual(f.sql.query(`SELECT * FROM claims WHERE ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}`).all(), []);
    f.control("#1", "visible");
    await f.db.batch(guards);
  } finally { f.close(); }
});

test("exact controls bind to the claim's source event, not its original version", async () => {
  const f = scientificContentFixture();
  try {
    const old = f.event(1, "C-1", "claim");
    const current = f.event(5, "C-1", "claim", { statement: "Revised claim" }, 2);
    f.control("C-1@1"); f.control("#1");
    await f.db.batch(prepareScientificContentGuards(f.db, [current]));
    await assert.rejects(f.db.batch(prepareScientificContentGuards(f.db, [old])), /SCIENTIFIC_REFERENCE_CHANGED/);
    assert.equal(f.sql.query(`SELECT * FROM claims WHERE ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}`).all().length, 1);
    f.control("#5");
    assert.deepEqual(f.sql.query(`SELECT * FROM claims WHERE ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL}`).all(), []);
  } finally { f.close(); }
});

test("a hidden witness in a later chunk rolls back earlier chunks and writes", async () => {
  const f = scientificContentFixture();
  try {
    const witnesses = Array.from({ length: 33 }, (_, i) => f.event(i + 1, `E-${i + 1}`));
    const guards = prepareScientificContentGuards(f.db, witnesses);
    assert.equal(guards.length, 3);
    assert.ok(f.statements.every((statement) => statement.parameters.length <= 64));
    f.control("E-33@1");
    await assert.rejects(f.db.batch([
      guards[0]!, f.db.prepare("INSERT INTO transaction_effects VALUES('after-first-chunk')"),
      ...guards.slice(1),
    ]), /SCIENTIFIC_REFERENCE_CHANGED/);
    assert.deepEqual(f.sql.query("SELECT * FROM transaction_effects").all(), []);
  } finally { f.close(); }
});

for (const damage of ["redacted", "withdrawn", "private", "digest", "body", "scope", "cursor"]) {
  test(`${damage} sources stay refused when visibility controls are visible`, async () => {
    const f = scientificContentFixture();
    try {
      const witness = f.event(1, "C-1", "claim");
      f.control("C-1@1", "visible");
      if (damage === "redacted") f.sql.exec("UPDATE event_content SET redacted_at='now'");
      if (damage === "withdrawn") f.sql.query("INSERT INTO scientific_withdrawals VALUES(?)").run(witness.eventId);
      if (damage === "private") f.sql.exec("UPDATE problems SET status='private-draft'");
      if (damage === "digest") f.sql.exec("UPDATE event_content SET payload_sha256='wrong'");
      if (damage === "body") f.sql.exec("UPDATE event_content SET payload_json='{}'");
      if (damage === "cursor") f.sql.exec("UPDATE problems SET public_seq=0");
      await assert.rejects(f.db.batch(prepareScientificContentGuards(f.db, [{
        ...witness, ...(damage === "scope" ? { problemId: "P-OTHER" } : {}),
      }])), /SCIENTIFIC_REFERENCE_CHANGED/);
    } finally { f.close(); }
  });
}

test("shared witness dedup retains strong body pins and rejects inconsistent inputs", async () => {
  const f = scientificContentFixture();
  try {
    const witness = f.event(1, "E-1");
    const weak = { eventId: witness.eventId, payloadDigest: witness.payloadDigest };
    const guards = prepareScientificContentGuards(f.db, [weak, witness, { ...witness, groundingWitnesses: [witness] }]);
    assert.equal(guards.length, 1);
    assert.equal(f.statements.at(-1)?.parameters.length, 4);
    await f.db.batch(guards);
    f.sql.exec("UPDATE event_content SET payload_json='{}'");
    await assert.rejects(f.db.batch(guards), /SCIENTIFIC_REFERENCE_CHANGED/);
    assert.throws(() => prepareScientificContentGuards(f.db, [witness, { ...witness, payloadJson: "{}" }]), /SCIENTIFIC_REFERENCE_CHANGED/);
  } finally { f.close(); }
});
