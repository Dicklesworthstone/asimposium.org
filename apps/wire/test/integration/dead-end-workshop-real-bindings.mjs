import assert from "node:assert/strict";
import {
  DeadEndsListResponseSchema,
  ProblemDocumentSchema,
  RecordDeadEndResponseSchema,
  SponsorWorkshopMutationResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node and Workerd");

// Fresh local D1/R2 and mounted HTTP writers. Enrollment and classifier decisions
// use the established fixture; publication, screening context, provenance,
// archive, replay, governance and public readback use production code.
await runLocalWorkerJourney(async (context) => {
  const { call, enroll, env, fixtures, sponsorCall } = context;
  const sponsor = "usr_dead_end_workshop_owner";
  const observerSponsor = "usr_dead_end_workshop_observer";
  const authorToken = await enroll("dead-end-workshop-author", sponsor);
  const observerToken = await enroll("dead-end-workshop-observer", observerSponsor);
  const author = (await call("/v1/hello", undefined, authorToken)).fellow.fellow_id;
  const observer = (await call("/v1/hello", undefined, observerToken)).fellow.fellow_id;
  const created = await call("/v1/problems", {
    title: "Endpoint deletion and finite branching obstructions",
    statement: "Every finite simple path has exactly one more vertex than edges.",
    falsifier: "A finite simple path with a different difference between vertex and edge counts.",
    motivation: "Preserve bounded failed approaches and precise conditions for revisiting them.",
    areas: ["combinatorics"],
  }, authorToken, 201);
  const problem = created.problem.id;
  const governancePath = `/v1/sponsors/problems/${problem}/lifecycle`;
  const govern = (body, key) => sponsorCall(sponsor, "POST", governancePath,
    "problem-lifecycle", body, 200, governancePath, key);
  await govern({ action: "publish" }, "dew-publish-problem");
  const reviewSession = await call("/v1/sessions", { problem_id: problem, intent: "review" }, observerToken, 201);
  await call(`/v1/problems/${problem}/statement-review`, {
    session_id: reviewSession.session_id, statement_version: 1, verdict: "statement-clear",
    basis: "The finite simple path, integer counts and exact difference are explicitly defined.",
  }, observerToken);
  await call(`/v1/sessions/${reviewSession.session_id}/close`, {
    handback: "The formulation is sufficiently precise for bounded negative results.",
  }, observerToken, 201);
  const authorSession = await call("/v1/sessions", { problem_id: problem, intent: "explore" }, authorToken, 201);
  const observerSession = await call("/v1/sessions", { problem_id: problem, intent: "review" }, observerToken, 201);
  await govern({ action: "manage-member", operation: "set-role", target_fellow_id: observer, role: "observer" }, "dew-observer-role");
  assert.equal((await env.DB.prepare("SELECT role FROM problem_memberships WHERE problem_id=? AND fellow_id=?")
    .bind(problem, observer).first()).role, "observer");

  const privateBody = "PRIVATE_DEAD_END_WORKSHOP_CANARY: deliberate exploratory notes remain private.";
  const payload = (label) => ({
    approach: `Exhaustive analysis of ${label} paths under repeated endpoint deletion.`,
    why_it_fails: "The branching cases grow exponentially before the endpoint invariant becomes informative.",
    retry_predicate: "Worth retrying when a uniform boundary estimate limits the branching width.",
    what_was_examined: `${label} integer path families with sizes two through twelve.`,
    scope_detection_floor: "Only the stated finite families were examined; no global obstruction is claimed.",
    retry_when: { kind: "statement-revised" },
  });
  const push = (data, session = authorSession, token = authorToken, extra = {}) =>
    call(`/v1/sessions/${session.session_id}/workshop`, {
      type: "dead-end-draft", title: "Stored bounded negative result", body_md: privateBody,
      ledger_intent: { kind: "create", target_kind: "dead-end" },
      publication: { object_kind: "dead-end", payload: data }, ...extra,
    }, token, 201);
  const selection = (draft, version = 1, cursor) => ({
    workshop_id: draft.workshop_id, expected_workshop_version: version,
    ...(cursor === undefined ? {} : { client_context_cursor: cursor }),
  });
  const publishFellow = (draft, key, expected = 201, session = authorSession,
    token = authorToken, version = 1, cursor) => call(`/v1/sessions/${session.session_id}/dead-ends`,
    selection(draft, version, cursor), token, expected, key);
  const actionPath = "/v1/sponsors/workshop/action";
  const act = (draft, key, expected = 201, actor = sponsor, fellow = author, version = 1, action = "promote") =>
    sponsorCall(actor, "POST", actionPath, "workshop.action", {
      problem_id: problem, fellow_id: fellow, workshop_id: draft.workshop_id,
      expected_workshop_version: version, action,
    }, expected, actionPath, key);
  const head = (draft) => env.DB.prepare("SELECT * FROM workshop_objects WHERE workshop_id=?")
    .bind(draft.workshop_id).first();
  const history = async (draft) => (await env.DB.prepare(
    "SELECT * FROM workshop_revisions WHERE workshop_id=? ORDER BY version",
  ).bind(draft.workshop_id).all()).results;
  const publicState = async () => ({
    problem: await env.DB.prepare("SELECT public_seq,chain_digest,status,current_statement_version FROM problems WHERE id=?")
      .bind(problem).first(),
    cursor: await env.DB.prepare("SELECT cursor FROM public_cursor WHERE singleton=1").first(),
    events: (await env.DB.prepare("SELECT e.*,c.payload_json FROM events e JOIN event_content c ON c.event_id=e.id WHERE e.problem_id=? ORDER BY e.seq")
      .bind(problem).all()).results,
    deadEnds: (await env.DB.prepare("SELECT * FROM dead_ends WHERE problem_id=? ORDER BY seq")
      .bind(problem).all()).results,
  });
  const sourceEvent = (id) => env.DB.prepare(
    "SELECT e.*,c.payload_json FROM events e JOIN event_content c ON c.event_id=e.id WHERE e.problem_id=? AND e.object_id=? AND e.type='dead_end.recorded'",
  ).bind(problem, id).first();
  const replayCount = async (key) => (await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM session_write_replays WHERE idempotency_key=?",
  ).bind(key).first()).n;
  const publicDeadEnds = async (history = false) => DeadEndsListResponseSchema.parse(
    await call(`/p/${problem}/dead-ends.json${history ? "?include_superseded=true" : ""}`),
  );
  const assertPublication = async (draft, receipt, data, actor, session, source, sponsorActed, version = 1) => {
    const event = await sourceEvent(receipt.dead_end_id);
    assert.ok(event);
    assert.equal(event.actor_fellow_id, actor.fellow);
    assert.equal(event.actor_sponsor_id, actor.sponsor);
    assert.equal(event.actor_session_id, session.session_id);
    assert.equal(event.model_string_self_declared, "synthetic-problem-model");
    assert.equal(event.harness, "local-problem-lifecycle-proof");
    assert.equal(event.seq, receipt.seq);
    assert.equal(event.object_kind, "dead_end");
    const published = JSON.parse(event.payload_json);
    for (const [key, value] of Object.entries(data)) assert.deepEqual(published[key], value, `preserved ${key}`);
    if (sponsorActed) {
      assert.equal(event.writer_credential_id, null);
      assert.deepEqual(published.sponsor_promotion, { acting_sponsor_id: actor.sponsor, workshop_version: version });
    } else {
      assert.equal(typeof event.writer_credential_id, "string");
      assert.equal(published.sponsor_promotion, undefined);
    }
    assert.ok(!event.payload_json.includes(privateBody));
    assert.ok(!event.payload_json.includes(draft.workshop_id));
    const revisions = await history(draft);
    assert.deepEqual(revisions.slice(0, source.length), source, "source revisions stay immutable");
    assert.equal(revisions.length, source.length + 1);
    const archived = revisions.at(-1);
    assert.equal(archived.revise_action, "archive");
    assert.equal(archived.publication_json, source.at(-1).publication_json);
    assert.equal(archived.publication_event_id, event.id);
    assert.equal(archived.session_id, session.session_id);
    assert.equal(archived.acting_sponsor_id, sponsorActed ? actor.sponsor : null);
    assert.equal((await head(draft)).state, "archived");
    assert.equal((await head(draft)).current_version, version + 1);
    const item = (await publicDeadEnds(true)).dead_ends.find((item) => item.dead_end_id === receipt.dead_end_id);
    assert.ok(item, "the published result is readable from the existing public face");
    for (const key of ["approach", "why_it_fails", "retry_predicate", "what_was_examined", "scope_detection_floor", "retry_when"])
      assert.deepEqual(item[key], data[key]);
    assert.equal(item.author_fellow_id, actor.fellow);
    assert.equal(item.sponsor_id, actor.sponsor);
    assert.equal(item.session_id, session.session_id);
    assert.equal(item.model_string_self_declared, "synthetic-problem-model");
    assert.equal(item.harness, "local-problem-lifecycle-proof");
    assert.ok(!JSON.stringify(item).includes(privateBody));
    return event;
  };
  const noPaidEffect = async (operation) => {
    const before = await publicState();
    const screens = await fixtures.screeningCalls();
    const result = await operation();
    assert.equal(await fixtures.screeningCalls(), screens, "invalid selection never reaches paid screening");
    assert.deepEqual(await publicState(), before, "invalid selection publishes no scientific effect");
    return result;
  };
  const duringScreen = async (operation, mutation) => {
    const screens = await fixtures.screeningCalls();
    await fixtures.pauseScreening(2500);
    const pending = operation();
    try {
      for (let attempt = 0; attempt < 150 && (await fixtures.screeningCalls()) === screens; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(await fixtures.screeningCalls(), screens + 1, "the selected public payload is being screened");
      await mutation();
      return await pending;
    } finally {
      await fixtures.resumeScreening();
    }
  };

  // Ordinary content-bearing requests remain available alongside saved selection.
  const direct = RecordDeadEndResponseSchema.parse(await call(
    `/v1/sessions/${authorSession.session_id}/dead-ends`, payload("ordinary direct"), authorToken, 201, "dew-direct"));
  assert.ok((await publicDeadEnds()).dead_ends.some((item) => item.dead_end_id === direct.dead_end_id));

  // An observer with promote permission can publish its own exact saved DE.
  const observerPayload = payload("observer finite boundary");
  const observerDraft = await push(observerPayload, observerSession, observerToken);
  const observerSource = await history(observerDraft);
  const observerReceipt = RecordDeadEndResponseSchema.parse(await publishFellow(observerDraft,
    "dew-observer-publish", 201, observerSession, observerToken));
  await assertPublication(observerDraft, observerReceipt, observerPayload,
    { fellow: observer, sponsor: observerSponsor }, observerSession, observerSource, false);
  const publishedObserver = await publicState();
  assert.deepEqual(await publishFellow(observerDraft, "dew-observer-publish", 200, observerSession, observerToken), observerReceipt);
  assert.deepEqual(await publicState(), publishedObserver);
  assert.equal((await history(observerDraft)).length, 2);
  assert.equal(await replayCount("dew-observer-publish"), 1);

  // A saved replacement runs the ordinary duplicate/supersession and retry checks.
  const replacementPayload = { ...observerPayload,
    why_it_fails: "The original branching obstruction persists after checking an additional independent boundary family.",
    supersedes_dead_end_id: observerReceipt.dead_end_id,
  };
  const replacement = await push(replacementPayload, observerSession, observerToken);
  const replacementSource = await history(replacement);
  const replacementReceipt = RecordDeadEndResponseSchema.parse(await publishFellow(replacement,
    "dew-observer-supersession", 201, observerSession, observerToken));
  await assertPublication(replacement, replacementReceipt, replacementPayload,
    { fellow: observer, sponsor: observerSponsor }, observerSession, replacementSource, false);
  assert.equal((await publicDeadEnds()).dead_ends.some((item) => item.dead_end_id === observerReceipt.dead_end_id), false);
  assert.equal((await publicDeadEnds(true)).dead_ends.find((item) => item.dead_end_id === observerReceipt.dead_end_id).superseded_by,
    replacementReceipt.dead_end_id);

  const ownerDraft = await push(payload("owner exact selection"));
  await noPaidEffect(async () => assert.equal((await call(`/v1/sessions/${authorSession.session_id}/dead-ends`,
    { ...selection(ownerDraft), approach: "An attempted scientific override" }, authorToken, 422)).code, "DEAD_END_BODY_INVALID"));
  await noPaidEffect(async () => {
    const response = await context.worker.fetch(`${context.origin}/v1/sessions/${authorSession.session_id}/dead-ends`, {
      method: "POST",
      headers: {
        "user-agent": context.userAgent, authorization: `Bearer ${authorToken}`,
        "content-type": "application/json", "idempotency-key": "dew-invalid-context-header",
        "asimp-client-context-cursor": "not-a-cursor",
      },
      body: JSON.stringify(selection(ownerDraft)),
    });
    assert.equal(response.status, 422);
    assert.equal(ProblemDocumentSchema.parse(await response.json()).code, "DEAD_END_BODY_INVALID");
  });
  await noPaidEffect(async () => assert.equal((await publishFellow(ownerDraft, "dew-foreign-fellow", 404,
    observerSession, observerToken)).code, "WORKSHOP_OBJECT_NOT_FOUND"));
  await noPaidEffect(() => act(ownerDraft, "dew-foreign-sponsor", 404, observerSponsor));
  const empty = await call(`/v1/sessions/${authorSession.session_id}/workshop`, {
    type: "dead-end-draft", title: "Working notes alone", body_md: privateBody,
  }, authorToken, 201);
  await noPaidEffect(async () => assert.equal((await publishFellow(empty, "dew-untyped", 422)).code, "PROMOTE_BODY_INVALID"));
  const low = await push({ ...payload("unsubstantial"), approach: "Nothing worked here." });
  await noPaidEffect(async () => assert.equal((await publishFellow(low, "dew-low-substance", 422)).code, "DEAD_END_LOW_SUBSTANCE"));
  const invalidTarget = await push({ ...payload("missing retry target"), retry_when: { kind: "claim-reaches", claim_id: "C-999999", reaches: "corroborated" } });
  await noPaidEffect(async () => assert.equal((await publishFellow(invalidTarget,
    "dew-missing-retry-target", 422)).code, "RETRY_WHEN_TARGET_NOT_FOUND"));
  await noPaidEffect(() => call(`/v1/sessions/${authorSession.session_id}/workshop`, {
    type: "dead-end-draft", title: "Incomplete typed result", body_md: privateBody,
    publication: { object_kind: "dead-end", payload: { approach: "A missing scientific failure explanation" } },
  }, authorToken, 422));

  // An intentional late archive fault rolls back every public effect and replay.
  for (const mode of ["fellow", "sponsor"]) {
    const data = payload(`${mode} archive rollback`);
    const draft = await push(data);
    const source = await history(draft);
    const key = `dew-${mode}-archive-fault`;
    const publish = (expected) => mode === "fellow" ? publishFellow(draft, key, expected) : act(draft, key, expected);
    const before = await publicState();
    await env.DB.prepare(`CREATE TRIGGER dead_end_workshop_archive_fault BEFORE INSERT ON workshop_revisions
      WHEN NEW.revise_action='archive' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_DEAD_END_ARCHIVE_FAILURE'); END`).run();
    try {
      await publish(500);
      assert.deepEqual(await publicState(), before);
      assert.deepEqual(await history(draft), source);
      assert.equal((await head(draft)).state, "open");
      assert.equal(await replayCount(key), 0);
    } finally {
      await env.DB.prepare("DROP TRIGGER dead_end_workshop_archive_fault").run();
    }
    const result = await publish(201);
    const receipt = mode === "fellow" ? RecordDeadEndResponseSchema.parse(result)
      : SponsorWorkshopMutationResponseSchema.parse(result).promotion.result;
    await assertPublication(draft, receipt, data, { fellow: author, sponsor }, authorSession, source, mode === "sponsor");
    const committed = await publicState();
    assert.deepEqual(await publish(200), result);
    assert.deepEqual(await publicState(), committed);
    assert.equal((await history(draft)).length, 2);
    assert.equal(await replayCount(key), 1);
  }

  // Sponsor publication works after the original observer session closes.
  const sponsorPayload = payload("closed observer session");
  const sponsorDraft = await push(sponsorPayload, observerSession, observerToken);
  const beforeClose = await publicState();
  await call(`/v1/sessions/${observerSession.session_id}/close`, {
    handback: "The saved failure analysis and retry conditions are ready for sponsor publication.",
    keep: [sponsorDraft.workshop_id],
  }, observerToken, 201);
  assert.deepEqual(await publicState(), beforeClose);
  const sponsorSource = await history(sponsorDraft);
  assert.equal(sponsorSource.length, 2);
  assert.ok((await env.DB.prepare("SELECT closed_at FROM sessions WHERE session_id=?")
    .bind(observerSession.session_id).first()).closed_at);
  const sponsorReceipt = SponsorWorkshopMutationResponseSchema.parse(await act(sponsorDraft,
    "dew-sponsor-closed", 201, observerSponsor, observer, 2));
  assert.equal(sponsorReceipt.promotion.object_kind, "dead-end");
  assert.equal(sponsorReceipt.promoted_workshop_version, 2);
  await assertPublication(sponsorDraft, sponsorReceipt.promotion.result, sponsorPayload,
    { fellow: observer, sponsor: observerSponsor }, observerSession, sponsorSource, true, 2);
  const closedPublished = await publicState();
  assert.deepEqual(await act(sponsorDraft, "dew-sponsor-closed", 200, observerSponsor, observer, 2), sponsorReceipt);
  assert.deepEqual(await publicState(), closedPublished);
  assert.equal((await history(sponsorDraft)).length, 3);

  // Legal concurrent private edits and discard actions win over an old selection.
  for (const mutation of ["edit", "discard"]) {
    const draft = await push(payload(`late ${mutation}`));
    const original = (await history(draft))[0];
    const before = await publicState();
    const refusal = await duringScreen(
      () => mutation === "edit" ? publishFellow(draft, "dew-late-edit", 409) : act(draft, "dew-late-discard", 409),
      () => mutation === "edit"
        ? call(`/v1/sessions/${authorSession.session_id}/workshop`, {
          workshop_id: draft.workshop_id, base_version: 1, title: "A newer private analysis",
        }, authorToken, 201)
        : act(draft, "dew-discard-during-screen", 201, sponsor, author, 1, "discard"),
    );
    assert.equal(refusal.code, "WORKSHOP_VERSION_CONFLICT");
    assert.deepEqual(await publicState(), before);
    assert.equal((await head(draft)).state, mutation === "edit" ? "open" : "discarded");
    assert.equal((await history(draft)).length, 2);
    assert.deepEqual((await history(draft))[0], original);
  }

  // Source consistency is checked even when an in-place projection change does
  // not increment its version. The fixture changes only the mutable head.
  const intentDraft = await push(payload("immutable intent source"));
  const intentHead = await head(intentDraft);
  const intentHistory = await history(intentDraft);
  await env.DB.prepare("UPDATE workshop_objects SET ledger_intent_json=NULL WHERE workshop_id=?")
    .bind(intentDraft.workshop_id).run();
  await noPaidEffect(async () => assert.equal((await act(intentDraft, "dew-early-intent", 422)).code, "PROMOTE_BODY_INVALID"));
  await env.DB.prepare("UPDATE workshop_objects SET ledger_intent_json=? WHERE workshop_id=?")
    .bind(intentHead.ledger_intent_json, intentDraft.workshop_id).run();
  const beforeIntentRace = await publicState();
  await fixtures.armRaceBeforeNextBatch("UPDATE workshop_objects SET ledger_intent_json=NULL WHERE workshop_id=?",
    [intentDraft.workshop_id], "INSERT INTO events");
  try {
    assert.equal((await act(intentDraft, "dew-late-intent", 422)).code, "PROMOTE_BODY_INVALID");
    assert.equal(await fixtures.raceStillArmed(), false);
    assert.deepEqual(await publicState(), beforeIntentRace);
    assert.deepEqual(await history(intentDraft), intentHistory);
    assert.equal((await head(intentDraft)).state, "open");
  } finally {
    await fixtures.disarmRace();
    await env.DB.prepare("UPDATE workshop_objects SET ledger_intent_json=? WHERE workshop_id=?")
      .bind(intentHead.ledger_intent_json, intentDraft.workshop_id).run();
  }

  // Real governance can revoke membership while a saved publication is screened.
  const finalObserverSession = await call("/v1/sessions", { problem_id: problem, intent: "review" }, observerToken, 201);
  const lostMembership = await push(payload("membership loss"), finalObserverSession, observerToken);
  const membershipHistory = await history(lostMembership);
  let afterRemoval;
  const memberRefusal = await duringScreen(
    () => publishFellow(lostMembership, "dew-membership-loss", 403, finalObserverSession, observerToken),
    async () => {
      await govern({ action: "manage-member", operation: "remove", target_fellow_id: observer }, "dew-remove-member");
      afterRemoval = await publicState();
    },
  );
  assert.equal(memberRefusal.code, "WRITE_REFUSED");
  assert.deepEqual(await publicState(), afterRemoval);
  assert.deepEqual(await history(lostMembership), membershipHistory);

  // The supplied statement cursor survives into the final transaction. A real
  // statement revision wins during screening; only governance may remain.
  const contextDraft = await push(payload("statement context pin"));
  const contextHistory = await history(contextDraft);
  const oldCursor = (await publicState()).problem.public_seq;
  let afterRevision;
  const contextRefusal = await duringScreen(
    () => publishFellow(contextDraft, "dew-context-race", 409, authorSession, authorToken, 1, oldCursor),
    async () => {
      // The pending screen already owns its timer. The governance request can
      // now complete immediately through its own actual screening boundary.
      await fixtures.resumeScreening();
      await govern({
        action: "revise-statement",
        statement: "Every nonempty finite simple path has exactly one more vertex than edges.",
        falsifier: "A nonempty finite simple path whose vertex count differs from its edge count plus one.",
        motivation: "Make the nonempty boundary explicit before evaluating more failed approaches.",
      }, "dew-revise-context");
      afterRevision = await publicState();
    },
  );
  assert.equal(contextRefusal.code, "STATEMENT_REVISED_SINCE");
  assert.deepEqual(await publicState(), afterRevision);
  assert.deepEqual(await history(contextDraft), contextHistory);
  await noPaidEffect(async () => assert.equal((await publishFellow(contextDraft,
    "dew-stale-context", 409, authorSession, authorToken, 1, oldCursor)).code, "STATEMENT_REVISED_SINCE"));
  const currentCursor = afterRevision.problem.public_seq;
  const currentReceipt = RecordDeadEndResponseSchema.parse(await publishFellow(contextDraft,
    "dew-current-context", 201, authorSession, authorToken, 1, currentCursor));
  await assertPublication(contextDraft, currentReceipt, payload("statement context pin"),
    { fellow: author, sponsor }, authorSession, contextHistory, false);
  const trigger = await env.DB.prepare(`SELECT t.event_id,e.type FROM dead_end_fired_triggers t
    JOIN events e ON e.id=t.event_id WHERE t.problem_id=? AND t.dead_end_id=?`)
    .bind(problem, replacementReceipt.dead_end_id).first();
  assert.ok(trigger, "the stored retry predicate produces its ordinary atomic trigger");
  assert.equal(trigger.type, "problem.statement-revised");

  // Publication failure on a closed board retains the ordinary endpoint response.
  await govern({ action: "retire", reason: "The saved-publication verification is complete." }, "dew-retire");
  await noPaidEffect(async () => assert.equal((await call(`/v1/sessions/${authorSession.session_id}/dead-ends`,
    payload("closed board refusal"), authorToken, 422, "dew-closed-board")).code, "CLAIMS_BOARD_LOCKED"));
  console.log(JSON.stringify({
    stage: "dead-end-workshop-publication", status: "pass", problem,
    observer_selection: true, closed_session_sponsor: true, original_attribution: true,
    atomic_archive_replay: true, rollback_then_same_key_retry: true,
    early_refusals_without_paid_screening: true, late_source_and_membership_guards: true,
    statement_cursor_guard: true, supersession_and_retry_trigger: true,
  }));
}, { laneName: "dead-end-workshop" });
