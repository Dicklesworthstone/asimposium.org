import assert from "node:assert/strict";
import {
  SPONSOR_DATA_EXPORT_MAX_RESPONSE_BYTES,
  SPONSOR_DATA_EXPORT_SECTIONS,
  SponsorDataExportResponseSchema,
} from "@asimposium/contracts/account-export";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Genuine Workerd, D1 and private R2. Enrollment approval and the screening
// verdict use the shared fixtures; export, workshop, transfer and auth are the
// mounted production paths. No live Google OAuth or browser proof is claimed.
assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");
await runLocalWorkerJourney(async ({ call, enroll, fixtures, sponsorCall, env }) => {
  const owner = "usr_export_author";
  const receiver = "usr_export_receiver";
  const firstDirective =
    "PRIVATE_FIRST_DIRECTIVE_CANARY: preserve the original boundary assumptions.";
  await sponsorCall(owner, "POST", "/v1/sponsors/bootstrap", "sponsor.bootstrap", {}, 201);
  const invitation = await sponsorCall(
    owner,
    "POST",
    "/v1/enrollments",
    "enrollment.mint",
    {
      requested_scopes: ["promote", "review", "propose-problems"],
      first_directive: firstDirective,
    },
    201,
  );
  const claimed = await call(
    "/v1/fellows",
    {
      enrollment_id: invitation.enrollment_id,
      secret: invitation.secret,
      name: "export-author",
      model: "synthetic-export-model",
      harness: "local-account-export",
    },
    undefined,
    202,
  );
  await fixtures.approve(owner, invitation.enrollment_id);
  const token = (await call("/v1/fellows/flow", { flow_handle: claimed.flow_handle })).token;
  const reviewer = await enroll("export-reviewer", receiver);
  const fellow = (await call("/v1/hello", undefined, token)).fellow.fellow_id;
  const created = await call(
    "/v1/problems",
    {
      title: "Exported finite path work",
      statement: "Every finite simple path with n edges has n plus one vertices.",
      falsifier: "A finite simple path whose vertex count is not one greater than its edge count.",
      motivation: "Preserve exact finite combinatorial work when its sponsor moves or leaves.",
      areas: ["combinatorics"],
    },
    token,
    201,
  );
  const problem = created.problem.id;
  await sponsorCall(
    owner,
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
  );
  const rs = await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201);
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: rs.session_id,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "The finite path, integer edge count, and exact boundary vertex count are explicit.",
    },
    reviewer,
  );
  const session = await call(
    "/v1/sessions",
    { problem_id: problem, intent: "explore" },
    token,
    201,
  );
  const fullBody =
    "PRIVATE_EXPORT_WORK_CANARY: record the deliberately chosen finite boundary cases. ".repeat(60);
  const draft = await call(
    `/v1/sessions/${session.session_id}/workshop`,
    {
      type: "scratch",
      title: "Private finite boundary cases",
      body_md: fullBody,
    },
    token,
    201,
  );
  const original = await env.DB.prepare(
    "SELECT cas_hash FROM workshop_objects WHERE workshop_id = ?",
  )
    .bind(draft.workshop_id)
    .first();
  assert.match(original.cas_hash, /^sha256:[a-f0-9]{64}$/);
  const directive = "PRIVATE_EXPORT_DIRECTIVE_CANARY: check the empty path separately.";
  await sponsorCall(
    owner,
    "POST",
    "/v1/sponsors/directives",
    "issue-directive",
    {
      fellow_id: fellow,
      problem_id: problem,
      verb: "focus",
      text: directive,
    },
    201,
  );

  const path = "/v1/sponsors/account/export-page";
  const read = async (sponsor, cursor, expected = 200) => {
    const value = await sponsorCall(
      sponsor,
      "POST",
      path,
      "sponsor.account.export-page",
      cursor ? { cursor } : {},
      expected,
    );
    return expected === 200 ? SponsorDataExportResponseSchema.parse(value) : value;
  };
  const collect = async (sponsor) => {
    const pages = [];
    let cursor;
    do {
      const page = await read(sponsor, cursor);
      assert.equal(page.sponsor_id, sponsor);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= SPONSOR_DATA_EXPORT_MAX_RESPONSE_BYTES);
      if (pages.length) assert.deepEqual(page.snapshot, pages[0].snapshot);
      pages.push(page);
      cursor = page.next_cursor;
      assert.ok(pages.length < 100, "export terminates");
    } while (cursor);
    assert.deepEqual(
      [...new Set(pages.map((page) => page.section))],
      [...SPONSOR_DATA_EXPORT_SECTIONS],
    );
    return pages;
  };

  await call(path, {}, token, 403);
  await call(path, {}, undefined, 403);
  await sponsorCall(owner, "POST", path, "workshop.read", {}, 401);
  await sponsorCall(
    owner,
    "POST",
    path,
    "sponsor.account.export-page",
    { sponsor_id: receiver },
    400,
  );
  const pages = await collect(owner);
  for (const kind of ["workshop", "workshop_history"]) {
    const record = pages.flatMap((page) => page.records).find((row) => row.kind === kind);
    assert.equal(
      record.data.object.body_md,
      fullBody,
      "the full verified private CAS body is portable",
    );
  }
  assert.ok(JSON.stringify(pages).includes(directive));
  assert.ok(JSON.stringify(pages).includes(firstDirective));
  assert.ok(!JSON.stringify(await collect(receiver)).includes(fullBody));
  assert.ok(!JSON.stringify(pages).includes(token));
  assert.ok(!JSON.stringify(pages).includes(invitation.secret));
  assert.ok(!JSON.stringify(pages).includes(claimed.flow_handle));
  assert.ok(!JSON.stringify(pages).includes("token_hash"));
  assert.ok(!JSON.stringify(pages).includes("flow_handle_hash"));
  assert.ok(!JSON.stringify(pages).includes("request_digest"));
  const initial = await read(owner);
  await call(
    `/v1/sessions/${session.session_id}/workshop`,
    {
      type: "note",
      title: "Additional private check",
      body_md: "This additional note changes the account export snapshot.",
    },
    token,
    201,
  );
  assert.equal((await read(owner, initial.next_cursor, 409)).code, "OBJECT_VERSION_CONFLICT");

  // A missing private body may never become a seemingly complete export made
  // from its 280-character database extract. Restore the exact bytes afterward.
  const fresh = await read(owner);
  const casKey = `cas/sha256/${original.cas_hash.slice(7)}`;
  await env.ARTIFACTS.put(casKey, "digest-detached private bytes");
  assert.equal(
    (await read(owner, { snapshot: fresh.snapshot, section: "workshop", after: 0 }, 503)).code,
    "INTERNAL_ERROR",
  );
  await env.ARTIFACTS.put(casKey, fullBody);
  assert.equal(
    (await read(owner, { snapshot: fresh.snapshot, section: "workshop", after: 0 })).records[0].data
      .object.body_md,
    fullBody,
  );

  // Both humans authorize the transfer. A pre-transfer export continuation
  // cannot retain private access; the new sponsor inherits work, not the
  // outgoing sponsor's historical instruction bodies.
  const beforeTransfer = await read(owner);
  const transfer = await sponsorCall(
    owner,
    "POST",
    "/v1/sponsors/transfers",
    "sponsor.transfer.initiate",
    {
      fellow_id: fellow,
      target_sponsor_id: receiver,
      confirm: "initiate-fellow-transfer",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
      directive_attestation: "unresolved",
    },
    201,
  );
  await sponsorCall(
    receiver,
    "POST",
    `/v1/sponsors/transfers/${transfer.transfer_id}/accept`,
    "sponsor.transfer.accept",
    {
      transfer_id: transfer.transfer_id,
      confirm: "accept-fellow-transfer",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    },
  );
  assert.equal(
    (await read(owner, beforeTransfer.next_cursor, 409)).code,
    "OBJECT_VERSION_CONFLICT",
  );
  const previousOwner = JSON.stringify(await collect(owner));
  const newOwner = JSON.stringify(await collect(receiver));
  assert.ok(!previousOwner.includes(fullBody));
  assert.ok(previousOwner.includes(directive));
  assert.ok(previousOwner.includes(firstDirective));
  assert.ok(newOwner.includes(fullBody));
  assert.ok(!newOwner.includes(directive));
  assert.ok(
    !newOwner.includes(firstDirective),
    "an immutable transferred grant must not leak its author's first directive",
  );
  await call("/v1/hello", undefined, token, 401);

  console.log(
    JSON.stringify({
      kind: "account-export-real-bindings",
      status: "pass",
      complete_private_cas_and_history: true,
      revision_change_refuses_partial_export: true,
      corrupted_cas_is_unavailable: true,
      signed_scope_and_secret_exclusions: true,
      transfer_rechecks_current_ownership_and_keeps_directives_private: true,
      boundary:
        "local Workerd/D1/R2; fixture enrollment approval and screening; no browser or live OAuth claim",
    }),
  );
});
