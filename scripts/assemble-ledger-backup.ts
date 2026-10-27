/** Offline recovery of private segmented archives into the existing v3 JSONL
 * format. No database or cloud credentials are used. Never run assembly in a
 * Worker: the assembled output intentionally occupies host memory, just like
 * the existing full-export restore tooling. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CHECKPOINT_SIGNATURE_MESSAGE_FORMAT } from "@asimposium/contracts";
import {
  BACKUP_SEGMENT_LIMITS,
  BackupManifestSchema,
  backupSegmentKey,
} from "../apps/wire/src/krater/backup-segments.ts";
import { verifyCheckpointSignature } from "../apps/wire/src/krater/checkpoint-signing.ts";
import {
  EXPORT_FORMAT,
  EXPORT_LICENSE,
  parseProblemExportSegment,
  verifyProblemExportSegment,
  verifyProblemRestorePreflight,
} from "../apps/wire/src/krater/export.ts";
import { checkpointDigest, genesisChainDigest } from "../apps/wire/src/krater/krater.ts";

export async function assembleLedgerBackup(input: {
  manifest: unknown;
  trustedKeys: readonly { key_id: string; public_key: string }[];
  /** Exact storage keys; the caller supplies their downloaded private root. */
  readSegment: (key: string) => Promise<string | null>;
}) {
  const manifest = BackupManifestSchema.parse(input.manifest);
  const signature = manifest.terminal_signature;
  const trusted = input.trustedKeys.find((key) => key.key_id === signature.key_id);
  if (
    !trusted ||
    !(await verifyCheckpointSignature(manifest.problem_id, signature, trusted.public_key)) ||
    signature.checkpoint_digest !==
      (await checkpointDigest(manifest.problem_id, manifest.cursor, manifest.chain_digest))
  )
    throw new Error("BACKUP_MANIFEST_SIGNATURE_INVALID");
  let cursor = 0;
  let root = await genesisChainDigest(manifest.problem_id);
  const eventLines: string[] = [];
  const checkpoints: unknown[] = [];
  for (let index = 1; index <= manifest.segments; index++) {
    const body = await input.readSegment(backupSegmentKey(manifest, index));
    if (body === null) throw new Error("BACKUP_SEGMENT_MISSING");
    if (new TextEncoder().encode(body).byteLength > BACKUP_SEGMENT_LIMITS.maxExportBytes)
      throw new Error("BACKUP_SEGMENT_TOO_LARGE");
    const parsed = parseProblemExportSegment(body);
    const last = parsed.ok ? parsed.events.at(-1) : undefined;
    if (!parsed.ok || !last || last.seq > manifest.cursor)
      throw new Error("BACKUP_SEGMENT_INVALID");
    const verified = await verifyProblemExportSegment(
      body,
      { problemId: manifest.problem_id, checkpointSeq: cursor, rootChainDigest: root },
      {
        problemId: manifest.problem_id,
        checkpointSeq: last.seq,
        rootChainDigest: last.chainDigest,
      },
    );
    if (!verified.intact) throw new Error("BACKUP_SEGMENT_CHAIN_INVALID");
    cursor = last.seq;
    root = verified.finalChainDigest;
    const lines = body.trimEnd().split("\n");
    checkpoints.push(...JSON.parse(lines[0] as string).checkpoints);
    eventLines.push(...lines.slice(1, -1));
  }
  if (cursor !== manifest.cursor || root !== manifest.chain_digest)
    throw new Error("BACKUP_MANIFEST_TERMINAL_MISMATCH");
  const header = {
    control: "export_header",
    format: EXPORT_FORMAT,
    license: EXPORT_LICENSE,
    problem: manifest.problem_id,
    title: manifest.title,
    generated_at: `${manifest.date}T00:00:00Z`,
    checkpoints,
  };
  const trailer = {
    control: "export_end",
    problem: manifest.problem_id,
    event_count: cursor,
    final_cursor: cursor,
  };
  const ndjson = `${[JSON.stringify(header), ...eventLines, JSON.stringify(trailer)].join("\n")}\n`;
  const final = await verifyProblemRestorePreflight(ndjson, {
    problemId: manifest.problem_id,
    checkpointSeq: manifest.cursor,
    rootChainDigest: manifest.chain_digest,
    checkpointDigest: signature.checkpoint_digest,
    checkpointVersion: 1,
    checkpointMode: "unsigned-v0",
    chainVersion: 2,
  });
  if (!final.intact) throw new Error("BACKUP_ASSEMBLY_INVALID");
  return {
    ndjson,
    signatures: {
      problem_id: manifest.problem_id,
      message_format: CHECKPOINT_SIGNATURE_MESSAGE_FORMAT,
      keys: [
        { key_id: trusted.key_id, algorithm: "Ed25519" as const, public_key: trusted.public_key },
      ],
      signatures: [signature],
      unsigned: Math.max(0, checkpoints.length - 1),
      next_after: null,
    },
    eventCount: cursor,
  };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const take = (name: string) => {
      const index = args.indexOf(name);
      const value = index >= 0 ? args[index + 1] : undefined;
      if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`);
      return value;
    };
    const manifestPath = take("--manifest"),
      root = resolve(take("--segments-root"));
    const output = take("--output"),
      key = take("--key");
    const separator = key.indexOf("=");
    if (separator < 1) throw new Error("--key must be an independently pinned kid=public_hex");
    const manifestBytes = await readFile(manifestPath, "utf8");
    if (Buffer.byteLength(manifestBytes) > 16 * 1024) throw new Error("BACKUP_MANIFEST_TOO_LARGE");
    const assembled = await assembleLedgerBackup({
      manifest: JSON.parse(manifestBytes),
      trustedKeys: [{ key_id: key.slice(0, separator), public_key: key.slice(separator + 1) }],
      readSegment: async (path) => readFile(resolve(root, path), "utf8"),
    });
    // Never replace an operator's existing recovery files. Verification has
    // finished before either destination is created.
    await writeFile(output, assembled.ndjson, { flag: "wx", mode: 0o600 });
    await writeFile(`${output}.checkpoints.json`, JSON.stringify(assembled.signatures), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        status: "verified",
        events: assembled.eventCount,
        output,
        signatures: `${output}.checkpoints.json`,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "BACKUP_ASSEMBLY_FAILED");
    process.exitCode = 1;
  }
}
