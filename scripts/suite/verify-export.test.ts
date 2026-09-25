import { expect, test } from "bun:test";
import { serializeProblemExport } from "../../apps/wire/src/krater/export.ts";
import {
  checkpointDigest,
  eventChainDigest,
  eventEnvelopeRowDigest,
  genesisChainDigest,
  KRATER_CHAIN_VERSION,
  sha256Hex,
} from "../../apps/wire/src/krater/krater.ts";
import {
  CHECKPOINT_SIGNATURE_MESSAGE_FORMAT,
  checkpointSignatureMessage,
} from "../../packages/contracts/src/ledger.ts";
import { verifyExportOffline } from "../verify-export.ts";

// 10lz / ADR-23: an attacker WITHOUT the signing key must not be able to make
// scripts/verify-export.ts accept a forged export. These are the three
// forgeries an independent verifier found against the first version, which
// trusted the export header's own checkpoint list.

const P = "P-FORGE";
const bare = (digest: string) => digest.replace(/^sha256:/, "");

async function buildHistory(payloads: readonly string[]) {
  let previous = await genesisChainDigest(P);
  const events = [];
  const checkpoints = [];
  for (const [index, payloadJson] of payloads.entries()) {
    const seq = index + 1;
    const payloadSha256 = await sha256Hex(payloadJson);
    const envelope = {
      eventId: `E-FORGE${seq}`,
      problemId: P,
      seq,
      type: "claim.created",
      objectKind: "claim",
      objectId: `C-${seq}`,
      objectVersion: 1,
      payloadSha256,
      createdAt: "2026-09-25T00:00:00.000Z",
      actorFellowId: "F-1",
      actorSponsorId: "S-1",
      actorSessionId: "SS-1",
      modelStringSelfDeclared: "m",
      harness: "h",
      writerCredentialId: "W-1",
    };
    const rowDigest = await eventEnvelopeRowDigest(envelope as never);
    const chainDigest = await eventChainDigest(P, seq, payloadSha256, rowDigest, previous);
    previous = chainDigest;
    events.push({
      ...envelope,
      rowDigest,
      chainDigest,
      chainVersion: KRATER_CHAIN_VERSION,
      payloadJson,
    });
    checkpoints.push({
      problemId: P,
      checkpointSeq: seq,
      rootChainDigest: chainDigest,
      checkpointDigest: await checkpointDigest(P, seq, chainDigest),
      checkpointVersion: 1,
      chainVersion: KRATER_CHAIN_VERSION,
      checkpointMode: "unsigned-v0",
    });
  }
  return { events, checkpoints };
}

const exportOf = (events: unknown[], checkpoints: unknown[]) =>
  serializeProblemExport({
    problemId: P,
    problemTitle: "t",
    events,
    checkpoints,
    generatedAt: "2026-09-25T00:00:00.000Z",
  } as never);

test("the verifier anchors on trusted signatures, not on the export header", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString(
    "hex",
  );
  const genuine = await buildHistory([
    '{"statement":"Zero squared is even."}',
    '{"statement":"One squared is odd."}',
    '{"statement":"Two squared is even."}',
  ]);
  const signatures = [];
  for (const c of genuine.checkpoints) {
    const root = bare(c.rootChainDigest);
    const digest = bare(c.checkpointDigest);
    const message = checkpointSignatureMessage({
      problemId: P,
      checkpointSeq: c.checkpointSeq,
      rootChainDigest: root,
      checkpointDigest: digest,
    });
    const signature = Buffer.from(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        pair.privateKey,
        new TextEncoder().encode(message),
      ),
    ).toString("hex");
    signatures.push({
      checkpoint_seq: c.checkpointSeq,
      root_chain_digest: root,
      checkpoint_digest: digest,
      key_id: "k1",
      algorithm: "Ed25519",
      signature,
      signed_at: "2026-09-25T00:00:00.000Z",
    });
  }
  const face = {
    problem_id: P,
    message_format: CHECKPOINT_SIGNATURE_MESSAGE_FORMAT,
    keys: [{ key_id: "k1", algorithm: "Ed25519", public_key: publicKey }],
    signatures,
    unsigned: 0,
    next_after: null,
  };
  const trustedKeys = [{ key_id: "k1", public_key: publicKey }];
  const verify = (ndjson: string) => verifyExportOffline({ ndjson, signatures: face, trustedKeys });

  const good = await verify(exportOf(genuine.events, genuine.checkpoints));
  expect(good.failures).toEqual([]);
  expect(good.ok).toBe(true);

  // A: last event rewritten, unkeyed digests recomputed, its checkpoint dropped.
  const forged = await buildHistory([
    '{"statement":"Zero squared is even."}',
    '{"statement":"One squared is odd."}',
    '{"statement":"Two squared is ODD (forged)."}',
  ]);
  expect((await verify(exportOf(forged.events, forged.checkpoints.slice(0, 2)))).ok).toBe(false);
  // B: truncation.
  expect(
    (await verify(exportOf(genuine.events.slice(0, 2), genuine.checkpoints.slice(0, 2)))).ok,
  ).toBe(false);
  // C: every event forged, no header checkpoints.
  const everything = await buildHistory(['{"statement":"X"}', '{"statement":"Y"}']);
  expect((await verify(exportOf(everything.events, []))).ok).toBe(false);
  // E: genuine signed history plus an appended, unsigned forged event.
  const extended = await buildHistory([
    '{"statement":"Zero squared is even."}',
    '{"statement":"One squared is odd."}',
    '{"statement":"Two squared is even."}',
    '{"statement":"Three squared is even (forged, unsigned)."}',
  ]);
  expect((await verify(exportOf(extended.events, extended.checkpoints))).ok).toBe(false);
  // D: served keys alone are never trusted.
  expect(
    (
      await verifyExportOffline({
        ndjson: exportOf(genuine.events, genuine.checkpoints),
        signatures: face,
        trustedKeys: [],
      })
    ).ok,
  ).toBe(false);
});
