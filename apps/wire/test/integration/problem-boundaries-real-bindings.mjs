import assert from "node:assert/strict";
import {
  PackResponseSchema,
  ProblemDetailSchema,
  ProblemStatementBoundariesSchema,
} from "@asimposium/contracts";
import { readPublishedProblemFormulation } from "../../src/ledger/problem-formulation-read.ts";
import { normHash } from "../../src/split/policy.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Real Worker/D1/R2 proof of authored problem boundaries through the existing
// proposal, reviewed publication, revision and fork paths. Identity and model
// observations are local fixtures; this is not a deployed/OAuth/model claim.
await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, operatorCall, env, fixtures, worker, origin, userAgent }) => {
    const owner = "usr_boundary_owner";
    const author = await enroll("boundary-author", owner);
    const reviewer = await enroll("boundary-reviewer", "usr_boundary_reviewer");
    const formulation = {
      statement: "Every finite tree has one fewer edge than vertices.",
      falsifier: "A finite tree with an edge count other than its vertex count minus one.",
      motivation: "Establish the invariant used in the connected-graph argument.",
    };
    const initial = {
      scope: "  Finite undirected trees, including the one-vertex tree.\n",
      out_of_scope: "Infinite graphs, disconnected forests and graph enumeration.",
      success_criteria: "An independently reviewable proof, or an explicit finite counterexample.",
    };
    const fields = (value) =>
      ProblemStatementBoundariesSchema.parse({
        scope: value.scope,
        out_of_scope: value.out_of_scope,
        success_criteria: value.success_criteria,
      });
    const proposal = {
      title: "Finite tree boundary investigation",
      ...formulation,
      areas: ["combinatorics"],
    };
    const brief = (
      await sponsorCall(
        owner,
        "POST",
        "/v1/sponsors/problem-briefs",
        "save-problem-brief",
        { ...proposal, ...initial },
        201,
      )
    ).brief;
    assert.deepEqual(fields(brief), initial);
    const list = await sponsorCall(
      owner,
      "GET",
      "/v1/sponsors/problem-briefs",
      "list-problem-briefs",
    );
    assert.deepEqual(fields(list.briefs.find((item) => item.id === brief.id)), initial);
    const omittedBrief = await sponsorCall(
      owner,
      "POST",
      "/v1/sponsors/problem-briefs",
      "save-problem-brief",
      { ...proposal, id: brief.id, expected_version: brief.version },
      422,
    );
    assert.equal(omittedBrief.code, "STATEMENT_INCOMPLETE");
    assert.equal(
      (
        await call(
          "/v1/problems",
          { ...proposal, brief_id: brief.id, expected_brief_version: brief.version },
          author,
          422,
        )
      ).code,
      "STATEMENT_INCOMPLETE",
    );
    const created = await call(
      "/v1/problems",
      { ...proposal, ...initial, brief_id: brief.id, expected_brief_version: brief.version },
      author,
      201,
    );
    const problem = created.problem.id;
    assert.deepEqual(fields(created.problem), initial);
    const lifecyclePath = `/v1/sponsors/problems/${problem}/lifecycle`;
    const govern = (body, expected = 200, key) =>
      sponsorCall(
        owner,
        "POST",
        lifecyclePath,
        "problem-lifecycle",
        body,
        expected,
        lifecyclePath,
        key,
      );
    const preview = () =>
      sponsorCall(
        owner,
        "GET",
        `/v1/sponsors/problems/${problem}/publication-preview`,
        "problem-publication-preview",
      );
    const detail = async (token) =>
      ProblemDetailSchema.parse((await call(`/v1/problems/${problem}`, undefined, token)).problem);
    const state = () =>
      env.DB.prepare("SELECT public_seq,current_statement_version,status FROM problems WHERE id=?")
        .bind(problem)
        .first();
    assert.equal(
      (await call(`/v1/problems/${problem}`, undefined, undefined, 404)).code,
      "PROBLEM_NOT_FOUND",
    );
    assert.deepEqual(fields(await detail(author)), initial);
    const firstPreview = await preview();
    assert.deepEqual(fields(firstPreview.problem), initial);
    const privateOmission = await govern({ action: "revise-statement", ...formulation }, 422);
    assert.equal(privateOmission.code, "STATEMENT_INCOMPLETE");
    const second = {
      ...initial,
      success_criteria:
        "A proof explicitly treating the one-vertex base case, or a finite counterexample.",
    };
    const privateRevision = await govern({ action: "revise-statement", ...formulation, ...second });
    assert.equal(privateRevision.problem.current_statement_version, 2);
    assert.deepEqual(fields(privateRevision.problem), second);
    const stalePreview = await govern(
      {
        action: "publish",
        reviewed_statement_version: 1,
        reviewed_digest: firstPreview.review_digest,
      },
      409,
    );
    assert.equal(stalePreview.code, "OBJECT_VERSION_CONFLICT");

    // Stage the immutable private version, then race its head switch after the
    // production writer has checked the sponsor's preview and before its batch.
    const secondPreview = await preview();
    const third = {
      ...second,
      scope: "Finite simple undirected trees, including the one-vertex tree.",
    };
    const raceAt = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO problem_statement_versions
    (problem_id,version,statement,norm_hash,falsifier,motivation,scope,out_of_scope,success_criteria,steward_accepted_by,created_at)
    VALUES(?,3,?,?,?,?,?,?,?,?,?)`)
      .bind(
        problem,
        formulation.statement,
        `sha256:${await normHash(formulation.statement)}`,
        formulation.falsifier,
        formulation.motivation,
        third.scope,
        third.out_of_scope,
        third.success_criteria,
        owner,
        raceAt,
      )
      .run();
    await fixtures.armRaceBeforeNextBatch(
      "UPDATE problems SET current_statement_version=3,updated_at=? WHERE id=?",
      [raceAt, problem],
      "INSERT INTO events",
    );
    const raced = await govern(
      {
        action: "publish",
        reviewed_statement_version: 2,
        reviewed_digest: secondPreview.review_digest,
      },
      409,
      "boundary-publication-race",
    );
    assert.equal(await fixtures.raceStillArmed(), false);
    assert.equal(raced.code, "OBJECT_VERSION_CONFLICT");
    assert.deepEqual(await state(), {
      public_seq: 0,
      current_statement_version: 3,
      status: "private-draft",
    });
    const published = await govern({ action: "publish" });
    assert.deepEqual(fields(published.problem), third);
    const screenedPublication = await fixtures.lastScreening();
    for (const text of Object.values(third))
      assert.ok(
        screenedPublication.statement.includes(text),
        "all authored boundaries reach publication screening",
      );
    const current = await detail();
    assert.deepEqual(fields(current), third);
    const admittedCursor = current.public_seq;
    const admitted = await readPublishedProblemFormulation(env.DB, problem, admittedCursor);
    assert.deepEqual(fields(admitted.problem), third);
    const face = await call(`/p/${problem}.json`);
    const kinds = {
      scope: "problem-scope",
      out_of_scope: "problem-out-of-scope",
      success_criteria: "problem-success-criteria",
    };
    for (const [field, kind] of Object.entries(kinds))
      assert.equal(face.items.find((item) => item.kind === kind)?.body, third[field]);
    const markdown = await worker.fetch(`${origin}/p/${problem}.md`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(markdown.status, 200);
    assert.ok((await markdown.text()).includes(third.out_of_scope));

    const reviewSession = (
      await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
    ).session_id;
    await call(
      `/v1/problems/${problem}/statement-review`,
      {
        session_id: reviewSession,
        statement_version: 3,
        verdict: "statement-clear",
        basis:
          "The finite simple-tree scope, excluded variants and base-case success criterion are explicit.",
      },
      reviewer,
    );
    const session = (
      await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
    ).session_id;
    const pack = PackResponseSchema.parse(
      await call(`/v1/sessions/${session}/pack?profile=orient&max_tokens=8000`, undefined, author),
    );
    assert.deepEqual(
      fields(JSON.parse(pack.items.find((item) => item.kind === "problem-formulation").body)),
      third,
    );
    const inspectedCursor = pack.cursor;
    const draft = await call(
      `/v1/sessions/${session}/workshop`,
      { type: "claim-draft", title: "Base case", body_md: "The one-vertex tree has no edges." },
      author,
      201,
    );
    const claim = (
      await call(
        `/v1/sessions/${session}/promote`,
        {
          workshop_id: draft.workshop_id,
          kind: "conjecture",
          statement: "The one-vertex tree has zero edges.",
          falsifier: "A one-vertex simple tree with an edge.",
          client_context_cursor: inspectedCursor,
        },
        author,
        201,
      )
    ).claim_id;
    const screenedClaim = await fixtures.lastScreening();
    assert.deepEqual(
      fields(JSON.parse(screenedClaim.publication_context_body).problem_statement),
      third,
      "downstream claim screening receives recorded problem boundaries",
    );

    const beforeOmission = await state();
    assert.equal(
      (await govern({ action: "revise-statement", ...formulation }, 422)).code,
      "STATEMENT_INCOMPLETE",
    );
    assert.deepEqual(await state(), beforeOmission);
    const fourth = {
      ...third,
      success_criteria:
        "A proof covering both leaf deletion and the one-vertex base case, or an explicit counterexample.",
    };
    const revised = await govern(
      { action: "revise-statement", ...formulation, ...fourth },
      200,
      "boundary-only-revision",
    );
    assert.equal(revised.problem.current_statement_version, 4);
    assert.deepEqual(fields(revised.problem), fourth);
    const revisionState = await state();
    assert.equal(revisionState.public_seq, beforeOmission.public_seq + 1);
    const claimAnchor = () =>
      env.DB.prepare(
        "SELECT statement_version,statement_drift FROM claims WHERE problem_id=? AND id=?",
      )
        .bind(problem, claim)
        .first();
    assert.deepEqual(await claimAnchor(), { statement_version: 3, statement_drift: 1 });
    const staleWrite = await call(
      `/v1/sessions/${session}/reanchor`,
      { claim_id: claim, base_version: 1, client_context_cursor: inspectedCursor },
      author,
      409,
    );
    assert.equal(staleWrite.code, "STATEMENT_REVISED_SINCE");
    assert.deepEqual(await state(), revisionState);
    assert.deepEqual(await claimAnchor(), { statement_version: 3, statement_drift: 1 });
    const refreshed = await detail();
    assert.deepEqual(fields(refreshed), fourth);
    const reanchored = await call(
      `/v1/sessions/${session}/reanchor`,
      { claim_id: claim, base_version: 1, client_context_cursor: refreshed.public_seq },
      author,
    );
    assert.equal(reanchored.statement_version, 4);
    assert.deepEqual(
      fields((await readPublishedProblemFormulation(env.DB, problem, admittedCursor)).problem),
      third,
      "old publication boundaries are immutable",
    );
    const beforeReplay = await state();
    assert.deepEqual(
      await govern(
        { action: "revise-statement", ...formulation, ...fourth },
        200,
        "boundary-only-revision",
      ),
      revised,
    );
    assert.deepEqual(await state(), beforeReplay);
    await assert.rejects(
      env.DB.prepare(
        "UPDATE problem_statement_versions SET scope='changed' WHERE problem_id=? AND version=4",
      )
        .bind(problem)
        .run(),
      /PROBLEM_STATEMENT_VERSION_IMMUTABLE/,
    );

    const inherited = await govern({
      action: "fork",
      title: "Independent boundary-preserving tree investigation",
    });
    assert.deepEqual(
      fields(
        (await call(`/v1/problems/${inherited.forked_problem_id}`, undefined, author)).problem,
      ),
      fourth,
    );
    assert.equal(
      (
        await govern(
          {
            action: "fork",
            title: "Rooted tree variant",
            statement: "Every finite rooted tree has exactly one distinguished root.",
          },
          422,
        )
      ).code,
      "STATEMENT_INCOMPLETE",
    );
    const changed = {
      ...fourth,
      scope: "Finite rooted trees with one explicitly distinguished vertex.",
    };
    const fork = await govern({
      action: "fork",
      title: "Rooted tree boundary investigation",
      statement: "Every finite rooted tree has exactly one distinguished root.",
      ...changed,
    });
    assert.deepEqual(
      fields((await call(`/v1/problems/${fork.forked_problem_id}`, undefined, author)).problem),
      changed,
    );
    const forkLineage = await env.DB.prepare("SELECT * FROM problem_forks WHERE problem_id=?")
      .bind(fork.forked_problem_id)
      .first();
    const beforeErasure = await state();
    const erased = await sponsorCall(
      owner,
      "DELETE",
      `/v1/sponsors/problems/${fork.forked_problem_id}`,
      "delete-problem-draft",
    );
    assert.equal(erased.deleted, true);
    assert.equal(erased.rows_deleted.problem, 0, "an empty identity retains public lineage");
    assert.equal(erased.rows_deleted.statementVersions, 1);
    assert.deepEqual(
      await env.DB.prepare("SELECT * FROM problem_forks WHERE problem_id=?")
        .bind(fork.forked_problem_id)
        .first(),
      forkLineage,
      "the parent's public fork audit is preserved exactly",
    );
    assert.deepEqual(await state(), beforeErasure);
    assert.deepEqual(
      await env.DB.prepare(
        "SELECT title,sponsor_id,created_by_fellow_id,public_seq,unlisted,admission_mode FROM problems WHERE id=?",
      )
        .bind(fork.forked_problem_id)
        .first(),
      {
        title: "",
        sponsor_id: null,
        created_by_fellow_id: null,
        public_seq: 0,
        unlisted: 1,
        admission_mode: "archived-read-only",
      },
    );
    assert.equal(
      (await call(`/v1/problems/${fork.forked_problem_id}`, undefined, author, 404)).code,
      "PROBLEM_NOT_FOUND",
    );
    assert.equal(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM problem_statement_versions WHERE problem_id=?",
        )
          .bind(fork.forked_problem_id)
          .first()
      ).n,
      0,
    );

    const control = (action) =>
      operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
        target_id: problem,
        target_kind: "problem",
        action,
        reason: "Verify visibility of the complete recorded formulation.",
      });
    await control("hide");
    assert.equal(
      (await call(`/v1/problems/${problem}`, undefined, undefined, 404)).code,
      "PROBLEM_NOT_FOUND",
    );
    assert.equal(await readPublishedProblemFormulation(env.DB, problem, admittedCursor), undefined);
    await control("restore");
    assert.deepEqual(fields(await detail()), fourth);
    const capacity = { action: "set-writer-cap", writer_cap: 4 };
    const capacityReceipt = await govern(capacity, 200, "boundary-capacity");
    assert.deepEqual(fields(capacityReceipt.problem), fourth);
    const source = await readPublishedProblemFormulation(
      env.DB,
      problem,
      (await detail()).public_seq,
    );
    const replayBeforeWithdrawal = await operatorCall(
      "GET",
      `/v1/operators/problems/${problem}/projections`,
      "operator.projections.read",
      undefined,
      200,
      "/v1/operators/problems/:problemId/projections",
    );
    assert.equal(replayBeforeWithdrawal.status, "consistent");
    assert.deepEqual(replayBeforeWithdrawal.drift, []);
    const beforeWithdrawal = await state();
    // Run the same lawful content-redaction update at the real D1 commit
    // boundary, after governance has inspected the still-visible source.
    await fixtures.armRaceBeforeNextBatch(
      `UPDATE event_content SET payload_json='{"control":"redacted"}',
       redacted_at=?, redaction_reason='privacy' WHERE event_id=?`,
      [new Date().toISOString(), source.publication.event_id],
      "INSERT INTO events",
    );
    const racingCapacity = await govern(
      { action: "set-writer-cap", writer_cap: 5 },
      409,
      "boundary-capacity-withdrawal-race",
    );
    assert.equal(await fixtures.raceStillArmed(), false);
    assert.equal(racingCapacity.code, "OBJECT_VERSION_CONFLICT");
    assert.deepEqual(await state(), beforeWithdrawal);
    const afterWithdrawal = await govern({ action: "set-writer-cap", writer_cap: 6 }, 409);
    assert.equal(afterWithdrawal.code, "OBJECT_VERSION_CONFLICT");
    for (const value of [...Object.values(fourth), ...Object.values(formulation)]) {
      assert.equal(JSON.stringify(racingCapacity).includes(value), false);
      assert.equal(JSON.stringify(afterWithdrawal).includes(value), false);
    }
    assert.deepEqual(await govern(capacity, 200, "boundary-capacity"), capacityReceipt);
    assert.deepEqual(await state(), beforeWithdrawal);
    assert.equal(
      (await env.DB.prepare("SELECT writer_cap FROM problems WHERE id=?").bind(problem).first())
        .writer_cap,
      4,
    );
    assert.equal(
      (await call(`/v1/problems/${problem}`, undefined, undefined, 404)).code,
      "PROBLEM_NOT_FOUND",
    );
    assert.equal(
      await readPublishedProblemFormulation(env.DB, problem, (await state()).public_seq),
      undefined,
      "redaction never restores retained projection boundaries",
    );

    // The sole policy canary is in a newly supported field. A rejected candidate
    // stays private and consumes no public cursor; no real model is claimed.
    const screenedDraft = await call(
      "/v1/problems",
      {
        ...proposal,
        title: "Boundary screening control",
        statement: "Every finite nonempty rooted tree has a distinguished vertex.",
        ...initial,
        out_of_scope: "LOCAL_POLICY_CANARY must be screened even when only in an exclusion.",
      },
      author,
      201,
    );
    const screenedPath = `/v1/sponsors/problems/${screenedDraft.problem.id}/lifecycle`;
    const rejected = await sponsorCall(
      owner,
      "POST",
      screenedPath,
      "problem-lifecycle",
      { action: "publish" },
      [403, 422],
    );
    assert.equal(rejected.code, "POLICY_DENIED");
    assert.equal(
      (
        await env.DB.prepare("SELECT public_seq FROM problems WHERE id=?")
          .bind(screenedDraft.problem.id)
          .first()
      ).public_seq,
      0,
    );

    console.log(
      JSON.stringify({
        kind: "problem-boundaries-real-bindings",
        status: "pass",
        scope:
          "real local Workerd/D1/R2; fixture identity and screening; no deployed or live-model proof",
        probes: [
          "private-brief-and-adoption",
          "complete-bundle-required",
          "private-revision",
          "stale-reviewed-publication",
          "publication-at-commit-race",
          "canonical-public-and-pack-reads",
          "publication-and-claim-screening",
          "boundary-only-revision",
          "claim-drift-and-stale-context",
          "exact-idempotent-replay",
          "immutable-storage-and-history",
          "fork-inheritance-and-explicit-variant",
          "lawful-private-erasure",
          "current-visibility-and-redaction",
          "governance-source-withdrawal-at-commit",
          "withdrawn-source-sealed-replay",
          "boundary-field-policy-refusal",
        ],
      }),
    );
    // The exact S@4 publication is deliberately redacted above. Its retained
    // immutable version cannot be reconstructed from withdrawn bytes; require
    // precisely that orphan while every other row remains consistent. The
    // operator read above proved complete replay before the lawful withdrawal.
    return {
      projectionParityExpect: {
        [problem]: {
          status: "unreplayable",
          drift: ["problem_statement_versions:orphan_row:4"],
        },
      },
    };
  },
);
