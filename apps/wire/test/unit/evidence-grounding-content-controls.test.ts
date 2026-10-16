import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_GROUNDING_SQL,
  EvidenceGroundingError,
  type EvidenceReference,
  readEvidenceGrounding,
} from "../../src/ledger/evidence-grounding.ts";
import { prepareScientificContentGuards } from "../../src/ledger/scientific-content-guards.ts";
import { scientificContentFixture } from "./scientific-content-controls-fixture.ts";

type Fixture = ReturnType<typeof scientificContentFixture>;
const read = (f: Fixture, roots: readonly EvidenceReference[]) =>
  readEvidenceGrounding(f.db, "P-DEMO", { claimId: "C-1", version: 1 }, roots);
const unavailable = (error: unknown) =>
  error instanceof EvidenceGroundingError && error.reason === "unavailable";
const invalid = (error: unknown) =>
  error instanceof EvidenceGroundingError && error.reason === "invalid";

for (const target of ["problem", "E-3", "E-3@1", "#3"]) {
  test(`grounding refuses ${target} before expanding hidden root dependencies`, async () => {
    const f = scientificContentFixture();
    try {
      const leaf = f.evidence(1);
      const root = f.evidence(3, [leaf.ref]);
      assert.equal((await read(f, [root.ref])).witnesses.length, 2);
      f.control(target);
      const rows = f.sql.query(EVIDENCE_GROUNDING_SQL).all("P-DEMO", JSON.stringify([root.ref]));
      assert.ok(rows.length <= 1, "a hidden source must not expand into its ancestors");
      assert.ok(rows.every((row) => (row as { payload_json: unknown }).payload_json === null));
      assert.doesNotMatch(JSON.stringify(rows), /RESTRICTED-CANARY/);
      await assert.rejects(read(f, [root.ref]), unavailable);
      f.control(target, "visible");
      const restored = await read(f, [root.ref]);
      assert.equal(restored.roots[0]?.eventId, root.eventId);
      assert.equal(restored.witnesses.length, 2);
    } finally { f.close(); }
  });
}

for (const target of ["E-1", "E-1@1", "#1"]) {
  test(`a hidden transitive ${target} is unavailable, never a discarded dependency`, async () => {
    const f = scientificContentFixture();
    try {
      const leaf = f.evidence(1);
      const root = f.evidence(3, [leaf.ref]);
      f.control(target);
      const rows = f.sql.query(EVIDENCE_GROUNDING_SQL).all("P-DEMO", JSON.stringify([root.ref])) as {
        evidence_id: string; payload_json: string | null;
      }[];
      assert.equal(rows.length, 2);
      assert.equal(rows.find((row) => row.evidence_id === "E-1")?.payload_json, null);
      assert.doesNotMatch(JSON.stringify(rows), /RESTRICTED-CANARY-1:/);
      assert.ok(rows.find((row) => row.evidence_id === "E-3")?.payload_json);
      await assert.rejects(read(f, [root.ref]), unavailable);
      f.control(target, "visible");
      assert.equal((await read(f, [root.ref])).witnesses.length, 2);
    } finally { f.close(); }
  });
}

for (const target of ["problem", "E-1", "E-1@1", "#1", "E-3", "E-3@1", "#3"]) {
  test(`the admitted graph is rechecked atomically when ${target} is hidden later`, async () => {
    const f = scientificContentFixture();
    try {
      const leaf = f.evidence(1);
      const root = f.evidence(3, [leaf.ref]);
      const admitted = await read(f, [root.ref]);
      // Use the public admission result, including the complete transitive
      // witnesses, with the actual production commit-guard builder.
      const guards = prepareScientificContentGuards(f.db, [{
        ...root, groundingWitnesses: admitted.witnesses,
      }]);
      f.control(target);
      await assert.rejects(f.db.batch([
        f.db.prepare("INSERT INTO transaction_effects VALUES('new-evidence')"),
        ...guards,
        f.db.prepare("INSERT INTO transaction_effects VALUES('replay-receipt')"),
      ]), /SCIENTIFIC_REFERENCE_CHANGED/);
      assert.deepEqual(f.sql.query("SELECT * FROM transaction_effects").all(), []);
      f.control(target, "visible");
      await f.db.batch(guards);
    } finally { f.close(); }
  });
}

for (const target of ["problem", "E-1", "E-1@1", "#1"]) {
  test(`grounding ignores ${target} controls from a different problem`, async () => {
    const f = scientificContentFixture();
    try {
      const source = f.evidence(1);
      f.evidence(1, [], {}, "P-OTHER");
      f.control(target, "hidden", "P-OTHER");
      assert.equal((await read(f, [source.ref])).roots[0]?.eventId, source.eventId);
    } finally { f.close(); }
  });
}

for (const target of ["E-1@2", "E-99", "#99"]) {
  test(`grounding does not confuse ${target} with the exact evidence event`, async () => {
    const f = scientificContentFixture();
    try {
      const source = f.evidence(1);
      f.control(target);
      assert.equal((await read(f, [source.ref])).witnesses.length, 1);
    } finally { f.close(); }
  });
}

test("independent controls remain authoritative across object and problem restores", async () => {
  const f = scientificContentFixture();
  try {
    const leaf = f.evidence(1);
    const root = f.evidence(3, [leaf.ref]);
    f.control("problem"); f.control("E-1"); f.control("#1");
    f.control("problem", "visible"); f.control("E-1", "visible");
    await assert.rejects(read(f, [root.ref]), unavailable);
    f.control("#1", "visible");
    assert.equal((await read(f, [root.ref])).witnesses.length, 2);
  } finally { f.close(); }
});

test("a readable root cannot cause a hidden sibling root to disappear from the graph", async () => {
  const f = scientificContentFixture();
  try {
    const first = f.evidence(1);
    const second = f.evidence(2);
    f.control("E-2@1");
    await assert.rejects(read(f, [first.ref, second.ref]), unavailable);
    assert.equal((await read(f, [first.ref])).witnesses.length, 1);
  } finally { f.close(); }
});

test("both method and falsification-check dependencies honor current controls", async () => {
  const f = scientificContentFixture();
  try {
    const method = f.evidence(1);
    const check = f.evidence(2);
    const root = f.evidence(3, [method.ref], { falsification_check: { evidence: [check.ref] } });
    assert.equal((await read(f, [root.ref])).witnesses.length, 3);
    f.control("#2");
    await assert.rejects(read(f, [root.ref]), unavailable);
    f.control("#2", "visible"); f.control("#1");
    await assert.rejects(read(f, [root.ref]), unavailable);
  } finally { f.close(); }
});

test("diamond graphs retain exact roots, deduplicate ancestors, and fail on any hidden ancestor", async () => {
  const f = scientificContentFixture();
  try {
    const shared = f.evidence(1);
    const left = f.evidence(2, [shared.ref]);
    const right = f.evidence(3, [shared.ref]);
    const root = f.evidence(4, [left.ref, right.ref]);
    const admitted = await read(f, [root.ref, left.ref]);
    assert.deepEqual(admitted.roots.map((item) => item.evidenceId), ["E-4", "E-2"]);
    assert.equal(admitted.witnesses.length, 4);
    assert.equal(new Set(admitted.witnesses.map((item) => item.eventId)).size, 4);
    f.control("#1");
    await assert.rejects(read(f, [root.ref, left.ref]), unavailable);
  } finally { f.close(); }
});

test("a hidden invalid source is refused as unavailable before body decoding", async () => {
  const f = scientificContentFixture();
  try {
    const source = f.evidence(1, [], { bears_on_id: "C-WRONG" });
    await assert.rejects(read(f, [source.ref]), invalid);
    f.control("#1");
    await assert.rejects(read(f, [source.ref]), unavailable);
    f.control("#1", "visible");
    await assert.rejects(read(f, [source.ref]), invalid);
  } finally { f.close(); }
});

for (const state of ["private", "redacted", "withdrawn", "tampered", "wrong-claim", "wrong-version"]) {
  test(`a visible control cannot revive a ${state} source`, async () => {
    const f = scientificContentFixture();
    try {
      const source = f.evidence(1, [], {
        ...(state === "wrong-claim" ? { bears_on_id: "C-2" } : {}),
        ...(state === "wrong-version" ? { bears_on_version: 2 } : {}),
      });
      f.control("#1", "visible");
      if (state === "private") f.sql.exec("UPDATE problems SET status='private-draft'");
      if (state === "redacted") f.sql.exec("UPDATE event_content SET redacted_at='now'");
      if (state === "withdrawn") f.sql.query("INSERT INTO scientific_withdrawals VALUES(?)").run(source.eventId);
      if (state === "tampered") f.sql.exec("UPDATE event_content SET payload_json='{}'");
      await assert.rejects(read(f, [source.ref]), (error) => error instanceof EvidenceGroundingError);
    } finally { f.close(); }
  });
}

test("the literal 64-node limit remains complete, while node 65 is refused", async () => {
  const f = scientificContentFixture();
  try {
    let root = f.evidence(1);
    for (let sequence = 2; sequence <= 64; sequence++) root = f.evidence(sequence, [root.ref]);
    assert.equal((await read(f, [root.ref])).witnesses.length, 64);
    const over = f.evidence(65, [root.ref]);
    await assert.rejects(read(f, [over.ref]), (error) => error instanceof EvidenceGroundingError && error.reason === "limit");
    f.control("E-33@1");
    await assert.rejects(read(f, [over.ref]), unavailable);
  } finally { f.close(); }
});

test("a forward dependency is not permitted by a visible restore", async () => {
  const f = scientificContentFixture();
  try {
    const later = f.evidence(2);
    const root = f.evidence(1, [later.ref]);
    f.control("#2", "visible");
    await assert.rejects(read(f, [root.ref]), invalid);
  } finally { f.close(); }
});

test("UTF-8 graph byte limits remain enforced with restored sources", async () => {
  const f = scientificContentFixture();
  try {
    const roots = [1, 2, 3].map((sequence) => f.evidence(sequence, [], { body_md: "é".repeat(180000) }));
    for (const root of roots) f.control(root.ref.evidence_id, "visible");
    await assert.rejects(read(f, roots.map((root) => root.ref)), (error) =>
      error instanceof EvidenceGroundingError && error.reason === "limit");
  } finally { f.close(); }
});
