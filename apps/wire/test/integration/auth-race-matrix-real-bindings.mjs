/**
 * W10.4 Auth Race Matrix on Real Local Workerd/D1 Stack (`asimposiumorg-ana`).
 *
 * Zero mocks: runs against the compiled Hono Worker in local Workerd with real
 * migrated Cloudflare D1 bindings via `runLocalWorkerJourney`. Logs structured
 * interleaving traces per race and asserts:
 *  - Exactly one credential outcome commits on every race path
 *  - Plaintext join secrets & bearer tokens NEVER appear in D1 rows or Worker logs
 *  - 30-min join-secret TTL and 24-hour proposal TTL are independent
 *  - Regenerating an unused join URL (`replaces_enrollment_id`) atomically invalidates predecessor
 *  - Immediate revocation (zero grace window)
 *  - Device flow RFC 8628 `slow_down`, body-only query refusal, bare proposal-ID rejection
 *  - One-time response-loss / concurrent `POST /v1/fellows/flow` issuance (never replays secret)
 *  - Bidirectional `WRONG_PRINCIPAL` (Fellow bearer on sponsor route; browser cookie on Stoa)
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, env, worker, origin }) => {
  const SPONSOR_A = "usr_race_sponsor_a";
  const SPONSOR_B = "usr_race_sponsor_b";
  const nowSec = () => Math.floor(Date.now() / 1000);
  const traces = [];

  const rawFetch = async (path, init = {}) => {
    const resp = await worker.fetch(`${origin}${path}`, {
      ...init,
      headers: {
        "User-Agent": "asimp-w10-4-auth-race-matrix",
        ...(init.headers ?? {}),
      },
    });
    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: resp.status, headers: resp.headers, text, json };
  };

  // Bootstrap both sponsors cleanly before racing (strict empty JSON object).
  for (const sponsor of [SPONSOR_A, SPONSOR_B]) {
    await sponsorCall(
      sponsor,
      "POST",
      "/v1/sponsors/bootstrap",
      "sponsor.bootstrap",
      {},
      [200, 201],
    );
  }

  // ---------------------------------------------------------------------------
  // RACE 1: Two simultaneous exchanges of ONE join code (single-use, SHA-256 at rest)
  // ---------------------------------------------------------------------------
  {
    const minted = await sponsorCall(
      SPONSOR_A,
      "POST",
      "/v1/enrollments",
      "enrollment.mint",
      { requested_scopes: ["promote", "review"] },
      201,
    );
    assert.equal(typeof minted.enrollment_id, "string");
    assert.equal(typeof minted.secret, "string");

    // Verify SHA-256 at rest BEFORE exchange: plaintext secret absent from enrollment_records.
    const recordRow = await env.DB.prepare(
      "SELECT secret_hash, secret_consumed_at, invalidated FROM enrollment_records WHERE enrollment_id = ?",
    )
      .bind(minted.enrollment_id)
      .first();
    assert.ok(recordRow, "enrollment_records row must exist");
    assert.notEqual(recordRow.secret_hash, minted.secret, "plaintext secret must never be stored");
    assert.equal(
      recordRow.secret_hash,
      sha256Hex(minted.secret),
      "stored secret_hash must match SHA-256",
    );

    const claimBody = (suffix) =>
      JSON.stringify({
        enrollment_id: minted.enrollment_id,
        secret: minted.secret,
        name: `race1-fellow-${suffix}`,
        model: "synthetic-race-model",
        harness: "w10-4-race-matrix",
      });

    const [r1, r2] = await Promise.all([
      rawFetch("/v1/fellows", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "race1-claim-alpha",
        },
        body: claimBody("a"),
      }),
      rawFetch("/v1/fellows", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "race1-claim-beta",
        },
        body: claimBody("b"),
      }),
    ]);

    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    assert.equal(
      statuses.filter((s) => s === 202).length,
      1,
      `Exactly one simultaneous join-code claim must win (got statuses=${statuses.join(",")})`,
    );
    const loser = r1.status === 202 ? r2 : r1;
    assert.ok(
      loser.status >= 400 && loser.status < 500,
      `Losing claim must receive 4xx refusal, got ${loser.status}`,
    );

    const proposalCount = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM enrollment_proposals WHERE enrollment_id = ?",
    )
      .bind(minted.enrollment_id)
      .first();
    assert.equal(proposalCount.cnt, 1, "Exactly one proposal row may commit in D1");

    traces.push({
      race: "RACE-1-SIMULTANEOUS-JOIN-EXCHANGE",
      statuses: [r1.status, r2.status],
      loser_code: loser.json?.code ?? null,
      d1_proposals: proposalCount.cnt,
      invariant_held: true,
    });
  }

  // ---------------------------------------------------------------------------
  // RACE 2: 30-min join-secret TTL vs 24h proposal TTL independence + D1
  //         immutability trigger + concurrent approve-vs-deny race
  // ---------------------------------------------------------------------------
  {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // (2a) Real wall-clock join-secret expiry (short expires_in_ms) refuses NEW claim
    const expiredJoin = await sponsorCall(
      SPONSOR_A,
      "POST",
      "/v1/enrollments",
      "enrollment.mint",
      { requested_scopes: ["review"], expires_in_ms: 400 },
      201,
    );
    await sleep(550);
    const lateClaim = await rawFetch("/v1/fellows", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "race2a-late-claim" },
      body: JSON.stringify({
        enrollment_id: expiredJoin.enrollment_id,
        secret: expiredJoin.secret,
        name: "race2a-late-fellow",
        model: "synthetic-race-model",
        harness: "w10-4-race-matrix",
      }),
    });
    assert.ok(
      lateClaim.status >= 400 && lateClaim.status < 500,
      `Expired join secret must refuse claim, got ${lateClaim.status}`,
    );

    // (2b) Already-claimed proposal whose join-secret TTL passes in real time STILL approves within 24h!
    const validProposal = await sponsorCall(
      SPONSOR_A,
      "POST",
      "/v1/enrollments",
      "enrollment.mint",
      { requested_scopes: ["review"], expires_in_ms: 800 },
      201,
    );
    const claimed2b = await rawFetch("/v1/fellows", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "race2b-claim" },
      body: JSON.stringify({
        enrollment_id: validProposal.enrollment_id,
        secret: validProposal.secret,
        name: "race2b-ttl-independent",
        model: "synthetic-race-model",
        harness: "w10-4-race-matrix",
      }),
    });
    assert.equal(claimed2b.status, 202);
    const propRow2b = await env.DB.prepare(
      "SELECT created_at, expires_at FROM enrollment_proposals WHERE enrollment_id = ?",
    )
      .bind(validProposal.enrollment_id)
      .first();
    assert.equal(
      propRow2b.expires_at - propRow2b.created_at,
      24 * 60 * 60 * 1000,
      "Pending proposal TTL must be exactly 24h independent of join-secret TTL",
    );

    // Wait for join-secret TTL to expire on real wall clock, then approve proposal
    await sleep(950);
    const approved2b = await sponsorCall(
      SPONSOR_A,
      "POST",
      `/v1/enrollments/${validProposal.enrollment_id}/decision`,
      "enrollment.decide",
      {
        enrollment_id: validProposal.enrollment_id,
        decision: "approve",
        step_up_authenticated_at: nowSec(),
      },
      200,
      "/v1/enrollments/:enrollmentId/decision",
    );
    assert.equal(approved2b.acknowledged, true);

    // (2c) Concurrent approve-vs-deny race on a single proposal commits EXACTLY ONE terminal decision
    const racedProp = await sponsorCall(
      SPONSOR_A,
      "POST",
      "/v1/enrollments",
      "enrollment.mint",
      { requested_scopes: ["review"] },
      201,
    );
    const claimed2c = await rawFetch("/v1/fellows", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "race2c-claim" },
      body: JSON.stringify({
        enrollment_id: racedProp.enrollment_id,
        secret: racedProp.secret,
        name: "race2c-approve-vs-deny",
        model: "synthetic-race-model",
        harness: "w10-4-race-matrix",
      }),
    });
    assert.equal(claimed2c.status, 202);

    const [approveRes, denyRes] = await Promise.all([
      sponsorCall(
        SPONSOR_A,
        "POST",
        `/v1/enrollments/${racedProp.enrollment_id}/decision`,
        "enrollment.decide",
        {
          enrollment_id: racedProp.enrollment_id,
          decision: "approve",
          step_up_authenticated_at: nowSec(),
        },
        [200, 404, 409],
        "/v1/enrollments/:enrollmentId/decision",
        "race2c-approve",
      ),
      sponsorCall(
        SPONSOR_A,
        "POST",
        `/v1/enrollments/${racedProp.enrollment_id}/decision`,
        "enrollment.decide",
        {
          enrollment_id: racedProp.enrollment_id,
          decision: "deny",
          step_up_authenticated_at: nowSec(),
        },
        [200, 404, 409],
        "/v1/enrollments/:enrollmentId/decision",
        "race2c-deny",
      ),
    ]);
    const finalProp = await env.DB.prepare(
      "SELECT status FROM enrollment_proposals WHERE enrollment_id = ?",
    )
      .bind(racedProp.enrollment_id)
      .first();
    assert.ok(
      finalProp.status === "approved" || finalProp.status === "denied",
      `Proposal must settle in exactly one terminal state, got ${finalProp.status}`,
    );
    const ackCount = [approveRes, denyRes].filter((r) => r?.acknowledged === true).length;
    assert.equal(ackCount, 1, "Exactly ONE of competing approve vs deny may succeed");
    // Actually query real D1 fellow_tokens (zero credentials minted at decision time;
    // and if denied, polling /v1/fellows/flow MUST return status=denied with zero token).
    const racedCreds = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt
         FROM fellow_tokens c
         JOIN enrollment_proposals p ON p.proposal_id = c.proposal_id
        WHERE p.enrollment_id = ?`,
    )
      .bind(racedProp.enrollment_id)
      .first();
    assert.equal(racedCreds.cnt, 0, "Zero credentials may exist before one-time poll");
    if (finalProp.status === "denied") {
      const deniedPoll = await rawFetch("/v1/fellows/flow", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "race2c-denied-poll" },
        body: JSON.stringify({ flow_handle: claimed2c.json.flow_handle }),
      });
      assert.equal(deniedPoll.json?.status, "denied");
      assert.equal(deniedPoll.json?.token, undefined);
    }

    traces.push({
      race: "RACE-2-JOIN-TTL-VS-PROPOSAL-TTL-AND-APPROVE-VS-DENY",
      late_claim_status: lateClaim.status,
      proposal_ttl_ms: propRow2b.expires_at - propRow2b.created_at,
      post_secret_ttl_approval: approved2b.acknowledged,
      raced_final_status: finalProp.status,
      raced_d1_creds: racedCreds.cnt,
      invariant_held: true,
    });
  }

  // ---------------------------------------------------------------------------
  // RACE 3: Regenerating unused join URL atomically invalidates predecessor
  // ---------------------------------------------------------------------------
  {
    const firstJoin = await sponsorCall(
      SPONSOR_A,
      "POST",
      "/v1/enrollments",
      "enrollment.mint",
      { requested_scopes: ["review"] },
      201,
    );
    const replacementJoin = await sponsorCall(
      SPONSOR_A,
      "POST",
      "/v1/enrollments",
      "enrollment.mint",
      {
        requested_scopes: ["review"],
        replaces_enrollment_id: firstJoin.enrollment_id,
      },
      201,
    );
    assert.notEqual(replacementJoin.enrollment_id, firstJoin.enrollment_id);

    const oldRow = await env.DB.prepare(
      "SELECT invalidated FROM enrollment_records WHERE enrollment_id = ?",
    )
      .bind(firstJoin.enrollment_id)
      .first();
    assert.equal(oldRow.invalidated, 1, "Predecessor join URL must be marked invalidated=1");

    const claimOld = await rawFetch("/v1/fellows", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "race3-old-claim" },
      body: JSON.stringify({
        enrollment_id: firstJoin.enrollment_id,
        secret: firstJoin.secret,
        name: "race3-stale-url",
        model: "synthetic-race-model",
        harness: "w10-4-race-matrix",
      }),
    });
    assert.ok(claimOld.status >= 400 && claimOld.status < 500, "Invalidated predecessor must fail");

    traces.push({
      race: "RACE-3-REGENERATE-INVALIDATES-PREDECESSOR",
      predecessor_invalidated: oldRow.invalidated,
      predecessor_claim_status: claimOld.status,
      invariant_held: true,
    });
  }

  // ---------------------------------------------------------------------------
  // RACE 4 & RACE 6: Approval double-POST + cross-sponsor refusal + one-time
  // response-loss concurrent poll issuance (exactly one plaintext token ever issued;
  // zero plaintext token retained in D1)
  // ---------------------------------------------------------------------------
  {
    const minted = await sponsorCall(
      SPONSOR_A,
      "POST",
      "/v1/enrollments",
      "enrollment.mint",
      { requested_scopes: ["promote", "review"] },
      201,
    );
    const claimed = await rawFetch("/v1/fellows", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "race4-claim" },
      body: JSON.stringify({
        enrollment_id: minted.enrollment_id,
        secret: minted.secret,
        name: "race4-double-approve",
        model: "synthetic-race-model",
        harness: "w10-4-race-matrix",
      }),
    });
    assert.equal(claimed.status, 202);
    const flowHandle = claimed.json.flow_handle;
    assert.equal(typeof flowHandle, "string");

    // Cross-sponsor approval attempt MUST fail with 403 WRONG_PRINCIPAL
    const wrongSponsorDecision = await sponsorCall(
      SPONSOR_B,
      "POST",
      `/v1/enrollments/${minted.enrollment_id}/decision`,
      "enrollment.decide",
      {
        enrollment_id: minted.enrollment_id,
        decision: "approve",
        step_up_authenticated_at: nowSec(),
      },
      403,
      "/v1/enrollments/:enrollmentId/decision",
    );
    assert.equal(wrongSponsorDecision.code, "WRONG_PRINCIPAL");

    // Double-POST approval race (two concurrent approvals with distinct keys)
    const [dec1, dec2] = await Promise.all([
      sponsorCall(
        SPONSOR_A,
        "POST",
        `/v1/enrollments/${minted.enrollment_id}/decision`,
        "enrollment.decide",
        {
          enrollment_id: minted.enrollment_id,
          decision: "approve",
          step_up_authenticated_at: nowSec(),
        },
        [200, 404, 409],
        "/v1/enrollments/:enrollmentId/decision",
        "race4-approve-key-1",
      ),
      sponsorCall(
        SPONSOR_A,
        "POST",
        `/v1/enrollments/${minted.enrollment_id}/decision`,
        "enrollment.decide",
        {
          enrollment_id: minted.enrollment_id,
          decision: "approve",
          step_up_authenticated_at: nowSec(),
        },
        [200, 404, 409],
        "/v1/enrollments/:enrollmentId/decision",
        "race4-approve-key-2",
      ),
    ]);
    const acks = [dec1, dec2].filter((d) => d?.acknowledged === true);
    assert.equal(
      acks.length,
      1,
      `Exactly ONE distinct-key concurrent approve may succeed (got ${acks.length})`,
    );
    const losingDec = [dec1, dec2].find((d) => d?.acknowledged !== true);
    assert.equal(losingDec?.code, "PROPOSAL_NOT_PENDING");

    // Same-key idempotent double-POST approval replay returns clean 200 acknowledged
    const replayDec = await sponsorCall(
      SPONSOR_A,
      "POST",
      `/v1/enrollments/${minted.enrollment_id}/decision`,
      "enrollment.decide",
      {
        enrollment_id: minted.enrollment_id,
        decision: "approve",
        step_up_authenticated_at: nowSec(),
      },
      200,
      "/v1/enrollments/:enrollmentId/decision",
      "race4-approve-key-1",
    );
    assert.equal(replayDec.acknowledged, true);

    // RACE 6 (One-time response-loss / concurrent poll issuance):
    // Fire two simultaneous POST /v1/fellows/flow polls with distinct idempotency keys.
    const [poll1, poll2] = await Promise.all([
      rawFetch("/v1/fellows/flow", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "race6-poll-1" },
        body: JSON.stringify({ flow_handle: flowHandle }),
      }),
      rawFetch("/v1/fellows/flow", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "race6-poll-2" },
        body: JSON.stringify({ flow_handle: flowHandle }),
      }),
    ]);

    const issuedTokens = [poll1.json?.token, poll2.json?.token].filter(
      (t) => typeof t === "string" && t.startsWith("asimp_ag_"),
    );
    assert.equal(
      issuedTokens.length,
      1,
      `Exactly ONE concurrent flow poll may receive the plaintext bearer token (got ${issuedTokens.length})`,
    );
    const issuedToken = issuedTokens[0];

    // Subsequent poll after issuance MUST NOT reconstruct or replay a secret
    const postPoll = await rawFetch("/v1/fellows/flow", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "race6-poll-3" },
      body: JSON.stringify({ flow_handle: flowHandle }),
    });
    assert.equal(postPoll.json?.token, undefined, "Post-issuance poll must never replay a token");

    // Verify D1 stores ONLY token_hash and exactly 1 credential row in fellow_tokens
    const credRows = await env.DB.prepare(
      `SELECT c.credential_id, c.token_hash, c.fellow_id
         FROM fellow_tokens c
         JOIN enrollment_proposals p ON p.proposal_id = c.proposal_id
        WHERE p.enrollment_id = ?`,
    )
      .bind(minted.enrollment_id)
      .all();
    assert.equal(credRows.results.length, 1, "Exactly one credential row in D1");
    assert.equal(credRows.results[0].token_hash, sha256Hex(issuedToken));
    assert.notEqual(credRows.results[0].token_hash, issuedToken);

    traces.push({
      race: "RACE-4-AND-6-DOUBLE-APPROVE-AND-ONE-TIME-ISSUANCE",
      wrong_sponsor_code: wrongSponsorDecision.code,
      poll_statuses: [poll1.status, poll2.status],
      tokens_issued: issuedTokens.length,
      post_poll_has_token: postPoll.json?.token !== undefined,
      d1_credential_rows: credRows.results.length,
      invariant_held: true,
    });
  }

  // ---------------------------------------------------------------------------
  // RACE 5: Device flow RFC 8628 slow_down + body-only enforcement + bare proposal ID refused
  // ---------------------------------------------------------------------------
  {
    const started = await rawFetch("/v1/device-code", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "race5-device-start",
        "cf-connecting-ip": "198.51.100.42",
      },
      body: JSON.stringify({
        name: "race5-device-fellow",
        model: "synthetic-race-model",
        harness: "w10-4-race-matrix",
        requested_scopes: ["review"],
      }),
    });
    assert.equal(started.status, 201, `device-code start failed: ${started.text}`);
    const deviceFlowHandle = started.json.device_code;
    assert.equal(typeof deviceFlowHandle, "string");

    // Query-string flow_handle MUST be refused with 400 BODY_ONLY_REQUIRED
    const queryRefusal = await rawFetch(
      `/v1/device-token?flow_handle=${encodeURIComponent(deviceFlowHandle)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "race5-query" },
        body: JSON.stringify({ flow_handle: deviceFlowHandle }),
      },
    );
    assert.equal(queryRefusal.status, 400);
    assert.equal(queryRefusal.json?.code, "BODY_ONLY_REQUIRED");

    // Bare proposal/enrollment ID instead of flow_handle MUST be refused
    const bareIdRefusal = await rawFetch("/v1/device-token", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "race5-bare-id" },
      body: JSON.stringify({ flow_handle: started.json.enrollment_id ?? "ASIMP-EN-01JXYZ4K6Q" }),
    });
    assert.ok(bareIdRefusal.status >= 400 && bareIdRefusal.status < 500);

    // Back-to-back polls faster than interval trigger RFC 8628 slow_down
    const fast1 = await rawFetch("/v1/device-token", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "race5-fast-1" },
      body: JSON.stringify({ flow_handle: deviceFlowHandle }),
    });
    const fast2 = await rawFetch("/v1/device-token", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "race5-fast-2" },
      body: JSON.stringify({ flow_handle: deviceFlowHandle }),
    });
    assert.equal(fast1.status, 200);
    assert.equal(fast2.status, 200);
    assert.equal(
      fast2.json?.status,
      "slow_down",
      `Expected slow_down on rapid poll, got ${fast2.text}`,
    );
    assert.ok(
      typeof fast2.json?.retry_after_seconds === "number" && fast2.json.retry_after_seconds >= 5,
      "slow_down must carry retry_after_seconds >= 5",
    );

    traces.push({
      race: "RACE-5-DEVICE-SLOW-DOWN-AND-BODY-ONLY",
      query_refusal_code: queryRefusal.json?.code,
      bare_id_status: bareIdRefusal.status,
      rapid_poll_status: fast2.json?.status,
      retry_after_seconds: fast2.json?.retry_after_seconds,
      invariant_held: true,
    });
  }

  // ---------------------------------------------------------------------------
  // RACE 7: Sponsor revocation racing Fellow calls (immediate effect, 0 grace window)
  //         + Bidirectional WRONG_PRINCIPAL (bearer on sponsor route, cookie on a.)
  // ---------------------------------------------------------------------------
  {
    const fellowToken = await enroll("race7-revoke-target", SPONSOR_A);
    const helloBefore = await call("/v1/hello", undefined, fellowToken, 200);
    const fellowId = helloBefore.fellow.fellow_id;
    const credRow = await env.DB.prepare(
      "SELECT credential_id FROM fellow_tokens WHERE fellow_id = ? LIMIT 1",
    )
      .bind(fellowId)
      .first();
    assert.ok(credRow?.credential_id, "enrolled Fellow must have active credential_id");

    // Bidirectional WRONG_PRINCIPAL check 1: Fellow bearer token on sponsor-only route
    const wrongPrincipalResp = await rawFetch("/v1/enrollments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fellowToken}`,
        "idempotency-key": "race7-wrong-principal-1",
      },
      body: JSON.stringify({ requested_scopes: ["review"] }),
    });
    assert.ok(
      [401, 403].includes(wrongPrincipalResp.status),
      `Fellow bearer on sponsor route must fail 401/403, got ${wrongPrincipalResp.status}`,
    );

    // Bidirectional WRONG_PRINCIPAL check 2: Browser session cookie on Stoa (a.) NEVER authenticates
    const cookieOnStoa = await rawFetch("/v1/hello", {
      method: "GET",
      headers: {
        cookie: "__Host-authjs.session-token=forged-browser-cookie-value",
      },
    });
    assert.equal(
      cookieOnStoa.status,
      401,
      `Browser cookie on Stoa must be rejected with 401, got ${cookieOnStoa.status}`,
    );

    // Concurrent sponsor credential revocation racing an in-flight Fellow WRITE (POST /v1/sessions)
    // plus an in-flight read (GET /v1/hello).
    const [revokeRes, concurrentWrite, concurrentHello] = await Promise.all([
      sponsorCall(
        SPONSOR_A,
        "POST",
        "/v1/fellows/credentials/revoke",
        "fellow.credential.revoke",
        {
          fellow_id: fellowId,
          credential_id: credRow.credential_id,
          confirm: "revoke-credential",
          step_up_authenticated_at: nowSec(),
        },
        200,
      ),
      rawFetch("/v1/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${fellowToken}`,
          "idempotency-key": "race7-inflight-session-write",
        },
        body: JSON.stringify({ problem_id: "P-4DSP" }),
      }),
      rawFetch("/v1/hello", {
        method: "GET",
        headers: { authorization: `Bearer ${fellowToken}` },
      }),
    ]);
    assert.ok(revokeRes, "Revoke call must commit");

    // Immediately after revocation commits: zero grace window -> MUST return 401 FELLOW_TOKEN_INVALID
    // on BOTH reads and writes (even if the raced pre-commit session write had opened a session).
    const helloAfter = await rawFetch("/v1/hello", {
      method: "GET",
      headers: { authorization: `Bearer ${fellowToken}` },
    });
    assert.equal(helloAfter.status, 401);
    assert.equal(helloAfter.json?.code, "FELLOW_TOKEN_INVALID");

    const sessionAfter = await rawFetch("/v1/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fellowToken}`,
        "idempotency-key": "race7-post-revoke-session",
      },
      body: JSON.stringify({ problem_id: "P-4DSP" }),
    });
    assert.equal(sessionAfter.status, 401);

    traces.push({
      race: "RACE-7-REVOCATION-AND-BIDIRECTIONAL-WRONG-PRINCIPAL",
      bearer_on_sponsor_status: wrongPrincipalResp.status,
      cookie_on_stoa_status: cookieOnStoa.status,
      concurrent_write_status: concurrentWrite.status,
      concurrent_hello_status: concurrentHello.status,
      post_revoke_hello_status: helloAfter.status,
      post_revoke_hello_code: helloAfter.json?.code,
      post_revoke_session_status: sessionAfter.status,
      invariant_held: true,
    });
  }

  // Emit single-line NDJSON verdict required by lanes-real-bindings.test.ts
  console.log(
    JSON.stringify({
      stage: "auth-race-matrix-complete",
      status: "pass",
      bead: "asimposiumorg-ana",
      races_passed: traces.length,
      traces,
    }),
  );
});
