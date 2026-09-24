import { describe, expect, test } from "bun:test";
import {
  checkpointSigningKey,
  checkpointVerifyKeys,
  verifyCheckpointSignature,
} from "../../src/krater/checkpoint-signing.ts";

const SEED = "11".repeat(32);

describe("checkpoint signing keys (ADR-23)", () => {
  test("absent, malformed or wrong-length keys disable signing", async () => {
    for (const raw of [
      undefined,
      "",
      "not json",
      JSON.stringify({ kid: "k1" }),
      JSON.stringify({ kid: "k1", seedHex: "12" }),
      JSON.stringify({ kid: "bad kid!", seedHex: SEED }),
      JSON.stringify({ kid: "k1", seedHex: "ZZ".repeat(32) }),
    ]) {
      expect(await checkpointSigningKey(raw)).toBeNull();
    }
  });

  test("a valid seed signs a message that verifies only under its own public key", async () => {
    const key = await checkpointSigningKey(JSON.stringify({ kid: "k1", seedHex: SEED }));
    expect(key?.kid).toBe("k1");
    expect(key?.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    const other = await checkpointSigningKey(
      JSON.stringify({ kid: "k2", seedHex: "22".repeat(32) }),
    );
    if (key === null || other === null) throw new Error("keys");
    const record = {
      checkpoint_seq: 3,
      root_chain_digest: "a".repeat(64),
      checkpoint_digest: "b".repeat(64),
    };
    const { checkpointSignatureMessage } = await import("@asimposium/contracts");
    const signature = Buffer.from(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        key.privateKey,
        new TextEncoder().encode(
          checkpointSignatureMessage({
            problemId: "P-X",
            checkpointSeq: 3,
            rootChainDigest: record.root_chain_digest,
            checkpointDigest: record.checkpoint_digest,
          }),
        ),
      ),
    ).toString("hex");
    expect(await verifyCheckpointSignature("P-X", { ...record, signature }, key.publicKeyHex)).toBe(
      true,
    );
    expect(
      await verifyCheckpointSignature("P-X", { ...record, signature }, other.publicKeyHex),
    ).toBe(false);
    expect(await verifyCheckpointSignature("P-Y", { ...record, signature }, key.publicKeyHex)).toBe(
      false,
    );
    expect(
      await verifyCheckpointSignature(
        "P-X",
        { ...record, checkpoint_seq: 4, signature },
        key.publicKeyHex,
      ),
    ).toBe(false);
  });

  test("verification keys drop malformed entries and never trust them", () => {
    expect(checkpointVerifyKeys(undefined)).toEqual([]);
    expect(checkpointVerifyKeys("{}")).toEqual([]);
    expect(
      checkpointVerifyKeys(
        JSON.stringify([
          { kid: "ok", publicKeyHex: "c".repeat(64) },
          { kid: "short", publicKeyHex: "c".repeat(10) },
          { kid: "bad kid", publicKeyHex: "c".repeat(64) },
        ]),
      ),
    ).toEqual([{ kid: "ok", publicKeyHex: "c".repeat(64) }]);
  });
});
