/**
 * Ed25519 signatures over integrity checkpoints (Fable §10, ADR-23; bead
 * asimposiumorg-10lz). Checkpoints stay `unsigned-v0` rows; this module adds
 * append-only signature rows (migration 0079) over the canonical message from
 * `checkpointSignatureMessage`, using only values `readCheckpoints` has
 * validated against the v2 event chain. A missing or malformed key disables
 * signing; it never signs with a fallback.
 */

import { type CheckpointSignature, checkpointSignatureMessage } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { readCheckpoints } from "./krater.ts";

const HEX64 = /^[0-9a-f]{64}$/;
const KID = /^[A-Za-z0-9._-]{1,64}$/;
/** PKCS#8 prefix for a raw 32-byte Ed25519 seed (RFC 8410). */
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";

export interface CheckpointSigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicKeyHex: string;
}

export interface CheckpointVerifyKey {
  readonly kid: string;
  readonly publicKeyHex: string;
}

const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const base64UrlToBytes = (value: string): Uint8Array =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

/** Parse CHECKPOINT_SIGNING_KEY; null when absent or malformed (signing disabled). */
export async function checkpointSigningKey(
  raw: string | undefined,
): Promise<CheckpointSigningKey | null> {
  if (raw === undefined || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const { kid, seedHex } = parsed as { kid?: unknown; seedHex?: unknown };
  if (typeof kid !== "string" || !KID.test(kid)) return null;
  if (typeof seedHex !== "string" || !HEX64.test(seedHex)) return null;
  try {
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      hexToBytes(PKCS8_ED25519_PREFIX + seedHex),
      { name: "Ed25519" },
      true,
      ["sign"],
    );
    const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as { x?: unknown };
    if (typeof jwk.x !== "string") return null;
    return { kid, privateKey, publicKeyHex: bytesToHex(base64UrlToBytes(jwk.x)) };
  } catch {
    return null;
  }
}

/** Parse CHECKPOINT_VERIFY_KEYS; malformed entries are dropped, never trusted. */
export function checkpointVerifyKeys(raw: string | undefined): CheckpointVerifyKey[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const keys: CheckpointVerifyKey[] = [];
  for (const entry of parsed.slice(0, 16)) {
    if (entry === null || typeof entry !== "object") continue;
    const { kid, publicKeyHex } = entry as { kid?: unknown; publicKeyHex?: unknown };
    if (
      typeof kid === "string" &&
      KID.test(kid) &&
      typeof publicKeyHex === "string" &&
      HEX64.test(publicKeyHex)
    )
      keys.push({ kid, publicKeyHex });
  }
  return keys;
}

/** Verify one signature against a public key (hex). */
export async function verifyCheckpointSignature(
  problemId: string,
  signature: Pick<
    CheckpointSignature,
    "checkpoint_seq" | "root_chain_digest" | "checkpoint_digest" | "signature"
  >,
  publicKeyHex: string,
): Promise<boolean> {
  if (!HEX64.test(publicKeyHex) || !/^[0-9a-f]{128}$/.test(signature.signature)) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      hexToBytes(signature.signature),
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

export interface CheckpointSigningResult {
  readonly enabled: boolean;
  readonly signed: number;
  readonly problems: number;
}

/**
 * Sign validated checkpoints that lack a signature by the current key. Bounded
 * per call (the cron runs every five minutes). A problem whose checkpoint
 * stream fails validation is skipped, not signed.
 */
export async function signPendingCheckpoints(
  db: D1Database,
  rawKey: string | undefined,
  limit = 200,
  now: () => string = () => new Date().toISOString(),
): Promise<CheckpointSigningResult> {
  const key = await checkpointSigningKey(rawKey);
  if (key === null) return { enabled: false, signed: 0, problems: 0 };
  const pending = await db
    .prepare(
      `SELECT DISTINCT c.problem_id FROM checkpoint_chain_v2 c
       LEFT JOIN checkpoint_signatures s
         ON s.problem_id = c.problem_id AND s.checkpoint_seq = c.checkpoint_seq AND s.key_id = ?
       WHERE s.problem_id IS NULL ORDER BY c.problem_id LIMIT 50`,
    )
    .bind(key.kid)
    .all<{ problem_id: string }>();
  let signed = 0;
  let problems = 0;
  for (const { problem_id: problemId } of pending.results ?? []) {
    if (signed >= limit) break;
    let checkpoints: Awaited<ReturnType<typeof readCheckpoints>>;
    try {
      checkpoints = await readCheckpoints(db as never, problemId);
    } catch {
      continue; // an unvalidated stream is never signed
    }
    const existing = new Set(
      (
        await db
          .prepare(
            "SELECT checkpoint_seq FROM checkpoint_signatures WHERE problem_id = ? AND key_id = ?",
          )
          .bind(problemId, key.kid)
          .all<{ checkpoint_seq: number }>()
      ).results?.map((row) => row.checkpoint_seq) ?? [],
    );
    const statements = [];
    for (const checkpoint of checkpoints) {
      if (signed + statements.length >= limit) break;
      if (existing.has(checkpoint.checkpointSeq)) continue;
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "Ed25519" },
          key.privateKey,
          new TextEncoder().encode(checkpointSignatureMessage(checkpoint)),
        ),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO checkpoint_signatures
               (problem_id, checkpoint_seq, key_id, algorithm, signature, signed_at)
             VALUES (?, ?, ?, 'Ed25519', ?, ?)
             ON CONFLICT(problem_id, checkpoint_seq, key_id) DO NOTHING`,
          )
          .bind(problemId, checkpoint.checkpointSeq, key.kid, bytesToHex(signature), now()),
      );
    }
    if (statements.length > 0) {
      await db.batch(statements);
      signed += statements.length;
      problems += 1;
    }
  }
  return { enabled: true, signed, problems };
}
