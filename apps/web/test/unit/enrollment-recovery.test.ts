import { expect, test } from "bun:test";
import {
  MintEnrollmentRequestSchema,
  SponsorEnrollmentDecisionCommandSchema,
  SponsorEnrollmentDecisionSchema,
} from "@asimposium/contracts";

import {
  bestEffortEnrollmentCacheInvalidation,
  enrollmentRecoveryConfigurationIsValid,
  enrollmentRecoveryDisposition,
  enrollmentRecoveryFingerprint,
  enrollmentRecoveryOwner,
  openEnrollmentRecoveryPayload,
  sealEnrollmentRecoveryPayload,
} from "../../lib/enrollment-recovery.ts";

const ROOT_A = "11".repeat(32);
const ROOT_B = "22".repeat(32);
const SPONSOR = "usr_fixture_sponsor";

test("the recovery fingerprint is pinned to normalized body bytes", async () => {
  const normalized = MintEnrollmentRequestSchema.parse({
    expires_in_ms: 1_800_000,
    requested_scopes: ["promote", "review"],
  });
  expect(await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "mint", normalized)).toBe(
    "8903c76bfebba06288ef3a744df62ee0e121898e3b6d9d4fc5fb2956a3d07828",
  );

  const reorderedInput = MintEnrollmentRequestSchema.parse({
    requested_scopes: ["promote", "review"],
    expires_in_ms: 1_800_000,
  });
  expect(await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "mint", reorderedInput)).toBe(
    await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "mint", normalized),
  );
});

test("sponsor, operation, body, and dedicated root are independent domains", async () => {
  const body = MintEnrollmentRequestSchema.parse({
    requested_scopes: ["review"],
    expires_in_ms: 60_000,
    first_directive: "Keep this private",
  });
  const baseline = await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "mint", body);
  const variants = await Promise.all([
    enrollmentRecoveryFingerprint(ROOT_A, "usr_other_sponsor", "mint", body),
    enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "decision", body),
    enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "mint", {
      ...body,
      first_directive: "Different private directive",
    }),
    enrollmentRecoveryFingerprint(ROOT_B, SPONSOR, "mint", body),
  ]);

  expect(new Set([baseline, ...variants]).size).toBe(5);
  expect(baseline).toMatch(/^[a-f0-9]{64}$/);
  expect(baseline).not.toContain("Keep this private");
});

test("decision recovery fingerprints stable intent while Agora owns step-up evidence", async () => {
  const intent = SponsorEnrollmentDecisionSchema.parse({
    enrollment_id: "ASIMP-EN-01JXYZ4K6Q",
    decision: "approve",
  });
  const firstFingerprint = await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "decision", intent);
  for (const stepUpAuthenticatedAt of [1_786_800_000, 1_786_800_900]) {
    const command = SponsorEnrollmentDecisionCommandSchema.parse({
      ...intent,
      step_up_authenticated_at: stepUpAuthenticatedAt,
    });
    expect(command.step_up_authenticated_at).toBe(stepUpAuthenticatedAt);
    expect(
      await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "decision", intent),
    ).toBe(firstFingerprint);
  }
});

test("the page owner is a stable sponsor binding and changes across principals", async () => {
  const owner = await enrollmentRecoveryOwner(ROOT_A, SPONSOR);
  expect(owner).toBe(
    await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "mint", {
      purpose: "client-memory-owner-v1",
    }),
  );
  expect(await enrollmentRecoveryOwner(ROOT_A, "usr_other_sponsor")).not.toBe(owner);
  expect(await enrollmentRecoveryOwner(ROOT_B, SPONSOR)).not.toBe(owner);
});

test("the exact recovery body is authenticated, sponsor-bound, and expires closed", async () => {
  const privateDirective = "private-directive-canary";
  const fingerprint = await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "mint", {
    requested_scopes: ["review"],
    first_directive: privateDirective,
  });
  const envelope = await sealEnrollmentRecoveryPayload(ROOT_A, {
    sponsorId: SPONSOR,
    scope: "mint",
    fingerprint,
    idempotencyKey: "console-original-key",
    expiresAt: 2_000,
    request: {
      requested_scopes: ["review"],
      first_directive: privateDirective,
    },
  });
  expect(envelope).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  expect(envelope).not.toContain(privateDirective);
  await expect(
    openEnrollmentRecoveryPayload(ROOT_A, envelope, SPONSOR, "mint", 1_999),
  ).resolves.toMatchObject({
    sponsorId: SPONSOR,
    scope: "mint",
    fingerprint,
    idempotencyKey: "console-original-key",
    request: { first_directive: privateDirective },
  });
  await expect(
    openEnrollmentRecoveryPayload(ROOT_A, envelope, "usr_other_sponsor", "mint", 1_999),
  ).rejects.toThrow("invalid enrollment recovery payload");
  await expect(
    openEnrollmentRecoveryPayload(ROOT_A, envelope, SPONSOR, "decision", 1_999),
  ).rejects.toThrow("invalid enrollment recovery payload");
  await expect(
    openEnrollmentRecoveryPayload(ROOT_A, envelope, SPONSOR, "mint", 2_000),
  ).rejects.toThrow("invalid enrollment recovery payload");
  const replacement = envelope.endsWith("A") ? "B" : "A";
  await expect(
    openEnrollmentRecoveryPayload(
      ROOT_A,
      `${envelope.slice(0, -1)}${replacement}`,
      SPONSOR,
      "mint",
      1_999,
    ),
  ).rejects.toThrow("invalid enrollment recovery payload");
});

test("malformed recovery roots fail before producing a reusable identity", async () => {
  await expect(enrollmentRecoveryFingerprint("AA".repeat(32), SPONSOR, "mint", {})).rejects.toThrow(
    "32 lowercase-hex bytes",
  );
  await expect(enrollmentRecoveryFingerprint("11", SPONSOR, "mint", {})).rejects.toThrow(
    "32 lowercase-hex bytes",
  );
});

test("write readiness requires an independent well-formed recovery key", () => {
  expect(enrollmentRecoveryConfigurationIsValid(ROOT_A, ROOT_B)).toBe(true);
  expect(enrollmentRecoveryConfigurationIsValid(ROOT_A, ROOT_A)).toBe(false);
  expect(enrollmentRecoveryConfigurationIsValid(undefined, ROOT_B)).toBe(false);
  expect(enrollmentRecoveryConfigurationIsValid("AA".repeat(32), ROOT_B)).toBe(false);
  expect(enrollmentRecoveryConfigurationIsValid("11", ROOT_B)).toBe(false);
});

test("only definite local or schema-valid non-ambiguous Worker refusals discard recovery", () => {
  expect(enrollmentRecoveryDisposition("unconfigured")).toBe("clear");
  expect(enrollmentRecoveryDisposition("unreachable")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 400, "MINT_BODY_INVALID")).toBe("clear");
  expect(enrollmentRecoveryDisposition("refused", 404, "PROPOSAL_NOT_PENDING")).toBe("clear");
  expect(enrollmentRecoveryDisposition("refused", 403, "STEP_UP_REQUIRED")).toBe("clear");
  expect(enrollmentRecoveryDisposition("refused", 408, "ENROLLMENT_UNAVAILABLE")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 425, "ENROLLMENT_UNAVAILABLE")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 429, "ENROLLMENT_UNAVAILABLE")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 400, "ENROLLMENT_UNAVAILABLE")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 400, "INTERNAL_ERROR")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 400)).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 500, "ENROLLMENT_UNAVAILABLE")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 503, "ENROLLMENT_UNAVAILABLE")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 302)).toBe("retain");
});

test("cache invalidation cannot suppress an already committed one-time result", () => {
  let calls = 0;
  expect(() =>
    bestEffortEnrollmentCacheInvalidation(() => {
      calls += 1;
      throw new Error("cache unavailable");
    }),
  ).not.toThrow();
  expect(calls).toBe(1);
});
