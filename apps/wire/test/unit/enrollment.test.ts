import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { MintEnrollmentRequest } from "@asimposium/contracts";

import {
  AesGcmEnrollmentReplayProtector,
  DEVICE_CODE_TTL_MS,
  DEVICE_LOOKUP_LOCKOUT_WINDOW_MS,
  DEVICE_START_RATE_LIMIT_ATTEMPTS,
  DEVICE_START_RATE_LIMIT_WINDOW_MS,
  EnrollmentError,
  EnrollmentPersistenceError,
  type EnrollmentRandom,
  EnrollmentReplayConfigurationError,
  EnrollmentService,
  type EnrollmentStore,
  InMemoryEnrollmentStore,
  safeEnrollmentDiagnostic,
} from "../../src/enrollment/service.ts";

class MutableClock {
  value = 1_700_000_000_000;

  now(): number {
    return this.value;
  }
}

class DeterministicRandom {
  #next = 1;

  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => {
      const value = this.#next;
      this.#next = (this.#next + 1) % 256;
      return value;
    });
  }
}

const sponsor = { type: "sponsor", sponsorId: "sponsor-opaque-1" } as const;
const otherSponsor = { type: "sponsor", sponsorId: "sponsor-opaque-2" } as const;
const fellow = { type: "fellow", fellowId: "fellow-opaque-1" } as const;
const malformedSecret = ["v1", "short"].join(".");
const wrongSecret = `v1.${"A".repeat(43)}`;
const nonCredentialFlowHandle = `flow_v1.${"A".repeat(43)}`;
const deviceProposal = {
  name: "device-orchid",
  model: "test-model",
  harness: "test-harness",
  requested_scopes: ["review"],
} as const;
const deviceStartOptions = { trustedClientAddress: "198.51.100.7" } as const;

function serviceFixture() {
  const clock = new MutableClock();
  const store = new InMemoryEnrollmentStore();
  const random = new DeterministicRandom();
  return {
    clock,
    store,
    service: new EnrollmentService({
      clock,
      store,
      random,
      replayProtector: new AesGcmEnrollmentReplayProtector(
        Uint8Array.from({ length: 32 }, (_value, index) => index),
        random,
      ),
    }),
  };
}

function storeProxy(
  base: InMemoryEnrollmentStore,
  overrides: Partial<EnrollmentStore>,
): EnrollmentStore {
  return new Proxy(base, {
    get(target, property) {
      const override = overrides[property as keyof EnrollmentStore];
      if (override !== undefined) return override;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as EnrollmentStore;
}

async function mintAndClaim(
  service: EnrollmentService,
  name = "orchid-vector",
): Promise<{ enrollmentId: string; secret: string; flowHandle: string }> {
  const minted = await service.mint(sponsor, {
    requested_scopes: ["promote", "review"],
    problem_binding: "P-4DSP",
    first_directive: "Check the falsifier before promotion.",
    event_budget: 12,
    artifact_budget_bytes: 4_096,
    fellow_grant_expires_in_ms: 86_400_000,
  });
  const claim = await service.claim({
    enrollment_id: minted.enrollmentId,
    secret: minted.secret,
    name,
    model: "test-model",
    harness: "test-harness",
  });
  return { enrollmentId: minted.enrollmentId, secret: minted.secret, flowHandle: claim.flowHandle };
}

async function expectEnrollmentError(
  promise: Promise<unknown>,
  code: EnrollmentError["code"],
): Promise<EnrollmentError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EnrollmentError);
    expect((error as EnrollmentError).code).toBe(code);
    return error as EnrollmentError;
  }
  throw new Error(`expected EnrollmentError ${code}`);
}

describe("S-1 enrollment state machine", () => {
  test("device codes use unbiased rejection sampling and bound a broken random source", async () => {
    class TailThenLowRandom implements EnrollmentRandom {
      #userBatches = 0;

      bytes(length: number): Uint8Array {
        if (length !== 8) return new Uint8Array(length);
        this.#userBatches += 1;
        return this.#userBatches === 1
          ? Uint8Array.from({ length }, (_value, index) => 240 + index)
          : Uint8Array.from({ length }, (_value, index) => index);
      }
    }
    const tailThenLow = new TailThenLowRandom();
    const sampled = new EnrollmentService({
      store: new InMemoryEnrollmentStore(),
      random: tailThenLow,
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    expect((await sampled.deviceStart(deviceProposal, deviceStartOptions)).user_code).toBe(
      "ABCD-EFGH",
    );

    const broken: EnrollmentRandom = { bytes: (length) => new Uint8Array(length).fill(255) };
    const unavailable = new EnrollmentService({
      store: new InMemoryEnrollmentStore(),
      random: broken,
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    await expect(unavailable.deviceStart(deviceProposal, deviceStartOptions)).rejects.toEqual(
      new TypeError("secure random source could not produce a device user code"),
    );
  });

  test("a memory-store user-code collision neither overwrites nor retargets the first proposal", async () => {
    class SameUserCodeRandom implements EnrollmentRandom {
      #call = 1;

      bytes(length: number): Uint8Array {
        if (length === 8) return new Uint8Array(length);
        const value = this.#call;
        this.#call = (this.#call + 1) % 240;
        return new Uint8Array(length).fill(value);
      }
    }
    const random = new SameUserCodeRandom();
    const service = new EnrollmentService({
      store: new InMemoryEnrollmentStore(),
      random,
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    const first = await service.deviceStart(deviceProposal, deviceStartOptions);
    await expect(
      service.deviceStart({ ...deviceProposal, name: "second-device-orchid" }, deviceStartOptions),
    ).rejects.toBeInstanceOf(EnrollmentPersistenceError);
    await expect(
      service.deviceLookup(sponsor, { user_code: first.user_code }),
    ).resolves.toMatchObject({ name: deviceProposal.name });
  });

  test("device starts are source-bounded and exact idempotency replay consumes no new slot", async () => {
    const { clock, service } = serviceFixture();
    const idempotentOptions = {
      trustedClientAddress: "198.51.100.20",
      idempotencyKey: "device-start-replay-0001",
    } as const;
    const original = await service.deviceStart(deviceProposal, idempotentOptions);
    await expect(service.deviceStart(deviceProposal, idempotentOptions)).resolves.toEqual(original);
    await expectEnrollmentError(
      service.deviceStart(
        { ...deviceProposal, name: "changed-device-proposal" },
        idempotentOptions,
      ),
      "IDEMPOTENCY_CONFLICT",
    );

    for (let index = 1; index < DEVICE_START_RATE_LIMIT_ATTEMPTS; index += 1) {
      await service.deviceStart(
        { ...deviceProposal, name: `source-bounded-${index}` },
        { trustedClientAddress: idempotentOptions.trustedClientAddress },
      );
    }
    await expectEnrollmentError(
      service.deviceStart(
        { ...deviceProposal, name: "source-bounded-refused" },
        { trustedClientAddress: idempotentOptions.trustedClientAddress },
      ),
      "DEVICE_START_RATE_LIMITED",
    );
    await expect(
      service.deviceStart(
        { ...deviceProposal, name: "independent-source" },
        { trustedClientAddress: "198.51.100.21" },
      ),
    ).resolves.toMatchObject({ expires_in_seconds: 30 * 60 });

    clock.value += DEVICE_START_RATE_LIMIT_WINDOW_MS + 1;
    await expect(
      service.deviceStart(
        { ...deviceProposal, name: "source-window-reopened" },
        { trustedClientAddress: idempotentOptions.trustedClientAddress },
      ),
    ).resolves.toMatchObject({ expires_in_seconds: 30 * 60 });
  });

  test("an ambiguous device-start persistence failure is never retried with fresh authority", async () => {
    const base = new InMemoryEnrollmentStore();
    let createCalls = 0;
    const store = storeProxy(base, {
      deviceCreate: async () => {
        createCalls += 1;
        throw new EnrollmentPersistenceError();
      },
    });
    const service = new EnrollmentService({
      store,
      random: new DeterministicRandom(),
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });

    await expect(service.deviceStart(deviceProposal, deviceStartOptions)).rejects.toBeInstanceOf(
      EnrollmentPersistenceError,
    );
    expect(createCalls).toBe(1);
  });

  test("concurrent invalid human-code attempts persist at most five failures", async () => {
    const { clock, service } = serviceFixture();
    const started = await service.deviceStart(deviceProposal, deviceStartOptions);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () => service.deviceLookup(sponsor, { user_code: "AAAA-AAAA" })),
    );
    const codes = outcomes
      .map((outcome) =>
        outcome.status === "rejected" && outcome.reason instanceof EnrollmentError
          ? outcome.reason.code
          : "UNEXPECTED_SUCCESS",
      )
      .sort();
    expect(codes).toEqual([
      "DEVICE_CODE_UNKNOWN",
      "DEVICE_CODE_UNKNOWN",
      "DEVICE_CODE_UNKNOWN",
      "DEVICE_CODE_UNKNOWN",
      "DEVICE_CODE_UNKNOWN",
      "DEVICE_LOOKUP_LOCKED",
    ]);
    await expectEnrollmentError(
      service.deviceLookup(sponsor, { user_code: started.user_code }),
      "DEVICE_LOOKUP_LOCKED",
    );

    clock.value += DEVICE_LOOKUP_LOCKOUT_WINDOW_MS + 1;
    await expect(
      service.deviceLookup(sponsor, { user_code: started.user_code }),
    ).resolves.toMatchObject({ name: deviceProposal.name });
  });

  test("device user codes remain usable for exactly the Fable thirty-minute window", async () => {
    const { clock, service } = serviceFixture();
    const started = await service.deviceStart(deviceProposal, deviceStartOptions);
    expect(started.expires_in_seconds).toBe(30 * 60);
    clock.value += DEVICE_CODE_TTL_MS - 1;
    await expect(
      service.deviceLookup(sponsor, { user_code: started.user_code }),
    ).resolves.toMatchObject({ name: deviceProposal.name });
    clock.value += 1;
    await expectEnrollmentError(
      service.deviceLookup(sponsor, { user_code: started.user_code }),
      "DEVICE_CODE_UNKNOWN",
    );
  });

  test("device lookup never exposes a card after its requested Fellow grant expires", async () => {
    const clock = new MutableClock();
    const base = new InMemoryEnrollmentStore();
    let enrollmentId = "";
    const store = storeProxy(base, {
      deviceCreate: async (input, idempotency) => {
        enrollmentId = input.record.enrollmentId;
        await base.deviceCreate(
          {
            ...input,
            record: {
              ...input.record,
              requestedResources: { fellowGrantExpiresAt: clock.value + 1 },
            },
          },
          idempotency,
        );
      },
    });
    const service = new EnrollmentService({
      clock,
      store,
      random: new DeterministicRandom(),
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    const started = await service.deviceStart(deviceProposal, deviceStartOptions);

    clock.value += 1;
    await expectEnrollmentError(
      service.deviceLookup(sponsor, { user_code: started.user_code }),
      "DEVICE_CODE_UNKNOWN",
    );
    await expect(
      base.deviceApprovalCardForDecision(enrollmentId, clock.value),
    ).resolves.toMatchObject({
      status: "expired",
    });
  });

  test("the high-entropy device poll handle expires at the same exclusive boundary", async () => {
    const { clock, service } = serviceFixture();
    const started = await service.deviceStart(deviceProposal, deviceStartOptions);

    clock.value += DEVICE_CODE_TTL_MS - 1;
    expect(await service.poll({ flow_handle: started.device_code })).toEqual({
      status: "authorization_pending",
      retry_after_seconds: 5,
    });

    clock.value += 1;
    expect(await service.poll({ flow_handle: started.device_code })).toEqual({
      status: "expired_token",
    });
  });

  test("a sponsor cannot approve a card retained past the device-code boundary", async () => {
    const { clock, service } = serviceFixture();
    const started = await service.deviceStart(deviceProposal, deviceStartOptions);
    const card = await service.deviceLookup(sponsor, { user_code: started.user_code });

    clock.value += DEVICE_CODE_TTL_MS;
    await expectEnrollmentError(
      service.decide(sponsor, card.enrollmentId, {
        enrollment_id: card.enrollmentId,
        decision: "approve",
      }),
      "WRONG_PRINCIPAL",
    );
    expect(await service.poll({ flow_handle: started.device_code })).toEqual({
      status: "expired_token",
    });
  });

  test("an operational device-card fallback failure is not rewritten as wrong-principal", async () => {
    const base = new InMemoryEnrollmentStore();
    const store = storeProxy(base, {
      deviceApprovalCardForDecision: async () => {
        throw new EnrollmentPersistenceError();
      },
    });
    const service = new EnrollmentService({
      store,
      random: new DeterministicRandom(),
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    const started = await service.deviceStart(deviceProposal, deviceStartOptions);
    const card = await service.deviceLookup(sponsor, { user_code: started.user_code });

    await expect(
      service.decide(sponsor, card.enrollmentId, {
        enrollment_id: card.enrollmentId,
        decision: "approve",
      }),
    ).rejects.toBeInstanceOf(EnrollmentPersistenceError);
  });

  test("mints a 256-bit fragment secret, stores only hashes, and issues one token after approval", async () => {
    const { service, store } = serviceFixture();
    const { enrollmentId, secret, flowHandle } = await mintAndClaim(service);

    expect(secret).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);
    expect(flowHandle).toMatch(/^flow_v1\.[A-Za-z0-9_-]{43}$/);
    expect(await service.poll({ flow_handle: flowHandle })).toEqual({
      status: "authorization_pending",
      retry_after_seconds: 5,
    });

    const card = await service.approvalCard(sponsor, enrollmentId);
    expect(card).toMatchObject({
      enrollmentId,
      status: "pending",
      name: "orchid-vector",
      requestedScopes: ["promote", "review"],
      requestedResources: {
        problemBinding: "P-4DSP",
        eventBudget: 12,
        artifactBudgetBytes: 4_096,
      },
      effectiveGrantedScopes: null,
      effectiveGrantedResources: null,
    });
    await service.decide(sponsor, enrollmentId, {
      enrollment_id: enrollmentId,
      decision: "reduce",
      reduction: {
        scopes: ["review"],
        event_budget: 6,
        artifact_budget_bytes: 2_048,
        fellow_grant_expires_in_ms: 43_200_000,
      },
    });

    await expect(service.approvalCard(sponsor, enrollmentId)).resolves.toMatchObject({
      status: "reduced",
      requestedScopes: ["promote", "review"],
      effectiveGrantedScopes: ["review"],
      effectiveGrantedResources: {
        problemBinding: "P-4DSP",
        eventBudget: 6,
        artifactBudgetBytes: 2_048,
      },
    });

    const approved = await service.poll({ flow_handle: flowHandle });
    expect(approved.status).toBe("approved");
    if (approved.status === "approved") {
      expect(approved.token).toMatch(/^asimp_ag_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$/);
      expect(approved.hello_url).toBe("https://a.asimposium.org/v1/hello");
      expect(await service.credentialBinding(approved.token)).toMatchObject({
        sponsorId: sponsor.sponsorId,
        name: "orchid-vector",
        grantedScopes: ["review"],
        grantedResources: {
          problemBinding: "P-4DSP",
          eventBudget: 6,
          artifactBudgetBytes: 2_048,
        },
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    }

    const snapshot = await store.storageSnapshot(enrollmentId);
    const stored = JSON.stringify(snapshot);
    expect(snapshot?.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot?.flowHandleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(flowHandle);
    if (approved.status === "approved") expect(stored).not.toContain(approved.token);

    await expectEnrollmentError(service.poll({ flow_handle: flowHandle }), "TOKEN_ALREADY_ISSUED");
  });

  test("one concurrent claim burns the one-time secret and every replay loses", async () => {
    const { service } = serviceFixture();
    const minted = await service.mint(sponsor, { requested_scopes: ["review"] });
    const body = {
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "vector-orchid",
      model: "test-model",
      harness: "test-harness",
    } as const;

    const outcomes = await Promise.allSettled([service.claim(body), service.claim(body)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: "PAIRING_INVALID" });
  });

  test("expiry, wrong-principal, and deny outcomes fail closed", async () => {
    const { clock, service } = serviceFixture();
    const expired = await service.mint(sponsor, { requested_scopes: ["review"], expires_in_ms: 1 });
    clock.value += 1;
    await expectEnrollmentError(
      service.claim({
        enrollment_id: expired.enrollmentId,
        secret: expired.secret,
        name: "expired-orchid",
        model: "test-model",
        harness: "test-harness",
      }),
      "PAIRING_INVALID",
    );

    const { enrollmentId, flowHandle } = await mintAndClaim(service, "deny-orchid");
    await expectEnrollmentError(service.approvalCard(fellow, enrollmentId), "WRONG_PRINCIPAL");
    await expectEnrollmentError(
      service.decide(otherSponsor, enrollmentId, { enrollment_id: enrollmentId, decision: "deny" }),
      "WRONG_PRINCIPAL",
    );
    await service.decide(sponsor, enrollmentId, { enrollment_id: enrollmentId, decision: "deny" });
    expect(await service.poll({ flow_handle: flowHandle })).toEqual({ status: "access_denied" });
  });

  test("proposal approval remains valid after the consumed join secret expires, until proposal expiry", async () => {
    const { clock, service } = serviceFixture();
    const minted = await service.mint(sponsor, { requested_scopes: ["review"], expires_in_ms: 1 });
    const claim = await service.claim({
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "proposal-orchid",
      model: "test-model",
      harness: "test-harness",
    });
    clock.value += 2;
    await service.decide(sponsor, minted.enrollmentId, {
      enrollment_id: minted.enrollmentId,
      decision: "approve",
    });
    expect((await service.poll({ flow_handle: claim.flowHandle })).status).toBe("approved");
  });

  test("RFC8628 pacing caps slow_down and decays after a quiet period", async () => {
    const { clock, service } = serviceFixture();
    const { flowHandle } = await mintAndClaim(service, "paced-orchid");
    expect(await service.poll({ flow_handle: flowHandle })).toEqual({
      status: "authorization_pending",
      retry_after_seconds: 5,
    });
    clock.value += 1_000;
    expect(await service.poll({ flow_handle: flowHandle })).toEqual({
      status: "slow_down",
      retry_after_seconds: 10,
    });
    for (const expected of [15, 20, 25, 30, 30, 30]) {
      clock.value += 1_000;
      expect(await service.poll({ flow_handle: flowHandle })).toEqual({
        status: "slow_down",
        retry_after_seconds: expected,
      });
    }
    clock.value += 60_000;
    expect(await service.poll({ flow_handle: flowHandle })).toEqual({
      status: "authorization_pending",
      retry_after_seconds: 25,
    });
  });

  test("one stable poll key advances from transient observations to every terminal outcome", async () => {
    {
      const { clock, service } = serviceFixture();
      const { enrollmentId, flowHandle } = await mintAndClaim(
        service,
        "stable-poll-approve-orchid",
      );
      const options = { idempotencyKey: "stable-poll-approve-1" } as const;
      expect(await service.poll({ flow_handle: flowHandle }, options)).toEqual({
        status: "authorization_pending",
        retry_after_seconds: 5,
      });
      clock.value += 1_000;
      expect(await service.poll({ flow_handle: flowHandle }, options)).toEqual({
        status: "slow_down",
        retry_after_seconds: 10,
      });
      await service.decide(sponsor, enrollmentId, {
        enrollment_id: enrollmentId,
        decision: "approve",
      });
      const approved = await service.poll({ flow_handle: flowHandle }, options);
      expect(approved.status).toBe("approved");
      expect(await service.poll({ flow_handle: flowHandle }, options)).toEqual(approved);
    }

    {
      const { service } = serviceFixture();
      const { enrollmentId, flowHandle } = await mintAndClaim(service, "stable-poll-deny-orchid");
      const options = { idempotencyKey: "stable-poll-deny-1" } as const;
      expect((await service.poll({ flow_handle: flowHandle }, options)).status).toBe(
        "authorization_pending",
      );
      await service.decide(sponsor, enrollmentId, {
        enrollment_id: enrollmentId,
        decision: "deny",
      });
      expect(await service.poll({ flow_handle: flowHandle }, options)).toEqual({
        status: "access_denied",
      });
      expect(await service.poll({ flow_handle: flowHandle }, options)).toEqual({
        status: "access_denied",
      });
    }

    {
      const { clock, service } = serviceFixture();
      const started = await service.deviceStart(
        { ...deviceProposal, name: "stable-poll-expire-orchid" },
        { trustedClientAddress: "198.51.100.30" },
      );
      const options = { idempotencyKey: "stable-poll-expire-1" } as const;
      expect((await service.poll({ flow_handle: started.device_code }, options)).status).toBe(
        "authorization_pending",
      );
      clock.value += DEVICE_CODE_TTL_MS;
      expect(await service.poll({ flow_handle: started.device_code }, options)).toEqual({
        status: "expired_token",
      });
      expect(await service.poll({ flow_handle: started.device_code }, options)).toEqual({
        status: "expired_token",
      });
    }
  });

  test("approval double-post and flow-poll race yield exactly one credential", async () => {
    const { service } = serviceFixture();
    const { enrollmentId, flowHandle } = await mintAndClaim(service, "race-orchid");

    const approvals = await Promise.allSettled([
      service.decide(sponsor, enrollmentId, { enrollment_id: enrollmentId, decision: "approve" }),
      service.decide(sponsor, enrollmentId, { enrollment_id: enrollmentId, decision: "approve" }),
    ]);
    expect(approvals.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);

    const polls = await Promise.allSettled([
      service.poll({ flow_handle: flowHandle }),
      service.poll({ flow_handle: flowHandle }),
    ]);
    const issued = polls.filter(
      (outcome) => outcome.status === "fulfilled" && outcome.value.status === "approved",
    );
    expect(issued).toHaveLength(1);
    const rejected = polls.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ code: "TOKEN_ALREADY_ISSUED" });
    }
  });

  test("same-key concurrent terminal polls converge on the one issued credential", async () => {
    const base = new InMemoryEnrollmentStore();
    let preflightReaders = 0;
    let releasePreflights: (() => void) | undefined;
    const bothPreflightsRead = new Promise<void>((resolve) => {
      releasePreflights = resolve;
    });
    const store = storeProxy(base, {
      idempotencyReplay: async (attempt) => {
        const replay = await base.idempotencyReplay(attempt);
        preflightReaders += 1;
        if (preflightReaders === 2) releasePreflights?.();
        await bothPreflightsRead;
        return replay;
      },
    });
    const random = new DeterministicRandom();
    const service = new EnrollmentService({
      store,
      random,
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32), random),
    });
    const { enrollmentId, flowHandle } = await mintAndClaim(service, "poll-race-replay-orchid");
    await service.decide(sponsor, enrollmentId, {
      enrollment_id: enrollmentId,
      decision: "approve",
    });
    const options = { idempotencyKey: "poll-race-replay-1" } as const;
    const results = await Promise.all([
      service.poll({ flow_handle: flowHandle }, options),
      service.poll({ flow_handle: flowHandle }, options),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.status).toBe("approved");
    expect(preflightReaders).toBeGreaterThanOrEqual(3);
  });

  test("reduce rejects escalations and only allows strictly narrower resource grants", async () => {
    const { service } = serviceFixture();
    const { enrollmentId } = await mintAndClaim(service, "reduce-orchid");

    await expectEnrollmentError(
      service.decide(sponsor, enrollmentId, {
        enrollment_id: enrollmentId,
        decision: "reduce",
        reduction: { scopes: ["upload-artifacts"] },
      }),
      "SCOPE_ESCALATION",
    );
    await expectEnrollmentError(
      service.decide(sponsor, enrollmentId, {
        enrollment_id: enrollmentId,
        decision: "reduce",
        reduction: { event_budget: 12 },
      }),
      "SCOPE_NOT_REDUCED",
    );
    await service.decide(sponsor, enrollmentId, {
      enrollment_id: enrollmentId,
      decision: "reduce",
      reduction: { problem_binding: null, first_directive: null, event_budget: 11 },
    });
  });

  test("finite sponsor limits strictly reduce a previously unbounded grant", async () => {
    const { clock, service } = serviceFixture();
    const minted = await service.mint(sponsor, { requested_scopes: ["review"] });
    const claim = await service.claim({
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "bounded-orchid",
      model: "test-model",
      harness: "test-harness",
    });

    await expect(
      service.decide(sponsor, minted.enrollmentId, {
        enrollment_id: minted.enrollmentId,
        decision: "reduce",
        reduction: {
          event_budget: 20,
          artifact_budget_bytes: 1_048_576,
          fellow_grant_expires_in_ms: 86_400_000,
        },
      }),
    ).resolves.toBeUndefined();
    const result = await service.poll({ flow_handle: claim.flowHandle });
    expect(result).toMatchObject({ status: "approved" });
    expect(await service.fellows(sponsor)).toMatchObject([
      {
        name: "bounded-orchid",
        grantedResources: {
          eventBudget: 20,
          artifactBudgetBytes: 1_048_576,
          fellowGrantExpiresAt: clock.value + 86_400_000,
        },
        credentials: [{ active: true }],
      },
    ]);
  });

  test("simultaneous same-name approvals allow one immutable Fellow binding", async () => {
    const { service } = serviceFixture();
    const first = await mintAndClaim(service, "shared-orchid");
    const second = await mintAndClaim(service, "shared-orchid");
    const outcomes = await Promise.allSettled([
      service.decide(sponsor, first.enrollmentId, {
        enrollment_id: first.enrollmentId,
        decision: "approve",
      }),
      service.decide(sponsor, second.enrollmentId, {
        enrollment_id: second.enrollmentId,
        decision: "approve",
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(
      (outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason,
    ).toMatchObject({
      code: "NAME_TAKEN",
    });
  });

  test("regenerating invalidates an unused predecessor and mint replay returns the encrypted original", async () => {
    const { service } = serviceFixture();
    const original = await service.mint(sponsor, { requested_scopes: ["review"] });
    const replacement = await service.mint(sponsor, {
      requested_scopes: ["review"],
      replaces_enrollment_id: original.enrollmentId,
    });
    await expectEnrollmentError(
      service.claim({
        enrollment_id: original.enrollmentId,
        secret: original.secret,
        name: "superseded-orchid",
        model: "test-model",
        harness: "test-harness",
      }),
      "PAIRING_INVALID",
    );
    const mintKey = "mint-idempotency-1";
    const first = await service.mint(
      sponsor,
      { requested_scopes: ["review"] },
      { idempotencyKey: mintKey },
    );
    await expect(
      service.mint(sponsor, { requested_scopes: ["review"] }, { idempotencyKey: mintKey }),
    ).resolves.toEqual(first);
    await expectEnrollmentError(
      service.mint(sponsor, { requested_scopes: ["promote"] }, { idempotencyKey: mintKey }),
      "IDEMPOTENCY_CONFLICT",
    );
    expect(replacement.secret).toMatch(/^v1\./);
  });

  test("lost-response recovery replays the original claim, decision, and one-time token", async () => {
    const { service } = serviceFixture();
    const minted = await service.mint(sponsor, { requested_scopes: ["review"] });
    const claimBody = {
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "idempotent-orchid",
      model: "test-model",
      harness: "test-harness",
    } as const;
    const claim = await service.claim(claimBody, { idempotencyKey: "claim-idempotency-1" });
    await expect(
      service.claim(claimBody, { idempotencyKey: "claim-idempotency-1" }),
    ).resolves.toEqual(claim);
    await expect(
      service.decide(
        sponsor,
        minted.enrollmentId,
        { enrollment_id: minted.enrollmentId, decision: "approve" },
        { idempotencyKey: "decision-idempotency-1" },
      ),
    ).resolves.toBeUndefined();
    await service.decide(
      sponsor,
      minted.enrollmentId,
      { enrollment_id: minted.enrollmentId, decision: "approve" },
      { idempotencyKey: "decision-idempotency-1" },
    );
    const issued = await service.poll(
      { flow_handle: claim.flowHandle },
      { idempotencyKey: "poll-idempotency-1" },
    );
    expect(issued.status).toBe("approved");
    await expect(
      service.poll({ flow_handle: claim.flowHandle }, { idempotencyKey: "poll-idempotency-1" }),
    ).resolves.toEqual(issued);
  });

  test("same-key concurrent first claim writers converge on one encrypted replay", async () => {
    const { service } = serviceFixture();
    const minted = await service.mint(sponsor, { requested_scopes: ["review"] });
    const body = {
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "race-replay-orchid",
      model: "test-model",
      harness: "test-harness",
    } as const;
    const results = await Promise.all([
      service.claim(body, { idempotencyKey: "claim-race-1" }),
      service.claim(body, { idempotencyKey: "claim-race-1" }),
    ]);
    expect(results[0]).toEqual(results[1]);
  });

  test("same-key concurrent decisions converge after both callers read pending state", async () => {
    const base = new InMemoryEnrollmentStore();
    let cardReaders = 0;
    let releaseReaders: (() => void) | undefined;
    const bothRead = new Promise<void>((resolve) => {
      releaseReaders = resolve;
    });
    const store = storeProxy(base, {
      approvalCard: async (enrollmentId, sponsorId, now) => {
        const card = await base.approvalCard(enrollmentId, sponsorId, now);
        cardReaders += 1;
        if (cardReaders === 2) releaseReaders?.();
        await bothRead;
        return card;
      },
    });
    const service = new EnrollmentService({
      store,
      random: new DeterministicRandom(),
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    const { enrollmentId } = await mintAndClaim(service, "decision-race-orchid");
    const decision = { enrollment_id: enrollmentId, decision: "approve" } as const;

    const outcomes = await Promise.all([
      service.decide(sponsor, enrollmentId, decision, { idempotencyKey: "decision-race-1" }),
      service.decide(sponsor, enrollmentId, decision, { idempotencyKey: "decision-race-1" }),
    ]);

    expect(outcomes).toEqual([undefined, undefined]);
    expect(cardReaders).toBe(2);
  });

  test("same-key concurrent device decisions converge across the two-card fallback race", async () => {
    const base = new InMemoryEnrollmentStore();
    let deviceReaders = 0;
    let firstReaderArrived: (() => void) | undefined;
    let releaseFirstReader: (() => void) | undefined;
    const firstReader = new Promise<void>((resolve) => {
      firstReaderArrived = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirstReader = resolve;
    });
    const store = storeProxy(base, {
      deviceApprovalCardForDecision: async (enrollmentId, now) => {
        deviceReaders += 1;
        if (deviceReaders === 1) {
          firstReaderArrived?.();
          await release;
        }
        return base.deviceApprovalCardForDecision(enrollmentId, now);
      },
    });
    const service = new EnrollmentService({
      store,
      random: new DeterministicRandom(),
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    const started = await service.deviceStart(deviceProposal, deviceStartOptions);
    const card = await service.deviceLookup(sponsor, { user_code: started.user_code });
    const decision = { enrollment_id: card.enrollmentId, decision: "approve" } as const;
    const delayed = service.decide(sponsor, card.enrollmentId, decision, {
      idempotencyKey: "device-decision-fallback-race-1",
    });

    await firstReader;
    await service.decide(sponsor, card.enrollmentId, decision, {
      idempotencyKey: "device-decision-fallback-race-1",
    });
    releaseFirstReader?.();

    await expect(delayed).resolves.toBeUndefined();
    expect(deviceReaders).toBe(2);
  });

  test("replay protection is required, stable across isolates, and decrypt failure is operational", async () => {
    expect(() => new EnrollmentService()).toThrow(EnrollmentReplayConfigurationError);

    const clock = new MutableClock();
    const store = new InMemoryEnrollmentStore();
    const key = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);
    const first = new EnrollmentService({
      clock,
      store,
      random: new DeterministicRandom(),
      replayProtector: new AesGcmEnrollmentReplayProtector(key),
    });
    const replayedBySecondIsolate = new EnrollmentService({
      clock,
      store,
      random: new DeterministicRandom(),
      replayProtector: new AesGcmEnrollmentReplayProtector(key),
    });
    const request: MintEnrollmentRequest = { requested_scopes: ["review"] };
    const minted = await first.mint(sponsor, request, { idempotencyKey: "stable-key-1" });
    await expect(
      replayedBySecondIsolate.mint(sponsor, request, { idempotencyKey: "stable-key-1" }),
    ).resolves.toEqual(minted);

    const wrongKeyIsolate = new EnrollmentService({
      clock,
      store,
      random: new DeterministicRandom(),
      replayProtector: new AesGcmEnrollmentReplayProtector(
        Uint8Array.from({ length: 32 }, (_value, index) => index + 2),
      ),
    });
    await expect(
      wrongKeyIsolate.mint(sponsor, request, { idempotencyKey: "stable-key-1" }),
    ).rejects.toBeInstanceOf(EnrollmentReplayConfigurationError);
  });

  test("PLANTED: replay protection owns exactly a Buffer key subview", async () => {
    const backing = Buffer.alloc(48, 0xa5);
    const key = backing.subarray(8, 40);
    for (let index = 0; index < key.length; index += 1) key[index] = index;
    const protector = new AesGcmEnrollmentReplayProtector(key, new DeterministicRandom());

    // Mutating caller storage after construction must neither rotate the
    // protector's key nor make WebCrypto import the surrounding allocation.
    key.fill(0xff);
    const sealed = await protector.seal("exact replay key window");
    await expect(protector.open(sealed)).resolves.toBe("exact replay key window");
  });

  test("HKDF separates replay encryption from stable non-enumerable source buckets", async () => {
    const address = "198.51.100.7";
    const key = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);
    const first = new AesGcmEnrollmentReplayProtector(key);
    const second = new AesGcmEnrollmentReplayProtector(key);
    const other = new AesGcmEnrollmentReplayProtector(
      Uint8Array.from({ length: 32 }, (_value, index) => index + 2),
    );
    const publicDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`device-start-source-v1\0${address}`),
    );
    const publicHex = [...new Uint8Array(publicDigest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const rawHmacKey = await crypto.subtle.importKey(
      "raw",
      key.slice().buffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const rawHmac = await crypto.subtle.sign(
      "HMAC",
      rawHmacKey,
      new TextEncoder().encode(`device-start-source-v1\0${address}`),
    );
    const rawHmacHex = [...new Uint8Array(rawHmac)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const bucket = await first.sourceBucket(address);

    expect(bucket).toBe("9c2f7c40f32a1ff6227ba16946804d0dc6b52ca55849cd25d7ca4931c08d5c55");
    expect(bucket).not.toBe(publicHex);
    expect(bucket).not.toBe(rawHmacHex);
    await expect(second.sourceBucket(address)).resolves.toBe(bucket);
    await expect(other.sourceBucket(address)).resolves.not.toBe(bucket);
  });

  test("replay AES uses its pinned HKDF subkey rather than the deployment root", async () => {
    const root = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);
    const zeroRandom: EnrollmentRandom = { bytes: (length) => new Uint8Array(length) };
    const protector = new AesGcmEnrollmentReplayProtector(root, zeroRandom);

    const sealed = await protector.seal("domain-separated-replay");
    expect(sealed).toEqual({
      ciphertext: "3ECliZ6f53Xjn3vE317wWE7SMUobhImcuY75bG4paz7Ga3n7NtyE",
      initializationVector: "AAAAAAAAAAAAAAAA",
    });
    await expect(protector.open(sealed)).resolves.toBe("domain-separated-replay");
  });

  test("naming policy rejects model, harness, reserved, impersonating, and profane names with safe suggestions", async () => {
    const { service } = serviceFixture();
    for (const [name, code] of [
      ["codex", "MODEL_AS_NAME"],
      ["claude-code", "HARNESS_AS_NAME"],
      ["system", "NAME_RESERVED"],
      ["codex-lab", "MODEL_AS_NAME"],
      ["real-proof", "NAME_RESERVED"],
      ["sh1t-proof", "NAME_RESERVED"],
    ] as const) {
      const minted = await service.mint(sponsor, { requested_scopes: ["review"] });
      const error = await expectEnrollmentError(
        service.claim({
          enrollment_id: minted.enrollmentId,
          secret: minted.secret,
          name,
          model: "test-model",
          harness: "test-harness",
        }),
        code,
      );
      expect(error.suggestions).toHaveLength(3);
      for (const suggestion of error.suggestions)
        expect(suggestion).toMatch(/^[a-z][a-z0-9-]{2,31}$/);
    }
  });

  test("valid credential fields receive teachable reserved-name policy errors while bad secrets stay opaque", async () => {
    const { service } = serviceFixture();
    for (const [name, code] of [
      ["codex", "MODEL_AS_NAME"],
      ["gemini-cli", "HARNESS_AS_NAME"],
    ] as const) {
      const minted = await service.mint(sponsor, { requested_scopes: ["review"] });
      const error = await expectEnrollmentError(
        service.claim({
          enrollment_id: minted.enrollmentId,
          secret: minted.secret,
          name,
          model: "test-model",
          harness: "test-harness",
        }),
        code,
      );
      expect(error.suggestions).toHaveLength(3);
      expect(error.suggestions.every((candidate) => !candidate.endsWith("-"))).toBe(true);
    }

    const minted = await service.mint(sponsor, { requested_scopes: ["review"] });
    await expectEnrollmentError(
      service.claim({
        enrollment_id: minted.enrollmentId,
        secret: malformedSecret,
        name: "codex",
        model: "test-model",
        harness: "test-harness",
      } as unknown as {
        enrollment_id: string;
        secret: string;
        name: string;
        model: string;
        harness: string;
      }),
      "PAIRING_INVALID",
    );
  });

  test("the exact Fable naming law accepts a trailing hyphen", async () => {
    const { service } = serviceFixture();
    const minted = await service.mint(sponsor, { requested_scopes: ["review"] });
    const proposal = await service.claim({
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "orchid-",
      model: "test-model",
      harness: "test-harness",
    });
    expect(proposal.flowHandle).toMatch(/^flow_v1\./);
  });

  test("name policy is unreachable until a current unused enrollment secret verifies", async () => {
    const { clock, service } = serviceFixture();
    const valid = await service.mint(sponsor, { requested_scopes: ["review"] });
    const unknown = await service.mint(sponsor, { requested_scopes: ["review"] });
    const expired = await service.mint(sponsor, {
      requested_scopes: ["review"],
      expires_in_ms: 1,
    });
    const consumed = await service.mint(sponsor, { requested_scopes: ["review"] });
    await service.claim({
      enrollment_id: consumed.enrollmentId,
      secret: consumed.secret,
      name: "consumed-orchid",
      model: "test-model",
      harness: "test-harness",
    });
    clock.value += 2;

    const opaqueAttempts = [
      {
        enrollmentId: valid.enrollmentId,
        secret: wrongSecret,
      },
      { enrollmentId: "ASIMP-EN-7F3K9M2Q8R", secret: unknown.secret },
      { enrollmentId: expired.enrollmentId, secret: expired.secret },
      { enrollmentId: consumed.enrollmentId, secret: consumed.secret },
    ];
    for (const name of ["codex", "claimed-orchid", "orchid-", "legal-orchid"]) {
      for (const attempt of opaqueAttempts) {
        const error = await expectEnrollmentError(
          service.claim({
            enrollment_id: attempt.enrollmentId,
            secret: attempt.secret,
            name,
            model: "test-model",
            harness: "test-harness",
          }),
          "PAIRING_INVALID",
        );
        expect(error.suggestions).toEqual([]);
      }
    }

    const teaching = await expectEnrollmentError(
      service.claim({
        enrollment_id: valid.enrollmentId,
        secret: valid.secret,
        name: "codex",
        model: "test-model",
        harness: "test-harness",
      }),
      "MODEL_AS_NAME",
    );
    expect(teaching.suggestions).toHaveLength(3);
    await expect(
      service.claim({
        enrollment_id: valid.enrollmentId,
        secret: valid.secret,
        name: "recovered-orchid",
        model: "test-model",
        harness: "test-harness",
      }),
    ).resolves.toMatchObject({ flowHandle: expect.stringMatching(/^flow_v1\./) });
  });

  test("approval cards report deny status without retaining requested grants as effective authority", async () => {
    const { service } = serviceFixture();
    const { enrollmentId } = await mintAndClaim(service, "denied-orchid");
    await service.decide(sponsor, enrollmentId, { enrollment_id: enrollmentId, decision: "deny" });
    await expect(service.approvalCard(sponsor, enrollmentId)).resolves.toMatchObject({
      status: "denied",
      effectiveGrantedScopes: null,
      effectiveGrantedResources: null,
    });
  });

  test("availability suggestions stay policy-valid and actually available under collision pressure", async () => {
    const { service } = serviceFixture();
    for (const name of ["fellow-2", "fellow-3", "fellow-4"]) {
      const enrollment = await mintAndClaim(service, name);
      await service.decide(sponsor, enrollment.enrollmentId, {
        enrollment_id: enrollment.enrollmentId,
        decision: "approve",
      });
    }
    const minted = await service.mint(sponsor, { requested_scopes: ["review"] });
    const error = await expectEnrollmentError(
      service.claim({
        enrollment_id: minted.enrollmentId,
        secret: minted.secret,
        name: "codex",
        model: "test-model",
        harness: "test-harness",
      }),
      "MODEL_AS_NAME",
    );
    expect(error.suggestions).toEqual(["fellow-5", "fellow-6", "fellow-7"]);
  });

  test("body-only poll input and diagnostics never admit credential-shaped extras", async () => {
    const { service } = serviceFixture();
    await expectEnrollmentError(
      service.poll({
        flow_handle: nonCredentialFlowHandle,
        proposal_id: "not-a-poll-credential",
      } as unknown as { flow_handle: string }),
      "FLOW_INVALID",
    );

    const canary = "asimp_ag_SHOULD_NOT_APPEAR";
    const diagnostic = safeEnrollmentDiagnostic({
      suite: "enrollment.never-log",
      startedAt: performance.now(),
      status: "fail",
      code: "FLOW_INVALID",
    });
    expect(diagnostic).not.toContain(canary);
    expect(diagnostic).not.toContain("/Users/");
    expect(diagnostic).not.toContain("flow_v1.");
  });
});
