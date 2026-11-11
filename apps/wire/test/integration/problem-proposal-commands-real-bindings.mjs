import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  FellowProblemBriefReadResponseSchema,
  fellowProblemBriefReadUrl,
  ProposeProblemResponseSchema,
  SaveProblemBriefResponseSchema,
  SearchResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const fingerprint = (value) => digest(JSON.stringify(value));
const BRIEFS = "/v1/sponsors/problem-briefs";

// Genuine local Workerd/D1/R2 and signed sponsor ingress. Enrollment and
// screening are synthetic journey fixtures, not a hosted OAuth/model proof.
await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, fixtures, env, worker, origin, userAgent, workerLogs }) => {
    const sponsor = "usr_problem_proposal_owner";
    const author = await enroll("problem-proposal-author", sponsor);
    const foreign = await enroll("problem-proposal-foreign", "usr_problem_proposal_foreign");
    const fellow = (await call("/v1/hello", undefined, author)).fellow.fellow_id;
    const privateCanary = "PRIVATE_PROBLEM_PROPOSAL_COMMAND_94a6";
    const initialCursor = await call("/cursor");
    const keys = {
      parallel: "problem-proposal-parallel",
      uncertain: "problem-proposal-discarded-response",
      stale: "problem-proposal-stale-intent",
      adoption: "problem-proposal-current-intent",
      denied: "problem-proposal-review-scope-denied",
      brief: "problem-proposal-brief-create",
      edit: "problem-proposal-brief-edit",
    };
    const proposal = {
      title: "Private finite path preparation",
      statement: "Every finite simple path with n edges has exactly n + 1 vertices.",
      falsifier: "A finite simple path whose vertex count differs from its edge count plus one.",
      motivation: `${privateCanary}: prepare a finite counting argument for independent review.`,
      scope: "Finite undirected simple paths, including the single-vertex path.",
      out_of_scope: "Cycles, infinite paths and walks that repeat vertices.",
      success_criteria:
        "A checkable argument from the definitions, or an explicit in-scope counterexample.",
      areas: ["combinatorics"],
    };
    const propose = async (body, key, expected = 201, token = author) => {
      const result = await call("/v1/problems", body, token, expected, key);
      return expected === 201 ? ProposeProblemResponseSchema.parse(result) : result;
    };
    const receipt = (key) =>
      env.DB.prepare(
        "SELECT * FROM problem_proposal_command_receipts WHERE fellow_id = ? AND key_digest = ?",
      )
        .bind(fellow, digest(key))
        .first();
    const problemCount = async () =>
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM problems WHERE sponsor_id = ?")
          .bind(sponsor)
          .first()
      ).n;
    const briefState = (id) =>
      env.DB.prepare("SELECT * FROM sponsor_problem_briefs WHERE id = ?").bind(id).first();
    const saveBrief = async (body, key) =>
      SaveProblemBriefResponseSchema.parse(
        await sponsorCall(sponsor, "POST", BRIEFS, "save-problem-brief", body, 201, BRIEFS, key),
      );

    // Both requests cross the real endpoint with the same stable command key.
    // Their competing atomic batches must elect one draft and one receipt.
    const [created, raced] = await Promise.all([
      propose(proposal, keys.parallel),
      propose(proposal, keys.parallel),
    ]);
    assert.equal(fingerprint(raced), fingerprint(created));
    assert.equal(created.problem.status, "private-draft");
    assert.equal(created.problem.public_seq, 0);
    assert.equal(await problemCount(), 1);
    assert.deepEqual((await call("/v1/hello", undefined, author)).problem_creation_budget, {
      limit: 2,
      remaining: 1,
      window_seconds: 86_400,
    });
    assert.equal((await receipt(keys.parallel)).problem_id, created.problem.id);
    for (const table of ["problem_memberships", "problem_stewards", "problem_statement_versions"]) {
      assert.equal(
        (
          await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE problem_id = ?`)
            .bind(created.problem.id)
            .first()
        ).n,
        1,
        "parallel recovery must not leave duplicate draft projections",
      );
    }
    const changed = await propose(
      { ...proposal, title: "An unrelated command under an occupied key" },
      keys.parallel,
      409,
    );
    assert.equal(changed.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(await problemCount(), 1);
    assert.equal(fingerprint(await propose(proposal, keys.parallel)), fingerprint(created));

    // Drop a successful response body before the client can learn its id.
    // Retrying its exact command must recover that accepted draft, not create
    // another one or mistake the original draft for a duplicate proposal.
    const uncertainBody = {
      ...proposal,
      title: "Private cycle counting preparation",
      statement: "Every finite undirected simple cycle has equally many edges and vertices.",
      falsifier: "A finite undirected simple cycle with unequal edge and vertex counts.",
      scope: "Finite undirected simple cycles with at least three vertices.",
      out_of_scope: "Paths, multigraphs and infinite cycles.",
    };
    const lost = await worker.fetch(`${origin}/v1/problems`, {
      method: "POST",
      headers: {
        "User-Agent": userAgent,
        authorization: `Bearer ${author}`,
        "content-type": "application/json",
        "Idempotency-Key": keys.uncertain,
      },
      body: JSON.stringify(uncertainBody),
    });
    assert.equal(lost.status, 201);
    assert.equal(lost.headers.get("cache-control"), "private, no-store");
    assert.equal(lost.headers.get("x-robots-tag"), "noindex, nofollow");
    await lost.body?.cancel();
    const accepted = await receipt(keys.uncertain);
    assert.ok(accepted);
    const recovered = await propose(uncertainBody, keys.uncertain);
    assert.equal(recovered.problem.id, accepted.problem_id);
    assert.equal(await problemCount(), 2);
    assert.equal(fingerprint(await propose(uncertainBody, keys.uncertain)), fingerprint(recovered));

    const exhausted = (await call("/v1/hello", undefined, author)).problem_creation_budget;
    assert.equal(exhausted.limit, 2);
    assert.equal(exhausted.remaining, 0);
    assert.equal(exhausted.window_seconds, 86_400);
    assert.ok(exhausted.retry_after_seconds > 0 && exhausted.retry_after_seconds <= 86_400);
    const peer = await enroll("problem-proposal-peer", sponsor);
    const quotaBody = {
      ...proposal,
      title: "Another Fellow cannot buy a separate allowance",
      statement: "Every nonempty finite tree has at least one leaf.",
    };
    const quotaRefusal = await worker.fetch(`${origin}/v1/problems`, {
      method: "POST",
      headers: {
        "User-Agent": userAgent,
        authorization: `Bearer ${peer}`,
        "content-type": "application/json",
        "Idempotency-Key": "problem-proposal-shared-limit",
      },
      body: JSON.stringify(quotaBody),
    });
    assert.equal(quotaRefusal.status, 429);
    assert.equal(quotaRefusal.headers.get("cache-control"), "private, no-store");
    assert.equal(quotaRefusal.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(quotaRefusal.headers.get("ratelimit-limit"), "2");
    assert.equal(quotaRefusal.headers.get("ratelimit-remaining"), "0");
    assert.ok(Number(quotaRefusal.headers.get("retry-after")) > 0);
    assert.equal((await quotaRefusal.json()).code, "RATE_LIMITED");
    assert.equal(await problemCount(), 2);
    assert.equal(
      (await call("/v1/hello", undefined, foreign)).problem_creation_budget.remaining,
      2,
    );
    const triage = await worker.fetch(`${origin}/v1/triage.md`, {
      headers: { "User-Agent": userAgent, authorization: `Bearer ${author}` },
    });
    assert.equal(triage.status, 200);
    const triageText = await triage.text();
    const triageBudget = /"problem_creation_budget":\s*(\{[^}]+\})/.exec(triageText);
    assert.ok(triageBudget);
    const markdownBudget = JSON.parse(triageBudget[1]);
    assert.equal(markdownBudget.limit, 2);
    assert.equal(markdownBudget.remaining, 0);
    assert.equal(markdownBudget.window_seconds, 86_400);
    assert.match(triageText, /"limit": 2/);
    assert.match(triageText, /"window_seconds": 86400/);
    assert.match(triageText, /sponsor/i);
    assert.match(triageText, /forks/i);

    // A sponsor can keep the same assignee while changing the actual intent.
    // Adoption must pin the version read, not merely the brief's identity.
    const intent = {
      ...proposal,
      title: "Private rooted-tree preparation",
      statement: "Each vertex in a finite rooted tree has a unique simple path to the root.",
      falsifier:
        "A finite rooted tree with a vertex that has no path or two simple paths to its root.",
      scope: "Finite undirected simple trees with one distinguished root.",
      out_of_scope: "Disconnected graphs, cycles and multiple-root conventions.",
      assigned_fellow_id: fellow,
    };
    const saved = await saveBrief(intent, keys.brief);
    const readUrl = fellowProblemBriefReadUrl(saved.brief.id);
    const firstRead = FellowProblemBriefReadResponseSchema.parse(
      await call(readUrl, undefined, author),
    );
    assert.equal(firstRead.brief.version, 1);
    const firstAction = firstRead.next_actions.find((action) => action.url === "/v1/problems");
    assert.ok(firstAction);
    assert.deepEqual(firstAction.body_prefill, {
      brief_id: saved.brief.id,
      expected_brief_version: 1,
    });
    const { assigned_fellow_id: _assignee, ...oldFormulation } = intent;
    const staleBody = { ...oldFormulation, ...firstAction.body_prefill };
    const revised = {
      ...intent,
      statement:
        "A finite tree with at least two vertices has at least two vertices of degree one.",
      falsifier: "A finite tree with at least two vertices and fewer than two degree-one vertices.",
      scope: "Finite undirected simple trees with at least two vertices.",
      out_of_scope: "The one-vertex tree, directed graphs and infinite trees.",
    };
    const edited = await saveBrief(
      { ...revised, id: saved.brief.id, expected_version: 1 },
      keys.edit,
    );
    assert.equal(edited.brief.version, 2);
    assert.equal(edited.brief.assigned_fellow_id, fellow);
    const beforeStale = fingerprint(await briefState(saved.brief.id));
    const stale = await propose(staleBody, keys.stale, 409);
    assert.equal(stale.code, "BRIEF_VERSION_CONFLICT");
    assert.equal(stale.current_version, 2);
    assert.equal(stale.refetch_url, readUrl);
    assert.equal(fingerprint(await briefState(saved.brief.id)), beforeStale);
    assert.equal(await problemCount(), 2);
    assert.equal(await receipt(keys.stale), null);
    const fresh = FellowProblemBriefReadResponseSchema.parse(
      await call(stale.refetch_url, undefined, author),
    );
    const freshAction = fresh.next_actions.find((action) => action.url === "/v1/problems");
    assert.ok(freshAction);
    assert.deepEqual(freshAction.body_prefill, {
      brief_id: saved.brief.id,
      expected_brief_version: 2,
    });
    const { assigned_fellow_id: _revisedAssignee, ...freshFormulation } = revised;
    const adoption = { ...freshFormulation, ...freshAction.body_prefill };
    const beforeLimitedAdoption = fingerprint(await briefState(saved.brief.id));
    assert.equal((await propose(adoption, keys.adoption, 429)).code, "RATE_LIMITED");
    assert.equal(fingerprint(await briefState(saved.brief.id)), beforeLimitedAdoption);
    assert.equal(await receipt(keys.adoption), null);

    // The remainder is the next rolling-window scenario. Age one historical
    // admission explicitly; production admission and its guard remain active.
    await env.DB.prepare(
      "UPDATE problem_creation_admissions SET created_at = ? WHERE problem_id = ?",
    )
      .bind(Date.now() - 86_400_000, created.problem.id)
      .run();
    assert.equal((await call("/v1/hello", undefined, author)).problem_creation_budget.remaining, 1);
    const adopted = await propose(adoption, keys.adoption);
    assert.equal(adopted.problem.status, "private-draft");
    assert.equal(adopted.problem.scope, revised.scope);
    assert.equal(await problemCount(), 3);
    const adoptedState = await briefState(saved.brief.id);
    assert.equal(adoptedState.status, "adopted");
    assert.equal(adoptedState.version, 3);
    assert.equal(fingerprint(await propose(adoption, keys.adoption)), fingerprint(adopted));
    assert.equal(fingerprint(await briefState(saved.brief.id)), fingerprint(adoptedState));
    await call(readUrl, undefined, author, 404);

    // Real scope approval is still authoritative for a new command.
    const invitation = await fixtures.mint("usr_problem_proposal_review_only", ["review"]);
    const claimed = await call(
      "/v1/fellows",
      {
        enrollment_id: invitation.enrollmentId,
        secret: invitation.secret,
        name: "problem-proposal-review-only",
        model: "synthetic-proposal-model",
        harness: "local-proposal-command-proof",
      },
      undefined,
      202,
    );
    await fixtures.approve("usr_problem_proposal_review_only", invitation.enrollmentId);
    const reviewOnly = await call("/v1/fellows/flow", { flow_handle: claimed.flow_handle });
    const beforeDenied = (await env.DB.prepare("SELECT COUNT(*) AS n FROM problems").first()).n;
    const denied = await propose(
      { ...proposal, distinct_because: "Scope refusal must precede duplicate detection." },
      keys.denied,
      403,
      reviewOnly.token,
    );
    assert.equal(denied.code, "WRITE_REFUSED");
    assert.equal(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM problems").first()).n,
      beforeDenied,
    );

    const ids = [created.problem.id, recovered.problem.id, adopted.problem.id];
    for (const id of ids) {
      await call(`/p/${id}.json`, undefined, undefined, 404);
      const forbidden = await call(`/v1/problems/${id}`, undefined, foreign, 404);
      assert.equal(JSON.stringify(forbidden).includes(privateCanary), false);
      assert.equal(
        (
          await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
            .bind(id)
            .first()
        ).n,
        0,
      );
      const search = SearchResponseSchema.parse(await call(`/search.json?q=${id}`));
      assert.equal(JSON.stringify(search.items).includes(id), false);
    }
    const publicIndex = JSON.stringify(await call("/problems.json"));
    for (const value of [...ids, privateCanary]) assert.equal(publicIndex.includes(value), false);
    assert.equal(await call("/cursor"), initialCursor);

    // A signed private erasure keeps the metadata receipt as a barrier against
    // an uncertain late retry silently recreating the discarded formulation.
    const erased = await sponsorCall(
      sponsor,
      "DELETE",
      `/v1/sponsors/problems/${created.problem.id}`,
      "delete-problem-draft",
    );
    assert.equal(erased.deleted, true);
    const countAfterErasure = await problemCount();
    const erasedRetry = await propose(proposal, keys.parallel, 404);
    assert.equal(erasedRetry.code, "PROBLEM_NOT_FOUND");
    assert.equal(await problemCount(), countAfterErasure);
    assert.equal((await receipt(keys.parallel)).problem_id, created.problem.id);
    assert.equal(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM problem_statement_versions WHERE problem_id = ?",
        )
          .bind(created.problem.id)
          .first()
      ).n,
      0,
    );

    // Erasing a still-charged draft retains its original creation admission.
    await sponsorCall(
      sponsor,
      "DELETE",
      `/v1/sponsors/problems/${recovered.problem.id}`,
      "delete-problem-draft",
    );
    assert.equal((await call("/v1/hello", undefined, author)).problem_creation_budget.remaining, 0);
    assert.equal(
      (await propose(quotaBody, "problem-proposal-after-erasure", 429)).code,
      "RATE_LIMITED",
    );
    assert.ok(
      await env.DB.prepare("SELECT 1 FROM problem_creation_admissions WHERE problem_id = ?")
        .bind(recovered.problem.id)
        .first(),
    );

    // Two independent commands compete for one real D1 slot. Their entire
    // private creation batches must agree with the single durable admission.
    const raceSponsor = "usr_problem_creation_race";
    const raceToken = await enroll("problem-creation-racer", raceSponsor);
    await propose(
      { ...proposal, statement: "Every finite simple path is acyclic." },
      "quota-race-first",
      201,
      raceToken,
    );
    const candidates = [
      { ...proposal, statement: "Every finite simple cycle has degree two at every vertex." },
      { ...proposal, statement: "Every finite tree is connected and acyclic." },
    ];
    const competing = await Promise.all(
      candidates.map((body, index) =>
        worker.fetch(`${origin}/v1/problems`, {
          method: "POST",
          headers: {
            "User-Agent": userAgent,
            authorization: `Bearer ${raceToken}`,
            "content-type": "application/json",
            "Idempotency-Key": `quota-race-${index}`,
          },
          body: JSON.stringify(body),
        }),
      ),
    );
    assert.deepEqual(competing.map((response) => response.status).sort(), [201, 429]);
    for (const response of competing) {
      const body = await response.json();
      if (response.status === 201) ProposeProblemResponseSchema.parse(body);
      else assert.equal(body.code, "RATE_LIMITED");
    }
    for (const table of [
      "problems",
      "problem_creation_admissions",
      "problem_proposal_command_receipts",
    ]) {
      assert.equal(
        (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE sponsor_id = ?`)
          .bind(raceSponsor)
          .first()).n,
        2,
      );
    }
    assert.equal(await call("/cursor"), initialCursor);

    const receipts = await env.DB.prepare(
      "SELECT * FROM problem_proposal_command_receipts WHERE fellow_id = ? ORDER BY key_digest",
    )
      .bind(fellow)
      .all();
    assert.equal(receipts.success, true);
    assert.equal(
      receipts.results.length,
      3,
      "only accepted creations have receipts, including the erased draft",
    );
    for (const row of receipts.results) {
      assert.equal(row.sponsor_id, sponsor);
      assert.equal(row.expires_at - row.created_at, 86_400_000);
      assert.match(row.key_digest, /^[a-f0-9]{64}$/);
      assert.match(row.request_digest, /^[a-f0-9]{64}$/);
    }
    const receiptBytes = JSON.stringify(receipts.results);
    const logs = workerLogs()
      .map((line) => line.message)
      .join("\n");
    for (const value of [
      privateCanary,
      proposal.statement,
      uncertainBody.statement,
      intent.statement,
      revised.statement,
      ...Object.values(keys),
    ]) {
      assert.equal(
        receiptBytes.includes(value),
        false,
        "receipts retain only digests and identity metadata",
      );
      assert.equal(
        logs.includes(value),
        false,
        "runtime logs omit private formulation prose and raw keys",
      );
    }
    assert.equal(logs.includes(invitation.secret), false);
    console.log(
      JSON.stringify({
        kind: "problem-proposal-commands-real-bindings",
        status: "pass",
        concurrent_same_key: true,
        discarded_response_recovered: true,
        changed_body_conflict: true,
        same_assignee_version_checked: true,
        adoption_replay: true,
        erased_draft_not_recreated: true,
        scope_and_privacy_preserved: true,
        sponsor_shared_creation_limit: true,
        concurrent_final_slot: true,
        erased_creation_still_charged: true,
        hello_and_triage_budget: true,
        committed_receipts: receipts.results.length,
        public_events: 0,
        boundary:
          "Actual local Workerd/D1/R2 and signed sponsor requests; synthetic identity/screening, no deployment claim",
      }),
    );
  },
);
