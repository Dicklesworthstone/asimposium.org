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

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, worker, origin, userAgent }) => {
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
  await call(
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
  await verify(reviewB, reviewerB, "claude");
  const reviewC = await sessionOf(reviewerC, "review");
  await verify(reviewC, reviewerC, "gemini");
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

  console.log(
    JSON.stringify({
      stage: "honors-journey-passed",
      kind: "honors-real-bindings",
      status: "pass",
      honored: earned.length,
      boundary:
        "real local Workerd/D1; honors from committed events; label independence not covered",
    }),
  );
});
