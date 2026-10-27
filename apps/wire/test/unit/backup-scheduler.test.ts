import { describe, expect, test } from "bun:test";
import { runScheduledBackup } from "../../src/krater/backup-scheduler.ts";
import { checkpointSigningKey } from "../../src/krater/checkpoint-signing.ts";

// Pure configuration checks; the leased cursor and archive writes are tested
// separately against real Workerd/D1/R2 in backup-scheduler-real-bindings.mjs.
const signing = JSON.stringify({ kid: "backup-unit", seedHex: "5c".repeat(32) });
const signer = await checkpointSigningKey(signing);
if (!signer) throw new Error("the test signing key must import");
const verification = JSON.stringify([{ kid: signer.kid, publicKeyHex: signer.publicKeyHex }]);
function env(keys: Record<string, string | undefined>) {
  return {
    DB: new Proxy(
      {},
      {
        get() {
          throw new Error("configuration refusal touched D1");
        },
      },
    ),
    ARTIFACTS: new Proxy(
      {},
      {
        get() {
          throw new Error("configuration refusal touched R2");
        },
      },
    ),
    ...keys,
  } as Parameters<typeof runScheduledBackup>[0];
}

describe("nightly backups distinguish disabled and invalid key configuration", () => {
  test("missing keys explicitly disable backups without claiming completion", async () => {
    expect(await runScheduledBackup(env({}))).toEqual({
      enabled: false,
      status: "disabled",
      reason: "signing_key_missing",
    });
    expect(await runScheduledBackup(env({ CHECKPOINT_SIGNING_KEY: signing }))).toEqual({
      enabled: false,
      status: "disabled",
      reason: "verification_keys_missing",
    });
  });

  test("configured malformed signing keys fail even if verification keys are absent", async () => {
    for (const key of ["", "not-json", JSON.stringify({ kid: "x", seedHex: "00" })]) {
      await expect(runScheduledBackup(env({ CHECKPOINT_SIGNING_KEY: key }))).rejects.toThrow(
        "BACKUP_SIGNING_KEY_INVALID",
      );
    }
  });

  test("invalid, empty, truncated and duplicate verification keyrings fail", async () => {
    for (const keys of [
      "",
      "not-json",
      "[]",
      "[{}]",
      verification.replace("]", ",{}]"),
      JSON.stringify([JSON.parse(verification)[0], JSON.parse(verification)[0]]),
    ]) {
      await expect(
        runScheduledBackup(env({ CHECKPOINT_SIGNING_KEY: signing, CHECKPOINT_VERIFY_KEYS: keys })),
      ).rejects.toThrow("BACKUP_VERIFICATION_KEYS_INVALID");
    }
  });

  test("a valid signing key must match the independently configured public pin", async () => {
    await expect(
      runScheduledBackup(
        env({
          CHECKPOINT_SIGNING_KEY: signing,
          CHECKPOINT_VERIFY_KEYS: JSON.stringify([
            { kid: signer.kid, publicKeyHex: "ab".repeat(32) },
          ]),
        }),
      ),
    ).rejects.toThrow("BACKUP_SIGNING_KEY_NOT_PINNED");
  });
});
