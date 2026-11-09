import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ClaimFaceResponseSchema,
  LeaseAcquireResponseSchema,
  ScreeningPromotionDeniedResponseSchema,
  SessionCloseResponseSchema,
  WorkshopObjectResponseSchema,
  WorkshopPushResponseSchema,
} from "@asimposium/contracts";
import {
  WorkshopDirectoryResponseSchema,
  workshopDirectoryMatchesQuery,
  workshopDirectoryPath,
} from "@asimposium/contracts/workshop-directory";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Enrollment approval and classifier observations use the existing fixture seam.
// HTTP authorization, D1 transactions, private R2, immutable history, outbox and
// the harness's final production projection replay all use genuine Workerd bindings.
assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

const receipt = await runLocalWorkerJourney(async function sessionClosePublicationsJourney({
  call,
  enroll,
  sponsorCall,
  env,
  fixtures,
  worker,
  origin,
  userAgent,
}) {
  const sponsor = "usr_close_publications_author";
  const author = await enroll("close-publications-author", sponsor);
  const reviewer = await enroll("close-publications-reviewer", "usr_close_publications_reviewer");
  const problem = (
    await call(
      "/v1/problems",
      {
        title: "Exact elementary integer identities",
        statement: "The square of every odd integer has residue one modulo eight.",
        falsifier: "An odd integer whose square has a different residue modulo eight.",
        motivation: "Publish reviewed private calculations together with their session handback.",
        areas: ["number-theory"],
      },
      author,
      201,
    )
  ).problem.id;
  await sponsorCall(
    sponsor,
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
  );
  const reviewSession = (
    await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
  ).session_id;
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: reviewSession,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "The integer domain, residue predicate, and counterexample condition are explicit.",
    },
    reviewer,
  );
  await call(
    `/v1/sessions/${reviewSession}/close`,
    {
      handback: "The problem has an exact statement.",
    },
    reviewer,
    201,
  );

  const open = async (token = author) =>
    (await call("/v1/sessions", { problem_id: problem, intent: "explore" }, token, 201)).session_id;
  const privateCanary = "PRIVATE_CLOSE_CANARY: these working notes are not public claim prose.";
  const privateBody = `${privateCanary}\n${"Record a private residue calculation and its boundary cases.\n".repeat(40)}`;
  const publication = (statement, falsifier, dependsOn = []) => ({
    kind: "conjecture",
    statement,
    falsifier,
    depends_on: dependsOn,
    relates_to: [],
  });
  const push = async (session, payload, title, token = author) =>
    WorkshopPushResponseSchema.parse(
      await call(
        `/v1/sessions/${session}/workshop`,
        {
          type: payload ? "claim-draft" : "scratch",
          title,
          body_md: privateBody,
          ...(payload
            ? { ledger_intent: { kind: "create", target_kind: "claim" }, publication: payload }
            : {}),
        },
        token,
        201,
      ),
    );
  const rows = async (sql, ...bindings) =>
    (
      await env.DB.prepare(sql)
        .bind(...bindings)
        .all()
    ).results;
  const one = (sql, ...bindings) =>
    env.DB.prepare(sql)
      .bind(...bindings)
      .first();
  const scalar = async (sql, ...bindings) => (await one(sql, ...bindings)).n;
  const head = (draft) =>
    one("SELECT * FROM workshop_objects WHERE workshop_id = ?", draft.workshop_id);
  const history = (draft) =>
    rows(
      "SELECT * FROM workshop_revisions WHERE workshop_id = ? ORDER BY version",
      draft.workshop_id,
    );
  const closeState = (session) =>
    one(
      "SELECT session_id, fellow_id, closed_at, handback, close_keep_json, close_discard_json FROM sessions WHERE session_id = ?",
      session,
    );
  const privateState = async (session) => ({
    session: await closeState(session),
    heads: await rows(
      "SELECT * FROM workshop_objects WHERE problem_id = ? ORDER BY workshop_id",
      problem,
    ),
    revisions: await rows(
      "SELECT * FROM workshop_revisions WHERE problem_id = ? ORDER BY workshop_id, version",
      problem,
    ),
    leases: await rows(
      "SELECT lease_id, status, released_at, released_by, updated_at FROM leases WHERE session_id = ? ORDER BY lease_id",
      session,
    ),
  });
  const publicState = async () => {
    const tables = {};
    for (const table of [
      "events",
      "claims",
      "claim_versions",
      "claim_projections",
      "claim_deps",
      "integrity_checkpoints",
      "idempotency",
    ]) {
      tables[table] = await scalar(
        `SELECT COUNT(*) AS n FROM ${table} WHERE problem_id = ?`,
        problem,
      );
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
        "User-Agent": userAgent,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
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
    assert.equal(
      await fixtures.screeningCalls(),
      target,
      "the intended screening boundary was reached",
    );
  };
  const retainBytes = async (
    draft,
    before,
    action,
    state,
    eventId = null,
    sessionAttribution = null,
  ) => {
    const after = await history(draft);
    assert.equal(
      after.length,
      before.length + 1,
      "one immutable revision records this close action",
    );
    assert.deepEqual(after.slice(0, -1), before, "the selected historical bytes remain immutable");
    const original = before.at(-1);
    const revision = after.at(-1);
    const current = await head(draft);
    assert.equal(revision.version, original.version + 1);
    assert.equal(current.current_version, revision.version);
    assert.equal(current.state, state);
    assert.equal(revision.revise_action, action);
    assert.equal(revision.publication_event_id, eventId);
    assert.equal(
      revision.acting_sponsor_id,
      null,
      "a Fellow close does not fabricate a sponsor action",
    );
    for (const field of [
      "problem_id",
      "fellow_id",
      "session_id",
      "type",
      "title",
      "body_md",
      "cas_hash",
      "relates_to_json",
      "ledger_intent_json",
      "revision_json",
      "publication_json",
    ]) {
      // A resumed action belongs to its current session; the head still
      // names the originating session and every prior revision is unchanged.
      const revisionValue =
        field === "session_id" && sessionAttribution
          ? sessionAttribution.actingSession
          : original[field];
      const headValue =
        field === "session_id" && sessionAttribution
          ? sessionAttribution.originSession
          : original[field];
      assert.equal(revision[field], revisionValue, `archive preserves ${field}`);
      assert.equal(current[field], headValue, `head preserves ${field}`);
    }
    assert.match(revision.cas_hash, /^sha256:[a-f0-9]{64}$/);
    const key = `cas/sha256/${revision.cas_hash.slice("sha256:".length)}`;
    const stored = await env.ARTIFACTS.get(key);
    assert.ok(stored, "the real private R2 body remains readable");
    assert.equal(await stored.text(), privateBody);
    assert.equal(
      await env.PUBLIC_ARTIFACTS.get(key),
      null,
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
      problem,
      before.head.public_seq,
    );
    assert.equal(
      events.length,
      selected.length,
      "one claim event per promotion and no wrapper event",
    );
    assert.deepEqual(
      events.map((event) => event.object_id),
      result.body.promoted,
    );
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
        "SELECT fellow_id FROM fellow_tokens WHERE credential_id = ?",
        event.writer_credential_id,
      );
      assert.equal(credential.fellow_id, state.fellow_id);
      assert.equal(
        createHash("sha256").update(event.payload_json).digest("hex"),
        event.payload_sha256,
      );
      const payload = JSON.parse(event.payload_json);
      assert.equal(payload.statement, source.statement);
      assert.equal(payload.falsifier, source.falsifier);
      assert.equal(payload.sponsor_promotion, undefined);
      assert.ok(!event.payload_json.includes(privateCanary));
      assert.ok(!event.payload_json.includes(item.draft.workshop_id));
      assert.ok(!event.payload_json.includes(request.handback));
      const version = await one(
        "SELECT kind, statement, falsifier, editor_fellow_id FROM claim_versions WHERE problem_id = ? AND claim_id = ? AND version = 1",
        problem,
        event.object_id,
      );
      assert.deepEqual(version, {
        kind: source.kind,
        statement: source.statement,
        falsifier: source.falsifier,
        editor_fellow_id: state.fellow_id,
      });
      assert.equal(
        await scalar(
          "SELECT COUNT(*) AS n FROM outbox WHERE event_id = ? AND problem_id = ? AND kind = 'search.index' AND dedupe_key = ? AND payload_sha256 = ?",
          event.id,
          problem,
          `search.index:${event.id}`,
          event.payload_sha256,
        ),
        1,
        "the same transaction supplied the exact durable search outbox witness",
      );
      await retainBytes(item.draft, item.before, "archive", "archived", event.id, item.sessions);
      const face = ClaimFaceResponseSchema.parse(
        await call(`/p/${problem}/claims/${event.object_id}@1.json`),
      );
      assert.equal(face.claim_state.claim_id, event.object_id);
      assert.equal(face.claim_state.version, 1);
      assert.ok(
        face.items.find((entry) => entry.kind === "claim-detail")?.body.includes(source.statement),
      );
      assert.ok(!JSON.stringify(face).includes(privateCanary));
      assert.ok(!JSON.stringify(face).includes(item.draft.workshop_id));
    }
    const after = await publicState();
    for (const table of [
      "events",
      "claims",
      "claim_versions",
      "event_content",
      "screening_publications",
    ]) {
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
    assert.equal(
      replay.raw,
      initial.raw,
      "a closed session replays the exact sealed response bytes",
    );
    const conflict = await attempt(session, key, {
      ...request,
      handback: "A different close intent.",
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");
    assert.deepEqual(await publicState(), beforePublic);
    assert.deepEqual(await privateState(session), beforePrivate);
    assert.equal(
      await fixtures.screeningCalls(),
      beforeScreens,
      "replay never spends screening again",
    );
    const state = await closeState(session);
    const sealed = await one(
      "SELECT response_ciphertext, response_initialization_vector FROM session_write_replays WHERE scope = 'session_close' AND principal_scope = ? AND idempotency_key = ?",
      state.fellow_id,
      key,
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
  assert.ok(
    (await head(singleDraft)).cas_hash,
    "the fixture exercises real R2, not only inline D1 text",
  );
  const singleRequest = {
    handback: "CLOSE_HANDBACK_SINGLE: check the residue calculation independently.",
    promote: [singleDraft.workshop_id],
  };
  const singleBefore = await publicState();
  const singleScreens = await fixtures.screeningCalls();
  const single = await attempt(singleSession, "close-single", singleRequest);
  await assertPublished(
    singleSession,
    singleRequest,
    [{ draft: singleDraft, before: singleHistory }],
    singleBefore,
    single,
  );
  assert.equal(await fixtures.screeningCalls(), singleScreens + 1);
  await assertReplay(singleSession, "close-single", singleRequest, single);
  const closed = await attempt(singleSession, "close-single-new-key", singleRequest);
  assert.equal(closed.status, 409);
  assert.equal(closed.body.code, "SESSION_CLOSED");

  // Keep, discard, public claims, source archival, handback and lease release share one close.
  const multiSession = await open();
  const sumDraft = await push(
    multiSession,
    publication(
      "The sum of the first n positive integers equals n times n plus one divided by two.",
      "A positive integer n whose first n positive integers have a different sum.",
    ),
    "Finite sum identity",
  );
  const tripleDraft = await push(
    multiSession,
    publication(
      "Among any three consecutive integers, exactly one is divisible by three.",
      "Three consecutive integers with zero or at least two multiples of three.",
      [single.body.promoted[0]],
    ),
    "Three consecutive residues",
  );
  const kept = await push(multiSession, null, "Retain private boundary notes");
  const discarded = await push(multiSession, null, "Discard superseded private notes");
  const selections = await Promise.all(
    [sumDraft, tripleDraft].map(async (draft) => ({
      draft,
      before: await history(draft),
    })),
  );
  const keptHistory = await history(kept);
  const discardedHistory = await history(discarded);
  const acquired = LeaseAcquireResponseSchema.parse(
    await call(
      `/v1/sessions/${multiSession}/leases`,
      {
        object: single.body.promoted[0],
        objective: "Check the odd-square boundary",
        deliverable: "A bounded independent residue calculation",
        ttl_seconds: 1800,
      },
      author,
      201,
    ),
  );
  const multiRequest = {
    handback:
      "CLOSE_HANDBACK_MULTI: the two selected calculations are ready for independent review.",
    promote: selections.map((item) => item.draft.workshop_id),
    keep: [kept.workshop_id],
    discard: [discarded.workshop_id],
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
    (await publicState()).tables.claim_deps,
    multiBefore.tables.claim_deps + 1,
    "the ordinary exact dependency writer runs inside close",
  );
  await assertReplay(multiSession, "close-multiple", multiRequest, multi);

  // A saved public replacement and a new claim share the same real close transaction.
  const pushReplacement = async (session, replacement) =>
    WorkshopPushResponseSchema.parse(
      await call(
        `/v1/sessions/${session}/workshop`,
        {
          type: "claim-draft",
          title: "Private saved replacement",
          body_md: privateBody,
          ledger_intent: {
            kind: "revise",
            target_id: replacement.claim_id,
            base_version: replacement.base_version,
          },
          revision: replacement,
        },
        author,
        201,
      ),
    );
  const replacement = {
    claim_id: multi.body.promoted[1],
    base_version: 1,
    kind: "conjecture",
    statement: "For every integer k, exactly one of k, k + 1 and k + 2 is divisible by 3.",
    falsifier: "An integer k whose three consecutive values contain zero or two multiples of 3.",
    depends_on: [single.body.promoted[0]],
  };
  const mixedSession = await open();
  const replacementDraft = await pushReplacement(mixedSession, replacement);
  const companion = await push(
    mixedSession,
    publication(
      "The product of any three consecutive integers is divisible by six.",
      "Three consecutive integers whose product is not divisible by six.",
      [multi.body.promoted[0]],
    ),
    "Consecutive product calculation",
  );
  const mixedHistory = await Promise.all([history(replacementDraft), history(companion)]);
  const oldVersion = await one(
    "SELECT * FROM claim_versions WHERE problem_id = ? AND claim_id = ? AND version = 1",
    problem,
    replacement.claim_id,
  );
  const mixedBefore = await publicState();
  const mixedScreens = await fixtures.screeningCalls();
  const mixedRequest = {
    handback: "CLOSE_HANDBACK_MIXED: review the exact replacement and companion claim.",
    promote: [replacementDraft.workshop_id, companion.workshop_id],
  };
  const mixed = await attempt(mixedSession, "close-mixed-replacement", mixedRequest);
  assert.equal(mixed.status, 201);
  assert.equal(mixed.body.promoted.length, 2);
  assert.equal(mixed.body.promoted[0], replacement.claim_id);
  const mixedEvents = await rows(
    `SELECT e.*, c.payload_json FROM events e JOIN event_content c ON c.event_id = e.id
     WHERE e.problem_id = ? AND e.seq > ? ORDER BY e.seq`,
    problem,
    mixedBefore.head.public_seq,
  );
  assert.deepEqual(
    mixedEvents.map((event) => event.type),
    ["claim.revised", "claim.created"],
  );
  assert.deepEqual(
    mixedEvents.map((event) => event.object_version),
    [2, 1],
  );
  assert.deepEqual(
    mixedEvents.map((event) => event.object_id),
    mixed.body.promoted,
  );
  assert.deepEqual(
    mixedEvents.map((event) => event.seq),
    [mixedBefore.head.public_seq + 1, mixedBefore.head.public_seq + 2],
  );
  for (const event of mixedEvents) {
    assert.equal(event.actor_session_id, mixedSession);
    assert.equal(event.actor_sponsor_id, sponsor);
    assert.equal(event.actor_fellow_id, (await closeState(mixedSession)).fellow_id);
    assert.equal(event.created_at, mixed.body.closed_at);
    assert.equal(
      createHash("sha256").update(event.payload_json).digest("hex"),
      event.payload_sha256,
    );
    for (const privateText of [privateCanary, mixedRequest.handback, ...mixedRequest.promote])
      assert.ok(!event.payload_json.includes(privateText));
  }
  const revisedPayload = JSON.parse(mixedEvents[0].payload_json);
  assert.equal(revisedPayload.base_version, 1);
  assert.equal(revisedPayload.statement, replacement.statement);
  assert.deepEqual(
    revisedPayload.dependency_pins.map(({ claim_id, version }) => ({ claim_id, version })),
    [{ claim_id: single.body.promoted[0], version: 1 }],
  );
  assert.deepEqual(
    JSON.parse(mixedEvents[1].payload_json).dependency_pins.map(({ claim_id, version }) => ({
      claim_id,
      version,
    })),
    [{ claim_id: multi.body.promoted[0], version: 1 }],
  );
  assert.deepEqual(
    await one(
      "SELECT * FROM claim_versions WHERE problem_id = ? AND claim_id = ? AND version = 1",
      problem,
      replacement.claim_id,
    ),
    oldVersion,
    "the mixed close preserves the original immutable public statement",
  );
  const mixedAfter = await publicState();
  assert.equal(mixedAfter.tables.claims, mixedBefore.tables.claims + 1);
  for (const table of ["events", "claim_versions", "event_content", "screening_publications"])
    assert.equal(mixedAfter.tables[table], mixedBefore.tables[table] + 2, table);
  assert.equal(mixedAfter.cursor, mixedBefore.cursor + 2);
  assert.equal(mixedAfter.head.public_seq, mixedBefore.head.public_seq + 2);
  assert.equal((await closeState(mixedSession)).handback, mixedRequest.handback);
  assert.equal(await fixtures.screeningCalls(), mixedScreens + 2);
  for (const [index, draft] of [replacementDraft, companion].entries())
    await retainBytes(draft, mixedHistory[index], "archive", "archived", mixedEvents[index].id);
  const revisedFace = ClaimFaceResponseSchema.parse(
    await call(`/p/${problem}/claims/${replacement.claim_id}@2.json`),
  );
  assert.equal(revisedFace.claim_state.version, 2);
  assert.ok(
    revisedFace.items.some(
      (item) => item.kind === "claim-detail" && item.body.includes(replacement.statement),
    ),
  );
  assert.ok(!JSON.stringify(revisedFace).includes(privateCanary));
  await assertReplay(mixedSession, "close-mixed-replacement", mixedRequest, mixed);

  const staleSession = await open();
  const staleReplacement = await pushReplacement(staleSession, replacement);
  const staleCompanion = await push(
    staleSession,
    publication("The sum of two odd integers is even.", "Two odd integers whose sum is odd."),
    "Uncommitted companion",
  );
  const staleBefore = { public: await publicState(), private: await privateState(staleSession) };
  const staleScreens = await fixtures.screeningCalls();
  const stale = await attempt(staleSession, "close-stale-mixed-replacement", {
    handback: "A stale public replacement must not publish its earlier companion.",
    promote: [staleCompanion.workshop_id, staleReplacement.workshop_id],
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "OBJECT_VERSION_CONFLICT");
  assert.deepEqual(await publicState(), staleBefore.public);
  assert.deepEqual(await privateState(staleSession), staleBefore.private);
  assert.equal(await fixtures.screeningCalls(), staleScreens);
  const retainedStale = await attempt(staleSession, "close-stale-with-private-handback", {
    handback:
      "The replacement needs rebasing; both private drafts are retained for the next session.",
    keep: [staleCompanion.workshop_id, staleReplacement.workshop_id],
  });
  assert.equal(retainedStale.status, 201);
  assert.deepEqual(retainedStale.body.promoted, []);
  assert.deepEqual(await publicState(), staleBefore.public);

  // Rejected closes must preserve all private heads, the open session and its active lease.
  const failedSession = await open();
  const goodFirst = await push(
    failedSession,
    publication(
      "Every positive divisor of a prime number is either one or that prime number.",
      "A prime number with a positive divisor distinct from one and itself.",
    ),
    "Prime divisor boundary",
  );
  const goodLast = await push(
    failedSession,
    publication(
      "The product of two integers each congruent to one modulo four is congruent to one modulo four.",
      "Two integers each congruent to one modulo four whose product has a different residue.",
    ),
    "Product residue boundary",
  );
  const failureKeep = await push(failedSession, null, "Keep only if the close succeeds");
  const failureDiscard = await push(failedSession, null, "Discard only if the close succeeds");
  await call(
    `/v1/sessions/${failedSession}/leases`,
    {
      object: single.body.promoted[0],
      objective: "Inspect the remaining residue argument",
      deliverable: "A concrete independent check",
      ttl_seconds: 1800,
    },
    author,
    201,
  );
  const baseRequest = {
    handback: "CLOSE_HANDBACK_REFUSAL: this must remain uncommitted on refusal.",
    promote: [goodFirst.workshop_id, goodLast.workshop_id],
    keep: [failureKeep.workshop_id],
    discard: [failureDiscard.workshop_id],
  };
  const foreignSession = await open(reviewer);
  const foreign = await push(
    foreignSession,
    publication(
      "The greatest common divisor of consecutive positive integers is one.",
      "Consecutive positive integers sharing a divisor greater than one.",
    ),
    "Another Fellow's private draft",
    reviewer,
  );
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
      assert.equal(
        await scalar(
          "SELECT COUNT(*) AS n FROM session_write_replays WHERE scope = 'session_close' AND principal_scope = ? AND idempotency_key = ?",
          fellow,
          key,
        ),
        0,
        "foreign and nonexistent selections are refused before reserving a close identity",
      );
    }
  }
  const duplicateKey = "close-duplicate-selection";
  const duplicateSelection = await attempt(failedSession, duplicateKey, {
    ...baseRequest,
    keep: [goodFirst.workshop_id],
  });
  assert.equal(duplicateSelection.status, 422);
  assert.equal(duplicateSelection.body.code, "SESSION_CLOSE_BODY_INVALID");
  assert.equal(
    await scalar(
      "SELECT COUNT(*) AS n FROM session_write_replays WHERE scope = 'session_close' AND principal_scope = ? AND idempotency_key = ?",
      fellow,
      duplicateKey,
    ),
    0,
  );
  assert.equal(await fixtures.screeningCalls(), invalidScreens);
  assert.deepEqual(await publicState(), invalidBefore.public);
  assert.deepEqual(await privateState(failedSession), invalidBefore.private);

  const missingFalsifier = await push(
    failedSession,
    {
      kind: "conjecture",
      statement: "A nonempty finite set of integers has a greatest element.",
    },
    "Incomplete public falsifier",
  );
  const duplicateClaim = await push(
    failedSession,
    oddSquare,
    "Already published residue statement",
  );
  const badDependency = await push(
    failedSession,
    publication(
      "Every integer divisible by six is divisible by both two and three.",
      "An integer divisible by six that is not divisible by two or not divisible by three.",
      ["C-999999"],
    ),
    "Unavailable dependency",
  );
  for (const [draft, status, code] of [
    [missingFalsifier, 422, "MISSING_FALSIFIER"],
    [duplicateClaim, 409, "DUPLICATE_CLAIM"],
    [badDependency, 422, "DEPENDENCY_NOT_FOUND"],
  ]) {
    const beforePublic = await publicState();
    const beforePrivate = await privateState(failedSession);
    const screens = await fixtures.screeningCalls();
    const refused = await attempt(failedSession, `close-later-${code}`, {
      ...baseRequest,
      promote: [goodFirst.workshop_id, draft.workshop_id],
    });
    assert.equal(refused.status, status);
    assert.equal(refused.body.code, code);
    assert.equal(
      await fixtures.screeningCalls(),
      screens,
      "all content validates before any member screens",
    );
    assert.deepEqual(
      await publicState(),
      beforePublic,
      "the valid first draft left no public prefix",
    );
    assert.deepEqual(
      await privateState(failedSession),
      beforePrivate,
      "no archive, keep, discard or close",
    );
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
    const revised = WorkshopPushResponseSchema.parse(
      await call(
        `/v1/sessions/${failedSession}/workshop`,
        {
          workshop_id: goodLast.workshop_id,
          base_version: goodLast.version,
          publication: changedPublication,
        },
        author,
        201,
      ),
    );
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
  assert.equal(
    await fixtures.screeningCalls(),
    changedReplayScreens,
    "a pinned retry does not screen a replacement source",
  );
  assert.deepEqual(await publicState(), raceBeforePublic);
  assert.deepEqual(await privateState(failedSession), afterConcurrentEdit);

  // A fresh identity after reviewing the new source completes the same user journey.
  const finalSelections = await Promise.all(
    [goodFirst, goodLast].map(async (draft) => ({
      draft,
      before: await history(draft),
    })),
  );
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
  assert.ok(
    (await privateState(failedSession)).leases.every(
      (item) => item.status === "released" && item.released_at === finalClose.body.closed_at,
    ),
  );
  await assertReplay(failedSession, "close-after-review", finalRequest, finalClose);

  // Retaining work is a usable handoff across sessions, not only storage.
  // All writes below use the existing public commands and their normal
  // credentials; private notes never become inferred publication text.
  const sourceSession = await open();
  const retainedPublication = publication(
    "The product of two consecutive integers is divisible by two.",
    "Consecutive integers with an odd product.",
  );
  const recoveredDraft = await push(sourceSession, retainedPublication, "Calculation to resume");
  const resumedReplacement = {
    claim_id: single.body.promoted[0],
    base_version: 1,
    kind: "conjecture",
    statement: "For every integer k, the integer (2k + 1) squared minus one is divisible by eight.",
    falsifier: "An integer k for which (2k + 1) squared minus one is not divisible by eight.",
    depends_on: [],
  };
  const recoveredReplacement = await pushReplacement(sourceSession, resumedReplacement);
  const closeDrafts = [
    await push(
      sourceSession,
      publication(
        "The sum of any two integers divisible by five is divisible by five.",
        "Two integers divisible by five whose sum is not divisible by five.",
      ),
      "First retained close calculation",
    ),
    await push(
      sourceSession,
      publication(
        "The difference of any two integers divisible by seven is divisible by seven.",
        "Two integers divisible by seven whose difference is not divisible by seven.",
      ),
      "Second retained close calculation",
    ),
  ];
  const keepAfterResume = await push(sourceSession, null, "Retain a second private handback");
  const discardAfterResume = await push(sourceSession, null, "Discard after resumed review");
  const revokedDraft = await push(
    sourceSession,
    publication(
      "The additive inverse of an integer divisible by eleven is divisible by eleven.",
      "An integer divisible by eleven whose additive inverse is not divisible by eleven.",
    ),
    "Retained publication requiring a current credential",
  );
  const recovered = [
    recoveredDraft,
    recoveredReplacement,
    ...closeDrafts,
    keepAfterResume,
    discardAfterResume,
    revokedDraft,
  ];
  const initialHistories = await Promise.all(recovered.map(history));
  const beforeRetention = await publicState();
  const retentionRequest = {
    handback: "RETAINED_HANDBACK: recover the exact private calculations in the next session.",
    keep: recovered.map((draft) => draft.workshop_id),
  };
  const retained = await attempt(sourceSession, "close-retain-for-next-session", retentionRequest);
  assert.equal(retained.status, 201);
  assert.deepEqual(retained.body.promoted, []);
  assert.deepEqual(await publicState(), beforeRetention, "retention itself publishes nothing");
  for (const [index, draft] of recovered.entries())
    await retainBytes(draft, initialHistories[index], "keep", "open");
  const sourceClosedState = await closeState(sourceSession);
  const resumedSession = await open();
  const resumedPath = `/v1/sessions/${resumedSession}`;
  const sessions = { originSession: sourceSession, actingSession: resumedSession };
  const recoveredRead = async (
    session,
    draft,
    token = author,
    status = 200,
    version,
    method = "GET",
  ) => {
    const response = await worker.fetch(
      `${origin}/v1/sessions/${session}/workshop/${draft.workshop_id}${version === undefined ? "" : `?version=${version}`}`,
      { method, headers: { "User-Agent": userAgent, authorization: `Bearer ${token}` } },
    );
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = await response.text();
    if (method === "HEAD") {
      assert.equal(body, "");
      return null;
    }
    if (status !== 200) {
      assert.ok(!body.includes(privateCanary));
      return JSON.parse(body);
    }
    const read = WorkshopObjectResponseSchema.parse(JSON.parse(body));
    assert.equal(read.problem_id, problem);
    assert.equal(read.fellow_id, sourceClosedState.fellow_id);
    assert.equal(read.object.body_md, privateBody);
    assert.equal(read.body_sha256, createHash("sha256").update(privateBody).digest("hex"));
    return read;
  };
  const directory = async (session, token = author, query = {}, status = 200, method = "GET") => {
    const response = await worker.fetch(`${origin}${workshopDirectoryPath(session, query)}`, {
      method,
      headers: { "User-Agent": userAgent, authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const raw = await response.text();
    assert.ok(
      !raw.includes(privateCanary),
      "the directory never contains private work-product bytes",
    );
    if (method === "HEAD") {
      assert.equal(raw, "");
      return { response, data: null, raw };
    }
    if (status !== 200) return { response, data: JSON.parse(raw), raw };
    const data = WorkshopDirectoryResponseSchema.parse(JSON.parse(raw));
    const scope = await one(
      "SELECT fellow_id,problem_id FROM sessions WHERE session_id=?",
      session,
    );
    assert.ok(
      workshopDirectoryMatchesQuery(session, scope.problem_id, scope.fellow_id, query, data),
    );
    for (const item of data.items) {
      for (const field of [
        "body_md",
        "cas_hash",
        "relates_to",
        "revision",
        "publication",
        "ledger_intent",
      ])
        assert.equal(Object.hasOwn(item, field), false, `${field} is not directory metadata`);
    }
    const next = /<([^>]+)>; rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
    if (data.next_after !== null) {
      assert.equal(next, workshopDirectoryPath(session, { ...query, after: data.next_after }));
      assert.ok(data.omitted.includes("page_limit"));
    } else assert.equal(next, undefined);
    return { response, data, raw };
  };
  const directoryPages = async (session, token = author, query = { limit: 2 }) => {
    const pages = [];
    let after = query.after;
    for (let index = 0; index < 100; index++) {
      const page = (
        await directory(session, token, { ...query, ...(after === undefined ? {} : { after }) })
      ).data;
      pages.push(page);
      if (page.next_after === null) return pages;
      assert.ok(after === undefined || page.next_after > after);
      after = page.next_after;
    }
    assert.fail("the bounded directory traversal must terminate");
  };
  const readDirectoryEntry = async (item, token = author) => {
    const response = await worker.fetch(`${origin}${item.read_url}`, {
      headers: { "User-Agent": userAgent, authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const read = WorkshopObjectResponseSchema.parse(await response.json());
    assert.equal(read.object.workshop_id, item.workshop_id);
    assert.equal(read.object.version, item.version);
    assert.equal(read.object.body_md, privateBody);
    assert.equal(read.body_sha256, createHash("sha256").update(privateBody).digest("hex"));
    return read;
  };
  for (const draft of recovered) {
    assert.equal((await recoveredRead(resumedSession, draft)).object.current_version, 2);
    assert.equal((await recoveredRead(resumedSession, draft, author, 200, 1)).object.version, 1);
    assert.equal((await head(draft)).session_id, sourceSession);
  }
  const beforeDirectoryRecovery = await publicState();
  const closedDirectory = (await directoryPages(sourceSession)).flatMap((page) => page.items);
  const resumedDirectoryPages = await directoryPages(resumedSession);
  const resumedDirectory = resumedDirectoryPages.flatMap((page) => page.items);
  assert.ok(recovered.length > 5);
  assert.ok(resumedDirectoryPages.length > 1);
  const savedIds = (
    await rows(
      `SELECT w.workshop_id FROM workshop_objects w
    JOIN workshop_revisions r ON r.workshop_id=w.workshop_id AND r.version=w.current_version
    WHERE w.problem_id=? AND w.fellow_id=? ORDER BY w.workshop_id COLLATE BINARY`,
      problem,
      sourceClosedState.fellow_id,
    )
  ).map((row) => row.workshop_id);
  assert.deepEqual(
    resumedDirectory.map((item) => item.workshop_id),
    savedIds,
  );
  assert.deepEqual(
    closedDirectory.map((item) => item.workshop_id),
    savedIds,
  );
  for (const draft of recovered) {
    const item = resumedDirectory.find((item) => item.workshop_id === draft.workshop_id);
    assert.ok(item, "retained drafts remain discoverable after their creating session closes");
    assert.equal(item.version, 2);
    assert.equal(item.state, "open");
    await readDirectoryEntry(item);
  }
  const observedRecovered = resumedDirectory.find(
    (item) => item.workshop_id === recoveredDraft.workshop_id,
  );
  assert.ok(observedRecovered);
  assert.deepEqual(
    await publicState(),
    beforeDirectoryRecovery,
    "directory and exact recovery reads append no public work",
  );

  // A new session is not authority to read or publish someone else's work,
  // work on another problem, or to continue writing through a closed session.
  const otherProblem = "P-CLOSE-RETAINED-OTHER";
  await fixtures.seedProblem(otherProblem, sponsor);
  const wrongProblemSession = (
    await call(
      "/v1/sessions",
      {
        problem_id: otherProblem,
        intent: "explore",
      },
      author,
      201,
    )
  ).session_id;
  const otherProblemDraft = await push(wrongProblemSession, null, "OTHER_PROBLEM_DIRECTORY_CANARY");
  const peer = await enroll("close-directory-peer", sponsor);
  const peerSession = await open(peer);
  const peerDrafts = [];
  for (let index = 0; index < 6; index++) {
    peerDrafts.push(
      await push(
        peerSession,
        publication(
          `An integer multiple of ${index + 31} remains a multiple after adding ${index + 31}.`,
          `An integer multiple of ${index + 31} whose sum with ${index + 31} is not a multiple.`,
        ),
        `SAME_SPONSOR_PEER_DIRECTORY_CANARY ${index}`,
        peer,
      ),
    );
  }
  // Ordinary refused convenience claims legitimately leave revisionless,
  // discarded heads. Such metadata cannot make all later saved work unreadable.
  await fixtures.setScreenMode("reject");
  try {
    const refused = await call(
      `/v1/p/${problem}/claims`,
      publication(
        "Every integer multiple of ninety-seven remains a multiple after adding ninety-seven.",
        "An integer multiple of ninety-seven whose sum with ninety-seven is not a multiple.",
      ),
      peer,
      403,
      "directory-refused-convenience-claim",
    );
    assert.equal(refused.code, "POLICY_DENIED");
  } finally {
    await fixtures.setScreenMode("pass");
  }
  const peerFellow = (await closeState(peerSession)).fellow_id;
  const revisionless = await one(
    `SELECT w.* FROM workshop_objects w
    WHERE w.problem_id=? AND w.fellow_id=? AND NOT EXISTS
      (SELECT 1 FROM workshop_revisions r WHERE r.workshop_id=w.workshop_id)
    ORDER BY w.workshop_id`,
    problem,
    peerFellow,
  );
  assert.ok(revisionless);
  assert.equal(revisionless.state, "discarded");
  // Give the same supported legacy shape a deterministic leading key for
  // the read-boundary probe. Admission is the real rejected request above;
  // this copied private metadata fixture is not a second publication command.
  const omittedBoundaryId = `W-${"0".repeat(26)}`;
  await env.DB.prepare(`INSERT INTO workshop_objects
    (workshop_id,problem_id,fellow_id,session_id,workshop_seq,type,title,body_md,
      cas_hash,relates_to_json,current_version,state,created_at)
    SELECT ?,problem_id,fellow_id,session_id,
      (SELECT MAX(workshop_seq)+1 FROM workshop_objects WHERE problem_id=? AND fellow_id=?),
      type,title,body_md,cas_hash,relates_to_json,current_version,state,created_at
    FROM workshop_objects WHERE workshop_id=?`)
    .bind(omittedBoundaryId, problem, peerFellow, revisionless.workshop_id)
    .run();
  const peerBefore = await publicState();
  const omittedFirst = (await directory(peerSession, peer, { limit: 1 })).data;
  assert.deepEqual(omittedFirst.items, []);
  assert.equal(omittedFirst.scanned_through, omittedBoundaryId);
  assert.equal(omittedFirst.next_after, omittedBoundaryId);
  assert.ok(omittedFirst.omitted.includes("source_unavailable"));
  const peerPages = [omittedFirst];
  let peerAfter = omittedFirst.next_after;
  let editedPeerEntry;
  for (let index = 0; index < 20 && peerAfter !== null; index++) {
    const page = (await directory(peerSession, peer, { limit: 1, after: peerAfter })).data;
    peerPages.push(page);
    if (editedPeerEntry === undefined && page.items.length > 0) {
      editedPeerEntry = page.items[0];
      await call(
        `/v1/sessions/${peerSession}/workshop`,
        {
          workshop_id: editedPeerEntry.workshop_id,
          base_version: editedPeerEntry.version,
          title: "SAME_SPONSOR_PEER_DIRECTORY_CANARY edited during traversal",
        },
        peer,
        201,
      );
      const pinned = await readDirectoryEntry(editedPeerEntry, peer);
      assert.equal(pinned.object.title, editedPeerEntry.title);
      assert.equal(pinned.object.current_version, editedPeerEntry.version + 1);
    }
    assert.ok(page.next_after === null || page.next_after > peerAfter);
    peerAfter = page.next_after;
  }
  assert.equal(peerAfter, null);
  assert.ok(editedPeerEntry);
  const peerItems = peerPages.flatMap((page) => page.items);
  assert.deepEqual(
    peerItems.map((item) => item.workshop_id),
    peerDrafts.map((item) => item.workshop_id).sort(),
  );
  assert.ok(!JSON.stringify(peerPages).includes(revisionless.title));
  assert.equal(new Set(peerItems.map((item) => item.workshop_id)).size, 6);
  const refreshedPeer = (await directoryPages(peerSession, peer)).flatMap((page) => page.items);
  assert.equal(
    refreshedPeer.find((item) => item.workshop_id === editedPeerEntry.workshop_id)?.version,
    editedPeerEntry.version + 1,
  );
  assert.deepEqual(
    await publicState(),
    peerBefore,
    "private metadata edits and directory reads leave the public cursor unchanged",
  );

  for (const method of ["GET", "HEAD"]) {
    await directory(resumedSession, peer, {}, 404, method);
    await directory(peerSession, author, {}, 404, method);
  }
  const peerOwnDirectory = await directory(peerSession, peer, { limit: 100 });
  assert.ok(!peerOwnDirectory.raw.includes(recoveredDraft.workshop_id));
  const authorOwnDirectory = await directory(resumedSession, author, { limit: 100 });
  assert.ok(!authorOwnDirectory.raw.includes("SAME_SPONSOR_PEER_DIRECTORY_CANARY"));
  assert.ok(!authorOwnDirectory.raw.includes(otherProblemDraft.workshop_id));
  const otherOwnDirectory = (await directory(wrongProblemSession, author, { limit: 100 })).data;
  assert.deepEqual(
    otherOwnDirectory.items.map((item) => item.workshop_id),
    [otherProblemDraft.workshop_id],
  );
  assert.ok(!JSON.stringify(otherOwnDirectory).includes(recoveredDraft.workshop_id));
  const refusalSnapshot = {
    public: await publicState(),
    private: await privateState(resumedSession),
  };
  const refusalScreens = await fixtures.screeningCalls();
  for (const [session, credential] of [
    [foreignSession, reviewer],
    [peerSession, peer],
    [wrongProblemSession, author],
  ]) {
    for (const method of ["GET", "HEAD"])
      await recoveredRead(session, recoveredDraft, credential, 404, undefined, method);
    const refused = await call(
      `/v1/sessions/${session}/promote`,
      {
        workshop_id: recoveredDraft.workshop_id,
        expected_workshop_version: 2,
      },
      credential,
      404,
    );
    assert.equal(refused.code, "WORKSHOP_OBJECT_NOT_FOUND");
    const refusedClose = await attempt(
      session,
      `retained-wrong-scope-${session}`,
      {
        handback: "A foreign private work product cannot be selected for this close.",
        promote: [recoveredDraft.workshop_id],
      },
      credential,
    );
    assert.equal(refusedClose.status, 404);
    assert.equal(refusedClose.body.code, "WORKSHOP_OBJECT_NOT_FOUND");
  }
  const closedSource = await call(
    `/v1/sessions/${sourceSession}/promote`,
    {
      workshop_id: recoveredDraft.workshop_id,
      expected_workshop_version: 2,
    },
    author,
    409,
  );
  assert.equal(closedSource.code, "SESSION_CLOSED");
  assert.equal(await fixtures.screeningCalls(), refusalScreens);
  assert.deepEqual(await publicState(), refusalSnapshot.public);
  assert.deepEqual(await privateState(resumedSession), refusalSnapshot.private);
  await call(
    `/v1/sessions/${wrongProblemSession}/close`,
    {
      handback: "The wrong-problem control selected no private work.",
    },
    author,
    201,
  );

  const firstResumedPublication = {
    ...retainedPublication,
    statement: "For every integer n, n times n plus one is divisible by two.",
    falsifier: "An integer n for which n times n plus one is odd.",
  };
  const edited = WorkshopPushResponseSchema.parse(
    await call(
      `${resumedPath}/workshop`,
      {
        workshop_id: recoveredDraft.workshop_id,
        base_version: 2,
        publication: firstResumedPublication,
      },
      author,
      201,
    ),
  );
  assert.equal(edited.version, 3);
  assert.deepEqual(
    (await recoveredRead(resumedSession, recoveredDraft)).object.publication,
    firstResumedPublication,
  );
  assert.deepEqual(
    (await recoveredRead(resumedSession, recoveredDraft, author, 200, 1)).object.publication,
    retainedPublication,
  );
  assert.equal((await history(recoveredDraft)).at(-1).session_id, resumedSession);
  assert.equal((await head(recoveredDraft)).session_id, sourceSession);
  const stillPinned = await readDirectoryEntry(observedRecovered);
  assert.equal(stillPinned.object.version, 2);
  assert.equal(stillPinned.object.current_version, 3);
  assert.deepEqual(stillPinned.object.publication, retainedPublication);
  const oldSelection = await call(
    `${resumedPath}/promote`,
    {
      workshop_id: recoveredDraft.workshop_id,
      expected_workshop_version: 2,
    },
    author,
    409,
  );
  assert.equal(oldSelection.code, "WORKSHOP_VERSION_CONFLICT");
  assert.equal(oldSelection.current_version, 3);

  // The current publisher and the immutable draft source are different
  // sessions. Recheck the selected source inside the actual commit anyway.
  const racePublic = await publicState();
  const retainedRaceScreens = await fixtures.screeningCalls();
  const finalResumedPublication = {
    ...firstResumedPublication,
    statement: "For every integer n, the product n(n + 1) is an even integer.",
  };
  let retainedRace;
  let racedPrivate;
  await fixtures.pauseScreening(30_000);
  const pendingRetained = worker.fetch(`${origin}${resumedPath}/promote`, {
    method: "POST",
    headers: {
      "User-Agent": userAgent,
      authorization: `Bearer ${author}`,
      "content-type": "application/json",
      "idempotency-key": "retained-source-race",
    },
    body: JSON.stringify({ workshop_id: recoveredDraft.workshop_id, expected_workshop_version: 3 }),
  });
  try {
    await waitForScreens(retainedRaceScreens + 1);
    const correction = await call(
      `${resumedPath}/workshop`,
      {
        workshop_id: recoveredDraft.workshop_id,
        base_version: 3,
        publication: finalResumedPublication,
      },
      author,
      201,
    );
    assert.equal(correction.version, 4);
    racedPrivate = await privateState(resumedSession);
    await fixtures.resumeScreening();
    retainedRace = await pendingRetained;
  } finally {
    await fixtures.resumeScreening();
    await Promise.allSettled([pendingRetained]);
  }
  assert.equal(retainedRace.status, 409);
  assert.equal((await retainedRace.json()).code, "WORKSHOP_VERSION_CONFLICT");
  assert.deepEqual(await publicState(), racePublic);
  assert.deepEqual(await privateState(resumedSession), racedPrivate);
  const resumedHistory = await history(recoveredDraft);
  const promotedRecovered = await call(
    `${resumedPath}/promote`,
    {
      workshop_id: recoveredDraft.workshop_id,
      expected_workshop_version: 4,
    },
    author,
    201,
    "retained-reviewed-publication",
  );
  const recoveredEvent = await one(
    `SELECT e.*, c.payload_json FROM events e
    JOIN event_content c ON c.event_id=e.id WHERE e.problem_id=? AND e.seq=?`,
    problem,
    promotedRecovered.seq,
  );
  assert.equal(recoveredEvent.actor_session_id, resumedSession);
  assert.equal(recoveredEvent.actor_fellow_id, sourceClosedState.fellow_id);
  assert.equal(
    JSON.parse(recoveredEvent.payload_json).statement,
    finalResumedPublication.statement,
  );
  assert.ok(!recoveredEvent.payload_json.includes(privateCanary));
  await retainBytes(
    recoveredDraft,
    resumedHistory,
    "archive",
    "archived",
    recoveredEvent.id,
    sessions,
  );

  const replacementHistory = await history(recoveredReplacement);
  const oldClaim = await one(
    "SELECT * FROM claim_versions WHERE problem_id=? AND claim_id=? AND version=1",
    problem,
    resumedReplacement.claim_id,
  );
  const revisedRecovered = await call(
    `${resumedPath}/revise`,
    {
      workshop_id: recoveredReplacement.workshop_id,
    },
    author,
    201,
    "retained-claim-replacement",
  );
  assert.equal(revisedRecovered.version, 2);
  const replacementEvent = await one(
    `SELECT e.*, c.payload_json FROM events e
    JOIN event_content c ON c.event_id=e.id WHERE e.problem_id=? AND e.seq=?`,
    problem,
    revisedRecovered.seq,
  );
  assert.equal(replacementEvent.actor_session_id, resumedSession);
  assert.equal(JSON.parse(replacementEvent.payload_json).statement, resumedReplacement.statement);
  assert.deepEqual(
    await one(
      "SELECT * FROM claim_versions WHERE problem_id=? AND claim_id=? AND version=1",
      problem,
      resumedReplacement.claim_id,
    ),
    oldClaim,
  );
  await retainBytes(
    recoveredReplacement,
    replacementHistory,
    "archive",
    "archived",
    replacementEvent.id,
    sessions,
  );

  const retainedSelections = await Promise.all(
    closeDrafts.map(async (draft) => ({
      draft,
      before: await history(draft),
      sessions,
    })),
  );
  const keepHistory = await history(keepAfterResume);
  const discardHistory = await history(discardAfterResume);
  const revokeHistory = await history(revokedDraft);
  const resumedLease = LeaseAcquireResponseSchema.parse(
    await call(
      `${resumedPath}/leases`,
      {
        object: promotedRecovered.claim_id,
        objective: "Check the recovered parity calculation",
        deliverable: "An exact independent divisibility check",
        ttl_seconds: 1800,
      },
      author,
      201,
    ),
  );
  const resumedCloseRequest = {
    handback:
      "RESUMED_CLOSE_HANDBACK: the recovered calculations now have exact public statements.",
    promote: closeDrafts.map((draft) => draft.workshop_id),
    keep: [keepAfterResume.workshop_id, revokedDraft.workshop_id],
    discard: [discardAfterResume.workshop_id],
  };
  const beforeResumedClose = await publicState();
  const resumedClose = await attempt(resumedSession, "retained-atomic-close", resumedCloseRequest);
  await assertPublished(
    resumedSession,
    resumedCloseRequest,
    retainedSelections,
    beforeResumedClose,
    resumedClose,
  );
  await retainBytes(keepAfterResume, keepHistory, "keep", "open", null, sessions);
  await retainBytes(discardAfterResume, discardHistory, "discard", "discarded", null, sessions);
  await retainBytes(revokedDraft, revokeHistory, "keep", "open", null, sessions);
  assert.equal(
    (await one("SELECT status FROM leases WHERE lease_id=?", resumedLease.lease.lease_id)).status,
    "released",
  );
  assert.deepEqual(
    await closeState(sourceSession),
    sourceClosedState,
    "using retained work never reopens or rewrites its original session handback",
  );
  await assertReplay(resumedSession, "retained-atomic-close", resumedCloseRequest, resumedClose);

  const beforeStateDirectories = await publicState();
  const openItems = (
    await directoryPages(resumedSession, author, { state: "open", limit: 2 })
  ).flatMap((page) => page.items);
  const archivedItems = (
    await directoryPages(resumedSession, author, { state: "archived", limit: 2 })
  ).flatMap((page) => page.items);
  const discardedItems = (
    await directoryPages(resumedSession, author, { state: "discarded", limit: 2 })
  ).flatMap((page) => page.items);
  for (const draft of [keepAfterResume, revokedDraft])
    assert.ok(openItems.some((item) => item.workshop_id === draft.workshop_id));
  for (const draft of [recoveredDraft, recoveredReplacement, ...closeDrafts]) {
    assert.ok(archivedItems.some((item) => item.workshop_id === draft.workshop_id));
    assert.ok(!openItems.some((item) => item.workshop_id === draft.workshop_id));
  }
  assert.ok(discardedItems.some((item) => item.workshop_id === discardAfterResume.workshop_id));
  assert.deepEqual(await publicState(), beforeStateDirectories);

  const credentialSession = await open();
  await recoveredRead(credentialSession, revokedDraft);
  const changeAdmission = (mode) =>
    sponsorCall(
      sponsor,
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      { action: "set-admission-mode", mode },
    );
  await changeAdmission("archived-read-only");
  const beforeArchivedRecovery = {
    public: await publicState(),
    private: await privateState(credentialSession),
    peerPrivate: await privateState(peerSession),
  };
  const archivedDirectory = (await directoryPages(resumedSession, author, { limit: 2 })).flatMap(
    (page) => page.items,
  );
  const archivedRecoveryEntry = archivedDirectory.find(
    (item) => item.workshop_id === revokedDraft.workshop_id,
  );
  assert.ok(archivedRecoveryEntry);
  await readDirectoryEntry(archivedRecoveryEntry);
  await directory(credentialSession, author, { state: "open", limit: 2 });
  // Use the peer's low-use publication budget to isolate the archival gate
  // from the author's earlier successful publications and rejection probes.
  const archivedPeerDirectory = (
    await directoryPages(peerSession, peer, { state: "open", limit: 2 })
  ).flatMap((page) => page.items);
  const archivedPeerEntry = archivedPeerDirectory.find(
    (item) => item.workshop_id === peerDrafts[0].workshop_id,
  );
  assert.ok(archivedPeerEntry);
  await readDirectoryEntry(archivedPeerEntry, peer);
  const blockedPublication = await call(
    `/v1/sessions/${peerSession}/promote`,
    {
      workshop_id: archivedPeerEntry.workshop_id,
      expected_workshop_version: archivedPeerEntry.version,
    },
    peer,
    403,
    "directory-archive-publication-refusal",
  );
  assert.equal(blockedPublication.code, "WRITE_REFUSED");
  assert.deepEqual(await publicState(), beforeArchivedRecovery.public);
  assert.deepEqual(await privateState(credentialSession), beforeArchivedRecovery.private);
  assert.deepEqual(await privateState(peerSession), beforeArchivedRecovery.peerPrivate);
  await changeAdmission("open");

  // A real private proposal permits the creator to recover its work. As in
  // the dedicated workshop-read lane, a current sponsor change is a fixture
  // for loss of that private resource grant, not a claimed transfer workflow.
  const privateProposal = (
    await call(
      "/v1/problems",
      {
        title: "Private recovery of divisibility notes",
        statement: "Every multiple of nineteen is divisible by nineteen.",
        falsifier: "A multiple of nineteen that is not divisible by nineteen.",
        motivation: "Keep the private source recoverable only under its current problem grant.",
        areas: ["number-theory"],
      },
      author,
      201,
    )
  ).problem.id;
  const privateContext = (
    await call("/v1/sessions", { problem_id: privateProposal, intent: "explore" }, author, 201)
  ).session_id;
  const privateResourceDraft = await push(
    privateContext,
    null,
    "PRIVATE_RESOURCE_DIRECTORY_CANARY",
  );
  const privateResourcePage = await directory(privateContext, author, { limit: 2 });
  assert.deepEqual(
    privateResourcePage.data.items.map((item) => item.workshop_id),
    [privateResourceDraft.workshop_id],
  );
  await readDirectoryEntry(privateResourcePage.data.items[0]);
  const beforeResourceRefusals = await publicState();
  await env.DB.prepare("UPDATE problems SET sponsor_id=? WHERE id=?")
    .bind("usr_close_publications_reviewer", privateProposal)
    .run();
  try {
    for (const method of ["GET", "HEAD"]) {
      const missing = await directory(privateContext, author, { limit: 2 }, 404, method);
      assert.ok(!missing.raw.includes("PRIVATE_RESOURCE_DIRECTORY_CANARY"));
      const exact = await worker.fetch(`${origin}${privateResourcePage.data.items[0].read_url}`, {
        method,
        headers: { "User-Agent": userAgent, authorization: `Bearer ${author}` },
      });
      assert.equal(exact.status, 404);
      assert.equal(exact.headers.get("cache-control"), "private, no-store");
      assert.ok(!(await exact.text()).includes(privateCanary));
    }
    assert.deepEqual(await publicState(), beforeResourceRefusals);
  } finally {
    await env.DB.prepare("UPDATE problems SET sponsor_id=? WHERE id=?")
      .bind(sponsor, privateProposal)
      .run();
  }
  await call(
    `/v1/sessions/${privateContext}/close`,
    {
      handback: "The private grant refusal control is complete; retain its draft.",
      keep: [privateResourceDraft.workshop_id],
    },
    author,
    201,
  );
  const credential = await one(
    "SELECT credential_id,fellow_id FROM fellow_tokens WHERE fellow_id=? AND revoked_at IS NULL",
    sourceClosedState.fellow_id,
  );
  assert.ok(credential);
  await sponsorCall(sponsor, "POST", "/v1/fellows/credentials/revoke", "fellow.credential.revoke", {
    ...credential,
    confirm: "revoke-credential",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  const revokedState = {
    public: await publicState(),
    private: await privateState(credentialSession),
  };
  for (const method of ["GET", "HEAD"]) {
    await recoveredRead(credentialSession, revokedDraft, author, 401, undefined, method);
    await directory(credentialSession, author, { limit: 2 }, 401, method);
    await directory(sourceSession, author, { limit: 2 }, 401, method);
  }
  await call(
    `/v1/sessions/${credentialSession}/promote`,
    {
      workshop_id: revokedDraft.workshop_id,
      expected_workshop_version: 3,
    },
    author,
    401,
  );
  assert.deepEqual(await publicState(), revokedState.public);
  assert.deepEqual(await privateState(credentialSession), revokedState.private);
  return {
    single_and_multiple_claims: true,
    mixed_public_creation_and_revision: true,
    stale_mixed_revision_before_screening: true,
    private_r2_source_and_immutable_archive: true,
    exact_claim_versions_and_fellow_provenance: true,
    keep_discard_handback_and_lease_atomicity: true,
    encrypted_exact_replay_after_closure: true,
    foreign_selection_before_reservation: true,
    later_content_and_policy_refusals: true,
    concurrent_source_revision_rollback: true,
    fresh_identity_after_source_review: true,
    retained_work_read_edit_promote_and_revise: true,
    retained_source_session_and_current_publisher_provenance: true,
    retained_sources_atomic_close_keep_discard_and_lease_release: true,
    retained_source_cas_and_authorization_refusals: true,
    private_directory_pagination_and_exact_observed_revisions: true,
    private_directory_same_sponsor_and_problem_isolation: true,
    private_directory_revisionless_omissions_and_edit_stable_cursors: true,
    private_directory_closed_and_archived_recovery: true,
    private_directory_current_grant_and_credential_refusals: true,
  };
});

console.log(
  JSON.stringify({ stage: "session-close-publications-journey-passed", status: "pass", receipt }),
);
