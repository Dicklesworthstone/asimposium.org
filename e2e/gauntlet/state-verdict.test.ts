import { describe, expect, test } from "bun:test";
import { GAUNTLET_STAGES, gauntletVerdict } from "./state-verdict.mjs";

const sponsorId = "usr_s";
const problemId = "P-X";
const fellow = { fellow_id: "F-1", sponsor_id: sponsorId };
const obs = (method: string, path: string, status: number, code: string | null = null) => ({
  method,
  path,
  status,
  code,
});
const fullObservations = [
  obs("POST", "/v1/fellows", 202),
  obs("GET", "/v1/hello", 200),
  obs("POST", "/v1/sessions/S-1/promote", 422, "MISSING_FALSIFIER"),
  obs("POST", "/v1/sessions/S-1/promote", 201),
];
const complete = {
  fellow,
  sponsorId,
  problemId,
  sessions: [{ session_id: "S-1", problem_id: problemId, closed_at: "2026-09-24T00:00:00Z" }],
  workshopObjects: 1,
  publicClaims: [{ author_fellow_id: "F-1", has_falsifier: true, conjecture_class: true }],
  observations: fullObservations,
  injected: true,
  secretSeenInPaths: false,
};

describe("state-derived gauntlet verdict", () => {
  test("a complete loop passes and reaches every stage", () => {
    const verdict = gauntletVerdict(complete);
    expect(verdict.completed).toBe(true);
    expect(verdict.reached).toEqual([...GAUNTLET_STAGES]);
  });
  test("an unclosed session fails", () => {
    const verdict = gauntletVerdict({
      ...complete,
      sessions: [{ session_id: "S-1", problem_id: problemId, closed_at: null }],
    });
    expect(verdict.completed).toBe(false);
    expect(verdict.missing).toEqual(["closed"]);
  });
  test("a conjecture without a falsifier does not count as promoted", () => {
    const verdict = gauntletVerdict({
      ...complete,
      publicClaims: [{ author_fellow_id: "F-1", has_falsifier: false, conjecture_class: true }],
    });
    expect(verdict.missing).toContain("promoted_public");
  });
  test("another Fellow's public claim does not count", () => {
    const verdict = gauntletVerdict({
      ...complete,
      publicClaims: [{ author_fellow_id: "F-OTHER", has_falsifier: true, conjecture_class: true }],
    });
    expect(verdict.completed).toBe(false);
  });
  test("a refusal never followed by success is not recovery", () => {
    const verdict = gauntletVerdict({
      ...complete,
      observations: fullObservations.slice(0, 3),
    });
    expect(verdict.missing).toContain("refusal_recovered");
  });
  test("an unapproved or foreign-sponsor Fellow fails", () => {
    expect(gauntletVerdict({ ...complete, fellow: null }).completed).toBe(false);
    expect(
      gauntletVerdict({ ...complete, fellow: { fellow_id: "F-1", sponsor_id: "usr_other" } })
        .completed,
    ).toBe(false);
  });
  test("no injection or a leaked secret fails even when every stage is reached", () => {
    expect(gauntletVerdict({ ...complete, injected: false }).completed).toBe(false);
    expect(gauntletVerdict({ ...complete, secretSeenInPaths: true }).completed).toBe(false);
  });
  test("the verdict takes no agent-reported input", () => {
    // A transcript claiming success is not a field the verdict reads.
    const withClaim = { ...complete, workshopObjects: 0, agentSaysSucceeded: true };
    expect(gauntletVerdict(withClaim).completed).toBe(false);
  });
});
