/**
 * Offline export verifier (Fable §10, ADR-23; bead asimposiumorg-10lz).
 *
 *   bun scripts/verify-export.ts <export.jsonl[.gz]> <checkpoints.json> <trusted-keys.json>
 *
 * A mirror or auditor verifies a public problem export with no network and no
 * trust in the serving Worker:
 *   1. the NDJSON export's integrity chain (header, every event link, trailer);
 *   2. Ed25519 signatures from /p/:id/checkpoints.json that verify under a key
 *      the verifier pins independently (trusted-keys.json: [{key_id,
 *      public_key}]) anchor the export: every signed seq must match the
 *      recomputed chain, the final event must be signed, and no signature may
 *      lie beyond the export's end (truncation).
 * Keys published inside checkpoints.json are never trusted by themselves.
 *
 * Exit 0 verified; 1 verification failed; 2 usage or unreadable input.
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  type CheckpointSignaturesResponse,
  CheckpointSignaturesResponseSchema,
  checkpointSignatureMessage,
} from "@asimposium/contracts";
import { parseProblemExport, verifyProblemExportChain } from "../apps/wire/src/krater/export.ts";

export interface TrustedKey {
  readonly key_id: string;
  readonly public_key: string;
}

export interface ExportVerification {
  readonly ok: boolean;
  readonly problem: string | null;
  readonly checkpoints: number;
  readonly signed: number;
  readonly failures: readonly string[];
}

const HEX64 = /^[0-9a-f]{64}$/;
const bare = (digest: string) => digest.replace(/^sha256:/, "");
const hexBytes = (hex: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

async function verifySignature(
  problemId: string,
  signature: CheckpointSignaturesResponse["signatures"][number],
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      hexBytes(signature.signature),
      new TextEncoder().encode(
        checkpointSignatureMessage({
          problemId,
          checkpointSeq: signature.checkpoint_seq,
          rootChainDigest: signature.root_chain_digest,
          checkpointDigest: signature.checkpoint_digest,
        }),
      ),
    );
  } catch {
    return false;
  }
}

export async function verifyExportOffline(input: {
  readonly ndjson: string;
  readonly signatures: unknown;
  readonly trustedKeys: readonly TrustedKey[];
}): Promise<ExportVerification> {
  const failures: string[] = [];
  const chain = await verifyProblemExportChain(input.ndjson);
  if (!chain.intact) failures.push(`chain: ${chain.detail}`);
  const parsed = parseProblemExport(input.ndjson);
  if (!parsed.ok) {
    failures.push(`export: ${parsed.detail}`);
    return { ok: false, problem: null, checkpoints: 0, signed: 0, failures };
  }
  const problem = parsed.header.problem;
  const face = CheckpointSignaturesResponseSchema.safeParse(input.signatures);
  if (!face.success) {
    failures.push("signatures: checkpoints.json does not match the contract");
    return {
      ok: false,
      problem,
      checkpoints: parsed.header.checkpoints.length,
      signed: 0,
      failures,
    };
  }
  if (face.data.problem_id !== problem) failures.push("signatures: problem mismatch");
  const trusted = new Map(
    input.trustedKeys
      .filter((key) => typeof key.key_id === "string" && HEX64.test(key.public_key))
      .map((key) => [key.key_id, key.public_key]),
  );
  if (trusted.size === 0) failures.push("keys: no trusted key supplied");

  // Anchor on the TRUSTED signatures, never on the export's own header: a
  // forger can recompute the unkeyed chain and drop or rewrite checkpoints.
  // Every event write mints a checkpoint whose root is that event's chain
  // digest, so a fully signed export has a trusted signature at every seq.
  const signedRoots = new Map<number, { root: string; digest: string }>();
  for (const candidate of face.data.signatures) {
    const key = trusted.get(candidate.key_id);
    if (key === undefined) continue;
    if (await verifySignature(problem, candidate, key)) {
      signedRoots.set(candidate.checkpoint_seq, {
        root: candidate.root_chain_digest,
        digest: candidate.checkpoint_digest,
      });
    } else {
      failures.push(`checkpoint ${candidate.checkpoint_seq}: signature does not verify`);
    }
  }
  const events = parsed.events;
  const last = events.at(-1);
  if (last === undefined) failures.push("export: no events to authenticate");
  let signed = 0;
  for (const event of events) {
    const anchor = signedRoots.get(event.seq);
    if (anchor === undefined) continue;
    if (anchor.root !== bare(event.chainDigest)) {
      failures.push(`event ${event.seq}: chain differs from the signed checkpoint`);
    } else {
      signed += 1;
    }
  }
  if (last !== undefined && !signedRoots.has(last.seq)) {
    failures.push(
      `event ${last.seq}: the final event has no trusted signature (unsigned tail; retry after signing)`,
    );
  }
  const beyond = [...signedRoots.keys()].filter((seq) => last === undefined || seq > last.seq);
  if (beyond.length > 0) {
    failures.push(`export: truncated; trusted signatures exist through seq ${Math.max(...beyond)}`);
  }
  // The header's checkpoints, when present, must agree with the signatures.
  for (const checkpoint of parsed.header.checkpoints) {
    const anchor = signedRoots.get(checkpoint.checkpointSeq);
    if (
      anchor !== undefined &&
      (anchor.root !== bare(checkpoint.rootChainDigest) ||
        anchor.digest !== bare(checkpoint.checkpointDigest))
    ) {
      failures.push(`checkpoint ${checkpoint.checkpointSeq}: header disagrees with its signature`);
    }
  }
  return {
    ok: failures.length === 0,
    problem,
    checkpoints: parsed.header.checkpoints.length,
    signed,
    failures,
  };
}

if (import.meta.main) {
  const [exportPath, signaturesPath, keysPath] = process.argv.slice(2);
  if (!exportPath || !signaturesPath || !keysPath) {
    console.error(
      "usage: bun scripts/verify-export.ts <export.jsonl[.gz]> <checkpoints.json> <trusted-keys.json>",
    );
    process.exit(2);
  }
  let ndjson: string;
  let signatures: unknown;
  let trustedKeys: TrustedKey[];
  try {
    const raw = readFileSync(exportPath);
    ndjson = (exportPath.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
    signatures = JSON.parse(readFileSync(signaturesPath, "utf8"));
    trustedKeys = JSON.parse(readFileSync(keysPath, "utf8"));
  } catch (error) {
    console.error(`unreadable input: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const result = await verifyExportOffline({ ndjson, signatures, trustedKeys });
  console.log(JSON.stringify({ kind: "export-verification", ...result }));
  process.exit(result.ok ? 0 : 1);
}
