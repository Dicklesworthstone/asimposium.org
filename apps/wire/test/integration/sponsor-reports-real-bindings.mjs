import assert from "node:assert/strict";
import {
  ProblemDocumentSchema,
  ReportResponseSchema,
  SponsorReportsRequestSchema,
  SponsorReportsResponseSchema,
  sponsorReportsMatchRequest,
} from "@asimposium/contracts";
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "../../../web/lib/service-envelope.ts";
import { LOCAL_OPERATOR_ID, runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Real signed HTTP and Fellow report submissions against migrated Workerd/D1.
// Enrollment uses the shared local approval fixture; this is not an OAuth proof.
await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, operatorCall, env, worker, origin, userAgent }) => {
    const authorSponsor = "usr_report_history_author";
    const secondAuthorSponsor = "usr_report_history_second_author";
    const owner = "usr_report_history_owner";
    const recipient = "usr_report_history_recipient";
    const author = await enroll("report-history-author", authorSponsor);
    const secondAuthor = await enroll("report-history-second-author", secondAuthorSponsor);
    const reporter = await enroll("report-history-fellow", owner);
    await enroll("report-history-recipient", recipient);
    const reporterId = (await call("/v1/hello", undefined, reporter)).fellow.fellow_id;
    const route = "/v1/sponsors/reports/list";
    const action = "sponsor.reports.list";
    const privateNotes = [
      "PRIVATE_HUMAN_REPORT_NOTE: inspect the first paragraph.",
      "PRIVATE_FELLOW_REPORT_NOTE: inspect the final paragraph.",
      "PRIVATE_PENDING_REPORT_NOTE: inspect the statement heading.",
      "PRIVATE_OTHER_SPONSOR_NOTE: inspect the citation location.",
    ];
    const decisionReasons = [
      "PRIVATE_DISMISSAL_REASON: reviewed the cited location; no issue remains.",
      "PRIVATE_UPHOLD_REASON: reviewed the location and confirmed the concern.",
    ];
    const privateFields = [
      "note",
      "resolved_by",
      "resolution_reason",
      "reporter_fellow_id",
      "reporter_sponsor_id",
    ];
    const assertPrivate = (value) => {
      const text = JSON.stringify(value);
      for (const secret of [...privateNotes, ...decisionReasons, reporterId, LOCAL_OPERATOR_ID]) {
        assert.ok(!text.includes(secret), "report history never includes private case material");
      }
      for (const report of value.reports) {
        for (const field of privateFields) assert.ok(!(field in report));
      }
    };
    const read = async (body = {}, sponsor = owner) => {
      const request = SponsorReportsRequestSchema.parse(body);
      const page = SponsorReportsResponseSchema.parse(
        await sponsorCall(sponsor, "POST", route, action, body),
      );
      assert.equal(sponsorReportsMatchRequest(sponsor, request, page), true);
      assertPrivate(page);
      return page;
    };
    const state = async () => ({
      reports: (await env.DB.prepare("SELECT * FROM reports ORDER BY report_id").all()).results,
      events: await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first(),
      audits: await env.DB.prepare("SELECT COUNT(*) AS n FROM operator_audit").first(),
      log: await env.DB.prepare("SELECT COUNT(*) AS n FROM moderation_log").first(),
    });

    const empty = await read();
    assert.deepEqual(empty.reports, []);
    assert.equal(empty.has_more, false);
    assert.equal(empty.next_cursor, null);

    const problems = [];
    for (const [index, statement] of [
      "For every natural number n, n + 0 = n.",
      "For every natural number n, n * 1 = n.",
      "For every natural number n, n = n.",
    ].entries()) {
      // Each sponsor keeps the actual two-problem creation allowance.
      const problemAuthor = index < 2 ? author : secondAuthor;
      const problemSponsor = index < 2 ? authorSponsor : secondAuthorSponsor;
      const problem = (
        await call(
          "/v1/problems",
          {
            title: `Sponsor report history target ${index + 1}`,
            statement,
            falsifier: "A natural number for which the stated equality is false.",
            motivation: "Exercise accountable report status without exposing private case notes.",
            areas: ["number-theory"],
          },
          problemAuthor,
          201,
        )
      ).problem.id;
      await sponsorCall(
        problemSponsor,
        "POST",
        `/v1/sponsors/problems/${problem}/lifecycle`,
        "problem-lifecycle",
        { action: "publish" },
      );
      problems.push(problem);
    }

    const human = ReportResponseSchema.parse(
      await sponsorCall(
        owner,
        "POST",
        "/v1/sponsors/reports",
        "sponsor.report",
        { problem_id: problems[0], target: "problem", reason: "privacy", note: privateNotes[0] },
        201,
      ),
    );
    const fellow = ReportResponseSchema.parse(
      await call(
        "/v1/reports",
        { problem_id: problems[1], target: "problem", reason: "integrity", note: privateNotes[1] },
        reporter,
        201,
      ),
    );
    const pending = ReportResponseSchema.parse(
      await sponsorCall(
        owner,
        "POST",
        "/v1/sponsors/reports",
        "sponsor.report",
        { problem_id: problems[2], target: "problem", reason: "spam", note: privateNotes[2] },
        201,
      ),
    );
    const foreign = ReportResponseSchema.parse(
      await sponsorCall(
        recipient,
        "POST",
        "/v1/sponsors/reports",
        "sponsor.report",
        { problem_id: problems[0], target: "problem", reason: "other", note: privateNotes[3] },
        201,
      ),
    );
    const duplicate = await sponsorCall(owner, "POST", "/v1/sponsors/reports", "sponsor.report", {
      problem_id: problems[1],
      target: "problem",
      reason: "integrity",
    });
    assert.equal(duplicate.report_id, fellow.report_id);
    assert.equal(duplicate.deduplicated, true, "human/Fellow reports share one sponsor family");
    const expectedIds = [human.report_id, fellow.report_id, pending.report_id];
    const beforeReads = await state();
    const initial = await read();
    assert.deepEqual(initial.reports.map((report) => report.report_id).sort(), expectedIds.sort());
    assert.equal(
      initial.reports.find((report) => report.report_id === human.report_id).reporter_class,
      "sponsor",
    );
    assert.equal(
      initial.reports.find((report) => report.report_id === fellow.report_id).reporter_class,
      "fellow",
    );
    assert.ok(
      initial.reports.every((report) => report.status === "pending" && report.resolved_at === null),
    );
    const otherPage = await read({}, recipient);
    assert.deepEqual(
      otherPage.reports.map((report) => report.report_id),
      [foreign.report_id],
    );

    // The cursor comes only from readback; pagination preserves exact order and
    // never returns another sponsor's row, even for a cursor copied from them.
    const first = await read({ limit: 2 });
    assert.equal(first.has_more, true);
    assert.equal(first.reports.length, 2);
    const second = await read({ limit: 2, before: first.next_cursor });
    assert.equal(second.has_more, false);
    assert.equal(second.next_cursor, null);
    assert.equal(second.reports.length, 1);
    assert.deepEqual([...first.reports, ...second.reports], initial.reports);
    const tail = second.reports[0];
    const exhausted = await read({
      before: { created_at: tail.created_at, report_id: tail.report_id },
      limit: 2,
    });
    assert.deepEqual(exhausted.reports, []);
    assert.equal(exhausted.has_more, false);
    assert.equal(exhausted.next_cursor, null);
    const foreignCursor = otherPage.reports[0];
    const bounded = await read({
      before: { created_at: foreignCursor.created_at, report_id: foreignCursor.report_id },
    });
    assert.ok(bounded.reports.every((report) => expectedIds.includes(report.report_id)));
    assert.deepEqual(
      await state(),
      beforeReads,
      "history reads do not mutate reporting or science",
    );

    const resolutionPath = "/v1/operators/reports/resolution";
    await operatorCall("POST", resolutionPath, "operator.reports.resolve", {
      report_id: human.report_id,
      resolution: "dismiss",
      reason: decisionReasons[0],
    });
    await operatorCall("POST", resolutionPath, "operator.reports.resolve", {
      report_id: fellow.report_id,
      resolution: "uphold",
      reason: decisionReasons[1],
    });
    const resolved = await read();
    for (const [reportId, status] of [
      [human.report_id, "dismissed"],
      [fellow.report_id, "upheld"],
      [pending.report_id, "pending"],
    ]) {
      const report = resolved.reports.find((item) => item.report_id === reportId);
      assert.equal(report.status, status);
      assert.equal(report.resolved_at === null, status === "pending");
    }
    assert.equal(
      (await read({}, recipient)).reports[0].status,
      "pending",
      "a different concern remains pending",
    );
    const hidden = await call(`/p/${problems[1]}.json`, undefined, undefined, 404);
    assert.equal(hidden.code, "PROBLEM_NOT_FOUND");
    assert.ok(
      resolved.reports.some((report) => report.report_id === fellow.report_id),
      "a hidden target keeps its sponsor-visible report status",
    );

    // Wrong credential class, signature, signed intent, query and body are all
    // refused over the actual Worker ingress, without broadening report scope.
    await call(route, {}, reporter, 403);
    await call(route, {}, undefined, 403);
    const cookieOnly = await worker.fetch(`${origin}${route}`, {
      method: "POST",
      headers: {
        "user-agent": userAgent,
        "content-type": "application/json",
        cookie: "authjs.session-token=fixture-only",
      },
      body: "{}",
    });
    assert.equal(cookieOnly.status, 403);
    assert.equal(ProblemDocumentSchema.parse(await cookieOnly.json()).code, "WRONG_PRINCIPAL");
    const wrongKeys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const forged = await mintServiceEnvelope({
      privateKey: wrongKeys.privateKey,
      kid: "problem-lifecycle-local-sponsor",
      now: Math.floor(Date.now() / 1000),
      method: "POST",
      route,
      action,
      principalType: "sponsor",
      principalId: owner,
      body: "{}",
    });
    const invalidSignature = await worker.fetch(`${origin}${route}`, {
      method: "POST",
      headers: {
        ...serviceEnvelopeHeaders(forged),
        "user-agent": userAgent,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(invalidSignature.status, 401);
    assert.equal(invalidSignature.headers.get("cache-control"), "private, no-store");
    assert.equal(invalidSignature.headers.get("x-robots-tag"), "noindex, nofollow");
    ProblemDocumentSchema.parse(await invalidSignature.json());
    await sponsorCall(owner, "POST", route, "sponsor.report", {}, 401);
    await sponsorCall(owner, "POST", route, action, {}, 401, "/v1/sponsors/reports");
    await sponsorCall(owner, "POST", route, action, {}, 401, route, undefined, "operator");
    for (const body of [
      { sponsor_id: recipient },
      { limit: 0 },
      { limit: 51 },
      { before: { report_id: human.report_id } },
    ]) {
      assert.equal(
        (await sponsorCall(owner, "POST", route, action, body, 422)).code,
        "SCHEMA_INVALID",
      );
    }
    assert.equal(
      (await sponsorCall(owner, "POST", `${route}?limit=1`, action, {}, 422, route)).code,
      "SCHEMA_INVALID",
    );
    assert.deepEqual(await read(), resolved, "refusals do not alter report history");
    const missing = await sponsorCall("usr_report_history_missing", "POST", route, action, {}, 404);
    assert.equal(missing.code, "ROUTE_NOT_FOUND");

    const now = () => Math.floor(Date.now() / 1000);
    const offer = await sponsorCall(
      owner,
      "POST",
      "/v1/sponsors/transfers",
      "sponsor.transfer.initiate",
      {
        fellow_id: reporterId,
        target_sponsor_id: recipient,
        confirm: "initiate-fellow-transfer",
        step_up_authenticated_at: now(),
        directive_attestation: "unresolved",
      },
      201,
    );
    await sponsorCall(
      recipient,
      "POST",
      `/v1/sponsors/transfers/${offer.transfer_id}/accept`,
      "sponsor.transfer.accept",
      {
        transfer_id: offer.transfer_id,
        confirm: "accept-fellow-transfer",
        step_up_authenticated_at: now(),
      },
    );
    assert.equal(
      (
        await env.DB.prepare("SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id = ?")
          .bind(reporterId)
          .first()
      ).sponsor_id,
      recipient,
    );
    assert.equal(
      (
        await env.DB.prepare("SELECT reporter_sponsor_id FROM reports WHERE report_id = ?")
          .bind(fellow.report_id)
          .first()
      ).reporter_sponsor_id,
      owner,
    );
    assert.deepEqual(
      await read(),
      resolved,
      "report accountability stays with the filing sponsor after transfer",
    );
    assert.deepEqual(
      (await read({}, recipient)).reports.map((report) => report.report_id),
      [foreign.report_id],
    );

    const publicLog = JSON.stringify(await call("/moderation/log.json"));
    const publicFace = JSON.stringify(await call(`/p/${problems[0]}.json`));
    for (const secret of [
      ...privateNotes,
      ...decisionReasons,
      ...expectedIds,
      reporterId,
      owner,
      recipient,
      LOCAL_OPERATOR_ID,
    ]) {
      assert.ok(
        !publicLog.includes(secret),
        "public moderation log contains no private report material",
      );
      assert.ok(
        !publicFace.includes(secret),
        "public scientific faces contain no private report material",
      );
    }

    // Deletion must withhold the private read even though accountability rows
    // remain durable and the transferred Fellow has a different active sponsor.
    const preview = await sponsorCall(
      owner,
      "GET",
      "/v1/sponsors/account/delete-preview",
      "sponsor.account.delete-preview",
    );
    const deletion = await sponsorCall(
      owner,
      "POST",
      "/v1/sponsors/account/delete",
      "sponsor.account.delete",
      {
        confirm: "delete-sponsor-account-and-revoke-all-fellows",
        expected_preview: preview.review,
        step_up_authenticated_at: now(),
      },
    );
    assert.equal(deletion.acknowledged, true);
    const deleted = ProblemDocumentSchema.parse(
      await sponsorCall(owner, "POST", route, action, {}, 404),
    );
    assert.equal(deleted.code, "ROUTE_NOT_FOUND");
    assert.ok(
      (
        await env.DB.prepare("SELECT tombstoned_at FROM sponsors WHERE sponsor_id = ?")
          .bind(owner)
          .first()
      ).tombstoned_at !== null,
    );
    const retained = (
      await env.DB.prepare(
        "SELECT report_id FROM reports WHERE reporter_sponsor_id = ? ORDER BY report_id",
      )
        .bind(owner)
        .all()
    ).results;
    assert.deepEqual(
      retained.map((row) => row.report_id),
      expectedIds,
    );
    assert.deepEqual(
      (await read({}, recipient)).reports.map((report) => report.report_id),
      [foreign.report_id],
    );
  },
  { laneName: "sponsor-reports" },
);

console.log(
  JSON.stringify({
    kind: "sponsor-reports-real-bindings",
    status: "pass",
    coverage: [
      "human-and-fellow-reports",
      "status-and-pagination",
      "private-metadata",
      "signed-ingress",
      "filing-sponsor-transfer-scope",
      "account-tombstone",
    ],
  }),
);
