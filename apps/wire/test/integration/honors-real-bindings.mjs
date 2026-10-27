import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// W9.7 honors (beads asimposiumorg-dn6 / asimposiumorg-codz) on real local
// Workerd HTTP and D1, from committed events only. Honors must follow the
// computed disposition (ADR-9). They must not mint from:
//   - a surviving falsification check recorded against a DIFFERENT claim,
//   - reviews by the author's own sponsor, however many,
//   - one plain independent confirm.
// A claim that really reaches strongly-supported through the disposition
// engine must be honored.
//
// Not covered: model-family independence of self-declared labels (bead
// asimposiumorg-okkp), live multi-sponsor behaviour.

function json(text) {
  return JSON.parse(text);
}

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, env, worker, origin, userAgent }) => {
    const OWNER = "usr_honors_owner";
    const author = await enroll("honors-author", OWNER);
    const sameSponsor = await enroll("honors-same-sponsor", OWNER);
    const reviewerB = await enroll("honors-reviewer-b", "usr_honors_b");
    const reviewerC = await enroll("honors-reviewer-c", "usr_honors_c");

    const created = await call(
      "/v1/problems",
      {
        title: "Honors gaming problem",
        statement: "For all natural numbers n, n + 0 = n.",
        falsifier: "A natural number n such that n + 0 !== n.",
        motivation: "Exercise honors against gamed histories.",
        areas: ["number-theory"],
      },
      author,
      201,
    );
    const problem = created.problem.id;
    await sponsorCall(
      OWNER,
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      {
        action: "publish",
      },
    );
    const sessionOf = async (token, intent) =>
      (await call("/v1/sessions", { problem_id: problem, intent }, token, 201)).session_id;
    const reviewB = await sessionOf(reviewerB, "review");
    await call(
      `/v1/problems/${problem}/statement-review`,
      { session_id: reviewB, statement_version: 1, verdict: "statement-clear", basis: "Exact." },
      reviewerB,
    );
    const authorSession = await sessionOf(author, "prove");
    const promote = async (statement) => {
      const draft = await call(
        `/v1/sessions/${authorSession}/workshop`,
        { type: "claim-draft", title: "Draft", body_md: "Private." },
        author,
        201,
      );
      return (
        await call(
          `/v1/sessions/${authorSession}/promote`,
          {
            workshop_id: draft.workshop_id,
            kind: "conjecture",
            statement,
            falsifier: "A natural number n such that the identity fails.",
            scientific_provenance: {
              model_family_self_declared: "gpt",
              method: { category: "deductive", procedure: "Peano axioms.", evidence: [] },
            },
          },
          author,
          201,
        )
      ).claim_id;
    };
    const claimA = await promote("For all natural n, n + 0 = n.");
    const claimB = await promote("For all natural n, 0 + n = n.");
    const claimC = await promote("For all natural n, n * 1 = n.");

    const proofFor = async (claim) =>
      (
        await call(
          `/v1/sessions/${authorSession}/evidence`,
          {
            bears_on_kind: "claim",
            bears_on_id: claim,
            bears_on_version: 1,
            direction: "supports",
            kind: "argument",
            mode: "confirmatory",
            source: {
              kind: "locator",
              locator: "https://example.invalid/peano",
              excerpt: "Peano axioms.",
            },
            body_md: "By the Peano axioms.",
          },
          author,
          201,
        )
      ).evidence_id;
    const digestsFor = async (session, token, claim, proofId) => {
      const pack = await call(
        `/v1/sessions/${session}/pack?${new URLSearchParams({ profile: "review", target: `${claim}@1` })}`,
        undefined,
        token,
      );
      const detail = json(pack.items.find((item) => item.kind === "claim-detail").body);
      const proof = json(pack.items.find((item) => item.id === proofId).body);
      return {
        claimDigest: detail.content_digest,
        proofRef: { evidence_id: proofId, digest: proof.content_digest },
      };
    };
    const provenance = (family, proofRef) => ({
      model_family_self_declared: family,
      method: { category: "deductive", procedure: "Direct check.", evidence: [proofRef] },
    });
    const honored = async () =>
      (await call("/results.json", undefined, undefined, 200)).results
        .filter((item) => item.kind === "claim")
        .map((item) => item.result_id);

    // Gamed history 1: a surviving check on claim A...
    const proofA = await proofFor(claimA);
    const refsA = await digestsFor(reviewB, reviewerB, claimA, proofA);
    const falsification = await call(
      `/v1/sessions/${reviewB}/evidence`,
      {
        bears_on_kind: "claim",
        bears_on_id: claimA,
        bears_on_version: 1,
        direction: "informs",
        kind: "computation",
        mode: "confirmatory",
        source: { kind: "locator", locator: "https://example.invalid/check", excerpt: "0..10000." },
        computation_domain_or_floor: "Natural n in [0, 10000]",
        falsification_check: {
          target_digest: refsA.claimDigest,
          attempted_falsifier: "A natural number n such that n + 0 !== n.",
          capable_of_failure: "Any counterexample in range.",
          result: "survived",
          evidence: [refsA.proofRef],
        },
        body_md: "No counterexample in 0..10000.",
      },
      reviewerB,
      201,
    );
    // ...plus one plain independent confirm on claim B.
    const proofB = await proofFor(claimB);
    const refsB = await digestsFor(reviewB, reviewerB, claimB, proofB);
    await call(
      `/v1/sessions/${reviewB}/review`,
      {
        target_claim_id: claimB,
        target_version: 1,
        verdict: "confirm",
        basis: "Looks right.",
        capable_of_failure: "A counterexample.",
        scientific_provenance: provenance("claude", refsB.proofRef),
        body_md: "Plain confirm.",
      },
      reviewerB,
      201,
    );
    // Gamed history 2: the author's own sponsor confirms claim C, repeatedly.
    const sameSession = await sessionOf(sameSponsor, "review");
    const proofC = await proofFor(claimC);
    const refsC = await digestsFor(sameSession, sameSponsor, claimC, proofC);
    await call(
      `/v1/sessions/${sameSession}/review`,
      {
        target_claim_id: claimC,
        target_version: 1,
        verdict: "confirm",
        basis: "Same-sponsor confirm.",
        capable_of_failure: "A counterexample.",
        verification: {
          kind: "full-write-up",
          target_digest: refsC.claimDigest,
          evidence: refsC.proofRef,
          coverage: ["all n"],
          result: "verified",
        },
        scientific_provenance: provenance("gemini", refsC.proofRef),
        body_md: "Same sponsor.",
      },
      sameSponsor,
      null,
    );

    const gamed = await honored();
    assert.ok(!gamed.includes(claimB), `claim B honored from another claim's check: ${gamed}`);
    assert.ok(!gamed.includes(claimC), `claim C honored from same-sponsor reviews: ${gamed}`);

    // A supportive label without an exercised, failure-capable verification
    // must never become a carrying review, even when the target later earns it.
    const assertionBasis = "ASSERTION_ONLY_MUST_NOT_CARRY_HONORS";
    await call(
      `/v1/sessions/${reviewB}/review`,
      {
        target_claim_id: claimA,
        target_version: 1,
        verdict: "confirm",
        basis: assertionBasis,
        body_md: "This is an impression, not a verification.",
        scientific_provenance: provenance("claude", refsA.proofRef),
      },
      reviewerB,
      201,
    );

    // The honest path: two independent full write-up verifications of claim A.
    const verify = async (session, token, family) =>
      call(
        `/v1/sessions/${session}/review`,
        {
          target_claim_id: claimA,
          target_version: 1,
          verdict: "confirm",
          basis: "Full write-up verification.",
          capable_of_failure: "A flaw in the argument.",
          verification: {
            kind: "full-write-up",
            target_digest: refsA.claimDigest,
            evidence: refsA.proofRef,
            coverage: ["all n"],
            result: "verified",
          },
          scientific_provenance: provenance(family, refsA.proofRef),
          body_md: "Verified.",
        },
        token,
        201,
      );
    const qualifiedB = await verify(reviewB, reviewerB, "claude");
    const reviewC = await sessionOf(reviewerC, "review");
    const qualifiedC = await verify(reviewC, reviewerC, "gemini");
    assert.ok(
      !(await honored()).includes(claimA),
      "scientific reviews alone cannot bypass sponsor disclosure",
    );
    const disclosurePath = `/v1/sponsors/disclosures/${problem}/${claimA}/1`;
    const disclosure = await sponsorCall(OWNER, "GET", disclosurePath, "sponsor.disclosure.read");
    for (const scope of disclosure.scopes) {
      assert.equal(scope.sponsor_id, OWNER);
      await sponsorCall(OWNER, "POST", disclosurePath, "sponsor.disclosure.write", {
        scope_id: scope.scope_id,
        expected_lineage_digest: disclosure.lineage_digest,
        expected_revision: scope.revision,
        decision: "no-undisclosed",
        disclosures: [],
      });
    }
    const standing = async (claim) => {
      const pack = await call(
        `/v1/sessions/${reviewB}/pack?${new URLSearchParams({ profile: "working", max_tokens: "8000" })}`,
        undefined,
        reviewerB,
      );
      return pack.items
        .find((item) => item.kind === "claim" && item.id === claim)
        ?.body.slice(0, 160);
    };
    const earned = await honored();
    assert.ok(
      earned.includes(claimA),
      `claim A (${await standing(claimA)}) must be honored: ${earned}`,
    );
    assert.ok(!earned.includes(claimB) && !earned.includes(claimC));

    // The honored item carries its attribution and carrying reviewers, and the
    // HTML face agrees with the JSON face (Diptych).
    const item = (await call("/results.json", undefined, undefined, 200)).results.find(
      (result) => result.result_id === claimA,
    );
    assert.equal(item.status, "strongly-supported");
    assert.equal(item.problem_id, problem);
    assert.ok(item.contributing_fellows.length >= 1);
    assert.equal(
      item.carrying_reviewers.length,
      2,
      "only the two actual full-write-up checks carry recognition",
    );
    assert.ok(
      !JSON.stringify(item).includes(assertionBasis),
      "an assertion-only review receives no carrying credit",
    );
    assert.deepEqual(new Set(item.evidence_trail), new Set([proofA, falsification.evidence_id]));
    assert.ok(!item.evidence_trail.includes(proofB) && !item.evidence_trail.includes(proofC));
    const carriers = new Set(item.carrying_reviewers.map((reviewer) => reviewer.fellow_id));
    assert.ok(carriers.size >= 2, `two independent carrying reviewers: ${[...carriers]}`);
    for (const reviewer of item.carrying_reviewers) {
      assert.ok(["T2", "T3"].includes(reviewer.tier), `carrying tier ${reviewer.tier}`);
    }
    const htmlResponse = await worker.fetch(`${origin}/results.html`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(htmlResponse.status, 200);
    const html = await htmlResponse.text();
    assert.ok(html.includes("For all natural n, n + 0 = n."), "HTML face lists the honored claim");
    assert.ok(!html.includes("0 + n = n"), "HTML face omits the gamed claim");

    const resultItems = async () =>
      (await call("/results.json", undefined, undefined, 200)).results;
    const findClaim = async () =>
      (await resultItems()).find(
        (result) => result.kind === "claim" && result.result_id === claimA,
      );
    await call(
      `/v1/sessions/${reviewB}/review`,
      {
        target_claim_id: claimA,
        target_version: 1,
        verdict: "confirm",
        basis: "A later redundant impression cannot reset settlement.",
        body_md: "No new scientific check.",
      },
      reviewerB,
      201,
    );
    const laterReview = await findClaim();
    assert.equal(
      laterReview.sequence,
      item.sequence,
      "a redundant later review cannot bump chronology",
    );
    assert.equal(laterReview.settled_at, item.settled_at);
    assert.deepEqual(laterReview.carrying_reviewers, item.carrying_reviewers);

    // Historical authorship is the publication snapshot. Identity triggers
    // also prevent a later profile mutation; do not disable them for a test.
    const authorId = item.contributing_fellows[0].fellow_id;
    const publication = await env.DB.prepare(`SELECT model_string_self_declared,harness FROM events
      WHERE problem_id=? AND object_id=? AND type='claim.created'`)
      .bind(problem, claimA)
      .first();
    assert.equal(item.contributing_fellows[0].model, publication.model_string_self_declared);
    assert.equal(item.contributing_fellows[0].harness, publication.harness);
    await assert.rejects(
      env.DB.prepare(
        "UPDATE enrollment_fellows SET model='changed-after-publication',harness='different-harness' WHERE fellow_id=?",
      )
        .bind(authorId)
        .run(),
      /Fellow identity is immutable/,
    );
    assert.deepEqual((await findClaim()).contributing_fellows, item.contributing_fellows);

    const priorStatus = (
      await env.DB.prepare("SELECT status FROM problems WHERE id=?").bind(problem).first()
    ).status;
    await env.DB.prepare("UPDATE problems SET status='resolved' WHERE id=?").bind(problem).run();
    assert.ok(
      !(await resultItems()).some((result) => result.kind === "problem"),
      "a forged resolved projection never grants honors",
    );
    await env.DB.prepare("UPDATE problems SET status=? WHERE id=?")
      .bind(priorStatus, problem)
      .run();

    await sponsorCall(
      OWNER,
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      {
        action: "enter-result-review",
        result_claim: { claim_id: claimA, version: 1 },
      },
    );
    const through = (
      await env.DB.prepare("SELECT public_seq FROM problems WHERE id=?").bind(problem).first()
    ).public_seq;
    const summary =
      "Two independent full-write-up checks and a recorded falsification attempt support only the exact additive identity.";
    const boundary = {
      verified: [`The exact statement in ${claimA}@1.`],
      mechanisms: ["Two independent full-write-up checks and a surviving falsification attempt."],
      independence_tiers: ["T2"],
      remaining_external_validation: [
        "No formal-kernel execution or external expert review is claimed.",
      ],
    };
    const closing = await call(
      `/v1/sessions/${authorSession}/synthesize`,
      {
        covers_through: through,
        body_md: summary,
        anchors: [
          { target_kind: "claim", target_id: claimA, target_version: 1 },
          { target_kind: "evidence", target_id: proofA },
          { target_kind: "review", target_id: qualifiedB.review_id },
          { target_kind: "review", target_id: qualifiedC.review_id },
        ],
        omitted: ["The other claims do not enlarge this result."],
        selection_policy: "Retain the exact result and the verifications that earned its standing.",
        closing_resolution: {
          result_claim: { claim_id: claimA, version: 1 },
          direction: "affirmed",
          no_claim_boundary: boundary,
        },
      },
      author,
      201,
    );
    await sponsorCall(
      OWNER,
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      {
        action: "resolve",
        direction: "affirmed",
        closing_synthesis: {
          synthesis_id: closing.synthesis_id,
          summary,
          no_claim_boundary: boundary,
        },
      },
    );
    const resolved = (await resultItems()).find(
      (result) => result.kind === "problem" && result.result_id === problem,
    );
    assert.ok(
      resolved,
      "a genuine published closing synthesis and sponsor resolution earn recognition",
    );
    const resolutionEvent = await env.DB.prepare(
      "SELECT seq,created_at FROM events WHERE problem_id=? AND type='problem.resolved' ORDER BY seq DESC LIMIT 1",
    )
      .bind(problem)
      .first();
    assert.equal(resolved.sequence, resolutionEvent.seq);
    assert.equal(resolved.settled_at, resolutionEvent.created_at);
    assert.deepEqual(resolved.carrying_reviewers, item.carrying_reviewers);
    assert.ok(resolved.evidence_trail.includes(closing.synthesis_id));
    assert.ok(resolved.evidence_trail.includes(proofA));

    // A genuine sponsor commentary event advances the head after settlement.
    // It must never masquerade as a newer problem resolution.
    await sponsorCall(
      OWNER,
      "POST",
      `/v1/problems/${problem}/commentary`,
      "post-commentary",
      {
        problem_id: problem,
        body: "The stated result remains bounded by its published closing declaration.",
        relates_to: [{ kind: "problem", id: problem, label: "Published resolution" }],
      },
      201,
    );
    const afterCommentary = (await resultItems()).find((result) => result.kind === "problem");
    assert.equal(afterCommentary.sequence, resolved.sequence);
    assert.equal(afterCommentary.settled_at, resolved.settled_at);

    // Current visibility is authoritative even if no science event changes the
    // captured head. Append restoring controls instead of deleting test history.
    const visibility = async (target, kind, version, state) => {
      await env.DB.prepare(`INSERT INTO content_controls
      (control_id,problem_id,target_kind,target_ref,visibility,source,reason_category,actor,reason,version,created_at)
      VALUES(?,?,?,?,?,'operator','privacy','honors-lane-operator','Exercise current source visibility.',?,?)`)
        .bind(
          `CC-honors-${target}-${version}`,
          problem,
          kind,
          target,
          state,
          version,
          new Date().toISOString(),
        )
        .run();
    };
    for (const [target, kind] of [
      [proofA, "evidence"],
      [qualifiedB.review_id, "review"],
      [closing.synthesis_id, "synthesis"],
    ]) {
      await visibility(target, kind, 1, "hidden");
      const withheld = await resultItems();
      assert.ok(
        !withheld.some((result) => result.kind === "problem"),
        `${kind} withdrawal removes resolved recognition`,
      );
      if (kind !== "synthesis")
        assert.ok(
          !withheld.some((result) => result.result_id === claimA),
          `${kind} withdrawal removes claim recognition`,
        );
      assert.ok(
        !JSON.stringify(withheld).includes(target),
        "withheld sources are not republished through attribution",
      );
      await visibility(target, kind, 2, "visible");
      assert.ok(
        (await resultItems()).some((result) => result.kind === "problem"),
        "available exact sources restore earned recognition",
      );
    }

    await call(
      `/v1/sessions/${authorSession}/close`,
      {
        handback: "The result was closed; later source corrections use a fresh session.",
        promote: [],
        keep: [],
        discard: [],
      },
      author,
      201,
    );
    const correctionSession = await sessionOf(author, "review");
    assert.notEqual(
      correctionSession,
      authorSession,
      "correction remains available after the original session closes",
    );
    const refusedNewEvidence = await call(
      `/v1/sessions/${correctionSession}/evidence`,
      {
        bears_on_kind: "claim",
        bears_on_id: claimA,
        bears_on_version: 1,
        direction: "supports",
        kind: "argument",
        mode: "confirmatory",
        source: {
          kind: "locator",
          locator: "https://example.invalid/closed",
          excerpt: "Closed result.",
        },
        body_md: "A fresh scientific publication is still refused after resolution.",
      },
      author,
      403,
    );
    assert.equal(refusedNewEvidence.code, "WRITE_REFUSED");
    const proofSource = await env.DB.prepare(
      "SELECT id,payload_sha256 FROM events WHERE problem_id=? AND object_id=? AND type='evidence.created'",
    )
      .bind(problem, proofA)
      .first();
    await call(
      `/v1/sessions/${correctionSession}/evidence/${proofA}/retract`,
      {
        source_event_id: proofSource.id,
        source_digest: `sha256:${proofSource.payload_sha256}`,
        reason: "The author withdraws the proof because its stated coverage needs correction.",
      },
      author,
      200,
    );
    const corrected = await resultItems();
    assert.ok(
      !corrected.some((result) => result.result_id === claimA || result.kind === "problem"),
      "an actual source withdrawal removes stale claim and problem recognition",
    );

    console.log(
      JSON.stringify({
        stage: "honors-journey-passed",
        kind: "honors-real-bindings",
        status: "pass",
        honored: earned.length,
        boundary:
          "real local Workerd/D1; earned disclosure and published resolution; exact carrying sources, frozen attribution, stable chronology and visibility/withdrawal revocation; no deployment claim",
      }),
    );
  },
);
