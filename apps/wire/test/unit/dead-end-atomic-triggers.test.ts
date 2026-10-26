import { expect, test } from "bun:test";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import type { KraterAtomicSettlement } from "../../src/krater/krater.ts";
import { prepareDeadEndTriggers } from "../../src/ledger/dead-ends.ts";
import {
  foldScientificRows,
  prepareScientificDispositions,
  type ScientificRow,
} from "../../src/ledger/scientific-disposition.ts";
import { iso, NOW, SESSION, sha, withdrawalFixture } from "./scientific-withdrawal-fixture.ts";

// Actual SQL and the canonical scientific fold. Parent identity tables use the
// existing unit fixture; the corresponding publication lane runs on real D1.
function fixture(reaches = "corroborated") {
  const f = withdrawalFixture();
  // The shared fixture applies the real moderation content-control schema.
  f.sql.exec(`CREATE TABLE dead_ends(problem_id TEXT,dead_end_id TEXT,superseded_by TEXT);
    CREATE TABLE dead_end_fired_triggers(problem_id TEXT,dead_end_id TEXT,trigger_kind TEXT,
      event_id TEXT,reason TEXT,fired_at TEXT,PRIMARY KEY(problem_id,dead_end_id));`);
  f.append("DE-source", "dead_end.recorded", "dead_end", "DE-route", {
    retry_when: { kind: "claim-reaches", claim_id: "C-1", reaches },
  });
  f.sql.exec("INSERT INTO dead_ends VALUES('P-DEMO','DE-route',NULL)");
  const base = f.source("evidence", "E-base", { kind: "argument" });
  const through = (
    f.sql.query("SELECT public_seq FROM problems WHERE id='P-DEMO'").get() as { public_seq: number }
  ).public_seq;
  const pending = (
    offset: number,
    type: string,
    object: string,
    payload: Record<string, unknown>,
    author = "fellow-a",
    sponsor = "sponsor-a",
    createdAt = iso(),
  ): KraterAtomicSettlement => {
    const payloadJson = JSON.stringify(payload);
    return {
      sequence: through + offset,
      claimId: object,
      eventId: `pending-${object}`,
      event: {
        type,
        objectId: object,
        objectVersion: 1,
        payloadJson,
        payloadSha256: sha(payloadJson),
        createdAt,
        fellowId: author,
        sponsorId: sponsor,
      },
    };
  };
  const check = (offset = 1, claim = "C-1") =>
    pending(offset, "evidence.created", "E-check", {
      bears_on_kind: "claim",
      bears_on_id: claim,
      bears_on_version: 1,
      kind: "argument",
      direction: "informs",
      mode: "confirmatory",
      computed_class: "citation",
      body_md: "The boundary cases satisfy the claimed bound.",
      falsification_check: {
        target_digest: `sha256:${sha("statement")}`,
        attempted_falsifier: "Search n=0 for an output beyond the bound.",
        capable_of_failure: "The observed output could exceed the proposed bound.",
        result: "survived",
        evidence: [{ evidence_id: base.id, digest: base.request.source_digest }],
      },
    });
  const review = (offset = 2, object = "R-independent") =>
    pending(offset, "review.created", object, {
      target_claim_id: "C-1",
      target_version: 1,
      verdict: "confirm",
      capable_of_failure: "A boundary case might exceed the proposed bound.",
      tier: "T1",
      independence_policy: "declared-family-and-grounded-method-v1",
    });
  const insert = (settlement: KraterAtomicSettlement): D1PreparedStatement[] => {
    const event = settlement.event;
    if (!event) throw new Error("Fixture settlement needs its prospective event.");
    const payload = JSON.parse(event.payloadJson);
    const kind = event.type.split(".")[0] ?? "";
    const statements = [
      f.db.prepare("UPDATE problems SET public_seq=? WHERE id='P-DEMO'").bind(settlement.sequence),
      f.db
        .prepare("INSERT INTO events VALUES(?,'P-DEMO',?,?,?,?,?,?,?,?,?,?,?)")
        .bind(
          settlement.eventId,
          settlement.sequence,
          event.type,
          kind,
          event.objectId,
          event.objectVersion,
          event.payloadSha256,
          event.fellowId,
          event.sponsorId,
          SESSION,
          null,
          event.createdAt,
        ),
      f.db
        .prepare("INSERT INTO event_content VALUES(?,?,?,NULL)")
        .bind(settlement.eventId, event.payloadSha256, event.payloadJson),
    ];
    if (kind === "evidence")
      statements.push(
        f.db
          .prepare("INSERT INTO evidence VALUES('P-DEMO',?,?,?,?,?,?,?,?)")
          .bind(
            event.objectId,
            settlement.eventId,
            settlement.sequence,
            event.fellowId,
            payload.bears_on_kind,
            payload.bears_on_id,
            payload.bears_on_version,
            payload.direction,
          ),
      );
    if (kind === "review")
      statements.push(
        f.db
          .prepare("INSERT INTO reviews VALUES('P-DEMO',?,?,?,?,?,?,?,?)")
          .bind(
            event.objectId,
            settlement.eventId,
            settlement.sequence,
            event.fellowId,
            payload.target_claim_id,
            payload.target_version,
            payload.verdict,
            payload.capable_of_failure,
          ),
      );
    return statements;
  };
  return { ...f, base, pending, check, review, insert };
}

test("a later batch review sees the earlier falsification attempt and fires one scientific transition", async () => {
  const f = fixture();
  try {
    const check = f.check(),
      review = f.review(),
      repeat = f.review(3, "R-repeat");
    expect(await prepareDeadEndTriggers(f.db, "P-DEMO", review)).toEqual([]);
    const first = await prepareDeadEndTriggers(f.db, "P-DEMO", check);
    const second = await prepareDeadEndTriggers(f.db, "P-DEMO", review, [check]);
    const third = await prepareDeadEndTriggers(f.db, "P-DEMO", repeat, [check, review]);
    expect(first).toEqual([]);
    expect(second.length).toBeGreaterThan(0);
    expect(third).toEqual([]);
    await f.db.batch([
      ...f.insert(check),
      ...first,
      ...f.insert(review),
      ...second,
      ...f.insert(repeat),
      ...third,
    ]);
    const rows = await prepareScientificDispositions(f.db, "P-DEMO", 100, 1, {
      claimId: "C-1",
      version: 1,
    }).all<ScientificRow>();
    expect((await foldScientificRows(rows.results)).disposition).toBe("corroborated");
    expect(f.sql.query("SELECT dead_end_id,event_id FROM dead_end_fired_triggers").all()).toEqual([
      { dead_end_id: "DE-route", event_id: review.eventId },
    ]);
  } finally {
    f.close();
  }
});

test("a batch member about another claim cannot supply this claim's falsification attempt", async () => {
  const f = fixture();
  try {
    expect(
      await prepareDeadEndTriggers(f.db, "P-DEMO", f.review(), [f.check(1, "C-OTHER")]),
    ).toEqual([]);
  } finally {
    f.close();
  }
});

test("changed consumed content aborts the entire prepared scientific transition", async () => {
  for (const change of ["redact", "replace"]) {
    const f = fixture();
    try {
      const check = f.check(),
        review = f.review();
      const firing = await prepareDeadEndTriggers(f.db, "P-DEMO", review, [check]);
      expect(firing.length).toBeGreaterThan(0);
      f.sql
        .query(
          change === "redact"
            ? "UPDATE event_content SET redacted_at='withdrawn' WHERE event_id=?"
            : "UPDATE event_content SET payload_json='{}' WHERE event_id=?",
        )
        .run(f.base.event.id);
      await expect(
        f.db.batch([...f.insert(check), ...f.insert(review), ...firing]),
      ).rejects.toThrow("SCIENTIFIC_REFERENCE_CHANGED");
      expect(f.sql.query("SELECT id FROM events WHERE id LIKE 'pending-%'").all()).toEqual([]);
      expect(f.sql.query("SELECT * FROM dead_end_fired_triggers").all()).toEqual([]);
    } finally {
      f.close();
    }
  }
});

test("the prospective immutable review time can settle a refutation at exactly 72 hours", async () => {
  for (const elapsed of [72 * 3600000 - 1, 72 * 3600000]) {
    const f = fixture("refuted");
    try {
      const counter = f.source(
        "evidence",
        "E-counter",
        { direction: "refutes", computed_class: "computation" },
        "fellow-c",
      );
      const review = f.pending(
        2,
        "review.created",
        "R-refutation",
        {
          target_claim_id: "C-1",
          target_version: 1,
          verdict: "refute",
          tier: "T1",
          capable_of_failure: "The counterexample might not satisfy a stated hypothesis.",
          independence_policy: "declared-family-and-grounded-method-v1",
          verification: {
            kind: "refutation",
            target_digest: `sha256:${sha("statement")}`,
            evidence: { evidence_id: counter.id, digest: counter.request.source_digest },
            coverage: ["The hypotheses hold at the counterexample.", "The conclusion fails."],
            result: "verified",
          },
        },
        "fellow-a",
        "sponsor-a",
        iso(NOW + elapsed),
      );
      const prepared = await prepareDeadEndTriggers(f.db, "P-DEMO", review);
      expect(prepared.length > 0).toBe(elapsed === 72 * 3600000);
    } finally {
      f.close();
    }
  }
});
