import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorkshopPushRequestSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import {
  checkAndReserveQuota,
  getRemainingBudget,
  PROMOTION_RATE_LIMIT_WINDOW_MS,
  parseSponsorLimit,
  promotionRateLimitedProblem,
  RESERVATION_EXPIRY_MS,
  settleQuotaReservation,
  settleQuotaReservationStatement,
} from "../../src/sessions/quota";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

function testDb(): D1Database {
  const sqlite = new Database(":memory:", { strict: true });
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.run(readFileSync(join(MIGRATIONS, file), "utf8"));
  }

  const prepare = (query: string) => {
    const methods = (...values: unknown[]) => ({
      async run() {
        const statement = sqlite.prepare(query);
        if (/^\s*SELECT\b/i.test(query)) {
          const rows = statement.all(...(values as any[]));
          return { results: rows, meta: { changes: 0 } };
        }
        const result = statement.run(...(values as any[]));
        return { results: [], meta: { changes: result.changes } };
      },
      async first<T>(): Promise<T | null> {
        const row = (sqlite.prepare(query) as any).get(...(values as any[]));
        return (row ?? null) as T | null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        const rows = (sqlite.prepare(query) as any).all(...(values as any[])) as T[];
        return { results: rows };
      },
    });
    return {
      bind: (...values: unknown[]) => methods(...values),
      run: () => methods().run(),
      first: <T>() => methods().first<T>(),
      all: <T>() => methods().all<T>(),
    };
  };

  return {
    prepare,
    batch: async (stmts: { run(): Promise<unknown> }[]) => {
      sqlite.run("BEGIN");
      try {
        const results = [];
        for (const s of stmts) results.push(await s.run());
        sqlite.run("COMMIT");
        return results;
      } catch (err) {
        sqlite.run("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}

describe("pure table/property tests: parseSponsorLimit", () => {
  test("returns null for undefined, null, or empty string", () => {
    expect(parseSponsorLimit(undefined)).toBeNull();
    expect(parseSponsorLimit(null)).toBeNull();
    expect(parseSponsorLimit("")).toBeNull();
  });

  test("parses valid positive integer or zero", () => {
    expect(parseSponsorLimit(20)).toBe(20);
    expect(parseSponsorLimit("20")).toBe(20);
    expect(parseSponsorLimit(0)).toBe(0);
    expect(parseSponsorLimit("0")).toBe(0);
    expect(parseSponsorLimit("50.8")).toBe(50);
  });

  test("fails closed on invalid, negative, or NaN input", () => {
    expect(() => parseSponsorLimit("not-a-number")).toThrow("INVALID_SPONSOR_PROMOTION_RATE_LIMIT");
    expect(() => parseSponsorLimit(NaN)).toThrow("INVALID_SPONSOR_PROMOTION_RATE_LIMIT");
    expect(() => parseSponsorLimit(-1)).toThrow("INVALID_SPONSOR_PROMOTION_RATE_LIMIT");
    expect(() => parseSponsorLimit("-10")).toThrow("INVALID_SPONSOR_PROMOTION_RATE_LIMIT");
    expect(() => parseSponsorLimit(Infinity)).toThrow("INVALID_SPONSOR_PROMOTION_RATE_LIMIT");
  });
});

describe("pure table/property tests: checkAndReserveQuota", () => {
  test("first publication is allowed with full remaining budget", async () => {
    const db = testDb();
    const now = 1_700_000_000_000;
    const result = await checkAndReserveQuota(db, {
      fellowId: "fel_test_1",
      problemId: "P-4DSP",
      sponsorId: "spn_test_1",
      sessionId: "ses_test_1",
      route: "promote",
      idempotencyKey: "key-1",
      requestDigest: "digest-1",
      now,
    });

    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error("expected allowed");
    expect(result.reservation.status).toBe("reserved");
    expect(result.reservation.fellowId).toBe("fel_test_1");
    expect(result.reservation.problemId).toBe("P-4DSP");
    expect(result.reservation.expiresAt).toBe(now + RESERVATION_EXPIRY_MS);
    expect(result.budget).toEqual({
      limit: 20,
      remaining: 19,
      window_seconds: 3600,
      sponsor_limit: null,
      sponsor_remaining: null,
    });
  });

  test("enforces exactly 20 attempts per hour for a fellow on a problem, 21st is rejected", async () => {
    const db = testDb();
    const now = 1_700_000_000_000;

    for (let i = 0; i < 20; i++) {
      const res = await checkAndReserveQuota(db, {
        fellowId: "fel_test_2",
        problemId: "P-4DSP",
        sponsorId: "spn_test_1",
        sessionId: "ses_test_1",
        route: "promote",
        idempotencyKey: `key-${i}`,
        requestDigest: `digest-${i}`,
        now: now + i * 1000,
      });
      expect(res.allowed).toBe(true);
      if (res.allowed) {
        expect(res.budget.remaining).toBe(19 - i);
      }
    }

    const overLimit = await checkAndReserveQuota(db, {
      fellowId: "fel_test_2",
      problemId: "P-4DSP",
      sponsorId: "spn_test_1",
      sessionId: "ses_test_1",
      route: "promote",
      idempotencyKey: "key-21",
      requestDigest: "digest-21",
      now: now + 25_000,
    });

    expect(overLimit.allowed).toBe(false);
    if (overLimit.allowed || overLimit.reason !== "RATE_LIMITED")
      throw new Error("expected rate limited");
    expect(overLimit.dimension).toBe("fellow_problem");
    expect(overLimit.budget.remaining).toBe(0);
    expect(overLimit.retryAfterSeconds).toBeGreaterThan(0);
    expect(overLimit.retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  test("problem isolation: exhausting budget on P-A leaves P-B intact", async () => {
    const db = testDb();
    const now = 1_700_000_000_000;

    for (let i = 0; i < 20; i++) {
      await checkAndReserveQuota(db, {
        fellowId: "fel_test_3",
        problemId: "P-PROBLEM-A",
        sponsorId: "spn_test_1",
        sessionId: "ses_test_1",
        route: "promote",
        idempotencyKey: `key-a-${i}`,
        requestDigest: `digest-a-${i}`,
        now: now + i * 1000,
      });
    }

    // Problem A is rate limited
    const resA = await checkAndReserveQuota(db, {
      fellowId: "fel_test_3",
      problemId: "P-PROBLEM-A",
      sponsorId: "spn_test_1",
      sessionId: "ses_test_1",
      route: "promote",
      idempotencyKey: "key-a-21",
      requestDigest: "digest-a-21",
      now: now + 25_000,
    });
    expect(resA.allowed).toBe(false);

    // Problem B has full quota
    const resB = await checkAndReserveQuota(db, {
      fellowId: "fel_test_3",
      problemId: "P-PROBLEM-B",
      sponsorId: "spn_test_1",
      sessionId: "ses_test_1",
      route: "promote",
      idempotencyKey: "key-b-1",
      requestDigest: "digest-b-1",
      now: now + 25_000,
    });
    expect(resB.allowed).toBe(true);
    if (!resB.allowed) throw new Error("expected allowed");
    expect(resB.budget.remaining).toBe(19);
  });

  test("fellow isolation: fellow A hitting cap does not block fellow B on same problem", async () => {
    const db = testDb();
    const now = 1_700_000_000_000;

    for (let i = 0; i < 20; i++) {
      await checkAndReserveQuota(db, {
        fellowId: "fel_isolation_a",
        problemId: "P-4DSP",
        sponsorId: "spn_test_1",
        sessionId: "ses_test_1",
        route: "promote",
        idempotencyKey: `key-a-${i}`,
        requestDigest: `digest-a-${i}`,
        now: now + i * 1000,
      });
    }

    const resB = await checkAndReserveQuota(db, {
      fellowId: "fel_isolation_b",
      problemId: "P-4DSP",
      sponsorId: "spn_test_2",
      sessionId: "ses_test_2",
      route: "promote",
      idempotencyKey: "key-b-1",
      requestDigest: "digest-b-1",
      now: now + 25_000,
    });
    expect(resB.allowed).toBe(true);
    if (!resB.allowed) throw new Error("expected allowed");
    expect(resB.budget.remaining).toBe(19);
  });

  test("sponsor aggregate limit: enforces limit across multiple fellows", async () => {
    const db = testDb();
    const now = 1_700_000_000_000;
    const sponsorLimit = 3;

    // Fellow 1 uses 2 attempts
    for (let i = 0; i < 2; i++) {
      const res = await checkAndReserveQuota(db, {
        fellowId: "fel_sponsor_1",
        problemId: "P-4DSP",
        sponsorId: "spn_shared",
        sessionId: "ses_test_1",
        route: "promote",
        idempotencyKey: `key-s1-${i}`,
        requestDigest: `digest-s1-${i}`,
        sponsorLimit,
        now: now + i * 1000,
      });
      expect(res.allowed).toBe(true);
    }

    // Fellow 2 uses the 3rd attempt (reaching sponsorLimit)
    const res2 = await checkAndReserveQuota(db, {
      fellowId: "fel_sponsor_2",
      problemId: "P-4DSP",
      sponsorId: "spn_shared",
      sessionId: "ses_test_2",
      route: "promote",
      idempotencyKey: "key-s2-1",
      requestDigest: "digest-s2-1",
      sponsorLimit,
      now: now + 2000,
    });
    expect(res2.allowed).toBe(true);

    // Fellow 2 (or Fellow 3) tries 4th attempt -> rejected by sponsor limit
    const res3 = await checkAndReserveQuota(db, {
      fellowId: "fel_sponsor_3",
      problemId: "P-4DSP",
      sponsorId: "spn_shared",
      sessionId: "ses_test_3",
      route: "promote",
      idempotencyKey: "key-s3-1",
      requestDigest: "digest-s3-1",
      sponsorLimit,
      now: now + 3000,
    });

    expect(res3.allowed).toBe(false);
    if (res3.allowed || res3.reason !== "RATE_LIMITED") throw new Error("expected rate limited");
    expect(res3.dimension).toBe("sponsor");
    expect(res3.budget.sponsor_remaining).toBe(0);
    expect(res3.budget.sponsor_limit).toBe(3);
  });

  test("sponsor limit of 0 rejects immediately", async () => {
    const db = testDb();
    const now = 1_700_000_000_000;
    const res = await checkAndReserveQuota(db, {
      fellowId: "fel_zero",
      problemId: "P-4DSP",
      sponsorId: "spn_zero",
      sessionId: "ses_zero",
      route: "promote",
      idempotencyKey: "key-0",
      requestDigest: "digest-0",
      sponsorLimit: 0,
      now,
    });

    expect(res.allowed).toBe(false);
    if (res.allowed || res.reason !== "RATE_LIMITED") throw new Error("expected rate limited");
    expect(res.dimension).toBe("sponsor");
    expect(res.budget.sponsor_limit).toBe(0);
    expect(res.budget.sponsor_remaining).toBe(0);
  });

  test("window rollover: attempts older than 1h roll out of the window", async () => {
    const db = testDb();
    const t0 = 1_700_000_000_000;

    // Use up all 20 attempts at t0
    for (let i = 0; i < 20; i++) {
      await checkAndReserveQuota(db, {
        fellowId: "fel_rollover",
        problemId: "P-4DSP",
        sponsorId: "spn_rollover",
        sessionId: "ses_rollover",
        route: "promote",
        idempotencyKey: `key-${i}`,
        requestDigest: `digest-${i}`,
        now: t0 + i * 1000,
      });
    }

    // At t0 + 30m, still rejected
    const midRes = await checkAndReserveQuota(db, {
      fellowId: "fel_rollover",
      problemId: "P-4DSP",
      sponsorId: "spn_rollover",
      sessionId: "ses_rollover",
      route: "promote",
      idempotencyKey: "key-mid",
      requestDigest: "digest-mid",
      now: t0 + 1_800_000,
    });
    expect(midRes.allowed).toBe(false);

    // At t0 + 1h + 5s, the first 5 attempts have rolled out
    const rollRes = await checkAndReserveQuota(db, {
      fellowId: "fel_rollover",
      problemId: "P-4DSP",
      sponsorId: "spn_rollover",
      sessionId: "ses_rollover",
      route: "promote",
      idempotencyKey: "key-post",
      requestDigest: "digest-post",
      now: t0 + PROMOTION_RATE_LIMIT_WINDOW_MS + 5_000,
    });
    expect(rollRes.allowed).toBe(true);
  });

  test("uncertain provider outcome: expired reservation is recovered and STILL consumes quota", async () => {
    const db = testDb();
    const t0 = 1_700_000_000_000;

    // 19 settled attempts
    for (let i = 0; i < 19; i++) {
      const res = await checkAndReserveQuota(db, {
        fellowId: "fel_uncertain",
        problemId: "P-4DSP",
        sponsorId: "spn_uncertain",
        sessionId: "ses_uncertain",
        route: "promote",
        idempotencyKey: `key-${i}`,
        requestDigest: `digest-${i}`,
        now: t0 + i * 1000,
      });
      if (res.allowed) {
        await settleQuotaReservation(db, res.reservation.reservationId, "settled_published");
      }
    }

    // 20th attempt is reserved, but worker crashes / provider times out
    const lostRes = await checkAndReserveQuota(db, {
      fellowId: "fel_uncertain",
      problemId: "P-4DSP",
      sponsorId: "spn_uncertain",
      sessionId: "ses_uncertain",
      route: "promote",
      idempotencyKey: "key-lost",
      requestDigest: "digest-lost",
      now: t0 + 20_000,
    });
    expect(lostRes.allowed).toBe(true);

    // 70 seconds later (past RESERVATION_EXPIRY_MS), another attempt arrives
    // The expired reservation is recovered, but it must NOT make the attempt free!
    const nextRes = await checkAndReserveQuota(db, {
      fellowId: "fel_uncertain",
      problemId: "P-4DSP",
      sponsorId: "spn_uncertain",
      sessionId: "ses_uncertain",
      route: "promote",
      idempotencyKey: "key-after-crash",
      requestDigest: "digest-after-crash",
      now: t0 + 20_000 + 70_000,
    });

    // It must be RATE_LIMITED because the lost attempt still consumes capacity
    expect(nextRes.allowed).toBe(false);
    if (nextRes.allowed || nextRes.reason !== "RATE_LIMITED")
      throw new Error("expected rate limited");
    expect(nextRes.dimension).toBe("fellow_problem");

    // Verify in DB that the lost reservation status became 'recovered'
    const recoveredRow = await db
      .prepare("SELECT status FROM public_write_attempt_reservations WHERE reservation_id = ?")
      .bind(lostRes.allowed ? lostRes.reservation.reservationId : "")
      .first<{ status: string }>();
    expect(recoveredRow?.status).toBe("recovered");
  });

  test("in-flight reservation handling: neither same nor different body re-enters paid screening", async () => {
    const db = testDb();
    const now = 1_700_000_000_000;

    // First attempt creates in-flight reservation
    const first = await checkAndReserveQuota(db, {
      fellowId: "fel_inflight",
      problemId: "P-4DSP",
      sponsorId: "spn_inflight",
      sessionId: "ses_inflight",
      route: "promote",
      idempotencyKey: "inflight-key",
      requestDigest: "digest-body-a",
      now,
    });
    expect(first.allowed).toBe(true);

    // A reservation is admission for one caller, not a reusable paid-screening ticket.
    const retry = await checkAndReserveQuota(db, {
      fellowId: "fel_inflight",
      problemId: "P-4DSP",
      sponsorId: "spn_inflight",
      sessionId: "ses_inflight",
      route: "promote",
      idempotencyKey: "inflight-key",
      requestDigest: "digest-body-a",
      now: now + 5000,
    });
    expect(retry.allowed).toBe(false);
    if (retry.allowed) throw new Error("in-flight retry must not screen again");
    expect(retry.reason).toBe("IN_FLIGHT_CONFLICT");

    // Different body with same idempotency key returns IN_FLIGHT_CONFLICT
    const conflict = await checkAndReserveQuota(db, {
      fellowId: "fel_inflight",
      problemId: "P-4DSP",
      sponsorId: "spn_inflight",
      sessionId: "ses_inflight",
      route: "promote",
      idempotencyKey: "inflight-key",
      requestDigest: "digest-body-different",
      now: now + 6000,
    });
    expect(conflict.allowed).toBe(false);
    if (conflict.allowed) throw new Error("expected conflict");
    expect(conflict.reason).toBe("IN_FLIGHT_CONFLICT");
  });

  test("missing or failed quota storage fails closed", async () => {
    const brokenDb = {
      prepare() {
        throw new Error("D1 connection lost");
      },
    } as unknown as D1Database;

    await expect(
      checkAndReserveQuota(brokenDb, {
        fellowId: "fel_fail",
        problemId: "P-4DSP",
        sponsorId: "spn_fail",
        sessionId: "ses_fail",
        route: "promote",
        idempotencyKey: "key-fail",
        requestDigest: "digest-fail",
      }),
    ).rejects.toThrow("D1 connection lost");
  });

  test("settled reservations are immutable", async () => {
    const db = testDb();
    const now = 1_700_000_000_000;
    const res = await checkAndReserveQuota(db, {
      fellowId: "fel_immutable",
      problemId: "P-4DSP",
      sponsorId: "spn_immutable",
      sessionId: "ses_immutable",
      route: "promote",
      idempotencyKey: "key-imm",
      requestDigest: "digest-imm",
      now,
    });
    expect(res.allowed).toBe(true);
    if (!res.allowed) throw new Error("expected allowed");

    // Settle as published
    await settleQuotaReservationStatement(db, res.reservation.reservationId, now + 1000).run();

    // Attempting to update a settled reservation throws SETTLED_RESERVATION_IMMUTABLE
    await expect(
      db
        .prepare(
          "UPDATE public_write_attempt_reservations SET status = 'recovered' WHERE reservation_id = ?",
        )
        .bind(res.reservation.reservationId)
        .run(),
    ).rejects.toThrow("SETTLED_RESERVATION_IMMUTABLE");

    // Attempting to delete throws RESERVATION_IMMUTABLE
    await expect(
      db
        .prepare("DELETE FROM public_write_attempt_reservations WHERE reservation_id = ?")
        .bind(res.reservation.reservationId)
        .run(),
    ).rejects.toThrow("RESERVATION_IMMUTABLE");
  });
});

describe("pure table/property tests: getRemainingBudget and problem formatting", () => {
  test("getRemainingBudget returns accurate remaining count and reflects sponsor limit", async () => {
    const db = testDb();
    const now = 1_700_000_000_000;

    // Initially 20 remaining
    const initial = await getRemainingBudget(db, {
      fellowId: "fel_budget_check",
      problemId: "P-4DSP",
      sponsorId: "spn_budget_check",
      sponsorLimit: 10,
      now,
    });
    expect(initial.limit).toBe(20);
    expect(initial.remaining).toBe(20);
    expect(initial.sponsor_limit).toBe(10);
    expect(initial.sponsor_remaining).toBe(10);
    expect(initial.retry_after_seconds).toBeUndefined();

    // After 5 attempts
    for (let i = 0; i < 5; i++) {
      await checkAndReserveQuota(db, {
        fellowId: "fel_budget_check",
        problemId: "P-4DSP",
        sponsorId: "spn_budget_check",
        sessionId: "ses_test",
        route: "promote",
        idempotencyKey: `k-${i}`,
        requestDigest: `d-${i}`,
        sponsorLimit: 10,
        now: now + i * 1000,
      });
    }

    const updated = await getRemainingBudget(db, {
      fellowId: "fel_budget_check",
      problemId: "P-4DSP",
      sponsorId: "spn_budget_check",
      sponsorLimit: 10,
      now: now + 6000,
    });
    expect(updated.remaining).toBe(15);
    expect(updated.sponsor_remaining).toBe(5);
  });

  test("promotionRateLimitedProblem produces RFC 7807 document with Rule A5 and rate limit headers", async () => {
    const response = promotionRateLimitedProblem({
      retryAfterSeconds: 120,
      budget: {
        limit: 20,
        remaining: 0,
        window_seconds: 3600,
        retry_after_seconds: 120,
        sponsor_limit: null,
        sponsor_remaining: null,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(response.headers.get("ratelimit-limit")).toBe("20");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
    expect(response.headers.get("ratelimit-reset")).toBe("120");
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("PROMOTION_RATE_LIMITED");
    expect(body.rule).toBe("A5");
    expect(body.fix_hint).toContain("Keep using the workshop");
    expect(body.limit).toBe(20);
    expect(body.remaining).toBe(0);
    expect(WorkshopPushRequestSchema.safeParse(body.example).success).toBe(true);
  });

  test.each([0, 5])(
    "promotionRateLimitedProblem reflects sponsor limit %i",
    async (sponsorLimit) => {
      const response = promotionRateLimitedProblem({
        retryAfterSeconds: 60,
        dimension: "sponsor",
        budget: {
          limit: 20,
          remaining: 15,
          window_seconds: 3600,
          sponsor_limit: sponsorLimit,
          sponsor_remaining: 0,
        },
      });

      expect(response.status).toBe(429);
      expect(response.headers.get("ratelimit-limit")).toBe(String(sponsorLimit));
      expect(response.headers.get("ratelimit-remaining")).toBe("0");

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.detail).toContain("Sponsor promotion");
      if (sponsorLimit === 0) {
        expect(body.fix_hint).toContain("operator-configured promotion limit");
      }
      expect(body.limit).toBe(sponsorLimit);
      expect(body.remaining).toBe(0);
    },
  );
});
