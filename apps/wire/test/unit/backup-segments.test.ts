import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { checkpointSignatureMessage } from "@asimposium/contracts";
import { assembleLedgerBackup } from "../../../../scripts/assemble-ledger-backup.ts";
import { verifyExportOffline } from "../../../../scripts/verify-export.ts";
import {
  type BackupManifest,
  backupManifestKey,
  backupProblemSegment,
  backupSegmentKey,
} from "../../src/krater/backup-segments.ts";
import { checkpointSigningKey } from "../../src/krater/checkpoint-signing.ts";
import {
  type ProblemExportEvent,
  parseProblemExport,
  serializeProblemExport,
  verifyProblemExportChain,
  verifyProblemExportSegment,
  verifyProblemRestorePreflight,
} from "../../src/krater/export.ts";
import {
  checkpointDigest,
  eventChainDigest,
  eventEnvelopeRowDigest,
  genesisChainDigest,
  type KraterCheckpoint,
  sha256Hex,
} from "../../src/krater/krater.ts";

const problemId = "P-SEGMENTED";
const signer = await checkpointSigningKey(
  JSON.stringify({ kid: "segments-test", seedHex: "3b".repeat(32) }),
);
if (!signer) throw new Error("test key unavailable");
const trustedKeys = [{ key_id: signer.kid, public_key: signer.publicKeyHex }];
const events: ProblemExportEvent[] = [];
const checkpoints: KraterCheckpoint[] = [];
let previous = await genesisChainDigest(problemId);
for (let seq = 1; seq <= 5; seq++) {
  const payloadJson = JSON.stringify({
    body_md: seq === 3 ? `Record ${seq}.${"x".repeat(20000)}` : `Record ${seq}.`,
  });
  const envelope = {
    problemId,
    eventId: `E-SEGMENT-${seq}`,
    seq,
    type: "commentary.posted",
    objectKind: "commentary",
    objectId: `COMMENT-${seq}`,
    objectVersion: 1,
    payloadSha256: await sha256Hex(payloadJson),
    createdAt: "2026-10-27T00:00:00Z",
    actorFellowId: null,
    actorSponsorId: null,
    actorSessionId: null,
    modelStringSelfDeclared: null,
    harness: null,
    writerCredentialId: null,
  };
  const rowDigest = await eventEnvelopeRowDigest(envelope);
  const chainDigest = await eventChainDigest(
    problemId,
    seq,
    envelope.payloadSha256,
    rowDigest,
    previous,
  );
  events.push({ ...envelope, rowDigest, chainDigest, chainVersion: 2, payloadJson });
  checkpoints.push({
    problemId,
    checkpointSeq: seq,
    rootChainDigest: chainDigest,
    checkpointDigest: await checkpointDigest(problemId, seq, chainDigest),
    chainVersion: 2,
    checkpointVersion: 1,
    checkpointMode: "unsigned-v0",
  });
  previous = chainDigest;
}
const terminal = checkpoints.at(-1);
const precedingRoot = events[1]?.chainDigest;
if (!terminal || !precedingRoot) throw new Error("test history is incomplete");
const signed = new Uint8Array(
  await crypto.subtle.sign(
    "Ed25519",
    signer.privateKey,
    new TextEncoder().encode(checkpointSignatureMessage(terminal)),
  ),
);
const manifest: BackupManifest = {
  format: "asimposium.segmented-ledger-backup.v1",
  problem_id: problemId,
  title: "Segmented archive",
  date: "2026-10-27",
  cursor: 5,
  chain_digest: previous,
  segments: 2,
  terminal_signature: {
    checkpoint_seq: 5,
    root_chain_digest: previous,
    checkpoint_digest: terminal.checkpointDigest,
    key_id: signer.kid,
    algorithm: "Ed25519",
    signed_at: "2026-10-27T00:00:00Z",
    signature: Array.from(signed, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  },
};
const serialize = (start: number, end: number) =>
  serializeProblemExport({
    problemId,
    problemTitle: manifest.title,
    generatedAt: `${manifest.date}T00:00:00Z`,
    events: events.slice(start, end),
    checkpoints: checkpoints.slice(start, end),
  });
const bodies = new Map([
  [backupSegmentKey(manifest, 1), serialize(0, 2)],
  [backupSegmentKey(manifest, 2), serialize(2, 5)],
]);
const assemble = (overrides: Partial<Parameters<typeof assembleLedgerBackup>[0]> = {}) =>
  assembleLedgerBackup({
    manifest,
    trustedKeys,
    readSegment: async (key) => bodies.get(key) ?? null,
    ...overrides,
  });

/** Unit SQL adapter, not a real-binding claim; the separate Workerd lane
 * exercises these exact readers and scheduler against Cloudflare bindings. */
function snapshotDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE problems (id TEXT, public_seq INTEGER, chain_digest TEXT, chain_version INTEGER);
    CREATE TABLE events (id TEXT, problem_id TEXT, seq INTEGER, type TEXT, object_kind TEXT,
      object_id TEXT, object_version INTEGER, payload_sha256 TEXT, created_at TEXT,
      actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT,
      model_string_self_declared TEXT, harness TEXT, writer_credential_id TEXT);
    CREATE TABLE event_content (event_id TEXT, payload_json TEXT, payload_sha256 TEXT, redacted_at INTEGER);
    CREATE TABLE event_chain_v2 (event_id TEXT, problem_id TEXT, seq INTEGER, row_digest TEXT, chain_digest TEXT, chain_version INTEGER);
    CREATE TABLE integrity_checkpoints (problem_id TEXT, checkpoint_seq INTEGER, checkpoint_version INTEGER, checkpoint_mode TEXT);
    CREATE TABLE checkpoint_chain_v2 (problem_id TEXT, checkpoint_seq INTEGER, root_chain_digest TEXT, checkpoint_digest TEXT, chain_version INTEGER);
    CREATE TABLE checkpoint_signatures (problem_id TEXT, checkpoint_seq INTEGER, key_id TEXT, algorithm TEXT, signature TEXT, signed_at TEXT);`);
  sqlite.query("INSERT INTO problems VALUES (?,5,?,2)").run(problemId, previous);
  for (const event of events) {
    sqlite
      .query("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        event.eventId,
        problemId,
        event.seq,
        event.type,
        event.objectKind,
        event.objectId,
        event.objectVersion,
        event.payloadSha256,
        event.createdAt,
        event.actorFellowId,
        event.actorSponsorId,
        event.actorSessionId,
        event.modelStringSelfDeclared,
        event.harness,
        event.writerCredentialId,
      );
    sqlite
      .query("INSERT INTO event_content VALUES (?,?,?,NULL)")
      .run(event.eventId, event.payloadJson, event.payloadSha256);
    sqlite
      .query("INSERT INTO event_chain_v2 VALUES (?,?,?,?,?,2)")
      .run(event.eventId, problemId, event.seq, event.rowDigest, event.chainDigest);
  }
  for (const checkpoint of checkpoints) {
    sqlite
      .query("INSERT INTO integrity_checkpoints VALUES (?,?,1,'unsigned-v0')")
      .run(problemId, checkpoint.checkpointSeq);
    sqlite
      .query("INSERT INTO checkpoint_chain_v2 VALUES (?,?,?,?,2)")
      .run(
        problemId,
        checkpoint.checkpointSeq,
        checkpoint.rootChainDigest,
        checkpoint.checkpointDigest,
      );
  }
  const signature = manifest.terminal_signature;
  sqlite
    .query("INSERT INTO checkpoint_signatures VALUES (?,?,?,'Ed25519',?,?)")
    .run(
      problemId,
      signature.checkpoint_seq,
      signature.key_id,
      signature.signature,
      signature.signed_at,
    );
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => sqlite.query(sql).get(...(values as never)) ?? null,
        all: async () => ({ results: sqlite.query(sql).all(...(values as never)) }),
      }),
    }),
  } as never;
}

describe("segmented backup recovery retains the existing strict export contract", () => {
  test("bounded SQL ranges advance across ticks and publish their manifest only at the terminal root", async () => {
    const writes = new Map<string, string>();
    const input = {
      db: snapshotDb(),
      bucket: { put: async (key: string, body: string) => writes.set(key, body) },
      problemId,
      title: manifest.title,
      date: manifest.date,
      cursor: 5,
      chainDigest: previous,
      checkpointVerifyKeys: JSON.stringify([
        { kid: signer.kid, publicKeyHex: signer.publicKeyHex },
      ]),
      limits: { maxEvents: 2, maxPayloadBytes: 30000, maxExportBytes: 100000 },
    };
    const first = await backupProblemSegment({ ...input, progress: null });
    expect(first.progress.after).toBe(2);
    expect(first.complete).toBe(false);
    expect(writes.has(backupManifestKey(manifest))).toBe(false);
    const second = await backupProblemSegment({ ...input, progress: first.progress });
    expect(second.progress.after).toBe(4);
    expect(writes.has(backupManifestKey(manifest))).toBe(false);
    const final = await backupProblemSegment({ ...input, progress: second.progress });
    expect(final.complete).toBe(true);
    expect(final.archive?.eventCount).toBe(5);
    const recovered = await assembleLedgerBackup({
      manifest: JSON.parse(writes.get(backupManifestKey(manifest)) ?? "null"),
      trustedKeys,
      readSegment: async (key) => writes.get(key) ?? null,
    });
    expect(recovered.ndjson).toBe(serialize(0, 5));
    const boundedByBytes = await backupProblemSegment({
      ...input,
      progress: null,
      limits: { ...input.limits, maxPayloadBytes: Buffer.byteLength(events[0]?.payloadJson ?? "") },
    });
    expect(boundedByBytes.progress.after).toBe(1);
    await expect(
      backupProblemSegment({
        ...input,
        progress: { ...first.progress, chainDigest: "00".repeat(32) },
      }),
    ).rejects.toThrow("BACKUP_HEAD_PREFIX_MISMATCH");
    await expect(
      backupProblemSegment({
        ...input,
        progress: null,
        limits: { ...input.limits, maxEvents: 1001 },
      }),
    ).rejects.toThrow("BACKUP_LIMITS_INVALID");
  });
  test("a continuation is refused by the full-export verifier but verifies from its exact preceding root", async () => {
    expect((await verifyProblemExportChain(serialize(2, 5))).intact).toBe(false);
    expect(
      (
        await verifyProblemExportSegment(
          serialize(2, 5),
          { problemId, checkpointSeq: 2, rootChainDigest: precedingRoot },
          { problemId, checkpointSeq: 5, rootChainDigest: previous },
        )
      ).intact,
    ).toBe(true);
    expect(
      (
        await verifyProblemExportSegment(
          serialize(2, 5),
          { problemId, checkpointSeq: 2, rootChainDigest: "00".repeat(32) },
          { problemId, checkpointSeq: 5, rootChainDigest: previous },
        )
      ).intact,
    ).toBe(false);
  });
  test("assembly produces the exact ordinary export accepted by offline and restore verification", async () => {
    expect(Buffer.byteLength(events[2]?.payloadJson ?? "")).toBeGreaterThan(16384);
    const result = await assemble();
    expect(result.ndjson).toBe(serialize(0, 5));
    expect((await verifyExportOffline({ ...result, trustedKeys })).ok).toBe(true);
    expect((await verifyProblemRestorePreflight(result.ndjson, terminal)).intact).toBe(true);
  });
  test("export payloads remain limited by the actual ingress UTF-8 byte bound", () => {
    const lines = serialize(0, 5).split("\n");
    const event = JSON.parse(lines[1] as string);
    event.payload_json = JSON.stringify({ body_md: "é".repeat(300000) });
    expect(event.payload_json.length).toBeLessThan(512 * 1024);
    lines[1] = JSON.stringify(event);
    expect(parseProblemExport(lines.join("\n")).ok).toBe(false);
  });
  test("missing, reordered, changed and truncated segment sets never become complete", async () => {
    await expect(assemble({ readSegment: async () => null })).rejects.toThrow(
      "BACKUP_SEGMENT_MISSING",
    );
    await expect(
      assemble({
        readSegment: async (key) => bodies.get(key)?.replace("Record 3.", "Forged 3.") ?? null,
      }),
    ).rejects.toThrow("BACKUP_SEGMENT_CHAIN_INVALID");
    await expect(assemble({ readSegment: async () => serialize(2, 5) })).rejects.toThrow(
      "BACKUP_SEGMENT_CHAIN_INVALID",
    );
    await expect(assemble({ manifest: { ...manifest, segments: 1 } })).rejects.toThrow(
      "BACKUP_MANIFEST_TERMINAL_MISMATCH",
    );
  });
  test("stripped terminal checkpoint metadata cannot produce a restore-incompatible export", async () => {
    await expect(
      assemble({
        readSegment: async (key) => {
          const body = bodies.get(key);
          if (!body) return null;
          const lines = body.split("\n");
          const header = JSON.parse(lines[0] as string);
          header.checkpoints = [];
          lines[0] = JSON.stringify(header);
          return lines.join("\n");
        },
      }),
    ).rejects.toThrow("BACKUP_ASSEMBLY_INVALID");
  });
  test("an independently pinned signature is required before reading any segment", async () => {
    let read = false;
    await expect(
      assemble({
        trustedKeys: [{ key_id: signer.kid, public_key: "00".repeat(32) }],
        readSegment: async () => {
          read = true;
          return null;
        },
      }),
    ).rejects.toThrow("BACKUP_MANIFEST_SIGNATURE_INVALID");
    expect(read).toBe(false);
    await expect(assemble({ manifest: { ...manifest, cursor: 4 } })).rejects.toThrow();
  });
});
