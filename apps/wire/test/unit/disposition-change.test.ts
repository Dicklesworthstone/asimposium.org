import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ClaimDependencyPin } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import {
  DISPOSITION_CHANGE_DEPENDENT_LIMIT,
  DISPOSITION_CHANGE_RECIPIENT_LIMIT,
  deliverDispositionChanges,
} from "../../src/inbox/disposition-change.ts";
import { withdrawScientificInput } from "../../src/ledger/scientific-withdrawals.ts";
import { NOW, SESSION, sha, withdrawalFixture } from "./scientific-withdrawal-fixture.ts";

type Fixture = ReturnType<typeof withdrawalFixture>;

/** The real notification/withdrawal SQL on a modeled SQLite parent fixture.
 * This is unit coverage; the dispositions lane exercises Workerd bindings. */
async function using(run: (fixture: Fixture) => Promise<void>) {
  const f = withdrawalFixture();
  try {
    for (const migration of [
      "0064_inbox_and_follows.sql",
      "0083_disposition_change_deliveries.sql",
      "0127_disposition_dependency_fanout.sql",
    ])
      f.sql.exec(
        readFileSync(new URL(`../../../../db/migrations/${migration}`, import.meta.url), "utf8"),
      );
    f.sql.exec("INSERT INTO enrollment_fellows VALUES('fellow-b','sponsor-b','active')");
    await run(f);
  } finally {
    f.close();
  }
}

function notices(f: Fixture) {
  return f.sql
    .query(`SELECT fellow_id,title,detail,target_id,caused_by_event_id
    FROM fellow_inbox_notices WHERE notice_type='disposition_change' ORDER BY fellow_id,seq`)
    .all() as {
    fellow_id: string;
    title: string;
    detail: string;
    target_id: string;
    caused_by_event_id: string;
  }[];
}

function retractClaim(f: Fixture, target = "C-1") {
  const event = f.append(
    "claim-correction",
    "object.retracted",
    "retraction",
    "R-correction",
    {
      retraction_id: "R-correction",
      target_object: target,
      retraction_kind: "self-corrected",
      reason: "WITHDRAWAL-REASON-PRIVATE-SENTINEL",
    },
    "fellow-b",
  );
  f.sql
    .query(`INSERT INTO retractions VALUES('P-DEMO','R-correction',?,?,'self-corrected',
    'WITHDRAWAL-REASON-PRIVATE-SENTINEL','fellow-b',?)`)
    .run(event.seq, target, new Date(NOW).toISOString());
  return event;
}

function premisePublications(f: Fixture) {
  f.sql.exec(
    "ALTER TABLE events ADD COLUMN model_string_self_declared TEXT; ALTER TABLE events ADD COLUMN harness TEXT;",
  );
  const statement = "Every n has the stated bound.";
  const content = JSON.stringify({
    claim_id: "C-1",
    statement,
    kind: "conjecture",
    falsifier: "Counterexample",
    dependency_pins: [],
  });
  const digest = sha(content),
    contentDigest = `sha256:${sha(statement)}`;
  f.sql.query("UPDATE events SET payload_sha256=? WHERE id='E-claim'").run(digest);
  f.sql
    .query("UPDATE event_content SET payload_sha256=?,payload_json=? WHERE event_id='E-claim'")
    .run(digest, content);
  f.sql.query("UPDATE claim_versions SET content_digest=? WHERE claim_id='C-1'").run(contentDigest);
  const leaf: ClaimDependencyPin = {
    claim_id: "C-1",
    version: 1,
    event_id: "E-claim",
    payload_digest: digest,
    content_digest: contentDigest,
  };
  const add = (
    claimId: string,
    pins: ClaimDependencyPin[] = [],
    version = 1,
    author = "fellow-b",
  ) => {
    const statement = `Published ${claimId}@${version} statement.`;
    const event = f.append(
      `${claimId}-v${version}`,
      version === 1 ? "claim.created" : "claim.revised",
      "claim",
      claimId,
      {
        claim_id: claimId,
        statement,
        kind: "lemma",
        falsifier: "Counterexample",
        dependency_pins: pins,
        ...(version > 1 ? { base_version: version - 1 } : {}),
      },
      author,
      "P-DEMO",
      version,
    );
    const contentDigest = `sha256:${sha(statement)}`;
    f.sql
      .query("INSERT INTO claim_versions VALUES('P-DEMO',?,?,?,?, 'lemma')")
      .run(claimId, version, contentDigest, statement);
    if (version === 1)
      f.sql.query("INSERT INTO claims VALUES('P-DEMO',?,?)").run(claimId, event.seq);
    return {
      claim_id: claimId,
      version,
      event_id: event.id,
      payload_digest: event.digest,
      content_digest: contentDigest,
    } satisfies ClaimDependencyPin;
  };
  return { leaf, add };
}

test("one premise revision notifies direct, transitive and diamond dependents exactly once per claim", () =>
  using(async (f) => {
    const p = premisePublications(f);
    const left = p.add("C-2", [p.leaf]),
      right = p.add("C-3", [p.leaf]);
    p.add("C-4", [left, right]);
    const cause = p.add("C-1", [], 2, "fellow-a");
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      notices: 3,
      failed: 0,
      pending: 0,
    });
    expect(notices(f).map((notice) => [notice.fellow_id, notice.target_id])).toEqual([
      ["fellow-b", "C-2"],
      ["fellow-b", "C-3"],
      ["fellow-b", "C-4"],
    ]);
    for (const notice of notices(f)) {
      expect(notice.caused_by_event_id).toBe(cause.event_id);
      expect(notice.detail).toContain("displayed disposition is open");
      expect(notice.detail).toContain("stale false → true");
    }
    expect(await deliverDispositionChanges(f.db)).toMatchObject({ examined: 0, notices: 0 });
  }));

for (const cause of ["refutation", "retraction"] as const) {
  test(`${cause} of a premise delivers dependent repair notices without changing their dispositions`, () =>
    using(async (f) => {
      const p = premisePublications(f);
      const author = cause === "retraction" ? "fellow-a" : "fellow-b";
      p.add("C-3", [p.add("C-2", [p.leaf], 1, author)], 1, author);
      if (cause === "refutation")
        f.source("evidence", "E-refutation", {
          direction: "refutes",
          computed_class: "computation",
        });
      else retractClaim(f);
      expect(await deliverDispositionChanges(f.db)).toMatchObject({ failed: 0, pending: 0 });
      const dependents = notices(f).filter((notice) => notice.target_id !== "C-1");
      expect(dependents.map((notice) => notice.target_id)).toEqual(["C-2", "C-3"]);
      for (const notice of dependents) {
        expect(notice.detail).toContain("displayed disposition is open");
        expect(notice.detail).toContain("stale false → true");
      }
    }));
}

test("the global dependent page bound advances through unchanged claims and drains later repairs", () =>
  using(async (f) => {
    const p = premisePublications(f),
      unaffected = p.add("C-99");
    for (let index = 0; index < DISPOSITION_CHANGE_DEPENDENT_LIMIT; index++)
      p.add(`C-${100 + index}`, [unaffected]);
    p.add("C-2", [p.leaf]);
    const cause = p.add("C-1", [], 2, "fellow-a");
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      notices: 0,
      failed: 0,
      pending: 1,
    });
    expect(
      f.sql
        .query(
          "SELECT state,direct_complete,dependent_after_seq FROM disposition_change_deliveries WHERE event_id=?",
        )
        .get(cause.event_id),
    ).toEqual({
      state: "pending",
      direct_complete: 1,
      dependent_after_seq: DISPOSITION_CHANGE_DEPENDENT_LIMIT + 2,
    });
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      notices: 1,
      failed: 0,
      pending: 0,
    });
    expect(notices(f).map((notice) => notice.target_id)).toEqual(["C-2"]);
    expect(await deliverDispositionChanges(f.db)).toMatchObject({ examined: 0, notices: 0 });
  }));

test("delayed fanout assesses the exact cause cut and never retargets a later dependent revision", () =>
  using(async (f) => {
    const p = premisePublications(f);
    p.add("C-2", [p.leaf]);
    const cause = p.add("C-1", [], 2, "fellow-a");
    const later = p.add("C-2", [], 2);
    p.add("C-3", [p.leaf]);
    f.sql
      .query("UPDATE disposition_change_deliveries SET state='unchanged' WHERE event_id=?")
      .run(later.event_id);
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      notices: 1,
      failed: 0,
      pending: 0,
    });
    expect(notices(f)).toMatchObject([
      {
        target_id: "C-2",
        caused_by_event_id: cause.event_id,
        title: "C-2@1 scientific standing updated",
      },
    ]);
    expect(notices(f)[0]?.detail).toContain("ledger sequence 3");
    expect(notices(f)[0]?.detail).toContain("stale false → true");
  }));

test("lawful cause-body removal between dependent pages preserves the validated repair target", () =>
  using(async (f) => {
    const p = premisePublications(f);
    for (let index = 0; index <= DISPOSITION_CHANGE_DEPENDENT_LIMIT; index++)
      p.add(`C-${index + 2}`, [p.leaf]);
    const cause = f.source("evidence", "E-fanout", {
      direction: "refutes",
      computed_class: "computation",
    });
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      notices: DISPOSITION_CHANGE_DEPENDENT_LIMIT + 1,
      failed: 0,
      pending: 1,
    });
    expect(
      f.sql
        .query(
          "SELECT target_claim_id,target_version,target_payload_sha256 FROM disposition_change_deliveries WHERE event_id=?",
        )
        .get(cause.event.id),
    ).toEqual({
      target_claim_id: "C-1",
      target_version: Number.MAX_SAFE_INTEGER,
      target_payload_sha256: cause.event.digest,
    });
    f.sql
      .query("UPDATE event_content SET payload_json='{}',redacted_at=? WHERE event_id=?")
      .run(new Date(NOW).toISOString(), cause.event.id);
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      notices: 1,
      failed: 0,
      quarantined: 0,
      pending: 0,
    });
    expect(notices(f)).toHaveLength(DISPOSITION_CHANGE_DEPENDENT_LIMIT + 2);
    const last = notices(f).at(-1);
    expect(last?.target_id).toBe(`C-${DISPOSITION_CHANGE_DEPENDENT_LIMIT + 2}`);
    expect(last?.caused_by_event_id).toBe(cause.event.id);
    expect(last?.detail).toContain("stale false → true");
    expect(await deliverDispositionChanges(f.db)).toMatchObject({ examined: 0, notices: 0 });
  }));

test("a pinned continuation cannot be reused after its cause digest changes", () =>
  using(async (f) => {
    const p = premisePublications(f);
    for (let index = 0; index <= DISPOSITION_CHANGE_DEPENDENT_LIMIT; index++)
      p.add(`C-${index + 2}`, [p.leaf]);
    const cause = p.add("C-1", [], 2, "fellow-a");
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      notices: DISPOSITION_CHANGE_DEPENDENT_LIMIT,
      failed: 0,
      pending: 1,
    });
    f.sql
      .query("UPDATE events SET payload_sha256=? WHERE id=?")
      .run("a".repeat(64), cause.event_id);
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      notices: 0,
      failed: 0,
      quarantined: 1,
    });
    expect(notices(f)).toHaveLength(DISPOSITION_CHANGE_DEPENDENT_LIMIT);
  }));

test("partial dependent recipients do not advance the claim page or suppress the next dependent", () =>
  using(async (f) => {
    const p = premisePublications(f),
      middle = p.add("C-2", [p.leaf]);
    p.add("C-3", [middle]);
    const reviewers = DISPOSITION_CHANGE_RECIPIENT_LIMIT + 3;
    for (let index = 0; index < reviewers; index++) {
      const fellow = `reviewer-${String(index).padStart(3, "0")}`;
      f.sql
        .query("INSERT INTO enrollment_fellows VALUES(?,?,'active')")
        .run(fellow, `sponsor-${index}`);
      const review = f.source("review", `R-${index + 1}`, { target_claim_id: "C-2" }, fellow);
      f.sql
        .query("UPDATE reviews SET target_claim_id='C-2' WHERE source_event_id=?")
        .run(review.event.id);
    }
    f.sql.exec("UPDATE disposition_change_deliveries SET state='unchanged'");
    const cause = p.add("C-1", [], 2, "fellow-a");
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      notices: DISPOSITION_CHANGE_RECIPIENT_LIMIT,
      failed: 0,
      pending: 1,
    });
    expect(
      f.sql
        .query("SELECT dependent_after_seq FROM disposition_change_deliveries WHERE event_id=?")
        .get(cause.event_id),
    ).toEqual({ dependent_after_seq: 0 });
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      notices: 5,
      failed: 0,
      pending: 0,
    });
    expect(notices(f)).toHaveLength(reviewers + 2);
    expect(
      new Set(notices(f).map((notice) => `${notice.fellow_id}:${notice.target_id}`)).size,
    ).toBe(reviewers + 2);
    expect(await deliverDispositionChanges(f.db)).toMatchObject({ examined: 0, notices: 0 });
  }));

test("a failed dependent delivery resumes after the last committed claim without skipping or duplicating repairs", () =>
  using(async (f) => {
    const p = premisePublications(f);
    const first = p.add("C-2", [p.leaf]);
    p.add("C-3", [p.leaf]);
    const cause = p.add("C-1", [], 2, "fellow-a");
    const inserts = new WeakSet<object>();
    let deliveries = 0;
    const interrupted = {
      prepare(sql: string) {
        const statement = f.db.prepare(sql);
        if (sql.includes("INSERT INTO fellow_inbox_notices")) inserts.add(statement);
        return statement;
      },
      async batch(statements: Parameters<D1Database["batch"]>[0]) {
        if (statements.some((statement) => inserts.has(statement)) && ++deliveries === 2)
          throw new Error("Injected failure before the second dependent commits");
        return f.db.batch(statements);
      },
    } as unknown as D1Database;
    expect(await deliverDispositionChanges(interrupted)).toMatchObject({
      notices: 1,
      failed: 1,
      pending: 1,
    });
    expect(notices(f).map((notice) => notice.target_id)).toEqual(["C-2"]);
    expect(
      f.sql
        .query(
          "SELECT state,dependent_after_seq FROM disposition_change_deliveries WHERE event_id=?",
        )
        .get(cause.event_id),
    ).toEqual({
      state: "pending",
      dependent_after_seq: (
        f.sql.query("SELECT seq FROM events WHERE id=?").get(first.event_id) as { seq: number }
      ).seq,
    });
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      notices: 1,
      failed: 0,
      pending: 0,
    });
    expect(notices(f).map((notice) => notice.target_id)).toEqual(["C-2", "C-3"]);
    expect(await deliverDispositionChanges(f.db)).toMatchObject({ examined: 0, notices: 0 });
  }));

for (const control of ["recipient", "claim", "problem"] as const) {
  test(`current ${control} authorization is checked again when dependent notices commit`, () =>
    using(async (f) => {
      const p = premisePublications(f);
      p.add("C-2", [p.leaf]);
      p.add("C-1", [], 2, "fellow-a");
      const inserts = new WeakSet<object>();
      const racing = {
        prepare(sql: string) {
          const statement = f.db.prepare(sql);
          if (sql.includes("INSERT INTO fellow_inbox_notices")) inserts.add(statement);
          return statement;
        },
        async batch(statements: Parameters<D1Database["batch"]>[0]) {
          if (statements.some((statement) => inserts.has(statement))) {
            if (control === "recipient")
              f.sql.exec(
                "UPDATE enrollment_fellows SET status='revoked' WHERE fellow_id='fellow-b'",
              );
            else if (control === "problem")
              f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'");
            else
              f.sql.exec(
                "INSERT INTO content_controls VALUES('CC-fanout','P-DEMO','claim','C-2','hidden','operator','test','operator','test',1,'2026-10-01T00:00:00.000Z')",
              );
          }
          return f.db.batch(statements);
        },
      } as unknown as D1Database;
      expect(await deliverDispositionChanges(racing)).toMatchObject({ notices: 0, failed: 0 });
      expect(notices(f)).toHaveLength(0);
    }));
}

test("refuter-first display and review facets notify the author without asserting corroboration", () =>
  using(async (f) => {
    f.source("review", "R-1");
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      changed: 1,
      notices: 1,
      quarantined: 0,
      failed: 0,
    });
    expect(notices(f)).toMatchObject([
      {
        fellow_id: "fellow-b",
        target_id: "C-1",
        title: "C-1 is now open · unchallenged",
      },
    ]);
    expect(notices(f)[0]?.detail).not.toContain("corroborated");
    expect(await deliverDispositionChanges(f.db)).toMatchObject({ examined: 0, notices: 0 });
  }));

test("canonical author retraction notifies prior reviewers, never the retracting author", () =>
  using(async (f) => {
    f.source("review", "R-1");
    f.sql.exec("UPDATE disposition_change_deliveries SET state='unchanged'");
    const event = retractClaim(f);
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      changed: 1,
      notices: 1,
      quarantined: 0,
      failed: 0,
    });
    expect(notices(f)).toMatchObject([
      {
        fellow_id: "fellow-a",
        title: "C-1 is now withdrawn",
        target_id: "C-1",
        caused_by_event_id: event.id,
      },
    ]);
    expect(JSON.stringify(notices(f))).not.toContain("WITHDRAWAL-REASON-PRIVATE-SENTINEL");
  }));

test("a correction index detached from its digest-bound target cannot route a notice", () =>
  using(async (f) => {
    f.source("review", "R-1");
    f.sql.exec("UPDATE disposition_change_deliveries SET state='unchanged'");
    retractClaim(f);
    f.sql.exec("UPDATE retractions SET target_object='C-2' WHERE retraction_id='R-correction'");
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      changed: 0,
      notices: 0,
      quarantined: 1,
      failed: 0,
    });
    expect(notices(f)).toHaveLength(0);
  }));

for (const kind of ["review", "evidence"] as const) {
  test(`${kind} withdrawal notifies lost support or new staleness and is replay-safe`, () =>
    using(async (f) => {
      const source = f.source(kind, kind === "review" ? "R-1" : "E-1");
      f.sql.exec("UPDATE disposition_change_deliveries SET state='unchanged'");
      const withdrawn = await withdrawScientificInput(
        f.options,
        f.actor,
        SESSION,
        kind,
        source.id,
        source.request,
        "withdraw-notice",
      );
      expect(await deliverDispositionChanges(f.db)).toMatchObject({
        changed: 1,
        notices: 1,
        quarantined: 0,
        failed: 0,
      });
      const [notice] = notices(f);
      expect(notice).toMatchObject({
        fellow_id: "fellow-b",
        target_id: "C-1",
        caused_by_event_id: withdrawn.event_id,
      });
      expect(notice?.title).toBe(
        kind === "review" ? "C-1 is now open" : "C-1 scientific standing updated",
      );
      if (kind === "evidence") expect(notice?.detail).toContain("stale false → true");
      expect(notice?.detail).not.toContain(source.request.reason);
      expect(
        await withdrawScientificInput(
          f.options,
          f.actor,
          SESSION,
          kind,
          source.id,
          source.request,
          "withdraw-notice",
        ),
      ).toEqual(withdrawn);
      expect(await deliverDispositionChanges(f.db)).toMatchObject({ examined: 0, notices: 0 });
      expect(notices(f)).toHaveLength(1);
    }));
}

test("withdrawn negative evidence remains a dispute while its new staleness is delivered", () =>
  using(async (f) => {
    const source = f.source("evidence", "E-1", { direction: "refutes" });
    f.sql.exec("UPDATE disposition_change_deliveries SET state='unchanged'");
    await withdrawScientificInput(
      f.options,
      f.actor,
      SESSION,
      "evidence",
      source.id,
      source.request,
      "negative-withdrawal",
    );
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      changed: 1,
      notices: 1,
      failed: 0,
    });
    expect(notices(f)[0]).toMatchObject({ title: "C-1 scientific standing updated" });
    expect(notices(f)[0]?.detail).toContain("displayed disposition is disputed");
    expect(notices(f)[0]?.detail).toContain("stale false → true");
  }));

test("a removed withdrawal explanation does not resurrect support or suppress its safe notice", () =>
  using(async (f) => {
    const source = f.source("review", "R-1");
    f.sql.exec("UPDATE disposition_change_deliveries SET state='unchanged'");
    const withdrawn = await withdrawScientificInput(
      f.options,
      f.actor,
      SESSION,
      "review",
      source.id,
      source.request,
      "redacted-withdrawal",
    );
    f.sql
      .query("UPDATE event_content SET redacted_at=? WHERE event_id=?")
      .run(new Date(NOW).toISOString(), withdrawn.event_id);
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      changed: 1,
      notices: 1,
      quarantined: 0,
      failed: 0,
    });
    expect(notices(f)[0]?.title).toBe("C-1 is now open");
  }));

test("withdrawing evidence for an old version never announces a change to the current version", () =>
  using(async (f) => {
    const source = f.source("evidence", "E-1");
    f.append(
      "claim-revision",
      "claim.revised",
      "claim",
      "C-1",
      {
        claim_id: "C-1",
        statement: "The revised bounded statement.",
      },
      "fellow-b",
      "P-DEMO",
      2,
    );
    f.sql
      .query("INSERT INTO claim_versions VALUES('P-DEMO','C-1',2,?,?,'conjecture')")
      .run(`sha256:${"1".repeat(64)}`, "The revised bounded statement.");
    f.sql.exec("UPDATE disposition_change_deliveries SET state='unchanged'");
    await withdrawScientificInput(
      f.options,
      f.actor,
      SESSION,
      "evidence",
      source.id,
      source.request,
      "old-version-withdrawal",
    );
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      changed: 0,
      notices: 0,
      unchanged: 1,
      quarantined: 0,
      failed: 0,
    });
    expect(notices(f)).toHaveLength(0);
  }));

test("digest-detached targets cannot route a notification", () =>
  using(async (f) => {
    const source = f.source("review", "R-1");
    f.sql
      .query(
        "UPDATE event_content SET payload_json=replace(payload_json,'C-1','C-2') WHERE event_id=?",
      )
      .run(source.event.id);
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      changed: 0,
      notices: 0,
      quarantined: 1,
      failed: 0,
    });
  }));

for (const corruption of ["digest", "author"] as const) {
  test(`a withdrawal with a detached source ${corruption} cannot route a claim notice`, () =>
    using(async (f) => {
      const source = f.source("evidence", "E-1");
      f.sql.exec("UPDATE disposition_change_deliveries SET state='unchanged'");
      await withdrawScientificInput(
        f.options,
        f.actor,
        SESSION,
        "evidence",
        source.id,
        source.request,
        `detached-${corruption}`,
      );
      if (corruption === "digest")
        f.sql
          .query("UPDATE events SET payload_sha256=? WHERE id=?")
          .run("a".repeat(64), source.event.id);
      else
        f.sql.query("UPDATE events SET actor_fellow_id='fellow-b' WHERE id=?").run(source.event.id);
      expect(await deliverDispositionChanges(f.db)).toMatchObject({
        changed: 0,
        notices: 0,
        quarantined: 1,
        failed: 0,
      });
      expect(notices(f)).toHaveLength(0);
    }));
}

test("recipient bounds continue until every prior reviewer is informed without duplicate notices", () =>
  using(async (f) => {
    const reviewers = DISPOSITION_CHANGE_RECIPIENT_LIMIT + 3;
    for (let index = 0; index < reviewers; index++) {
      const fellow = `reviewer-${String(index).padStart(3, "0")}`;
      f.sql
        .query("INSERT INTO enrollment_fellows VALUES(?,?,'active')")
        .run(fellow, `sponsor-${index}`);
      f.source("review", `R-${index + 1}`, {}, fellow);
    }
    f.sql.exec("UPDATE disposition_change_deliveries SET state='unchanged'");
    retractClaim(f);
    expect(await deliverDispositionChanges(f.db)).toMatchObject({
      notices: DISPOSITION_CHANGE_RECIPIENT_LIMIT,
      failed: 0,
    });
    expect(
      f.sql
        .query("SELECT state FROM disposition_change_deliveries WHERE event_id='claim-correction'")
        .get(),
    ).toEqual({ state: "pending" });
    expect(await deliverDispositionChanges(f.db)).toMatchObject({ notices: 3, failed: 0 });
    expect(notices(f)).toHaveLength(reviewers);
    expect(new Set(notices(f).map((notice) => notice.fellow_id)).size).toBe(reviewers);
    expect(await deliverDispositionChanges(f.db)).toMatchObject({ examined: 0, notices: 0 });
  }));

test("delivery failure leaves the job pending and a retry preserves one causal notice", () =>
  using(async (f) => {
    f.source("review", "R-1");
    f.sql.exec("UPDATE disposition_change_deliveries SET state='unchanged'");
    retractClaim(f);
    const failing = {
      prepare: f.db.prepare.bind(f.db),
      batch: async () => {
        throw new Error("database unavailable");
      },
    } as unknown as D1Database;
    expect(await deliverDispositionChanges(failing)).toMatchObject({ failed: 1, notices: 0 });
    expect(notices(f)).toHaveLength(0);
    expect(await deliverDispositionChanges(f.db)).toMatchObject({ failed: 0, notices: 1 });
    expect(await deliverDispositionChanges(f.db)).toMatchObject({ examined: 0, notices: 0 });
  }));
