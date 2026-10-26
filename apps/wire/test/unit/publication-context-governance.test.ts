import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  ProblemDocumentSchema,
  type ProblemLifecycleActionRequest,
  ScreeningPublicationProvenanceSchema,
} from "@asimposium/contracts";
import type { Env } from "../../src/env";
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

type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
type Problem = Parameters<typeof applyPublicProblemGovernance>[1];
const count = (f: Fixture, table: string) =>
  (f.sql.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const snapshot = (f: Fixture, id = PROBLEM) =>
  f.sql.query("SELECT * FROM problems WHERE id = ?").get(id) as Problem;
const revise = {
  action: "revise-statement",
  statement: "Exact replacement public statement.",
  falsifier: "Exact replacement falsifier.",
  motivation: "Explain the narrower replacement.",
} as const satisfies ProblemLifecycleActionRequest;
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
    const calls = { calls: 0 };
    const candidate = {
      ...f.input(`${snapshot(f).title}\n\n${revise.statement}\n\n${revise.motivation}`),
      kind: "problem-statement-revision",
      falsifier: revise.falsifier,
    };
    const response = await applyPublicProblemGovernance(
      f.db,
      snapshot(f),
      SPONSOR,
      revise,
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

test("same-Fellow publication during sponsor revision refuses stale context and rolls back governance and quota", () =>
  using(async (f) => {
    await f.write(f.input("First public source."));
    const calls = { calls: 0 };
    const candidate = {
      ...f.input(revise.statement),
      kind: "problem-statement-revision",
      falsifier: revise.falsifier,
    };
    const response = await applyPublicProblemGovernance(
      f.db,
      snapshot(f),
      SPONSOR,
      revise,
      request("racing-revision"),
      screening(f, candidate, calls, async () => {
        await f.write(f.input("Overlapping same-Fellow source."));
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
    const overhead = JSON.stringify({ body_md: "", falsifier: "Exact falsifier." }).length;
    const source = "S".repeat(512 * 1024 - overhead);
    await f.write(f.input(source));
    await f.write(f.input(source));
    const calls = { calls: 0 };
    const candidate = {
      ...f.input(revise.statement),
      kind: "problem-statement-revision",
      falsifier: revise.falsifier,
    };
    const response = await applyPublicProblemGovernance(
      f.db,
      snapshot(f),
      SPONSOR,
      revise,
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
