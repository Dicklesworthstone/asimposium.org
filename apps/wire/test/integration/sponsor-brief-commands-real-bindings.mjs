import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  FellowProblemBriefListResponseSchema,
  FellowProblemBriefReadResponseSchema,
  fellowProblemBriefReadUrl,
  SaveProblemBriefResponseSchema,
  SponsorProblemBriefListResponseSchema,
  WithdrawProblemBriefResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

const BRIEFS = "/v1/sponsors/problem-briefs";
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Genuine local Workerd/D1/R2 and signed sponsor ingress. Identity and screening
// are the shared synthetic journey fixtures; this is not a hosted OAuth proof.
await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, env, worker, origin, userAgent, workerLogs }) => {
    const sponsor = "usr_brief_command_owner";
    const otherSponsor = "usr_brief_command_other";
    const firstToken = await enroll("brief-command-first", sponsor);
    const secondToken = await enroll("brief-command-second", sponsor);
    const foreignToken = await enroll("brief-command-foreign", otherSponsor);
    const firstFellow = (await call("/v1/hello", undefined, firstToken)).fellow.fellow_id;
    const secondFellow = (await call("/v1/hello", undefined, secondToken)).fellow.fellow_id;
    const privateCanary = "PRIVATE_BRIEF_COMMAND_CONTENT_73a9";
    const keys = {
      create: "brief-command-parallel-create",
      conflict: "brief-command-stale-edit",
      reassign: "brief-command-reassign",
      edit: "brief-command-later-edit",
      staleWithdrawal: "brief-command-stale-withdrawal",
      withdraw: "brief-command-withdraw",
      adoption: "brief-command-adoption-save",
      adoptedWithdrawal: "brief-command-adopted-withdrawal",
      foreign: "brief-command-foreign-edit",
    };
    const initial = {
      title: "Private finite tree preparation",
      statement: "Every finite nonempty simple tree has one fewer edge than vertices.",
      falsifier:
        "A finite nonempty simple tree whose edge count is not its vertex count minus one.",
      motivation: `${privateCanary}: establish the finite edge invariant before attempting a larger graph argument.`,
      scope: "Finite nonempty undirected simple trees.",
      out_of_scope: "Infinite graphs, multigraphs and disconnected forests.",
      success_criteria:
        "A checkable argument from the stated definitions, or a counterexample in scope.",
      areas: ["combinatorics"],
      assigned_fellow_id: firstFellow,
      famous_guardrail: {
        canonical_formulation:
          "The finite tree edge-count theorem under the stated graph conventions.",
        variant_distinctions:
          "A forest has one fewer edge per connected component, not necessarily one fewer edge in total.",
        authoritative_references: [
          "Use the explicit definitions and hypotheses in this private preparation brief.",
        ],
        standing_banner: "Private preparation does not establish an independently reviewed result.",
      },
    };

    async function save(request, key, expected = 201, principal = sponsor) {
      const result = await sponsorCall(
        principal,
        "POST",
        BRIEFS,
        "save-problem-brief",
        request,
        expected,
        BRIEFS,
        key,
      );
      return expected === 201 ? SaveProblemBriefResponseSchema.parse(result) : result;
    }
    async function withdraw(id, version, key, expected = 200) {
      const path = `${BRIEFS}/${encodeURIComponent(id)}/withdraw`;
      const result = await sponsorCall(
        sponsor,
        "POST",
        path,
        "withdraw-problem-brief",
        { expected_version: version },
        expected,
        path,
        key,
      );
      return expected === 200 ? WithdrawProblemBriefResponseSchema.parse(result) : result;
    }
    const stored = (id) =>
      env.DB.prepare("SELECT * FROM sponsor_problem_briefs WHERE id = ?").bind(id).first();
    const assigned = async (token) =>
      FellowProblemBriefListResponseSchema.parse(
        await call("/v1/problem-briefs", undefined, token),
      );
    const sponsorBriefs = async () =>
      SponsorProblemBriefListResponseSchema.parse(
        await sponsorCall(sponsor, "GET", BRIEFS, "list-problem-briefs"),
      );

    // Two freshly signed requests share a command key, not an envelope nonce.
    // Exactly one private brief and receipt may survive the competing batches.
    const [created, concurrentReplay] = await Promise.all([
      save(initial, keys.create),
      save(initial, keys.create),
    ]);
    assert.equal(
      fingerprint(concurrentReplay),
      fingerprint(created),
      "parallel same-key requests return the same receipt",
    );
    const id = created.brief.id;
    assert.equal(created.brief.version, 1);
    assert.equal(created.brief.assigned_fellow_id, firstFellow);
    assert.equal(fingerprint(await save(initial, keys.create)), fingerprint(created));
    assert.equal(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM sponsor_problem_briefs WHERE sponsor_id = ?",
        )
          .bind(sponsor)
          .first()
      ).n,
      1,
    );
    const bodyConflict = await save(
      { ...initial, title: "A different private command" },
      keys.create,
      409,
    );
    assert.equal(bodyConflict.code, "IDEMPOTENCY_CONFLICT");
    assert.equal((await stored(id)).version, 1);

    const firstList = await assigned(firstToken);
    assert.deepEqual(
      firstList.briefs.map((brief) => brief.id),
      [id],
    );
    assert.equal(
      JSON.stringify(firstList).includes(privateCanary),
      false,
      "listing does not expose formulation bodies",
    );
    const readUrl = firstList.briefs[0].read_url;
    assert.equal(readUrl, fellowProblemBriefReadUrl(id));
    const privateRead = await worker.fetch(origin + readUrl, {
      headers: { "User-Agent": userAgent, authorization: `Bearer ${firstToken}` },
    });
    assert.equal(privateRead.status, 200);
    assert.equal(privateRead.headers.get("cache-control"), "private, no-store");
    assert.equal(privateRead.headers.get("x-robots-tag"), "noindex, nofollow");
    const detail = FellowProblemBriefReadResponseSchema.parse(await privateRead.json());
    assert.equal(fingerprint(detail.brief), fingerprint(created.brief));
    assert.ok(detail.next_actions.some((action) => action.url === "/v1/problems"));
    const unknown = await call(
      fellowProblemBriefReadUrl("brief-not-present"),
      undefined,
      foreignToken,
      404,
    );
    assert.equal(
      fingerprint(await call(readUrl, undefined, foreignToken, 404)),
      fingerprint(unknown),
    );
    await call(readUrl, undefined, secondToken, 404);
    await call(readUrl, undefined, undefined, 401);
    assert.deepEqual((await assigned(secondToken)).briefs, []);
    const beforeForeign = fingerprint(await stored(id));
    const foreignEdit = await save(
      { ...initial, id, expected_version: 1 },
      keys.foreign,
      404,
      otherSponsor,
    );
    assert.equal(foreignEdit.code, "BRIEF_NOT_FOUND");
    assert.equal(fingerprint(await stored(id)), beforeForeign);

    const reassignRequest = {
      ...initial,
      id,
      expected_version: 1,
      title: "Private finite tree preparation, reassigned",
      assigned_fellow_id: secondFellow,
    };
    const reassigned = await save(reassignRequest, keys.reassign);
    assert.equal(reassigned.brief.version, 2);
    assert.equal(reassigned.brief.created_at, created.brief.created_at);
    assert.equal(reassigned.brief.assigned_fellow_id, secondFellow);
    assert.equal(
      fingerprint(reassigned.brief.famous_guardrail),
      fingerprint(initial.famous_guardrail),
    );
    assert.equal(
      fingerprint([
        reassigned.brief.scope,
        reassigned.brief.out_of_scope,
        reassigned.brief.success_criteria,
      ]),
      fingerprint([initial.scope, initial.out_of_scope, initial.success_criteria]),
    );
    assert.deepEqual((await assigned(firstToken)).briefs, []);
    await call(readUrl, undefined, firstToken, 404);
    assert.deepEqual(
      (await assigned(secondToken)).briefs.map((brief) => brief.id),
      [id],
    );
    const secondRead = FellowProblemBriefReadResponseSchema.parse(
      await call(readUrl, undefined, secondToken),
    );
    assert.equal(fingerprint(secondRead.brief), fingerprint(reassigned.brief));

    const latestRequest = {
      ...reassignRequest,
      expected_version: 2,
      statement:
        "For each finite nonempty undirected simple tree, the number of edges equals the number of vertices minus one.",
    };
    const latest = await save(latestRequest, keys.edit);
    assert.equal(latest.brief.version, 3);
    const latestState = fingerprint(await stored(id));
    // A replay is the original response, even after the assignee and formulation
    // have changed. Recovering it must never restore its old state.
    assert.equal(fingerprint(await save(initial, keys.create)), fingerprint(created));
    assert.equal(fingerprint(await save(reassignRequest, keys.reassign)), fingerprint(reassigned));
    assert.equal(fingerprint(await stored(id)), latestState);
    const stale = await save({ ...reassignRequest, title: "An obsolete edit" }, keys.conflict, 409);
    assert.equal(stale.code, "BRIEF_VERSION_CONFLICT");
    assert.equal(stale.current_version, 3);
    assert.equal(stale.refetch_url, BRIEFS);
    assert.equal(fingerprint(await stored(id)), latestState);
    const staleWithdrawal = await withdraw(id, 2, keys.staleWithdrawal, 409);
    assert.equal(staleWithdrawal.code, "BRIEF_VERSION_CONFLICT");
    assert.equal(staleWithdrawal.current_version, 3);
    const crossOperation = await withdraw(id, 3, keys.create, 409);
    assert.equal(crossOperation.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(fingerprint(await stored(id)), latestState);

    const withdrawn = await withdraw(id, 3, keys.withdraw);
    assert.deepEqual(withdrawn, { withdrawn: true, id, version: 4 });
    assert.equal(fingerprint(await withdraw(id, 3, keys.withdraw)), fingerprint(withdrawn));
    const withdrawnState = fingerprint(await stored(id));
    assert.equal(fingerprint(await save(reassignRequest, keys.reassign)), fingerprint(reassigned));
    assert.equal(fingerprint(await stored(id)), withdrawnState);
    assert.equal((await stored(id)).status, "withdrawn");
    assert.deepEqual((await assigned(secondToken)).briefs, []);
    await call(readUrl, undefined, secondToken, 404);
    assert.deepEqual((await sponsorBriefs()).briefs, []);

    // Adoption consumes a second active brief and advances its version. A later
    // sponsor withdrawal cannot relabel that adopted intent as withdrawn.
    const adoptionRequest = {
      ...initial,
      title: "Private leaf-count preparation",
      statement: "Every finite simple tree with at least two vertices has at least two leaves.",
      falsifier:
        "A finite simple tree with at least two vertices and fewer than two degree-one vertices.",
      famous_guardrail: {
        ...initial.famous_guardrail,
        canonical_formulation:
          "The finite tree leaf-count theorem for trees with at least two vertices.",
        variant_distinctions:
          "The one-vertex tree has no degree-one leaves, so the size condition is required.",
      },
    };
    const adoptionSave = await save(adoptionRequest, keys.adoption);
    const adoptionId = adoptionSave.brief.id;
    const adoptionReadUrl = fellowProblemBriefReadUrl(adoptionId);
    const adoptedBrief = FellowProblemBriefReadResponseSchema.parse(
      await call(adoptionReadUrl, undefined, firstToken),
    );
    assert.equal(fingerprint(adoptedBrief.brief), fingerprint(adoptionSave.brief));
    const { assigned_fellow_id: _assignedFellow, ...formulation } = adoptionRequest;
    const adopted = await call(
      "/v1/problems",
      { ...formulation, brief_id: adoptionId },
      firstToken,
      201,
    );
    assert.equal(adopted.problem.status, "private-draft");
    const adoptedRow = await stored(adoptionId);
    assert.equal(adoptedRow.status, "adopted");
    assert.equal(adoptedRow.version, 2);
    const adoptedState = fingerprint(adoptedRow);
    const adoptedWithdrawal = await withdraw(adoptionId, 2, keys.adoptedWithdrawal, 404);
    assert.equal(adoptedWithdrawal.code, "BRIEF_NOT_FOUND");
    assert.equal(fingerprint(await stored(adoptionId)), adoptedState);
    assert.equal(
      fingerprint(await save(adoptionRequest, keys.adoption)),
      fingerprint(adoptionSave),
    );
    assert.equal(fingerprint(await stored(adoptionId)), adoptedState);
    assert.deepEqual((await assigned(firstToken)).briefs, []);
    await call(adoptionReadUrl, undefined, firstToken, 404);
    assert.deepEqual((await sponsorBriefs()).briefs, []);
    await call(`/p/${adopted.problem.id}.json`, undefined, undefined, 404);
    assert.equal(
      (await call("/problems.json")).problems.some((problem) => problem.id === adopted.problem.id),
      false,
    );
    assert.equal(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
          .bind(adopted.problem.id)
          .first()
      ).n,
      0,
    );

    const receipts = await env.DB.prepare(
      "SELECT * FROM sponsor_brief_command_receipts ORDER BY key_digest",
    ).all();
    assert.equal(receipts.success, true);
    assert.equal(
      receipts.results.length,
      5,
      "only committed create/edit/withdraw commands retain receipts",
    );
    for (const receipt of receipts.results) {
      assert.equal(receipt.sponsor_id, sponsor);
      assert.equal(receipt.expires_at - receipt.created_at, 24 * 60 * 60 * 1000);
      assert.match(receipt.key_digest, /^[a-f0-9]{64}$/);
      assert.match(receipt.request_digest, /^[a-f0-9]{64}$/);
    }
    const retainedReceiptBytes = JSON.stringify(receipts.results);
    const runtimeLogBytes = workerLogs()
      .map((line) => line.message)
      .join("\n");
    for (const value of [
      privateCanary,
      initial.statement,
      latestRequest.statement,
      ...Object.values(keys),
    ]) {
      assert.equal(
        retainedReceiptBytes.includes(value),
        false,
        "receipts retain metadata, not private prose or raw command keys",
      );
      assert.equal(
        runtimeLogBytes.includes(value),
        false,
        "runtime logs omit private brief prose and raw command keys",
      );
    }
    console.log(
      JSON.stringify({
        stage: "sponsor-brief-commands-real-bindings-passed",
        concurrent_create_replay: true,
        changed_body_and_operation_refused: true,
        versioned_reassignment: true,
        historical_replay_preserves_current_state: true,
        stale_edit_and_withdrawal_refused: true,
        withdrawal_replay: true,
        adopted_brief_cannot_be_withdrawn: true,
        private_assignment_reads_current: true,
        receipt_and_log_privacy: true,
        committed_receipts: receipts.results.length,
        public_events: 0,
      }),
    );
  },
);
