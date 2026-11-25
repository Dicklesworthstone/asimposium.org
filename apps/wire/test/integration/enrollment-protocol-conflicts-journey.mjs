import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PackResponseSchema } from "@asimposium/contracts";
import {
  ActiveDirectiveResponseSchema,
  ProtocolConflictReceiptSchema,
  ProtocolConflictRecordSchema,
} from "@asimposium/contracts/directives";

// Runs inside the existing native Workerd/D1 lane. Every source is minted,
// claimed and approved through the mounted, signed enrollment routes; no DIR
// or receipt is manufactured for an instruction that came from enrollment.
export async function enrollmentProtocolConflictsJourney({
  call,
  sponsorCall,
  fixtures,
  env,
  worker,
  origin,
  userAgent,
  problem,
  sponsor,
  author,
  foreign,
  foreignSession,
}) {
  const receiver = "usr_protocol_conflict_foreign";
  const privateCanary = "PRIVATE_ENROLLMENT_PROTOCOL_CANARY";
  const privateValues = [privateCanary];
  const now = () => Math.floor(Date.now() / 1000);
  const prose = {
    rule_cited: "P1",
    refused_part: "Describe a same-sponsor review as independent verification.",
    explanation:
      "I refuse that part of the onboarding instruction and will request review from a different sponsor.",
  };
  const sourceId = (enrollment, fellow) =>
    `EI-${createHash("sha256").update(`${enrollment}\0${fellow}\0${sponsor}`).digest("hex").slice(0, 32)}`;
  const state = () =>
    env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM protocol_conflicts) AS conflicts,
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT cursor FROM public_cursor WHERE singleton=1) AS cursor,
      (SELECT COUNT(*) FROM fellow_inbox_notices WHERE notice_type='protocol_notice') AS notices,
      (SELECT COUNT(*) FROM screening_publications) AS screened_publications`).first();
  const open = (token, problemId = problem) =>
    call("/v1/sessions", { problem_id: problemId, intent: "review" }, token, 201);
  const active = async (token, problemId = problem) =>
    ActiveDirectiveResponseSchema.parse(
      await call(`/v1/directives/active?problem_id=${problemId}`, undefined, token),
    );
  const path = (session) => `/v1/sessions/${session.session_id}/protocol-conflicts`;
  async function enrolled(name, { bound, removeInstruction = false } = {}) {
    const invitation = await sponsorCall(
      sponsor,
      "POST",
      "/v1/enrollments",
      "enrollment.mint",
      {
        requested_scopes: ["review", "promote"],
        first_directive: `${privateCanary}: ${name}; use only my other Fellow as verifier.`,
        ...(bound ? { problem_binding: bound } : {}),
      },
      201,
    );
    const identity = { name, model: "synthetic-protocol-model", harness: "local-protocol-proof" };
    const claim = await call(
      "/v1/fellows",
      { enrollment_id: invitation.enrollment_id, secret: invitation.secret, ...identity },
      undefined,
      202,
    );
    await sponsorCall(
      sponsor,
      "POST",
      `/v1/enrollments/${invitation.enrollment_id}/decision`,
      "enrollment.decide",
      {
        enrollment_id: invitation.enrollment_id,
        decision: removeInstruction ? "reduce" : "approve",
        ...(removeInstruction ? { reduction: { first_directive: null } } : {}),
        step_up_authenticated_at: now(),
      },
      200,
      "/v1/enrollments/:enrollmentId/decision",
    );
    const issued = await call("/v1/fellows/flow", { flow_handle: claim.flow_handle });
    assert.equal(typeof issued.token, "string");
    const hello = await call("/v1/hello", undefined, issued.token);
    const fellow = hello.fellow.fellow_id;
    const directiveId = sourceId(invitation.enrollment_id, fellow);
    privateValues.push(invitation.secret, claim.flow_handle, issued.token, directiveId);
    return { token: issued.token, fellow, directiveId, invitation, identity };
  }

  const initial = await enrolled("protocol-enrollment-global");
  const received = await active(initial.token);
  assert.equal(received.initial_instruction.directive_id, initial.directiveId);
  assert.equal(received.initial_instruction.source_kind, "enrollment-instruction");
  assert.equal(received.focus, null);
  assert.deepEqual(received.forbids, []);
  const session = await open(initial.token);
  const conflictPath = path(session);
  const packRead = session.next_actions.find((action) => action.url.includes("/pack?"));
  assert.ok(packRead);
  const pack = PackResponseSchema.parse(await call(packRead.url, undefined, initial.token));
  assert.ok(
    pack.next_actions.some((action) => action.method === "POST" && action.url === conflictPath),
    "an enrollment-only instruction exposes the executable refusal action",
  );
  const body = { directive_id: initial.directiveId, ...prose };
  const beforeInvalid = await state();
  const screensBeforeInvalid = await fixtures.screeningCalls();
  await call(conflictPath, { ...body, directive_id: `EI-${"0".repeat(32)}` }, initial.token, 401);
  await call(`/v1/sessions/${foreignSession}/protocol-conflicts`, body, foreign, 401);
  await call(
    conflictPath,
    { ...body, source_enrollment_id: initial.invitation.enrollment_id },
    initial.token,
    422,
  );
  assert.deepEqual(await state(), beforeInvalid);
  assert.equal(await fixtures.screeningCalls(), screensBeforeInvalid);

  // Pending transfer does not revoke the original sponsor's authority.
  const transfer = await sponsorCall(
    sponsor,
    "POST",
    "/v1/sponsors/transfers",
    "sponsor.transfer.initiate",
    {
      fellow_id: initial.fellow,
      target_sponsor_id: receiver,
      confirm: "initiate-fellow-transfer",
      directive_attestation: "unresolved",
      step_up_authenticated_at: now(),
    },
    201,
  );
  const before = await state();
  const key = "enrollment-protocol-durable-receipt";
  const receipt = ProtocolConflictReceiptSchema.parse(
    await call(conflictPath, body, initial.token, 200, key),
  );
  assert.equal(receipt.fellow_id, initial.fellow);
  assert.equal(receipt.sponsor_id, sponsor);
  assert.deepEqual(await state(), {
    conflicts: before.conflicts + 1,
    events: before.events + 1,
    cursor: before.cursor + 1,
    notices: before.notices + 1,
    screened_publications: before.screened_publications + 1,
  });
  const stored = await env.DB.prepare(`SELECT c.*, ep.enrollment_id AS approved_enrollment,
    content.payload_json, q.status AS reservation_status
    FROM protocol_conflicts c JOIN enrollment_proposals ep ON ep.proposal_id=c.source_proposal_id
    JOIN event_content content ON content.event_id=c.event_id
    JOIN public_write_attempt_reservations q ON q.reservation_id=c.reservation_id
    WHERE c.conflict_id=?`)
    .bind(receipt.conflict_id)
    .first();
  assert.equal(stored.source_kind, "enrollment-instruction");
  assert.equal(stored.source_enrollment_id, initial.invitation.enrollment_id);
  assert.equal(stored.approved_enrollment, initial.invitation.enrollment_id);
  assert.equal(stored.source_directive_id, null);
  assert.equal(stored.source_notice_id, null);
  assert.equal(stored.directive_id, initial.directiveId);
  assert.equal(stored.reservation_status, "settled_published");
  const publicPath = `/p/${problem}/protocol-conflicts/${receipt.conflict_id}`;
  const publicRecord = ProtocolConflictRecordSchema.parse(await call(`${publicPath}.json`));
  assert.equal(publicRecord.explanation, prose.explanation);
  const publicMarkdown = await worker.fetch(`${origin}${publicPath}.md`, {
    headers: { "User-Agent": userAgent },
  });
  assert.equal(publicMarkdown.status, 200);
  const notice = await env.DB.prepare(
    "SELECT * FROM fellow_inbox_notices WHERE caused_by_event_id=?",
  )
    .bind(receipt.event_id)
    .first();
  assert.equal(notice.notice_type, "protocol_notice");
  assert.equal(notice.target_id, receipt.conflict_id);
  for (const bytes of [
    stored.payload_json,
    JSON.stringify(receipt),
    JSON.stringify(publicRecord),
    await publicMarkdown.text(),
    JSON.stringify(await call(`/p/${problem}/events.json?since=0&limit=200`)),
    JSON.stringify(notice),
    JSON.stringify(await fixtures.lastScreening()),
  ]) {
    for (const privateValue of [
      ...privateValues,
      initial.invitation.enrollment_id,
      stored.source_proposal_id,
    ])
      assert.ok(
        !bytes.includes(privateValue),
        "private enrollment provenance stays out of publication and screening",
      );
  }
  const after = await state();
  const screensAfter = await fixtures.screeningCalls();
  assert.deepEqual(await call(conflictPath, body, initial.token, 200, key), receipt);
  await call(conflictPath, body, initial.token, 409, "enrollment-protocol-duplicate");
  await call(
    conflictPath,
    { ...body, explanation: "Different public explanation for the same key." },
    initial.token,
    409,
    key,
  );
  assert.deepEqual(await state(), after);
  assert.equal(await fixtures.screeningCalls(), screensAfter);

  // One global instruction may conflict in more than one problem, while the
  // same source in a single problem remains unique.
  const second = (
    await call(
      "/v1/problems",
      {
        title: "A second finite path boundary",
        statement: "A path with no edges has one vertex.",
        falsifier: "A simple connected path with zero edges and a different vertex count.",
        motivation: "Apply the original onboarding boundary independently in another problem.",
        areas: ["combinatorics"],
      },
      author,
      201,
    )
  ).problem.id;
  await sponsorCall(
    sponsor,
    "POST",
    `/v1/sponsors/problems/${second}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
  );
  const secondSession = await open(initial.token, second);
  assert.equal(
    (await active(initial.token, second)).initial_instruction.directive_id,
    initial.directiveId,
  );
  const secondReceipt = ProtocolConflictReceiptSchema.parse(
    await call(path(secondSession), body, initial.token, 200, "enrollment-protocol-second-problem"),
  );
  assert.equal(secondReceipt.problem_id, second);
  assert.notEqual(secondReceipt.conflict_id, receipt.conflict_id);
  for (const completed of [session, secondSession]) {
    await call(
      `/v1/sessions/${completed.session_id}/close`,
      { handback: "Recorded the onboarding conflict; independent review remains necessary." },
      initial.token,
      201,
    );
  }
  const closed = await state();
  const screensAfterClose = await fixtures.screeningCalls();
  assert.deepEqual(await call(conflictPath, body, initial.token, 200, key), receipt);
  assert.deepEqual(await state(), closed);
  assert.equal(await fixtures.screeningCalls(), screensAfterClose);

  // Accepted transfer and an authentic rebind do not turn the former
  // sponsor's immutable enrollment history into the new sponsor's steering.
  await sponsorCall(
    receiver,
    "POST",
    `/v1/sponsors/transfers/${transfer.transfer_id}/accept`,
    "sponsor.transfer.accept",
    {
      transfer_id: transfer.transfer_id,
      confirm: "accept-fellow-transfer",
      step_up_authenticated_at: now(),
    },
  );
  await call(conflictPath, body, initial.token, 401, key);
  const rebind = await sponsorCall(
    receiver,
    "POST",
    "/v1/sponsors/rebinds",
    "sponsor.rebind.create",
    {
      fellow_id: initial.fellow,
      confirm: "rebind-transferred-fellow",
      step_up_authenticated_at: now(),
    },
    201,
  );
  const claim = await call(
    "/v1/fellows/rebind",
    { rebind_id: rebind.rebind_id, secret: rebind.secret, ...initial.identity },
    undefined,
    202,
  );
  await sponsorCall(
    receiver,
    "POST",
    `/v1/sponsors/rebinds/${rebind.rebind_id}/decision`,
    "sponsor.rebind.decide",
    {
      rebind_id: rebind.rebind_id,
      decision: "approve",
      confirm: "decide-fellow-rebind",
      step_up_authenticated_at: now(),
    },
  );
  const replacement = await call("/v1/fellows/rebind/flow", { flow_handle: claim.flow_handle });
  assert.equal(replacement.status, "approved");
  await sponsorCall(receiver, "POST", "/v1/fellows/lifecycle", "fellow.lifecycle.change", {
    fellow_id: initial.fellow,
    status: "active",
    confirm: "change-fellow-lifecycle",
    step_up_authenticated_at: now(),
  });
  assert.equal((await active(replacement.token)).initial_instruction, null);
  const reboundSession = await open(replacement.token);
  const beforeRebound = await state();
  await call(path(reboundSession), body, replacement.token, 401, "enrollment-old-sponsor-source");
  assert.deepEqual(await state(), beforeRebound);

  // Approval may remove the requested first directive. Its otherwise
  // predictable EI ID must not authorize a source that was never granted.
  const reduced = await enrolled("protocol-enrollment-reduced", { removeInstruction: true });
  assert.equal((await active(reduced.token)).initial_instruction, null);
  const reducedSession = await open(reduced.token);
  const beforeReduced = await state();
  await call(
    path(reducedSession),
    { ...prose, directive_id: reduced.directiveId },
    reduced.token,
    401,
  );
  assert.deepEqual(await state(), beforeReduced);
  const scoped = await enrolled("protocol-enrollment-scoped", { bound: problem });
  const scopedSession = await open(scoped.token);
  assert.equal((await active(scoped.token)).initial_instruction.problem_id, problem);
  await call(
    path(secondSession),
    { ...prose, directive_id: scoped.directiveId },
    scoped.token,
    401,
  );
  await call(`/v1/directives/active?problem_id=${second}`, undefined, scoped.token, 401);
  ProtocolConflictReceiptSchema.parse(
    await call(path(scopedSession), { ...prose, directive_id: scoped.directiveId }, scoped.token),
  );

  // Complete screening cannot override an authority change. The actual D1
  // append rolls back the event, source projection, notice and public cursor.
  const racing = await enrolled("protocol-enrollment-revoked");
  const racingSession = await open(racing.token);
  const beforeRace = await state();
  const beforeRaceScreens = await fixtures.screeningCalls();
  await fixtures.revokeOnNextScreen();
  await call(
    path(racingSession),
    { ...prose, directive_id: racing.directiveId },
    racing.token,
    401,
    "enrollment-protocol-revoked-during-screen",
  );
  assert.equal(await fixtures.screeningCalls(), beforeRaceScreens + 1);
  assert.deepEqual(await state(), beforeRace);
  const failedAttempt = await env.DB.prepare(`SELECT status FROM public_write_attempt_reservations
    WHERE fellow_id=? AND route=? ORDER BY reserved_at DESC LIMIT 1`)
    .bind(racing.fellow, path(racingSession))
    .first();
  assert.equal(failedAttempt.status, "settled_failed");
}
