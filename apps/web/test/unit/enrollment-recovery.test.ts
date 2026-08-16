import { expect, test } from "bun:test";
import { MintEnrollmentRequestSchema } from "@asimposium/contracts";

import {
  enrollmentRecoveryConfigurationIsValid,
  enrollmentRecoveryDisposition,
  enrollmentRecoveryFingerprint,
  enrollmentRecoveryStateForOwner,
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

test("malformed recovery roots fail before producing a reusable identity", async () => {
  await expect(
    enrollmentRecoveryFingerprint("AA".repeat(32), SPONSOR, "mint", {}),
  ).rejects.toThrow("32 lowercase-hex bytes");
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

test("only definite local or 4xx refusals discard a recovery identity", () => {
  expect(enrollmentRecoveryDisposition("unconfigured")).toBe("clear");
  expect(enrollmentRecoveryDisposition("unreachable")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 400)).toBe("clear");
  expect(enrollmentRecoveryDisposition("refused", 404)).toBe("clear");
  expect(enrollmentRecoveryDisposition("refused", 429)).toBe("clear");
  expect(enrollmentRecoveryDisposition("refused", 500)).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 503)).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 302)).toBe("retain");
});

test("client-memory recovery state is never restored across sponsor owners", () => {
  const state = { owner: "owner-a", secret: "fragment-secret" };
  expect(enrollmentRecoveryStateForOwner("owner-a", state)).toBe(state);
  expect(enrollmentRecoveryStateForOwner("owner-b", state)).toBeNull();
  expect(enrollmentRecoveryStateForOwner(undefined, state)).toBeNull();
  expect(enrollmentRecoveryStateForOwner("owner-a", null)).toBeNull();
});
