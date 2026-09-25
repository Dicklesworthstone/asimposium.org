import assert from "node:assert/strict";
import { PackResponseSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Review-queue and formal pack profiles (beads asimposiumorg-lu59 /
// asimposiumorg-codz) on real local Workerd HTTP and D1. The review-queue pack
// must agree with /v1/p/:id/next for an independent reviewer (same first
// target), and must never present a same-sponsor candidate as more than T0.
// The formal profile carries open proof gaps.
//
// Not covered: formal-artifact evidence uploads, TOON faces.

function json(text) {
  return JSON.parse(text);
}

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall }) => {
  const OWNER = "usr_packs_owner";
  const author = await enroll("packs-author", OWNER);
  const sibling = await enroll("packs-sibling", OWNER);
  const outsider = await enroll("packs-outsider", "usr_packs_outsider");
  const created = await call(
    "/v1/problems",
    {
      title: "Pack selection problem",
      statement: "For all natural numbers n, n + 0 = n in the pack lane.",
      falsifier: "A natural number n such that n + 0 !== n.",
      motivation: "Exercise review-queue and formal packs.",
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
  const outsiderSession = await sessionOf(outsider, "review");
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: outsiderSession,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "Exact.",
    },
    outsider,
  );
  const authorSession = await sessionOf(author, "prove");
  const draft = await call(
    `/v1/sessions/${authorSession}/workshop`,
    { type: "claim-draft", title: "Draft", body_md: "Private." },
    author,
    201,
  );
  const claim = (
    await call(
      `/v1/sessions/${authorSession}/promote`,
      {
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement: "For all natural n, n + 0 = n.",
        falsifier: "A natural n such that n + 0 !== n.",
        scientific_provenance: {
          model_family_self_declared: "gpt",
          method: { category: "deductive", procedure: "Peano axioms.", evidence: [] },
        },
      },
      author,
      201,
    )
  ).claim_id;
  const pack = async (session, token, profile) =>
    PackResponseSchema.parse(
      await call(
        `/v1/sessions/${session}/pack?profile=${profile}&max_tokens=8000`,
        undefined,
        token,
      ),
    );
  const candidates = (p) =>
    p.items.filter((item) => item.kind === "review-candidate").map((item) => item.id);

  // Same sponsor as the author: if offered, the candidate discloses T0 and
  // never claims independence (a same-sponsor review carries no weight).
  const siblingSession = await sessionOf(sibling, "review");
  const siblingPack = await pack(siblingSession, sibling, "review-queue");
  for (const item of siblingPack.items.filter((i) => i.kind === "review-candidate")) {
    if (item.id.startsWith(`${claim}@`)) {
      assert.equal(json(item.body).prospective_independence_tier, "T0");
    }
  }

  // Independent reviewer: the pack's first target is /next's review target.
  const outsiderQueue = candidates(await pack(outsiderSession, outsider, "review-queue"));
  assert.ok(outsiderQueue.includes(`${claim}@1`), `outsider queue: ${outsiderQueue}`);
  const next = await call(`/v1/p/${problem}/next`, undefined, outsider, 200);
  assert.equal(next.primary_move?.move, "review");
  assert.equal(outsiderQueue[0], next.primary_move.refs[1], "pack and /next agree");

  // Formal profile: a verification report and an open proof gap.
  const proof = (
    await call(
      `/v1/sessions/${authorSession}/evidence`,
      {
        bears_on_kind: "claim",
        bears_on_id: claim,
        bears_on_version: 1,
        direction: "supports",
        kind: "argument",
        mode: "confirmatory",
        source: { kind: "locator", locator: "https://example.invalid/peano", excerpt: "Peano." },
        body_md: "By the Peano axioms.",
      },
      author,
      201,
    )
  ).evidence_id;
  const reviewPack = await call(
    `/v1/sessions/${outsiderSession}/pack?${new URLSearchParams({ profile: "review", target: `${claim}@1` })}`,
    undefined,
    outsider,
  );
  const claimDigest = json(
    reviewPack.items.find((item) => item.kind === "claim-detail").body,
  ).content_digest;
  const proofRef = {
    evidence_id: proof,
    digest: json(reviewPack.items.find((item) => item.id === proof).body).content_digest,
  };
  await call(
    `/v1/sessions/${outsiderSession}/review`,
    {
      target_claim_id: claim,
      target_version: 1,
      verdict: "confirm",
      basis: "Full write-up verification.",
      capable_of_failure: "A flaw in the argument.",
      verification: {
        kind: "full-write-up",
        target_digest: claimDigest,
        evidence: proofRef,
        coverage: ["all n"],
        result: "verified",
      },
      scientific_provenance: {
        model_family_self_declared: "claude",
        method: { category: "deductive", procedure: "Direct check.", evidence: [proofRef] },
      },
      body_md: "Verified.",
    },
    outsider,
    201,
  );
  await call(
    `/v1/sessions/${authorSession}/gaps`,
    {
      target_claim_id: claim,
      target_version: 1,
      obligation: "Show the successor case explicitly.",
      closes_what: "The inductive step of the identity.",
    },
    author,
    null,
  );
  const formal = await pack(authorSession, author, "formal");
  const kinds = new Set(formal.items.map((item) => item.kind));
  assert.ok(kinds.has("proof-gap"), `formal pack carries the open proof gap: ${[...kinds]}`);
  // Known gap (lu59): formal records (verification reports, formal artifacts)
  // are not in the formal profile; src/sessions/formal-pack.ts is unwired.

  console.log(
    JSON.stringify({
      stage: "packs-journey-passed",
      kind: "packs-real-bindings",
      status: "pass",
      formal_kinds: [...kinds],
      boundary: "real local Workerd/D1; review-queue and formal profiles; no TOON faces",
    }),
  );
});
