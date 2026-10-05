import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// dwml on real local Workerd/D1: after an accepted transfer, the grant the
// transfer moved authorizes a fresh harness-migration credential under the
// receiving sponsor (migration 0087 and authenticateCredential), and nothing
// else: not the former sponsor, not an enrollment-origin credential, and no
// pre-transfer credential. The credential is minted directly in D1 here,
// exactly as an approved rebind issues it.
await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, env }) => {
  const A = "usr_rebind_alpha";
  const B = "usr_rebind_beta";
  const moved = await enroll("rebind-moved", A);
  await enroll("rebind-beta-own", B);
  const movedId = (await call("/v1/hello", undefined, moved)).fellow.fellow_id;
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
  const grant = () =>
    env.DB.prepare(
      "SELECT proposal_id, sponsor_id, granted_scopes_json, granted_resources_json, granted_at FROM enrollment_grants WHERE fellow_id = ?",
    )
      .bind(movedId)
      .first();
  let minted = 0;
  // A well-formed bearer and its credential row, as a rebind issues it.
  const mint = async ({ sponsor, origin = "harness-migration", proposalId = null }) => {
    const current = await grant();
    minted += 1;
    const token = `asimp_ag_${"0".repeat(20)}${String(minted).padStart(6, "0")}_${randomBytes(32).toString("base64url")}`;
    const issuedAt = Date.now();
    await env.DB.prepare(
      `INSERT INTO fellow_tokens (
         credential_id, proposal_id, fellow_id, sponsor_id, token_hash,
         granted_scopes_json, granted_resources_json, issued_at, expires_at,
         revoked_at, last_used_at, credential_profile, credential_origin
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'bearer', ?)`,
    )
      .bind(
        `cred-lane-rebind-${minted}`,
        proposalId,
        movedId,
        sponsor,
        createHash("sha256").update(token).digest("hex"),
        current.granted_scopes_json,
        current.granted_resources_json,
        issuedAt,
        issuedAt + 7 * 24 * 3600 * 1000,
        origin,
      )
      .run();
    return token;
  };
  const mintAllowed = (input) =>
    mint(input).catch((error) => assert.fail(`the credential was refused: ${error}`));

  // A -> B: every pre-transfer credential is dead, the Fellow is paused.
  await transferTo(A, B);
  await call("/v1/hello", undefined, moved, 401);
  const afterMove = await grant();
  assert.equal(afterMove.sponsor_id, B);

  // The former sponsor cannot mint under the moved grant.
  await assert.rejects(mint({ sponsor: A }), /credential (durable )?authority/);
  // An enrollment-origin credential is not what the transferred grant admits.
  await assert.rejects(
    mint({ sponsor: B, origin: "enrollment", proposalId: afterMove.proposal_id }),
    /credential (durable )?authority|identity|binding/,
  );

  // The receiving sponsor's fresh credential authenticates once it resumes.
  const rebound = await mintAllowed({ sponsor: B });
  await call("/v1/hello", undefined, rebound, 401);
  await resume(B);
  const hello = await call("/v1/hello", undefined, rebound, 200);
  assert.equal(hello.fellow.fellow_id, movedId);
  await call("/v1/hello", undefined, moved, 401);

  // B -> A: B's credential dies with the move; the original enrollment's
  // credential stays dead even back under A; A's fresh credential works.
  await transferTo(B, A);
  await call("/v1/hello", undefined, rebound, 401);
  await call("/v1/hello", undefined, moved, 401);
  const back = await mintAllowed({ sponsor: A });
  await resume(A);
  assert.equal((await call("/v1/hello", undefined, back, 200)).fellow.fellow_id, movedId);
  await call("/v1/hello", undefined, moved, 401);

  console.log(
    JSON.stringify({
      kind: "fellow-rebind-real-bindings",
      status: "pass",
      boundary:
        "local Workerd/D1; credentials minted directly in D1 as a rebind issues them; no staging",
    }),
  );
  return { status: "pass" };
});
