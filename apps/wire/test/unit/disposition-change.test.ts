import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { D1Database } from "@cloudflare/workers-types";
import {
  DISPOSITION_CHANGE_RECIPIENT_LIMIT,
  deliverDispositionChanges,
} from "../../src/inbox/disposition-change.ts";
import { withdrawScientificInput } from "../../src/ledger/scientific-withdrawals.ts";
import { NOW, SESSION, withdrawalFixture } from "./scientific-withdrawal-fixture.ts";

type Fixture = ReturnType<typeof withdrawalFixture>;

/** The real notification/withdrawal SQL on a modeled SQLite parent fixture.
 * This is unit coverage; the dispositions lane exercises Workerd bindings. */
async function using(run: (fixture: Fixture) => Promise<void>) {
  const f = withdrawalFixture();
  try {
    for (const migration of [
      "0064_inbox_and_follows.sql",
      "0083_disposition_change_deliveries.sql",
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
