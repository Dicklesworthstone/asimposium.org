import assert from "node:assert/strict";
import {
  FullPackPageSchema,
  PackResponseSchema,
  ProblemDormancyEventSchema,
} from "@asimposium/contracts";
import { EventTailResponseSchema } from "@asimposium/contracts/event-tail";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";
import { assertProjectionsRebuild } from "./projection-rebuild-check.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");
const quietMs = 45 * 86_400_000;

await runLocalWorkerJourney(
  async ({ call, enroll, fixtures, env, worker, origin, userAgent }) => {
    const author = await enroll("dormancy-author", "usr_dormancy_author");
    const reviewer = await enroll("dormancy-reviewer", "usr_dormancy_reviewer");
    const now = Date.now() - 1000;
    const boundary = new Date(now - quietMs).toISOString();
    const id = "P-DORMANCY-BOUNDARY";
    const seeded = await fixtures.seedDormancyProblem(id, author, reviewer, boundary);
    const head = async (problem = id) =>
      env.DB.prepare(
        "SELECT status,public_seq,chain_digest,last_material_at,last_material_event_id FROM problems WHERE id=?",
      )
        .bind(problem)
        .first();
    const count = async (type, problem = id) =>
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id=? AND type=?")
          .bind(problem, type)
          .first()
      ).n;
    const snapshot = async (problem = id) => ({
      head: await head(problem),
      cursor: await call("/cursor"),
      events: (
        await env.DB.prepare("SELECT id,seq,type FROM events WHERE problem_id=? ORDER BY seq")
          .bind(problem)
          .all()
      ).results,
    });
    assert.equal(
      (await head()).last_material_at,
      boundary,
      "the activation event sets the material clock",
    );
    assert.equal((await head()).last_material_event_id, seeded.reviewId);
    assert.equal(
      (await fixtures.runDormancyTick(now - 1)).dormant,
      0,
      "one millisecond before45days stays active",
    );
    const before = await snapshot();
    const sweep = await fixtures.runDormancyTick(now);
    assert.equal(sweep.dormant, 1);
    assert.equal(sweep.failed, 0);
    const after = await snapshot();
    assert.equal(after.head.status, "dormant");
    assert.equal(after.head.public_seq, before.head.public_seq + 1);
    assert.equal(after.cursor, before.cursor + 1);
    assert.equal(await count("problem.dormant"), 1);
    const record = await env.DB.prepare(
      "SELECT e.*,c.payload_json FROM events e JOIN event_content c ON c.event_id=e.id WHERE e.problem_id=? AND e.type='problem.dormant'",
    )
      .bind(id)
      .first();
    const payload = ProblemDormancyEventSchema.parse(JSON.parse(record.payload_json));
    assert.equal(payload.observed_through, before.head.public_seq);
    assert.equal(payload.last_material_event_id, seeded.reviewId);
    assert.equal(record.actor_fellow_id, null);
    assert.equal(record.actor_sponsor_id, null);
    assert.equal((await fixtures.runDormancyTick(now)).examined, 0);
    assert.deepEqual(
      await snapshot(),
      after,
      "repeated sweeps create no second event or cursor increment",
    );
    await assertProjectionsRebuild(env.DB, id);

    // A real session, workshop write and hypothesis lifecycle are coordination,
    // and cannot manufacture renewed object-level activity.
    const session = (await call("/v1/sessions", { problem_id: id, intent: "explore" }, author, 201))
      .session_id;
    const path = `/v1/sessions/${session}`;
    await call(
      `${path}/workshop`,
      {
        type: "note",
        title: "Private path notes",
        body_md: "Inspect finite path boundaries before proposing a test.",
        relates_to: [],
        force_note: true,
      },
      author,
      201,
    );
    const hypothesis = (
      await call(
        `${path}/hypotheses`,
        {
          route: "Finite path enumeration",
          mechanism: "Enumerate edge counts and compare distinct vertices.",
          falsifier: "A finite path with a non-unit vertex/edge difference.",
          discriminating_predictions: [
            "Each finite path has vertex count minus edge count equal to one.",
          ],
          origin: "proposed",
          body_md: "A bounded enumeration route.",
        },
        author,
        201,
      )
    ).hypothesis_id;
    const face = (await call(`/p/${id}/hypotheses/${hypothesis}.json`)).hypotheses[0];
    await call(
      `${path}/hypotheses/${hypothesis}/lifecycle`,
      {
        action: "defer",
        expected_last_event_id: face.last_event.event_id,
        reason: "Await a finite boundary observation.",
      },
      author,
    );
    assert.equal((await head()).status, "dormant");
    assert.equal((await head()).last_material_at, boundary);
    await call(
      `${path}/evidence`,
      {
        bears_on_kind: "hypothesis",
        bears_on_id: hypothesis,
        direction: "informs",
        kind: "argument",
        source: { kind: "model_memory" },
        mode: "exploratory",
        body_md:
          "For a path with two adjacent edges, the three enumerated vertices give difference one.",
      },
      author,
      201,
    );
    assert.equal(
      (await head()).status,
      "active",
      "accepted evidence wakes the problem in its own transaction",
    );
    assert.notEqual((await head()).last_material_at, boundary);
    assert.equal(
      await count("problem.dormant"),
      1,
      "reactivation adds no second coordination event",
    );
    await assertProjectionsRebuild(env.DB, id);

    const tail = EventTailResponseSchema.parse(
      await call(`/p/${id}/events.json?since=0&limit=200`),
    );
    assert.ok(
      tail.events.some((item) => item.event?.type === "problem.dormant"),
      "public tail includes the platform transition",
    );
    const pack = PackResponseSchema.parse(
      await call(
        `${path}/pack?profile=full&max_tokens=8000&through=${tail.page_end.through}&after=0`,
        undefined,
        author,
      ),
    );
    const page = FullPackPageSchema.parse(
      JSON.parse(pack.items.find((item) => item.kind === "full-page").body),
    );
    assert.ok(page.records > 0);
    const dormantRecord = pack.items
      .filter((item) => item.kind === "full-event")
      .map((item) => JSON.parse(item.body))
      .find((item) => item.publication?.type === "problem.dormant");
    assert.ok(
      dormantRecord && dormantRecord.content_omitted === null,
      "typed full pack includes dormancy",
    );
    ProblemDormancyEventSchema.parse(dormantRecord.content);
    for (const format of ["md", "json"]) {
      const response = await worker.fetch(`${origin}/p/${id}.${format}`, {
        headers: { "User-Agent": userAgent },
      });
      assert.equal(response.status, 200);
    }

    // The genuine production cron, not only a direct helper call, transitions
    // another old public problem. All other consumers must still succeed.
    const cronProblem = "P-DORMANCY-CRON";
    await fixtures.seedDormancyProblem(
      cronProblem,
      author,
      reviewer,
      new Date(now - quietMs - 86_400_000).toISOString(),
    );
    const cron = await worker.scheduled({ cron: "*/5 * * * *" });
    assert.equal(cron.outcome, "ok");
    assert.equal((await head(cronProblem)).status, "dormant");
    await assertProjectionsRebuild(env.DB, cronProblem);

    // A real scientific write after scheduler selection invalidates that exact
    // observed head; the delayed sweep must not hide the newly active problem.
    const raceProblem = "P-DORMANCY-RACE";
    await fixtures.seedDormancyProblem(raceProblem, author, reviewer, boundary);
    const raceSession = (
      await call("/v1/sessions", { problem_id: raceProblem, intent: "explore" }, author, 201)
    ).session_id;
    const racePath = `/v1/sessions/${raceSession}`;
    const route = (
      await call(
        `${racePath}/hypotheses`,
        {
          route: "Race route",
          mechanism: "Check finite path boundaries.",
          falsifier: "A path with an inconsistent count.",
          discriminating_predictions: ["The boundary count is one."],
          origin: "proposed",
          body_md: "Finite boundary route.",
        },
        author,
        201,
      )
    ).hypothesis_id;
    const race = await fixtures.dormancyVersusEvidence(Date.now(), `${racePath}/evidence`, author, {
      bears_on_kind: "hypothesis",
      bears_on_id: route,
      direction: "informs",
      kind: "argument",
      source: { kind: "model_memory" },
      mode: "exploratory",
      body_md: "A fresh finite observation confirms three vertices for two edges.",
    });
    assert.equal(
      race.writeStatus,
      201,
      "the real authenticated evidence route committed during the pause",
    );
    const raceResult = race.result;
    assert.equal(raceResult.raced, 1, JSON.stringify(raceResult));
    assert.equal((await head(raceProblem)).status, "active");
    assert.equal(await count("problem.dormant", raceProblem), 0);
    await assertProjectionsRebuild(env.DB, raceProblem);

    const faultProblem = "P-DORMANCY-FAULT";
    await fixtures.seedDormancyProblem(faultProblem, author, reviewer, boundary);
    const faultBefore = await snapshot(faultProblem);
    await env.DB.prepare(`CREATE TRIGGER dormancy_late_fault BEFORE UPDATE OF status ON problems
    WHEN NEW.id='P-DORMANCY-FAULT' AND NEW.status='dormant'
    BEGIN SELECT RAISE(ABORT,'DORMANCY_LATE_FAULT'); END`).run();
    assert.equal((await fixtures.runDormancyTick(Date.now())).failed, 1);
    assert.deepEqual(await snapshot(faultProblem), faultBefore);
    await env.DB.prepare("DROP TRIGGER dormancy_late_fault").run();
    assert.equal((await fixtures.runDormancyTick(Date.now())).dormant, 1);
    await assertProjectionsRebuild(env.DB, faultProblem);
    console.log(
      JSON.stringify({
        kind: "problem-dormancy-real-bindings",
        status: "pass",
        features: [
          "45-day boundary",
          "material clock",
          "platform event",
          "atomic reactivation",
          "process exclusion",
          "cron",
          "race refusal",
          "rollback",
          "typed public history",
          "projection parity",
        ],
        boundary:
          "Local Workerd/D1/R2; historical bootstrap through production Krater; synthetic screening, no deployment claim.",
      }),
    );
  },
  { lane: "problem-dormancy" },
);
