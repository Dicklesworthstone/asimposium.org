import assert from "node:assert/strict";
import {
  ProblemStewardshipActionReceiptSchema,
  SponsorProblemGovernanceResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Real local Workerd/D1/R2 and signed sponsor requests. Identity and screening
// use the shared synthetic fixtures; this does not claim hosted OAuth proof.
await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, env, fixtures }) => {
  const alpha = "usr_stewardship_alpha",
    beta = "usr_stewardship_beta",
    gamma = "usr_stewardship_gamma";
  const token = await enroll("stewardship-author", alpha);
  await enroll("stewardship-beta", beta);
  await enroll("stewardship-gamma", gamma);
  const lifecycle = (id) => `/v1/sponsors/problems/${id}/lifecycle`;
  const governance = (id) => `/v1/sponsors/problems/${id}/governance`;
  const read = async (actor, id, suffix = "") =>
    SponsorProblemGovernanceResponseSchema.parse(
      await sponsorCall(actor, "GET", `${governance(id)}${suffix}`, "problem-governance-read"),
    );
  const command = async (actor, id, operation, target) => {
    const state = await read(actor, id);
    assert.ok(state.stewardship);
    return {
      action: "manage-steward",
      operation,
      target_sponsor_id: target,
      expected_stewardship_version: state.stewardship.version,
    };
  };
  const write = (actor, id, body, key, expected = 200) =>
    sponsorCall(actor, "POST", lifecycle(id), "problem-lifecycle", body, expected, undefined, key);
  const accepted = (body) => ProblemStewardshipActionReceiptSchema.parse(body.governance_action);
  const propose = async (name) =>
    (
      await call(
        "/v1/problems",
        {
          title: `Stewardship ${name}`,
          statement: `The ${name} stewardship formulation has an explicit finite domain.`,
          falsifier: `A finite ${name} counterexample violates the stated property.`,
          motivation: "Exercise accountable shared research governance.",
          areas: ["number-theory"],
        },
        token,
        201,
      )
    ).problem.id;

  const draft = await propose("private");
  const first = await read(alpha, draft);
  assert.equal(first.stewardship.accountable_sponsor_id, alpha);
  assert.deepEqual(
    first.stewardship.stewards.map((row) => [row.sponsor_id, row.is_founding]),
    [[alpha, true]],
  );
  await sponsorCall(beta, "GET", governance(draft), "problem-governance-read", undefined, 404);
  const add = await command(alpha, draft, "add", beta);
  const shared = accepted(await write(alpha, draft, add, "draft-share"));
  assert.equal(shared.event_id, null);
  assert.deepEqual(accepted(await write(alpha, draft, add, "draft-share")), shared);
  assert.equal(
    (await write(alpha, draft, { ...add, target_sponsor_id: gamma }, "stale-draft-add", 409)).code,
    "OBJECT_VERSION_CONFLICT",
  );
  assert.equal((await read(beta, draft)).authority.steward, true);

  const racePin = (await read(alpha, draft)).stewardship.version;
  const competing = await Promise.all([
    write(
      alpha,
      draft,
      {
        action: "manage-steward",
        operation: "add",
        target_sponsor_id: gamma,
        expected_stewardship_version: racePin,
      },
      "draft-race-add",
      [200, 409],
    ),
    write(
      alpha,
      draft,
      {
        action: "manage-steward",
        operation: "remove",
        target_sponsor_id: beta,
        expected_stewardship_version: racePin,
      },
      "draft-race-remove",
      [200, 409],
    ),
  ]);
  assert.equal(competing.filter((body) => body.governance_action).length, 1);
  assert.equal(competing.filter((body) => body.code === "OBJECT_VERSION_CONFLICT").length, 1);
  let state = await read(alpha, draft);
  if (!state.stewardship.stewards.some((row) => row.sponsor_id === beta)) {
    accepted(
      await write(alpha, draft, await command(alpha, draft, "add", beta), "draft-readd-beta"),
    );
  }
  state = await read(alpha, draft);
  if (state.stewardship.stewards.some((row) => row.sponsor_id === gamma)) {
    accepted(
      await write(alpha, draft, await command(alpha, draft, "remove", gamma), "draft-remove-gamma"),
    );
  }
  const transfer = await command(alpha, draft, "transfer", gamma);
  const transferred = accepted(await write(alpha, draft, transfer, "draft-transfer"));
  await sponsorCall(alpha, "GET", governance(draft), "problem-governance-read", undefined, 404);
  assert.deepEqual(accepted(await write(alpha, draft, transfer, "draft-transfer")), transferred);
  assert.equal(
    (await write(alpha, draft, { ...transfer, target_sponsor_id: beta }, "draft-transfer", 409))
      .code,
    "IDEMPOTENCY_CONFLICT",
  );
  await write(
    alpha,
    draft,
    { ...transfer, operation: "add", target_sponsor_id: alpha },
    "draft-new-after-transfer",
    403,
  );
  state = await read(gamma, draft);
  assert.equal(state.stewardship.accountable_sponsor_id, gamma);
  assert.equal(
    state.stewardship.stewards.some((row) => row.sponsor_id === alpha),
    false,
  );
  accepted(
    await write(gamma, draft, await command(gamma, draft, "remove", beta), "draft-remove-beta"),
  );
  await write(gamma, draft, await command(gamma, draft, "remove", gamma), "draft-remove-last", 422);
  console.log(JSON.stringify({ stage: "private-stewardship-replay-and-races", passed: true }));

  const published = await propose("public");
  await sponsorCall(alpha, "POST", lifecycle(published), "problem-lifecycle", {
    action: "publish",
  });
  accepted(
    await write(
      alpha,
      published,
      await command(alpha, published, "add", beta),
      "public-share-beta",
    ),
  );
  const sharedTransfer = await command(beta, published, "transfer", gamma);
  const duplicate = await Promise.all([
    write(beta, published, sharedTransfer, "public-shared-transfer"),
    write(beta, published, sharedTransfer, "public-shared-transfer"),
  ]);
  assert.deepEqual(accepted(duplicate[0]), accepted(duplicate[1]));
  assert.ok(accepted(duplicate[0]).event_id);
  for (const body of duplicate) {
    assert.deepEqual(Object.keys(body.problem).sort(), ["id", "updated_at"]);
    assert.equal(JSON.stringify(body).includes("statement"), false);
  }
  await sponsorCall(beta, "GET", governance(published), "problem-governance-read", undefined, 404);
  assert.deepEqual(
    accepted(await write(beta, published, sharedTransfer, "public-shared-transfer")),
    accepted(duplicate[0]),
  );
  await write(
    beta,
    published,
    { ...sharedTransfer, operation: "add", target_sponsor_id: beta },
    "public-new-after-transfer",
    403,
  );
  state = await read(alpha, published);
  assert.equal(state.stewardship.accountable_sponsor_id, alpha);
  assert.equal(
    state.stewardship.stewards.find((row) => row.sponsor_id === alpha).is_founding,
    true,
  );
  const removeFounder = await command(gamma, published, "remove", alpha);
  accepted(await write(gamma, published, removeFounder, "public-remove-founder"));
  state = await read(gamma, published);
  assert.equal(state.stewardship.accountable_sponsor_id, gamma);
  assert.equal(state.stewardship.stewards.length, 1);
  await write(
    gamma,
    published,
    await command(gamma, published, "remove", gamma),
    "public-remove-last",
    422,
  );
  const continued = await read(gamma, published, `/stewards/after/${encodeURIComponent(alpha)}`);
  assert.deepEqual(
    continued.stewardship.stewards.map((row) => row.sponsor_id),
    [gamma],
  );

  const before = await env.DB.prepare(
    "SELECT public_seq,stewardship_version,sponsor_id FROM problems WHERE id=?",
  )
    .bind(published)
    .first();
  const racedTransfer = await command(gamma, published, "transfer", beta);
  await fixtures.armRaceBeforeNextBatch(
    "UPDATE sponsors SET tombstoned_at=? WHERE sponsor_id=?",
    [new Date().toISOString(), beta],
    "INSERT INTO events",
  );
  assert.equal(
    (await write(gamma, published, racedTransfer, "public-target-became-inactive", 409)).code,
    "OBJECT_VERSION_CONFLICT",
  );
  assert.equal(await fixtures.raceStillArmed(), false);
  assert.deepEqual(
    await env.DB.prepare(
      "SELECT public_seq,stewardship_version,sponsor_id FROM problems WHERE id=?",
    )
      .bind(published)
      .first(),
    before,
  );
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM events WHERE problem_id=? AND type='problem.steward-updated'",
      )
        .bind(published)
        .first()
    ).n,
    3,
  );
  console.log(
    JSON.stringify({ stage: "public-stewardship-current-authority-and-recovery", passed: true }),
  );
});
