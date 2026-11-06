import {
  CHECKPOINT_SIGNATURE_MESSAGE_FORMAT,
  type ExportCheckpointBundle,
  ExportCheckpointBundleSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { checkpointVerifyKeys, verifyCheckpointSignature } from "./checkpoint-signing.ts";
import { checkpointDigest } from "./krater.ts";

/** Trust anchors are supplied by an offline caller, never copied from an
 * export or from the same HTTP response that carries the ledger. */
export interface ExportTrustedKey {
  readonly key_id: string;
  readonly public_key: string;
}

export interface ExportSignatureAssurance {
  /** null means no signature was available, not a failed mathematical check. */
  readonly checkpointSignaturesValid: true | null;
  readonly checkpointSignatureCount: number;
  readonly signedThrough: number;
  readonly trustedThrough: number;
  readonly signatureCoverage: "none" | "prefix" | "complete";
  readonly authenticated: boolean;
  readonly authenticationScope: "original-event-chain-only";
  readonly keyTrust: "independently-pinned-keys-required";
}

export function unsignedExportCheckpointBundle(
  problemId: string,
  through: number,
): ExportCheckpointBundle {
  return ExportCheckpointBundleSchema.parse({
    format: "asimposium.export-checkpoints.v1",
    problem_id: problemId,
    through,
    message_format: CHECKPOINT_SIGNATURE_MESSAGE_FORMAT,
    selection: "latest-per-configured-key",
    signed_material: "original-event-chain-only",
    key_trust: "independently-pinned-keys-required",
    keys: [],
    signatures: [],
  });
}

/** One latest checkpoint per configured key is sufficient to authenticate
 * each key's complete chain prefix. Reading every historical signature would
 * grow with the ledger and is unnecessary for a bounded public download. */
export async function readExportCheckpointBundle(
  db: D1Database,
  rawVerifyKeys: string | undefined,
  problemId: string,
  through: number,
): Promise<ExportCheckpointBundle> {
  const empty = unsignedExportCheckpointBundle(problemId, through);
  const keys = new Map<string, string>();
  for (const key of checkpointVerifyKeys(rawVerifyKeys)) {
    const previous = keys.get(key.kid);
    if (previous !== undefined && previous !== key.publicKeyHex)
      throw new Error("EXPORT_CHECKPOINT_KEYS_AMBIGUOUS");
    keys.set(key.kid, key.publicKeyHex);
  }
  const configured = [...keys.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (configured.length === 0 || through === 0) return empty;
  const rows = await db
    .prepare(`WITH latest AS (
      SELECT configured.value AS key_id, (
        SELECT MAX(s.checkpoint_seq) FROM checkpoint_signatures s
        WHERE s.problem_id = ? AND s.key_id = configured.value AND s.checkpoint_seq <= ?
      ) AS checkpoint_seq FROM json_each(?) configured
    )
    SELECT s.checkpoint_seq, c.root_chain_digest, c.checkpoint_digest,
           s.key_id, s.algorithm, s.signature, s.signed_at,
           c.chain_version, i.checkpoint_version, i.checkpoint_mode
    FROM latest l JOIN checkpoint_signatures s
      ON s.problem_id = ? AND s.checkpoint_seq = l.checkpoint_seq AND s.key_id = l.key_id
    LEFT JOIN checkpoint_chain_v2 c
      ON c.problem_id = s.problem_id AND c.checkpoint_seq = s.checkpoint_seq
    LEFT JOIN integrity_checkpoints i
      ON i.problem_id = s.problem_id AND i.checkpoint_seq = s.checkpoint_seq
    ORDER BY s.checkpoint_seq, s.key_id LIMIT 17`)
    .bind(problemId, through, JSON.stringify(configured.map(([id]) => id)), problemId)
    .all<{
      checkpoint_seq: number;
      root_chain_digest: string;
      checkpoint_digest: string;
      key_id: string;
      algorithm: string;
      signature: string;
      signed_at: string;
      chain_version: number;
      checkpoint_version: number;
      checkpoint_mode: string;
    }>();
  if (
    !rows.success ||
    rows.results.some(
      (row) =>
        row.chain_version !== 2 ||
        row.checkpoint_version !== 1 ||
        row.checkpoint_mode !== "unsigned-v0",
    )
  )
    throw new Error("EXPORT_CHECKPOINT_SOURCE_INVALID");
  const bundle = ExportCheckpointBundleSchema.parse({
    ...empty,
    keys: configured.map(([key_id, public_key]) => ({ key_id, public_key, algorithm: "Ed25519" })),
    signatures: rows.results.map(
      ({ chain_version: _chain, checkpoint_version: _version, checkpoint_mode: _mode, ...row }) =>
        row,
    ),
  });
  for (const signature of bundle.signatures) {
    const key = keys.get(signature.key_id);
    if (
      key === undefined ||
      signature.checkpoint_digest !==
        (await checkpointDigest(
          problemId,
          signature.checkpoint_seq,
          signature.root_chain_digest,
        )) ||
      !(await verifyCheckpointSignature(problemId, signature, key))
    )
      throw new Error("EXPORT_CHECKPOINT_SIGNATURE_INVALID");
  }
  return bundle;
}

/** Check actual Ed25519 signatures and their exact associations after the
 * caller has recomputed the exported chain and every payload commitment. An
 * embedded public key proves mathematical consistency, never operator identity.
 * Header prose, timestamps, key labels and publication notices stay unsigned. */
export async function verifyExportCheckpointBundle(input: {
  readonly bundle: ExportCheckpointBundle;
  readonly problemId: string;
  readonly through: number;
  readonly events: readonly { readonly seq: number; readonly chainDigest: string }[];
  readonly checkpoints: readonly {
    readonly checkpointSeq: number;
    readonly rootChainDigest: string;
    readonly checkpointDigest: string;
  }[];
  readonly trustedKeys?: readonly ExportTrustedKey[];
}): Promise<
  | { readonly ok: true; readonly assurance: ExportSignatureAssurance }
  | { readonly ok: false; readonly detail: string }
> {
  const parsed = ExportCheckpointBundleSchema.safeParse(input.bundle);
  if (
    !parsed.success ||
    parsed.data.problem_id !== input.problemId ||
    parsed.data.through !== input.through
  )
    return { ok: false, detail: "checkpoint signatures name a different or invalid exported cut" };
  const trusted = new Map<string, string>();
  for (const key of input.trustedKeys ?? []) {
    if (
      !key ||
      typeof key.key_id !== "string" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(key.key_id) ||
      typeof key.public_key !== "string" ||
      !/^[0-9a-f]{64}$/.test(key.public_key) ||
      (trusted.has(key.key_id) && trusted.get(key.key_id) !== key.public_key)
    )
      return {
        ok: false,
        detail: "independently pinned verification keys are invalid or ambiguous",
      };
    trusted.set(key.key_id, key.public_key);
  }
  const bundle = parsed.data;
  const keys = new Map(bundle.keys.map((key) => [key.key_id, key.public_key]));
  const checkpoints = new Map(
    input.checkpoints.map((checkpoint) => [checkpoint.checkpointSeq, checkpoint]),
  );
  const events = new Map(input.events.map((event) => [event.seq, event.chainDigest]));
  let signedThrough = 0;
  let trustedThrough = 0;
  for (const signature of bundle.signatures) {
    const checkpoint = checkpoints.get(signature.checkpoint_seq);
    const key = keys.get(signature.key_id);
    if (
      !checkpoint ||
      key === undefined ||
      checkpoint.rootChainDigest !== signature.root_chain_digest ||
      checkpoint.checkpointDigest !== signature.checkpoint_digest ||
      events.get(signature.checkpoint_seq) !== signature.root_chain_digest ||
      signature.checkpoint_digest !==
        (await checkpointDigest(
          input.problemId,
          signature.checkpoint_seq,
          signature.root_chain_digest,
        ))
    )
      return {
        ok: false,
        detail: "checkpoint signature is detached from its exported checkpoint or event",
      };
    if (!(await verifyCheckpointSignature(input.problemId, signature, key)))
      return {
        ok: false,
        detail: "checkpoint signature does not verify under its embedded public key",
      };
    signedThrough = Math.max(signedThrough, signature.checkpoint_seq);
    if (trusted.get(signature.key_id) === key)
      trustedThrough = Math.max(trustedThrough, signature.checkpoint_seq);
  }
  return {
    ok: true,
    assurance: {
      checkpointSignaturesValid: bundle.signatures.length === 0 ? null : true,
      checkpointSignatureCount: bundle.signatures.length,
      signedThrough,
      trustedThrough,
      signatureCoverage:
        signedThrough === 0 ? "none" : signedThrough === input.through ? "complete" : "prefix",
      authenticated: input.through > 0 && trustedThrough === input.through,
      authenticationScope: "original-event-chain-only",
      keyTrust: "independently-pinned-keys-required",
    },
  };
}
