import { describe, expect, test } from "bun:test";
import {
  ClaimReanchorResponseSchema,
  ProblemDocumentSchema,
  PromoteResponseSchema,
  SessionOpenResponseSchema,
  WorkshopPushResponseSchema,
} from "@asimposium/contracts";
import { writeLedgerEvent } from "../../src/krater/krater.ts";
import { normHash, sha256Hex } from "../../src/split/policy.ts";
import { fixture } from "./session-routes.test.ts";

const PROBLEM = "P-4DSP";
type RacePoint = "after-context-read" | "before-commit";

// The production route and transaction run against the shared migrated SQLite
// unit adapter. The re-anchor native journey separately exercises Workerd/D1.
async function reanchorFixture() {
  let armed: RacePoint | undefined;
  let ready = false;
  let raced: { seq: number; version: number } | undefined;
  const f = await fixture({
    afterRead: async (read) => {
      if (
        armed === "after-context-read" &&
        read.kind === "first" &&
        read.sql.startsWith("SELECT seq, object_version FROM events")
      ) {
        armed = undefined;
        raced = await revision();
      }
      if (
        armed === "before-commit" &&
        read.kind === "first" &&
        read.sql.includes("AS author_fellow_id") &&
        read.sql.includes("FROM claims c WHERE")
      )
        ready = true;
    },
    beforeBatch: async () => {
      if (armed !== "before-commit" || !ready) return;
      armed = undefined;
      ready = false;
      raced = await revision();
    },
  });
  let key = 0;
  const post = (
    path: string,
    body: unknown,
    requestKey = `reanchor-context-${++key}`,
    headers: Record<string, string> = {},
  ) =>
    f.call(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": requestKey, ...headers },
      body: JSON.stringify(body),
    });
  const opened = await post("/v1/sessions", { problem_id: PROBLEM });
  expect(opened.status, await opened.clone().text()).toBe(201);
  const session = SessionOpenResponseSchema.parse(await opened.json());
  const path = `/v1/sessions/${session.session_id}`;
  const saved = await post(`${path}/workshop`, {
    type: "claim-draft",
    title: "Parity claim",
    body_md: "Private draft for the inspected formulation.",
  });
  expect(saved.status, await saved.clone().text()).toBe(201);
  const draft = WorkshopPushResponseSchema.parse(await saved.json());
  const promoted = await post(`${path}/promote`, {
    workshop_id: draft.workshop_id,
    kind: "conjecture",
    statement: "Every even integer in the problem domain has an even square.",
    falsifier: "An even input whose square is odd.",
  });
  expect(promoted.status, await promoted.clone().text()).toBe(201);
  const claim = PromoteResponseSchema.parse(await promoted.json());

  async function revision() {
    const current = await f.db
      .prepare("SELECT title, current_statement_version FROM problems WHERE id = ?")
      .bind(PROBLEM)
      .first<{ title: string; current_statement_version: number }>();
    if (!current) throw new Error("Missing re-anchor fixture problem");
    const version = current.current_statement_version + 1;
    const createdAt = new Date().toISOString();
    const statement = `For every integer n in 0..${version * 10}, n squared has the same parity as n.`;
    const falsifier = "An integer in the finite domain whose square changes its parity.";
    const motivation = "Keep claims tied to the formulation their authors actually inspected.";
    const payloadJson = JSON.stringify({
      action: "revise-statement",
      acting_principal: { type: "sponsor", id: f.binding.sponsorId },
      source_fellow_id: f.binding.fellowId,
      previous_statement_version: current.current_statement_version,
      previous_status: "active",
      problem: {
        id: PROBLEM,
        title: current.title,
        status: "active",
        current_statement_version: version,
        statement,
        falsifier,
        motivation,
        updated_at: createdAt,
      },
    });
    const hash = `sha256:${await normHash(statement)}`;
    const written = await writeLedgerEvent(
      f.db,
      {
        problemId: PROBLEM,
        eventId: `E-reanchor-context-${version}`,
        idempotencyKey: `reanchor-context-statement-${version}`,
        requestDigest: await sha256Hex(payloadJson),
        eventType: "problem.statement-revised",
        objectKind: "problem",
        objectId: PROBLEM,
        objectVersion: version,
        payloadJson,
        createdAt,
        attribution: {
          principalType: "sponsor",
          sponsorId: f.binding.sponsorId,
          fellowId: null,
          sessionId: null,
          modelSelfDeclared: null,
          harness: null,
        },
      },
      {
        statementsAfterEvent: () => [
          f.db
            .prepare(`INSERT INTO problem_statement_versions
              (problem_id, version, statement, norm_hash, falsifier, motivation, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .bind(PROBLEM, version, statement, hash, falsifier, motivation, createdAt),
          f.db
            .prepare(
              "UPDATE problems SET current_statement_version = ?, updated_at = ? WHERE id = ?",
            )
            .bind(version, createdAt, PROBLEM),
          f.db
            .prepare(
              "UPDATE claims SET statement_drift = 1 WHERE problem_id = ? AND statement_version < ?",
            )
            .bind(PROBLEM, version),
        ],
      },
    );
    return { seq: written.seq, version };
  }
  const state = () =>
    f.db
      .prepare(`SELECT p.public_seq, p.current_statement_version,
        c.statement_version, c.statement_drift,
        (SELECT COUNT(*) FROM events e WHERE e.problem_id = p.id AND e.type = 'claim.reanchored') AS reanchors,
        (SELECT COUNT(*) FROM session_write_replays WHERE scope = 'reanchor') AS receipts
        FROM problems p JOIN claims c ON c.problem_id = p.id
        WHERE p.id = ? AND c.id = ?`)
      .bind(PROBLEM, claim.claim_id)
      .first<{
        public_seq: number;
        current_statement_version: number;
        statement_version: number;
        statement_drift: number;
        reanchors: number;
        receipts: number;
      }>();
  return {
    post,
    path,
    request: { claim_id: claim.claim_id, base_version: claim.version },
    revision,
    state,
    arm: (point: RacePoint) => {
      armed = point;
      ready = false;
    },
    race: () => {
      expect(armed).toBeUndefined();
      if (!raced) throw new Error("The competing statement revision did not run");
      return raced;
    },
  };
}

describe("re-anchor statement context", () => {
  test("a captured request cannot clear drift against a later uninspected formulation", async () => {
    const f = await reanchorFixture();
    const inspected = await f.revision();
    const later = await f.revision();
    const before = await f.state();
    const response = await f.post(`${f.path}/reanchor`, {
      ...f.request,
      client_context_cursor: inspected.seq,
    });
    expect(response.status, await response.clone().text()).toBe(409);
    expect(ProblemDocumentSchema.parse(await response.json())).toMatchObject({
      code: "STATEMENT_REVISED_SINCE",
      statement_version: later.version,
      client_context_cursor: inspected.seq,
      revised_at_cursor: later.seq,
      delta_pointer: `/p/${PROBLEM}.md`,
    });
    expect(await f.state()).toEqual(before);
  });

  test("fresh body context permits re-anchor and exact replay does not adopt another revision", async () => {
    const f = await reanchorFixture();
    const inspected = await f.revision();
    const body = { ...f.request, client_context_cursor: inspected.seq };
    const response = await f.post(`${f.path}/reanchor`, body, "inspected-reanchor");
    expect(response.status, await response.clone().text()).toBe(200);
    const bytes = await response.text();
    expect(ClaimReanchorResponseSchema.parse(JSON.parse(bytes))).toMatchObject({
      statement_version: inspected.version,
      statement_drift: false,
    });
    await f.revision();
    const before = await f.state();
    expect(before?.statement_drift).toBe(1);
    const replay = await f.post(`${f.path}/reanchor`, body, "inspected-reanchor");
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(bytes);
    expect(await f.state()).toEqual(before);
    const repeatedIntent = await f.post(`${f.path}/reanchor`, body);
    expect(repeatedIntent.status).toBe(409);
  });

  test("session fallback refuses a later statement and a fresh header recovers the same session", async () => {
    const f = await reanchorFixture();
    const inspected = await f.revision();
    const before = await f.state();
    const legacy = await f.post(`${f.path}/reanchor`, f.request);
    expect(legacy.status, await legacy.clone().text()).toBe(409);
    expect(ProblemDocumentSchema.parse(await legacy.json()).code).toBe("STATEMENT_REVISED_SINCE");
    expect(await f.state()).toEqual(before);
    const fresh = await f.post(`${f.path}/reanchor`, f.request, "header-reanchor", {
      "asimp-client-context-cursor": String(inspected.seq),
    });
    expect(fresh.status, await fresh.clone().text()).toBe(200);
    expect(ClaimReanchorResponseSchema.parse(await fresh.json()).statement_version).toBe(
      inspected.version,
    );
  });

  test("an explicit stale body takes precedence over a newer context header", async () => {
    const f = await reanchorFixture();
    const earlier = await f.revision();
    const later = await f.revision();
    const before = await f.state();
    const response = await f.post(
      `${f.path}/reanchor`,
      { ...f.request, client_context_cursor: earlier.seq },
      "conflicting-context",
      { "asimp-client-context-cursor": String(later.seq) },
    );
    expect(response.status, await response.clone().text()).toBe(409);
    const refusal = ProblemDocumentSchema.parse(await response.json());
    if (refusal.code !== "STATEMENT_REVISED_SINCE" || !("client_context_cursor" in refusal))
      throw new Error("Expected a statement-context refusal carrying the inspected cursor");
    expect(refusal.client_context_cursor).toBe(earlier.seq);
    expect(await f.state()).toEqual(before);
  });

  test("invalid and future header cursors are refused without a ledger write", async () => {
    const f = await reanchorFixture();
    const before = await f.state();
    for (const cursor of ["-1", "1.5", "NaN", "9007199254740992", "1000"]) {
      const response = await f.post(`${f.path}/reanchor`, f.request, undefined, {
        "asimp-client-context-cursor": cursor,
      });
      expect(response.status, await response.clone().text()).toBe(400);
      expect(ProblemDocumentSchema.parse(await response.json()).code).toBe("SCHEMA_INVALID");
      expect(await f.state()).toEqual(before);
    }
  });

  for (const point of ["after-context-read", "before-commit"] as const)
    test(`a revision ${point} rolls back the re-anchor and permits a fresh retry`, async () => {
      const f = await reanchorFixture();
      const inspected = await f.revision();
      f.arm(point);
      const response = await f.post(`${f.path}/reanchor`, {
        ...f.request,
        client_context_cursor: inspected.seq,
      });
      const raced = f.race();
      expect(response.status, await response.clone().text()).toBe(409);
      expect(ProblemDocumentSchema.parse(await response.json())).toMatchObject({
        code: "STATEMENT_REVISED_SINCE",
        client_context_cursor: inspected.seq,
        revised_at_cursor: raced.seq,
      });
      expect(await f.state()).toEqual({
        public_seq: raced.seq,
        current_statement_version: raced.version,
        statement_version: 1,
        statement_drift: 1,
        reanchors: 0,
        receipts: 0,
      });
      const recovered = await f.post(`${f.path}/reanchor`, {
        ...f.request,
        client_context_cursor: raced.seq,
      });
      expect(recovered.status, await recovered.clone().text()).toBe(200);
      expect(ClaimReanchorResponseSchema.parse(await recovered.json()).statement_version).toBe(
        raced.version,
      );
      expect(await f.state()).toMatchObject({ reanchors: 1, receipts: 1, statement_drift: 0 });
    });
});
