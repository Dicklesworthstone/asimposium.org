import { describe, expect, test } from "bun:test";
import {
  ProblemDocumentSchema,
  PromoteResponseSchema,
  SessionOpenResponseSchema,
  WorkshopPushResponseSchema,
} from "@asimposium/contracts";
import { writeLedgerEvent } from "../../src/krater/krater.ts";
import { normHash, sha256Hex } from "../../src/split/policy.ts";
import { addApprovedFellow, fixture } from "./session-routes.test.ts";

type RacePoint = "after-admission" | "before-screening" | "before-commit";

async function statementRaceFixture() {
  let armed: RacePoint | undefined;
  let ready = false;
  let revisionSequence: number | undefined;
  let statementVersion = 1;
  let screenings = 0;
  const f = await fixture({
    afterRead: async (read) => {
      if (
        armed === "before-screening" &&
        read.kind === "run" &&
        read.sql.includes("INSERT INTO public_write_attempt_reservations")
      )
        ready = true;
      if (
        armed !== "after-admission" ||
        read.kind !== "first" ||
        !read.sql.startsWith("SELECT seq, object_version FROM events")
      )
        return;
      armed = undefined;
      revisionSequence = (await appendStatement()).seq;
    },
    beforeBatch: async () => {
      if (!armed || !ready) return;
      armed = undefined;
      ready = false;
      revisionSequence = (await appendStatement()).seq;
    },
    screenPromotion: async () => {
      screenings++;
      if (armed === "before-commit") ready = true;
      return { decision: "pass", coarse_category: "benign-context", provider_status: "ok" };
    },
  });
  async function appendStatement() {
    const version = ++statementVersion;
    const createdAt = new Date().toISOString();
    const statement = `For every even integer n in 0..${version * 10}, n squared is even.`;
    const falsifier = "An even integer with an odd square.";
    const motivation = "Bound the problem's domain before admitting another result.";
    const problem = await f.db
      .prepare("SELECT title FROM problems WHERE id = 'P-4DSP'")
      .first<{ title: string }>();
    if (!problem) throw new Error("Missing fixture problem");
    const payloadJson = JSON.stringify({
      action: "revise-statement",
      acting_principal: { type: "sponsor", id: f.binding.sponsorId },
      source_fellow_id: f.binding.fellowId,
      previous_statement_version: version - 1,
      previous_status: "active",
      problem: {
        id: "P-4DSP",
        title: problem.title,
        status: "active",
        current_statement_version: version,
        statement,
        falsifier,
        motivation,
        updated_at: createdAt,
      },
    });
    const hash = `sha256:${await normHash(statement)}`;
    return writeLedgerEvent(
      f.db,
      {
        problemId: "P-4DSP",
        eventId: `E-statement-context-race-${version}`,
        idempotencyKey: `statement-context-race-${version}`,
        requestDigest: await sha256Hex(payloadJson),
        eventType: "problem.statement-revised",
        objectKind: "problem",
        objectId: "P-4DSP",
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
            VALUES ('P-4DSP', ?, ?, ?, ?, ?, ?)`)
            .bind(version, statement, hash, falsifier, motivation, createdAt),
          f.db
            .prepare("UPDATE problems SET current_statement_version = ? WHERE id = 'P-4DSP'")
            .bind(version),
        ],
      },
    );
  }
  let key = 0;
  const post = (
    path: string,
    body: unknown,
    requestKey = `context-race-${++key}`,
    headers: Record<string, string> = {},
    caller = f.call,
  ) =>
    caller(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": requestKey, ...headers },
      body: JSON.stringify(body),
    });
  const opened = await post("/v1/sessions", { problem_id: "P-4DSP" });
  expect(opened.status).toBe(201);
  const session = SessionOpenResponseSchema.parse(await opened.json());
  const path = `/v1/sessions/${session.session_id}`;
  const draft = async (publication?: unknown) => {
    const saved = await post(`${path}/workshop`, {
      type: "claim-draft",
      title: "Original statement draft",
      body_md: "Private working notes.",
      ...(publication === undefined ? {} : { publication }),
    });
    expect(saved.status, await saved.clone().text()).toBe(201);
    return WorkshopPushResponseSchema.parse(await saved.json());
  };
  const expectRefusal = async (response: Response, cursor = 0) => {
    expect(armed).toBeUndefined();
    expect(revisionSequence).toBeGreaterThan(0);
    expect(response.status, await response.clone().text()).toBe(409);
    expect(ProblemDocumentSchema.parse(await response.json())).toMatchObject({
      code: "STATEMENT_REVISED_SINCE",
      revised_at_cursor: revisionSequence,
      client_context_cursor: cursor,
    });
    expect(
      await f.db.prepare("SELECT public_seq FROM problems WHERE id = 'P-4DSP'").first(),
    ).toEqual({
      public_seq: revisionSequence,
    });
  };
  const count = async (table: "claims" | "claim_versions" | "reviews" | "hypotheses") => {
    const row = await f.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE problem_id = 'P-4DSP'`)
      .first<{ n: number }>();
    if (!row) throw new Error("Missing fixture count");
    return row.n;
  };
  return {
    ...f,
    post,
    session,
    path,
    draft,
    count,
    appendStatement,
    expectRefusal,
    arm: (point: RacePoint) => {
      armed = point;
      ready = false;
    },
    screenings: () => screenings,
    revisionSequence: () => {
      if (revisionSequence === undefined) throw new Error("Statement race did not run");
      return revisionSequence;
    },
  };
}

const claim = {
  kind: "conjecture",
  statement: "Odd integers have odd squares.",
  falsifier: "An odd integer with an even square.",
};

describe("statement context race", () => {
  for (const point of ["after-admission", "before-screening", "before-commit"] as const) {
    test(`promotion refuses ${point}, rolls back, and recovers using a fresh cursor`, async () => {
      const f = await statementRaceFixture();
      const draft = await f.draft();
      f.arm(point);
      await f.expectRefusal(
        await f.post(`${f.path}/promote`, {
          workshop_id: draft.workshop_id,
          ...claim,
          client_context_cursor: 0,
        }),
      );
      expect(await f.count("claims")).toBe(0);
      expect(
        await f.db
          .prepare("SELECT COUNT(*) AS n FROM session_write_replays WHERE scope = 'promote'")
          .first(),
      ).toEqual({ n: 0 });
      if (point !== "after-admission") {
        expect(f.screenings()).toBe(1);
        expect(
          await f.db.prepare("SELECT status FROM public_write_attempt_reservations").all(),
        ).toMatchObject({ results: [{ status: "settled_failed" }] });
      }
      const recoveredBody = {
        workshop_id: draft.workshop_id,
        ...claim,
        statement: "Every even integer in the bounded domain has an even square.",
        client_context_cursor: f.revisionSequence(),
      };
      const recovered = await f.post(`${f.path}/promote`, recoveredBody, "refreshed-promotion");
      expect(recovered.status, await recovered.clone().text()).toBe(201);
      const bytes = await recovered.text();
      expect(PromoteResponseSchema.parse(JSON.parse(bytes)).version).toBe(1);
      const screens = f.screenings();
      await f.appendStatement();
      const replay = await f.post(`${f.path}/promote`, recoveredBody, "refreshed-promotion");
      expect(replay.status).toBe(200);
      expect(await replay.text()).toBe(bytes);
      expect(f.screenings()).toBe(screens);
      expect(await f.count("claims")).toBe(1);
    });
  }

  test("session-open fallback and header cursor both remain bound through publication", async () => {
    for (const header of [false, true]) {
      const f = await statementRaceFixture();
      const draft = await f.draft();
      f.arm("before-screening");
      await f.expectRefusal(
        await f.post(
          `${f.path}/promote`,
          {
            workshop_id: draft.workshop_id,
            ...claim,
          },
          undefined,
          header ? { "asimp-client-context-cursor": "0" } : {},
        ),
      );
      expect(await f.count("claims")).toBe(0);
    }
  });

  test("malformed header cursors refuse before consuming publication capacity", async () => {
    const f = await statementRaceFixture();
    const draft = await f.draft();
    for (const value of ["not-a-cursor", "Infinity", "-1", "0.5", "9007199254740992"]) {
      const response = await f.post(
        `${f.path}/promote`,
        {
          workshop_id: draft.workshop_id,
          ...claim,
        },
        undefined,
        { "asimp-client-context-cursor": value },
      );
      expect(response.status, await response.clone().text()).toBe(400);
      expect(ProblemDocumentSchema.parse(await response.json()).code).toBe("SCHEMA_INVALID");
    }
    expect(f.screenings()).toBe(0);
    expect(await f.count("claims")).toBe(0);
    expect(
      await f.db.prepare("SELECT COUNT(*) AS n FROM public_write_attempt_reservations").first(),
    ).toEqual({ n: 0 });
  });

  test("direct append keeps its original cursor despite opening an implicit session", async () => {
    const f = await statementRaceFixture();
    await f.post(`${f.path}/close`, { handback: "Continue through a direct append." });
    f.arm("after-admission");
    await f.expectRefusal(
      await f.post("/v1/p/P-4DSP/claims", { ...claim, client_context_cursor: 0 }),
    );
    expect(await f.count("claims")).toBe(0);
    expect(
      await f.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE closed_at IS NULL").first(),
    ).toEqual({ n: 0 });
  });

  test("claim replacement and independent review cannot adopt a newer screening formulation", async () => {
    for (const operation of ["revise", "review"] as const) {
      const f = await statementRaceFixture();
      const draft = await f.draft();
      const created = await f.post(`${f.path}/promote`, {
        workshop_id: draft.workshop_id,
        ...claim,
      });
      expect(created.status, await created.clone().text()).toBe(201);
      const published = PromoteResponseSchema.parse(await created.json());
      let submit: () => Promise<Response>;
      if (operation === "revise") {
        submit = () =>
          f.post(`${f.path}/revise`, {
            ...claim,
            claim_id: published.claim_id,
            base_version: 1,
            statement: "Every positive odd integer has an odd square.",
            client_context_cursor: published.seq,
          });
      } else {
        const reviewer = await addApprovedFellow(f, {
          suffix: "statement-race-reviewer",
          scopes: ["review"],
          sponsor: { type: "sponsor", sponsorId: "usr_statement_race_reviewer" },
        });
        const opened = await f.post(
          "/v1/sessions",
          { problem_id: "P-4DSP", intent: "review" },
          undefined,
          {},
          reviewer.call,
        );
        const session = SessionOpenResponseSchema.parse(await opened.json());
        submit = () =>
          f.post(
            `/v1/sessions/${session.session_id}/review`,
            {
              target_claim_id: published.claim_id,
              target_version: 1,
              verdict: "inform",
              basis: "Checked both parity residues.",
              capable_of_failure: "A contrary residue refutes the claim.",
              body_md: "The finite calculation covers both residues.",
              client_context_cursor: published.seq,
            },
            undefined,
            {},
            reviewer.call,
          );
      }
      f.arm("before-screening");
      await f.expectRefusal(await submit(), published.seq);
      expect(await f.count("claim_versions")).toBe(1);
      expect(await f.count("reviews")).toBe(0);
    }
  });

  test("atomic batch refuses every member when its claim context becomes obsolete", async () => {
    const f = await statementRaceFixture();
    f.arm("after-admission");
    await f.expectRefusal(
      await f.post("/v1/p/P-4DSP/events:batch", {
        members: [
          {
            tempId: "tmp:claim",
            action: "claim",
            causedBy: [],
            data: { ...claim, client_context_cursor: 0 },
          },
          {
            tempId: "tmp:route",
            action: "hypothesis",
            causedBy: [],
            data: {
              route: "Inspect parity residues.",
              mechanism: "Squaring preserves both residues.",
              falsifier: "A changed residue.",
              origin: "proposed",
              body_md: "Check the two exhaustive cases.",
            },
          },
        ],
      }),
    );
    expect(await f.count("claims")).toBe(0);
    expect(await f.count("hypotheses")).toBe(0);
    expect(
      await f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM session_write_replays WHERE scope IN ('promote', 'hypotheses')",
        )
        .first(),
    ).toEqual({ n: 0 });
  });

  test("singleton, multi-member and direct claims share context admission on an already revised problem", async () => {
    for (const mode of ["direct", "singleton", "multi"] as const) {
      const f = await statementRaceFixture();
      const closed = await f.post(`${f.path}/close`, {
        handback: "Resume through a convenience write.",
      });
      expect(closed.status).toBe(201);
      const revision = await f.appendStatement();
      const body =
        mode === "direct"
          ? claim
          : {
              members: [
                { tempId: "tmp:claim", action: "claim", causedBy: [], data: claim },
                ...(mode === "singleton"
                  ? []
                  : [
                      {
                        tempId: "tmp:route",
                        action: "hypothesis",
                        causedBy: [],
                        data: {
                          route: "Inspect parity residues.",
                          mechanism: "Squaring preserves both residues.",
                          falsifier: "A changed residue.",
                          origin: "proposed",
                          body_md: "Check the two exhaustive cases.",
                        },
                      },
                    ]),
              ],
            };
      const route = mode === "direct" ? "/v1/p/P-4DSP/claims" : "/v1/p/P-4DSP/events:batch";
      const missing = await f.post(route, body);
      expect(missing.status, `${mode}: ${await missing.clone().text()}`).toBe(409);
      expect(ProblemDocumentSchema.parse(await missing.json())).toMatchObject({
        code: "STATEMENT_REVISED_SINCE",
        revised_at_cursor: revision.seq,
        client_context_cursor: 0,
      });
      const malformed = await f.post(route, body, undefined, {
        "asimp-client-context-cursor": "not-a-cursor",
      });
      expect(malformed.status, `${mode}: ${await malformed.clone().text()}`).toBe(400);
      expect(ProblemDocumentSchema.parse(await malformed.json()).code).toBe("SCHEMA_INVALID");
      expect(f.screenings()).toBe(0);
      expect(await f.count("claims")).toBe(0);
      expect(
        await f.db.prepare("SELECT COUNT(*) AS n FROM public_write_attempt_reservations").first(),
      ).toEqual({ n: 0 });
      expect(
        await f.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE closed_at IS NULL").first(),
      ).toEqual({ n: 0 });
      const fresh = await f.post(route, body, undefined, {
        "asimp-client-context-cursor": String(revision.seq),
      });
      expect(fresh.status, `${mode}: ${await fresh.clone().text()}`).toBe(201);
      expect(await f.count("claims")).toBe(1);
    }
  });

  test("close-with-promotion retains the private draft and open session after context changes", async () => {
    const f = await statementRaceFixture();
    const draft = await f.draft({ ...claim, client_context_cursor: 0 });
    f.arm("after-admission");
    await f.expectRefusal(
      await f.post(`${f.path}/close`, {
        handback: "Publish this claim and close the work.",
        promote: [draft.workshop_id],
      }),
    );
    expect(await f.count("claims")).toBe(0);
    expect(
      await f.db
        .prepare("SELECT closed_at, handback FROM sessions WHERE session_id = ?")
        .bind(f.session.session_id)
        .first(),
    ).toEqual({ closed_at: null, handback: null });
    expect(
      await f.db
        .prepare("SELECT state FROM workshop_objects WHERE workshop_id = ?")
        .bind(draft.workshop_id)
        .first(),
    ).toEqual({ state: "open" });
  });
});
