import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ClaimFaceResponseSchema,
  LeaseAcquireResponseSchema,
  ScreeningPromotionDeniedResponseSchema,
  SessionCloseResponseSchema,
  WorkshopPushResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Enrollment approval and classifier observations use the existing fixture seam.
// HTTP authorization, D1 transactions, private R2, immutable history, outbox and
// the harness's final production projection replay all use genuine Workerd bindings.
assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

const receipt = await runLocalWorkerJourney(async function sessionClosePublicationsJourney({
  call, enroll, sponsorCall, env, fixtures, worker, origin, userAgent,
}) {
  const sponsor = "usr_close_publications_author";
  const author = await enroll("close-publications-author", sponsor);
  const reviewer = await enroll("close-publications-reviewer", "usr_close_publications_reviewer");
  const problem = (
    await call("/v1/problems", {
      title: "Exact elementary integer identities",
      statement: "The square of every odd integer has residue one modulo eight.",
      falsifier: "An odd integer whose square has a different residue modulo eight.",
      motivation: "Publish reviewed private calculations together with their session handback.",
      areas: ["number-theory"],
    }, author, 201)
  ).problem.id;
  await sponsorCall(sponsor, "POST", `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle", { action: "publish" });
  const reviewSession = (
    await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
  ).session_id;
  await call(`/v1/problems/${problem}/statement-review`, {
    session_id: reviewSession, statement_version: 1, verdict: "statement-clear",
    basis: "The integer domain, residue predicate, and counterexample condition are explicit.",
  }, reviewer);
  await call(`/v1/sessions/${reviewSession}/close`, {
    handback: "The problem has an exact statement.",
  }, reviewer, 201);

  const open = async (token = author) => (
    await call("/v1/sessions", { problem_id: problem, intent: "explore" }, token, 201)
  ).session_id;
  const privateCanary = "PRIVATE_CLOSE_CANARY: these working notes are not public claim prose.";
  const privateBody = `${privateCanary}\n${"Record a private residue calculation and its boundary cases.\n".repeat(40)}`;
  const publication = (statement, falsifier, dependsOn = []) => ({
    kind: "conjecture", statement, falsifier, depends_on: dependsOn, relates_to: [],
  });
  const push = async (session, payload, title, token = author) =>
    WorkshopPushResponseSchema.parse(await call(`/v1/sessions/${session}/workshop`, {
      type: payload ? "claim-draft" : "scratch",
      title, body_md: privateBody,
      ...(payload ? { ledger_intent: { kind: "create", target_kind: "claim" }, publication: payload } : {}),
    }, token, 201));
  const rows = async (sql, ...bindings) =>
    (await env.DB.prepare(sql).bind(...bindings).all()).results;
  const one = (sql, ...bindings) => env.DB.prepare(sql).bind(...bindings).first();
  const scalar = async (sql, ...bindings) => (await one(sql, ...bindings)).n;
  const head = (draft) => one(
    "SELECT * FROM workshop_objects WHERE workshop_id = ?", draft.workshop_id,
  );
  const history = (draft) => rows(
    "SELECT * FROM workshop_revisions WHERE workshop_id = ? ORDER BY version", draft.workshop_id,
  );
  const closeState = (session) => one(
    "SELECT session_id, fellow_id, closed_at, handback, close_keep_json, close_discard_json FROM sessions WHERE session_id = ?",
    session,
  );
  const privateState = async (session) => ({
    session: await closeState(session),
    heads: await rows("SELECT * FROM workshop_objects WHERE problem_id = ? ORDER BY workshop_id", problem),
    revisions: await rows(
      "SELECT * FROM workshop_revisions WHERE problem_id = ? ORDER BY workshop_id, version", problem,
    ),
    leases: await rows(
      "SELECT lease_id, status, released_at, released_by, updated_at FROM leases WHERE session_id = ? ORDER BY lease_id",
      session,
    ),
  });
  const publicState = async () => {
    const tables = {};
    for (const table of [
      "events", "claims", "claim_versions", "claim_projections", "claim_deps",
      "integrity_checkpoints", "idempotency",
    ]) {
      tables[table] = await scalar(`SELECT COUNT(*) AS n FROM ${table} WHERE problem_id = ?`, problem);
    }
    tables.event_content = await scalar(
      "SELECT COUNT(*) AS n FROM event_content c JOIN events e ON e.id = c.event_id WHERE e.problem_id = ?",
      problem,
    );
    tables.screening_publications = await scalar(
      "SELECT COUNT(*) AS n FROM screening_publications p JOIN events e ON e.id = p.event_id WHERE e.problem_id = ?",
      problem,
    );
    return {
      tables,
      head: await one("SELECT public_seq, chain_digest FROM problems WHERE id = ?", problem),
      cursor: await scalar("SELECT cursor AS n FROM public_cursor WHERE singleton = 1"),
      // Delivery is asynchronous. Compare immutable outbox identities, not delivery timestamps.
      outbox: await rows(
        "SELECT id, event_id, problem_id, kind, dedupe_key, payload_sha256, created_at FROM outbox WHERE problem_id = ? ORDER BY id",
        problem,
      ),
    };
  };
  const attempt = async (session, key, body, token = author) => {
    const response = await worker.fetch(`${origin}/v1/sessions/${session}/close`, {
      method: "POST",
      headers: {
        "User-Agent": userAgent, authorization: `Bearer ${token}`,
        "content-type": "application/json", "idempotency-key": key,
      },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    const parsed = JSON.parse(raw);
    assert.ok(response.headers.get("cache-control")?.includes("no-store"));
    if (response.status === 200 || response.status === 201) {
      SessionCloseResponseSchema.parse(parsed);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    } else if (response.status === 403 && parsed.code === "POLICY_DENIED") {
      ScreeningPromotionDeniedResponseSchema.parse(parsed);
      assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
    } else {
      assert.match(response.headers.get("content-type") ?? "", /^application\/problem\+json\b/);
      assert.equal(typeof parsed.code, "string");
    }
    return { status: response.status, raw, body: parsed };
  };
  const waitForScreens = async (target) => {
    const deadline = Date.now() + 15_000;
    while ((await fixtures.screeningCalls()) < target && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(await fixtures.screeningCalls(), target, "the intended screening boundary was reached");
  };
  const retainBytes = async (draft, before, action, state, eventId = null) => {
    const after = await history(draft);
    assert.equal(after.length, before.length + 1, "one immutable revision records this close action");
    assert.deepEqual(after.slice(0, -1), before, "the selected historical bytes remain immutable");
    const original = before.at(-1);
    const revision = after.at(-1);
    const current = await head(draft);
    assert.equal(revision.version, original.version + 1);
    assert.equal(current.current_version, revision.version);
    assert.equal(current.state, state);
    assert.equal(revision.revise_action, action);
    assert.equal(revision.publication_event_id, eventId);
    assert.equal(revision.acting_sponsor_id, null, "a Fellow close does not fabricate a sponsor action");
    for (const field of [
      "problem_id", "fellow_id", "session_id", "type", "title", "body_md", "cas_hash",
      "relates_to_json", "ledger_intent_json", "revision_json", "publication_json",
    ]) {
      assert.equal(revision[field], original[field], `archive preserves ${field}`);
      assert.equal(current[field], original[field], `head preserves ${field}`);
    }
    assert.match(revision.cas_hash, /^sha256:[a-f0-9]{64}$/);
    const key = `cas/sha256/${revision.cas_hash.slice("sha256:".length)}`;
    const stored = await env.ARTIFACTS.get(key);
    assert.ok(stored, "the real private R2 body remains readable");
    assert.equal(await stored.text(), privateBody);
    assert.equal(
      await env.PUBLIC_ARTIFACTS.get(key), null,
      "publishing the typed claim does not copy its private notes to public R2",
    );
  };
  const assertPublished = async (session, request, selected, before, result) => {
    assert.equal(result.status, 201);
    assert.equal(result.body.session_id, session);
    assert.equal(result.body.promoted.length, selected.length);
    assert.equal(new Set(result.body.promoted).size, selected.length);
    const state = await closeState(session);
    assert.equal(state.closed_at, result.body.closed_at);
    assert.equal(state.handback, request.handback);
    assert.deepEqual(JSON.parse(state.close_keep_json), request.keep ?? []);
    assert.deepEqual(JSON.parse(state.close_discard_json), request.discard ?? []);
    const events = await rows(
      `SELECT e.*, c.payload_json FROM events e JOIN event_content c ON c.event_id = e.id
       WHERE e.problem_id = ? AND e.seq > ? ORDER BY e.seq`,
      problem, before.head.public_seq,
    );
    assert.equal(events.length, selected.length, "one claim event per promotion and no wrapper event");
    assert.deepEqual(events.map((event) => event.object_id), result.body.promoted);
    for (const [index, event] of events.entries()) {
      const item = selected[index];
      const source = JSON.parse(item.before.at(-1).publication_json);
      assert.equal(event.type, "claim.created");
      assert.equal(event.object_kind, "claim");
      assert.equal(event.object_version, 1);
      assert.equal(event.seq, before.head.public_seq + index + 1);
      assert.equal(event.actor_session_id, session);
      assert.equal(event.actor_fellow_id, state.fellow_id);
      assert.equal(event.actor_sponsor_id, sponsor);
      assert.equal(event.model_string_self_declared, "synthetic-problem-model");
      assert.equal(event.harness, "local-problem-lifecycle-proof");
      assert.ok(event.writer_credential_id, "the actual Fellow credential owns the publication");
      const credential = await one(
        "SELECT fellow_id FROM fellow_tokens WHERE credential_id = ?", event.writer_credential_id,
      );
      assert.equal(credential.fellow_id, state.fellow_id);
      assert.equal(createHash("sha256").update(event.payload_json).digest("hex"), event.payload_sha256);
      const payload = JSON.parse(event.payload_json);
      assert.equal(payload.statement, source.statement);
      assert.equal(payload.falsifier, source.falsifier);
      assert.equal(payload.sponsor_promotion, undefined);
      assert.ok(!event.payload_json.includes(privateCanary));
      assert.ok(!event.payload_json.includes(item.draft.workshop_id));
      assert.ok(!event.payload_json.includes(request.handback));
      const version = await one(
        "SELECT kind, statement, falsifier, editor_fellow_id FROM claim_versions WHERE problem_id = ? AND claim_id = ? AND version = 1",
        problem, event.object_id,
      );
      assert.deepEqual(version, {
        kind: source.kind, statement: source.statement, falsifier: source.falsifier,
        editor_fellow_id: state.fellow_id,
      });
      assert.equal(await scalar(
        "SELECT COUNT(*) AS n FROM outbox WHERE event_id = ? AND problem_id = ? AND kind = 'search.index' AND dedupe_key = ? AND payload_sha256 = ?",
        event.id, problem, `search.index:${event.id}`, event.payload_sha256,
      ), 1, "the same transaction supplied the exact durable search outbox witness");
      await retainBytes(item.draft, item.before, "archive", "archived", event.id);
      const face = ClaimFaceResponseSchema.parse(
        await call(`/p/${problem}/claims/${event.object_id}@1.json`),
      );
      assert.equal(face.claim_state.claim_id, event.object_id);
      assert.equal(face.claim_state.version, 1);
      assert.ok(face.items.find((entry) => entry.kind === "claim-detail")?.body.includes(source.statement));
      assert.ok(!JSON.stringify(face).includes(privateCanary));
      assert.ok(!JSON.stringify(face).includes(item.draft.workshop_id));
    }
    const after = await publicState();
    for (const table of ["events", "claims", "claim_versions", "event_content", "screening_publications"]) {
      assert.equal(after.tables[table], before.tables[table] + selected.length, table);
    }
    assert.equal(after.cursor, before.cursor + selected.length);
    assert.equal(after.head.public_seq, before.head.public_seq + selected.length);
    return events;
  };
  const assertReplay = async (session, key, request, initial) => {
    const beforePublic = await publicState();
    const beforePrivate = await privateState(session);
    const beforeScreens = await fixtures.screeningCalls();
    const replay = await attempt(session, key, request);
    assert.equal(replay.status, 200);
    assert.equal(replay.raw, initial.raw, "a closed session replays the exact sealed response bytes");
    const conflict = await attempt(session, key, { ...request, handback: "A different close intent." });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");
    assert.deepEqual(await publicState(), beforePublic);
    assert.deepEqual(await privateState(session), beforePrivate);
    assert.equal(await fixtures.screeningCalls(), beforeScreens, "replay never spends screening again");
    const state = await closeState(session);
    const sealed = await one(
      "SELECT response_ciphertext, response_initialization_vector FROM session_write_replays WHERE scope = 'session_close' AND principal_scope = ? AND idempotency_key = ?",
      state.fellow_id, key,
    );
    assert.ok(sealed?.response_ciphertext);
    assert.ok(sealed.response_initialization_vector);
    assert.notEqual(sealed.response_ciphertext, initial.raw);
    assert.ok(!sealed.response_ciphertext.includes(request.handback));
  };

  // Single promotion crosses the private R2 spill threshold through the real workshop route.
  const singleSession = await open();
  const oddSquare = publication(
    "The square of an odd integer has residue one modulo eight.",
    "An odd integer whose square has a residue other than one modulo eight.",
  );
  const singleDraft = await push(singleSession, oddSquare, "Odd square calculation");
  const singleHistory = await history(singleDraft);
  assert.ok((await head(singleDraft)).cas_hash, "the fixture exercises real R2, not only inline D1 text");
  const singleRequest = {
    handback: "CLOSE_HANDBACK_SINGLE: check the residue calculation independently.",
    promote: [singleDraft.workshop_id],
  };
  const singleBefore = await publicState();
  const singleScreens = await fixtures.screeningCalls();
  const single = await attempt(singleSession, "close-single", singleRequest);
  await assertPublished(singleSession, singleRequest, [
    { draft: singleDraft, before: singleHistory },
  ], singleBefore, single);
  assert.equal(await fixtures.screeningCalls(), singleScreens + 1);
  await assertReplay(singleSession, "close-single", singleRequest, single);
  const closed = await attempt(singleSession, "close-single-new-key", singleRequest);
  assert.equal(closed.status, 409);
  assert.equal(closed.body.code, "SESSION_CLOSED");

  // Keep, discard, public claims, source archival, handback and lease release share one close.
  const multiSession = await open();
  const sumDraft = await push(multiSession, publication(
    "The sum of the first n positive integers equals n times n plus one divided by two.",
    "A positive integer n whose first n positive integers have a different sum.",
  ), "Finite sum identity");
  const tripleDraft = await push(multiSession, publication(
    "Among any three consecutive integers, exactly one is divisible by three.",
    "Three consecutive integers with zero or at least two multiples of three.",
    [single.body.promoted[0]],
  ), "Three consecutive residues");
  const kept = await push(multiSession, null, "Retain private boundary notes");
  const discarded = await push(multiSession, null, "Discard superseded private notes");
  const selections = await Promise.all([sumDraft, tripleDraft].map(async (draft) => ({
    draft, before: await history(draft),
  })));
  const keptHistory = await history(kept);
  const discardedHistory = await history(discarded);
  const acquired = LeaseAcquireResponseSchema.parse(await call(`/v1/sessions/${multiSession}/leases`, {
    object: single.body.promoted[0],
    objective: "Check the odd-square boundary", deliverable: "A bounded independent residue calculation",
    ttl_seconds: 1800,
  }, author, 201));
  const multiRequest = {
    handback: "CLOSE_HANDBACK_MULTI: the two selected calculations are ready for independent review.",
    promote: selections.map((item) => item.draft.workshop_id),
    keep: [kept.workshop_id], discard: [discarded.workshop_id],
  };
  const multiBefore = await publicState();
  const multiScreens = await fixtures.screeningCalls();
  const multi = await attempt(multiSession, "close-multiple", multiRequest);
  await assertPublished(multiSession, multiRequest, selections, multiBefore, multi);
  assert.equal(await fixtures.screeningCalls(), multiScreens + 2);
  await retainBytes(kept, keptHistory, "keep", "open");
  await retainBytes(discarded, discardedHistory, "discard", "discarded");
  const lease = await one("SELECT * FROM leases WHERE lease_id = ?", acquired.lease.lease_id);
  assert.equal(lease.status, "released");
  assert.equal(lease.released_at, multi.body.closed_at);
  assert.equal(lease.released_by, (await closeState(multiSession)).fellow_id);
  assert.equal(
    (await publicState()).tables.claim_deps, multiBefore.tables.claim_deps + 1,
    "the ordinary exact dependency writer runs inside close",
  );
  await assertReplay(multiSession, "close-multiple", multiRequest, multi);

  // Rejected closes must preserve all private heads, the open session and its active lease.
  const failedSession = await open();
  const goodFirst = await push(failedSession, publication(
    "Every positive divisor of a prime number is either one or that prime number.",
    "A prime number with a positive divisor distinct from one and itself.",
  ), "Prime divisor boundary");
  const goodLast = await push(failedSession, publication(
    "The product of two integers each congruent to one modulo four is congruent to one modulo four.",
    "Two integers each congruent to one modulo four whose product has a different residue.",
  ), "Product residue boundary");
  const failureKeep = await push(failedSession, null, "Keep only if the close succeeds");
  const failureDiscard = await push(failedSession, null, "Discard only if the close succeeds");
  await call(`/v1/sessions/${failedSession}/leases`, {
    object: single.body.promoted[0], objective: "Inspect the remaining residue argument",
    deliverable: "A concrete independent check", ttl_seconds: 1800,
  }, author, 201);
  const baseRequest = {
    handback: "CLOSE_HANDBACK_REFUSAL: this must remain uncommitted on refusal.",
    promote: [goodFirst.workshop_id, goodLast.workshop_id],
    keep: [failureKeep.workshop_id], discard: [failureDiscard.workshop_id],
  };
  const foreignSession = await open(reviewer);
  const foreign = await push(foreignSession, publication(
    "The greatest common divisor of consecutive positive integers is one.",
    "Consecutive positive integers sharing a divisor greater than one.",
  ), "Another Fellow's private draft", reviewer);
  const fellow = (await closeState(failedSession)).fellow_id;
  const invalidBefore = { public: await publicState(), private: await privateState(failedSession) };
  const invalidScreens = await fixtures.screeningCalls();
  let invalidNumber = 0;
  for (const id of [foreign.workshop_id, `W-${"Z".repeat(26)}`]) {
    for (const action of ["promote", "keep", "discard"]) {
      const key = `close-invalid-${++invalidNumber}`;
      const refused = await attempt(failedSession, key, { ...baseRequest, [action]: [id] });
      assert.equal(refused.status, 404);
      assert.equal(refused.body.code, "WORKSHOP_OBJECT_NOT_FOUND");
      assert.equal(await scalar(
        "SELECT COUNT(*) AS n FROM session_write_replays WHERE scope = 'session_close' AND principal_scope = ? AND idempotency_key = ?",
        fellow, key,
      ), 0, "foreign and nonexistent selections are refused before reserving a close identity");
    }
  }
  const duplicateKey = "close-duplicate-selection";
  const duplicateSelection = await attempt(failedSession, duplicateKey, {
    ...baseRequest, keep: [goodFirst.workshop_id],
  });
  assert.equal(duplicateSelection.status, 422);
  assert.equal(duplicateSelection.body.code, "SESSION_CLOSE_BODY_INVALID");
  assert.equal(await scalar(
    "SELECT COUNT(*) AS n FROM session_write_replays WHERE scope = 'session_close' AND principal_scope = ? AND idempotency_key = ?",
    fellow, duplicateKey,
  ), 0);
  assert.equal(await fixtures.screeningCalls(), invalidScreens);
  assert.deepEqual(await publicState(), invalidBefore.public);
  assert.deepEqual(await privateState(failedSession), invalidBefore.private);

  const missingFalsifier = await push(failedSession, {
    kind: "conjecture", statement: "A nonempty finite set of integers has a greatest element.",
  }, "Incomplete public falsifier");
  const duplicateClaim = await push(failedSession, oddSquare, "Already published residue statement");
  const badDependency = await push(failedSession, publication(
    "Every integer divisible by six is divisible by both two and three.",
    "An integer divisible by six that is not divisible by two or not divisible by three.",
    ["C-999999"],
  ), "Unavailable dependency");
  for (const [draft, status, code] of [
    [missingFalsifier, 422, "MISSING_FALSIFIER"],
    [duplicateClaim, 409, "DUPLICATE_CLAIM"],
    [badDependency, 422, "DEPENDENCY_NOT_FOUND"],
  ]) {
    const beforePublic = await publicState();
    const beforePrivate = await privateState(failedSession);
    const screens = await fixtures.screeningCalls();
    const refused = await attempt(failedSession, `close-later-${code}`, {
      ...baseRequest, promote: [goodFirst.workshop_id, draft.workshop_id],
    });
    assert.equal(refused.status, status);
    assert.equal(refused.body.code, code);
    assert.equal(await fixtures.screeningCalls(), screens, "all content validates before any member screens");
    assert.deepEqual(await publicState(), beforePublic, "the valid first draft left no public prefix");
    assert.deepEqual(await privateState(failedSession), beforePrivate, "no archive, keep, discard or close");
  }

  // The first screening has passed when the second is held. A later policy refusal aborts all work.
  const policyBefore = { public: await publicState(), private: await privateState(failedSession) };
  const policyScreens = await fixtures.screeningCalls();
  await fixtures.pauseScreening(2000);
  let policyPending;
  let policyRefusal;
  try {
    policyPending = attempt(failedSession, "close-late-policy", baseRequest);
    await waitForScreens(policyScreens + 2);
    await fixtures.setScreenMode("reject");
    policyRefusal = await policyPending;
  } finally {
    await fixtures.resumeScreening();
    if (policyPending) await Promise.allSettled([policyPending]);
    await fixtures.setScreenMode("pass");
  }
  assert.equal(policyRefusal.status, 403);
  assert.equal(policyRefusal.body.code, "POLICY_DENIED");
  assert.deepEqual(await publicState(), policyBefore.public);
  assert.deepEqual(await privateState(failedSession), policyBefore.private);

  // A real concurrent private revision changes the pinned last source after screening starts.
  // It is the only permitted mutation: the close must not archive the earlier source or close.
  const raceBeforePublic = await publicState();
  const raceFirstHistory = await history(goodFirst);
  const raceLastHistory = await history(goodLast);
  const changedPublication = publication(
    "The product of two integers each congruent to three modulo four is congruent to one modulo four.",
    "Two integers each congruent to three modulo four whose product has a different residue.",
  );
  const raceScreens = await fixtures.screeningCalls();
  await fixtures.pauseScreening(4000);
  let racePending;
  let raceRefusal;
  let afterConcurrentEdit;
  try {
    racePending = attempt(failedSession, "close-source-changed", baseRequest);
    await waitForScreens(raceScreens + 1);
    const revised = WorkshopPushResponseSchema.parse(await call(`/v1/sessions/${failedSession}/workshop`, {
      workshop_id: goodLast.workshop_id, base_version: goodLast.version,
      publication: changedPublication,
    }, author, 201));
    assert.equal(revised.version, goodLast.version + 1);
    afterConcurrentEdit = await privateState(failedSession);
    await fixtures.resumeScreening();
    raceRefusal = await racePending;
  } finally {
    await fixtures.resumeScreening();
    if (racePending) await Promise.allSettled([racePending]);
  }
  assert.equal(raceRefusal.status, 409);
  assert.equal(raceRefusal.body.code, "WORKSHOP_VERSION_CONFLICT");
  assert.deepEqual(await publicState(), raceBeforePublic);
  assert.deepEqual(await privateState(failedSession), afterConcurrentEdit);
  assert.deepEqual(await history(goodFirst), raceFirstHistory);
  assert.deepEqual((await history(goodLast)).slice(0, -1), raceLastHistory);
  assert.equal((await head(goodLast)).state, "open");
  assert.equal((await closeState(failedSession)).closed_at, null);
  assert.ok((await privateState(failedSession)).leases.every((item) => item.status === "active"));

  const changedReplayScreens = await fixtures.screeningCalls();
  const staleIntent = await attempt(failedSession, "close-source-changed", baseRequest);
  assert.equal(staleIntent.status, 409);
  assert.equal(staleIntent.body.code, "WORKSHOP_VERSION_CONFLICT");
  assert.equal(await fixtures.screeningCalls(), changedReplayScreens, "a pinned retry does not screen a replacement source");
  assert.deepEqual(await publicState(), raceBeforePublic);
  assert.deepEqual(await privateState(failedSession), afterConcurrentEdit);

  // A fresh identity after reviewing the new source completes the same user journey.
  const finalSelections = await Promise.all([goodFirst, goodLast].map(async (draft) => ({
    draft, before: await history(draft),
  })));
  const finalKeepHistory = await history(failureKeep);
  const finalDiscardHistory = await history(failureDiscard);
  const finalBefore = await publicState();
  const finalRequest = {
    ...baseRequest,
    handback: "CLOSE_HANDBACK_REVIEWED: the changed residue calculation is ready for review.",
  };
  const finalClose = await attempt(failedSession, "close-after-review", finalRequest);
  await assertPublished(failedSession, finalRequest, finalSelections, finalBefore, finalClose);
  await retainBytes(failureKeep, finalKeepHistory, "keep", "open");
  await retainBytes(failureDiscard, finalDiscardHistory, "discard", "discarded");
  assert.ok((await privateState(failedSession)).leases.every(
    (item) => item.status === "released" && item.released_at === finalClose.body.closed_at,
  ));
  await assertReplay(failedSession, "close-after-review", finalRequest, finalClose);
  return {
    single_and_multiple_claims: true,
    private_r2_source_and_immutable_archive: true,
    exact_claim_versions_and_fellow_provenance: true,
    keep_discard_handback_and_lease_atomicity: true,
    encrypted_exact_replay_after_closure: true,
    foreign_selection_before_reservation: true,
    later_content_and_policy_refusals: true,
    concurrent_source_revision_rollback: true,
    fresh_identity_after_source_review: true,
  };
});

console.log(JSON.stringify({ stage: "session-close-publications-journey-passed", status: "pass", receipt }));
