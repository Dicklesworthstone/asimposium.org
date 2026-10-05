import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { parseStoaRebindUrl } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// dwml on real local Workerd/D1: after an accepted transfer the receiving
// sponsor rebinds the Fellow over HTTP. It mints a rebind URL (fragment
// secret), the Fellow's agent claims it with its exact identity and polls,
// the sponsor sees the claim and approves it, and the next poll issues one
// fresh credential bound to the transferred grant (0087/0088). Nothing else
// reaches the Fellow: not a direct credential insert without an approved
// rebind, not the former sponsor, not a mismatched declaration, not a
// pre-transfer credential.
await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, env, worker, origin }) => {
  const A = "usr_rebind_alpha";
  const B = "usr_rebind_beta";
  const moved = await enroll("rebind-moved", A);
  await enroll("rebind-beta-own", B);
  const hello = await call("/v1/hello", undefined, moved);
  const movedId = hello.fellow.fellow_id;
  const identity = await env.DB.prepare(
    "SELECT name, model, harness FROM enrollment_fellows WHERE fellow_id = ?",
  )
    .bind(movedId)
    .first();
  const now = () => Math.floor(Date.now() / 1000);

  const transferTo = async (from, to) => {
    const offer = await sponsorCall(
      from,
      "POST",
      "/v1/sponsors/transfers",
      "sponsor.transfer.initiate",
      {
        fellow_id: movedId,
        target_sponsor_id: to,
        confirm: "initiate-fellow-transfer",
        step_up_authenticated_at: now(),
        directive_attestation: "no_directives",
      },
      201,
    );
    await sponsorCall(
      to,
      "POST",
      `/v1/sponsors/transfers/${offer.transfer_id}/accept`,
      "sponsor.transfer.accept",
      {
        transfer_id: offer.transfer_id,
        confirm: "accept-fellow-transfer",
        step_up_authenticated_at: now(),
      },
      200,
    );
  };
  const resume = (sponsor) =>
    sponsorCall(sponsor, "POST", "/v1/fellows/lifecycle", "fellow.lifecycle.change", {
      fellow_id: movedId,
      status: "active",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: now(),
    });
  const mintRebind = (sponsor, expected = 201) =>
    sponsorCall(
      sponsor,
      "POST",
      "/v1/sponsors/rebinds",
      "sponsor.rebind.create",
      {
        fellow_id: movedId,
        confirm: "rebind-transferred-fellow",
        step_up_authenticated_at: now(),
      },
      expected,
    );
  const decide = (sponsor, rebindId, decision, expected = 200) =>
    sponsorCall(
      sponsor,
      "POST",
      `/v1/sponsors/rebinds/${rebindId}/decision`,
      "sponsor.rebind.decide",
      {
        rebind_id: rebindId,
        decision,
        confirm: "decide-fellow-rebind",
        step_up_authenticated_at: now(),
      },
      expected,
    );
  const listed = async (sponsor, rebindId) =>
    (await sponsorCall(sponsor, "GET", "/v1/sponsors/rebinds", "sponsor.rebind.list")).rebinds.find(
      (rebind) => rebind.rebind_id === rebindId,
    );
  const claim = (rebind, declared, expected = 202, key) =>
    call(
      "/v1/fellows/rebind",
      {
        rebind_id: rebind.rebind_id,
        secret: rebind.secret,
        name: declared.name,
        model: declared.model,
        harness: declared.harness,
      },
      undefined,
      expected,
      key,
    );
  const poll = (flowHandle, key, expected = 200) =>
    call("/v1/fellows/rebind/flow", { flow_handle: flowHandle }, undefined, expected, key);

  // A -> B: every pre-transfer credential is dead, the Fellow is paused.
  await transferTo(A, B);
  await call("/v1/hello", undefined, moved, 401);

  // No credential reaches the moved grant without an approved rebind, not
  // even one inserted directly in D1 as the issuance statement would.
  const grant = await env.DB.prepare(
    "SELECT granted_scopes_json, granted_resources_json FROM enrollment_grants WHERE fellow_id = ?",
  )
    .bind(movedId)
    .first();
  await assert.rejects(
    env.DB.prepare(
      `INSERT INTO fellow_tokens (
         credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
         granted_scopes_json, granted_resources_json, issued_at, expires_at,
         revoked_at, last_used_at, credential_profile, credential_origin
       ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'bearer', 'harness-migration')`,
    )
      .bind(
        "cred-lane-unapproved",
        movedId,
        B,
        createHash("sha256").update(randomBytes(32)).digest("hex"),
        grant.granted_scopes_json,
        grant.granted_resources_json,
        Date.now(),
        Date.now() + 3_600_000,
      )
      .run(),
    /credential durable authority/,
    "a credential without an approved rebind is refused",
  );

  // Only the receiving sponsor can rebind.
  assert.equal((await mintRebind(A, 409)).code, "REBIND_FELLOW_NOT_ELIGIBLE");

  // A claim declaring a different Fellow cannot be approved; the sponsor denies it.
  const first = await mintRebind(B);
  const parsedUrl = parseStoaRebindUrl(first.rebind_url);
  assert.equal(parsedUrl?.rebindId, first.rebind_id, "the URL names this rebind");
  assert.equal(parsedUrl?.secret, first.secret, "the secret lives only in the fragment");
  const capsule = await worker.fetch(`${origin}/rebind/${first.rebind_id}`, {
    headers: { accept: "application/json" },
  });
  assert.equal(capsule.status, 200);
  const capsuleBody = await capsule.json();
  assert.equal(capsuleBody.fellow_name, identity.name);
  assert.equal(
    JSON.stringify(capsuleBody).includes(first.secret),
    false,
    "no secret in the capsule",
  );
  const markdown = await (
    await worker.fetch(`${origin}/rebind/${first.rebind_id}`, {
      headers: { accept: "text/markdown" },
    })
  ).text();
  assert.match(markdown, /# ASImposium Fellow rebind/);
  assert.ok(
    markdown.includes(`${origin}/v1/fellows/rebind`),
    "the claim command names this origin",
  );
  assert.equal(markdown.includes(first.secret), false, "no secret in the Markdown face");
  assert.equal(
    (await claim({ ...first, secret: `v1.${"A".repeat(43)}` }, identity, 400)).code,
    "REBIND_CLAIM_INVALID",
    "a wrong secret is the opaque refusal",
  );
  const imposter = await claim(first, { ...identity, model: "someone-else/model-9" });
  assert.equal((await listed(B, first.rebind_id)).claim.matches_fellow, false);
  assert.equal(
    (await decide(B, first.rebind_id, "approve", 422)).code,
    "REBIND_DECLARATION_MISMATCH",
  );
  assert.equal((await decide(A, first.rebind_id, "deny", 404)).code, "REBIND_NOT_FOUND");
  await decide(B, first.rebind_id, "deny");
  assert.equal((await poll(imposter.flow_handle)).status, "access_denied");
  assert.equal(
    (await claim(first, identity, 400)).code,
    "REBIND_CLAIM_INVALID",
    "a claimed rebind cannot be claimed again",
  );

  // hmda: an approved rebind not yet redeemed dies with a later transfer.
  // glpz: B passes the still paused Fellow on (its status evidence is kept).
  const stale = await mintRebind(B);
  const staleClaim = await claim(stale, identity);
  await decide(B, stale.rebind_id, "approve");
  await transferTo(B, A);
  await transferTo(A, B);
  assert.equal(
    (await poll(staleClaim.flow_handle)).status,
    "expired_token",
    "a rebind approved before a later transfer issues nothing",
  );
  assert.equal((await listed(B, stale.rebind_id)).status, "superseded");

  // The Fellow's own claim, approved: one credential, replayable by its key.
  const second = await mintRebind(B);
  const claimed = await claim(second, identity, 202, "rebind-claim-key");
  assert.deepEqual(
    await claim(second, identity, 202, "rebind-claim-key"),
    claimed,
    "a same-key claim retry replays its flow handle",
  );
  assert.equal((await poll(claimed.flow_handle)).status, "authorization_pending");
  const summary = await listed(B, second.rebind_id);
  assert.equal(summary.status, "awaiting-approval");
  assert.equal(summary.claim.matches_fellow, true);
  assert.equal((await decide(A, second.rebind_id, "approve", 404)).code, "REBIND_NOT_FOUND");
  await decide(B, second.rebind_id, "approve");
  const issued = await poll(claimed.flow_handle, "rebind-poll-key");
  assert.equal(issued.status, "approved");
  assert.deepEqual(
    await poll(claimed.flow_handle, "rebind-poll-key"),
    issued,
    "the same poll key replays the one token",
  );
  assert.equal((await poll(claimed.flow_handle, undefined, 400)).code, "FLOW_INVALID");
  assert.equal((await listed(B, second.rebind_id)).status, "redeemed");

  // The new bearer works once the receiving sponsor resumes the Fellow.
  await call("/v1/hello", undefined, issued.token, 401);
  await resume(B);
  assert.equal((await call("/v1/hello", undefined, issued.token)).fellow.fellow_id, movedId);
  await call("/v1/hello", undefined, moved, 401);

  // B -> A: B's credential dies; A rebinds the same way and its token works.
  await transferTo(B, A);
  await call("/v1/hello", undefined, issued.token, 401);
  // x223: back under A, the original enrollment's sponsor matches again, yet
  // a credential still needs a redeemed rebind of the transfer that moved it.
  await assert.rejects(
    env.DB.prepare(
      `INSERT INTO fellow_tokens (
         credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
         granted_scopes_json, granted_resources_json, issued_at, expires_at,
         revoked_at, last_used_at, credential_profile, credential_origin
       ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'bearer', 'harness-migration')`,
    )
      .bind(
        "cred-lane-returned-unapproved",
        movedId,
        A,
        createHash("sha256").update(randomBytes(32)).digest("hex"),
        grant.granted_scopes_json,
        grant.granted_resources_json,
        Date.now(),
        Date.now() + 3_600_000,
      )
      .run(),
    /credential durable authority/,
    "back with its first sponsor, a credential still needs an approved rebind",
  );
  const back = await mintRebind(A);
  const backClaim = await claim(back, identity);
  await decide(A, back.rebind_id, "approve");
  const backToken = (await poll(backClaim.flow_handle)).token;
  await resume(A);
  assert.equal((await call("/v1/hello", undefined, backToken)).fellow.fellow_id, movedId);
  await call("/v1/hello", undefined, moved, 401);

  // xya1: an archived Fellow (revoked, then archived) cannot be rebound. A
  // rebind approved before that polls expired_token, never a fake outage.
  const doomedToken = await enroll("rebind-doomed", A);
  const doomedId = (await call("/v1/hello", undefined, doomedToken)).fellow.fellow_id;
  const doomedIdentity = await env.DB.prepare(
    "SELECT name, model, harness FROM enrollment_fellows WHERE fellow_id = ?",
  )
    .bind(doomedId)
    .first();
  const doomedOffer = await sponsorCall(
    A,
    "POST",
    "/v1/sponsors/transfers",
    "sponsor.transfer.initiate",
    {
      fellow_id: doomedId,
      target_sponsor_id: B,
      confirm: "initiate-fellow-transfer",
      step_up_authenticated_at: now(),
      directive_attestation: "no_directives",
    },
    201,
  );
  await sponsorCall(
    B,
    "POST",
    `/v1/sponsors/transfers/${doomedOffer.transfer_id}/accept`,
    "sponsor.transfer.accept",
    {
      transfer_id: doomedOffer.transfer_id,
      confirm: "accept-fellow-transfer",
      step_up_authenticated_at: now(),
    },
    200,
  );
  const doomedRebind = await sponsorCall(
    B,
    "POST",
    "/v1/sponsors/rebinds",
    "sponsor.rebind.create",
    { fellow_id: doomedId, confirm: "rebind-transferred-fellow", step_up_authenticated_at: now() },
    201,
  );
  const doomedClaim = await claim(doomedRebind, doomedIdentity);
  await decide(B, doomedRebind.rebind_id, "approve");
  for (const status of ["revoked", "archived"]) {
    await sponsorCall(B, "POST", "/v1/fellows/lifecycle", "fellow.lifecycle.change", {
      fellow_id: doomedId,
      status,
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: now(),
    });
  }
  assert.equal((await listed(B, doomedRebind.rebind_id)).status, "expired");
  assert.equal((await poll(doomedClaim.flow_handle)).status, "expired_token");
  assert.equal(
    (
      await sponsorCall(
        B,
        "POST",
        "/v1/sponsors/rebinds",
        "sponsor.rebind.create",
        {
          fellow_id: doomedId,
          confirm: "rebind-transferred-fellow",
          step_up_authenticated_at: now(),
        },
        409,
      )
    ).code,
    "REBIND_FELLOW_NOT_ELIGIBLE",
  );

  // 6prt: the receiving sponsor's panic after the transfer ends rebinding on
  // that grant: an approved rebind expires and a new one is refused, never 503.
  const late = await mintRebind(A);
  const lateClaim = await claim(late, identity);
  await decide(A, late.rebind_id, "approve");
  await sponsorCall(A, "POST", "/v1/sponsors/panic", "sponsor.panic", {
    confirm: "revoke-all-fellow-credentials",
    step_up_authenticated_at: now(),
  });
  assert.equal((await poll(lateClaim.flow_handle)).status, "expired_token");
  assert.equal((await mintRebind(A, 409)).code, "REBIND_FELLOW_NOT_ELIGIBLE");

  console.log(
    JSON.stringify({
      kind: "fellow-rebind-real-bindings",
      status: "pass",
      boundary: "local Workerd/D1; signed sponsor envelopes; no staging, no browser",
    }),
  );
  return { status: "pass" };
});
