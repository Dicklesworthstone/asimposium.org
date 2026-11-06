import { expect, test } from "bun:test";
import { checkpointSigningKey } from "../../apps/wire/src/krater/checkpoint-signing.ts";
import {
  EXPORT_FORMAT,
  PUBLIC_EXPORT_FORMAT,
  PUBLIC_EXPORT_V4_FORMAT,
  parseProblemExport,
  publicationContextDigest,
  serializeProblemExport,
  serializePublicProblemExport,
} from "../../apps/wire/src/krater/export.ts";
import { unsignedExportCheckpointBundle } from "../../apps/wire/src/krater/export-signatures.ts";
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

async function verifySignedExportFormat(
  format: typeof EXPORT_FORMAT | typeof PUBLIC_EXPORT_V4_FORMAT | typeof PUBLIC_EXPORT_FORMAT,
) {
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
  const exportFor = async (
    events: typeof genuine.events,
    checkpoints: typeof genuine.checkpoints,
  ): Promise<string> => {
    if (format === EXPORT_FORMAT) return exportOf(events, checkpoints);
    const first = events[0];
    const ndjson = await serializePublicProblemExport({
      problemId: P,
      problemTitle: "t",
      events,
      checkpoints,
      generatedAt: "2026-09-25T00:00:00.000Z",
      publicationNotices:
        first === undefined
          ? []
          : [
              {
                event_id: first.eventId,
                seq: first.seq,
                payload_sha256: first.payloadSha256,
                screening_notice: {
                  category: "dual-use-boundary",
                  action: "published-with-warning",
                  notice: "screening-warning",
                },
              },
            ],
    } as never);
    if (format !== PUBLIC_EXPORT_V4_FORMAT) return ndjson;
    const records = ndjson.trimEnd().split("\n");
    const header = JSON.parse(records[0]!);
    header.format = PUBLIC_EXPORT_V4_FORMAT;
    delete header.checkpoint_signatures;
    records[0] = JSON.stringify(header);
    return `${records.join("\n")}\n`;
  };
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

  const genuineExport = await exportFor(genuine.events, genuine.checkpoints);
  const good = await verify(genuineExport);
  expect(good.failures).toEqual([]);
  expect(good.ok).toBe(true);
  expect(good.format).toBe(format);
  if (format !== EXPORT_FORMAT) {
    expect(good.publicationContextAssurance).toBe("export-self-consistency-only");
    expect(good.publicationNoticeCount).toBe(1);
    const original = genuineExport
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(good.publicationContextSha256).toBe(original[0].publication_context_sha256);
    expect(parseProblemExport(genuineExport).ok).toBe(false);

    // A valid signed event history does not excuse missing or altered context.
    const mutations = [
      (records: typeof original) => {
        records.splice(1, 1);
      },
      (records: typeof original) => {
        records[1].notices = [];
      },
      (records: typeof original) => {
        records[0].publication_context_sha256 = records[1].context_sha256 = "0".repeat(64);
      },
      (records: typeof original) => {
        records[1].problem = "P-OTHER";
      },
      (records: typeof original) => {
        records[0].format = "asimposium.problem-export.v99";
      },
    ];
    for (const mutate of mutations) {
      const altered = structuredClone(original);
      mutate(altered);
      expect(
        (await verify(`${altered.map((record) => JSON.stringify(record)).join("\n")}\n`)).ok,
      ).toBe(false);
    }

    // Checkpoint signatures bind events, not this independently mutable
    // companion. Recomputed context must never gain an authenticity label.
    const recontextualized = structuredClone(original);
    recontextualized[1].notices = [];
    recontextualized[1].context_sha256 = await publicationContextDigest(recontextualized[1]);
    recontextualized[0].publication_context_sha256 = recontextualized[1].context_sha256;
    const unpinned = await verify(
      `${recontextualized.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    expect(unpinned.ok).toBe(true);
    expect(unpinned.publicationNoticeCount).toBe(0);
    expect(unpinned.publicationContextAssurance).toBe("export-self-consistency-only");
  } else {
    expect(good.publicationContextAssurance).toBeUndefined();
  }

  // A: last event rewritten, unkeyed digests recomputed, its checkpoint dropped.
  const forged = await buildHistory([
    '{"statement":"Zero squared is even."}',
    '{"statement":"One squared is odd."}',
    '{"statement":"Two squared is ODD (forged)."}',
  ]);
  expect((await verify(await exportFor(forged.events, forged.checkpoints.slice(0, 2)))).ok).toBe(
    false,
  );
  // B: truncation.
  expect(
    (await verify(await exportFor(genuine.events.slice(0, 2), genuine.checkpoints.slice(0, 2)))).ok,
  ).toBe(false);
  // C: every event forged, no header checkpoints.
  const everything = await buildHistory(['{"statement":"X"}', '{"statement":"Y"}']);
  expect((await verify(await exportFor(everything.events, []))).ok).toBe(false);
  // E: genuine signed history plus an appended, unsigned forged event.
  const extended = await buildHistory([
    '{"statement":"Zero squared is even."}',
    '{"statement":"One squared is odd."}',
    '{"statement":"Two squared is even."}',
    '{"statement":"Three squared is even (forged, unsigned)."}',
  ]);
  expect((await verify(await exportFor(extended.events, extended.checkpoints))).ok).toBe(false);
  // D: served keys alone are never trusted.
  expect(
    (
      await verifyExportOffline({
        ndjson: await exportFor(genuine.events, genuine.checkpoints),
        signatures: face,
        trustedKeys: [],
      })
    ).ok,
  ).toBe(false);
}

for (const format of [EXPORT_FORMAT, PUBLIC_EXPORT_V4_FORMAT, PUBLIC_EXPORT_FORMAT] as const) {
  test(`the verifier anchors ${format} on trusted signatures, not on the export header`, () =>
    verifySignedExportFormat(format));
}

async function embeddedFixture(signedThrough = 3) {
  const history = await buildHistory([
    '{"statement":"Zero squared is even."}',
    '{"statement":"One squared is odd."}',
    '{"statement":"Two squared is even."}',
  ]);
  const key = await checkpointSigningKey(
    JSON.stringify({ kid: "export-key", seedHex: "12".repeat(32) }),
  );
  if (key === null) throw new Error("test signing key unavailable");
  const checkpoint = history.checkpoints[signedThrough - 1];
  if (checkpoint === undefined) throw new Error("invalid test checkpoint");
  const signature = Buffer.from(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      key.privateKey,
      new TextEncoder().encode(
        checkpointSignatureMessage({
          problemId: P,
          checkpointSeq: signedThrough,
          rootChainDigest: checkpoint.rootChainDigest,
          checkpointDigest: checkpoint.checkpointDigest,
        }),
      ),
    ),
  ).toString("hex");
  const bundle = {
    ...unsignedExportCheckpointBundle(P, history.events.length),
    keys: [{ key_id: key.kid, algorithm: "Ed25519" as const, public_key: key.publicKeyHex }],
    signatures: [
      {
        checkpoint_seq: signedThrough,
        root_chain_digest: checkpoint.rootChainDigest,
        checkpoint_digest: checkpoint.checkpointDigest,
        key_id: key.kid,
        algorithm: "Ed25519" as const,
        signature,
        signed_at: "2026-11-06T00:00:00.000Z",
      },
    ],
  };
  const input = {
    problemId: P,
    problemTitle: "Public signed export",
    events: history.events,
    checkpoints: history.checkpoints.map((checkpoint) => ({
      ...checkpoint,
      checkpointVersion: 1 as const,
      checkpointMode: "unsigned-v0" as const,
    })),
    generatedAt: "2026-11-06T00:00:00.000Z",
    publicationNotices: [
      {
        event_id: history.events[0]!.eventId,
        seq: 1,
        payload_sha256: history.events[0]!.payloadSha256,
        screening_notice: {
          category: "dual-use-boundary" as const,
          action: "published-with-warning" as const,
          notice: "screening-warning" as const,
        },
      },
    ],
    checkpointSignatures: bundle,
  };
  return {
    input,
    ndjson: await serializePublicProblemExport(input),
    trustedKeys: [{ key_id: key.kid, public_key: key.publicKeyHex }],
  };
}

test("v5 verifies offline from one export while distinguishing signature math from pinned identity", async () => {
  const fixture = await embeddedFixture();
  const trusted = await verifyExportOffline(fixture);
  expect(trusted.ok).toBe(true);
  expect(trusted.format).toBe(PUBLIC_EXPORT_FORMAT);
  expect(trusted.chainLinkageValid).toBe(true);
  expect(trusted.payloadCommitmentRecomputed).toBe(true);
  expect(trusted.checkpointSignaturesValid).toBe(true);
  expect(trusted.checkpointSignatureCount).toBe(1);
  expect(trusted.signedThrough).toBe(3);
  expect(trusted.trustedThrough).toBe(3);
  expect(trusted.signatureCoverage).toBe("complete");
  expect(trusted.authenticated).toBe(true);
  expect(trusted.authenticationScope).toBe("original-event-chain-only");
  expect(trusted.publicationContextAssurance).toBe("export-self-consistency-only");

  for (const trustedKeys of [[], [{ key_id: "export-key", public_key: "ab".repeat(32) }]]) {
    const untrusted = await verifyExportOffline({ ndjson: fixture.ndjson, trustedKeys });
    expect(untrusted.ok).toBe(false);
    expect(untrusted.chainLinkageValid).toBe(true);
    expect(untrusted.checkpointSignaturesValid).toBe(true);
    expect(untrusted.signedThrough).toBe(3);
    expect(untrusted.trustedThrough).toBe(0);
    expect(untrusted.authenticated).toBe(false);
  }
});

test("v5 keeps unsigned history and unsigned tails readable without claiming full authentication", async () => {
  const fixture = await embeddedFixture(1);
  const partial = await verifyExportOffline(fixture);
  expect(partial.ok).toBe(false);
  expect(partial.chainLinkageValid).toBe(true);
  expect(partial.payloadCommitmentRecomputed).toBe(true);
  expect(partial.checkpointSignaturesValid).toBe(true);
  expect(partial.signatureCoverage).toBe("prefix");
  expect(partial.trustedThrough).toBe(1);
  expect(partial.authenticated).toBe(false);
  const unsigned = await verifyExportOffline({
    ndjson: await serializePublicProblemExport({
      ...fixture.input,
      checkpointSignatures: undefined,
    }),
    trustedKeys: fixture.trustedKeys,
  });
  expect(unsigned.ok).toBe(false);
  expect(unsigned.chainLinkageValid).toBe(true);
  expect(unsigned.checkpointSignaturesValid).toBeNull();
  expect(unsigned.signatureCoverage).toBe("none");
  expect(unsigned.trustedThrough).toBe(0);
  expect(unsigned.authenticated).toBe(false);
});

test("v5 refuses corrupted signatures and detached keys, roots, scopes, cuts or checkpoint associations", async () => {
  const fixture = await embeddedFixture();
  const records = fixture.ndjson
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const mutations: ((rows: any[]) => void)[] = [
    (rows) => {
      rows[0].checkpoint_signatures.signatures[0].signature = "ab".repeat(64);
    },
    (rows) => {
      rows[0].checkpoint_signatures.keys[0].public_key = "ab".repeat(32);
    },
    (rows) => {
      rows[0].checkpoint_signatures.signatures[0].root_chain_digest = "ab".repeat(32);
    },
    (rows) => {
      rows[0].checkpoint_signatures.signatures[0].checkpoint_digest = "ab".repeat(32);
    },
    (rows) => {
      rows[0].checkpoint_signatures.signatures[0].checkpoint_seq = 2;
    },
    (rows) => {
      rows[0].checkpoint_signatures.signatures[0].key_id = "unavailable";
    },
    (rows) => {
      rows[0].checkpoint_signatures.problem_id = "P-OTHER";
    },
    (rows) => {
      rows[0].checkpoint_signatures.through = 4;
    },
    (rows) => {
      rows[0].checkpoint_signatures.signatures.push(rows[0].checkpoint_signatures.signatures[0]);
    },
    (rows) => {
      rows[0].checkpoints = rows[0].checkpoints.slice(0, 2);
    },
    (rows) => {
      delete rows[0].checkpoint_signatures;
    },
    (rows) => {
      rows[0].format = PUBLIC_EXPORT_V4_FORMAT;
    },
    (rows) => {
      rows[2].payload_json = "forged bytes";
    },
    (rows) => {
      delete rows[2].payload_json;
    },
    (rows) => {
      rows[2].payload_json = null;
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(records);
    mutate(changed);
    const result = await verifyExportOffline({
      ndjson: `${changed.map((row) => JSON.stringify(row)).join("\n")}\n`,
      trustedKeys: fixture.trustedKeys,
    });
    expect(result.ok).toBe(false);
    expect(result.authenticated).not.toBe(true);
  }
  // A well-formed, fully rehashed forgery still cannot reuse the signature.
  const forged = await buildHistory([
    '{"statement":"forged 1"}',
    '{"statement":"forged 2"}',
    '{"statement":"forged 3"}',
  ]);
  const ndjson = await serializePublicProblemExport({
    ...fixture.input,
    events: forged.events,
    checkpoints: forged.checkpoints as typeof fixture.input.checkpoints,
    publicationNotices: [],
  });
  const forgedResult = await verifyExportOffline({ ndjson, trustedKeys: fixture.trustedKeys });
  expect(forgedResult.ok).toBe(false);
  expect(forgedResult.chainLinkageValid).toBe(true);
  expect(forgedResult.payloadCommitmentRecomputed).toBe(true);
});

test("payload coverage is never claimed for a digest-only or redacted export", async () => {
  const fixture = await embeddedFixture();
  for (const value of [undefined, null, ""]) {
    const rows = fixture.ndjson
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    rows[2].payload_json = value;
    const result = await verifyExportOffline({
      ndjson: `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      trustedKeys: fixture.trustedKeys,
    });
    expect(result.ok).toBe(false);
    expect(result.payloadCommitmentRecomputed).not.toBe(true);
    expect(result.authenticated).not.toBe(true);
  }
});

test("v5 signatures do not authenticate publication notices or other unsigned header metadata", async () => {
  const fixture = await embeddedFixture();
  const rows = fixture.ndjson
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  rows[0].title = "An unsigned title was changed";
  rows[0].generated_at = "2026-11-07T00:00:00.000Z";
  rows[0].checkpoint_signatures.signatures[0].signed_at = "2026-11-07T00:00:00.000Z";
  rows[1].notices = [];
  rows[1].context_sha256 = await publicationContextDigest(rows[1]);
  rows[0].publication_context_sha256 = rows[1].context_sha256;
  const result = await verifyExportOffline({
    ndjson: `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    trustedKeys: fixture.trustedKeys,
  });
  expect(result.ok).toBe(true);
  expect(result.authenticated).toBe(true);
  expect(result.authenticationScope).toBe("original-event-chain-only");
  expect(result.publicationContextAssurance).toBe("export-self-consistency-only");
  expect(result.publicationNoticeCount).toBe(0);
});
