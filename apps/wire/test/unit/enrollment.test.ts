import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { type MintEnrollmentRequest, ProblemDocumentSchema } from "@asimposium/contracts";

import {
  AesGcmEnrollmentReplayProtector,
  authorizeFellowWrite,
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
  enrollmentCryptoForTests,
  type FellowAuthorizationRefusalReason,
  type FellowCredentialBinding,
  type FellowExistingProblemTarget,
  type FellowNewProblemTarget,
  type FellowSessionAdmissionTarget,
  type FellowSessionCloseTarget,
  type FellowWriteEffect,
  type FellowWriteGrantUsage,
  fellowAuthorizationResponse,
  InMemoryEnrollmentStore,
  inspectFellowWriteAuthorization,
  SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS,
  SPONSOR_STEP_UP_WINDOW_SECONDS,
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
const trustedTestStoaOrigin = "https://a.asimposium.org";

function serviceFixture() {
  const clock = new MutableClock();
  const store = new InMemoryEnrollmentStore();
  const random = new DeterministicRandom();
  return {
    clock,
    store,
    service: new EnrollmentService({
      stoaOrigin: trustedTestStoaOrigin,
      agoraOrigin: "https://asimposium.org",
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

function currentStepUp(clock: MutableClock): number {
  return Math.floor(clock.value / 1_000);
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
      stoaOrigin: trustedTestStoaOrigin,
      agoraOrigin: "https://asimposium.org",
      store: new InMemoryEnrollmentStore(),
      random: tailThenLow,
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    expect((await sampled.deviceStart(deviceProposal, deviceStartOptions)).user_code).toBe(
      "ABCD-EFGH",
    );

    const broken: EnrollmentRandom = { bytes: (length) => new Uint8Array(length).fill(255) };
    const unavailable = new EnrollmentService({
      stoaOrigin: trustedTestStoaOrigin,
      agoraOrigin: "https://asimposium.org",
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
      stoaOrigin: trustedTestStoaOrigin,
      agoraOrigin: "https://asimposium.org",
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
      stoaOrigin: trustedTestStoaOrigin,
      agoraOrigin: "https://asimposium.org",
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

    clock.value += DEVICE_LOOKUP_LOCKOUT_WINDOW_MS;
    await expectEnrollmentError(
      service.deviceLookup(sponsor, { user_code: started.user_code }),
      "DEVICE_LOOKUP_LOCKED",
    );
    clock.value += 1;
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
      stoaOrigin: trustedTestStoaOrigin,
      agoraOrigin: "https://asimposium.org",
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

  test("polling first at the requested grant boundary durably expires a pending proposal", async () => {
    const { clock, service } = serviceFixture();
    const minted = await service.mint(sponsor, {
      requested_scopes: ["review"],
      fellow_grant_expires_in_ms: 1,
    });
    const claim = await service.claim({
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "pending-grant-expiry",
      model: "test-model",
      harness: "test-harness",
    });

    expect(await service.poll({ flow_handle: claim.flowHandle })).toEqual({
      status: "authorization_pending",
      retry_after_seconds: 5,
    });
    clock.value += 1;
    expect(await service.poll({ flow_handle: claim.flowHandle })).toEqual({
      status: "expired_token",
    });
    expect(await service.approvalCard(sponsor, minted.enrollmentId)).toMatchObject({
      status: "expired",
      effectiveGrantedScopes: null,
      effectiveGrantedResources: null,
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
        step_up_authenticated_at: currentStepUp(clock),
      }),
      "WRONG_PRINCIPAL",
    );
    expect(await service.poll({ flow_handle: started.device_code })).toEqual({
      status: "expired_token",
    });
  });

  test("an operational device-card fallback failure is not rewritten as wrong-principal", async () => {
    const clock = new MutableClock();
    const base = new InMemoryEnrollmentStore();
    const store = storeProxy(base, {
      deviceApprovalCardForDecision: async () => {
        throw new EnrollmentPersistenceError();
      },
    });
    const service = new EnrollmentService({
      stoaOrigin: trustedTestStoaOrigin,
      agoraOrigin: "https://asimposium.org",
      clock,
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
        step_up_authenticated_at: currentStepUp(clock),
      }),
    ).rejects.toBeInstanceOf(EnrollmentPersistenceError);
  });

  test("mints a 256-bit fragment secret, stores only hashes, and issues one token after approval", async () => {
    const { clock, service, store } = serviceFixture();
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
      step_up_authenticated_at: currentStepUp(clock),
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
      service.decide(otherSponsor, enrollmentId, {
        enrollment_id: enrollmentId,
        decision: "deny",
        step_up_authenticated_at: currentStepUp(clock),
      }),
      "WRONG_PRINCIPAL",
    );
    await service.decide(sponsor, enrollmentId, {
      enrollment_id: enrollmentId,
      decision: "deny",
      step_up_authenticated_at: currentStepUp(clock),
    });
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
      step_up_authenticated_at: currentStepUp(clock),
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
        step_up_authenticated_at: currentStepUp(clock),
      });
      const approved = await service.poll({ flow_handle: flowHandle }, options);
      expect(approved.status).toBe("approved");
      expect(await service.poll({ flow_handle: flowHandle }, options)).toEqual(approved);
    }

    {
      const { clock, service } = serviceFixture();
      const { enrollmentId, flowHandle } = await mintAndClaim(service, "stable-poll-deny-orchid");
      const options = { idempotencyKey: "stable-poll-deny-1" } as const;
      expect((await service.poll({ flow_handle: flowHandle }, options)).status).toBe(
        "authorization_pending",
      );
      await service.decide(sponsor, enrollmentId, {
        enrollment_id: enrollmentId,
        decision: "deny",
        step_up_authenticated_at: currentStepUp(clock),
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
    const { clock, service } = serviceFixture();
    const { enrollmentId, flowHandle } = await mintAndClaim(service, "race-orchid");

    const approvals = await Promise.allSettled([
      service.decide(sponsor, enrollmentId, {
        enrollment_id: enrollmentId,
        decision: "approve",
        step_up_authenticated_at: currentStepUp(clock),
      }),
      service.decide(sponsor, enrollmentId, {
        enrollment_id: enrollmentId,
        decision: "approve",
        step_up_authenticated_at: currentStepUp(clock),
      }),
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
    const clock = new MutableClock();
    const service = new EnrollmentService({
      stoaOrigin: trustedTestStoaOrigin,
      agoraOrigin: "https://asimposium.org",
      clock,
      store,
      random,
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32), random),
    });
    const { enrollmentId, flowHandle } = await mintAndClaim(service, "poll-race-replay-orchid");
    await service.decide(sponsor, enrollmentId, {
      enrollment_id: enrollmentId,
      decision: "approve",
      step_up_authenticated_at: currentStepUp(clock),
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
    const { clock, service, store } = serviceFixture();
    const { enrollmentId } = await mintAndClaim(service, "reduce-orchid");

    await expectEnrollmentError(
      store.decision({
        enrollmentId,
        sponsorId: sponsor.sponsorId,
        decision: {
          enrollment_id: enrollmentId,
          decision: "reduce",
          reduction: { scopes: [] },
        },
        now: clock.value,
      }),
      "SCOPE_NOT_REDUCED",
    );
    await expectEnrollmentError(
      service.decide(sponsor, enrollmentId, {
        enrollment_id: enrollmentId,
        decision: "reduce",
        step_up_authenticated_at: currentStepUp(clock),
        reduction: { scopes: ["upload-artifacts"] },
      }),
      "SCOPE_ESCALATION",
    );
    await expectEnrollmentError(
      service.decide(sponsor, enrollmentId, {
        enrollment_id: enrollmentId,
        decision: "reduce",
        step_up_authenticated_at: currentStepUp(clock),
        reduction: { event_budget: 12 },
      }),
      "SCOPE_NOT_REDUCED",
    );
    await service.decide(sponsor, enrollmentId, {
      enrollment_id: enrollmentId,
      decision: "reduce",
      step_up_authenticated_at: currentStepUp(clock),
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
        step_up_authenticated_at: currentStepUp(clock),
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
    const { clock, service } = serviceFixture();
    const first = await mintAndClaim(service, "shared-orchid");
    const second = await mintAndClaim(service, "shared-orchid");
    const outcomes = await Promise.allSettled([
      service.decide(sponsor, first.enrollmentId, {
        enrollment_id: first.enrollmentId,
        decision: "approve",
        step_up_authenticated_at: currentStepUp(clock),
      }),
      service.decide(sponsor, second.enrollmentId, {
        enrollment_id: second.enrollmentId,
        decision: "approve",
        step_up_authenticated_at: currentStepUp(clock),
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
    const { clock, service } = serviceFixture();
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
        {
          enrollment_id: minted.enrollmentId,
          decision: "approve",
          step_up_authenticated_at: currentStepUp(clock),
        },
        { idempotencyKey: "decision-idempotency-1" },
      ),
    ).resolves.toBeUndefined();
    await service.decide(
      sponsor,
      minted.enrollmentId,
      {
        enrollment_id: minted.enrollmentId,
        decision: "approve",
        step_up_authenticated_at: currentStepUp(clock),
      },
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

  test("decision step-up honors the authenticated transport skew at both freshness boundaries", async () => {
    for (const scenario of [
      { label: "exact-window", offsetSeconds: -SPONSOR_STEP_UP_WINDOW_SECONDS, code: undefined },
      {
        label: "oldest-with-skew",
        offsetSeconds: -(SPONSOR_STEP_UP_WINDOW_SECONDS + SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS),
        code: undefined,
      },
      {
        label: "one-second-too-old",
        offsetSeconds: -(SPONSOR_STEP_UP_WINDOW_SECONDS + SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS + 1),
        code: "STEP_UP_REQUIRED",
      },
      {
        label: "future-with-skew",
        offsetSeconds: SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS,
        code: undefined,
      },
      {
        label: "one-second-too-future",
        offsetSeconds: SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS + 1,
        code: "STEP_UP_REQUIRED",
      },
    ] as const) {
      const { clock, service } = serviceFixture();
      const { enrollmentId } = await mintAndClaim(service, `decision-${scenario.label}`);
      const decision = {
        enrollment_id: enrollmentId,
        decision: "approve",
        step_up_authenticated_at: currentStepUp(clock) + scenario.offsetSeconds,
      } as const;

      if (scenario.code === undefined) {
        await expect(service.decide(sponsor, enrollmentId, decision)).resolves.toBeUndefined();
        await expect(service.approvalCard(sponsor, enrollmentId)).resolves.toMatchObject({
          status: "approved",
        });
      } else {
        await expectEnrollmentError(service.decide(sponsor, enrollmentId, decision), scenario.code);
        await expect(service.approvalCard(sponsor, enrollmentId)).resolves.toMatchObject({
          status: "pending",
        });
      }
    }
  });

  test("malformed decision step-up evidence is refused without settling the proposal", async () => {
    for (const scenario of [
      { label: "fractional", step_up_authenticated_at: 1_700_000_000.5 },
      { label: "missing" },
    ] as const) {
      const { service } = serviceFixture();
      const { enrollmentId } = await mintAndClaim(service, `decision-${scenario.label}`);
      const decision =
        "step_up_authenticated_at" in scenario
          ? {
              enrollment_id: enrollmentId,
              decision: "approve",
              step_up_authenticated_at: scenario.step_up_authenticated_at,
            }
          : { enrollment_id: enrollmentId, decision: "approve" };
      await expectEnrollmentError(
        service.decide(sponsor, enrollmentId, decision as never),
        "DECISION_BODY_INVALID",
      );
      await expect(service.approvalCard(sponsor, enrollmentId)).resolves.toMatchObject({
        status: "pending",
      });
    }
  });

  test("a stale decision records nothing, while a committed decision replays after step-up expiry", async () => {
    const clock = new MutableClock();
    const base = new InMemoryEnrollmentStore();
    let decisionWrites = 0;
    const store = storeProxy(base, {
      decision: async (attempt, idempotency) => {
        decisionWrites += 1;
        await base.decision(attempt, idempotency);
      },
    });
    const service = new EnrollmentService({
      stoaOrigin: trustedTestStoaOrigin,
      agoraOrigin: "https://asimposium.org",
      clock,
      store,
      random: new DeterministicRandom(),
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    const { enrollmentId } = await mintAndClaim(service, "decision-stale-retry");
    const before = await base.storageSnapshot(enrollmentId);
    const key = "decision-step-up-retry-1";
    const stale = {
      enrollment_id: enrollmentId,
      decision: "approve",
      step_up_authenticated_at:
        currentStepUp(clock) -
        (SPONSOR_STEP_UP_WINDOW_SECONDS + SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS + 1),
    } as const;

    await expectEnrollmentError(
      service.decide(sponsor, enrollmentId, stale, { idempotencyKey: key }),
      "STEP_UP_REQUIRED",
    );
    expect(decisionWrites).toBe(0);
    expect(await base.storageSnapshot(enrollmentId)).toEqual(before);
    await expect(service.approvalCard(sponsor, enrollmentId)).resolves.toMatchObject({
      status: "pending",
    });

    const fresh = { ...stale, step_up_authenticated_at: currentStepUp(clock) };
    await expect(
      service.decide(sponsor, enrollmentId, fresh, { idempotencyKey: key }),
    ).resolves.toBeUndefined();
    expect(decisionWrites).toBe(1);

    clock.value +=
      (SPONSOR_STEP_UP_WINDOW_SECONDS + SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS + 1) * 1_000;
    await expect(
      service.decide(sponsor, enrollmentId, fresh, { idempotencyKey: key }),
    ).resolves.toBeUndefined();
    expect(decisionWrites).toBe(1);

    // Reauthentication changes only command evidence, never the semantic
    // product request. The same key must therefore replay instead of conflict.
    const refreshed = { ...fresh, step_up_authenticated_at: currentStepUp(clock) };
    await expect(
      service.decide(sponsor, enrollmentId, refreshed, { idempotencyKey: key }),
    ).resolves.toBeUndefined();
    expect(decisionWrites).toBe(1);
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
    const clock = new MutableClock();
    const service = new EnrollmentService({
      stoaOrigin: trustedTestStoaOrigin,
      agoraOrigin: "https://asimposium.org",
      clock,
      store,
      random: new DeterministicRandom(),
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    const { enrollmentId } = await mintAndClaim(service, "decision-race-orchid");
    const decision = {
      enrollment_id: enrollmentId,
      decision: "approve",
      step_up_authenticated_at: currentStepUp(clock),
    } as const;

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
    const clock = new MutableClock();
    const service = new EnrollmentService({
      stoaOrigin: trustedTestStoaOrigin,
      agoraOrigin: "https://asimposium.org",
      clock,
      store,
      random: new DeterministicRandom(),
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    const started = await service.deviceStart(deviceProposal, deviceStartOptions);
    const card = await service.deviceLookup(sponsor, { user_code: started.user_code });
    const decision = {
      enrollment_id: card.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: currentStepUp(clock),
    } as const;
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
    expect(
      () =>
        new EnrollmentService({
          stoaOrigin: trustedTestStoaOrigin,
          agoraOrigin: "https://asimposium.org",
        }),
    ).toThrow(EnrollmentReplayConfigurationError);

    const clock = new MutableClock();
    const store = new InMemoryEnrollmentStore();
    const key = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);
    const first = new EnrollmentService({
      stoaOrigin: trustedTestStoaOrigin,
      agoraOrigin: "https://asimposium.org",
      clock,
      store,
      random: new DeterministicRandom(),
      replayProtector: new AesGcmEnrollmentReplayProtector(key),
    });
    const replayedBySecondIsolate = new EnrollmentService({
      stoaOrigin: trustedTestStoaOrigin,
      agoraOrigin: "https://asimposium.org",
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
      stoaOrigin: trustedTestStoaOrigin,
      agoraOrigin: "https://asimposium.org",
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
    const { clock, service } = serviceFixture();
    const { enrollmentId } = await mintAndClaim(service, "denied-orchid");
    await service.decide(sponsor, enrollmentId, {
      enrollment_id: enrollmentId,
      decision: "deny",
      step_up_authenticated_at: currentStepUp(clock),
    });
    await expect(service.approvalCard(sponsor, enrollmentId)).resolves.toMatchObject({
      status: "denied",
      effectiveGrantedScopes: null,
      effectiveGrantedResources: null,
    });
  });

  test("availability suggestions stay policy-valid and actually available under collision pressure", async () => {
    const { clock, service } = serviceFixture();
    for (const name of ["fellow-2", "fellow-3", "fellow-4"]) {
      const enrollment = await mintAndClaim(service, name);
      await service.decide(sponsor, enrollment.enrollmentId, {
        enrollment_id: enrollment.enrollmentId,
        decision: "approve",
        step_up_authenticated_at: currentStepUp(clock),
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

  test("credential revoke is exact-replay safe across the step-up boundary", async () => {
    const { clock, service } = serviceFixture();
    await service.bootstrapSponsor(sponsor);
    const enrollment = await mintAndClaim(service, "revoke-orchid");
    await service.decide(sponsor, enrollment.enrollmentId, {
      enrollment_id: enrollment.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: currentStepUp(clock),
    });
    const issued = await service.poll({ flow_handle: enrollment.flowHandle });
    expect(issued.status).toBe("approved");
    if (issued.status !== "approved") throw new Error("fixture token was not issued");
    expect(await service.credentialBinding(issued.token)).toBeDefined();
    const listed = await service.fellows(sponsor);
    const owned = listed[0];
    const credential = owned?.credentials[0];
    if (owned === undefined || credential === undefined) {
      throw new Error("fixture credential was not listed");
    }
    const body = {
      fellow_id: owned.fellowId,
      credential_id: credential.credentialId,
      confirm: "revoke-credential",
      step_up_authenticated_at: Math.floor(clock.value / 1_000),
    } as const;
    const first = await service.revokeCredential(sponsor, body, {
      idempotencyKey: "revoke-credential-one",
    });
    expect(first).toMatchObject({
      acknowledged: true,
      fellow_id: owned.fellowId,
      credential_id: credential.credentialId,
      sponsor_seq: 1,
    });
    expect(await service.credentialBinding(issued.token)).toBeUndefined();

    clock.value +=
      (SPONSOR_STEP_UP_WINDOW_SECONDS + SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS + 1) * 1_000;
    expect(
      await service.revokeCredential(sponsor, body, {
        idempotencyKey: "revoke-credential-one",
      }),
    ).toEqual(first);
    await expectEnrollmentError(
      service.revokeCredential(sponsor, body, {
        idempotencyKey: "revoke-credential-two",
      }),
      "STEP_UP_REQUIRED",
    );
  });

  test("Fellow lifecycle and sponsor panic keep status, token authority, and audit order aligned", async () => {
    const { clock, service } = serviceFixture();
    await service.bootstrapSponsor(sponsor);
    const enrollment = await mintAndClaim(service, "lifecycle-orchid");
    await service.decide(sponsor, enrollment.enrollmentId, {
      enrollment_id: enrollment.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: currentStepUp(clock),
    });
    const issued = await service.poll({ flow_handle: enrollment.flowHandle });
    if (issued.status !== "approved") throw new Error("fixture token was not issued");
    const owned = (await service.fellows(sponsor))[0];
    if (owned === undefined) throw new Error("fixture Fellow was not listed");
    const stepUp = Math.floor(clock.value / 1_000);

    const paused = await service.transitionFellow(
      sponsor,
      {
        fellow_id: owned.fellowId,
        status: "paused",
        confirm: "change-fellow-lifecycle",
        step_up_authenticated_at: stepUp,
      },
      { idempotencyKey: "lifecycle-pause-one" },
    );
    expect(paused).toMatchObject({ status: "paused", sponsor_seq: 1 });
    expect(await service.credentialBinding(issued.token)).toBeUndefined();

    const resumed = await service.transitionFellow(
      sponsor,
      {
        fellow_id: owned.fellowId,
        status: "active",
        confirm: "change-fellow-lifecycle",
        step_up_authenticated_at: stepUp,
      },
      { idempotencyKey: "lifecycle-resume-one" },
    );
    expect(resumed).toMatchObject({ status: "active", sponsor_seq: 2 });
    expect(await service.credentialBinding(issued.token)).toBeDefined();

    const panic = await service.panicSponsor(
      sponsor,
      {
        confirm: "revoke-all-fellow-credentials",
        step_up_authenticated_at: stepUp,
      },
      { idempotencyKey: "lifecycle-panic-one" },
    );
    expect(panic).toMatchObject({ acknowledged: true, sponsor_seq: 3 });
    expect(await service.credentialBinding(issued.token)).toBeUndefined();

    const compromised = await service.transitionFellow(
      sponsor,
      {
        fellow_id: owned.fellowId,
        status: "compromised",
        confirm: "change-fellow-lifecycle",
        step_up_authenticated_at: stepUp,
      },
      { idempotencyKey: "lifecycle-compromise-one" },
    );
    expect(compromised).toMatchObject({ status: "compromised", sponsor_seq: 4 });
    expect((await service.fellows(sponsor))[0]?.status).toBe("compromised");
    await expectEnrollmentError(
      service.transitionFellow(
        otherSponsor,
        {
          fellow_id: owned.fellowId,
          status: "archived",
          confirm: "change-fellow-lifecycle",
          step_up_authenticated_at: stepUp,
        },
        { idempotencyKey: "foreign-lifecycle-one" },
      ),
      "FELLOW_LIFECYCLE_NOT_CURRENT",
    );
  });

  test("sponsor panic invalidates an approved credential family before one-time issuance", async () => {
    const { clock, service } = serviceFixture();
    await service.bootstrapSponsor(sponsor);
    const enrollment = await mintAndClaim(service, "panic-before-poll");
    await service.decide(sponsor, enrollment.enrollmentId, {
      enrollment_id: enrollment.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: currentStepUp(clock),
    });
    await service.panicSponsor(
      sponsor,
      {
        confirm: "revoke-all-fellow-credentials",
        step_up_authenticated_at: Math.floor(clock.value / 1_000),
      },
      { idempotencyKey: "panic-before-poll-one" },
    );

    await expectEnrollmentError(
      service.poll({ flow_handle: enrollment.flowHandle }),
      "FLOW_INVALID",
    );
    expect((await service.fellows(sponsor))[0]?.credentials).toEqual([]);
  });

  test("one-time issuance rechecks every Fellow status after approval", async () => {
    for (const [status, shouldIssue] of [
      ["paused", false],
      ["revoked", false],
      ["compromised", false],
      ["suspicious_review", true],
    ] as const) {
      const { clock, service } = serviceFixture();
      await service.bootstrapSponsor(sponsor);
      const enrollment = await mintAndClaim(service, `poll-status-${status.replace("_", "-")}`);
      await service.decide(sponsor, enrollment.enrollmentId, {
        enrollment_id: enrollment.enrollmentId,
        decision: "approve",
        step_up_authenticated_at: currentStepUp(clock),
      });
      const fellow = (await service.fellows(sponsor))[0];
      if (fellow === undefined) throw new Error("approved Fellow was not listed");
      await service.transitionFellow(
        sponsor,
        {
          fellow_id: fellow.fellowId,
          status,
          confirm: "change-fellow-lifecycle",
          step_up_authenticated_at: Math.floor(clock.value / 1_000),
        },
        { idempotencyKey: `poll-status-${status}` },
      );

      const poll = service.poll({ flow_handle: enrollment.flowHandle });
      if (shouldIssue) {
        await expect(poll).resolves.toMatchObject({ status: "approved" });
      } else {
        await expectEnrollmentError(poll, "FLOW_INVALID");
        expect((await service.fellows(sponsor))[0]?.credentials).toEqual([]);
      }
    }
  });

  test("sponsor step-up applies the signed-transport skew at its outer boundaries", async () => {
    for (const scenario of [
      { label: "exact", offsetSeconds: -15 * 60, code: undefined },
      {
        label: "too-old",
        offsetSeconds: -(SPONSOR_STEP_UP_WINDOW_SECONDS + SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS + 1),
        code: "STEP_UP_REQUIRED",
      },
      {
        label: "future",
        offsetSeconds: SPONSOR_STEP_UP_CLOCK_SKEW_SECONDS + 1,
        code: "STEP_UP_REQUIRED",
      },
    ] as const) {
      const { clock, service } = serviceFixture();
      await service.bootstrapSponsor(sponsor);
      const call = service.panicSponsor(
        sponsor,
        {
          confirm: "revoke-all-fellow-credentials",
          step_up_authenticated_at: Math.floor(clock.value / 1_000) + scenario.offsetSeconds,
        },
        { idempotencyKey: `step-up-${scenario.label}` },
      );
      if (scenario.code === undefined) {
        await expect(call).resolves.toMatchObject({ acknowledged: true, sponsor_seq: 1 });
      } else {
        await expectEnrollmentError(call, scenario.code);
      }
    }

    const { clock, service } = serviceFixture();
    await service.bootstrapSponsor(sponsor);
    await expectEnrollmentError(
      service.panicSponsor(
        sponsor,
        {
          confirm: "revoke-all-fellow-credentials",
          step_up_authenticated_at: Math.floor(clock.value / 1_000) + 0.5,
        },
        { idempotencyKey: "step-up-fractional" },
      ),
      "SPONSOR_PANIC_BODY_INVALID",
    );
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

  test("diagnostics redact a credential-shaped caller suite while retaining safe metadata", () => {
    const suiteSecret = "asimp_ag_DIAGNOSTIC_SUITE_SECRET_BYTES";
    const diagnostic = safeEnrollmentDiagnostic({
      suite: `enrollment.${suiteSecret}.regression`,
      startedAt: performance.now(),
      status: "fail",
      code: "FLOW_INVALID",
    });

    expect(diagnostic).not.toContain(suiteSecret);
    let parsedDiagnostic: unknown;
    try {
      parsedDiagnostic = JSON.parse(diagnostic) as unknown;
    } catch {
      throw new Error("safe-enrollment-diagnostic-json");
    }
    expect(parsedDiagnostic).toMatchObject({
      tool: "bun",
      package: "@asimposium/wire",
      suite: "enrollment.<redacted>.regression",
      status: "fail",
      code: "FLOW_INVALID",
      reproduce: "cd apps/wire && bun run test:unit",
    });
  });
});

describe("centralized Fellow write authorization", () => {
  const NOW = 1_700_000_000_000;

  function binding(overrides: Partial<FellowCredentialBinding> = {}): FellowCredentialBinding {
    return {
      fellowId: "F-alpha",
      credentialId: "CRED-alpha",
      sponsorId: "S-alpha",
      name: "alpha",
      model: "claude-opus-5",
      harness: "claude-code",
      grantedScopes: ["promote", "review", "propose-problems", "upload-artifacts"],
      grantedResources: {},
      tokenHash: "a".repeat(64),
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 1_000_000,
      credentialProfile: "bearer",
      fellowStatus: "active",
      ...overrides,
    };
  }

  function existingTarget(
    overrides: Partial<FellowExistingProblemTarget> = {},
  ): FellowExistingProblemTarget {
    return {
      kind: "existing-problem",
      problemId: "P-1",
      publication: "published",
      unlisted: false,
      membershipRole: "contributor",
      ...overrides,
    };
  }

  function newProblemTarget(
    overrides: Partial<FellowNewProblemTarget> = {},
  ): FellowNewProblemTarget {
    return {
      kind: "new-problem",
      initialPublication: "private-draft",
      unlisted: false,
      ...overrides,
    };
  }

  function sessionAdmissionTarget(
    overrides: Partial<FellowSessionAdmissionTarget> = {},
  ): FellowSessionAdmissionTarget {
    return { kind: "session-admission", problemId: "P-1", ...overrides };
  }

  function sessionCloseTarget(
    overrides: Partial<FellowSessionCloseTarget> = {},
  ): FellowSessionCloseTarget {
    return { kind: "session-close", problemId: "P-1", membershipRole: "contributor", ...overrides };
  }

  function usage(overrides: Partial<FellowWriteGrantUsage> = {}): FellowWriteGrantUsage {
    return { eventsRecorded: 0, artifactBytesRecorded: 0, ...overrides };
  }

  type AuthorizationInput = Parameters<typeof authorizeFellowWrite>[0];
  type DecisionOverrides = {
    credential?: Partial<FellowCredentialBinding>;
    target?: AuthorizationInput["target"];
    usage?: Partial<FellowWriteGrantUsage>;
    effect?: FellowWriteEffect;
    artifactBytesRequested?: number;
    now?: number;
  };

  function input(overrides: DecisionOverrides = {}): AuthorizationInput {
    const effect = overrides.effect ?? "promote";
    return {
      effect,
      credential: binding(overrides.credential),
      target: overrides.target ?? existingTarget(),
      usage: usage(overrides.usage),
      ...(effect === "upload-artifacts"
        ? { artifactBytesRequested: overrides.artifactBytesRequested ?? 1 }
        : overrides.artifactBytesRequested === undefined
          ? {}
          : { artifactBytesRequested: overrides.artifactBytesRequested }),
      now: overrides.now ?? NOW,
    };
  }

  function decide(overrides: DecisionOverrides = {}) {
    return authorizeFellowWrite(input(overrides));
  }

  function inspect(overrides: DecisionOverrides = {}) {
    return inspectFellowWriteAuthorization(input(overrides));
  }

  test("the happy paths follow effect-specific Fable semantics", () => {
    expect(
      decide({
        effect: "workshop.push",
        credential: { grantedScopes: [] },
        target: existingTarget({ membershipRole: "observer", publication: "private-draft" }),
      }),
    ).toEqual({ decision: "allow", effect: "workshop.push" });
    expect(decide({ effect: "promote" })).toEqual({ decision: "allow", effect: "promote" });
    expect(
      decide({ effect: "review", target: existingTarget({ membershipRole: "observer" }) }),
    ).toEqual({ decision: "allow", effect: "review" });
    expect(
      decide({
        effect: "upload-artifacts",
        target: existingTarget({ membershipRole: "observer", publication: "private-draft" }),
        artifactBytesRequested: 512,
      }),
    ).toEqual({ decision: "allow", effect: "upload-artifacts" });
    expect(decide({ effect: "propose-problems", target: newProblemTarget() })).toEqual({
      decision: "allow",
      effect: "propose-problems",
    });
    expect(
      decide({
        effect: "session.open",
        credential: { grantedScopes: [] },
        target: sessionAdmissionTarget(),
      }),
    ).toEqual({ decision: "allow", effect: "session.open" });
    expect(
      decide({
        effect: "session.close",
        credential: { grantedScopes: [] },
        target: sessionCloseTarget(),
      }),
    ).toEqual({ decision: "allow", effect: "session.close" });
  });

  test("the refusal matrix is type-exhaustive, deterministic, and caller-opaque", () => {
    // This mapped type is the exhaustiveness mechanism. Adding a refusal
    // reason without a causal plant is a compile error; an array + Set size
    // check would only prove that the array contains itself.
    const matrix: Record<FellowAuthorizationRefusalReason, DecisionOverrides> = {
      credential_revoked: { credential: { revokedAt: NOW - 1 } },
      credential_not_yet_valid: { credential: { issuedAt: NOW + 1 } },
      credential_expired: { credential: { expiresAt: NOW } },
      fellow_status_not_writable: { credential: { fellowStatus: "paused" } },
      scope_not_granted: { credential: { grantedScopes: ["review"] }, effect: "promote" },
      grant_expired: { credential: { grantedResources: { fellowGrantExpiresAt: NOW } } },
      problem_binding_mismatch: {
        credential: { grantedResources: { problemBinding: "P-other" } },
      },
      not_a_member: { target: existingTarget({ membershipRole: undefined }) },
      role_not_permitted: { target: existingTarget({ membershipRole: "observer" }) },
      target_not_writable: {
        effect: "propose-problems",
        target: newProblemTarget({ initialPublication: "published" }),
      },
      event_budget_exhausted: {
        credential: { grantedResources: { eventBudget: 3 } },
        usage: { eventsRecorded: 3 },
      },
      artifact_budget_unverifiable: {
        effect: "upload-artifacts",
        artifactBytesRequested: -1,
      },
      artifact_budget_exhausted: {
        effect: "upload-artifacts",
        credential: { grantedResources: { artifactBudgetBytes: 100 } },
        usage: { artifactBytesRecorded: 91 },
        artifactBytesRequested: 10,
      },
      suspicious_review_write_blocked: {
        effect: "session.open",
        target: sessionAdmissionTarget(),
        credential: { fellowStatus: "suspicious_review", grantedScopes: [] },
      },
    };

    const callerFaces = new Set<string>();
    for (const [reason, overrides] of Object.entries(matrix) as [
      FellowAuthorizationRefusalReason,
      DecisionOverrides,
    ][]) {
      const first = inspect(overrides);
      const second = inspect(overrides);
      expect(first.operatorReason).toBe(reason);
      expect(second).toEqual(first);
      expect(first.decision.decision).toBe("refuse");
      if (first.decision.decision !== "refuse") throw new Error("refusal plant authorized");
      const callerProblem = fellowAuthorizationResponse(first.decision);
      expect(callerProblem).toBeDefined();
      const parsed = ProblemDocumentSchema.parse(callerProblem);
      expect(parsed).toEqual({
        type: "https://asimposium.org/errors/UNAUTHORIZED",
        title: "Authorization was not accepted",
        status: 401,
        code: "UNAUTHORIZED",
        detail: "The request did not include an authorization accepted by this route.",
        fix_hint: "Obtain a fresh sponsor authorization and retry the request.",
      });
      expect(Object.keys(parsed).sort()).toEqual(
        ["code", "detail", "fix_hint", "status", "title", "type"].sort(),
      );
      expect(JSON.stringify(first.decision)).not.toContain(reason);
      expect("operatorReason" in first.decision).toBe(false);
      callerFaces.add(JSON.stringify(callerProblem));
    }
    expect(callerFaces.size).toBe(1);
  });

  test("PLANTED: problem bindings, roles, and scope escalation do not authorize", () => {
    expect(
      inspect({
        credential: { grantedResources: { problemBinding: "P-1" } },
        target: existingTarget({ problemId: "P-2", membershipRole: "steward" }),
      }).operatorReason,
    ).toBe("problem_binding_mismatch");

    expect(
      inspect({ credential: { grantedScopes: ["review"] }, effect: "promote" }).operatorReason,
    ).toBe("scope_not_granted");

    expect(inspect({ target: existingTarget({ membershipRole: "observer" }) }).operatorReason).toBe(
      "role_not_permitted",
    );

    expect(inspect({ target: existingTarget({ membershipRole: undefined }) }).operatorReason).toBe(
      "not_a_member",
    );
  });

  test("PLANTED: stale, revoked and expired credentials are refused before scope", () => {
    // Each of these also lacks the scope, so if ordering regressed the reason
    // would change. Pinning the earlier reason pins the order.
    const scopeless = { grantedScopes: ["review" as const] };
    expect(
      inspect({ credential: { ...scopeless, revokedAt: NOW - 1 }, effect: "promote" })
        .operatorReason,
    ).toBe("credential_revoked");
    expect(
      inspect({ credential: { ...scopeless, expiresAt: NOW }, effect: "promote" }).operatorReason,
    ).toBe("credential_expired");
    expect(
      inspect({ credential: { ...scopeless, fellowStatus: "revoked" }, effect: "promote" })
        .operatorReason,
    ).toBe("fellow_status_not_writable");
  });

  test("PLANTED: suspicious-review blocks fresh session effects but quarantines other writes", () => {
    const quarantined = inspect({ credential: { fellowStatus: "suspicious_review" } });
    expect(quarantined).toEqual({
      decision: {
        decision: "quarantine",
        effect: "promote",
        handling: "blocked-pending-operator-review",
      },
      operatorReason: "suspicious_review_quarantine",
    });
    expect(fellowAuthorizationResponse(quarantined.decision)).toBeUndefined();
    expect(JSON.stringify(quarantined.decision)).not.toContain("hold");

    for (const effect of ["session.open", "session.close"] as const) {
      const blocked = inspect({
        effect,
        target: effect === "session.open" ? sessionAdmissionTarget() : sessionCloseTarget(),
        credential: { fellowStatus: "suspicious_review", grantedScopes: [] },
      });
      expect(blocked.operatorReason).toBe("suspicious_review_write_blocked");
      expect(blocked.decision.decision).toBe("refuse");
    }

    // Quarantine cannot become a way to submit an ungranted write.
    const invalid = inspect({
      credential: { fellowStatus: "suspicious_review", grantedScopes: ["review"] },
      effect: "promote",
    });
    expect(invalid.operatorReason).toBe("scope_not_granted");
    expect(invalid.decision.decision).toBe("refuse");

    for (const fellowStatus of [
      "pending",
      "paused",
      "revoked",
      "compromised",
      "archived",
    ] as const) {
      expect(inspect({ credential: { fellowStatus } }).operatorReason).toBe(
        "fellow_status_not_writable",
      );
    }
  });

  test("PLANTED: internal session effects use admission/close targets without public scopes", () => {
    const admission = sessionAdmissionTarget();
    expect(admission).toEqual({ kind: "session-admission", problemId: "P-1" });
    expect(
      decide({ effect: "session.open", credential: { grantedScopes: [] }, target: admission }),
    ).toEqual({ decision: "allow", effect: "session.open" });
    expect(
      inspect({
        effect: "session.open",
        credential: { grantedScopes: [], grantedResources: { problemBinding: "P-other" } },
        target: admission,
      }).operatorReason,
    ).toBe("problem_binding_mismatch");
    expect(
      inspect({
        effect: "session.open",
        credential: { grantedScopes: [], grantedResources: { fellowGrantExpiresAt: NOW } },
        target: admission,
      }).operatorReason,
    ).toBe("grant_expired");
    // This is only the pure evaluator's synthetic input. wqlf owns durable,
    // credential-attributed event-budget consumption and route-level races.
    expect(
      inspect({
        effect: "session.open",
        credential: { grantedScopes: [], grantedResources: { eventBudget: 1 } },
        target: admission,
        usage: { eventsRecorded: 1 },
      }).operatorReason,
    ).toBe("event_budget_exhausted");
    expect(
      inspect({
        effect: "session.close",
        credential: { grantedScopes: [] },
        target: sessionCloseTarget({ membershipRole: undefined }),
      }).operatorReason,
    ).toBe("not_a_member");
  });

  test("PLANTED: unscoped workshop writes share the central lifecycle gate", () => {
    const workshop = {
      effect: "workshop.push" as const,
      credential: { grantedScopes: [] as const },
      target: existingTarget({ publication: "private-draft", membershipRole: "observer" }),
    };

    expect(decide(workshop)).toEqual({ decision: "allow", effect: "workshop.push" });
    expect(
      inspect({
        ...workshop,
        credential: { ...workshop.credential, fellowStatus: "suspicious_review" },
      }),
    ).toEqual({
      decision: {
        decision: "quarantine",
        effect: "workshop.push",
        handling: "blocked-pending-operator-review",
      },
      operatorReason: "suspicious_review_quarantine",
    });

    for (const fellowStatus of ["paused", "revoked", "compromised"] as const) {
      const refusal = inspect({
        ...workshop,
        credential: { ...workshop.credential, fellowStatus },
      });
      expect(refusal.decision.decision).toBe("refuse");
      expect(refusal.operatorReason).toBe("fellow_status_not_writable");
    }
  });

  test("PLANTED: private-draft creation and orthogonal unlisted discovery are exact", () => {
    expect(decide({ effect: "propose-problems", target: newProblemTarget() })).toEqual({
      decision: "allow",
      effect: "propose-problems",
    });
    expect(
      inspect({
        effect: "propose-problems",
        target: newProblemTarget({ initialPublication: "published" }),
      }).operatorReason,
    ).toBe("target_not_writable");
    expect(
      inspect({
        effect: "propose-problems",
        credential: { grantedResources: { problemBinding: "P-1" } },
        target: newProblemTarget(),
      }).operatorReason,
    ).toBe("problem_binding_mismatch");

    for (const effect of ["promote", "review", "upload-artifacts", "workshop.push"] as const) {
      const listed = decide({ effect, target: existingTarget({ unlisted: false }) });
      const unlisted = decide({ effect, target: existingTarget({ unlisted: true }) });
      expect(unlisted).toEqual(listed);
    }
    expect(
      inspect({ target: existingTarget({ publication: "private-draft" }) }).operatorReason,
    ).toBe("target_not_writable");
  });

  test("PLANTED: contributor/steward promote, observers review but cannot promote", () => {
    for (const membershipRole of ["contributor", "steward"] as const) {
      expect(decide({ target: existingTarget({ membershipRole }) })).toEqual({
        decision: "allow",
        effect: "promote",
      });
    }
    expect(inspect({ target: existingTarget({ membershipRole: "observer" }) }).operatorReason).toBe(
      "role_not_permitted",
    );
    expect(
      decide({ effect: "review", target: existingTarget({ membershipRole: "observer" }) }),
    ).toEqual({ decision: "allow", effect: "review" });
  });

  test("PLANTED: event and artifact budgets are independent and boundary-exact", () => {
    expect(
      decide({
        credential: { grantedResources: { eventBudget: 3 } },
        usage: { eventsRecorded: 2 },
      }),
    ).toMatchObject({ decision: "allow" });
    expect(
      inspect({
        credential: { grantedResources: { eventBudget: 3 } },
        usage: { eventsRecorded: 3 },
      }).operatorReason,
    ).toBe("event_budget_exhausted");

    const artifactGrant = { artifactBudgetBytes: 100 };
    expect(
      decide({
        effect: "upload-artifacts",
        credential: { grantedResources: artifactGrant },
        usage: { artifactBytesRecorded: 90 },
        artifactBytesRequested: 10,
      }),
    ).toMatchObject({ decision: "allow" });
    expect(
      inspect({
        effect: "upload-artifacts",
        credential: { grantedResources: artifactGrant },
        usage: { artifactBytesRecorded: 91 },
        artifactBytesRequested: 10,
      }).operatorReason,
    ).toBe("artifact_budget_exhausted");
    expect(
      inspect({
        effect: "upload-artifacts",
        credential: { grantedResources: artifactGrant },
        artifactBytesRequested: -1,
      }).operatorReason,
    ).toBe("artifact_budget_unverifiable");
  });

  test("PLANTED: the decision never reads or returns token material", () => {
    // The binding carries a tokenHash. Authorization must not consult it, and
    // must not echo it: a decision record is diagnostic input, and the hash is
    // the one field in the binding that is credential material.
    const tokenHash = "f".repeat(64);
    for (const refuse of [false, true]) {
      const decision = decide({
        credential: { tokenHash },
        ...(refuse ? { target: existingTarget({ membershipRole: undefined }) } : {}),
      });
      expect(JSON.stringify(decision)).not.toContain(tokenHash);
      const callerProblem = fellowAuthorizationResponse(decision);
      if (callerProblem !== undefined) {
        expect(JSON.stringify(callerProblem)).not.toContain(tokenHash);
      }
    }
  });

  test("bearer acceptance is digest-keyed, so there is no secret comparison to time", async () => {
    // Structural, not chronometric. A wall-clock assertion on a shared runner
    // measures the host; these assertions measure the code.
    const { sha256Hex } = enrollmentCryptoForTests;
    const raw = `asimp_ag_${"0".repeat(26)}_${"a".repeat(43)}`;
    const digest = await sha256Hex(raw);

    // 1. The digest is not the token: what is stored cannot be replayed.
    expect(digest).not.toBe(raw);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    // 2. The store's authentication entry point takes a hash, not a token, so
    //    a raw secret cannot reach the lookup even by mistake.
    const store = new InMemoryEnrollmentStore();
    expect(await store.authenticateCredential(digest, Date.now(), "bearer")).toBeUndefined();
    expect(await store.authenticateCredential(raw, Date.now(), "bearer")).toBeUndefined();

    // 3. Uniform miss: a well-formed unknown token and a malformed one are both
    //    `undefined`, so the response shape is not an existence oracle. (They
    //    differ in time because the shape gate precedes hashing; the shape is
    //    published in the contract and the prefix is deliberately scannable.)
    const service = new EnrollmentService({
      stoaOrigin: "https://a.asimposium.org",
      agoraOrigin: "https://asimposium.org",
      store,
      replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
    });
    expect(await service.credentialBinding(raw)).toBeUndefined();
    expect(await service.credentialBinding("not-a-token")).toBeUndefined();
    expect(await service.credentialBinding("")).toBeUndefined();
  });

  test("the decision is pure: identical inputs, identical output, no clock read", () => {
    const input = {
      effect: "promote" as const,
      credential: binding(),
      target: existingTarget(),
      usage: usage(),
      now: NOW,
    };
    const first = authorizeFellowWrite(input);
    const second = authorizeFellowWrite(input);
    expect(first).toEqual(second);
    // Advancing only `now` past expiry flips the decision, proving the function
    // takes time as an input rather than reading a clock of its own.
    expect(
      inspectFellowWriteAuthorization({ ...input, now: input.credential.expiresAt }).operatorReason,
    ).toBe("credential_expired");
  });
});
