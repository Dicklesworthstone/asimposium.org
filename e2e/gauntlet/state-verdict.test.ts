import { describe, expect, test } from "bun:test";
import { GAUNTLET_STAGES, gauntletVerdict } from "./state-verdict.mjs";

const sponsorId = "usr_s";
const problemId = "P-X";
const fellow = { fellow_id: "F-1", sponsor_id: sponsorId };
const closedSession = {
  session_id: "S-1",
  problem_id: problemId,
  closed_at: "2026-09-24T00:00:00Z",
  has_handback: true,
};
const obs = (
  method: string,
  path: string,
  status: number,
  code: string | null = null,
  injected = false,
) => ({
  method,
  path,
  status,
  code,
  injected,
});
const fullObservations = [
  obs("POST", "/v1/fellows", 202),
  obs("GET", "/v1/hello", 200),
  obs("GET", "/v1/sessions/S-1/pack", 200),
  obs("POST", "/v1/sessions/S-1/promote", 422, "PROMOTE_BODY_INVALID", true),
  obs("POST", "/v1/sessions/S-1/promote", 201),
];
const complete = {
  fellow,
  sponsorId,
  problemId,
  sessions: [closedSession],
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
      sessions: [{ ...closedSession, closed_at: null }],
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
      observations: fullObservations.slice(0, 4),
    });
    expect(verdict.missing).toContain("refusal_recovered");
  });
  test("an injected success plus later natural refusals cannot prove recovery", () => {
    const verdict = gauntletVerdict({
      ...complete,
      observations: [
        ...fullObservations.slice(0, 3),
        obs("POST", "/v1/sessions/S-1/promote", 201, null, true),
        obs("POST", "/v1/sessions/S-1/promote", 422, "PROMOTE_BODY_INVALID"),
        obs("POST", "/v1/sessions/S-1/promote", 201),
      ],
    });
    expect(verdict.completed).toBe(false);
    expect(verdict.missing).toContain("refusal_recovered");
  });
  test("natural-only contract refusals cannot replace the injected refusal", () => {
    const verdict = gauntletVerdict({
      ...complete,
      observations: fullObservations.map((observation) => ({ ...observation, injected: false })),
    });
    expect(verdict.completed).toBe(false);
    expect(verdict.missing).toContain("refusal_recovered");
  });
  test("success on a different owned session does not recover the refused promotion", () => {
    const verdict = gauntletVerdict({
      ...complete,
      sessions: [...complete.sessions, { ...closedSession, session_id: "S-2" }],
      observations: [...fullObservations.slice(0, 4), obs("POST", "/v1/sessions/S-2/promote", 201)],
    });
    expect(verdict.missing).toContain("refusal_recovered");
  });
  test("actual recovery on a later owned session still counts", () => {
    const verdict = gauntletVerdict({
      ...complete,
      sessions: [...complete.sessions, { ...closedSession, session_id: "S-2" }],
      observations: [
        ...fullObservations.slice(0, 4),
        obs("POST", "/v1/sessions/S-2/promote", 422, "PROMOTE_BODY_INVALID", true),
        obs("POST", "/v1/sessions/S-2/promote", 201),
      ],
    });
    expect(verdict.completed).toBe(true);
  });
  test("a foreign session's injected refusal cannot prove this Fellow recovered", () => {
    const verdict = gauntletVerdict({
      ...complete,
      observations: [
        ...fullObservations.slice(0, 3),
        obs("POST", "/v1/sessions/S-OTHER/promote", 422, "PROMOTE_BODY_INVALID", true),
        obs("POST", "/v1/sessions/S-1/promote", 201),
      ],
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
  test("a journey without a pack read is incomplete", () => {
    const verdict = gauntletVerdict({
      ...complete,
      observations: fullObservations.filter((observation) => !observation.path.endsWith("/pack")),
    });
    expect(verdict.completed).toBe(false);
    expect(verdict.missing).toContain("pack_read");
  });
  test.each([
    ["GET", "/v1/sessions/S-OTHER/pack", 200],
    ["GET", "/v1/sessions/S-1/pack", 403],
    ["POST", "/v1/sessions/S-1/pack", 200],
    ["GET", "/v1/sessions/S-1/pack-extra", 200],
  ] as const)("only a successful owned pack GET counts: %s %s %s", (method, path, status) => {
    const verdict = gauntletVerdict({
      ...complete,
      observations: [
        ...fullObservations.filter((observation) => !observation.path.endsWith("/pack")),
        obs(method, path, status),
      ],
    });
    expect(verdict.completed).toBe(false);
    expect(verdict.missing).toContain("pack_read");
  });
  test.each([false, true])(
    "admitted non-conjecture-class claims require a falsifier: %s",
    (has_falsifier) => {
      const verdict = gauntletVerdict({
        ...complete,
        publicClaims: [{ author_fellow_id: "F-1", has_falsifier, conjecture_class: false }],
      });
      expect(verdict.completed).toBe(has_falsifier);
      if (has_falsifier) expect(verdict.missing).not.toContain("promoted_public");
      else expect(verdict.missing).toContain("promoted_public");
    },
  );
  test("an owned pack from another problem does not satisfy this attempt", () => {
    const verdict = gauntletVerdict({
      ...complete,
      sessions: [
        ...complete.sessions,
        { ...closedSession, session_id: "S-2", problem_id: "P-OTHER" },
      ],
      observations: [
        ...fullObservations.filter((observation) => !observation.path.endsWith("/pack")),
        obs("GET", "/v1/sessions/S-2/pack", 200),
      ],
    });
    expect(verdict.completed).toBe(false);
    expect(verdict.missing).toContain("pack_read");
  });
  test("idle closure without an authored handback is incomplete", () => {
    const verdict = gauntletVerdict({
      ...complete,
      sessions: [{ ...closedSession, has_handback: false }],
    });
    expect(verdict.completed).toBe(false);
    expect(verdict.missing).toContain("closed");
  });
});
