import { test } from "bun:test";
import assert from "node:assert/strict";
import { ScientificWithdrawalReceiptSchema } from "@asimposium/contracts/scientific-withdrawals";
import { withdrawScientificInput } from "../../src/ledger/scientific-withdrawals.ts";
import { iso, NOW, SESSION, withdrawalFixture } from "./scientific-withdrawal-fixture.ts";

type Fixture = ReturnType<typeof withdrawalFixture>;
type Source = ReturnType<Fixture["hypothesisSource"]>;
async function withFixture(body: (fixture: Fixture) => Promise<void>) {
  const fixture = withdrawalFixture();
  try {
    await body(fixture);
  } finally {
    fixture.close();
  }
}
const withdraw = (f: Fixture, source: Source, key = "hypothesis-withdrawal") =>
  withdrawScientificInput(f.options, f.actor, SESSION, "evidence", source.id, source.request, key);
const count = (f: Fixture, table: string) =>
  (f.sql.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const head = (f: Fixture) => f.sql.query("SELECT public_seq FROM problems WHERE id='P-DEMO'").get();
const row = (f: Fixture, query: string, ...values: (string | number | null)[]) =>
  f.sql.query(query).get(...values) as Record<string, unknown> | null;
const control = (f: Fixture, target: string, visibility = "hidden") => {
  const version =
    Number(
      row(
        f,
        "SELECT MAX(version) AS version FROM content_controls WHERE problem_id='P-DEMO' AND target_ref=?",
        target,
      )?.version ?? 0,
    ) + 1;
  f.sql
    .query(`INSERT INTO content_controls(control_id,problem_id,target_kind,target_ref,visibility,
    source,reason_category,actor,reason,version,created_at)
    VALUES(?,'P-DEMO','ledger-object',?,?,'operator','privacy','operator-test','Visibility test',?,?)`)
    .run(`CC-${crypto.randomUUID()}`, target, visibility, version, iso());
};

for (const direction of ["supports", "refutes", "informs"]) {
  test(`an author withdraws ${direction} evidence with exact hypothesis affinity and immutable history`, () =>
    withFixture(async (f) => {
      const source = f.hypothesisSource("E-source", { direction });
      const originalEvent = f.sql.query("SELECT * FROM events WHERE id=?").get(source.event.id);
      const originalContent = f.sql
        .query("SELECT * FROM event_content WHERE event_id=?")
        .get(source.event.id);
      const originalEvidence = f.sql
        .query("SELECT * FROM evidence WHERE evidence_id=?")
        .get(source.id);
      assert.equal(
        row(
          f,
          "SELECT COUNT(*) AS n FROM artifact_publication_evidence WHERE evidence_id=?",
          source.id,
        )?.n,
        1,
      );
      const result = ScientificWithdrawalReceiptSchema.parse(await withdraw(f, source));
      assert.equal(result.target_kind, "evidence");
      assert.equal(result.target_object, source.id);
      assert.equal(result.target_event_id, source.event.id);
      assert.equal(result.target_digest, source.request.source_digest);
      assert.equal("hypothesis_id" in result ? result.hypothesis_id : undefined, "H-1");
      assert.equal("claim_id" in result, false);
      assert.equal("claim_version" in result, false);
      assert.deepEqual(
        f.sql
          .query("SELECT claim_id,claim_version,hypothesis_id FROM scientific_withdrawals")
          .get(),
        {
          claim_id: null,
          claim_version: null,
          hypothesis_id: "H-1",
        },
      );
      assert.deepEqual(
        f.sql.query("SELECT * FROM events WHERE id=?").get(source.event.id),
        originalEvent,
      );
      assert.deepEqual(
        f.sql.query("SELECT * FROM event_content WHERE event_id=?").get(source.event.id),
        originalContent,
      );
      assert.deepEqual(
        f.sql.query("SELECT * FROM evidence WHERE evidence_id=?").get(source.id),
        originalEvidence,
      );
      assert.equal(
        row(
          f,
          "SELECT COUNT(*) AS n FROM artifact_publication_evidence WHERE evidence_id=?",
          source.id,
        )?.n,
        0,
      );
      assert.equal(count(f, "scientific_withdrawals"), 1);
      assert.equal(count(f, "retractions"), 1);
      assert.equal(
        row(f, "SELECT status FROM hypotheses WHERE hypothesis_id='H-1'")?.status,
        "open",
      );
      assert.equal(f.counts.screens, 1);
    }));
}

test("the correction projection keeps event time when acceptance advances the clock", () =>
  withFixture(async (f) => {
    const source = f.hypothesisSource();
    f.before(() => f.clock(NOW + 7));
    const result = await withdraw(f, source);
    assert.equal(
      row(f, "SELECT created_at FROM events WHERE id=?", result.event_id)?.created_at,
      iso(),
    );
    assert.equal(
      row(f, "SELECT created_at FROM retractions WHERE retraction_id=?", result.retraction_id)
        ?.created_at,
      iso(),
    );
    assert.equal(
      row(f, "SELECT created_at FROM scientific_withdrawals WHERE event_id=?", result.event_id)
        ?.created_at,
      NOW + 7,
    );
    assert.equal(result.created_at, iso(NOW + 7));
  }));

test("hypothesis evidence with an omitted unversioned pin is correctable", () =>
  withFixture(async (f) => {
    const source = f.hypothesisSource("E-unversioned", { bears_on_version: undefined });
    assert.equal((await withdraw(f, source)).target_event_id, source.event.id);
  }));

test("an observer who can publish evidence can withdraw their own hypothesis evidence", () =>
  withFixture(async (f) => {
    f.sql.exec("UPDATE problem_memberships SET role='observer'");
    const source = f.hypothesisSource();
    assert.equal((await withdraw(f, source)).target_object, source.id);
    assert.equal(f.counts.screens, 1);
  }));

test("observer correction still requires the evidence publication scope", () =>
  withFixture(async (f) => {
    f.sql.exec(`UPDATE problem_memberships SET role='observer';
      UPDATE fellow_tokens SET granted_scopes_json='["review"]';
      UPDATE enrollment_grants SET granted_scopes_json='["review"]';`);
    const source = f.hypothesisSource();
    await assert.rejects(
      withdrawScientificInput(
        f.options,
        { ...f.actor, grantedScopes: ["review"] },
        SESSION,
        "evidence",
        source.id,
        source.request,
        "observer-without-promote",
      ),
      { code: "NOT_ALLOWED" },
    );
    assert.equal(f.counts.screens, 0);
    assert.equal(f.counts.reservations, 0);
  }));

test("another Fellow cannot withdraw the original evidence author's input", () =>
  withFixture(async (f) => {
    const source = f.hypothesisSource("E-peer", {}, "fellow-b");
    await assert.rejects(withdraw(f, source), { code: "NOT_ALLOWED" });
    assert.equal(f.counts.reservations, 0);
    assert.equal(count(f, "scientific_withdrawals"), 0);
  }));

for (const mismatch of ["source-event", "source-digest", "target-object"]) {
  test(`a mismatched ${mismatch} cannot withdraw a different hypothesis input`, () =>
    withFixture(async (f) => {
      const source = f.hypothesisSource("E-first");
      const other = f.hypothesisSource("E-second");
      const request = {
        ...source,
        ...(mismatch === "target-object" ? { id: other.id } : {}),
        request: {
          ...source.request,
          ...(mismatch === "source-event" ? { source_event_id: other.event.id } : {}),
          ...(mismatch === "source-digest" ? { source_digest: `sha256:${"0".repeat(64)}` } : {}),
        },
      };
      await assert.rejects(withdraw(f, request), { code: "NOT_ALLOWED" });
      assert.equal(f.counts.screens, 0);
      assert.equal(f.counts.reservations, 0);
    }));
}

test("a matching digest label cannot conceal substituted hypothesis evidence bytes", () =>
  withFixture(async (f) => {
    const source = f.hypothesisSource();
    f.sql.query("UPDATE event_content SET payload_json='{}' WHERE event_id=?").run(source.event.id);
    await assert.rejects(withdraw(f, source));
    assert.equal(f.counts.screens, 0);
    assert.equal(count(f, "retractions"), 0);
  }));

test("projection retargeting cannot convert the correction into another hypothesis's history", () =>
  withFixture(async (f) => {
    const source = f.hypothesisSource();
    f.hypothesisSource("E-other", { bears_on_id: "H-2" });
    f.sql.query("UPDATE evidence SET bears_on_id='H-2' WHERE evidence_id=?").run(source.id);
    await assert.rejects(withdraw(f, source));
    assert.equal(f.counts.reservations, 0);
    assert.equal(count(f, "retractions"), 0);
  }));

test("hypotheses never acquire invented claim-version pins", () =>
  withFixture(async (f) => {
    const source = f.hypothesisSource("E-versioned", { bears_on_version: 1 });
    await assert.rejects(withdraw(f, source));
    assert.equal(f.counts.screens, 0);
    assert.equal(count(f, "retractions"), 0);
  }));

for (const target of ["problem", "E-1", "E-1@1", "#3", "H-1", "H-1@1", "#2"]) {
  test(`the latest ${target} control governs correction before quota and screening`, () =>
    withFixture(async (f) => {
      const source = f.hypothesisSource("E-1");
      control(f, target);
      await assert.rejects(withdraw(f, source), { code: "NOT_ALLOWED" });
      assert.equal(f.counts.reservations, 0);
      assert.equal(f.counts.screens, 0);
      control(f, target, "visible");
      assert.equal((await withdraw(f, source)).target_event_id, source.event.id);
    }));
}

for (const target of ["problem", "E-1", "H-1"]) {
  test(`a ${target} hide after screening aborts the complete correction`, () =>
    withFixture(async (f) => {
      const source = f.hypothesisSource("E-1"),
        beforeHead = head(f),
        events = count(f, "events");
      f.before(() => control(f, target));
      await assert.rejects(withdraw(f, source));
      assert.deepEqual(head(f), beforeHead);
      assert.equal(count(f, "events"), events);
      assert.equal(count(f, "scientific_withdrawals"), 0);
      assert.equal(count(f, "retractions"), 0);
    }));
}

test("the exact receipt survives replay and a closed session without another screen", () =>
  withFixture(async (f) => {
    const source = f.hypothesisSource();
    const first = await withdraw(f, source);
    const firstHead = head(f);
    f.sql.exec("UPDATE sessions SET closed_at='closed'");
    assert.deepEqual(await withdraw(f, source), first);
    assert.deepEqual(head(f), firstHead);
    assert.equal(f.counts.reservations, 1);
    assert.equal(f.counts.screens, 1);
    assert.equal(count(f, "scientific_withdrawals"), 1);
  }));

test("another key or changed reason cannot replace a committed correction", () =>
  withFixture(async (f) => {
    const source = f.hypothesisSource();
    const first = await withdraw(f, source);
    await assert.rejects(withdraw(f, source, "different-key"), { code: "CONFLICT" });
    await assert.rejects(
      withdraw(f, {
        ...source,
        request: {
          ...source.request,
          reason: "A changed reason cannot rewrite the first explanation.",
        },
      }),
      { code: "CONFLICT" },
    );
    assert.deepEqual(await withdraw(f, source), first);
    assert.equal(f.counts.screens, 1);
  }));

test("overlapping retries converge on one hypothesis correction and one public cursor step", () =>
  withFixture(async (f) => {
    const source = f.hypothesisSource();
    const receipts = await Promise.all(Array.from({ length: 8 }, () => withdraw(f, source)));
    assert.equal(new Set(receipts.map((receipt) => receipt.event_id)).size, 1);
    assert.equal(count(f, "scientific_withdrawals"), 1);
    assert.equal(count(f, "retractions"), 1);
    assert.equal(row(f, "SELECT cursor FROM public_cursor")?.cursor, 1);
  }));

test("a lost committed acknowledgment recovers the same hypothesis correction", () =>
  withFixture(async (f) => {
    const source = f.hypothesisSource();
    f.loseAcknowledgment();
    const first = await withdraw(f, source);
    assert.deepEqual(await withdraw(f, source), first);
    assert.equal(f.counts.settlements, 0);
    assert.equal(count(f, "scientific_withdrawals"), 1);
  }));

for (const [label, mutation] of [
  ["credential revocation", "UPDATE fellow_tokens SET revoked_at=1"],
  ["session closure", "UPDATE sessions SET closed_at='closed'"],
  ["membership removal", "DELETE FROM problem_memberships"],
  [
    "source redaction",
    "UPDATE event_content SET redacted_at='hidden' WHERE event_id LIKE 'source-%'",
  ],
  [
    "source substitution",
    "UPDATE event_content SET payload_json='{}' WHERE event_id LIKE 'source-%'",
  ],
  [
    "late storage failure",
    `CREATE TRIGGER withdrawal_late_fault BEFORE INSERT ON scientific_withdrawals
      BEGIN SELECT RAISE(ABORT,'INJECTED_WITHDRAWAL_FAILURE'); END`,
  ],
] as const) {
  test(`${label} after screening rolls back correction, content, projections and cursor`, () =>
    withFixture(async (f) => {
      const source = f.hypothesisSource();
      const events = count(f, "events"),
        contents = count(f, "event_content"),
        beforeHead = head(f);
      f.before(() => f.sql.exec(mutation));
      await assert.rejects(withdraw(f, source));
      assert.equal(count(f, "events"), events);
      assert.equal(count(f, "event_content"), contents);
      assert.equal(count(f, "scientific_withdrawals"), 0);
      assert.equal(count(f, "retractions"), 0);
      assert.equal(count(f, "screening_publications"), 0);
      assert.deepEqual(head(f), beforeHead);
      assert.equal(row(f, "SELECT cursor FROM public_cursor")?.cursor, 0);
    }));
}

test("correcting evidence for an already eliminated route does not resurrect that route", () =>
  withFixture(async (f) => {
    const source = f.hypothesisSource();
    f.sql.exec(
      "UPDATE hypotheses SET status='killed',kill_event_id='original-kill',kill_source_seq=4",
    );
    const previous = f.sql.query("SELECT * FROM hypotheses").all();
    await withdraw(f, source);
    assert.deepEqual(f.sql.query("SELECT * FROM hypotheses").all(), previous);
  }));
