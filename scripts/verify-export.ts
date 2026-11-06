/**
 * Offline export verifier (Fable §10, ADR-23; bead asimposiumorg-10lz).
 *
 *   bun scripts/verify-export.ts <export.jsonl[.gz]> <checkpoints.json> <trusted-keys.json> [deletion-journal.ndjson]
 *   bun scripts/verify-export.ts <export.jsonl[.gz]> --embedded <trusted-keys.json> [deletion-journal.ndjson]
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
 *   3. optionally, the signed deletion journal (journal/deletion/v1/<n>.ndjson)
 *      verifies under the same pinned keys, so a mirror can check offline
 *      which private-draft and account deletions a restore must replay.
 *
 * Boundary: truncation is detectable only against signatures the verifier is
 * given. A mirror that serves a truncated export together with an equally
 * truncated checkpoints.json passes as a shorter, still-authentic history.
 * Freshness needs an independent source of the latest signed seq (another
 * mirror, or a checkpoint retained from an earlier fetch).
 * Public v5 downloads embed bounded signatures and public keys; --embedded
 * avoids a second checkpoint download. Those embedded keys are not trust anchors.
 * Public v4/v5 companions are checked for exact framing, source binding and digest
 * consistency. The result labels that context as self-consistency-only: event
 * checkpoint signatures do not authenticate the companion's provenance.
 *
 * Exit 0 verified; 1 verification failed; 2 usage or unreadable input.
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { CheckpointSignaturesResponseSchema } from "@asimposium/contracts";
import { verifyCheckpointSignature } from "../apps/wire/src/krater/checkpoint-signing.ts";
import {
  EXPORT_FORMAT,
  type PUBLIC_EXPORT_FORMAT,
  type PUBLIC_EXPORT_V4_FORMAT,
  type PublicProblemExportVerification,
  parseProblemExport,
  parsePublicProblemExport,
  verifyProblemExportChain,
  verifyPublicProblemExportChain,
} from "../apps/wire/src/krater/export.ts";
import type { ExportSignatureAssurance } from "../apps/wire/src/krater/export-signatures.ts";
import { parseAndVerifyDeletionJournal } from "../apps/wire/src/krater/retention.ts";

export interface TrustedKey {
  readonly key_id: string;
  readonly public_key: string;
}

type PublicContextIntegrity = Partial<
  Pick<
    Extract<PublicProblemExportVerification, { intact: true }>,
    "publicationContextSha256" | "publicationNoticeCount" | "publicationContextAssurance"
  >
>;

export interface ExportVerification
  extends PublicContextIntegrity,
    Omit<Partial<ExportSignatureAssurance>, "checkpointSignaturesValid"> {
  readonly ok: boolean;
  readonly format?:
    | typeof EXPORT_FORMAT
    | typeof PUBLIC_EXPORT_V4_FORMAT
    | typeof PUBLIC_EXPORT_FORMAT;
  readonly chainLinkageValid?: boolean;
  readonly payloadCommitmentRecomputed?: boolean;
  readonly checkpointSignaturesValid?: boolean | null;
  readonly problem: string | null;
  readonly checkpoints: number;
  readonly signed: number;
  readonly failures: readonly string[];
}

const HEX64 = /^[0-9a-f]{64}$/;
const bare = (digest: string) => digest.replace(/^sha256:/, "");
export async function verifyExportOffline(input: {
  readonly ndjson: string;
  /** Legacy v3/v4 sidecar, or additional independently retained checkpoints.
   * v5's embedded signatures need no second downloaded file. */
  readonly signatures?: unknown;
  readonly trustedKeys: readonly TrustedKey[];
}): Promise<ExportVerification> {
  const failures: string[] = [];
  // Keep both exact grammars. Public context is never stripped or passed to
  // the private restore parser as an implicitly trusted v3 archive.
  const privateParsed = parseProblemExport(input.ndjson);
  const parsed = privateParsed.ok ? privateParsed : parsePublicProblemExport(input.ndjson);
  const publicFormat = parsed.ok && "publicationContext" in parsed;
  if (!Array.isArray(input.trustedKeys))
    return {
      ok: false,
      problem: null,
      checkpoints: 0,
      signed: 0,
      failures: ["keys: expected an independently pinned key array"],
    };
  const publicChain = publicFormat
    ? await verifyPublicProblemExportChain(input.ndjson, undefined, undefined, input.trustedKeys)
    : null;
  const chain = publicChain?.intact
    ? publicChain
    : await verifyProblemExportChain(publicFormat ? parsed.chainNdjson : input.ndjson);
  // Every accepted v3/v4/v5 event must carry payload_json, and the common
  // verifier rehashes those bytes before its envelope and chain links. Public
  // content-control refusals produce no archive; digest-only/redacted records
  // cannot pass this grammar. chain.intact therefore establishes full payload
  // coverage here, independently of whether any signing key is trusted.
  if (!chain.intact) failures.push(`chain: ${chain.detail}`);
  if (publicChain !== null && !publicChain.intact && chain.intact)
    failures.push(`public export: ${publicChain.detail}`);
  if (!parsed.ok) {
    failures.push(`export: ${parsed.detail}`);
    return { ok: false, problem: null, checkpoints: 0, signed: 0, failures };
  }
  const problem = parsed.header.problem;
  const format = publicFormat ? parsed.format : EXPORT_FORMAT;
  const context: PublicContextIntegrity = publicChain?.intact
    ? {
        publicationContextSha256: publicChain.publicationContextSha256,
        publicationNoticeCount: publicChain.publicationNoticeCount,
        publicationContextAssurance: publicChain.publicationContextAssurance,
      }
    : {};
  if (input.signatures === undefined) {
    if (!publicFormat || parsed.checkpointSignatures === null)
      failures.push("signatures: legacy exports require a separate checkpoint file");
    else if (publicChain?.intact && !publicChain.authenticated)
      failures.push(
        "signatures: the final event has no signature under an independently pinned key",
      );
    return {
      ok: failures.length === 0,
      format,
      problem,
      checkpoints: parsed.header.checkpoints.length,
      signed:
        publicFormat && publicChain?.intact
          ? new Set(
              parsed.checkpointSignatures?.signatures.map((signature) => signature.checkpoint_seq),
            ).size
          : 0,
      authenticated: false,
      chainLinkageValid: chain.intact,
      payloadCommitmentRecomputed: chain.intact,
      ...(publicChain?.intact
        ? {
            checkpointSignaturesValid: publicChain.checkpointSignaturesValid,
            checkpointSignatureCount: publicChain.checkpointSignatureCount,
            signedThrough: publicChain.signedThrough,
            trustedThrough: publicChain.trustedThrough,
            signatureCoverage: publicChain.signatureCoverage,
            authenticated: publicChain.authenticated,
            authenticationScope: publicChain.authenticationScope,
            keyTrust: publicChain.keyTrust,
          }
        : {}),
      ...context,
      failures,
    };
  }
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
  const trusted = new Map<string, string>();
  for (const key of input.trustedKeys) {
    if (
      !key ||
      typeof key.key_id !== "string" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(key.key_id) ||
      typeof key.public_key !== "string" ||
      !HEX64.test(key.public_key) ||
      (trusted.has(key.key_id) && trusted.get(key.key_id) !== key.public_key)
    ) {
      failures.push("keys: independently pinned verification keys are invalid or ambiguous");
      continue;
    }
    trusted.set(key.key_id, key.public_key);
  }
  if (trusted.size === 0) failures.push("keys: no trusted key supplied");

  // Anchor on the TRUSTED signatures, never on the export's own header: a
  // forger can recompute the unkeyed chain and drop or rewrite checkpoints.
  // A terminal checkpoint authenticates its complete recomputed chain prefix;
  // it need not carry a separate signature for every earlier event.
  const signedRoots = new Map<number, { root: string; digest: string }>();
  let invalidSignature = false;
  for (const candidate of face.data.signatures) {
    const key = trusted.get(candidate.key_id);
    if (key === undefined) continue;
    if (await verifyCheckpointSignature(problem, candidate, key)) {
      signedRoots.set(candidate.checkpoint_seq, {
        root: candidate.root_chain_digest,
        digest: candidate.checkpoint_digest,
      });
    } else {
      invalidSignature = true;
      failures.push(`checkpoint ${candidate.checkpoint_seq}: signature does not verify`);
    }
  }
  const events = parsed.events;
  const last = events.at(-1);
  if (last === undefined) failures.push("export: no events to authenticate");
  let signed = 0;
  let trustedThrough = 0;
  for (const event of events) {
    const anchor = signedRoots.get(event.seq);
    if (anchor === undefined) continue;
    if (anchor.root !== bare(event.chainDigest)) {
      failures.push(`event ${event.seq}: chain differs from the signed checkpoint`);
    } else {
      signed += 1;
      trustedThrough = Math.max(trustedThrough, event.seq);
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
    format,
    problem,
    checkpoints: parsed.header.checkpoints.length,
    signed,
    chainLinkageValid: chain.intact,
    payloadCommitmentRecomputed: chain.intact,
    checkpointSignaturesValid: invalidSignature ? false : signedRoots.size === 0 ? null : true,
    checkpointSignatureCount: signedRoots.size,
    signedThrough: trustedThrough,
    trustedThrough,
    signatureCoverage:
      trustedThrough === 0 ? "none" : trustedThrough === last?.seq ? "complete" : "prefix",
    authenticated: failures.length === 0 && trustedThrough > 0 && trustedThrough === last?.seq,
    authenticationScope: "original-event-chain-only",
    keyTrust: "independently-pinned-keys-required",
    failures,
    ...context,
  };
}

/** Verify a signed deletion journal offline under independently pinned keys. */
export async function verifyDeletionJournalOffline(input: {
  readonly ndjson: string;
  readonly trustedKeys: readonly TrustedKey[];
}): Promise<{ readonly ok: boolean; readonly records: number; readonly failure: string | null }> {
  const verified = await parseAndVerifyDeletionJournal(
    input.ndjson,
    input.trustedKeys.map((key) => ({ kid: key.key_id, publicKeyHex: key.public_key })),
  );
  return verified.valid
    ? { ok: true, records: verified.records.length, failure: null }
    : { ok: false, records: 0, failure: verified.reason };
}

if (import.meta.main) {
  const [exportPath, signaturesPath, keysPath, journalPath] = process.argv.slice(2);
  if (!exportPath || !signaturesPath || !keysPath) {
    console.error(
      "usage: bun scripts/verify-export.ts <export.jsonl[.gz]> <checkpoints.json|--embedded> <trusted-keys.json> [deletion-journal.ndjson]",
    );
    process.exit(2);
  }
  let ndjson: string;
  let signatures: unknown;
  let trustedKeys: TrustedKey[];
  try {
    const raw = readFileSync(exportPath);
    ndjson = (exportPath.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
    signatures =
      signaturesPath === "--embedded"
        ? undefined
        : JSON.parse(readFileSync(signaturesPath, "utf8"));
    trustedKeys = JSON.parse(readFileSync(keysPath, "utf8"));
  } catch (error) {
    console.error(`unreadable input: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const result = await verifyExportOffline({ ndjson, signatures, trustedKeys });
  console.log(JSON.stringify({ kind: "export-verification", ...result }));
  let journalOk = true;
  if (journalPath) {
    let journal: string;
    try {
      journal = readFileSync(journalPath, "utf8");
    } catch (error) {
      console.error(`unreadable input: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
    const journalResult = await verifyDeletionJournalOffline({ ndjson: journal, trustedKeys });
    console.log(JSON.stringify({ kind: "deletion-journal-verification", ...journalResult }));
    journalOk = journalResult.ok;
  }
  process.exit(result.ok && journalOk ? 0 : 1);
}
