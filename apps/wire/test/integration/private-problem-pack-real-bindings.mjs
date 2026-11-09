import assert from "node:assert/strict";
import { PackResponseSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Actual local Workerd/D1/R2 with the shared synthetic identity/screening
// harness. This does not establish hosted screening or deployment readiness.
await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, reviseStatement, env, worker, origin, userAgent }) => {
    const sponsor = "usr_private_pack_journey";
    const token = await enroll("private-pack-author", sponsor);
    const proposal = {
      title: "Private finite tree preparation",
      statement: "Every finite nonempty tree has one fewer edge than vertices.",
      falsifier: "A finite tree with an edge count other than its vertex count minus one.",
      motivation: "Establish the edge invariant needed for a connected graph argument.",
      scope: "Finite nonempty undirected simple trees.",
      out_of_scope: "Infinite objects and disconnected forests.",
      success_criteria: "An independently checkable argument or a counterexample in scope.",
      areas: ["combinatorics"],
    };
    const created = await call("/v1/problems", proposal, token, 201);
    const problem = created.problem.id;
    const hello = await call("/v1/hello", undefined, token);
    assert.ok(hello.assignments.some((assignment) => assignment.problem_id === problem));
    const opened = await call(
      "/v1/sessions",
      { problem_id: problem, intent: "sharpen-statement" },
      token,
      201,
    );
    const packUrl = `/v1/sessions/${opened.session_id}/pack?profile=working`;
    const response = await worker.fetch(origin + packUrl, {
      headers: { "user-agent": userAgent, authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const etag = response.headers.get("etag");
    assert.ok(etag);
    const pack = PackResponseSchema.parse(await response.json());
    assert.equal(pack.cursor, 0);
    assert.deepEqual(pack.degraded, []);
    assert.deepEqual(pack.viewer.effective_permissions, ["workshop:read", "workshop:write"]);
    const formulation = pack.items.find((item) => item.kind === "problem-formulation");
    assert.ok(formulation);
    assert.equal(formulation.scope, "workshop");
    assert.equal(formulation.untrusted, true);
    const exact = JSON.parse(formulation.body);
    for (const [key, value] of Object.entries(proposal)) assert.deepEqual(exact[key], value);
    assert.equal(exact.publication, "private-draft");
    assert.equal(exact.statement_version, 1);
    assert.deepEqual(
      pack.next_actions.filter((action) => action.method === "POST").map((action) => action.url),
      [`/v1/sessions/${opened.session_id}/workshop`],
    );
    const unchanged = await worker.fetch(origin + packUrl, {
      headers: {
        "user-agent": userAgent,
        authorization: `Bearer ${token}`,
        "if-none-match": etag,
      },
    });
    assert.equal(unchanged.status, 304);
    await unchanged.arrayBuffer();

    const preparation = pack.items.find((item) => item.id === "SYS-private-preparation");
    assert.ok(preparation);
    const { contract } = JSON.parse(preparation.body);
    const pushed = await call(
      contract.url,
      {
        ...contract.prefill,
        title: "PRIVATE_PACK_RETAINED_WORK",
        body_md: "PRIVATE_PACK_BODY: check the single-vertex tree before the induction step.",
      },
      token,
      201,
    );
    await call(
      `/v1/sessions/${opened.session_id}/close`,
      {
        handback: "PRIVATE_PACK_HANDBACK: continue with the two-vertex case.",
        promote: [],
        keep: [pushed.workshop_id],
        discard: [],
      },
      token,
      201,
    );
    const resumed = await call("/v1/sessions", { problem_id: problem }, token, 201);
    const resumedUrl = `/v1/sessions/${resumed.session_id}/pack?profile=working`;
    const resumedPack = PackResponseSchema.parse(await call(resumedUrl, undefined, token));
    assert.ok(resumedPack.items.some((item) => item.id === pushed.workshop_id));
    assert.ok(JSON.stringify(resumedPack).includes("PRIVATE_PACK_HANDBACK"));
    const retained = await call(
      `/v1/sessions/${resumed.session_id}/workshop/${pushed.workshop_id}`,
      undefined,
      token,
    );
    assert.ok(JSON.stringify(retained).includes("PRIVATE_PACK_BODY"));

    const revisedStatement =
      "For every finite nonempty simple tree, the edge count equals its vertex count minus one.";
    await reviseStatement(problem, sponsor, token, {
      action: "revise-statement",
      statement: revisedStatement,
      falsifier: proposal.falsifier,
      motivation: proposal.motivation,
      scope: proposal.scope,
      out_of_scope: proposal.out_of_scope,
      success_criteria: proposal.success_criteria,
    });
    const revisedPack = PackResponseSchema.parse(await call(resumedUrl, undefined, token));
    const current = revisedPack.items.find((item) => item.kind === "problem-formulation");
    assert.ok(current);
    assert.equal(JSON.parse(current.body).statement_version, 2);
    assert.equal(JSON.parse(current.body).statement, revisedStatement);
    assert.equal(revisedPack.cursor, 0);

    for (const profile of ["hello", "orient", "working", "digest"]) {
      const small = PackResponseSchema.parse(
        await call(
          `/v1/sessions/${resumed.session_id}/pack?profile=${profile}&max_tokens=800`,
          undefined,
          token,
        ),
      );
      assert.ok(small.tokens_estimate <= 800);
      assert.deepEqual(small.degraded, []);
      assert.ok(small.next_actions.some((action) => action.method === "GET"));
    }
    const peer = await enroll("private-pack-unbound-peer", sponsor);
    await call(`/v1/problems/${problem}`, undefined, peer, 404);
    await call("/v1/sessions", { problem_id: problem }, peer, 404);
    await call(`/v1/sessions/${resumed.session_id}/pack`, undefined, peer, 404);
    await call(`/v1/sessions/${resumed.session_id}/pack?profile=full`, undefined, token, 404);
    await call(`/p/${problem}.json`, undefined, undefined, 404);
    const index = await call("/problems.json");
    assert.equal(
      index.problems.some((item) => item.id === problem),
      false,
    );
    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
      .bind(problem)
      .first();
    assert.equal(events.n, 0);
    console.log(
      JSON.stringify({
        stage: "private-problem-pack-real-bindings-passed",
        exact_private_formulation: true,
        executable_preparation: true,
        retained_work_recovered: true,
        private_version_refresh: true,
        bounded_profiles: ["hello", "orient", "working", "digest"],
        public_events: 0,
        unauthorized_reads_refused: true,
      }),
    );
  },
);
