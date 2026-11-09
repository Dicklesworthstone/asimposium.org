import { afterEach, expect, test } from "bun:test";
import {
  AdminReportDetailSchema,
  ProblemDocumentSchema,
  ReportResponseSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { createEnrollmentRouter } from "../../src/enrollment/router.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
} from "../../src/enrollment/service.ts";
import { writeLedgerEvent } from "../../src/krater/krater.ts";
import { operatorReportsQueue } from "../../src/moderation/operator-http.ts";
import {
  captureReportSource,
  operatorReportDetail,
  ReportSourceUnavailableError,
  readOperatorReportDetail,
} from "../../src/moderation/report-detail.ts";
import { fileReportRequest } from "../../src/moderation/router.ts";
import { fileReport } from "../../src/moderation/store.ts";
import { resolveModerationTarget } from "../../src/moderation/target.ts";
import { PROBLEM, publicationContextFixture } from "../support/publication-context.ts";

type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});
const REPORTER = {
  reporterClass: "sponsor",
  reporterSponsorId: "usr_private_reporter",
  reporterFellowId: null,
} as const;
const NOTE = "PRIVATE-ALLEGATION: inspect <script>alert('reported')</script> as text.";

async function fixture() {
  const f = await publicationContextFixture();
  fixtures.push(f);
  let serial = 0;
  const publish = async (
    version = 1,
    body = `Original public claim version ${version}.`,
    type = version === 1 ? "claim.created" : "claim.revised",
  ) => {
    const input = f.command(f.input()).input;
    const eventId = `E-report-${++serial}`;
    return writeLedgerEvent(
      f.db,
      {
        ...input,
        eventId,
        idempotencyKey: eventId,
        eventType: type,
        objectKind: "claim",
        objectId: "C-1",
        objectVersion: version,
        payloadJson: JSON.stringify({
          claim_id: "C-1",
          statement: body,
          kind: "conjecture",
          falsifier: "A counterexample in the stated finite scope.",
          ...(version > 1 ? { base_version: version - 1 } : {}),
        }),
      },
      { statementsAfterEvent: () => [] },
    );
  };
  const report = async (target = "C-1@1", sponsor = REPORTER.reporterSponsorId) => {
    const response = await fileReportRequest(
      f.db,
      { ...REPORTER, reporterSponsorId: sponsor },
      {
        problem_id: PROBLEM,
        target,
        reason: "integrity",
        note: NOTE,
      },
    );
    expect(response.status).toBe(201);
    return ReportResponseSchema.parse(await response.json());
  };
  return { ...f, publish, report };
}

test("reported claim version remains exact through revisions, hiding and sponsor-family replay", async () => {
  const f = await fixture();
  const original = await f.publish(1);
  await f.publish(2, "NEWER-BODY-MUST-NOT-REPLACE-ORIGINAL");
  const receipt = await f.report();
  await f.publish(3, "LATEST-BODY-MUST-NOT-REPLACE-ORIGINAL");
  f.visible("C-1", "hidden");
  f.visible("problem", "hidden");
  const response = await operatorReportDetail(f.db, receipt.report_id);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  const detail = AdminReportDetailSchema.parse(await response.json());
  expect(detail.note).toBe(NOTE);
  expect(detail.target_ref).toBe("C-1");
  expect(detail.source).toMatchObject({
    state: "available",
    binding: "requested-version",
    requested_target: "C-1@1",
    event_id: original.eventId,
    object_version: 1,
  });
  expect(JSON.stringify(detail)).toContain("Original public claim version 1.");
  expect(JSON.stringify(detail)).not.toContain("MUST-NOT-REPLACE");
  expect(JSON.stringify(detail)).not.toContain(REPORTER.reporterSponsorId);
  const replay = await fileReportRequest(f.db, REPORTER, {
    problem_id: PROBLEM,
    target: "C-1@3",
    reason: "privacy",
    note: "A replay must not replace the original allegation or source.",
  });
  expect(replay.status).toBe(200);
  expect(ReportResponseSchema.parse(await replay.json()).report_id).toBe(receipt.report_id);
  expect(await readOperatorReportDetail(f.db, receipt.report_id)).toEqual(detail);
  const queue = JSON.stringify(await (await operatorReportsQueue(f.db)).json());
  expect(queue).not.toContain(NOTE);
  expect(queue).not.toContain("Original public claim");
  expect(queue).not.toContain("source_event_id");
});

test("unversioned reports retain the publication captured at filing without claiming an earlier viewport", async () => {
  const f = await fixture();
  await f.publish(1);
  const captured = await f.publish(2);
  const receipt = await f.report("C-1");
  await f.publish(3);
  const detail = await readOperatorReportDetail(f.db, receipt.report_id);
  expect(detail?.source).toMatchObject({
    state: "available",
    binding: "captured-at-filing",
    requested_target: "C-1",
    event_id: captured.eventId,
    object_version: 2,
  });
});

test("legacy reports remain explicitly unpinned even when a plausible current body exists", async () => {
  const f = await fixture();
  await f.publish(1);
  const receipt = await fileReport(f.db, {
    problemId: PROBLEM,
    targetKind: "claim",
    targetRef: "C-1",
    reason: "integrity",
    note: NOTE,
    ...REPORTER,
  });
  const detail = await readOperatorReportDetail(f.db, receipt.reportId);
  expect(detail?.source).toEqual({ state: "unavailable", reason: "not-pinned" });
  expect(JSON.stringify(detail)).not.toContain("Original public claim");
});

test("question reports capture authored lease details when that is the latest public event", async () => {
  const f = await fixture();
  for (const [eventId, type, payload] of [
    ["E-question-asked", "question.asked", { question: "Which finite boundary applies?" }],
    [
      "E-question-leased",
      "question.leased",
      { objective: "Examine the boundary.", deliverable: "Produce the exact witness." },
    ],
  ] as const) {
    await writeLedgerEvent(
      f.db,
      {
        ...f.command(f.input()).input,
        eventId,
        idempotencyKey: eventId,
        objectKind: "question",
        objectId: "Q-1",
        objectVersion: 1,
        eventType: type,
        payloadJson: JSON.stringify(payload),
      },
      { statementsAfterEvent: () => [] },
    );
  }
  const source = await captureReportSource(f.db, PROBLEM, "Q-1", "question");
  expect(source?.eventId).toBe("E-question-leased");
  expect(source?.payloadJson).toContain("Produce the exact witness.");
});

test("lawful source redaction withholds bytes and never falls forward to a newer version", async () => {
  const f = await fixture();
  const original = await f.publish();
  const receipt = await f.report();
  await f.publish(2, "NEWER-SOURCE-NOT-A-REPLACEMENT");
  f.sql
    .query(
      "UPDATE event_content SET payload_json='{}', redacted_at=?, redaction_reason='lawful test redaction' WHERE event_id=?",
    )
    .run(new Date().toISOString(), original.eventId);
  const detail = await readOperatorReportDetail(f.db, receipt.report_id);
  expect(detail?.source).toEqual({ state: "unavailable", reason: "redacted" });
  expect(JSON.stringify(detail)).not.toContain("NEWER-SOURCE");
  const replay = await fileReportRequest(f.db, REPORTER, {
    problem_id: PROBLEM,
    target: "C-1@1",
    reason: "integrity",
  });
  expect(replay.status).toBe(200);
  const fresh = await fileReportRequest(
    f.db,
    { ...REPORTER, reporterSponsorId: "usr_new_reporter" },
    {
      problem_id: PROBLEM,
      target: "C-1@1",
      reason: "integrity",
    },
  );
  expect(fresh.status).toBe(404);
  expect(ProblemDocumentSchema.parse(await fresh.json()).code).toBe("REPORT_TARGET_NOT_FOUND");
});

test("source capture cannot substitute an earlier readable publication for a redacted head", async () => {
  const f = await fixture();
  await f.publish(1);
  const latest = await f.publish(2);
  f.sql
    .query(
      "UPDATE event_content SET redacted_at=?, redaction_reason='test redaction' WHERE event_id=?",
    )
    .run(new Date().toISOString(), latest.eventId);
  expect(await captureReportSource(f.db, PROBLEM, "C-1", "claim")).toBeUndefined();
  expect((await captureReportSource(f.db, PROBLEM, "C-1@1", "claim"))?.requestedRef).toBe("C-1@1");
});

test("the report transaction rechecks source availability and retains no partial report or hide", async () => {
  const f = await fixture();
  const original = await f.publish();
  const source = await captureReportSource(f.db, PROBLEM, "C-1@1", "claim");
  expect(source).toBeDefined();
  f.sql
    .query(
      "UPDATE event_content SET redacted_at=?, redaction_reason='race before insert' WHERE event_id=?",
    )
    .run(new Date().toISOString(), original.eventId);
  await expect(
    fileReport(f.db, {
      problemId: PROBLEM,
      targetKind: "claim",
      targetRef: "C-1",
      reason: "integrity",
      note: NOTE,
      ...REPORTER,
      source,
      requireSource: true,
    }),
  ).rejects.toBeInstanceOf(ReportSourceUnavailableError);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM reports").get()).toEqual({ n: 0 });
  expect(f.sql.query("SELECT COUNT(*) AS n FROM content_controls").get()).toEqual({ n: 0 });
  expect(f.sql.query("SELECT COUNT(*) AS n FROM moderation_log").get()).toEqual({ n: 0 });
});

test("a conflicting published object kind cannot race capture into a whole-target report", async () => {
  const f = await fixture();
  const publish = async (kind: string, type: string) => {
    const eventId = `E-shared-id-${kind}`;
    return writeLedgerEvent(
      f.db,
      {
        ...f.command(f.input()).input,
        eventId,
        idempotencyKey: eventId,
        objectKind: kind,
        objectId: "R-1",
        objectVersion: 1,
        eventType: type,
        payloadJson: JSON.stringify({ body_md: "Published source." }),
      },
      { statementsAfterEvent: () => [] },
    );
  };
  await publish("review", "review.created");
  const source = await captureReportSource(f.db, PROBLEM, "R-1", "review");
  expect(source).toBeDefined();
  await publish("retraction", "object.retracted");
  await expect(
    fileReport(f.db, {
      problemId: PROBLEM,
      targetKind: "review",
      targetRef: "R-1",
      reason: "integrity",
      note: NOTE,
      ...REPORTER,
      source,
      requireSource: true,
    }),
  ).rejects.toBeInstanceOf(ReportSourceUnavailableError);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM reports").get()).toEqual({ n: 0 });
  expect(f.sql.query("SELECT COUNT(*) AS n FROM content_controls").get()).toEqual({ n: 0 });
});

test("immutable pins reject retargeting and incomplete or foreign source bindings", async () => {
  const f = await fixture();
  const original = await f.publish();
  const receipt = await f.report();
  for (const change of [
    "source_event_id=NULL",
    "source_ref='C-1@2'",
    "target_ref='C-2'",
    "source_digest='forged'",
  ]) {
    expect(() =>
      f.sql.query(`UPDATE reports SET ${change} WHERE report_id=?`).run(receipt.report_id),
    ).toThrow("REPORT_SOURCE_IMMUTABLE");
  }
  expect(() =>
    f.sql
      .query(`INSERT INTO reports(report_id,problem_id,target_kind,target_ref,reason,
    reporter_class,reporter_sponsor_id,status,created_at,source_event_id)
    VALUES('RP-invalid',?,'claim','C-1','integrity','sponsor','usr_invalid','pending',?,?)`)
      .run(PROBLEM, new Date().toISOString(), original.eventId),
  ).toThrow("REPORT_SOURCE_UNAVAILABLE");
  const indexes = f.sql.query("PRAGMA index_info(events_problem_object_seq_idx)").all() as {
    name: string;
  }[];
  expect(indexes.map((column) => column.name)).toEqual(["problem_id", "object_id", "seq"]);
});

test("corrupt bytes and a private-source producer never become operator evidence", async () => {
  const f = await fixture();
  const original = await f.publish();
  const receipt = await f.report();
  // Deliberately bypass the SQLite fixture guard to emulate retained storage corruption.
  f.sql.exec("DROP TRIGGER event_content_lawful_redaction_only");
  f.sql
    .query("UPDATE event_content SET payload_json=? WHERE event_id=?")
    .run('{"statement":"TAMPERED-UNCOMMITTED-BYTES"}', original.eventId);
  expect((await readOperatorReportDetail(f.db, receipt.report_id))?.source).toEqual({
    state: "unavailable",
    reason: "integrity-failed",
  });
  expect(await captureReportSource(f.db, PROBLEM, "C-1@1", "claim")).toBeUndefined();
  await f.publish(2, "PRIVATE-WORKSHOP-CANARY", "workshop.saved");
  expect(await captureReportSource(f.db, PROBLEM, "C-1@2", "claim")).toBeUndefined();
  expect(JSON.stringify(await readOperatorReportDetail(f.db, receipt.report_id))).not.toContain(
    "PRIVATE-WORKSHOP-CANARY",
  );
});

test("a redaction during operator read is caught by the final source witness", async () => {
  const f = await fixture();
  const original = await f.publish();
  const receipt = await f.report();
  const racingDb = {
    prepare(sql: string) {
      if (sql.startsWith("SELECT 1 AS available WHERE")) {
        f.sql
          .query(
            "UPDATE event_content SET redacted_at=?, redaction_reason='redacted during read' WHERE event_id=?",
          )
          .run(new Date().toISOString(), original.eventId);
      }
      return f.db.prepare(sql);
    },
  } as D1Database;
  const detail = await readOperatorReportDetail(racingDb, receipt.report_id);
  expect(detail?.source.state).toBe("unavailable");
  expect(JSON.stringify(detail)).not.toContain("Original public claim");
});

test("exact report HTTP authenticates the operator route/action and keeps every outcome private", async () => {
  const f = await fixture();
  await f.publish();
  const receipt = await f.report();
  const service = new EnrollmentService({
    stoaOrigin: "https://a.asimposium.org",
    agoraOrigin: "https://asimposium.org",
    replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32).fill(1)),
  });
  const verified: string[] = [];
  let wrongPrincipal = false;
  const app = createEnrollmentRouter({
    service,
    db: f.db,
    verifiedOperator: async (request, route, action) => {
      verified.push(`${route} ${action}`);
      return {
        principal: wrongPrincipal
          ? ({ type: "sponsor", sponsorId: "usr_imposter" } as const)
          : ({ type: "operator", operatorId: "usr_operator", serviceEnvelopeKid: "test" } as const),
        rawBody: new Uint8Array(await request.arrayBuffer()),
      };
    },
  });
  const path = `/v1/operators/reports/${receipt.report_id}`;
  const allowed = await app.request(`https://a.asimposium.org${path}`);
  expect(allowed.status).toBe(200);
  expect(AdminReportDetailSchema.parse(await allowed.json()).note).toBe(NOTE);
  expect(verified).toEqual(["/v1/operators/reports/:reportId operator.reports.read"]);
  const noAuth = createEnrollmentRouter({ service, db: f.db });
  const refusals = [
    await noAuth.request(`https://a.asimposium.org${path}`, {
      headers: { cookie: "operator=trusted", "x-operator-id": "usr_operator" },
    }),
    await app.request(`https://a.asimposium.org${path}?include=workshop`),
    await app.request(`https://a.asimposium.org/v1/operators/reports/RP-${"0".repeat(26)}`),
    await app.request(`https://a.asimposium.org${path}%0A`),
  ];
  wrongPrincipal = true;
  refusals.push(await app.request(`https://a.asimposium.org${path}`));
  for (const response of refusals) {
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const body = await response.json();
    expect(ProblemDocumentSchema.safeParse(body).success).toBe(true);
    expect(JSON.stringify(body)).not.toContain(NOTE);
    expect(JSON.stringify(body)).not.toContain("Original public claim");
  }
});

// Covers the narrow alias compatibility correction discovered after the tested
// suite: generic proof-gap leases coordinate a gap without republishing it.
test.each(["gap.filed", "lease.completed"])(
  "known proof_gap lease events preserve gap reportability; %s cannot masquerade as coordination",
  async (invalidType) => {
    const f = await fixture();
    let sequence = 0;
    const append = async (kind: string, type: string) => {
      const eventId = `E-gap-lease-alias-${++sequence}`;
      return writeLedgerEvent(
        f.db,
        {
          ...f.command(f.input()).input,
          eventId,
          idempotencyKey: eventId,
          objectKind: kind,
          objectId: "G-1",
          objectVersion: 1,
          eventType: type,
          payloadJson: JSON.stringify({ body_md: "The original published proof gap." }),
        },
        { statementsAfterEvent: () => [] },
      );
    };
    const filed = await append("gap", "gap.filed");
    for (const [index, type] of [
      "lease.acquired",
      "lease.released",
      "lease.challenged",
    ].entries()) {
      await append("proof_gap", type);
      expect(await resolveModerationTarget(f.db, PROBLEM, "G-1", "gap")).toEqual({
        problemId: PROBLEM,
        targetKind: "gap",
        targetRef: "G-1",
      });
      const response = await fileReportRequest(
        f.db,
        { ...REPORTER, reporterSponsorId: `usr_gap_reporter_${index}` },
        {
          problem_id: PROBLEM,
          target: "G-1",
          reason: "integrity",
          note: NOTE,
        },
      );
      expect(response.status).toBe(201);
      const receipt = ReportResponseSchema.parse(await response.json());
      expect((await readOperatorReportDetail(f.db, receipt.report_id))?.source).toMatchObject({
        state: "available",
        event_id: filed.eventId,
        event_type: "gap.filed",
      });
    }
    const source = await captureReportSource(f.db, PROBLEM, "G-1", "gap");
    expect(source?.eventId).toBe(filed.eventId);
    await append("proof_gap", invalidType);
    expect(await resolveModerationTarget(f.db, PROBLEM, "G-1", "gap")).toBeUndefined();
    await expect(
      fileReport(f.db, {
        problemId: PROBLEM,
        targetKind: "gap",
        targetRef: "G-1",
        reason: "integrity",
        note: NOTE,
        ...REPORTER,
        source,
        requireSource: true,
      }),
    ).rejects.toBeInstanceOf(ReportSourceUnavailableError);
  },
);
