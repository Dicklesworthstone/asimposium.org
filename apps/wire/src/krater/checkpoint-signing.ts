/**
 * Ed25519 signatures over integrity checkpoints (Fable §10, ADR-23; bead
 * asimposiumorg-10lz). Checkpoints stay `unsigned-v0` rows; this module adds
 * append-only signature rows (migration 0079) over the canonical message from
 * `checkpointSignatureMessage`, after validating a bounded v2 chain suffix
 * from genesis or a previously authenticated checkpoint. A malformed key disables
 * signing; it never signs with a fallback.
 */

import { type CheckpointSignature, checkpointSignatureMessage } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { checkpointDigest, eventChainDigest, genesisChainDigest, readEvents } from "./krater.ts";

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

interface CheckpointRow {
  problem_id: string;
  checkpoint_seq: number;
  root_chain_digest: string | null;
  checkpoint_digest: string | null;
  checkpoint_version: number;
  chain_version: number | null;
  checkpoint_mode: string;
  event_chain_digest: string | null;
  event_chain_version: number | null;
  signature: string | null;
  algorithm: string | null;
}

async function validCheckpoint(row: CheckpointRow, problemId: string, seq: number) {
  return (
    row.problem_id === problemId &&
    row.checkpoint_seq === seq &&
    row.checkpoint_version === 1 &&
    row.chain_version === 2 &&
    row.event_chain_version === 2 &&
    row.checkpoint_mode === "unsigned-v0" &&
    row.root_chain_digest !== null &&
    HEX64.test(row.root_chain_digest) &&
    row.root_chain_digest === row.event_chain_digest &&
    row.checkpoint_digest === (await checkpointDigest(problemId, seq, row.root_chain_digest))
  );
}

async function validSignature(row: CheckpointRow, key: CheckpointSigningKey) {
  return (
    row.algorithm === "Ed25519" &&
    row.signature !== null &&
    row.root_chain_digest !== null &&
    row.checkpoint_digest !== null &&
    (await verifyCheckpointSignature(
      row.problem_id,
      {
        checkpoint_seq: row.checkpoint_seq,
        root_chain_digest: row.root_chain_digest,
        checkpoint_digest: row.checkpoint_digest,
        signature: row.signature,
      },
      key.publicKeyHex,
    ))
  );
}

/**
 * Sign validated checkpoints that lack a signature by the current key. Bounded
 * per call, including validation work, even when overlapping ticks insert no
 * rows. Existing signatures authenticate the prefix without loading it again.
 * Bodies are deliberately not read: legal redaction does not erase envelopes.
 */
export async function signPendingCheckpoints(
  db: D1Database,
  rawKey: string | undefined,
  limit = 200,
  now: () => string = () => new Date().toISOString(),
): Promise<CheckpointSigningResult> {
  const key = await checkpointSigningKey(rawKey);
  if (key === null) return { enabled: false, signed: 0, problems: 0 };
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("CHECKPOINT_SIGNING_LIMIT");
  let remaining = Math.min(limit, 200);
  await db
    .prepare(`INSERT INTO checkpoint_signing_cursors (key_id, after_problem_id, revision)
    VALUES (?, NULL, 0) ON CONFLICT(key_id) DO NOTHING`)
    .bind(key.kid)
    .run();
  const cursor = await db
    .prepare("SELECT after_problem_id, revision FROM checkpoint_signing_cursors WHERE key_id = ?")
    .bind(key.kid)
    .first<{ after_problem_id: string | null; revision: number }>();
  if (
    !cursor ||
    !Number.isSafeInteger(cursor.revision) ||
    cursor.revision < 0 ||
    cursor.revision >= Number.MAX_SAFE_INTEGER
  )
    throw new Error("CHECKPOINT_SIGNING_CURSOR_INVALID");
  const candidates = (after: string | null) =>
    db
      .prepare(
        `SELECT e.problem_id, MIN(e.seq) AS first_pending,
              p.public_seq, p.chain_digest, p.chain_version
       FROM events e JOIN problems p ON p.id = e.problem_id
       LEFT JOIN checkpoint_signatures s
         ON s.problem_id = e.problem_id AND s.checkpoint_seq = e.seq AND s.key_id = ?
       WHERE p.chain_version = 2 AND e.problem_id > ? AND s.problem_id IS NULL
       GROUP BY e.problem_id ORDER BY e.problem_id LIMIT 50`,
      )
      .bind(key.kid, after ?? "")
      .all<{
        problem_id: string;
        first_pending: number;
        public_seq: number;
        chain_digest: string | null;
        chain_version: number | null;
      }>();
  let pending = await candidates(cursor.after_problem_id);
  // Only wrap after reaching the end. Corrupt or perpetually busy early scopes
  // therefore cannot monopolize the first 50 positions of every cron tick.
  if (pending.results.length === 0 && cursor.after_problem_id !== null)
    pending = await candidates(null);
  let signed = 0;
  let problems = 0;
  let lastAttempted: string | null = null;
  let candidatesLeft = pending.results.length;
  for (const candidate of pending.results ?? []) {
    if (remaining === 0) break;
    lastAttempted = candidate.problem_id;
    // Reserve work for later scopes even when an earlier stream is corrupt.
    // Production's 200-event budget covers every one of the 50 candidates.
    const share = Math.max(1, Math.floor(remaining / candidatesLeft));
    candidatesLeft--;
    const { problem_id: problemId, first_pending: first, public_seq: head } = candidate;
    if (
      !Number.isSafeInteger(first) ||
      first < 1 ||
      !Number.isSafeInteger(head) ||
      first > head ||
      candidate.chain_version !== 2 ||
      candidate.chain_digest === null ||
      !HEX64.test(candidate.chain_digest)
    )
      continue;
    const after = first - 1;
    const count = Math.min(share, head - after);
    const through = after + count;
    // Charge the attempted window before reading: corrupted streams and racing
    // workers cannot turn a 200-row tick into unbounded hashing/signing work.
    remaining -= count;
    let rows: CheckpointRow[];
    let events: Awaited<ReturnType<typeof readEvents>>;
    let anchor: CheckpointRow | undefined;
    try {
      rows = (
        await db
          .prepare(
            `SELECT i.problem_id, i.checkpoint_seq, c.root_chain_digest, c.checkpoint_digest,
                i.checkpoint_version, c.chain_version, i.checkpoint_mode,
                e.chain_digest AS event_chain_digest, e.chain_version AS event_chain_version,
                s.signature, s.algorithm
         FROM integrity_checkpoints i
         LEFT JOIN checkpoint_chain_v2 c
           ON c.problem_id = i.problem_id AND c.checkpoint_seq = i.checkpoint_seq
         LEFT JOIN event_chain_v2 e
           ON e.problem_id = i.problem_id AND e.seq = i.checkpoint_seq
         LEFT JOIN checkpoint_signatures s
           ON s.problem_id = i.problem_id AND s.checkpoint_seq = i.checkpoint_seq AND s.key_id = ?
         WHERE i.problem_id = ? AND i.checkpoint_seq >= ? AND i.checkpoint_seq <= ?
         ORDER BY i.checkpoint_seq ASC LIMIT ?`,
          )
          .bind(key.kid, problemId, Math.max(1, after), through, count + (after > 0 ? 1 : 0))
          .all<CheckpointRow>()
      ).results;
      if (rows.length !== count + (after > 0 ? 1 : 0)) continue;
      let previous = await genesisChainDigest(problemId);
      if (after > 0) {
        anchor = rows.shift();
        if (
          !anchor ||
          anchor.root_chain_digest === null ||
          !(await validCheckpoint(anchor, problemId, after)) ||
          !(await validSignature(anchor, key))
        )
          continue;
        previous = anchor.root_chain_digest;
      }
      events = await readEvents(db, problemId, after, count);
      if (events.length !== count) continue;
      let valid = true;
      for (let index = 0; index < count; index++) {
        const event = events[index];
        const row = rows[index];
        const seq = after + index + 1;
        if (
          !event ||
          !row ||
          event.problemId !== problemId ||
          event.seq !== seq ||
          !(await validCheckpoint(row, problemId, seq)) ||
          event.chainDigest !==
            (await eventChainDigest(
              problemId,
              seq,
              event.payloadSha256,
              event.rowDigest,
              previous,
            )) ||
          row.root_chain_digest !== event.chainDigest ||
          (row.signature !== null && !(await validSignature(row, key)))
        ) {
          valid = false;
          break;
        }
        previous = event.chainDigest;
      }
      if (!valid || (through === head && previous !== candidate.chain_digest)) continue;
    } catch {
      continue; // an unvalidated stream is never signed
    }
    const statements = [];
    for (let index = 0; index < rows.length; index++) {
      const checkpoint = rows[index];
      const event = events[index];
      if (
        !checkpoint ||
        !event ||
        checkpoint.root_chain_digest === null ||
        checkpoint.checkpoint_digest === null ||
        checkpoint.signature !== null
      )
        continue;
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "Ed25519" },
          key.privateKey,
          new TextEncoder().encode(
            checkpointSignatureMessage({
              problemId,
              checkpointSeq: checkpoint.checkpoint_seq,
              rootChainDigest: checkpoint.root_chain_digest,
              checkpointDigest: checkpoint.checkpoint_digest,
            }),
          ),
        ),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO checkpoint_signatures
               (problem_id, checkpoint_seq, key_id, algorithm, signature, signed_at)
             SELECT i.problem_id, i.checkpoint_seq, ?, 'Ed25519', ?, ?
             FROM integrity_checkpoints i
             JOIN checkpoint_chain_v2 c
               ON c.problem_id = i.problem_id AND c.checkpoint_seq = i.checkpoint_seq
             JOIN event_chain_v2 e ON e.problem_id = i.problem_id AND e.seq = i.checkpoint_seq
             JOIN problems p ON p.id = i.problem_id
             WHERE i.problem_id = ? AND i.checkpoint_seq = ?
               AND i.checkpoint_version = 1 AND i.checkpoint_mode = 'unsigned-v0'
               AND c.chain_version = 2 AND c.root_chain_digest = ? AND c.checkpoint_digest = ?
               AND e.chain_version = 2 AND e.chain_digest = c.root_chain_digest
               AND e.event_id = ? AND e.row_digest = ? AND p.chain_version = 2
               AND (p.public_seq > ? OR (p.public_seq = ? AND p.chain_digest = ?))
               AND (? = 0 OR EXISTS (
                 SELECT 1 FROM checkpoint_signatures a
                 JOIN checkpoint_chain_v2 ac
                   ON ac.problem_id = a.problem_id AND ac.checkpoint_seq = a.checkpoint_seq
                 JOIN integrity_checkpoints ai
                   ON ai.problem_id = a.problem_id AND ai.checkpoint_seq = a.checkpoint_seq
                 WHERE a.problem_id = i.problem_id AND a.checkpoint_seq = ? AND a.key_id = ?
                   AND a.algorithm = 'Ed25519' AND a.signature = ? AND ac.chain_version = 2
                   AND ac.root_chain_digest = ? AND ac.checkpoint_digest = ?
                   AND ai.checkpoint_version = 1 AND ai.checkpoint_mode = 'unsigned-v0'))
             ON CONFLICT(problem_id, checkpoint_seq, key_id) DO NOTHING`,
          )
          .bind(
            key.kid,
            bytesToHex(signature),
            now(),
            problemId,
            checkpoint.checkpoint_seq,
            checkpoint.root_chain_digest,
            checkpoint.checkpoint_digest,
            event.eventId,
            event.rowDigest,
            head,
            head,
            candidate.chain_digest,
            after,
            after,
            key.kid,
            anchor?.signature ?? null,
            anchor?.root_chain_digest ?? null,
            anchor?.checkpoint_digest ?? null,
          ),
      );
    }
    if (statements.length > 0) {
      const results = await db.batch(statements);
      const inserted = results.reduce((total, result) => total + (result.meta.changes ?? 0), 0);
      signed += inserted;
      if (inserted > 0) problems += 1;
    }
  }
  // Publish progress only after the bounded page. Concurrent workers may sign
  // the same window, but an older revision can never rewind a newer cursor.
  await db
    .prepare(`UPDATE checkpoint_signing_cursors
    SET after_problem_id = ?, revision = revision + 1 WHERE key_id = ? AND revision = ?`)
    .bind(lastAttempted, key.kid, cursor.revision)
    .run();
  return { enabled: true, signed, problems };
}
