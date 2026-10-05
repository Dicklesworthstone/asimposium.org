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
  async ({ call, enroll, sponsorCall, operatorCall, env, fixtures, worker, origin, userAgent }) => {
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

    // Snapshot the public faces of the consistent problem. After every
    // corruption and repair below, they must come back byte for byte.
    const PUBLIC_FACES = [`/p/${problem}.json`, `/p/${problem}.md`, `/p/${problem}/full.md`];
    const snapshotFaces = async () => {
      const faces = {};
      for (const path of PUBLIC_FACES) {
        const response = await worker.fetch(`${origin}${path}`, {
          headers: { "User-Agent": userAgent },
        });
        assert.equal(response.status, 200, path);
        faces[path] = { etag: response.headers.get("etag"), body: await response.text() };
      }
      return faces;
    };
    const facesBefore = await snapshotFaces();

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
    // A correctly signed operator envelope whose principal is not on the
    // deployment's operator allowlist is refused the same way (s0o6).
    const notAllowlisted = await sponsorCall(
      "usr_unlisted_operator",
      "GET",
      `/v1/operators/problems/${problem}/projections`,
      "operator.projections.read",
      undefined,
      [401, 403],
      DRY_RUN,
      undefined,
      "operator",
    );
    assert.equal(notAllowlisted.tables, undefined);
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

    // 3a. An interrupted rebuild leaves nothing half-done: with two rows lost
    //     (a claim version, inserted first, and the review, inserted later)
    //     and the review insert made to fail, the repair writes neither.
    const versionRow = () =>
      env.DB.prepare(
        "SELECT * FROM claim_versions WHERE problem_id = ? AND claim_id = ? AND version = 1",
      )
        .bind(problem, claimIds[1])
        .first();
    const originalVersion = await versionRow();
    await env.DB.exec("DROP TRIGGER claim_versions_immutable_delete");
    await env.DB.prepare(
      "DELETE FROM claim_versions WHERE problem_id = ? AND claim_id = ? AND version = 1",
    )
      .bind(problem, claimIds[1])
      .run();
    await env.DB.prepare("DELETE FROM reviews WHERE problem_id = ? AND review_id = ?")
      .bind(problem, review.review_id)
      .run();
    await env.DB.exec(
      "CREATE TRIGGER doctor_lane_interrupt BEFORE INSERT ON reviews BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
    );
    const interrupted = await repair(503);
    assert.equal(interrupted.code, "ENROLLMENT_UNAVAILABLE");
    assert.equal(
      await versionRow(),
      null,
      "the earlier insert was rolled back with the failed one",
    );
    assert.equal(await reviewRow(), null);
    await env.DB.exec("DROP TRIGGER doctor_lane_interrupt");
    assert.equal((await repair()).inserted, 2, "a later repair restores both");
    assert.deepEqual(await versionRow(), originalVersion);
    assert.deepEqual(await reviewRow(), original);

    // 3b. A write landing between the repair's insert and its re-check (here a
    //     local AFTER INSERT trigger that alters a hypothesis): the repair says
    //     rows were inserted and the problem is still not consistent (ys2o).
    await env.DB.prepare("DELETE FROM reviews WHERE problem_id = ? AND review_id = ?")
      .bind(problem, review.review_id)
      .run();
    await env.DB.exec(
      "CREATE TRIGGER doctor_lane_concurrent_write AFTER INSERT ON reviews BEGIN UPDATE hypotheses SET mechanism = 'changed mid-repair'; END",
    );
    const incomplete = await repair(409);
    assert.equal(incomplete.code, "PROJECTION_REPAIR_INCOMPLETE");
    assert.match(incomplete.detail, /rows were inserted/);
    assert.deepEqual(await reviewRow(), original, "the missing row was inserted");
    await env.DB.exec("DROP TRIGGER doctor_lane_concurrent_write");
    const healthRow = () =>
      env.DB.prepare(
        "SELECT status, drift_count, source_cursor FROM projection_health WHERE problem_id = ?",
      )
        .bind(problem)
        .first();
    assert.equal((await healthRow())?.status, "drift", "an incomplete repair records drift");
    // Clear it so step 5 can only see what the drift refusal itself records.
    await env.DB.prepare("DELETE FROM projection_health WHERE problem_id = ?").bind(problem).run();

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

    // 5. Stale boards keep serving with the drift said out loud (Fable §5):
    //    after the refused repair the public problem faces carry a degraded
    //    notice; once the row is set right and a repair ends consistent, the
    //    notice is gone.
    const DRIFT_NOTICE = /disagree with its event log/;
    const faceJson = async () => {
      const response = await worker.fetch(`${origin}/p/${problem}.json`, {
        headers: { "User-Agent": userAgent },
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const faceMd = async () =>
      (
        await worker.fetch(`${origin}/p/${problem}.md`, { headers: { "User-Agent": userAgent } })
      ).text();
    const drifted = await faceJson();
    assert.equal(drifted.degraded.length, 1, JSON.stringify(drifted.degraded));
    assert.match(drifted.degraded[0], DRIFT_NOTICE);
    assert.match(await faceMd(), DRIFT_NOTICE);
    const fullPack = async () =>
      (
        await worker.fetch(`${origin}/p/${problem}/full.md`, {
          headers: { "User-Agent": userAgent },
        })
      ).text();
    assert.match(await fullPack(), DRIFT_NOTICE, "the full pack carries the notice too");
    assert.deepEqual(await healthRow(), {
      status: "drift",
      drift_count: 1,
      source_cursor: head.seq,
    });

    await env.DB.prepare(
      "UPDATE hypotheses SET mechanism = ? WHERE problem_id = ? AND hypothesis_id = ?",
    )
      .bind("n and n squared share their lowest bit", problem, hypothesis.hypothesis_id)
      .run();
    assert.equal((await repair()).status, "consistent");
    assert.deepEqual((await faceJson()).degraded, [], "the notice clears once consistent");
    assert.doesNotMatch(await faceMd(), DRIFT_NOTICE);
    assert.doesNotMatch(await fullPack(), DRIFT_NOTICE);

    // 5b. A failed health write never changes the repair's answer (lo95): with
    //     the health table unavailable the repair still reports consistent.
    await env.DB.exec("ALTER TABLE projection_health RENAME TO projection_health_offline");
    const unhealthy = await repair();
    assert.equal(unhealthy.status, "consistent");
    // ...and a drift refusal still answers its own 409, not a 500.
    await env.DB.prepare(
      "UPDATE hypotheses SET mechanism = ? WHERE problem_id = ? AND hypothesis_id = ?",
    )
      .bind("tampered while health is offline", problem, hypothesis.hypothesis_id)
      .run();
    let offlineRefusal;
    try {
      offlineRefusal = await repair(409);
    } catch (error) {
      assert.fail(`a drift refusal with health offline must stay a 409: ${error.message}`);
    }
    assert.equal(offlineRefusal.code, "PROJECTION_DRIFT_NOT_REPAIRABLE");
    await env.DB.prepare(
      "UPDATE hypotheses SET mechanism = ? WHERE problem_id = ? AND hypothesis_id = ?",
    )
      .bind("n and n squared share their lowest bit", problem, hypothesis.hypothesis_id)
      .run();
    await env.DB.exec("ALTER TABLE projection_health_offline RENAME TO projection_health");

    // Digest equality: the repaired problem serves exactly the faces it served
    // before anything was corrupted.
    const facesAfter = await snapshotFaces();
    for (const path of PUBLIC_FACES) {
      assert.equal(facesAfter[path].etag, facesBefore[path].etag, `${path} ETag`);
      assert.equal(facesAfter[path].body, facesBefore[path].body, `${path} body`);
    }

    // 6. A private draft an operator has repaired can still be deleted: the
    //    deletion removes its health row too (2jih).
    const draft = (
      await call(
        "/v1/problems",
        {
          title: "Doctor draft problem",
          statement: "Every integer in 0..9 is below ten.",
          falsifier: "An integer in 0..9 that is ten or more.",
          motivation: "Exercise draft deletion after a repair.",
          areas: ["number-theory"],
        },
        author,
        201,
      )
    ).problem.id;
    const draftRepair = await operatorCall(
      "POST",
      `/v1/operators/problems/${draft}/projections/repair`,
      "operator.projections.repair",
      {},
      200,
      REPAIR,
    );
    assert.equal(draftRepair.status, "consistent");
    assert.ok(
      await env.DB.prepare("SELECT 1 AS found FROM projection_health WHERE problem_id = ?")
        .bind(draft)
        .first(),
      "the repair recorded health for the draft",
    );
    await sponsorCall(SPONSOR, "DELETE", `/v1/sponsors/problems/${draft}`, "delete-problem-draft");
    assert.equal(
      await env.DB.prepare("SELECT 1 AS found FROM problems WHERE id = ?").bind(draft).first(),
      null,
      "the repaired draft is gone",
    );

    // 7. A row with no event behind it is reported as an orphan, and repair
    //    refuses rather than keep or delete it.
    await env.DB.prepare(
      `INSERT INTO hypotheses (hypothesis_id, problem_id, route, mechanism, falsifier, expected_evidence,
         discriminating_predictions_json, origin, status, author_fellow_id, created_at, body_md,
         source_event_id, source_seq)
       SELECT 'H-ORPHANDOCTORLANE', problem_id, route, mechanism, falsifier, expected_evidence,
         discriminating_predictions_json, origin, status, author_fellow_id, created_at, body_md,
         (SELECT r.source_event_id FROM reviews r WHERE r.problem_id = ? AND r.review_id = ?), 999999
       FROM hypotheses WHERE problem_id = ? AND hypothesis_id = ?`,
    )
      .bind(problem, review.review_id, problem, hypothesis.hypothesis_id)
      .run();
    dryRunReport = ProjectionDoctorReportSchema.parse(await dryRun());
    assert.deepEqual(dryRunReport.drift, [
      { table: "hypotheses", key: "H-ORPHANDOCTORLANE", kind: "orphan_row" },
    ]);
    assert.equal(dryRunReport.repairable, false);
    assert.equal((await repair(409)).code, "PROJECTION_DRIFT_NOT_REPAIRABLE");
    await env.DB.exec("DROP TRIGGER hypotheses_immutable_delete");
    await env.DB.prepare("DELETE FROM hypotheses WHERE problem_id = ? AND hypothesis_id = ?")
      .bind(problem, "H-ORPHANDOCTORLANE")
      .run();
    assert.equal((await repair()).status, "consistent");

    // 10. On a fresh, unredacted problem: a lost row whose only source is an
    //     edited payload is refused, never rebuilt from the edit; then an
    //     event without its v2 chain row reads as unverifiable, not tampered.
    const fresh = (
      await call(
        "/v1/problems",
        {
          title: "Doctor integrity problem",
          statement: "Every integer in 0..20 has a square of the same parity.",
          falsifier: "An integer in 0..20 whose square has the opposite parity.",
          motivation: "Exercise integrity refusal on a clean log.",
          areas: ["number-theory"],
        },
        author,
        201,
      )
    ).problem.id;
    await sponsorCall(
      SPONSOR,
      "POST",
      `/v1/sponsors/problems/${fresh}/lifecycle`,
      "problem-lifecycle",
      { action: "publish" },
    );
    const freshReview = (
      await call("/v1/sessions", { problem_id: fresh, intent: "review" }, reviewer, 201)
    ).session_id;
    await call(
      `/v1/problems/${fresh}/statement-review`,
      {
        session_id: freshReview,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "Exact.",
      },
      reviewer,
    );
    const freshSession = (
      await call("/v1/sessions", { problem_id: fresh, intent: "prove" }, author, 201)
    ).session_id;
    const freshDraft = await call(
      `/v1/sessions/${freshSession}/workshop`,
      { type: "claim-draft", title: "Draft", body_md: "Private." },
      author,
      201,
    );
    const freshClaim = await call(
      `/v1/sessions/${freshSession}/promote`,
      {
        workshop_id: freshDraft.workshop_id,
        kind: "conjecture",
        statement: "Four squared is even.",
        falsifier: "Four squared being odd.",
      },
      author,
      201,
    );
    const freshDryRun = async (expected = 200) =>
      operatorCall(
        "GET",
        `/v1/operators/problems/${fresh}/projections`,
        "operator.projections.read",
        undefined,
        expected,
        DRY_RUN,
      );
    const freshRepair = (expected = 200) =>
      operatorCall(
        "POST",
        `/v1/operators/problems/${fresh}/projections/repair`,
        "operator.projections.repair",
        {},
        expected,
        REPAIR,
      );
    assert.equal(ProjectionDoctorReportSchema.parse(await freshDryRun()).status, "consistent");
    // A claim build row rebuilt later (as the integrity backfill does for
    // legacy claims) carries its own build time; that is not drift (nuzc).
    await env.DB.prepare(
      "UPDATE claim_projections SET updated_at = ? WHERE problem_id = ? AND claim_id = ?",
    )
      .bind("2030-01-01T00:00:00.000Z", fresh, freshClaim.claim_id)
      .run();
    assert.equal(ProjectionDoctorReportSchema.parse(await freshDryRun()).status, "consistent");
    const claimEvent = await env.DB.prepare(
      "SELECT id FROM events WHERE problem_id = ? AND type = 'claim.created' AND object_id = ?",
    )
      .bind(fresh, freshClaim.claim_id)
      .first();
    const claimPayload = await env.DB.prepare(
      "SELECT payload_json FROM event_content WHERE event_id = ?",
    )
      .bind(claimEvent.id)
      .first();
    await env.DB.prepare("DELETE FROM claim_versions WHERE problem_id = ? AND claim_id = ?")
      .bind(fresh, freshClaim.claim_id)
      .run();
    await env.DB.exec("DROP TRIGGER IF EXISTS event_content_lawful_redaction_only");
    await env.DB.prepare("UPDATE event_content SET payload_json = ? WHERE event_id = ?")
      .bind(
        claimPayload.payload_json.replace("Four squared being odd.", "Nothing could refute it."),
        claimEvent.id,
      )
      .run();
    const freshReport = ProjectionDoctorReportSchema.parse(await freshDryRun());
    assert.equal(freshReport.status, "log_integrity_failed");
    assert.deepEqual(freshReport.drift, [
      { table: "claim_versions", key: `${freshClaim.claim_id}@1`, kind: "missing_row" },
    ]);
    assert.equal((await freshRepair(409)).code, "PROJECTION_LOG_INTEGRITY_FAILED");
    assert.equal(
      await env.DB.prepare(
        "SELECT 1 AS found FROM projection_health WHERE problem_id = ? AND status = 'drift'",
      )
        .bind(fresh)
        .first(),
      null,
      "an unverifiable log is not recorded as projection drift",
    );
    assert.equal(
      await env.DB.prepare(
        "SELECT 1 AS found FROM claim_versions WHERE problem_id = ? AND claim_id = ?",
      )
        .bind(fresh, freshClaim.claim_id)
        .first(),
      null,
      "nothing was rebuilt from the edited payload",
    );
    await env.DB.prepare("UPDATE event_content SET payload_json = ? WHERE event_id = ?")
      .bind(claimPayload.payload_json, claimEvent.id)
      .run();
    assert.equal(
      (await freshRepair()).inserted,
      1,
      "with the payload restored, repair rebuilds it",
    );

    // A head that does not name the last event (a removed tail) fails too.
    const freshHead = await env.DB.prepare("SELECT chain_digest FROM problems WHERE id = ?")
      .bind(fresh)
      .first();
    await env.DB.prepare("UPDATE problems SET chain_digest = ? WHERE id = ?")
      .bind("0".repeat(64), fresh)
      .run();
    const headReport = ProjectionDoctorReportSchema.parse(await freshDryRun());
    assert.equal(headReport.status, "log_integrity_failed");
    assert.equal(headReport.integrity.head_matches, false);
    assert.equal((await freshRepair(409)).code, "PROJECTION_LOG_INTEGRITY_FAILED");
    await env.DB.prepare("UPDATE problems SET chain_digest = ? WHERE id = ?")
      .bind(freshHead.chain_digest, fresh)
      .run();
    assert.equal(ProjectionDoctorReportSchema.parse(await freshDryRun()).status, "consistent");
    // A problem that has events but no chain head yet awaits its backfill:
    // unverifiable, as the write path treats it, never "consistent" (4alg).
    await env.DB.prepare("UPDATE problems SET chain_digest = NULL WHERE id = ?").bind(fresh).run();
    const headless = ProjectionDoctorReportSchema.parse(await freshDryRun());
    assert.equal(headless.status, "log_unverifiable");
    assert.equal(headless.integrity.backfill_pending, true);
    assert.equal((await freshRepair(409)).code, "PROJECTION_LOG_INTEGRITY_FAILED");
    await env.DB.prepare("UPDATE problems SET chain_digest = ? WHERE id = ?")
      .bind(freshHead.chain_digest, fresh)
      .run();

    // A read the doctor cannot complete is an operational failure, never a
    // verdict about the log.
    await env.DB.exec("ALTER TABLE integrity_checkpoints RENAME TO integrity_checkpoints_offline");
    assert.equal((await freshDryRun(503)).code, "ENROLLMENT_UNAVAILABLE");
    assert.equal((await freshRepair(503)).code, "ENROLLMENT_UNAVAILABLE");
    await env.DB.exec("ALTER TABLE integrity_checkpoints_offline RENAME TO integrity_checkpoints");

    // A problem with no events and no chain head yet (a bare fixture row)
    // verifies trivially.
    await env.DB.prepare(
      "INSERT INTO problems (id, public_seq, created_at, updated_at, sponsor_id) VALUES (?, 0, ?, ?, ?)",
    )
      .bind("P-DOCTORBARE", new Date().toISOString(), new Date().toISOString(), SPONSOR)
      .run();
    const bare = ProjectionDoctorReportSchema.parse(
      await operatorCall(
        "GET",
        "/v1/operators/problems/P-DOCTORBARE/projections",
        "operator.projections.read",
        undefined,
        200,
        DRY_RUN,
      ),
    );
    assert.equal(bare.status, "consistent");
    assert.equal(bare.integrity.sound, true);

    await env.DB.exec("DROP TRIGGER event_chain_v2_immutable_before_delete");
    await env.DB.prepare("DELETE FROM event_chain_v2 WHERE event_id = ?").bind(claimEvent.id).run();
    const pending = ProjectionDoctorReportSchema.parse(await freshDryRun());
    assert.equal(pending.status, "log_unverifiable");
    assert.equal(pending.integrity.backfill_pending, true);
    assert.equal((await freshRepair(409)).code, "PROJECTION_LOG_INTEGRITY_FAILED");

    // 8. A lawfully redacted payload cannot be replayed: the dry run says so
    //    and repair refuses without recording drift that was never found.
    const hypothesisEvent = await env.DB.prepare(
      "SELECT source_event_id FROM hypotheses WHERE problem_id = ? AND hypothesis_id = ?",
    )
      .bind(problem, hypothesis.hypothesis_id)
      .first();
    await fixtures.redactPublicContent(hypothesisEvent.source_event_id);
    dryRunReport = ProjectionDoctorReportSchema.parse(await dryRun());
    assert.equal(dryRunReport.status, "unreplayable");
    assert.equal(dryRunReport.unreplayable_events, 1);
    assert.equal(dryRunReport.repairable, false);
    assert.equal((await repair(409)).code, "PROJECTION_REBUILD_UNREPLAYABLE");
    assert.deepEqual(
      await healthRow(),
      { status: "consistent", drift_count: 0, source_cursor: head.seq },
      "an unreplayable log leaves the health record as it was",
    );
    // A lawful redaction keeps its digest: the log still verifies.
    assert.equal(dryRunReport.integrity.sound, true);
    assert.equal(dryRunReport.integrity.redacted, 1);

    // 9. A log that does not verify is never rebuilt from (ops:event-verify):
    //    an edited stored payload, then an edited event envelope.
    const reviewEvent = await env.DB.prepare(
      "SELECT source_event_id FROM reviews WHERE problem_id = ? AND review_id = ?",
    )
      .bind(problem, review.review_id)
      .first();
    const storedPayload = await env.DB.prepare(
      "SELECT payload_json FROM event_content WHERE event_id = ?",
    )
      .bind(reviewEvent.source_event_id)
      .first();
    await env.DB.exec("DROP TRIGGER IF EXISTS event_content_lawful_redaction_only");
    await env.DB.prepare("UPDATE event_content SET payload_json = ? WHERE event_id = ?")
      .bind(
        storedPayload.payload_json.replace("Checked two squared directly.", "Checked it loosely."),
        reviewEvent.source_event_id,
      )
      .run();
    dryRunReport = ProjectionDoctorReportSchema.parse(await dryRun());
    assert.equal(dryRunReport.status, "log_integrity_failed");
    assert.equal(dryRunReport.integrity.content_mismatches, 1);
    assert.equal(dryRunReport.integrity.chain_sound, true);
    assert.equal(dryRunReport.repairable, false);
    assert.equal((await repair(409)).code, "PROJECTION_LOG_INTEGRITY_FAILED");
    assert.deepEqual(
      await healthRow(),
      { status: "consistent", drift_count: 0, source_cursor: head.seq },
      "an unverifiable log is not recorded as projection drift",
    );
    await env.DB.prepare("UPDATE event_content SET payload_json = ? WHERE event_id = ?")
      .bind(storedPayload.payload_json, reviewEvent.source_event_id)
      .run();
    assert.equal(ProjectionDoctorReportSchema.parse(await dryRun()).integrity.sound, true);

    await env.DB.exec("DROP TRIGGER events_immutable_before_update");
    await env.DB.prepare("UPDATE events SET created_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", reviewEvent.source_event_id)
      .run();
    dryRunReport = ProjectionDoctorReportSchema.parse(await dryRun());
    assert.equal(dryRunReport.status, "log_integrity_failed");
    assert.equal(dryRunReport.integrity.chain_sound, false);
    assert.equal((await repair(409)).code, "PROJECTION_LOG_INTEGRITY_FAILED");

    // 10. 79n: an event of a type this Worker does not know (a newer writer,
    //     or a tampered log) cannot be judged. On a problem whose log is
    //     otherwise sound, the dry run reports it unreplayable and repair
    //     refuses instead of rebuilding around it.
    await fixtures.appendUnknownEvent("P-DOCTORBARE");
    const unknown = ProjectionDoctorReportSchema.parse(
      await operatorCall(
        "GET",
        "/v1/operators/problems/P-DOCTORBARE/projections",
        "operator.projections.read",
        undefined,
        200,
        DRY_RUN,
      ),
    );
    assert.equal(unknown.integrity.sound, true, "the unknown event is a sound log entry");
    assert.equal(unknown.status, "unreplayable");
    assert.equal(unknown.unreplayable_events, 1);
    assert.equal(
      (
        await operatorCall(
          "POST",
          "/v1/operators/problems/P-DOCTORBARE/projections/repair",
          "operator.projections.repair",
          {},
          409,
          "/v1/operators/problems/:problemId/projections/repair",
        )
      ).code,
      "PROJECTION_REBUILD_UNREPLAYABLE",
    );

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
    return {
      projectionParityExpect: {
        // Step 9 leaves this problem's stored log edited on purpose: the
        // edited hypothesis payload and review envelope replay differently.
        [problem]: {
          status: "log_integrity_failed",
          drift: [
            `hypotheses:orphan_row:${hypothesis.hypothesis_id}`,
            `reviews:column:${review.review_id}:created_at`,
          ],
        },
        // Step 10 leaves this problem's claim event without its v2 chain row
        // (backfill pending), so the claim's build digest cannot be rebuilt.
        [fresh]: {
          status: "log_unverifiable",
          drift: [`claim_projections:column:${freshClaim.claim_id}:build_digest`],
        },
      },
    };
  },
);
