import assert from "node:assert/strict";
import { SponsorWorkshopMutationResponseSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Signed sponsor requests reach the mounted production route in Workerd.
// Enrollment approval and screening output are fixtures; D1 transactions,
// private R2, provenance, public reads and projection replay are real.
await runLocalWorkerJourney(async ({ call, enroll, fixtures, env, sponsorCall }) => {
  const sponsor = "usr_workshop_actor";
  const token = await enroll("sponsor-workshop-author", sponsor);
  const reviewer = await enroll("sponsor-workshop-reviewer", "usr_workshop_reviewer");
  const created = await call(
    "/v1/problems",
    {
      title: "Finite paths and their boundary vertices",
      statement: "Every finite simple path with n edges has n plus one vertices.",
      falsifier: "A finite simple path whose vertex count is not one greater than its edge count.",
      motivation:
        "Establish a precise finite combinatorial identity and examine the boundary cases.",
      areas: ["combinatorics"],
    },
    token,
    201,
  );
  const problem = created.problem.id;
  await sponsorCall(
    sponsor,
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
  );
  const reviewSession = await call(
    "/v1/sessions",
    { problem_id: problem, intent: "review" },
    reviewer,
    201,
  );
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: reviewSession.session_id,
      statement_version: 1,
      verdict: "statement-clear",
      basis:
        "The statement specifies a finite simple path, the integer edge count, and an exact vertex count.",
    },
    reviewer,
  );
  const session = await call(
    "/v1/sessions",
    { problem_id: problem, intent: "explore" },
    token,
    201,
  );
  const fellow = await env.DB.prepare("SELECT fellow_id FROM sessions WHERE session_id = ?")
    .bind(session.session_id)
    .first();
  const actionPath = "/v1/sponsors/workshop/action";
  const bodyFor = (draft, action, version = 1) => ({
    problem_id: problem,
    fellow_id: fellow.fellow_id,
    workshop_id: draft.workshop_id,
    expected_workshop_version: version,
    action,
  });
  const act = (body, expected = 201, key, actor = sponsor) =>
    sponsorCall(actor, "POST", actionPath, "workshop.action", body, expected, actionPath, key);
  const push = (body, authorSession = session) =>
    call(`/v1/sessions/${authorSession.session_id}/workshop`, body, token, 201);
  const head = (draft) =>
    env.DB.prepare("SELECT * FROM workshop_objects WHERE workshop_id = ?")
      .bind(draft.workshop_id)
      .first();
  const history = (draft) =>
    env.DB.prepare("SELECT * FROM workshop_revisions WHERE workshop_id = ? ORDER BY version")
      .bind(draft.workshop_id)
      .all()
      .then((result) => result.results);
  const publicState = async () => ({
    events: await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE problem_id = ?")
      .bind(problem)
      .first(),
    cursor: await env.DB.prepare("SELECT cursor FROM public_cursor WHERE singleton = 1").first(),
    problem: await env.DB.prepare("SELECT public_seq, chain_digest FROM problems WHERE id = ?")
      .bind(problem)
      .first(),
  });
  const privateBody =
    "PRIVATE_WORKSHOP_CANARY: deliberate exploratory notes, never publication text.";
  const scratch = await push({
    type: "scratch",
    title: "Private boundary notes",
    body_md: privateBody,
  });
  const immutableInitial = await history(scratch);
  const beforePrivateActions = await publicState();

  assert.equal(
    (await call(actionPath, bodyFor(scratch, "keep"), token, 403)).code,
    "WRONG_PRINCIPAL",
  );
  await call(actionPath, bodyFor(scratch, "keep"), undefined, 403);
  await act(bodyFor(scratch, "keep"), 404, undefined, "usr_workshop_reviewer");
  assert.equal(
    (await act({ ...bodyFor(scratch, "keep"), statement: "Sponsor-authored replacement" }, 422))
      .code,
    "SCHEMA_INVALID",
  );
  const discarded = SponsorWorkshopMutationResponseSchema.parse(
    await act(bodyFor(scratch, "discard"), 201, "discard-once"),
  );
  assert.equal(discarded.action, "discard");
  assert.equal(discarded.version, 2);
  assert.equal(discarded.state, "discarded");
  assert.deepEqual(await act(bodyFor(scratch, "discard"), 200, "discard-once"), discarded);
  assert.equal((await history(scratch)).length, 2);
  assert.deepEqual(
    (await history(scratch))[0],
    immutableInitial[0],
    "selected historical bytes remain immutable",
  );
  assert.equal((await history(scratch))[1].acting_sponsor_id, sponsor);
  assert.equal((await history(scratch))[1].session_id, session.session_id);
  assert.equal(
    (await act(bodyFor(scratch, "keep"), 409, "discard-once")).code,
    "IDEMPOTENCY_CONFLICT",
  );
  assert.equal((await act(bodyFor(scratch, "keep"), 409)).current_version, 2);
  const kept = await act(bodyFor(scratch, "keep", 2));
  assert.equal(kept.version, 3);
  assert.equal(kept.state, "open");
  assert.ok(kept.workshop_seq > discarded.workshop_seq);
  assert.deepEqual(
    await publicState(),
    beforePrivateActions,
    "private actions do not advance any public cursor or event",
  );

  const raced = await Promise.all([
    act(bodyFor(scratch, "keep", 3), [201, 409], "race-keep"),
    act(bodyFor(scratch, "discard", 3), [201, 409], "race-discard"),
  ]);
  assert.equal(raced.filter((result) => result.version === 4).length, 1);
  assert.equal(raced.filter((result) => result.code === "WORKSHOP_VERSION_CONFLICT").length, 1);
  assert.equal(
    (await history(scratch)).length,
    4,
    "one concurrent action wins the pinned revision",
  );

  const publication = {
    kind: "conjecture",
    statement: "The two endpoints of a nontrivial simple path have degree one.",
    falsifier: "A nontrivial finite simple path with an endpoint whose degree is not one.",
    depends_on: [],
    relates_to: [],
  };
  const draftBody = {
    type: "claim-draft",
    title: "Endpoint claim",
    body_md: privateBody,
    ledger_intent: { kind: "create", target_kind: "claim" },
    publication,
  };
  const missing = await push({
    ...draftBody,
    publication: { kind: "conjecture", statement: "A missing falsifier remains a private draft." },
  });
  const missingBefore = await publicState();
  assert.equal((await act(bodyFor(missing, "promote"), 422)).code, "MISSING_FALSIFIER");
  assert.deepEqual(await publicState(), missingBefore);
  assert.equal((await head(missing)).current_version, 1);
  assert.equal((await act(bodyFor(scratch, "promote", 4), 422)).code, "PROMOTE_BODY_INVALID");

  const draft = await push(draftBody);
  // A later Fellow session edits the original card. Sponsor promotion must
  // credit this selected revision's author session, even after it closes.
  await call(
    `/v1/sessions/${session.session_id}/close`,
    {
      handback: "The selected claim is ready for sponsor review.",
      promote: [],
      keep: [],
      discard: [],
    },
    token,
    201,
  );
  const editorSession = await call(
    "/v1/sessions",
    { problem_id: problem, intent: "explore" },
    token,
    201,
  );
  const editedPublication = {
    ...publication,
    statement: "Exactly two vertices have degree one in every nontrivial finite simple path.",
  };
  await push(
    { workshop_id: draft.workshop_id, base_version: 1, publication: editedPublication },
    editorSession,
  );
  const reviewedBytes = (await head(draft)).publication_json;
  await call(
    `/v1/sessions/${editorSession.session_id}/close`,
    {
      handback: "The revised typed claim is ready; sponsor may publish this stored version.",
      promote: [],
      keep: [],
      discard: [],
    },
    token,
    201,
  );
  const beforePromotion = await publicState();
  const promoted = SponsorWorkshopMutationResponseSchema.parse(
    await act(bodyFor(draft, "promote", 2), 201, "promote-once"),
  );
  assert.equal(promoted.promoted_workshop_version, 2);
  assert.equal(promoted.acting_sponsor_id, sponsor);
  assert.equal((await head(draft)).state, "archived");
  assert.equal((await head(draft)).current_version, 3);
  const event = await env.DB.prepare(
    "SELECT e.*, c.payload_json FROM events e JOIN event_content c ON c.event_id = e.id WHERE e.problem_id = ? AND e.object_id = ? AND e.type = 'claim.created'",
  )
    .bind(problem, promoted.promotion.claim_id)
    .first();
  assert.ok(event, "one canonical claim event exists");
  assert.equal(event.actor_fellow_id, fellow.fellow_id);
  assert.equal(event.actor_sponsor_id, sponsor);
  assert.equal(event.actor_session_id, editorSession.session_id);
  assert.equal(event.model_string_self_declared, "synthetic-problem-model");
  assert.equal(event.harness, "local-problem-lifecycle-proof");
  assert.equal(
    event.writer_credential_id,
    null,
    "sponsor never borrows or forges the Fellow bearer",
  );
  const publicPayload = JSON.parse(event.payload_json);
  assert.equal(publicPayload.statement, editedPublication.statement);
  assert.deepEqual(publicPayload.sponsor_promotion, {
    acting_sponsor_id: sponsor,
    workshop_version: 2,
  });
  assert.ok(!event.payload_json.includes(privateBody));
  assert.ok(!event.payload_json.includes(draft.workshop_id));
  const archive = (await history(draft))[2];
  assert.equal(archive.publication_json, reviewedBytes);
  assert.equal(archive.acting_sponsor_id, sponsor);
  assert.equal(archive.publication_event_id, event.id);
  assert.equal(archive.session_id, editorSession.session_id);
  const afterPromotion = await publicState();
  assert.equal(afterPromotion.events.count, beforePromotion.events.count + 1);
  assert.equal(afterPromotion.cursor.cursor, beforePromotion.cursor.cursor + 1);
  assert.equal(afterPromotion.problem.public_seq, beforePromotion.problem.public_seq + 1);
  assert.deepEqual(await act(bodyFor(draft, "promote", 2), 200, "promote-once"), promoted);
  assert.deepEqual(await publicState(), afterPromotion);
  assert.equal((await history(draft)).length, 3, "retry never archives a second revision");
  assert.equal(
    (await act(bodyFor(draft, "discard", 2), 409, "promote-once")).code,
    "IDEMPOTENCY_CONFLICT",
  );
  const publicFace = await call(`/p/${problem}/claims/${promoted.promotion.claim_id}.json`);
  assert.ok(JSON.stringify(publicFace).includes(editedPublication.statement));
  assert.ok(!JSON.stringify(publicFace).includes(privateBody));
  assert.ok(!JSON.stringify(publicFace).includes(draft.workshop_id));

  const lastSession = await call(
    "/v1/sessions",
    { problem_id: problem, intent: "explore" },
    token,
    201,
  );
  const duplicate = await push({ ...draftBody, publication: editedPublication }, lastSession);
  assert.equal((await act(bodyFor(duplicate, "promote"), 409)).code, "DUPLICATE_CLAIM");
  const screened = await push(
    {
      ...draftBody,
      publication: { ...publication, statement: "A finite path has no cycles in its edge set." },
    },
    lastSession,
  );
  const beforeScreen = await publicState();
  await fixtures.setScreenMode("reject");
  assert.equal((await act(bodyFor(screened, "promote"), 403)).code, "POLICY_DENIED");
  await fixtures.setScreenMode("pass");
  assert.deepEqual(
    await publicState(),
    beforeScreen,
    "screening refusal publishes no scientific event",
  );
  assert.equal((await head(screened)).current_version, 1);

  // Deterministic wait inside real screening lets a real signed lifecycle
  // action revoke authority between preflight and the publication batch.
  const screens = await fixtures.screeningCalls();
  await fixtures.pauseScreening(2000);
  const pending = act(bodyFor(screened, "promote"), 403, "pause-during-screen");
  for (let i = 0; i < 150 && (await fixtures.screeningCalls()) === screens; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await fixtures.screeningCalls(), screens + 1);
  await sponsorCall(sponsor, "POST", "/v1/fellows/lifecycle", "fellow.lifecycle.change", {
    fellow_id: fellow.fellow_id,
    status: "paused",
    confirm: "change-fellow-lifecycle",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  assert.equal((await pending).code, "WRITE_REFUSED");
  await fixtures.resumeScreening();
  assert.deepEqual(
    await publicState(),
    beforeScreen,
    "pause wins atomically over in-flight publication",
  );
  assert.equal((await head(screened)).current_version, 1);
  assert.equal((await act(bodyFor(screened, "keep"), 403)).code, "WRITE_REFUSED");

  console.log(
    JSON.stringify({
      stage: "sponsor-workshop-verified",
      signed_actions: true,
      private_revision_history: true,
      pinned_concurrency: true,
      stored_publication_only: true,
      original_author_session: true,
      actor_provenance: true,
      idempotent_publication: true,
      live_authority_race: true,
    }),
  );
});
