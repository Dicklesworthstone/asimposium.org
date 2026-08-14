import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { MintEnrollmentRequest } from "@asimposium/contracts";

import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentError,
  EnrollmentReplayConfigurationError,
  EnrollmentService,
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
