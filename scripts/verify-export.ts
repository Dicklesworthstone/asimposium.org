/**
 * Offline export verifier (Fable §10, ADR-23; bead asimposiumorg-10lz).
 *
 *   bun scripts/verify-export.ts <export.jsonl[.gz]> <checkpoints.json> <trusted-keys.json>
 *
 * A mirror or auditor verifies a public problem export with no network and no
 * trust in the serving Worker:
 *   1. the NDJSON export's integrity chain (header, every event link, trailer);
 *   2. every checkpoint in the export header carries at least one Ed25519
 *      signature, from /p/:id/checkpoints.json, that verifies under a key the
 *      verifier pins independently (trusted-keys.json: [{key_id, public_key}]).
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

  let signed = 0;
  for (const checkpoint of parsed.header.checkpoints) {
    const root = bare(checkpoint.rootChainDigest);
    const digest = bare(checkpoint.checkpointDigest);
    const candidates = face.data.signatures.filter(
      (s) => s.checkpoint_seq === checkpoint.checkpointSeq,
    );
    let verified = false;
    for (const candidate of candidates) {
      const key = trusted.get(candidate.key_id);
      if (key === undefined) continue;
      if (candidate.root_chain_digest !== root || candidate.checkpoint_digest !== digest) {
        failures.push(
          `checkpoint ${checkpoint.checkpointSeq}: signature is over different digests`,
        );
        continue;
      }
      if (await verifySignature(problem, candidate, key)) {
        verified = true;
        break;
      }
      failures.push(`checkpoint ${checkpoint.checkpointSeq}: signature does not verify`);
    }
    if (verified) signed += 1;
    else if (!failures.some((f) => f.startsWith(`checkpoint ${checkpoint.checkpointSeq}:`)))
      failures.push(`checkpoint ${checkpoint.checkpointSeq}: no signature by a trusted key`);
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
