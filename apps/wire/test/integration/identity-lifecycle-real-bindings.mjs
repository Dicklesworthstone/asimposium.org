import assert from "node:assert/strict";
import {
  SponsorAccountDeletePreviewResponseSchema,
  SponsorAccountDeleteResponseSchema,
  SponsorAccountExportResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// W3.8 identity lifecycle over HTTP on real Workerd/D1/R2 (bead
// asimposiumorg-wty4): bilateral transfer (offer, accept, reject, cancel,
// refusals), credential rotation, immutable public attribution, account export,
// deletion preview and deletion. Sponsors act only through signed envelopes.
await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, env }) => {
  const A = "usr_lifecycle_alpha";
  const B = "usr_lifecycle_beta";
  const C = "usr_lifecycle_gamma";
  const moved = await enroll("lifecycle-moved", A);
  const kept = await enroll("lifecycle-kept", A);
  await enroll("lifecycle-beta-own", B);
  await enroll("lifecycle-gamma-own", C);
  const movedId = (await call("/v1/hello", undefined, moved)).fellow.fellow_id;
  const keptId = (await call("/v1/hello", undefined, kept)).fellow.fellow_id;

  // A public contribution before the transfer, to prove attribution is immutable.
  const created = await call(
    "/v1/problems",
    {
      title: "Lifecycle attribution problem",
      statement: "Every integer in 0..9 has a square of the same parity.",
      falsifier: "An integer in 0..9 whose square has the opposite parity.",
      motivation: "Prove public attribution survives transfer and deletion.",
      areas: ["number-theory"],
    },
    moved,
    201,
  );
  const problem = created.problem.id;
  await sponsorCall(A, "POST", `/v1/sponsors/problems/${problem}/lifecycle`, "problem-lifecycle", {
    action: "publish",
  });

  const now = () => Math.floor(Date.now() / 1000);
  const sponsorResult = async (sponsor, method, path, action, body) => {
    try {
      return { ok: true, body: await sponsorCall(sponsor, method, path, action, body, 200) };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  };
  // A refusal must teach with its specific lifecycle code, never collapse to 503.
  const refusedWith = (result, pattern, why) => {
    assert.equal(result.ok, false, why);
    assert.match(result.error, pattern, why);
    assert.doesNotMatch(result.error, /ENROLLMENT_UNAVAILABLE|status=5\d\d/, why);
  };
  const offer = (fellowId) =>
    sponsorCall(
      A,
      "POST",
      "/v1/sponsors/transfers",
      "sponsor.transfer.initiate",
      {
        fellow_id: fellowId,
        target_sponsor_id: B,
        confirm: "initiate-fellow-transfer",
        step_up_authenticated_at: now(),
        directive_attestation: "no_directives",
      },
      201,
    );

  // --- Offer and refusals ---
  const transfer = await offer(movedId);
  assert.equal(transfer.status, "pending");
  assert.equal(transfer.manifest.credential_rotation_required, true);
  assert.equal(transfer.manifest.public_attribution_immutable, true);
  const duplicate = await sponsorResult(
    A,
    "POST",
    "/v1/sponsors/transfers",
    "sponsor.transfer.initiate",
    {
      fellow_id: movedId,
      target_sponsor_id: B,
      confirm: "initiate-fellow-transfer",
      step_up_authenticated_at: now(),
      directive_attestation: "no_directives",
    },
  );
  refusedWith(
    duplicate,
    /TRANSFER_PENDING_EXISTS/,
    "a second pending offer for the same Fellow is refused",
  );
  const accept = (sponsor, transferId) =>
    sponsorResult(
      sponsor,
      "POST",
      `/v1/sponsors/transfers/${transferId}/accept`,
      "sponsor.transfer.accept",
      {
        transfer_id: transferId,
        confirm: "accept-fellow-transfer",
        step_up_authenticated_at: now(),
      },
    );
  refusedWith(
    await accept(C, transfer.transfer_id),
    /TRANSFER_(NOT_FOUND|UNAUTHORIZED)/,
    "a third sponsor cannot accept",
  );
  const incoming = await sponsorCall(B, "GET", "/v1/sponsors/transfers", "sponsor.transfer.list");
  assert.ok(incoming.incoming.some((t) => t.transfer_id === transfer.transfer_id));

  // --- Accept: rotation, rebinding, immutable history ---
  const accepted = await accept(B, transfer.transfer_id);
  assert.equal(accepted.ok, true, accepted.error);
  refusedWith(
    await accept(B, transfer.transfer_id),
    /TRANSFER_NOT_PENDING/,
    "an accepted offer cannot be accepted again",
  );
  // The pre-transfer credential no longer works.
  await call("/v1/hello", undefined, moved, 401);
  const fellowRow = await env.DB.prepare(
    "SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id = ?",
  )
    .bind(movedId)
    .first();
  assert.equal(fellowRow.sponsor_id, B);
  const problemEvent = await env.DB.prepare(
    "SELECT actor_sponsor_id FROM events WHERE problem_id = ? ORDER BY seq LIMIT 1",
  )
    .bind(problem)
    .first();
  assert.ok(
    problemEvent === null || problemEvent.actor_sponsor_id !== B,
    "history keeps its sponsor",
  );

  // --- Reject and cancel leave the Fellow with its sponsor ---
  const toReject = await offer(keptId);
  const rejected = await sponsorResult(
    B,
    "POST",
    `/v1/sponsors/transfers/${toReject.transfer_id}/reject`,
    "sponsor.transfer.reject",
    {
      transfer_id: toReject.transfer_id,
      confirm: "reject-fellow-transfer",
      step_up_authenticated_at: now(),
    },
  );
  assert.equal(rejected.ok, true, rejected.error);
  // A rejected offer changes nothing.
  await call("/v1/hello", undefined, kept, 200);
  const toCancel = await offer(keptId);
  const cancelled = await sponsorResult(
    A,
    "POST",
    `/v1/sponsors/transfers/${toCancel.transfer_id}/cancel`,
    "sponsor.transfer.cancel",
    {
      transfer_id: toCancel.transfer_id,
      confirm: "cancel-fellow-transfer",
      step_up_authenticated_at: now(),
    },
  );
  assert.equal(cancelled.ok, true, cancelled.error);
  refusedWith(
    await accept(B, toCancel.transfer_id),
    /TRANSFER_NOT_PENDING/,
    "a cancelled offer cannot be accepted",
  );

  // --- Export, deletion preview, deletion ---
  const exported = SponsorAccountExportResponseSchema.parse(
    await sponsorCall(A, "GET", "/v1/sponsors/account/export", "sponsor.account.export"),
  );
  assert.ok(exported.fellows.some((fellow) => fellow.fellow_id === keptId));
  assert.ok(
    !exported.fellows.some((fellow) => fellow.fellow_id === movedId),
    "moved Fellow left A",
  );
  const preview = SponsorAccountDeletePreviewResponseSchema.parse(
    await sponsorCall(
      A,
      "GET",
      "/v1/sponsors/account/delete-preview",
      "sponsor.account.delete-preview",
    ),
  );
  assert.ok(preview.active_fellows_count >= 1);
  const deleted = SponsorAccountDeleteResponseSchema.parse(
    await sponsorCall(A, "POST", "/v1/sponsors/account/delete", "sponsor.account.delete", {
      confirm: "delete-sponsor-account-and-revoke-all-fellows",
      step_up_authenticated_at: now(),
    }),
  );
  assert.equal(deleted.acknowledged, true);
  // A's Fellows are revoked.
  await call("/v1/hello", undefined, kept, 401);
  const orphans = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM enrollment_fellows WHERE sponsor_id = ? AND status = 'active'",
  )
    .bind(A)
    .first();
  assert.equal(Number(orphans.n), 0, "no active Fellow remains under a deleted sponsor");
  // The public record still renders after deletion.
  await call(`/p/${problem}.json`, undefined, undefined, 200);

  console.log(
    JSON.stringify({
      stage: "identity-lifecycle-journey-passed",
      kind: "identity-lifecycle-real-bindings",
      status: "pass",
      boundary: "local Workerd/D1/R2; signed sponsor envelopes; no browser, OAuth or step-up UI",
    }),
  );
});
