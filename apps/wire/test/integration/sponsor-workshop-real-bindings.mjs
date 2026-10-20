import assert from "node:assert/strict";
import {
  SPONSOR_WORKSHOP_INDEX_PAGE_LIMIT,
  SponsorWorkshopIndexResponseSchema,
  SponsorWorkshopMutationResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Signed sponsor requests reach the mounted production route in Workerd.
// Enrollment approval and screening output are fixtures; D1 transactions,
// private R2, provenance, public reads and projection replay are real.
await runLocalWorkerJourney(async (journey) => {
  const { call, enroll, fixtures, env, sponsorCall, worker, origin, userAgent } = journey;
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
  const indexPath = "/v1/sponsors/workshops";
  const directory = async (after, actor = sponsor) =>
    SponsorWorkshopIndexResponseSchema.parse(
      await sponsorCall(actor, "POST", indexPath, "workshop.list", after ? { after } : {}),
    );
  const grant = await env.DB.prepare(
    "SELECT granted_resources_json FROM enrollment_grants WHERE fellow_id = ?",
  )
    .bind(fellow.fellow_id)
    .first();
  const resources = JSON.parse(grant.granted_resources_json);
  assert.equal(resources.problemBinding, undefined);
  assert.equal(resources.problem_binding, undefined);
  assert.deepEqual(
    (await directory()).workshops,
    [
      {
        fellow_id: fellow.fellow_id,
        fellow_name: "sponsor-workshop-author",
        problem_id: problem,
        workshop_cursor: scratch.workshop_seq,
      },
    ],
    "actual work is discoverable without a mint-time problem assignment",
  );
  assert.deepEqual((await directory(undefined, "usr_workshop_reviewer")).workshops, []);
  assert.equal((await call(indexPath, {}, token, 403)).code, "WRONG_PRINCIPAL");
  await call(indexPath, {}, undefined, 403);
  await sponsorCall(sponsor, "POST", indexPath, "workshop.read", {}, 401);
  assert.ok(!JSON.stringify(await directory()).includes(privateBody));
  assert.deepEqual(await publicState(), beforePrivateActions);

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
  assert.equal(
    (await directory()).workshops[0].workshop_cursor,
    discarded.workshop_seq,
    "discarded work stays discoverable for recovery",
  );
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

  // Genuine private proposals, sessions and pushes cross the directory page
  // boundary in D1. No grant bindings or console inventory rows are fixtures.
  const privateProblems = [];
  for (let i = 0; i < SPONSOR_WORKSHOP_INDEX_PAGE_LIMIT; i += 1) {
    const privateProblem = await call(
      "/v1/problems",
      {
        title: `Finite path with exactly ${i + 2} edges`,
        statement: `Every finite simple path with exactly ${i + 2} edges has exactly ${i + 3} vertices.`,
        falsifier: `A finite simple path with ${i + 2} edges and a vertex count other than ${i + 3}.`,
        motivation:
          "Examine this fixed finite boundary case independently before public submission.",
        areas: ["combinatorics"],
        distinct_because: `This private problem fixes the edge count at ${i + 2} and limits all claims to that one boundary case.`,
      },
      token,
      201,
    );
    const privateId = privateProblem.problem.id;
    privateProblems.push(privateId);
    const privateSession = await call("/v1/sessions", { problem_id: privateId }, token, 201);
    const privateDraft = await push(
      {
        type: "scratch",
        title: "Private finite case",
        body_md: privateBody,
      },
      privateSession,
    );
    await call(
      `/v1/sessions/${privateSession.session_id}/close`,
      {
        handback: "Retain this deliberately private case for sponsor review.",
        ...(i % 2 === 0
          ? { keep: [privateDraft.workshop_id] }
          : { discard: [privateDraft.workshop_id] }),
      },
      token,
      201,
    );
  }
  const firstDirectory = await directory();
  assert.equal(firstDirectory.workshops.length, SPONSOR_WORKSHOP_INDEX_PAGE_LIMIT);
  assert.ok(firstDirectory.next_cursor);
  const firstPair = firstDirectory.workshops.find((item) => item.problem_id !== problem);
  assert.ok(firstPair);
  const firstHead = await env.DB.prepare(
    "SELECT workshop_id, current_version FROM workshop_objects WHERE fellow_id = ? AND problem_id = ? LIMIT 1",
  )
    .bind(firstPair.fellow_id, firstPair.problem_id)
    .first();
  await act({
    problem_id: firstPair.problem_id,
    fellow_id: firstPair.fellow_id,
    workshop_id: firstHead.workshop_id,
    expected_workshop_version: firstHead.current_version,
    action: "keep",
  });
  const lastDirectory = await directory(firstDirectory.next_cursor);
  assert.equal(lastDirectory.next_cursor, null);
  assert.deepEqual(
    [...firstDirectory.workshops, ...lastDirectory.workshops].map((item) => item.problem_id),
    [problem, ...privateProblems].sort(),
    "stable pages discover every actual pair even after an earlier draft changes",
  );
  assert.deepEqual((await directory(undefined, "usr_workshop_reviewer")).workshops, []);
  assert.deepEqual(
    await publicState(),
    beforePrivateActions,
    "private discovery, proposals and recovered drafts leave the public cursor unchanged",
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
    publication: {
      kind: "conjecture",
      statement: "A missing falsifier remains a private draft.",
    },
  });
  const missingBefore = await publicState();
  assert.equal((await act(bodyFor(missing, "promote"), 422)).code, "MISSING_FALSIFIER");
  assert.deepEqual(await publicState(), missingBefore);
  assert.equal((await head(missing)).current_version, 1);
  assert.equal((await act(bodyFor(scratch, "promote", 4), 422)).code, "PROMOTE_BODY_INVALID");

  const draft = await push(draftBody);
  const draftInitial = await history(draft);
  const missingInitial = await history(missing);
  const beforeClose = await publicState();
  // A later Fellow session edits the original card. Sponsor promotion must
  // credit this selected revision's author session, even after it closes.
  // The first close exercises the bulk SQL keep/discard path and must retain
  // the exact typed publication bytes in each immutable private snapshot.
  await call(
    `/v1/sessions/${session.session_id}/close`,
    {
      handback: "The selected claim is ready for sponsor review.",
      promote: [],
      keep: [draft.workshop_id],
      discard: [missing.workshop_id],
    },
    token,
    201,
  );
  for (const [object, original, action, state] of [
    [draft, draftInitial, "keep", "open"],
    [missing, missingInitial, "discard", "discarded"],
  ]) {
    const revisions = await history(object);
    assert.equal(revisions.length, 2);
    assert.deepEqual(revisions[0], original[0]);
    assert.equal(revisions[1].publication_json, original[0].publication_json);
    assert.equal(revisions[1].revise_action, action);
    assert.equal(revisions[1].session_id, session.session_id);
    assert.equal(revisions[1].acting_sponsor_id, null);
    assert.equal(revisions[1].publication_event_id, null);
    const closedHead = await head(object);
    assert.equal(closedHead.current_version, 2);
    assert.equal(closedHead.state, state);
    assert.equal(closedHead.publication_json, original[0].publication_json);
  }
  assert.deepEqual(await publicState(), beforeClose, "bulk close actions stay private");
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
    { workshop_id: draft.workshop_id, base_version: 2, publication: editedPublication },
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
    await act(bodyFor(draft, "promote", 3), 201, "promote-once"),
  );
  assert.equal(promoted.promoted_workshop_version, 3);
  assert.equal(promoted.acting_sponsor_id, sponsor);
  assert.equal((await head(draft)).state, "archived");
  assert.equal((await head(draft)).current_version, 4);
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
    workshop_version: 3,
  });
  assert.ok(!event.payload_json.includes(privateBody));
  assert.ok(!event.payload_json.includes(draft.workshop_id));
  const archive = (await history(draft))[3];
  assert.equal(archive.publication_json, reviewedBytes);
  assert.equal(archive.acting_sponsor_id, sponsor);
  assert.equal(archive.publication_event_id, event.id);
  assert.equal(archive.session_id, editorSession.session_id);
  const afterPromotion = await publicState();
  assert.equal(afterPromotion.events.count, beforePromotion.events.count + 1);
  assert.equal(afterPromotion.cursor.cursor, beforePromotion.cursor.cursor + 1);
  assert.equal(afterPromotion.problem.public_seq, beforePromotion.problem.public_seq + 1);
  assert.deepEqual(await act(bodyFor(draft, "promote", 3), 200, "promote-once"), promoted);
  assert.deepEqual(await publicState(), afterPromotion);
  assert.equal((await history(draft)).length, 4, "retry never archives a second revision");
  assert.equal(
    (await act(bodyFor(draft, "discard", 3), 409, "promote-once")).code,
    "IDEMPOTENCY_CONFLICT",
  );
  const publicFace = await call(`/p/${problem}/claims/${promoted.promotion.claim_id}.json`);
  assert.ok(JSON.stringify(publicFace).includes(editedPublication.statement));
  assert.ok(!JSON.stringify(publicFace).includes(privateBody));
  assert.ok(!JSON.stringify(publicFace).includes(draft.workshop_id));

  const researchSession = await call(
    "/v1/sessions",
    { problem_id: problem, intent: "explore" },
    token,
    201,
  );
  const duplicate = await push({ ...draftBody, publication: editedPublication }, researchSession);
  assert.equal((await act(bodyFor(duplicate, "promote"), 409)).code, "DUPLICATE_CLAIM");

  // Typed routes and evidence are deliberate Fellow work products. Sponsors
  // select their immutable revision; the ordinary scientific writer handles
  // validation, coercion, screening, publication and exact receipts.
  const hypothesisPayload = {
    route: "Induct on the number of edges in a finite simple path.",
    mechanism: "Remove one endpoint and its incident edge, preserving a smaller simple path.",
    falsifier: "An endpoint removal that does not leave a simple path with one fewer edge.",
    expected_evidence: "The zero-edge boundary case and the exact endpoint-removal identity.",
    discriminating_predictions: ["One endpoint removal decreases both counts by one."],
    origin: "proposed",
    body_md: "PUBLIC_HYPOTHESIS_PRODUCT: compare the endpoint-removal route with cycle deletion.",
  };
  const evidencePayload = {
    bears_on_kind: "claim",
    bears_on_id: promoted.promotion.claim_id,
    bears_on_version: 1,
    direction: "informs",
    kind: "argument",
    source: { kind: "model_memory" },
    mode: "exploratory",
    body_md: "PUBLIC_EVIDENCE_PRODUCT: the one-edge path has two vertices of degree one.",
  };
  const hypothesisDraft = await push(
    {
      type: "note",
      title: "Endpoint-removal route",
      body_md: privateBody,
      ledger_intent: { kind: "create", target_kind: "hypothesis" },
      publication: { object_kind: "hypothesis", payload: hypothesisPayload },
    },
    researchSession,
  );
  const evidenceDraft = await push(
    {
      type: "evidence-draft",
      title: "One-edge boundary observation",
      body_md: privateBody,
      ledger_intent: { kind: "create", target_kind: "evidence" },
      publication: { object_kind: "evidence", payload: evidencePayload },
    },
    researchSession,
  );
  const typedBefore = await publicState();
  await call(
    `/v1/sessions/${researchSession.session_id}/close`,
    {
      handback: "The complete route and observation are ready for sponsor inspection.",
      keep: [hypothesisDraft.workshop_id, evidenceDraft.workshop_id],
    },
    token,
    201,
  );
  assert.deepEqual(await publicState(), typedBefore, "typed work and close stay private");
  const typedPage = await sponsorCall(sponsor, "POST", "/v1/sponsors/workshop", "workshop.read", {
    problem_id: problem,
    fellow_id: fellow.fellow_id,
  });
  const selectedHypothesis = typedPage.objects.find(
    (item) => item.workshop_id === hypothesisDraft.workshop_id,
  );
  assert.ok(selectedHypothesis, "the actual sponsor read carries the typed publication");
  assert.deepEqual(selectedHypothesis.publication, {
    object_kind: "hypothesis",
    payload: hypothesisPayload,
  });
  await act(bodyFor(evidenceDraft, "promote", 2), 404, undefined, "usr_workshop_reviewer");

  await env.DB.prepare(
    "UPDATE problem_memberships SET role='observer' WHERE problem_id=? AND fellow_id=?",
  )
    .bind(problem, fellow.fellow_id)
    .run();
  assert.equal((await act(bodyFor(hypothesisDraft, "promote", 2), 403)).code, "WRITE_REFUSED");
  const evidenceReceipt = SponsorWorkshopMutationResponseSchema.parse(
    await act(bodyFor(evidenceDraft, "promote", 2), 201, "typed-evidence-once"),
  );
  assert.equal(evidenceReceipt.promotion.object_kind, "evidence");
  assert.equal(evidenceReceipt.promotion.result.computed_class, "assertion");
  assert.deepEqual(evidenceReceipt.promotion.result.coercion_flags, [
    "p8_model_memory_caps_at_assertion",
  ]);
  assert.equal(evidenceReceipt.promotion.result.drives_promotion, false);
  await env.DB.prepare(
    "UPDATE problem_memberships SET role='contributor' WHERE problem_id=? AND fellow_id=?",
  )
    .bind(problem, fellow.fellow_id)
    .run();
  const hypothesisReceipt = SponsorWorkshopMutationResponseSchema.parse(
    await act(bodyFor(hypothesisDraft, "promote", 2), 201, "typed-hypothesis-once"),
  );
  assert.equal(hypothesisReceipt.promotion.object_kind, "hypothesis");
  assert.equal(hypothesisReceipt.promotion.result.status, "open");
  for (const [object, receipt, kind, product] of [
    [hypothesisDraft, hypothesisReceipt, "hypothesis", hypothesisPayload.body_md],
    [evidenceDraft, evidenceReceipt, "evidence", evidencePayload.body_md],
  ]) {
    const id =
      kind === "hypothesis"
        ? receipt.promotion.result.hypothesis_id
        : receipt.promotion.result.evidence_id;
    const entry = await env.DB.prepare(
      "SELECT e.*,c.payload_json FROM events e JOIN event_content c ON c.event_id=e.id WHERE e.problem_id=? AND e.object_id=? AND e.type=?",
    )
      .bind(problem, id, `${kind}.created`)
      .first();
    assert.ok(entry);
    assert.equal(entry.actor_fellow_id, fellow.fellow_id);
    assert.equal(entry.actor_sponsor_id, sponsor);
    assert.equal(entry.actor_session_id, researchSession.session_id);
    assert.equal(entry.writer_credential_id, null);
    assert.equal(entry.seq, receipt.promotion.seq);
    assert.equal(entry.model_string_self_declared, "synthetic-problem-model");
    assert.equal(entry.harness, "local-problem-lifecycle-proof");
    const content = JSON.parse(entry.payload_json);
    assert.equal(content.body_md, product);
    assert.deepEqual(content.sponsor_promotion, {
      acting_sponsor_id: sponsor,
      workshop_version: 2,
    });
    assert.ok(!entry.payload_json.includes(privateBody));
    assert.ok(!entry.payload_json.includes(object.workshop_id));
    const archived = await history(object);
    assert.equal(archived.length, 3);
    assert.equal(archived[2].publication_event_id, entry.id);
    assert.equal(archived[2].session_id, researchSession.session_id);
    assert.equal(archived[2].acting_sponsor_id, sponsor);
    assert.equal((await head(object)).state, "archived");
    const face = await call(
      `/p/${problem}/${kind === "hypothesis" ? "hypotheses" : "evidence"}/${id}.json`,
    );
    assert.ok(JSON.stringify(face).includes(product));
    assert.ok(!JSON.stringify(face).includes(privateBody));
  }
  const typedPublished = await publicState();
  assert.deepEqual(
    await act(bodyFor(evidenceDraft, "promote", 2), 200, "typed-evidence-once"),
    evidenceReceipt,
  );
  assert.deepEqual(
    await act(bodyFor(hypothesisDraft, "promote", 2), 200, "typed-hypothesis-once"),
    hypothesisReceipt,
  );
  assert.deepEqual(await publicState(), typedPublished);

  const lastSession = await call(
    "/v1/sessions",
    { problem_id: problem, intent: "explore" },
    token,
    201,
  );
  const missingTarget = await push(
    {
      type: "evidence-draft",
      title: "Unresolved exact target",
      body_md: privateBody,
      publication: {
        object_kind: "evidence",
        payload: { ...evidencePayload, bears_on_id: "C-999999" },
      },
    },
    lastSession,
  );
  assert.equal((await act(bodyFor(missingTarget, "promote"), 422)).code, "EVIDENCE_BODY_INVALID");
  assert.deepEqual(await publicState(), typedPublished);
  const mismatched = await push(
    {
      type: "note",
      title: "Unselected route",
      body_md: privateBody,
      publication: { object_kind: "hypothesis", payload: hypothesisPayload },
      ledger_intent: { kind: "create", target_kind: "claim" },
    },
    lastSession,
  );
  assert.equal((await act(bodyFor(mismatched, "promote"), 422)).code, "PROMOTE_BODY_INVALID");
  assert.deepEqual(await publicState(), typedPublished);

  // A late private archive fault must roll back the public object and its
  // receipt as well, leaving the exact request safe to retry.
  const lateFault = await push(
    {
      type: "note",
      title: "Archive transaction witness",
      body_md: privateBody,
      publication: {
        object_kind: "hypothesis",
        payload: {
          ...hypothesisPayload,
          route: "Compare a path with its reversed vertex order.",
        },
      },
    },
    lastSession,
  );
  await env.DB.prepare(`CREATE TRIGGER sponsor_research_archive_fault BEFORE INSERT ON workshop_revisions
    WHEN NEW.revise_action='archive' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SPONSOR_ARCHIVE_FAILURE'); END`).run();
  await act(bodyFor(lateFault, "promote"), 500, "typed-archive-fault");
  assert.deepEqual(await publicState(), typedPublished);
  assert.equal((await head(lateFault)).current_version, 1);
  await env.DB.prepare("DROP TRIGGER sponsor_research_archive_fault").run();
  await act(bodyFor(lateFault, "promote"), 201, "typed-archive-fault");

  // Evidence on a hypothesis has a complete public item face, so the
  // receipt opens the scientific product as well as its event identity.
  const routeEvidenceProduct =
    "PUBLIC_ROUTE_EVIDENCE: removing either endpoint gives the same edge count.";
  const routeEvidence = await push(
    {
      type: "evidence-draft",
      title: "Endpoint-removal route observation",
      body_md: privateBody,
      publication: {
        object_kind: "evidence",
        payload: {
          ...evidencePayload,
          bears_on_kind: "hypothesis",
          bears_on_id: hypothesisReceipt.promotion.result.hypothesis_id,
          bears_on_version: undefined,
          body_md: routeEvidenceProduct,
        },
      },
    },
    lastSession,
  );
  const routeEvidenceReceipt = SponsorWorkshopMutationResponseSchema.parse(
    await act(bodyFor(routeEvidence, "promote"), 201, "typed-route-evidence"),
  );
  assert.equal(routeEvidenceReceipt.promotion.object_kind, "evidence");
  const routeEvidenceFace = await worker.fetch(
    `${origin}/p/${problem}/evidence/${routeEvidenceReceipt.promotion.result.evidence_id}.md`,
    { headers: { "User-Agent": userAgent } },
  );
  assert.equal(routeEvidenceFace.status, 200);
  const routeEvidenceReadback = await routeEvidenceFace.text();
  assert.ok(routeEvidenceReadback.includes(routeEvidenceReceipt.promotion.result.evidence_id));
  assert.ok(routeEvidenceReadback.includes(routeEvidenceProduct));
  assert.ok(!routeEvidenceReadback.includes(privateBody));
  assert.ok(!routeEvidenceReadback.includes(routeEvidence.workshop_id));

  // Version pins are tested against real concurrent workshop writes while
  // the provider waits; no prepared scientific prefix may survive the loss.
  for (const mutation of ["edit", "discard"]) {
    const racedDraft = await push(
      {
        type: "note",
        title: `Pinned ${mutation} race`,
        body_md: privateBody,
        publication: { object_kind: "hypothesis", payload: hypothesisPayload },
      },
      lastSession,
    );
    const beforeRace = await publicState();
    const callsBeforeRace = await fixtures.screeningCalls();
    await fixtures.pauseScreening(2000);
    const publishing = act(bodyFor(racedDraft, "promote"), 409, `typed-race-${mutation}`);
    for (let i = 0; i < 150 && (await fixtures.screeningCalls()) === callsBeforeRace; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await fixtures.screeningCalls(), callsBeforeRace + 1);
    if (mutation === "edit")
      await push(
        {
          workshop_id: racedDraft.workshop_id,
          base_version: 1,
          title: "A newer private revision",
        },
        lastSession,
      );
    else await act(bodyFor(racedDraft, "discard"));
    assert.equal((await publishing).code, "WORKSHOP_VERSION_CONFLICT");
    await fixtures.resumeScreening();
    assert.deepEqual(await publicState(), beforeRace);
    assert.equal((await history(racedDraft)).length, 2);
    assert.equal((await head(racedDraft)).state, mutation === "edit" ? "open" : "discarded");
  }

  const screened = await push(
    {
      ...draftBody,
      publication: { ...publication, statement: "A finite path has no cycles in its edge set." },
    },
    lastSession,
  );

  // A stalled Fellow's complete replacement remains publishable by its
  // sponsor after the authoring session closes. Only saved science is used.
  const replacement = {
    claim_id: promoted.promotion.claim_id, base_version: 1, kind: "conjecture",
    statement: "Every finite simple path with at least one edge has exactly two degree-one vertices.",
    falsifier: "A finite simple path with at least one edge and a degree-one vertex count other than two.",
    depends_on: [],
  };
  const replacementBody = (revision) => ({
    type: "claim-draft", title: "Private saved replacement", body_md: privateBody,
    revision, ledger_intent: { kind: "revise", target_id: revision.claim_id, base_version: revision.base_version },
  });
  const replacementDraft = await push(replacementBody(replacement), lastSession);
  const staleReplacement = await push(replacementBody(replacement), lastSession);
  const missingReplacement = await push(replacementBody({ ...replacement, falsifier: undefined }), lastSession);
  const invalidBefore = await publicState();
  assert.equal((await act(bodyFor(missingReplacement, "promote"), 422)).code, "MISSING_FALSIFIER");
  await act(bodyFor(replacementDraft, "promote"), 404, undefined, "usr_workshop_reviewer");
  assert.equal((await act({ ...bodyFor(replacementDraft, "promote"), base_version: 999 }, 422)).code, "SCHEMA_INVALID");
  assert.deepEqual(await publicState(), invalidBefore);
  await call(`/v1/sessions/${lastSession.session_id}/close`, {
    handback: "A complete replacement is saved for the sponsor to review and publish.",
  }, token, 201);
  const replacementEditor = await call("/v1/sessions", { problem_id: problem }, token, 201);
  const selectedReplacement = { ...replacement,
    statement: "Exactly two vertices have degree one in every finite simple path containing an edge." };
  await push({ workshop_id: replacementDraft.workshop_id, base_version: 1,
    revision: selectedReplacement }, replacementEditor);
  await call(`/v1/sessions/${replacementEditor.session_id}/close`, {
    handback: "Publish the exact updated replacement and retain its prior version's reviews.",
  }, token, 201);
  const selectedHistory = await history(replacementDraft);
  assert.equal(selectedHistory[1].session_id, replacementEditor.session_id);
  const revisionBefore = await publicState();
  const revisionScreensBefore = await fixtures.screeningCalls();
  assert.equal((await act(bodyFor(replacementDraft, "promote"), 409)).code, "WORKSHOP_VERSION_CONFLICT");
  assert.equal(await fixtures.screeningCalls(), revisionScreensBefore);
  await env.DB.prepare(`CREATE TRIGGER sponsor_replacement_archive_fault BEFORE INSERT ON workshop_revisions
    WHEN NEW.revise_action='archive' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_REPLACEMENT_ARCHIVE_FAILURE'); END`).run();
  await act(bodyFor(replacementDraft, "promote", 2), 500, "sponsor-replacement-once");
  assert.deepEqual(await publicState(), revisionBefore);
  assert.deepEqual(await history(replacementDraft), selectedHistory);
  assert.equal((await env.DB.prepare("SELECT MAX(version) AS version FROM claim_versions WHERE problem_id=? AND claim_id=?")
    .bind(problem, replacement.claim_id).first()).version, 1);
  await env.DB.prepare("DROP TRIGGER sponsor_replacement_archive_fault").run();
  const revised = SponsorWorkshopMutationResponseSchema.parse(
    await act(bodyFor(replacementDraft, "promote", 2), 201, "sponsor-replacement-once"),
  );
  assert.deepEqual(revised.promotion, { claim_id: replacement.claim_id, problem_id: problem,
    seq: revisionBefore.problem.public_seq + 1, version: 2, queue_position: revised.promotion.queue_position });
  const revisionEvent = await env.DB.prepare(`SELECT e.*, c.payload_json FROM events e
    JOIN event_content c ON c.event_id=e.id WHERE e.problem_id=? AND e.seq=?`)
    .bind(problem, revised.promotion.seq).first();
  assert.equal(revisionEvent.type, "claim.revised");
  assert.equal(revisionEvent.actor_fellow_id, fellow.fellow_id);
  assert.equal(revisionEvent.actor_sponsor_id, sponsor);
  assert.equal(revisionEvent.actor_session_id, replacementEditor.session_id);
  assert.equal(revisionEvent.writer_credential_id, null);
  assert.equal(revisionEvent.object_version, 2);
  const revisionPayload = JSON.parse(revisionEvent.payload_json);
  assert.equal(revisionPayload.statement, selectedReplacement.statement);
  assert.deepEqual(revisionPayload.sponsor_promotion, { acting_sponsor_id: sponsor, workshop_version: 2 });
  assert.ok(!revisionEvent.payload_json.includes(privateBody));
  assert.ok(!revisionEvent.payload_json.includes(replacementDraft.workshop_id));
  const revisedHistory = await history(replacementDraft);
  assert.deepEqual(revisedHistory.slice(0, 2), selectedHistory);
  assert.equal(revisedHistory[2].revision_json, selectedHistory[1].revision_json);
  assert.equal(revisedHistory[2].session_id, replacementEditor.session_id);
  assert.equal(revisedHistory[2].publication_event_id, revisionEvent.id);
  assert.equal(revisedHistory[2].acting_sponsor_id, sponsor);
  assert.equal((await head(replacementDraft)).state, "archived");
  const revisionAfter = await publicState();
  assert.deepEqual(await act(bodyFor(replacementDraft, "promote", 2), 200, "sponsor-replacement-once"), revised);
  assert.equal((await act(bodyFor(staleReplacement, "promote"), 409)).code, "OBJECT_VERSION_CONFLICT");
  assert.deepEqual(await publicState(), revisionAfter);
  assert.equal((await history(replacementDraft)).length, 3);
  const revisedFace = await call(`/p/${problem}/claims/${replacement.claim_id}@2.json`);
  const originalFace = await call(`/p/${problem}/claims/${replacement.claim_id}@1.json`);
  assert.ok(JSON.stringify(revisedFace).includes(selectedReplacement.statement));
  assert.ok(JSON.stringify(originalFace).includes(editedPublication.statement));
  assert.ok(!JSON.stringify(revisedFace).includes(privateBody));
  const revisionIndexDeadline = Date.now() + 25_000;
  while (Date.now() < revisionIndexDeadline) {
    const indexed = await env.DB.prepare("SELECT statement FROM public_claim_fts WHERE problem_id=? AND claim_id=?")
      .bind(problem, replacement.claim_id).first();
    if (indexed?.statement === selectedReplacement.statement) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(await env.DB.prepare("SELECT statement FROM public_claim_fts WHERE problem_id=? AND claim_id=?")
    .bind(problem, replacement.claim_id).first(), { statement: selectedReplacement.statement });

  const replacementRaceSession = await call("/v1/sessions", { problem_id: problem }, token, 201);
  for (const mutation of ["edit", "discard"]) {
    const source = await push(replacementBody({ ...replacement, base_version: 2,
      statement: `The saved ${mutation} replacement tests the path's endpoint invariant.` }), replacementRaceSession);
    const beforeRace = await publicState();
    const screenCount = await fixtures.screeningCalls();
    await fixtures.pauseScreening(2000);
    const publishing = act(bodyFor(source, "promote"), 409, `replacement-race-${mutation}`);
    for (let i = 0; i < 150 && (await fixtures.screeningCalls()) === screenCount; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await fixtures.screeningCalls(), screenCount + 1);
    if (mutation === "edit") await push({ workshop_id: source.workshop_id, base_version: 1,
      title: "The Fellow changed its saved selection" }, replacementRaceSession);
    else await act(bodyFor(source, "discard"));
    assert.equal((await publishing).code, "WORKSHOP_VERSION_CONFLICT");
    await fixtures.resumeScreening();
    assert.deepEqual(await publicState(), beforeRace);
  }
  const pausedReplacement = await push(replacementBody({ ...replacement, base_version: 2,
    statement: "Every nontrivial path retains two endpoints after reversal." }), replacementRaceSession);
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
  const pendingReplacement = act(bodyFor(pausedReplacement, "promote"), 403, "pause-during-replacement");
  for (let i = 0; i < 150 && (await fixtures.screeningCalls()) < screens + 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await fixtures.screeningCalls(), screens + 2);
  await sponsorCall(sponsor, "POST", "/v1/fellows/lifecycle", "fellow.lifecycle.change", {
    fellow_id: fellow.fellow_id,
    status: "paused",
    confirm: "change-fellow-lifecycle",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  assert.equal((await pending).code, "WRITE_REFUSED");
  assert.equal((await pendingReplacement).code, "WRITE_REFUSED");
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
      unbound_workshop_discovery: true,
      paginated_actual_problem_pairs: true,
      private_revision_history: true,
      sponsor_claim_replacements: true,
      replacement_rollback_replay_and_search: true,
      pinned_concurrency: true,
      stored_publication_only: true,
      bulk_close_preserves_publication_history: true,
      original_author_session: true,
      actor_provenance: true,
      idempotent_publication: true,
      live_authority_race: true,
      typed_hypothesis_and_evidence_publication: true,
      observer_evidence_permission: true,
      closed_source_session_publication: true,
      scientific_writer_coercions_and_refusals: true,
      hypothesis_evidence_public_readback: true,
      archive_failure_and_edit_discard_races: true,
    }),
  );
});
