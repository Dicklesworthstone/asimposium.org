import { describe, expect, test } from "bun:test";

import { RECENT_DECISION_WINDOW_SECONDS, recentAuthOk } from "../../lib/recent-auth.ts";

describe("sponsor decision recent-auth boundary", () => {
  const now = 1_800_000_000;

  test("accepts the inclusive fifteen-minute window", () => {
    expect(recentAuthOk(now, now)).toBe(true);
    expect(recentAuthOk(now - RECENT_DECISION_WINDOW_SECONDS, now)).toBe(true);
    expect(recentAuthOk(now - RECENT_DECISION_WINDOW_SECONDS - 1, now)).toBe(false);
  });

  test("fails closed for missing, negative, future, fractional, and non-finite claims", () => {
    for (const claim of [
      undefined,
      -1,
      now + 1,
      now - 0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(recentAuthOk(claim, now), String(claim)).toBe(false);
    }
    expect(recentAuthOk(now, Number.NaN)).toBe(false);
    expect(recentAuthOk(0, -1)).toBe(false);
  });

  test("an ordinary later session read cannot make an old claim fresh", () => {
    const signedInAt = now - RECENT_DECISION_WINDOW_SECONDS - 1;
    expect(recentAuthOk(signedInAt, now)).toBe(false);
    expect(recentAuthOk(signedInAt, now + 60)).toBe(false);
  });
});
