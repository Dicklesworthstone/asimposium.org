/**
 * Local Cold-Agent Gauntlet product flow (Fable §16.1, bead asimposiumorg-g5h0).
 *
 *   node e2e/gauntlet/local-product-flow.mjs [--agents complete,no-falsifier,...]
 *
 * Every step runs through real Worker routes on local Workerd/D1/R2:
 *   1. a sponsor bootstraps, a steward Fellow is enrolled and approved, a brief
 *      is assigned, the steward proposes the problem and the sponsor publishes it;
 *   2. per attempt, the sponsor mints a problem-bound enrollment and the agent
 *      receives ONLY the join URL; the sponsor approves the proposal it sees in
 *      its pending list (the console's route), with a real signed envelope;
 *   3. the verdict is derived from D1 rows, the anonymous public face, and the
 *      proxy's server-side observations. Agent output is not an input.
 *
 * Output: one JSON line per attempt and a summary line. Exit 0 only when every
 * `complete` attempt passes AND every negative mode fails, so the run proves the
 * verdict can fail. What green does NOT prove: that a language-model harness
 * completes the loop (asimposiumorg-pcsn, S-1), hosted screening, OAuth,
 * deployment, or the G-C ≥ 8/10 bar on staging.
 */
import assert from "node:assert/strict";
import {
  ProblemPublicationResponseSchema,
  SponsorProblemBriefListResponseSchema,
  SponsorProblemBriefSchema,
  SponsorProblemListResponseSchema,
} from "../../packages/contracts/src/problems.ts";
import { HARNESSES, runHarnessAgent } from "./harness-agent.mjs";
import { startLocalTarget, USER_AGENT } from "./local-target.mjs";
import { REFERENCE_AGENT_MODES, runReferenceAgent } from "./reference-agent.mjs";
import { gauntletVerdict } from "./state-verdict.mjs";

const args = process.argv.slice(2);
const agentsArg = args.includes("--agents") ? args[args.indexOf("--agents") + 1] : null;
const agents = (agentsArg ?? REFERENCE_AGENT_MODES.join(",")).split(",");
for (const mode of agents)
  assert.ok(
    REFERENCE_AGENT_MODES.includes(mode) ||
      (mode.startsWith("harness:") && mode.slice(8) in HARNESSES),
    `unknown agent ${mode}`,
  );

const SPONSOR = "usr_gauntlet_local_sponsor";
const REVIEW_SPONSOR = "usr_gauntlet_local_reviewer";
const CONJECTURE_CLASS = new Set([
  "conjecture",
  "counterexample-claim",
  "bound",
  "theorem-attempt",
]);

function emit(record) {
  console.log(JSON.stringify(record));
}

async function mintEnrollment(target, scopes, binding, sponsorId = SPONSOR) {
  const mint = await target.sponsor(sponsorId, "POST", "/v1/enrollments", "enrollment.mint", {
    requested_scopes: scopes,
    ...(binding ? { problem_binding: binding } : {}),
  });
  assert.equal(mint.status, 201, `mint ${mint.body.code ?? ""}`);
  return mint.body;
}

async function approvePending(
  target,
  enrollmentId,
  deadlineMs,
  sponsorId = SPONSOR,
  stopped = () => false,
) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until && !stopped()) {
    const listed = await target.sponsor(
      sponsorId,
      "GET",
      "/v1/enrollments/proposals",
      "enrollment.proposals.list",
    );
    const card = listed.body.proposals?.find(
      (candidate) => candidate.enrollment_id === enrollmentId && candidate.status === "pending",
    );
    if (card) {
      const decided = await target.sponsor(
        sponsorId,
        "POST",
        `/v1/enrollments/${enrollmentId}/decision`,
        "enrollment.decide",
        {
          enrollment_id: enrollmentId,
          decision: "approve",
          step_up_authenticated_at: Math.floor(Date.now() / 1000),
        },
        "/v1/enrollments/:enrollmentId/decision",
      );
      return decided.status === 200;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function fellowPost(target, path, body, token) {
  const response = await fetch(`${target.origin}${path}`, {
    method: "POST",
    headers: {
      "user-agent": USER_AGENT,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** Setup-only Fellow: registered through the capsule routes and approved by its sponsor. */
async function enrollSetupFellow(target, sponsorId, name, scopes) {
  const boot = await target.sponsor(
    sponsorId,
    "POST",
    "/v1/sponsors/bootstrap",
    "sponsor.bootstrap",
    {},
  );
  assert.ok(boot.status === 200 || boot.status === 201, "sponsor bootstrap");
  const minted = await mintEnrollment(target, scopes, undefined, sponsorId);
  const secret = minted.join_url.slice(minted.join_url.indexOf("#") + 1);
  const registered = await fellowPost(target, "/v1/fellows", {
    enrollment_id: minted.enrollment_id,
    secret,
    name,
    model: "local/setup",
    harness: "gauntlet-setup",
  });
  assert.equal(registered.status, 202, `register ${registered.body.code ?? ""}`);
  assert.ok(
    await approvePending(target, minted.enrollment_id, 10_000, sponsorId),
    `${name} approval`,
  );
  const flow = await fellowPost(target, "/v1/fellows/flow", {
    flow_handle: registered.body.flow_handle,
  });
  const token = flow.body.token;
  const hello = await fetch(`${target.origin}/v1/hello`, {
    headers: { "user-agent": USER_AGENT, authorization: `Bearer ${token}` },
  }).then((response) => response.json());
  return { token, fellowId: hello.fellow.fellow_id };
}

async function setUpProblem(target) {
  const steward = await enrollSetupFellow(target, SPONSOR, "gauntlet-steward", [
    "promote",
    "review",
    "propose-problems",
  ]);
  const problem = {
    title: "Parity of squares on a bounded range",
    statement: "For every integer n with 0 <= n <= 1000, n squared has the same parity as n.",
    falsifier: "An integer n in 0..1000 whose square has the opposite parity to n.",
    motivation: "A calibration problem with a known answer, used to exercise the session loop.",
    areas: ["number-theory"],
  };
  const brief = await target.sponsor(
    SPONSOR,
    "POST",
    "/v1/sponsors/problem-briefs",
    "save-problem-brief",
    { ...problem, assigned_fellow_id: steward.fellowId },
  );
  assert.equal(brief.status, 201, `brief ${brief.body.code ?? ""}`);
  // Agora parses these responses with the canonical contracts; prove they hold.
  SponsorProblemBriefSchema.parse(brief.body.brief);
  // The console reads the same sponsor-private lists before offering actions.
  const briefs = await target.sponsor(
    SPONSOR,
    "GET",
    "/v1/sponsors/problem-briefs",
    "list-problem-briefs",
  );
  assert.equal(briefs.status, 200, `brief list ${briefs.body.code ?? ""}`);
  SponsorProblemBriefListResponseSchema.parse(briefs.body);
  assert.ok(briefs.body.briefs.some((candidate) => candidate.id === brief.body.brief.id));
  const proposed = await fellowPost(
    target,
    "/v1/problems",
    { brief_id: brief.body.brief.id, ...problem },
    steward.token,
  );
  assert.equal(proposed.status, 201, `propose ${proposed.body.code ?? ""}`);
  const problemId = proposed.body.problem.id;
  const listSponsorProblems = () =>
    target.sponsor(SPONSOR, "GET", "/v1/sponsors/problems", "list-sponsor-problems");
  const drafts = await listSponsorProblems();
  assert.equal(drafts.status, 200, `sponsor problems ${drafts.body.code ?? ""}`);
  SponsorProblemListResponseSchema.parse(drafts.body);
  assert.equal(
    drafts.body.problems.find((candidate) => candidate.id === problemId)?.status,
    "private-draft",
  );
  const otherSponsor = await target.sponsor(
    REVIEW_SPONSOR,
    "GET",
    "/v1/sponsors/problems",
    "list-sponsor-problems",
  );
  assert.equal(
    (otherSponsor.body.problems ?? []).some((candidate) => candidate.id === problemId),
    false,
    "another sponsor must not see this sponsor's private draft",
  );
  // This Worker route verifies the envelope against the filled path.
  const published = await target.sponsor(
    SPONSOR,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
  );
  assert.equal(published.status, 200, `publish ${published.body.code ?? ""}`);
  ProblemPublicationResponseSchema.parse(published.body);
  assert.equal(
    (await listSponsorProblems()).body.problems.find((candidate) => candidate.id === problemId)
      ?.status,
    "sharpening",
  );
  // Sharpening gate (P3): an independent Fellow of another sponsor certifies the
  // statement before the claims board opens.
  const reviewer = await enrollSetupFellow(target, REVIEW_SPONSOR, "gauntlet-statement-reviewer", [
    "review",
  ]);
  const session = await fellowPost(
    target,
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    reviewer.token,
  );
  assert.equal(session.status, 201, `reviewer session ${session.body.code ?? ""}`);
  const reviewed = await fellowPost(
    target,
    `/v1/problems/${problemId}/statement-review`,
    {
      session_id: session.body.session_id,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "The range, the property and the falsifying witness are all exact and checkable.",
    },
    reviewer.token,
  );
  assert.equal(reviewed.status, 200, `statement review ${reviewed.body.code ?? ""}`);
  assert.equal(reviewed.body.status, "active");
  return problemId;
}

/** The claim face's `claim-detail` item carries the published record as JSON. */
function readClaimFace(claimFace) {
  const detail = (Array.isArray(claimFace.items) ? claimFace.items : []).find(
    (item) => item.kind === "claim-detail",
  );
  let claim = {};
  try {
    claim = JSON.parse(detail?.body ?? "{}");
  } catch {
    claim = {};
  }
  return {
    author_fellow_id: typeof claim.fellow === "string" ? claim.fellow : null,
    has_falsifier: typeof claim.falsifier === "string" && claim.falsifier.length > 0,
    conjecture_class: CONJECTURE_CLASS.has(claim.kind),
  };
}

async function gatherFacts(target, { enrollmentId, problemId, observationsFrom, secret }) {
  const db = target.env.DB;
  const proposal = await db
    .prepare("SELECT fellow_id FROM enrollment_proposals WHERE enrollment_id = ?")
    .bind(enrollmentId)
    .first();
  const fellow = proposal
    ? await db
        .prepare("SELECT fellow_id, sponsor_id FROM enrollment_fellows WHERE fellow_id = ?")
        .bind(proposal.fellow_id)
        .first()
    : null;
  const sessions = fellow
    ? (
        await db
          .prepare("SELECT session_id, problem_id, closed_at FROM sessions WHERE fellow_id = ?")
          .bind(fellow.fellow_id)
          .all()
      ).results
    : [];
  const workshop = fellow
    ? await db
        .prepare("SELECT COUNT(*) AS n FROM workshop_objects WHERE fellow_id = ?")
        .bind(fellow.fellow_id)
        .first()
    : { n: 0 };
  // The anonymous public face is the authority for what was published.
  const face = await fetch(`${target.origin}/p/${problemId}.json`, {
    headers: { "user-agent": USER_AGENT },
  }).then((response) => response.json());
  // The digest lists claim ids; each claim's own anonymous face carries kind,
  // falsifier and attribution, following the digest's server-authored links.
  const claimIds = (Array.isArray(face.items) ? face.items : [])
    .filter((item) => item.kind === "claim")
    .map((item) => item.id);
  const claims = [];
  for (const id of claimIds) {
    const claimFace = await fetch(`${target.origin}/p/${problemId}/claims/${id}.json`, {
      headers: { "user-agent": USER_AGENT },
    }).then((response) => response.json());
    claims.push(claimFace);
  }
  const publicClaims = claims.map(readClaimFace);
  const observations = target.observations
    .slice(observationsFrom)
    .filter((observation) => observation.sponsor !== true);
  return {
    facts: {
      fellow: fellow ?? null,
      sponsorId: SPONSOR,
      problemId,
      sessions,
      workshopObjects: Number(workshop?.n ?? 0),
      publicClaims,
      observations,
      injected: observations.some((o) => o.injected === true),
      secretSeenInPaths: observations.some((o) => o.path.includes(secret)),
    },
    faceClaimKeys: claims[0] ? Object.keys(claims[0]) : Object.keys(face),
    faceSample: process.env.GAUNTLET_DEBUG_FACE
      ? JSON.stringify(claims[0] ?? face).slice(0, 3000)
      : undefined,
  };
}

async function main() {
  const target = await startLocalTarget();
  const results = [];
  try {
    const problemId = await setUpProblem(target);
    emit({
      stage: "setup",
      status: "pass",
      problem_id: problemId,
      boundary: "local Workerd/D1/R2; fixture screening",
    });
    for (const [index, mode] of agents.entries()) {
      const minted = await mintEnrollment(target, ["promote", "review"], problemId);
      const secret = minted.join_url.slice(minted.join_url.indexOf("#") + 1);
      const observationsFrom = target.observations.length;
      const isHarness = mode.startsWith("harness:");
      let agentDone = false;
      const approval =
        mode === "abandon"
          ? Promise.resolve(false)
          : approvePending(
              target,
              minted.enrollment_id,
              isHarness ? 900_000 : 30_000,
              SPONSOR,
              () => agentDone,
            );
      const agentOutcome = isHarness
        ? await runHarnessAgent(mode.slice(8), minted.join_url).then((run) => ({
            stage: run.timedOut ? "timeout" : `exit-${run.exitCode}`,
            ok: run.exitCode === 0,
            tokens: run.tokens,
            duration_ms: run.durationMs,
            transcript_sha256: run.transcriptSha256,
            stderr_tail: run.exitCode === 0 ? undefined : run.stderrTail,
          }))
        : await runReferenceAgent(minted.join_url, {
            mode,
            name: `reference-${mode}-${index}`.slice(0, 32),
            bound: 2000 + index * 97,
          }).catch((error) => ({
            stage: "agent-error",
            ok: false,
            error: String(error).slice(0, 200),
          }));
      agentDone = true;
      await approval;
      const { facts, faceClaimKeys, faceSample } = await gatherFacts(target, {
        enrollmentId: minted.enrollment_id,
        problemId,
        observationsFrom,
        secret,
      });
      const verdict = gauntletVerdict(facts);
      // Real harnesses have no expected outcome: their result is the measurement.
      const expectedPass = isHarness ? null : mode === "complete";
      const record = {
        attempt: index,
        agent: isHarness ? mode : `reference:${mode}`,
        ...(isHarness
          ? {
              tokens: agentOutcome.tokens,
              duration_ms: agentOutcome.duration_ms,
              transcript_sha256: agentOutcome.transcript_sha256,
              stderr_tail: agentOutcome.stderr_tail,
            }
          : {}),
        completed: verdict.completed,
        expected: expectedPass === null ? "measured" : expectedPass ? "pass" : "fail",
        as_expected: expectedPass === null ? null : verdict.completed === expectedPass,
        stage_reached: verdict.stageReached,
        missing: verdict.missing,
        failures: verdict.failures,
        agent_reported_stage: agentOutcome.stage,
        requests: facts.observations.length,
        // Where the agent's requests went (route shape and status class only).
        request_histogram: Object.entries(
          facts.observations.reduce((counts, o) => {
            const key = `${o.method} ${o.path
              .replace(/\/(S|W|P|F|C)-[A-Z0-9@-]+/g, "/$1-…")
              .replace(/ASIMP-EN-[A-Z0-9]+/, "ASIMP-EN-…")} ${Math.floor(o.status / 100)}xx`;
            counts[key] = (counts[key] ?? 0) + 1;
            return counts;
          }, {}),
        ).sort((a, b) => b[1] - a[1]),
        // Server-side refusals seen by the proxy: route shape, status and code only.
        refusals: facts.observations
          .filter((o) => o.status >= 400)
          .map((o) => ({
            method: o.method,
            route: o.path
              .replace(/\/(S|W|P|F|C)-[A-Z0-9-]+/g, "/$1-…")
              .replace(/ASIMP-EN-[A-Z0-9]+/, "ASIMP-EN-…"),
            status: o.status,
            code: o.code,
            injected: o.injected === true,
          })),
        face_claim_keys: faceClaimKeys,
        ...(faceSample ? { face_sample: faceSample } : {}),
      };
      results.push(record);
      emit(record);
    }
  } finally {
    await target.close();
  }
  // Reference attempts must match expectations; harness attempts are measurements.
  const ok =
    results.length > 0 &&
    results.every((record) => record.as_expected === null || record.as_expected === true);
  emit({
    kind: "gauntlet-local-summary",
    status: ok ? "pass" : "fail",
    attempts: results.length,
    completed: results.filter((record) => record.completed).length,
    no_claim:
      "Local target with fixture screening. Not hosted screening, OAuth, deployment, or the staging G-C bar (10 fresh sessions, >= 3 harnesses, >= 8 completions, median <= 25K tokens).",
  });
  process.exit(ok ? 0 : 1);
}

await main();
