import assert from "node:assert/strict";
import { PROJECTION_DOCTOR_TABLES, ProjectionDoctorReportSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// W2.6 ops:projection-rebuild (bead asimposiumorg-79n) on real local Workerd
// and D1. An allowlisted operator reads a dry-run report that replays a
// problem's event log against its stored projection tables, and a repair that
// only inserts rows the log proves are missing. Drift is injected into this
// throwaway local database by dropping one immutability trigger and deleting
// or altering a row, which no product route can do.
//
// Not covered: staging, the Agora operator console, redacted (unreplayable)
// events, problems too large to replay in one request.

const DRY_RUN = "/v1/operators/problems/:problemId/projections";
const REPAIR = "/v1/operators/problems/:problemId/projections/repair";

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, operatorCall, env, worker, origin, userAgent }) => {
    const SPONSOR = "usr_doctor_author";
    const author = await enroll("doctor-author", SPONSOR);
    const reviewer = await enroll("doctor-reviewer", "usr_doctor_reviewer");
    const problem = (
      await call(
        "/v1/problems",
        {
          title: "Doctor parity problem",
          statement: "Every integer in 0..40 has a square of the same parity.",
          falsifier: "An integer in 0..40 whose square has the opposite parity.",
          motivation: "Exercise the projection doctor.",
          areas: ["number-theory"],
        },
        author,
        201,
      )
    ).problem.id;
    await sponsorCall(
      SPONSOR,
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      {
        action: "publish",
      },
    );
    const reviewSession = (
      await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
    ).session_id;
    await call(
      `/v1/problems/${problem}/statement-review`,
      {
        session_id: reviewSession,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "Exact range.",
      },
      reviewer,
    );
    const session = (
      await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
    ).session_id;
    const claimIds = [];
    for (const statement of ["Two squared is even.", "Three squared is odd."]) {
      const draft = await call(
        `/v1/sessions/${session}/workshop`,
        { type: "claim-draft", title: "Draft", body_md: "Private." },
        author,
        201,
      );
      const promoted = await call(
        `/v1/sessions/${session}/promote`,
        {
          workshop_id: draft.workshop_id,
          kind: "conjecture",
          statement,
          falsifier: "A counterexample in range.",
        },
        author,
        201,
      );
      claimIds.push(promoted.claim_id);
    }
    const review = await call(
      `/v1/sessions/${reviewSession}/review`,
      {
        target_claim_id: claimIds[0],
        target_version: 1,
        verdict: "confirm",
        basis: "Checked two squared directly.",
        capable_of_failure: "Two squared being odd.",
        body_md: "Direct check.",
      },
      reviewer,
      201,
    );
    const hypothesis = await call(
      `/v1/sessions/${session}/hypotheses`,
      {
        route: "parity is preserved by squaring",
        mechanism: "n and n squared share their lowest bit",
        falsifier: "an n whose square has the other parity",
        discriminating_predictions: ["squares of evens are even"],
        origin: "proposed",
        body_md: "Parity route.",
      },
      author,
      201,
    );

    const dryRun = (expected = 200) =>
      operatorCall(
        "GET",
        `/v1/operators/problems/${problem}/projections`,
        "operator.projections.read",
        undefined,
        expected,
        DRY_RUN,
      );
    const repair = (expected = 200) =>
      operatorCall(
        "POST",
        `/v1/operators/problems/${problem}/projections/repair`,
        "operator.projections.repair",
        {},
        expected,
        REPAIR,
      );
    const rows = (table) => Object.fromEntries(dryRunReport.tables.map((t) => [t.table, t]))[table];
    let dryRunReport;

    // 1. A consistent problem: the rebuild equals the stored tables.
    dryRunReport = ProjectionDoctorReportSchema.parse(await dryRun());
    const head = await env.DB.prepare("SELECT MAX(seq) AS seq FROM events WHERE problem_id = ?")
      .bind(problem)
      .first();
    assert.equal(dryRunReport.status, "consistent", JSON.stringify(dryRunReport.drift));
    assert.equal(dryRunReport.source_cursor, head.seq);
    assert.deepEqual(dryRunReport.drift, []);
    assert.equal(dryRunReport.repairable, true);
    assert.deepEqual(
      dryRunReport.tables.map((t) => t.table),
      [...PROJECTION_DOCTOR_TABLES],
    );
    for (const [table, count] of [
      ["claims", 2],
      ["claim_versions", 2],
      ["reviews", 1],
      ["hypotheses", 1],
    ]) {
      assert.deepEqual(rows(table), { table, rebuilt_rows: count, live_rows: count }, table);
    }

    // 2. Only the allowlisted operator: a signed sponsor, an unsigned caller and
    //    an unknown problem learn nothing.
    const asSponsor = await sponsorCall(
      SPONSOR,
      "GET",
      `/v1/operators/problems/${problem}/projections`,
      "operator.projections.read",
      undefined,
      [401, 403],
      DRY_RUN,
    );
    assert.equal(asSponsor.tables, undefined);
    const unsigned = await worker.fetch(`${origin}/v1/operators/problems/${problem}/projections`, {
      headers: { "User-Agent": userAgent },
    });
    assert.ok([401, 403].includes(unsigned.status), `unsigned status ${unsigned.status}`);
    assert.equal((await unsigned.json()).tables, undefined);
    await operatorCall(
      "GET",
      "/v1/operators/problems/P-NOSUCHPROBLEM/projections",
      "operator.projections.read",
      undefined,
      404,
      DRY_RUN,
    );

    // 3. A lost row: detected, repaired by insertion, equal to the original.
    const reviewRow = () =>
      env.DB.prepare("SELECT * FROM reviews WHERE problem_id = ? AND review_id = ?")
        .bind(problem, review.review_id)
        .first();
    const original = await reviewRow();
    assert.ok(original, "the review row exists");
    await env.DB.exec("DROP TRIGGER reviews_immutable_delete");
    await env.DB.prepare("DELETE FROM reviews WHERE problem_id = ? AND review_id = ?")
      .bind(problem, review.review_id)
      .run();
    dryRunReport = ProjectionDoctorReportSchema.parse(await dryRun());
    assert.equal(dryRunReport.status, "drift");
    assert.deepEqual(dryRunReport.drift, [
      { table: "reviews", key: review.review_id, kind: "missing_row" },
    ]);
    assert.equal(dryRunReport.repairable, true);
    assert.deepEqual(rows("reviews"), { table: "reviews", rebuilt_rows: 1, live_rows: 0 });
    const repaired = await repair();
    assert.deepEqual(repaired, {
      problem_id: problem,
      mode: "repair",
      source_cursor: head.seq,
      inserted: 1,
      status: "consistent",
    });
    assert.deepEqual(await reviewRow(), original, "the repaired row equals the lost one");
    assert.equal(ProjectionDoctorReportSchema.parse(await dryRun()).status, "consistent");
    assert.equal((await repair()).inserted, 0, "a second repair inserts nothing");

    // 4. A tampered column: reported, never rewritten; repair refuses whole.
    await env.DB.prepare(
      "UPDATE hypotheses SET mechanism = ? WHERE problem_id = ? AND hypothesis_id = ?",
    )
      .bind("tampered", problem, hypothesis.hypothesis_id)
      .run();
    dryRunReport = ProjectionDoctorReportSchema.parse(await dryRun());
    assert.equal(dryRunReport.status, "drift");
    assert.deepEqual(dryRunReport.drift, [
      { table: "hypotheses", key: hypothesis.hypothesis_id, kind: "column", column: "mechanism" },
    ]);
    assert.equal(dryRunReport.repairable, false);
    const refused = await repair(409);
    assert.equal(refused.code, "PROJECTION_DRIFT_NOT_REPAIRABLE");
    const still = await env.DB.prepare(
      "SELECT mechanism FROM hypotheses WHERE problem_id = ? AND hypothesis_id = ?",
    )
      .bind(problem, hypothesis.hypothesis_id)
      .first();
    assert.equal(still.mechanism, "tampered", "a refused repair writes nothing");

    console.log(
      JSON.stringify({
        kind: "projection-doctor-real-bindings",
        status: "pass",
        problem,
        source_cursor: head.seq,
        boundary:
          "local Workerd/D1; operator-signed service envelopes; drift injected by dropping a local trigger; no staging, no console",
      }),
    );
  },
);
