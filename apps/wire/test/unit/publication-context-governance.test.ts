import { test } from "bun:test";
import assert from "node:assert/strict";
import { ProblemDocumentSchema, ScreeningPublicationProvenanceSchema } from "@asimposium/contracts";
import type { Env } from "../../src/env";
import { decideScreeningCase, sponsorCaseActorId } from "../../src/moderation/store";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger";
import { readProblemPublicationPreview } from "../../src/problems/publication-preview";
import { screenPublicCandidate } from "../../src/screening/public-candidate";
import type { WorkersAIPromotionInput } from "../../src/screening/workers-ai";
import {
  FELLOW,
  PROBLEM,
  publicationContextFixture,
  SPONSOR,
} from "../support/publication-context";
import { syntheticScreeningObservation } from "../support/screening";
import {
  reviewedStatementRevisionFixture,
  statementRevisionSourceFixture,
} from "../support/statement-proposal.ts";

type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
type Problem = Parameters<typeof applyPublicProblemGovernance>[1];
const count = (f: Fixture, table: string) =>
  (f.sql.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const snapshot = (f: Fixture, id = PROBLEM) =>
  f.sql.query("SELECT * FROM problems WHERE id = ?").get(id) as Problem;
const revise = {
  statement: "Exact replacement public statement.",
  falsifier: "Exact replacement falsifier.",
  motivation: "Explain the narrower replacement.",
} as const;
async function reviewedRevision(f: Fixture, key: string) {
  const command = await reviewedStatementRevisionFixture(f.db, SPONSOR, PROBLEM, revise, key);
  const source = await statementRevisionSourceFixture(f.db, SPONSOR, PROBLEM);
  return { command, sourceFellowId: source.binding.fellowId };
}
function request(key: string) {
  return new Request("https://a.asimposium.org/v1/sponsors/problems/context/lifecycle", {
    method: "POST",
    headers: { "idempotency-key": key },
  });
}
async function using(run: (f: Fixture) => Promise<void>) {
  const f = await publicationContextFixture();
  try {
    f.sql.query("UPDATE problems SET created_by_fellow_id = ? WHERE id = ?").run(FELLOW, PROBLEM);
    await run(f);
  } finally {
    f.sql.close();
  }
}
function screening(
  f: Fixture,
  candidate: WorkersAIPromotionInput,
  state: { calls: number },
  during?: () => Promise<void>,
) {
  return {
    sponsorLimit: 100,
    screen: () =>
      screenPublicCandidate(
        async (input) => {
          const active = f.sql
            .query(
              "SELECT COUNT(*) AS n FROM public_write_attempt_reservations WHERE status='reserved'",
            )
            .get() as { n: number };
          assert.equal(active.n, 1, "paid evaluation happens only after quota reservation");
          state.calls++;
          const observation = await syntheticScreeningObservation(input, {
            decision: "pass",
            coarse_category: "benign-context",
            provider_status: "ok",
          });
          await during?.();
          return observation;
        },
        { DB: f.db } as Env,
        candidate,
        {
          sponsorId: SPONSOR,
          route:
            candidate.kind === "problem-proposal" ? "problem-publish" : "problem-revise-statement",
        },
      ),
  };
}

test("governance publication retains a contextual sponsor receipt and exact replay buys no screen or quota", () =>
  using(async (f) => {
    f.sql.query("UPDATE problems SET status='private-draft' WHERE id = ?").run(PROBLEM);
    const calls = { calls: 0 };
    const candidate = {
      ...f.input("Context problem\n\nExact public problem statement.\n\nExact public motivation."),
      kind: "problem-proposal",
      falsifier: "Exact public falsifier.",
    };
    const preview = await readProblemPublicationPreview(f.db, PROBLEM, SPONSOR);
    assert.ok(preview);
    const publish = {
      action: "publish",
      reviewed_statement_version: preview.problem.current_statement_version,
      reviewed_digest: preview.review_digest,
    } as const;
    const first = await applyPublicProblemGovernance(
      f.db,
      snapshot(f),
      SPONSOR,
      publish,
      request("publish-context"),
      screening(f, candidate, calls),
    );
    assert.equal(first.status, 200, await first.clone().text());
    const firstBody = await first.json();
    const event = f.sql.query("SELECT actor_fellow_id, actor_sponsor_id FROM events").get() as {
      actor_fellow_id: string | null;
      actor_sponsor_id: string;
    };
    assert.equal(
      event.actor_fellow_id,
      null,
      "sponsor governance does not borrow Fellow authorship",
    );
    assert.equal(event.actor_sponsor_id, SPONSOR);
    const row = f.sql.query("SELECT provenance_json FROM screening_publications").get() as {
      provenance_json: string;
    };
    const receipt = ScreeningPublicationProvenanceSchema.parse(JSON.parse(row.provenance_json));
    assert.equal(receipt.version, "ledger-publication-screening.v2");
    assert.equal(
      receipt.version === "ledger-publication-screening.v2" && receipt.context.mode,
      "initial-publication",
    );
    const replay = await applyPublicProblemGovernance(
      f.db,
      snapshot(f),
      SPONSOR,
      publish,
      request("publish-context"),
      {
        sponsorLimit: 0,
        async screen() {
          throw new Error("replay cannot evaluate again");
        },
      },
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), firstBody);
    assert.equal(calls.calls, 1);
    assert.equal(count(f, "events"), 1);
    assert.equal(count(f, "public_write_attempt_reservations"), 1);
    assert.equal(
      (
        f.sql.query("SELECT status FROM public_write_attempt_reservations").get() as {
          status: string;
        }
      ).status,
      "settled_published",
    );
  }));

test("a public statement revision screens its prior statement and commits the exact version transition", () =>
  using(async (f) => {
    const { command, sourceFellowId } = await reviewedRevision(f, "revision-proposal");
    const calls = { calls: 0 };
    const candidate = {
      ...f.input(`${snapshot(f).title}\n\n${revise.statement}\n\n${revise.motivation}`),
      fellowId: sourceFellowId,
      kind: "problem-statement-revision",
      falsifier: revise.falsifier,
    };
    const response = await applyPublicProblemGovernance(
      f.db,
      snapshot(f),
      SPONSOR,
      command,
      request("revision-context"),
      screening(f, candidate, calls),
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(snapshot(f).current_statement_version, 2);
    const row = f.sql.query("SELECT provenance_json FROM screening_publications").get() as {
      provenance_json: string;
    };
    const receipt = ScreeningPublicationProvenanceSchema.parse(JSON.parse(row.provenance_json));
    assert.equal(receipt.version, "ledger-publication-screening.v2");
    assert.equal(
      receipt.version === "ledger-publication-screening.v2" && receipt.context.statement_version,
      1,
    );
    assert.equal(calls.calls, 1);
  }));

test("operator rejection during sponsor revision cannot publish the declined statement", () =>
  using(async (f) => {
    const { command, sourceFellowId } = await reviewedRevision(f, "rejected-proposal");
    const candidate = {
      ...f.input(`${snapshot(f).title}\n\n${revise.statement}\n\n${revise.motivation}`),
      fellowId: sourceFellowId,
      kind: "problem-statement-revision",
      falsifier: revise.falsifier,
    };
    const held = await screenPublicCandidate(
      (input) =>
        syntheticScreeningObservation(input, {
          decision: "quarantine",
          coarse_category: "injection",
          provider_status: "ok",
        }),
      { DB: f.db } as Env,
      candidate,
      { sponsorId: SPONSOR, route: "problem-revise-statement" },
    );
    assert.ok(held instanceof Response);
    const { case_id: caseId } = (await held.json()) as { case_id: string };
    const calls = { calls: 0 };
    const before = f.state();
    const response = await applyPublicProblemGovernance(
      f.db,
      snapshot(f),
      SPONSOR,
      command,
      request("rejected-revision"),
      screening(f, candidate, calls, async () => {
        assert.equal(
          (
            await decideScreeningCase(f.db, "operator", {
              caseId,
              decision: "confirm_rejection",
              reason: "The exact synthetic statement must remain outside the public ledger.",
            })
          ).ok,
          true,
        );
      }),
    );
    assert.equal(response.status, 202, await response.clone().text());
    assert.deepEqual(await response.json(), {
      code: "SCREENING_HOLD",
      coarse_category: "provider-unavailable",
      appeal: "SPONSOR_APPEAL_AVAILABLE",
    });
    assert.deepEqual(f.state(), before);
    assert.equal(snapshot(f).current_statement_version, 1);
    assert.equal(count(f, "problem_statement_versions"), 1);
    assert.deepEqual(
      f.sql.query("SELECT state FROM screening_cases WHERE case_id = ?").get(caseId),
      { state: "rejected" },
    );
    const retry = await applyPublicProblemGovernance(
      f.db,
      snapshot(f),
      SPONSOR,
      command,
      request("rejected-revision"),
      screening(f, candidate, calls),
    );
    assert.equal(retry.status, 403);
    assert.equal(calls.calls, 1);
  }));

test("same-Fellow publication during sponsor revision refuses stale context and rolls back governance and quota", () =>
  using(async (f) => {
    const { command, sourceFellowId } = await reviewedRevision(f, "racing-proposal");
    await f.write({ ...f.input("First public source."), fellowId: sourceFellowId });
    const calls = { calls: 0 };
    const candidate = {
      ...f.input(revise.statement),
      fellowId: sourceFellowId,
      kind: "problem-statement-revision",
      falsifier: revise.falsifier,
    };
    const response = await applyPublicProblemGovernance(
      f.db,
      snapshot(f),
      SPONSOR,
      command,
      request("racing-revision"),
      screening(f, candidate, calls, async () => {
        await f.write({ ...f.input("Overlapping same-Fellow source."), fellowId: sourceFellowId });
      }),
    );
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal(
      ProblemDocumentSchema.parse(await response.json()).code,
      "SCREENING_CONTEXT_STALE",
    );
    assert.equal(snapshot(f).current_statement_version, 1);
    assert.equal(count(f, "events"), 2, "only the prior and racing scientific events remain");
    assert.equal(count(f, "screening_publications"), 0);
    assert.equal(count(f, "problem_statement_versions"), 1);
    assert.equal(
      (
        f.sql.query("SELECT status FROM public_write_attempt_reservations").get() as {
          status: string;
        }
      ).status,
      "settled_failed",
    );
  }));

test("complete-context failure settles governance quota before any paid classifier call", () =>
  using(async (f) => {
    const { command, sourceFellowId } = await reviewedRevision(f, "unavailable-proposal");
    const overhead = JSON.stringify({ body_md: "", falsifier: "Exact falsifier." }).length;
    const source = "S".repeat(512 * 1024 - overhead);
    await f.write({ ...f.input(source), fellowId: sourceFellowId });
    await f.write({ ...f.input(source), fellowId: sourceFellowId });
    const calls = { calls: 0 };
    const candidate = {
      ...f.input(revise.statement),
      fellowId: sourceFellowId,
      kind: "problem-statement-revision",
      falsifier: revise.falsifier,
    };
    const response = await applyPublicProblemGovernance(
      f.db,
      snapshot(f),
      SPONSOR,
      command,
      request("unavailable-revision"),
      screening(f, candidate, calls),
    );
    assert.equal(response.status, 503);
    assert.equal(
      ProblemDocumentSchema.parse(await response.json()).code,
      "SCREENING_CONTEXT_UNAVAILABLE",
    );
    assert.equal(calls.calls, 0);
    assert.equal(count(f, "events"), 2);
    assert.equal(count(f, "screening_publications"), 0);
    assert.equal(
      (
        f.sql.query("SELECT status FROM public_write_attempt_reservations").get() as {
          status: string;
        }
      ).status,
      "settled_failed",
    );
  }));

test("sponsor-only problem lifecycle hold (null created_by_fellow_id) uses sponsor_screening_cases without Fellow FK failure and commits on release (Wave 19)", () =>
  using(async (f) => {
    // First publish the draft via the real governance path so an immutable problem.admitted
    // formulation event exists, then clear created_by_fellow_id to model a sponsor-only problem.
    f.sql.query("UPDATE problems SET status='private-draft' WHERE id = ?").run(PROBLEM);
    const preview = await readProblemPublicationPreview(f.db, PROBLEM, SPONSOR);
    assert.ok(preview);
    const published = await applyPublicProblemGovernance(
      f.db,
      snapshot(f),
      SPONSOR,
      {
        action: "publish",
        reviewed_statement_version: preview.problem.current_statement_version,
        reviewed_digest: preview.review_digest,
      },
      request("sponsor-only-publish"),
      screening(
        f,
        {
          ...f.input(
            "Context problem\n\nExact public problem statement.\n\nExact public motivation.",
          ),
          kind: "problem-proposal",
          falsifier: "Exact public falsifier.",
        },
        { calls: 0 },
      ),
    );
    assert.equal(published.status, 200, await published.clone().text());
    f.sql.query("UPDATE problems SET created_by_fellow_id = NULL WHERE id = ?").run(PROBLEM);

    const retireAction = {
      action: "retire",
      reason: "Retiring legacy problem without a Fellow creator after sponsor review.",
    } as const;
    const candidate: WorkersAIPromotionInput = {
      problemId: PROBLEM,
      fellowId: sponsorCaseActorId(SPONSOR),
      kind: "problem-lifecycle",
      statement: JSON.stringify(retireAction),
      falsifier: null,
    };

    const held = await screenPublicCandidate(
      (input) =>
        syntheticScreeningObservation(input, {
          decision: "quarantine",
          coarse_category: "dual-use-boundary",
          provider_status: "ok",
        }),
      { DB: f.db } as Env,
      candidate,
      { sponsorId: SPONSOR, route: "problem-retire", authorKind: "sponsor" },
    );
    assert.ok(held instanceof Response);
    assert.equal(held.status, 202);
    const { case_id: caseId } = (await held.json()) as { case_id: string };
    assert.match(caseId, /^QC-/);
    assert.equal(count(f, "sponsor_screening_cases"), 1);
    assert.equal(count(f, "screening_cases"), 0);

    const decision = await decideScreeningCase(f.db, "operator_wave19", {
      caseId,
      decision: "release",
      reason: "Confirmed benign sponsor retirement notice.",
    });
    assert.equal(decision.ok, true);

    let aiCallsAfterRelease = 0;
    const response = await applyPublicProblemGovernance(
      f.db,
      snapshot(f),
      SPONSOR,
      retireAction,
      request("sponsor-only-retire"),
      {
        sponsorLimit: 100,
        screen: () =>
          screenPublicCandidate(
            async (input) => {
              aiCallsAfterRelease++;
              return syntheticScreeningObservation(input, {
                decision: "pass",
                coarse_category: "benign-context",
                provider_status: "ok",
              });
            },
            { DB: f.db } as Env,
            candidate,
            { sponsorId: SPONSOR, route: "problem-retire", authorKind: "sponsor" },
          ),
      },
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(
      aiCallsAfterRelease,
      0,
      "released sponsor governance case commits with 0 AI calls",
    );
    assert.equal(snapshot(f).status, "retired");
    assert.equal(count(f, "screening_publications"), 2);

    // Wave 20: even if a caller passes fellowId = sponsorCaseActorId(SPONSOR) WITHOUT
    // authorKind: "sponsor", screenPublicCandidate must never touch fellow_screening_refusals
    // (impossible Fellow FK) and must record direct rejections in sponsor_screening_cases.
    const directReject = await screenPublicCandidate(
      (input) =>
        syntheticScreeningObservation(input, {
          decision: "reject",
          coarse_category: "harassment",
          provider_status: "ok",
        }),
      { DB: f.db } as Env,
      {
        problemId: PROBLEM,
        fellowId: sponsorCaseActorId(SPONSOR),
        kind: "problem-lifecycle",
        statement: JSON.stringify({
          action: "retire",
          reason: "Sponsor actor without explicit authorKind flag",
        }),
        falsifier: null,
      },
      { sponsorId: SPONSOR, route: "problem-retire" },
    );
    assert.ok(directReject instanceof Response);
    assert.equal(directReject.status, 403);
    const { case_id: rejectedCaseId } = (await directReject.json()) as { case_id: string };
    assert.match(rejectedCaseId, /^QC-/);
    assert.equal(count(f, "sponsor_screening_cases"), 2);
    // The fixture omits fellow_screening_refusals entirely, so reaching HTTP 403
    // with a persisted sponsor_screening_cases receipt proves neither posture lookup
    // nor refusal recording touched the Fellow-FK table.
    assert.equal(
      f.sql
        .query(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fellow_screening_refusals'",
        )
        .get(),
      null,
    );
  }));
