import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  readScientificEvidence,
  resolveScientificReferences,
  type ScientificContentIdentity,
  ScientificInputError,
  scientificContentGuards,
  validateFalsificationCheck,
  validateScientificVerification,
} from "../../src/ledger/scientific-checks.ts";
import {
  prepareScientificContentGuards,
  ScientificGuardError,
} from "../../src/ledger/scientific-content-guards.ts";
import { withGroundingFixture } from "./evidence-grounding-fixture.ts";

const claim = {
  eventId: "claim-1",
  payloadDigest: "a".repeat(64),
  claimId: "C-1",
  version: 1,
  contentDigest: `sha256:${"a".repeat(64)}`,
  statement: "A precise claim.",
  fellowId: "fellow-author",
  sponsorId: "sponsor-author",
  provenance: null,
};

test("existing reference admission carries the entire graph into the existing commit guard", () =>
  withGroundingFixture(async (f) => {
    const base = f.add("E-1"),
      middle = f.derived("E-2", [base]),
      root = f.derived("E-3", [middle], "method");
    const evidence = await readScientificEvidence(f.db, "P-DEMO", claim, root);
    assert.equal(evidence.evidenceId, "E-3");
    assert.equal(evidence.groundingWitnesses?.length, 3);
    await f.db.batch([
      f.db.prepare("INSERT INTO atomic_writes VALUES('committed')"),
      ...scientificContentGuards(f.db, [evidence]),
    ]);
    assert.equal(f.sql.query("SELECT * FROM atomic_writes").all().length, 1);
  }));

for (const mode of ["withdraw", "redact", "tamper", "private", "cursor"] as const)
  test(`post-screening ${mode} of an ancestor rolls back the whole publication`, () =>
    withGroundingFixture(async (f) => {
      const base = f.add("E-1"),
        middle = f.derived("E-2", [base]),
        root = f.derived("E-3", [middle]);
      const evidence = await readScientificEvidence(f.db, "P-DEMO", claim, root);
      if (mode === "withdraw") f.withdraw("E-1");
      if (mode === "redact")
        f.sql.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='event-E-1'");
      if (mode === "tamper")
        f.sql.exec("UPDATE event_content SET payload_json='{}' WHERE event_id='event-E-1'");
      if (mode === "private")
        f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'");
      if (mode === "cursor") f.sql.exec("UPDATE events SET seq=10001 WHERE id='event-E-1'");
      await assert.rejects(
        f.db.batch([
          f.db.prepare("INSERT INTO atomic_writes VALUES('must-rollback')"),
          ...scientificContentGuards(f.db, [evidence]),
        ]),
        /SCIENTIFIC_REFERENCE_CHANGED/,
      );
      assert.equal(f.sql.query("SELECT * FROM atomic_writes").all().length, 0);
    }));

test("method roots share a single snapshot and preserve caller order", () =>
  withGroundingFixture(async (f) => {
    const base = f.add("E-1"),
      left = f.derived("E-2", [base]),
      right = f.derived("E-3", [base]);
    const resolved = await resolveScientificReferences(f.db, "P-DEMO", claim, [right, left]);
    assert.equal(f.calls(), 1);
    assert.deepEqual(
      resolved.map((r) => r.evidenceId),
      ["E-3", "E-2"],
    );
    const guards = scientificContentGuards(f.db, resolved);
    assert.equal(guards.length, 1);
    await f.db.batch(guards);
  }));

test("withdrawn ancestors refuse full-write-up verification before new support is admitted", () =>
  withGroundingFixture(async (f) => {
    const base = f.add("E-1"),
      root = f.derived("E-2", [base]);
    const verification = {
      kind: "full-write-up" as const,
      target_digest: claim.contentDigest,
      evidence: root,
      coverage: ["exact statement"],
      result: "verified" as const,
    };
    assert.equal(
      (
        await validateScientificVerification(
          f.db,
          "P-DEMO",
          claim,
          verification,
          "reviewer",
          "other-sponsor",
        )
      ).fullWriteUp,
      true,
    );
    f.withdraw("E-1");
    await assert.rejects(
      validateScientificVerification(
        f.db,
        "P-DEMO",
        claim,
        verification,
        "reviewer",
        "other-sponsor",
      ),
      ScientificInputError,
    );
  }));

test("surviving falsification checks cannot reuse indirectly withdrawn grounding", () =>
  withGroundingFixture(async (f) => {
    const base = f.add("E-1"),
      root = f.derived("E-2", [base]);
    const check = {
      target_digest: claim.contentDigest,
      attempted_falsifier: "A counterexample",
      capable_of_failure: "An unequal result",
      result: "survived" as const,
      evidence: [root],
    };
    const resolved = await validateFalsificationCheck(f.db, "P-DEMO", claim, check, "informs");
    assert.equal(resolved[0]?.groundingWitnesses?.length, 2);
    f.withdraw("E-1");
    await assert.rejects(
      validateFalsificationCheck(f.db, "P-DEMO", claim, check, "informs"),
      ScientificInputError,
    );
  }));

test("duplicate root refusal remains a scientific teaching error and spends no reads", () =>
  withGroundingFixture(async (f) => {
    const root = f.add("E-1");
    await assert.rejects(
      resolveScientificReferences(f.db, "P-DEMO", claim, [root, root]),
      ScientificInputError,
    );
    assert.equal(f.calls(), 0);
  }));

test("inconsistent snapshots cannot silently replace an earlier stronger identity", () =>
  withGroundingFixture(async (f) => {
    const root = f.add("E-1"),
      evidence = await readScientificEvidence(f.db, "P-DEMO", claim, root);
    for (const changed of [
      { payloadDigest: "f".repeat(64) },
      { payloadJson: "{}" },
      { problemId: "P-OTHER" },
    ]) {
      assert.throws(
        () => scientificContentGuards(f.db, [evidence, { ...evidence, ...changed }]),
        ScientificGuardError,
      );
      assert.throws(
        () => scientificContentGuards(f.db, [{ ...evidence, ...changed }, evidence]),
        ScientificGuardError,
      );
    }
  }));

test("digest-only duplicates cannot downgrade exact-content witnesses in either order", () =>
  withGroundingFixture(async (f) => {
    const root = f.add("E-1"),
      evidence = await readScientificEvidence(f.db, "P-DEMO", claim, root);
    const old = { eventId: evidence.eventId, payloadDigest: evidence.payloadDigest };
    f.sql.exec("UPDATE event_content SET payload_json='{}'");
    for (const inputs of [
      [evidence, old],
      [old, evidence],
    ])
      await assert.rejects(
        f.db.batch(scientificContentGuards(f.db, inputs)),
        /SCIENTIFIC_REFERENCE_CHANGED/,
      );
  }));

test("guarding 64 dependencies uses four statements and <=64 parameters per statement", () =>
  withGroundingFixture(async (f) => {
    let root = f.add("E-1");
    for (let n = 2; n <= 64; n++) root = f.derived(`E-${n}`, [root]);
    const evidence = await readScientificEvidence(f.db, "P-DEMO", claim, root);
    const guards = scientificContentGuards(f.db, [evidence]);
    assert.equal(guards.length, 4);
    for (const guard of guards)
      assert.ok((guard as unknown as { values(): unknown[] }).values().length <= 64);
    await f.db.batch(guards);
  }));

test("a failure in a later guard chunk rolls earlier publication work back", () =>
  withGroundingFixture(async (f) => {
    let root = f.add("E-1");
    for (let n = 2; n <= 40; n++) root = f.derived(`E-${n}`, [root]);
    const evidence = await readScientificEvidence(f.db, "P-DEMO", claim, root);
    f.withdraw("E-30");
    await assert.rejects(
      f.db.batch([
        f.db.prepare("INSERT INTO atomic_writes VALUES('no')"),
        ...scientificContentGuards(f.db, [evidence]),
      ]),
      /SCIENTIFIC_REFERENCE_CHANGED/,
    );
    assert.equal(f.sql.query("SELECT * FROM atomic_writes").all().length, 0);
  }));

test("legacy digest-only callers retain a guard and still observe withdrawal", () =>
  withGroundingFixture(async (f) => {
    const ref = f.add("E-1");
    const identity = { eventId: "event-E-1", payloadDigest: ref.digest.slice(7) };
    await f.db.batch(scientificContentGuards(f.db, [identity]));
    f.withdraw("E-1");
    await assert.rejects(
      f.db.batch(scientificContentGuards(f.db, [identity])),
      /SCIENTIFIC_REFERENCE_CHANGED/,
    );
  }));

test("publication preconditions are frozen at preparation, not reread from caller objects", () =>
  withGroundingFixture(async (f) => {
    const root = f.add("E-1"),
      evidence = await readScientificEvidence(f.db, "P-DEMO", claim, root);
    const guards = scientificContentGuards(f.db, [evidence]);
    evidence.payloadJson = "{}";
    evidence.payloadDigest = "0".repeat(64);
    await f.db.batch(guards);
  }));

test("invalid and excessive witness collections fail before a transaction", () =>
  withGroundingFixture(async (f) => {
    assert.deepEqual(prepareScientificContentGuards(f.db, []), []);
    assert.throws(
      () => prepareScientificContentGuards(f.db, [{ eventId: "x", payloadDigest: "invalid" }]),
      ScientificGuardError,
    );
    assert.throws(
      () =>
        prepareScientificContentGuards(
          f.db,
          Array.from({ length: 257 }, (_, i) => ({
            eventId: `e-${i}`,
            payloadDigest: "a".repeat(64),
          })),
        ),
      ScientificGuardError,
    );
    const roots: ScientificContentIdentity[] = [
      { eventId: "x", payloadDigest: "a".repeat(64), payloadJson: "x".repeat(524289) },
    ];
    assert.throws(() => scientificContentGuards(f.db, roots), ScientificGuardError);
  }));
