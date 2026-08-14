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
 * `MemoryNonceStore` proves the *algorithm*: first use accepted, second refused,
 * expired entries evicted, capacity bounded. It is a single Worker isolate's
 * memory and therefore not the production store — Fable §7.10 puts fail-closed
 * counters in D1, and a global replay window needs D1 or a Durable Object so
 * two isolates cannot each accept the same envelope once.
 *
 * That store is W2 (Krater) work and it is **blocked** here: there is no D1
 * namespace and no migrations yet. Nothing in this file may be cited as
 * evidence that replay is refused across isolates in production.
 */

export interface NonceStore {
  /**
   * Record a nonce as used.
   *
   * @returns true when the nonce was previously unseen and is now claimed;
   *          false when it was already present, which is a replay.
   */
  claim(nonce: string, expiresAt: number, now: number): Promise<boolean>;
}

/**
 * In-memory, single-isolate replay window. Test double for the algorithm, not
 * the production store — see the module comment before citing it.
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
