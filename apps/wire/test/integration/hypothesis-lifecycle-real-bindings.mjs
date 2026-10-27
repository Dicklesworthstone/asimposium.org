import assert from "node:assert/strict";
import {
  FullPackPageSchema,
  HypothesisLifecycleResponseSchema,
  HypothesisResponseSchema,
  PackResponseSchema,
} from "@asimposium/contracts";
import { EventTailResponseSchema } from "@asimposium/contracts/event-tail";
import { HypothesesResponseSchema } from "@asimposium/contracts/hypotheses";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";
import { assertProjectionsRebuild } from "./projection-rebuild-check.mjs";

// Genuine local Workerd/D1/R2. All scientific states below are produced by
// mounted write routes. Screening uses the shared synthetic provider seam;
// this is not a staging or live Workers AI proof.
assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, fixtures, env, worker, origin, userAgent }) => {
  const sponsor = "usr_hypothesis_lifecycle_author";
  const author = await enroll("hypothesis-lifecycle-author", sponsor);
  const peer = await enroll("hypothesis-lifecycle-peer", "usr_hypothesis_lifecycle_peer");
  const problem = (await call("/v1/problems", {
    title: "Hypothesis route coordination",
    statement: "Every integer from zero through ninety has a square of the same parity.",
    falsifier: "An integer in this range whose square has the opposite parity.",
    motivation: "Coordinate distinct falsifiable routes while preserving their original scientific statements.",
    areas: ["number-theory"],
  }, author, 201)).problem.id;
  await sponsorCall(sponsor, "POST", `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle", { action: "publish" });
  const peerSession = (await call("/v1/sessions", { problem_id: problem, intent: "review" }, peer, 201)).session_id;
  await call(`/v1/problems/${problem}/statement-review`, {
    session_id: peerSession, statement_version: 1, verdict: "statement-clear",
    basis: "The finite domain, observable and counterexample criterion are explicit.",
  }, peer);
  const session = (await call("/v1/sessions", { problem_id: problem, intent: "explore" }, author, 201)).session_id;
  const authorPath = `/v1/sessions/${session}`;
  const peerPath = `/v1/sessions/${peerSession}`;
  const create = async (label, path = authorPath, token = author) => HypothesisResponseSchema.parse(
    await call(`${path}/hypotheses`, {
      route: `Finite parity route ${label}`,
      mechanism: `Enumerate residue classes using the ${label} decomposition.`,
      falsifier: `A residue class contradicts the ${label} parity prediction.`,
      discriminating_predictions: [`The ${label} observable remains zero on every boundary input.`],
      origin: "proposed", body_md: `A falsifiable route using ${label}.`,
    }, token, 201),
  ).hypothesis_id;
  const face = async (id, through) => HypothesesResponseSchema.parse(await call(
    `/p/${problem}/hypotheses/${id}.json${through === undefined ? "" : `?through=${through}`}`));
  const read = async (id) => (await face(id)).hypotheses[0];
  const change = (id, body, key, expected = 200, path = authorPath, token = author) =>
    call(`${path}/hypotheses/${id}/lifecycle`, body, token, expected, key);
  const evidence = (id, path = authorPath, token = author) => call(`${path}/evidence`, {
    bears_on_kind: "hypothesis", bears_on_id: id, direction: "refutes", kind: "argument",
    source: { kind: "model_memory" }, mode: "exploratory",
    body_md: "At the explicit boundary input this route's predicted parity disagrees with the computed parity.",
  }, token, 201);
  const next = async () => {
    const result = await call(`/v1/p/${problem}/next`, undefined, author);
    return [result.primary_move, ...result.alternatives];
  };
  const count = async (sql, ...values) => (await env.DB.prepare(sql).bind(...values).first()).n;
  const state = async (id) => ({
    head: await env.DB.prepare("SELECT public_seq, chain_digest FROM problems WHERE id=?").bind(problem).first(),
    route: await env.DB.prepare("SELECT * FROM hypotheses WHERE problem_id=? AND hypothesis_id=?").bind(problem, id).first(),
    events: await count("SELECT COUNT(*) AS n FROM events WHERE problem_id=?", problem),
    outbox: await count("SELECT COUNT(*) AS n FROM outbox WHERE problem_id=?", problem),
    publications: await count("SELECT COUNT(*) AS n FROM screening_publications p JOIN events e ON e.id=p.event_id WHERE e.problem_id=?", problem),
    receipts: await count("SELECT COUNT(*) AS n FROM session_write_replays WHERE scope='hypothesis-lifecycle'"),
  });

  const first = await create("original");
  const second = await create("competing");
  const initial = await face(first);
  const original = initial.hypotheses[0];
  assert.ok((await next()).some(move => move.move === "third-alternative" && move.refs.includes(first)),
    "two active routes offer a concrete third-alternative move");
  const unauthorized = await change(first, {
    action: "defer", expected_last_event_id: original.last_event.event_id, reason: "A peer may not coordinate another author's route.",
  }, "lifecycle-foreign-author", 403, peerPath, peer);
  assert.equal(unauthorized.code, "WRITE_REFUSED");

  const deferBody = { action: "defer", expected_last_event_id: original.last_event.event_id,
    reason: "Await the finite boundary computation before spending more work on this route." };
  const deferred = HypothesisLifecycleResponseSchema.parse(await change(first, deferBody, "lifecycle-defer"));
  assert.equal(deferred.status, "deferred");
  assert.deepEqual(await change(first, deferBody, "lifecycle-defer"), deferred, "accepted replay preserves exact receipt");
  assert.equal((await read(first)).status, "deferred");
  assert.ok((await next()).every(move => !move.refs.includes(first)), "a deferred route leaves live recommendations");
  const stale = await change(first, { ...deferBody, reason: "This original head is obsolete." }, "lifecycle-stale", 409);
  assert.equal(stale.code, "OBJECT_VERSION_CONFLICT");
  const resumed = HypothesisLifecycleResponseSchema.parse(await change(first, {
    action: "resume", expected_last_event_id: deferred.event_id, reason: "The missing finite boundary computation is now available.",
  }, "lifecycle-resume"));
  assert.equal((await read(first)).status, "active");
  assert.ok((await next()).some(move => move.move === "third-alternative" && move.refs.includes(first)),
    "a verified resume returns the original immutable route to live recommendations");
  assert.deepEqual((await read(first)).content, original.content);
  assert.deepEqual(await face(first, initial.cursor), initial, "frozen reads retain the old active state");

  const successor = await create("narrower boundary");
  const narrowed = HypothesisLifecycleResponseSchema.parse(await change(first, {
    action: "narrow", expected_last_event_id: resumed.event_id,
    successor_hypothesis_id: successor, reason: "Concentrate future work on the separately published boundary restriction.",
  }, "lifecycle-narrow"));
  const narrowedFace = await read(first);
  assert.equal(narrowedFace.status, "narrowed");
  assert.equal(narrowedFace.lifecycle.successor_hypothesis_id, successor);
  assert.deepEqual(narrowedFace.content, original.content, "narrowing never rewrites the old route or falsifier");
  const replacedEvidence = await call(`${authorPath}/evidence`, {
    bears_on_kind: "hypothesis", bears_on_id: first, direction: "supports", kind: "argument",
    source: { kind: "model_memory" }, mode: "exploratory", body_md: "Attempt to build on the replaced route.",
  }, author, 409);
  assert.equal(replacedEvidence.code, "STALE_ROUTE");
  const forbiddenResume = await change(first, { action: "resume", expected_last_event_id: narrowed.event_id,
    reason: "Attempt to reactivate a terminal replaced route." }, "lifecycle-terminal", 409);
  assert.equal(forbiddenResume.code, "OBJECT_VERSION_CONFLICT");
  const secondHead = await read(second);
  await change(second, { action: "supersede", expected_last_event_id: secondHead.last_event.event_id,
    successor_hypothesis_id: successor, reason: "The new published route replaces this broad attempt." }, "lifecycle-supersede");
  assert.equal((await read(second)).status, "superseded");
  assert.ok((await next()).every(move => !move.refs.includes(first) && !move.refs.includes(second)));
  for (const format of ["md", "html"]) {
    const rendered = await worker.fetch(`${origin}/p/${problem}/hypotheses/${first}.${format}`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(rendered.status, 200);
    const body = await rendered.text();
    assert.ok(body.includes("narrowed") && body.includes(successor), "human faces show the status and successor");
  }

  // Evidence still pins the original scientific target. A resumed route can
  // be eliminated by another Fellow's available refuting observation.
  const successorHead = await read(successor);
  const waiting = await change(successor, { action: "defer", expected_last_event_id: successorHead.last_event.event_id,
    reason: "Wait for the boundary observation." }, "successor-defer");
  await change(successor, { action: "resume", expected_last_event_id: waiting.event_id,
    reason: "The boundary observation is ready for inspection." }, "successor-resume");
  const refuter = await evidence(successor, peerPath, peer);
  await call(`${peerPath}/hypotheses/${successor}/kill`, { hypothesis_id: successor,
    killed_by_evidence_id: refuter.evidence_id, reason: "The observation fires this route's recorded falsifier." }, peer);
  assert.equal((await read(successor)).status, "killed");
  const pausedRoute = await create("temporarily paused");
  await change(pausedRoute, { action: "defer", expected_last_event_id: (await read(pausedRoute)).last_event.event_id,
    reason: "Await an independent counterexample check." }, "paused-defer");
  const pausedEvidence = await evidence(pausedRoute, peerPath, peer);
  await call(`${peerPath}/hypotheses/${pausedRoute}/kill`, { hypothesis_id: pausedRoute,
    killed_by_evidence_id: pausedEvidence.evidence_id, reason: "A checked counterexample closes the deferred route." }, peer);
  assert.equal((await read(pausedRoute)).status, "killed", "deferral does not block legitimate elimination");

  // A late transaction fault must roll back the event, source, projection,
  // replay and screening-publication rows; exact retry can then publish once.
  const faulty = await create("transaction rollback", peerPath, peer);
  const faultBody = { action: "defer", expected_last_event_id: (await read(faulty)).last_event.event_id,
    reason: "Wait for an independent boundary computation." };
  const beforeFault = await state(faulty);
  await env.DB.prepare(`CREATE TRIGGER lifecycle_late_fault BEFORE INSERT ON screening_publications
    WHEN EXISTS (SELECT 1 FROM events e WHERE e.id=NEW.event_id AND e.type='hypothesis.deferred')
    BEGIN SELECT RAISE(ABORT, 'LIFECYCLE_LATE_FAULT'); END`).run();
  await change(faulty, faultBody, "lifecycle-rollback", 500, peerPath, peer);
  await env.DB.prepare("DROP TRIGGER lifecycle_late_fault").run();
  assert.deepEqual(await state(faulty), beforeFault, "late fault leaves no partial scientific mutation");
  await change(faulty, faultBody, "lifecycle-rollback", 200, peerPath, peer);
  assert.equal((await read(faulty)).status, "deferred");

  // Competing requests run through the real HTTP writer and D1 transaction.
  // A synthetic screening delay creates the interleave, not a stand-in event.
  const raced = await create("concurrent transition", peerPath, peer);
  const raceBody = { action: "defer", expected_last_event_id: (await read(raced)).last_event.event_id,
    reason: "The first request waits for screening." };
  const screenStart = await fixtures.screeningCalls();
  await fixtures.pauseScreening(2000);
  const pending = change(raced, raceBody, "lifecycle-race-loser", 409, peerPath, peer);
  const deadline = Date.now() + 10_000;
  while (await fixtures.screeningCalls() === screenStart && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(await fixtures.screeningCalls() > screenStart, "the first request reached screening");
  await fixtures.resumeScreening();
  await change(raced, { ...raceBody, reason: "The competing request wins the exact head." },
    "lifecycle-race-winner", 200, peerPath, peer);
  assert.ok(["OBJECT_VERSION_CONFLICT", "SCREENING_CONTEXT_STALE"].includes((await pending).code));
  assert.equal(await count("SELECT COUNT(*) AS n FROM events WHERE problem_id=? AND object_id=? AND type='hypothesis.deferred'",
    problem, raced), 1, "only one competing lifecycle event commits");

  const tail = EventTailResponseSchema.parse(await call(`/p/${problem}/events.json?since=0&limit=200`));
  const expectedTypes = ["hypothesis.deferred", "hypothesis.resumed", "hypothesis.narrowed", "hypothesis.superseded"];
  for (const type of expectedTypes)
    assert.ok(tail.events.some(record => record.event?.type === type), `public event tail discloses ${type}`);
  const records = [];
  let after = 0;
  const through = tail.page_end.through;
  for (let pages = 0; pages < 10; pages++) {
    const pack = PackResponseSchema.parse(await call(`${authorPath}/pack?profile=full&max_tokens=8000&through=${through}&after=${after}`,
      undefined, author));
    records.push(...pack.items.filter(item => item.kind === "full-event").map(item => JSON.parse(item.body)));
    const page = FullPackPageSchema.parse(JSON.parse(pack.items.find(item => item.kind === "full-page").body));
    if (!page.has_more) break;
    assert.ok(page.next_after > after, "full-pack continuation advances");
    after = page.next_after;
  }
  for (const type of expectedTypes) {
    const record = records.find(item => item.publication?.type === type);
    assert.ok(record && record.content_omitted === null && record.content?.expected_last_event_id,
      `full ledger packs retain the typed ${type} receipt`);
  }
  await assertProjectionsRebuild(env.DB, problem);
  console.log(JSON.stringify({ kind: "hypothesis-lifecycle-real-bindings", status: "pass",
    boundary: "local Workerd/D1/R2 with synthetic screening; no staging or live Workers AI",
    features: ["defer", "resume", "narrow", "supersede", "immutable statements", "frozen reads",
      "live recommendations", "exact replay", "stale target refusal", "resumed and deferred elimination",
      "atomic rollback", "competing transitions", "public event tail", "typed full packs", "projection rebuild"] }));
});
