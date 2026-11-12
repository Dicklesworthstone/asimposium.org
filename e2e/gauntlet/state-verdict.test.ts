import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
let nextOrder = 0;
const obs = (
  method: string,
  path: string,
  status: number,
  code: string | null = null,
  injected = false,
  claimId = "C-1",
) => {
  const startedOrder = ++nextOrder;
  return {
    started_order: startedOrder,
    completed_order: ++nextOrder,
    claim_id:
      method === "POST" && path.endsWith("/promote") && (status === 200 || status === 201)
        ? claimId
        : null,
    method,
    path,
    status,
    code,
    injected,
  };
};
const fullObservations = [
  obs("POST", "/v1/fellows", 202),
  obs("GET", "/v1/hello", 200),
  obs("GET", "/v1/sessions/S-1/pack", 200),
  obs("POST", "/v1/sessions/S-1/promote", 422, "PROMOTE_BODY_INVALID", true),
  obs("POST", "/v1/sessions/S-1/promote", 201),
];
const publicClaim = {
  claim_id: "C-1",
  author_fellow_id: "F-1",
  session_id: "S-1",
  has_falsifier: true,
  conjecture_class: true,
};
const complete = {
  fellow,
  sponsorId,
  problemId,
  sessions: [closedSession],
  workshopObjects: 1,
  publicClaims: [publicClaim],
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
  test("a late pack and replay cannot prepare an already published claim", () => {
    const observations = [
      obs("GET", "/v1/hello", 200),
      obs("POST", "/v1/sessions/S-1/promote", 422, "PROMOTE_BODY_INVALID", true),
      obs("POST", "/v1/sessions/S-1/promote", 201),
      obs("GET", "/v1/sessions/S-1/pack", 200),
      obs("POST", "/v1/sessions/S-1/promote", 200),
    ];
    const verdict = gauntletVerdict({ ...complete, observations });
    expect(verdict.completed).toBe(false);
    expect(verdict.missing).toEqual(["pack_read"]);
    expect(verdict.failures).toEqual([]);
  });
  test("a later genuinely prepared claim can complete after an unprepared publication", () => {
    const observations = [
      obs("GET", "/v1/hello", 200),
      obs("POST", "/v1/sessions/S-1/promote", 422, "PROMOTE_BODY_INVALID", true),
      obs("POST", "/v1/sessions/S-1/promote", 201),
      obs("GET", "/v1/sessions/S-1/pack", 200),
      obs("POST", "/v1/sessions/S-1/promote", 200),
      obs("POST", "/v1/sessions/S-1/promote", 201, null, false, "C-2"),
    ];
    expect(
      gauntletVerdict({
        ...complete,
        observations,
        publicClaims: [...complete.publicClaims, { ...publicClaim, claim_id: "C-2" }],
      }).completed,
    ).toBe(true);
  });
  test("a replay without the original creation witness cannot prove new publication", () => {
    const observations = fullObservations.map((observation) =>
      observation.status === 201 ? { ...observation, status: 200 } : observation,
    );
    expect(gauntletVerdict({ ...complete, observations }).missing).toEqual(["pack_read"]);
  });
  test("an aborted read does not prevent a later genuinely completed preparation", () => {
    const observations = [
      obs("GET", "/v1/hello", 200),
      { ...obs("GET", "/v1/sessions/S-1/pack", 200), completed_order: null },
      obs("GET", "/v1/sessions/S-1/pack", 200),
      obs("POST", "/v1/sessions/S-1/promote", 422, "PROMOTE_BODY_INVALID", true),
      obs("POST", "/v1/sessions/S-1/promote", 201),
    ];
    expect(gauntletVerdict({ ...complete, observations }).completed).toBe(true);
  });
  test("another successful object does not replace or poison a verified claim receipt", () => {
    const observations = [
      obs("GET", "/v1/hello", 200),
      { ...obs("POST", "/v1/sessions/S-1/promote", 201), claim_id: null },
      obs("GET", "/v1/sessions/S-1/pack", 200),
      obs("POST", "/v1/sessions/S-1/promote", 422, "PROMOTE_BODY_INVALID", true),
      obs("POST", "/v1/sessions/S-1/promote", 201),
    ];
    expect(gauntletVerdict({ ...complete, observations }).completed).toBe(true);
  });
  test("a lost creation response followed by a pack and replay stays unproven", () => {
    const observations = [
      obs("GET", "/v1/hello", 200),
      obs("POST", "/v1/sessions/S-1/promote", 422, "PROMOTE_BODY_INVALID", true),
      obs("POST", "/v1/sessions/S-1/promote", 502),
      obs("GET", "/v1/sessions/S-1/pack", 200),
      obs("POST", "/v1/sessions/S-1/promote", 200),
    ];
    expect(gauntletVerdict({ ...complete, observations }).missing).toEqual(["pack_read"]);
  });
  test("a read overlapping the publishing request is not earlier preparation", () => {
    const observations = fullObservations.map((observation) => ({
      ...observation,
      started_order: observation.started_order * 10,
      completed_order: observation.path.endsWith("/pack") ? 95 : observation.completed_order * 10,
    }));
    // Pack [50,95] and publication [90,100] overlap. Completion order alone
    // would count the read, even though the write began before it was served.
    expect(gauntletVerdict({ ...complete, observations }).missing).toEqual(["pack_read"]);
  });
  test.each([undefined, NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "unverified request ordinals cannot establish preparation: %s",
    (started_order) => {
      const observations = fullObservations.map((observation) =>
        observation.path.endsWith("/pack") ? { ...observation, started_order } : observation,
      );
      expect(gauntletVerdict({ ...complete, observations }).missing).toEqual(["pack_read"]);
    },
  );
  test.each([undefined, null, NaN, Infinity, -1, 0, 5, 7.5, Number.MAX_SAFE_INTEGER + 1])(
    "unverified response ordinals cannot establish preparation: %s",
    (completed_order) => {
      const observations = fullObservations.map((observation) =>
        observation.path.endsWith("/pack") ? { ...observation, completed_order } : observation,
      );
      expect(gauntletVerdict({ ...complete, observations }).missing).toEqual(["pack_read"]);
    },
  );
  test("duplicate observation endpoints cannot establish a chronology", () => {
    const observations = fullObservations.map((observation) =>
      observation.path.endsWith("/pack") ? { ...observation, started_order: 1 } : observation,
    );
    expect(gauntletVerdict({ ...complete, observations }).missing).toEqual(["pack_read"]);
  });
  test.each([undefined, null, "", "C-OTHER"])(
    "a missing or foreign successful receipt cannot prepare the public claim: %s",
    (claim_id) => {
      const observations = fullObservations.map((observation) =>
        observation.status === 201 ? { ...observation, claim_id } : observation,
      );
      expect(gauntletVerdict({ ...complete, observations }).completed).toBe(false);
    },
  );
  test.each([undefined, null, "", "C-OTHER"])(
    "a missing or foreign public claim ID cannot borrow a prepared receipt: %s",
    (claim_id) => {
      expect(
        gauntletVerdict({
          ...complete,
          publicClaims: complete.publicClaims.map((claim) => ({ ...claim, claim_id })),
        }).completed,
      ).toBe(false);
    },
  );
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
      publicClaims: [
        {
          author_fellow_id: "F-1",
          session_id: "S-1",
          has_falsifier: false,
          conjecture_class: true,
        },
      ],
    });
    expect(verdict.missing).toContain("promoted_public");
  });
  test("another Fellow's public claim does not count", () => {
    const verdict = gauntletVerdict({
      ...complete,
      publicClaims: [
        {
          author_fellow_id: "F-OTHER",
          session_id: "S-1",
          has_falsifier: true,
          conjecture_class: true,
        },
      ],
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
      publicClaims: complete.publicClaims.map((claim) => ({ ...claim, session_id: "S-2" })),
      observations: [
        ...fullObservations.slice(0, 4),
        obs("GET", "/v1/sessions/S-2/pack", 200),
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
        publicClaims: [
          {
            claim_id: "C-1",
            author_fellow_id: "F-1",
            session_id: "S-1",
            has_falsifier,
            conjecture_class: false,
          },
        ],
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

  test("a different closed session cannot supply the publishing session's handback", () => {
    const verdict = gauntletVerdict({
      ...complete,
      sessions: [
        { ...closedSession, closed_at: null, has_handback: false },
        { ...closedSession, session_id: "S-2" },
      ],
    });
    expect(verdict.completed).toBe(false);
    expect(verdict.missing).toEqual(["closed"]);
  });

  test("pack and closure on one session cannot be stitched to another's public contribution", () => {
    const facts = {
      ...complete,
      sessions: [
        closedSession,
        { ...closedSession, session_id: "S-2", closed_at: null, has_handback: false },
      ],
      publicClaims: complete.publicClaims.map((claim) => ({ ...claim, session_id: "S-2" })),
      observations: [
        ...fullObservations.slice(0, 3),
        obs("POST", "/v1/sessions/S-2/promote", 422, "PROMOTE_BODY_INVALID", true),
        obs("POST", "/v1/sessions/S-2/promote", 201),
      ],
    };
    const verdict = gauntletVerdict(facts);
    expect(verdict.completed).toBe(false);
    expect(verdict.missing).toEqual(["pack_read", "closed"]);
    expect(gauntletVerdict({ ...facts, sessions: [...facts.sessions].reverse() })).toEqual(verdict);
  });

  test.each([null, "", "S-FOREIGN"])(
    "missing or foreign public session attribution cannot count as a publication: %s",
    (session_id) => {
      const verdict = gauntletVerdict({
        ...complete,
        publicClaims: complete.publicClaims.map((claim) => ({ ...claim, session_id })),
      });
      expect(verdict.completed).toBe(false);
      expect(verdict.missing).toContain("promoted_public");
    },
  );

  test("a different session's recovery cannot stand in for the public claim's session", () => {
    const verdict = gauntletVerdict({
      ...complete,
      sessions: [...complete.sessions, { ...closedSession, session_id: "S-2" }],
      observations: [
        ...fullObservations.slice(0, 3),
        obs("POST", "/v1/sessions/S-1/promote", 201),
        obs("GET", "/v1/sessions/S-2/pack", 200),
        obs("POST", "/v1/sessions/S-2/promote", 422, "PROMOTE_BODY_INVALID", true),
        obs("POST", "/v1/sessions/S-2/promote", 201),
      ],
    });
    expect(verdict.completed).toBe(false);
    expect(verdict.missing).toEqual(["refusal_recovered"]);
  });
});

test("proxy completion follows actual Node HTTP finish and refuses premature close", () => {
  const source = readFileSync(new URL("./local-target.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export function observeGauntletResponse(");
  const end = source.indexOf("/** Start Workerd + proxy.", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  // Execute the exact production helper without importing Wrangler's entire
  // Worker setup into this HTTP transport unit. Neither endpoint is mocked.
  const script = `
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
assert.equal(process.versions.bun, undefined);
assert.ok(process.versions.node.startsWith("24."));
${source.slice(start, end)}
async function probe(abort) {
  const records = [];
  let order = 0;
  let complete;
  const terminal = new Promise(resolve => { complete = resolve; });
  const server = createServer((_request, response) => {
    observeGauntletResponse(response, () => ++order, value => {
      records.push(value);
      complete();
    });
    if (abort) response.destroy();
    else response.end("public HTTP unit fixture");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await Promise.all([terminal, new Promise((resolve, reject) => {
      const request = get({ hostname: "127.0.0.1", port: server.address().port,
        headers: { "user-agent": "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)" }
      }, response => {
        response.resume();
        response.on("end", resolve);
        response.on("error", abort ? resolve : reject);
      });
      request.on("error", abort ? resolve : reject);
    })]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  assert.deepEqual(records, [abort ? null : 1]);
  assert.equal(order, abort ? 0 : 1);
}
await probe(false);
await probe(true);
console.log("HTTP_COMPLETION_BOUNDARY_OK");
`;
  const child = spawnSync("node", ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain("HTTP_COMPLETION_BOUNDARY_OK");
});
