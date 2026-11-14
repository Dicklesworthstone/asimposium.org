import assert from "node:assert/strict";
import { ProblemFaceResponseSchema, SearchResponseSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// P11 duplicate-problem screening must not confirm private text (real local
// Workerd/D1). A sponsor revises a private draft before publishing it; the
// earlier wording stays in problem_statement_versions but was never public.
// Another sponsor proposing that earlier wording must not be told it
// matches, while published unlisted wording still refuses as POSSIBLE_DUPLICATE.
// Unlisted hides a public problem from discovery, not from a known-URL read or
// a duplicate refusal. Never-published foreign wording remains private.
// Current controls and lawful redaction withdraw duplicate feedback even when
// the retained statement/hash and immutable publication envelope still exist.

const problemBody = (title, statement) => ({
  title,
  statement,
  falsifier: "An explicit counterexample in the stated range.",
  motivation: "Exercise duplicate screening privacy.",
  areas: ["number-theory"],
});

await runLocalWorkerJourney(
  async ({
    call,
    enroll,
    sponsorCall,
    reviseStatement,
    operatorCall,
    fixtures,
    env,
    worker,
    origin,
    userAgent,
  }) => {
    const SPONSOR_A = "usr_dup_privacy_a";
    const SPONSOR_B = "usr_dup_privacy_b";
    const fellowA = await enroll("dup-privacy-a", SPONSOR_A);
    const fellowB = await enroll("dup-privacy-b", SPONSOR_B);
    const DRAFT_WORDING = "Every prime above three is one more or one less than a multiple of six.";
    const PUBLISHED_WORDING = "Each prime greater than three is congruent to 1 or 5 modulo 6.";
    const publicRead = (path) =>
      worker.fetch(`${origin}${path}`, { headers: { "User-Agent": userAgent } });

    const problem = (
      await call(
        "/v1/problems",
        { ...problemBody("Primes mod six", DRAFT_WORDING), unlisted: true },
        fellowA,
        201,
      )
    ).problem.id;
    const privateFace = await publicRead(`/p/${problem}.json`);
    assert.equal(privateFace.status, 404);
    assert.ok(!(await privateFace.text()).includes(DRAFT_WORDING));
    await reviseStatement(problem, SPONSOR_A, fellowA, {
      action: "revise-statement",
      statement: PUBLISHED_WORDING,
      falsifier: "A prime above three congruent to 3 modulo 6.",
      motivation: "Sharper modular wording before publication.",
    });
    await sponsorCall(
      SPONSOR_A,
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      {
        action: "publish",
      },
    );

    const publicFace = await publicRead(`/p/${problem}.json`);
    assert.equal(publicFace.status, 200, "a published unlisted problem is public by known URL");
    assert.equal(publicFace.headers.get("x-robots-tag"), "noindex, nofollow");
    const projection = ProblemFaceResponseSchema.parse(await publicFace.json());
    assert.ok(JSON.stringify(projection).includes(PUBLISHED_WORDING));
    assert.ok(!JSON.stringify(projection).includes(DRAFT_WORDING));
    for (const path of ["/problems.json", `/search.json?q=${problem}`]) {
      const response = await publicRead(path);
      assert.equal(response.status, 200, path);
      const data = await response.json();
      // Search echoes its caller's query; only result items represent discovery.
      const listed = path.startsWith("/search") ? SearchResponseSchema.parse(data).items : data;
      assert.ok(!JSON.stringify(listed).includes(problem), "unlisted is absent from discovery");
    }

    // The never-published draft wording is not a public statement: no match.
    const fresh = await call(
      "/v1/problems",
      problemBody("Primes around multiples of six", DRAFT_WORDING),
      fellowB,
      201,
    );
    assert.notEqual(fresh.problem.id, problem);

    // The published wording is: the duplicate refusal intentionally names the
    // public unlisted problem even though ordinary discovery excludes it.
    const refusal = await call(
      "/v1/problems",
      problemBody("Primes mod six again", PUBLISHED_WORDING),
      fellowB,
      409,
    );
    assert.equal(refusal.code, "POSSIBLE_DUPLICATE");
    assert.equal(
      refusal.existing_problem_id,
      problem,
      "published unlisted matches retain their ID",
    );

    // A sponsor's own private draft still counts for that sponsor.
    const own = await call(
      "/v1/problems",
      problemBody("Own draft again", DRAFT_WORDING),
      fellowB,
      409,
    );
    assert.equal(own.existing_problem_id, fresh.problem.id);

    // Current visibility overrides an old public envelope. A new foreign
    // proposer must be able to create a draft without learning the hidden ID.
    const control = (action) =>
      operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
        target_id: problem,
        target_kind: "problem",
        action,
        reason: "Review the duplicate-source publication.",
      });
    await control("hide");
    assert.equal((await publicRead(`/p/${problem}.json`)).status, 404);
    const hiddenProposer = await enroll("dup-privacy-hidden", "usr_dup_privacy_hidden");
    const hiddenFresh = await call(
      "/v1/problems",
      problemBody("Independent proposal after source withdrawal", PUBLISHED_WORDING),
      hiddenProposer,
      201,
    );
    assert.notEqual(hiddenFresh.problem.id, problem);
    assert.ok(!JSON.stringify(hiddenFresh).includes(problem));

    // A later restore makes the same exact public source eligible again.
    await control("restore");
    const restored = await call(
      "/v1/problems",
      problemBody("Restored public formulation again", PUBLISHED_WORDING),
      fellowB,
      409,
    );
    assert.equal(restored.code, "POSSIBLE_DUPLICATE");
    assert.equal(restored.existing_problem_id, problem);

    // Lawful redaction removes the publication bytes, while immutable envelope
    // and statement projection survive. Neither retained row authorizes a leak.
    const source = await env.DB.prepare(
      "SELECT * FROM events WHERE problem_id=? AND type='problem.admitted'",
    )
      .bind(problem)
      .first();
    assert.ok(source, "the source has an actual public admission");
    await fixtures.redactPublicContent(source.id);
    const retained = await env.DB.prepare(
      "SELECT statement,norm_hash FROM problem_statement_versions WHERE problem_id=? AND version=?",
    )
      .bind(problem, source.object_version)
      .first();
    assert.ok(retained, "the old statement projection survives redaction");
    assert.equal(retained.statement, PUBLISHED_WORDING);
    assert.match(retained.norm_hash, /^sha256:[0-9a-f]{64}$/);
    const redactedProposer = await enroll("dup-privacy-redacted", "usr_dup_privacy_redacted");
    const redactedFresh = await call(
      "/v1/problems",
      problemBody("Independent proposal after lawful redaction", PUBLISHED_WORDING),
      redactedProposer,
      201,
    );
    assert.notEqual(redactedFresh.problem.id, problem);
    assert.ok(!JSON.stringify(redactedFresh).includes(problem));
    assert.deepEqual(
      await env.DB.prepare("SELECT * FROM events WHERE id=?").bind(source.id).first(),
      source,
      "duplicate screening and redaction preserve the immutable envelope",
    );

    console.log(
      JSON.stringify({
        kind: "problem-duplicate-privacy-real-bindings",
        status: "pass",
        boundary: "local Workerd/D1; signed sponsor lifecycle; no deploy claim",
      }),
    );
  },
);
