/**
 * Replay defence for the service envelope.
 *
 * A signature proves who wrote an envelope, never how many times it was sent.
 * Every envelope carries a single-use nonce, and the second presentation is
 * refused. The nonce only has to be remembered for the envelope's maximum
 * lifetime: past `exp` the expiry check refuses it anyway, so entries are
 * evicted rather than accumulated.
 *
 * ## What is and is not proven here
 *
 * `MemoryNonceStore` is unit-test-only: it proves the small in-process
 * algorithm but cannot coordinate independent Worker isolates. `D1NonceStore`
 * is the production-shaped adapter: a unique nonce digest and one SQLite UPSERT
 * decide the first claim atomically across isolates sharing the D1 binding.
 *
 * The adapter and its local SQL contract tests are not proof of a deployed D1
 * binding, a Worker isolate, or a Vercel/Google integration. They make the
 * production boundary explicit so that proof has one concrete implementation
 * to exercise when those environments exist.
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

import { sha256Hex } from "./canonical";

export interface NonceStore {
  /**
   * Record a nonce as used.
   *
   * @returns true when the nonce was previously unseen and is now claimed;
   *          false when it was already present, which is a replay.
   */
  claim(nonce: string, expiresAt: number, now: number): Promise<boolean>;
}

/** A bounded retention sweep avoids unbounded successful-write accumulation. */
export const NONCE_CLEANUP_BATCH_SIZE = 100;

const CLAIM_NONCE_SQL = `
INSERT INTO auth_envelope_nonces (nonce_hash, expires_at, claimed_at)
VALUES (?, ?, ?)
ON CONFLICT(nonce_hash) DO UPDATE SET
  expires_at = excluded.expires_at,
  claimed_at = excluded.claimed_at
WHERE auth_envelope_nonces.expires_at <= ?`;

const CLEANUP_EXPIRED_NONCES_SQL = `
DELETE FROM auth_envelope_nonces
WHERE nonce_hash IN (
  SELECT nonce_hash
  FROM auth_envelope_nonces
  WHERE expires_at <= ?
  ORDER BY expires_at ASC
  LIMIT ?
)`;

const sql = (db: D1Database, query: string, ...values: unknown[]): D1PreparedStatement =>
  db.prepare(query).bind(...values);

function validEpochSecond(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * The one input contract every `NonceStore` enforces, shared so the two
 * implementations cannot drift apart.
 *
 * The verifier only reaches `claim()` for an envelope it has already accepted
 * as unexpired, and it retains the digest through the skew window plus one
 * second, so a real claim always arrives with `expiresAt >= now + 1`. An
 * `expiresAt <= now` therefore means a caller has computed a retention window
 * this store cannot honour, which is a caller invariant failure rather than a
 * replay decision — a store that answered `true` would record a digest that is
 * already expired, opening the replay window it exists to close.
 *
 * This lived only in `D1NonceStore`, which made the in-memory double the more
 * permissive of the two: it would green-light window arithmetic that production
 * rejects, and a regression narrowing the verifier's expiry margin would turn a
 * routine expired credential into a coarse replay-store outage in production
 * while every unit test using the double stayed green.
 */
function assertClaimableWindow(expiresAt: number, now: number): void {
  if (!validEpochSecond(now) || !validEpochSecond(expiresAt) || expiresAt <= now) {
    throw new NonceStoreInputError("invalid nonce expiry");
  }
}

/**
 * D1-backed replay window for the Worker binding.
 *
 * The raw nonce never reaches D1: `nonce_hash` is SHA-256 of its UTF-8 bytes.
 * `claim()` performs one conflict-aware UPSERT; the unique primary key, not a
 * process-local read-then-write convention, determines whether a concurrent
 * duplicate is a replay. Expiry is exclusive (`expires_at <= now` is expired).
 */
export class D1NonceStore implements NonceStore {
  readonly #db: D1Database;
  readonly #cleanupBatchSize: number;

  constructor(db: D1Database, cleanupBatchSize = NONCE_CLEANUP_BATCH_SIZE) {
    if (!Number.isSafeInteger(cleanupBatchSize) || cleanupBatchSize < 1) {
      throw new NonceStoreConfigurationError("cleanup batch size must be a positive safe integer");
    }
    this.#db = db;
    this.#cleanupBatchSize = cleanupBatchSize;
  }

  /**
   * Delete at most one retention batch. This is intentionally bounded: a
   * successful write must not turn a large expired backlog into an unbounded
   * latency or write-amplification event. It is safe to leave additional
   * expired digests behind because the atomic UPSERT can reclaim its own row.
   */
  async cleanupExpired(now: number): Promise<number> {
    if (!validEpochSecond(now)) throw new NonceStoreInputError("invalid cleanup time");
    const result = await sql(
      this.#db,
      CLEANUP_EXPIRED_NONCES_SQL,
      now,
      this.#cleanupBatchSize,
    ).run();
    return result.meta.changes ?? 0;
  }

  async claim(nonce: string, expiresAt: number, now: number): Promise<boolean> {
    assertClaimableWindow(expiresAt, now);

    await this.cleanupExpired(now);
    const nonceHash = await sha256Hex(new TextEncoder().encode(nonce));
    const result = await sql(this.#db, CLAIM_NONCE_SQL, nonceHash, expiresAt, now, now).run();
    return result.meta.changes === 1;
  }
}

/**
 * Unit-test-only in-memory, single-isolate replay window. It is never a
 * production substitute for `D1NonceStore` — see the module comment before
 * citing it.
 *
 * It shares `assertClaimableWindow` with the D1 adapter so the two agree on
 * which inputs are refusable. Coordination across isolates remains the part
 * only `D1NonceStore` can provide.
 */
export class MemoryNonceStore implements NonceStore {
  readonly #seen = new Map<string, number>();
  readonly #capacity: number;

  constructor(capacity = 10_000) {
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#seen.size;
  }

  async claim(nonce: string, expiresAt: number, now: number): Promise<boolean> {
    // Identical to `D1NonceStore`: the double must refuse every window the
    // production store refuses, or it cannot be trusted to prove the verifier's
    // expiry arithmetic.
    assertClaimableWindow(expiresAt, now);
    this.#evictExpired(now);
    const existing = this.#seen.get(nonce);
    if (existing !== undefined && existing > now) return false;

    if (this.#seen.size >= this.#capacity) {
      // Fail closed: refusing a legitimate write is recoverable, silently
      // forgetting a nonce under memory pressure is a replay window.
      throw new NonceStoreFullError(this.#capacity);
    }
    this.#seen.set(nonce, expiresAt);
    return true;
  }

  #evictExpired(now: number): void {
    for (const [nonce, expiresAt] of this.#seen) {
      if (expiresAt <= now) this.#seen.delete(nonce);
    }
  }
}

export class NonceStoreFullError extends Error {
  readonly code = "NONCE_STORE_FULL";
  constructor(capacity: number) {
    super(`replay window is at capacity (${capacity})`);
    this.name = "NonceStoreFullError";
  }
}

/** Configuration or caller invariant failure; safe to map to a generic refusal. */
export class NonceStoreConfigurationError extends Error {
  readonly code = "NONCE_STORE_CONFIGURATION";

  constructor(message: string) {
    super(message);
    this.name = "NonceStoreConfigurationError";
  }
}

/** Invalid epoch inputs are never serialised or logged by the auth boundary. */
export class NonceStoreInputError extends Error {
  readonly code = "NONCE_STORE_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "NonceStoreInputError";
  }
}
