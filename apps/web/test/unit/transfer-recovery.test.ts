import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { stoaRebindUrl } from "@asimposium/contracts";
import {
  enrollmentRecoveryFingerprint,
  enrollmentRecoveryOwner,
  openEnrollmentRecoveryPayload,
  sealEnrollmentRecoveryPayload,
} from "../../lib/enrollment-recovery";
import {
  parseTransferIntent,
  TRANSFER_RECOVERY_SCOPE,
  type TransferIntent,
} from "../../lib/transfer-recovery";
import {
  clearEnrollmentAttempt,
  enrollmentAttemptKey,
  retainedEnrollmentAttempts,
} from "../../app/console/idempotency";

mock.module("server-only", () => ({}));
const source = "usr_transfer_source";
const target = "usr_transfer_target";
const fellow = "F-01JXYZ4K6Q";
const otherFellow = "F-01JXYZ4K6R";
const transferId = `TRF-${"0".repeat(26)}`;
const otherTransfer = `TRF-${"1".repeat(26)}`;
const rebindId = `ASIMP-RB-${"0".repeat(26)}`;
const otherRebind = `ASIMP-RB-${"1".repeat(26)}`;
const recoveryKey = "71".repeat(32);
const envelopeKey = "72".repeat(32);
const secret = `v1.${"A".repeat(43)}`;
const createdAt = Date.now();
const manifest = {
  fellow_id: fellow,
  name: "redshift",
  model: "provider/model-v1",
  harness: "codex",
  fellow_created_at: createdAt,
  status: "active",
  open_problem_memberships: ["P-TEST"],
  directive_disclosure_status: "unresolved",
  pre_transfer_directive_count: 1,
  private_workshop_access_moves: true,
  historical_directive_bodies_disclosed: false,
  credential_rotation_required: true,
  public_attribution_immutable: true,
};
const targetRef = {
  transfer_id: transferId,
  fellow_id: fellow,
  source_sponsor_id: source,
  target_sponsor_id: target,
};
const offer: TransferIntent = {
  kind: "offer",
  request: { fellow_id: fellow, target_sponsor_id: target, confirm: "initiate-fellow-transfer" },
};
const rebindCreate: TransferIntent = {
  kind: "rebind-create",
  request: { fellow_id: fellow, confirm: "rebind-transferred-fellow" },
};
const cases: readonly {
  readonly intent: TransferIntent;
  readonly actor: string;
  readonly response: Record<string, unknown>;
}[] = [
  {
    intent: offer,
    actor: source,
    response: {
      acknowledged: true,
      ...targetRef,
      status: "pending",
      created_at: createdAt,
      expires_at: createdAt + 86_400_000,
      manifest,
    },
  },
  {
    intent: { kind: "accept", transfer: targetRef },
    actor: target,
    response: {
      acknowledged: true,
      ...targetRef,
      effective_at: createdAt,
      revoked_credentials_count: 2,
      fellow_status: "paused",
      rebind_required: true,
    },
  },
  {
    intent: { kind: "reject", transfer: targetRef },
    actor: target,
    response: {
      acknowledged: true,
      transfer_id: transferId,
      status: "rejected",
      resolved_at: createdAt,
    },
  },
  {
    intent: { kind: "cancel", transfer: targetRef },
    actor: source,
    response: {
      acknowledged: true,
      transfer_id: transferId,
      status: "cancelled",
      resolved_at: createdAt,
    },
  },
  {
    intent: rebindCreate,
    actor: target,
    response: {
      rebind_id: rebindId,
      fellow_id: fellow,
      rebind_url: stoaRebindUrl("https://a.asimposium.org", rebindId, secret),
      secret,
      expires_at: createdAt + 1_800_000,
    },
  },
  ...(["approve", "deny"] as const).map((decision) => ({
    intent: {
      kind: "rebind-decision" as const,
      fellow_id: fellow,
      request: {
        rebind_id: rebindId,
        decision,
        confirm: "decide-fellow-rebind" as const,
      },
    },
    actor: target,
    response: {
      rebind_id: rebindId,
      fellow_id: fellow,
      status: decision === "approve" ? "approved" : "denied",
      decided_at: createdAt,
    },
  })),
];

let principal: string | null;
let authIssuedAt: number | undefined;
let reply: unknown;
let loseReply: boolean;
let loseRefresh: boolean;
const writes: {
  operation: string;
  principalId: string;
  request: Record<string, unknown>;
  key: string;
}[] = [];
let realAuth: typeof import("../../auth");
let realTransport: typeof import("../../lib/stoa");
let realCache: typeof import("next/cache");
let actions: typeof import("../../app/console/transfer-actions");
const originalRecoveryKey = process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX;
const originalEnvelopeKey = process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX;

const send =
  (operation: string) =>
  async (principalId: string, request: Record<string, unknown>, key: string) => {
    writes.push({ operation, principalId, request: structuredClone(request), key });
    if (loseReply) throw new Error("PRIVATE_TRANSPORT_CANARY");
    return reply;
  };
beforeAll(async () => {
  realAuth = { ...(await import("../../auth")) };
  realTransport = { ...(await import("../../lib/stoa")) };
  realCache = { ...(await import("next/cache")) };
  mock.module("@/auth", () => ({
    ...realAuth,
    auth: async () => (principal === null ? null : { user: { id: principal }, authIssuedAt }),
  }));
  mock.module("@/lib/stoa", () => ({
    ...realTransport,
    configuredStoaOrigin: () => "https://a.asimposium.org",
    stoaInitiateTransfer: send("offer"),
    stoaResolveTransfer: send("resolve"),
    stoaCreateRebind: send("rebind-create"),
    stoaDecideRebind: send("rebind-decision"),
  }));
  mock.module("next/cache", () => ({
    ...realCache,
    revalidatePath: () => {
      if (loseRefresh) throw new Error("CACHE_FAILED");
    },
  }));
  const path: string = "../../app/console/transfer-actions?transfer-recovery-test";
  actions = (await import(path)) as typeof actions;
});
beforeEach(() => {
  principal = source;
  authIssuedAt = Math.floor(Date.now() / 1000);
  process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX = recoveryKey;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = envelopeKey;
  reply = { ok: true, data: cases[0]?.response };
  loseReply = false;
  loseRefresh = false;
  writes.length = 0;
});
afterAll(() => {
  mock.module("@/auth", () => realAuth);
  mock.module("@/lib/stoa", () => realTransport);
  mock.module("next/cache", () => realCache);
  if (originalRecoveryKey === undefined) delete process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX;
  else process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX = originalRecoveryKey;
  if (originalEnvelopeKey === undefined) delete process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX;
  else process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = originalEnvelopeKey;
});

async function prepare(intent = offer, actor = source, key = "console-transfer-original") {
  principal = actor;
  const owner = await enrollmentRecoveryOwner(recoveryKey, actor);
  const prepared = await actions.prepareTransferAttempt(intent, actor, owner, key, true);
  if (!prepared.ok) throw new Error(prepared.message);
  return { ...prepared, actor, owner, key };
}
async function recover(prepared: Awaited<ReturnType<typeof prepare>>) {
  return actions.recoverTransferAttempt(
    prepared.recoveryPayload,
    prepared.key,
    prepared.actor,
    prepared.owner,
  );
}

test("transfer recovery normalizes shared contracts and never accepts client authentication or secret fields", () => {
  for (const fixture of cases) expect(parseTransferIntent(fixture.intent)).toEqual(fixture.intent);
  for (const raw of [
    null,
    [],
    { ...offer, extra: "private" },
    { ...offer, request: { ...offer.request, step_up_authenticated_at: 1 } },
    { ...offer, request: { ...offer.request, directive_attestation: "no_directives" } },
    { ...rebindCreate, request: { ...rebindCreate.request, secret } },
    { kind: "accept", transfer: { ...targetRef, manifest } },
    { kind: "accept", transfer: { ...targetRef, source_sponsor_id: target } },
  ])
    expect(parseTransferIntent(raw)).toBeUndefined();
});

test("each transfer and rebind operation reports only its matching authoritative receipt", async () => {
  for (const fixture of cases) {
    const prepared = await prepare(fixture.intent, fixture.actor);
    reply = { ok: true, data: fixture.response };
    loseRefresh = true;
    expect(await recover(prepared)).toMatchObject({
      ok: true,
      receipt: { kind: fixture.intent.kind },
    });
    expect(writes.at(-1)).toMatchObject({ principalId: fixture.actor, key: prepared.key });
    expect(writes.at(-1)?.request.step_up_authenticated_at).toBe(authIssuedAt);
  }
});

test("lost replies and reauthentication recover the same operation with its original key", async () => {
  for (const fixture of cases) {
    writes.length = 0;
    const prepared = await prepare(fixture.intent, fixture.actor);
    loseReply = true;
    const unknown = await recover(prepared);
    expect(unknown).toMatchObject({ ok: false, recovery: "retain" });
    expect(JSON.stringify(unknown)).not.toContain("PRIVATE_TRANSPORT_CANARY");
    const original = writes[0];
    authIssuedAt = Math.floor(Date.now() / 1000) - 2;
    loseReply = false;
    reply = { ok: true, data: fixture.response };
    expect(await recover(prepared)).toMatchObject({ ok: true });
    const retry = writes[1];
    expect(retry).toMatchObject({ key: prepared.key, principalId: fixture.actor });
    expect(retry?.request).toEqual({
      ...original?.request,
      step_up_authenticated_at: authIssuedAt,
    });
    const reopened = await openEnrollmentRecoveryPayload(
      recoveryKey,
      prepared.recoveryPayload,
      fixture.actor,
      TRANSFER_RECOVERY_SCOPE,
      Date.now(),
    );
    expect(reopened.request).toEqual(fixture.intent);
  }
});

test("wrong accounts, stale authentication, altered retry keys and ciphertext never dispatch", async () => {
  const prepared = await prepare();
  for (const account of [null, target, "person@example.invalid"]) {
    principal = account;
    expect(await recover(prepared)).toMatchObject({ ok: false, recovery: "retain" });
  }
  principal = source;
  for (const timestamp of [undefined, 0, Infinity, Math.floor(Date.now() / 1000) + 500]) {
    authIssuedAt = timestamp;
    expect(await recover(prepared)).toMatchObject({ ok: false, recovery: "retain" });
  }
  authIssuedAt = Math.floor(Date.now() / 1000);
  expect(await recover({ ...prepared, key: "console-replacement" })).toMatchObject({
    ok: false,
    recovery: "retain",
  });
  expect(
    await recover({ ...prepared, owner: await enrollmentRecoveryOwner(recoveryKey, target) }),
  ).toMatchObject({ ok: false, recovery: "retain" });
  expect(
    await recover({ ...prepared, recoveryPayload: prepared.recoveryPayload + "A" }),
  ).toMatchObject({ ok: false, recovery: "retain" });
  expect(writes).toHaveLength(0);
});

test("preparation requires confirmation and refuses the wrong sponsor's decision or a self-transfer", async () => {
  const owner = await enrollmentRecoveryOwner(recoveryKey, source);
  for (const intent of [
    { kind: "accept", transfer: targetRef },
    { kind: "reject", transfer: targetRef },
    { ...offer, request: { ...offer.request, target_sponsor_id: source } },
  ])
    expect(
      await actions.prepareTransferAttempt(intent, source, owner, "console-test", true),
    ).toMatchObject({ ok: false });
  expect(
    await actions.prepareTransferAttempt(offer, source, owner, "console-test", false),
  ).toMatchObject({ ok: false });
  expect(
    await actions.prepareTransferAttempt(offer, source, owner, "console-test\n", true),
  ).toMatchObject({ ok: false });
  expect(writes).toHaveLength(0);
});

test("well-formed but unrelated receipts never become a fabricated transfer success", async () => {
  const mutations = [
    [0, { fellow_id: otherFellow }],
    [0, { source_sponsor_id: target }],
    [0, { target_sponsor_id: source }],
    [0, { manifest: { ...manifest, fellow_id: otherFellow } }],
    [1, { transfer_id: otherTransfer }],
    [1, { fellow_id: otherFellow }],
    [1, { source_sponsor_id: target }],
    [1, { target_sponsor_id: source }],
    [2, { transfer_id: otherTransfer }],
    [2, { status: "cancelled" }],
    [3, { transfer_id: otherTransfer }],
    [3, { status: "rejected" }],
    [4, { fellow_id: otherFellow }],
    [4, { rebind_url: stoaRebindUrl("https://a-staging.asimposium.org", rebindId, secret) }],
    [4, { rebind_id: otherRebind }],
    [5, { rebind_id: otherRebind }],
    [5, { fellow_id: otherFellow }],
    [5, { status: "denied" }],
  ] as const;
  for (const [index, mutation] of mutations) {
    const fixture = cases[index];
    if (!fixture) throw new Error("Missing transfer fixture");
    const prepared = await prepare(fixture.intent, fixture.actor);
    reply = { ok: true, data: { ...fixture.response, ...mutation } };
    expect(await recover(prepared)).toMatchObject({ ok: false, recovery: "retain" });
  }
});

test("ambiguous and authentication refusals retain recovery while a definite expired transfer clears it", async () => {
  const prepared = await prepare();
  for (const failure of [
    { reason: "unreachable" },
    { reason: "unconfigured" },
    { reason: "refused", status: 403, problemCode: "STEP_UP_REQUIRED" },
    { reason: "refused", status: 401, problemCode: "UNAUTHORIZED" },
    { reason: "refused", status: 409, problemCode: "IDEMPOTENCY_CONFLICT" },
    { reason: "refused", status: 503, problemCode: "ENROLLMENT_UNAVAILABLE" },
  ]) {
    reply = { ok: false, ...failure };
    expect(await recover(prepared)).toMatchObject({ ok: false, recovery: "retain" });
  }
  reply = { ok: false, reason: "refused", status: 409, problemCode: "TRANSFER_EXPIRED" };
  expect(await recover(prepared)).toMatchObject({ ok: false, recovery: "clear" });
});

test("reload retains an encrypted rebind command, never the URL or its secret, until handoff acknowledgment", async () => {
  const prepared = await prepare(rebindCreate, target);
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
    removeItem: (key: string) => {
      saved.delete(key);
    },
  };
  enrollmentAttemptKey(
    TRANSFER_RECOVERY_SCOPE,
    prepared.fingerprint,
    prepared.recoveryPayload,
    prepared.serverNow,
    storage,
    new Map(),
    () => prepared.key,
    prepared.owner,
  );
  const [restored] = retainedEnrollmentAttempts(
    TRANSFER_RECOVERY_SCOPE,
    storage,
    new Map(),
    prepared.owner,
  );
  expect(restored).toMatchObject({ fingerprint: prepared.fingerprint, key: prepared.key });
  expect([...saved.values()].join(" ")).not.toContain(secret);
  expect([...saved.values()].join(" ")).not.toContain(fellow);
  expect([...saved.values()].join(" ")).not.toContain("https://a.asimposium.org/rebind/");
  reply = { ok: true, data: cases[4]?.response };
  expect(await recover(prepared)).toMatchObject({ ok: true, receipt: { rebindId } });
  expect(
    retainedEnrollmentAttempts(TRANSFER_RECOVERY_SCOPE, storage, new Map(), prepared.owner),
  ).toHaveLength(1);
  expect(
    clearEnrollmentAttempt(
      TRANSFER_RECOVERY_SCOPE,
      prepared.fingerprint,
      storage,
      new Map(),
      prepared.owner,
    ),
  ).toBe(true);
  expect(
    retainedEnrollmentAttempts(TRANSFER_RECOVERY_SCOPE, storage, new Map(), prepared.owner),
  ).toHaveLength(0);
});

test("expired sealed attempts cannot be turned into fresh transfers", async () => {
  const prepared = await prepare();
  const expired = await sealEnrollmentRecoveryPayload(recoveryKey, {
    sponsorId: source,
    scope: TRANSFER_RECOVERY_SCOPE,
    fingerprint: await enrollmentRecoveryFingerprint(
      recoveryKey,
      source,
      TRANSFER_RECOVERY_SCOPE,
      offer,
    ),
    idempotencyKey: prepared.key,
    expiresAt: Date.now() - 1,
    request: offer,
  });
  expect(await recover({ ...prepared, recoveryPayload: expired })).toMatchObject({
    ok: false,
    recovery: "retain",
  });
  expect(writes).toHaveLength(0);
});
