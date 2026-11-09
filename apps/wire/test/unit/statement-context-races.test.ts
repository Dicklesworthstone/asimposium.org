import { describe, expect, test } from "bun:test";
import {
  ProblemDocumentSchema,
  ProblemGovernanceEventSchema,
  PromoteResponseSchema,
  SessionOpenResponseSchema,
  WorkshopPushResponseSchema,
} from "@asimposium/contracts";
import { writeLedgerEvent } from "../../src/krater/krater.ts";
import { normHash, sha256Hex } from "../../src/split/policy.ts";
import { addApprovedFellow, fixture } from "./session-routes.test.ts";

type RacePoint = "after-admission" | "before-screening" | "before-commit" | "before-session-open";

async function statementRaceFixture() {
  let armed: RacePoint | undefined;
  let revisionCreatedAt: string | undefined;
  let ready = false;
  let revisionSequence: number | undefined;
  let statementVersion = 1;
  let screenings = 0;
  let failImplicitSessionRead = false;
  const f = await fixture({
    beforeRead: async (read) => {
      if (
        failImplicitSessionRead &&
        read.kind === "first" &&
        read.sql === "SELECT * FROM sessions WHERE session_id = ?"
      ) {
        failImplicitSessionRead = false;
        throw new Error("Injected implicit session readback failure");
      }
    },
    afterRead: async (read) => {
      if (
        armed === "before-session-open" &&
        read.kind === "first" &&
        read.sql.includes("FROM sessions") &&
        read.sql.includes("closed_at IS NULL")
      )
        ready = true;
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
      revisionSequence = (await appendStatement(revisionCreatedAt)).seq;
    },
    beforeBatch: async () => {
      if (!armed || !ready) return;
      armed = undefined;
      ready = false;
      revisionSequence = (await appendStatement(revisionCreatedAt)).seq;
    },
    screenPromotion: async () => {
      screenings++;
      if (armed === "before-commit") ready = true;
      return { decision: "pass", coarse_category: "benign-context", provider_status: "ok" };
    },
  });
  await f.db
    .prepare(
      "UPDATE problems SET title = 'Parity under bounded statement revisions' WHERE id = 'P-4DSP'",
    )
    .run();
  async function appendStatement(createdAt = new Date().toISOString()) {
    const version = ++statementVersion;
    const statement = `For every even integer n in 0..${version * 10}, n squared is even.`;
    const falsifier = "An even integer with an odd square.";
    const motivation = "Bound the problem's domain before admitting another result.";
    const problem = await f.db
      .prepare("SELECT title FROM problems WHERE id = 'P-4DSP'")
      .first<{ title: string }>();
    if (!problem) throw new Error("Missing fixture problem");
    const scientificAuthor = {
      fellow_id: f.binding.fellowId,
      sponsor_id: f.binding.sponsorId,
      session_id: session.session_id,
      model_self_declared: f.binding.model,
      harness: f.binding.harness,
    };
    const payloadJson = JSON.stringify(
      ProblemGovernanceEventSchema.parse({
        action: "revise-statement",
        acting_principal: { type: "sponsor", id: f.binding.sponsorId },
        source_fellow_id: f.binding.fellowId,
        scientific_author: scientificAuthor,
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
      }),
    );
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
            (problem_id, version, statement, norm_hash, falsifier, motivation, created_at, scientific_author_json)
            VALUES ('P-4DSP', ?, ?, ?, ?, ?, ?, ?)`)
            .bind(
              version,
              statement,
              hash,
              falsifier,
              motivation,
              createdAt,
              JSON.stringify(scientificAuthor),
            ),
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
  const draft = async (publication?: unknown, sessionId = session.session_id) => {
    const saved = await post(`/v1/sessions/${sessionId}/workshop`, {
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
    if (revisionSequence === undefined) throw new Error("Statement race did not run");
    expect(response.status, await response.clone().text()).toBe(409);
    expect(ProblemDocumentSchema.parse(await response.json())).toMatchObject({
      code: "STATEMENT_REVISED_SINCE",
      revised_at_cursor: revisionSequence,
      client_context_cursor: cursor,
    });
    expect(
      await f.db
        .prepare("SELECT public_seq FROM problems WHERE id = 'P-4DSP'")
        .first<{ public_seq: number }>(),
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
    arm: (point: RacePoint, createdAt?: string) => {
      armed = point;
      revisionCreatedAt = createdAt;
      ready = false;
    },
    screenings: () => screenings,
    failImplicitSessionRead: () => {
      failImplicitSessionRead = true;
    },
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
          .first<{ n: number }>(),
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

  test("backdated revisions committed after session open invalidate its durable context", async () => {
    for (const point of ["after-admission", "before-screening", "before-commit"] as const) {
      const f = await statementRaceFixture();
      const draft = await f.draft();
      const backdated = new Date(Date.parse(f.session.opened_at) - 60_000).toISOString();
      f.arm(point, backdated);
      await f.expectRefusal(
        await f.post(`${f.path}/promote`, { workshop_id: draft.workshop_id, ...claim }),
      );
      expect(await f.count("claims")).toBe(0);
      expect(
        await f.db
          .prepare("SELECT opened_public_cursor FROM sessions WHERE session_id = ?")
          .bind(f.session.session_id)
          .first<{ opened_public_cursor: number | null }>(),
      ).toEqual({ opened_public_cursor: 0 });
      expect(
        await f.db
          .prepare("SELECT created_at FROM events WHERE type = 'problem.statement-revised'")
          .first<{ created_at: string }>(),
      ).toEqual({ created_at: backdated });
    }
  });

  test("explicit and implicit session inserts capture the committed head atomically", async () => {
    for (const mode of ["explicit", "implicit"] as const) {
      const f = await statementRaceFixture();
      await f.post(`${f.path}/close`, { handback: "Continue with a new session." });
      const backdated = new Date(Date.parse(f.session.opened_at) - 60_000).toISOString();
      f.arm("before-session-open", backdated);
      const opened = await f.post(
        mode === "explicit" ? "/v1/sessions" : "/v1/p/P-4DSP/hypotheses",
        mode === "explicit"
          ? { problem_id: "P-4DSP" }
          : {
              route: "Inspect parity residues.",
              mechanism: "Squaring preserves both residues.",
              falsifier: "A changed residue.",
              origin: "proposed",
              body_md: "Check the two exhaustive cases.",
            },
      );
      expect(opened.status, await opened.clone().text()).toBe(201);
      const stored = await f.db
        .prepare("SELECT session_id, opened_public_cursor FROM sessions WHERE session_id <> ?")
        .bind(f.session.session_id)
        .first<{ session_id: string; opened_public_cursor: number }>();
      expect(stored?.opened_public_cursor).toBe(f.revisionSequence());
      if (!stored) throw new Error("Missing new session");
      if (mode === "implicit") {
        expect(
          await f.db
            .prepare("SELECT public_seq FROM problems WHERE id = 'P-4DSP'")
            .first<{ public_seq: number }>(),
        ).toEqual({ public_seq: stored.opened_public_cursor + 1 });
        continue;
      }

      const draft = await f.draft(undefined, stored.session_id);
      const path = `/v1/sessions/${stored.session_id}/promote`;
      const body = { workshop_id: draft.workshop_id, ...claim };
      const published = await f.post(path, body, "opened-after-revision");
      expect(published.status, await published.clone().text()).toBe(201);
      const bytes = await published.text();
      const screens = f.screenings();
      await f.appendStatement(backdated);
      const replay = await f.post(path, body, "opened-after-revision");
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(await replay.text()).toBe(bytes);
      expect(f.screenings()).toBe(screens);
      expect(await f.count("claims")).toBe(1);
    }
  });

  test("legacy sessions fail closed after any revision while successful receipts still replay", async () => {
    for (const revised of [false, true]) {
      const f = await statementRaceFixture();
      await f.post(`${f.path}/close`, { handback: "Continue an older session." });
      const backdated = new Date(Date.parse(f.session.opened_at) - 60_000).toISOString();
      const revision = revised ? await f.appendStatement(backdated) : undefined;
      const sessionId = "S-legacy-statement-context";
      const openedAt = new Date().toISOString();
      await f.db
        .prepare(`INSERT INTO sessions
          (session_id, fellow_id, problem_id, opened_at, last_heartbeat_at, idle_close_at)
          VALUES (?, ?, 'P-4DSP', ?, ?, ?)`)
        .bind(
          sessionId,
          f.binding.fellowId,
          openedAt,
          openedAt,
          new Date(Date.now() + 30 * 60_000).toISOString(),
        )
        .run();
      const draft = await f.draft(undefined, sessionId);
      const path = `/v1/sessions/${sessionId}/promote`;
      const body = { workshop_id: draft.workshop_id, ...claim };
      const result = await f.post(path, body, "legacy-context");
      expect(result.status, await result.clone().text()).toBe(revised ? 409 : 201);
      if (revision) {
        expect(ProblemDocumentSchema.parse(await result.json())).toMatchObject({
          code: "STATEMENT_REVISED_SINCE",
          revised_at_cursor: revision.seq,
          client_context_cursor: 0,
        });
        expect(f.screenings()).toBe(0);
        const recovered = await f.post(path, {
          ...body,
          client_context_cursor: revision.seq,
        });
        expect(recovered.status, await recovered.clone().text()).toBe(201);
      } else {
        const bytes = await result.text();
        const screens = f.screenings();
        await f.appendStatement(backdated);
        const replay = await f.post(path, body, "legacy-context");
        expect(replay.status).toBe(200);
        expect(await replay.text()).toBe(bytes);
        expect(f.screenings()).toBe(screens);
      }
      await expect(
        f.db
          .prepare("UPDATE sessions SET opened_public_cursor = 0 WHERE session_id = ?")
          .bind(sessionId)
          .run(),
      ).rejects.toThrow("SESSION_OPENED_PUBLIC_CURSOR_IMMUTABLE");
      expect(
        await f.db
          .prepare("SELECT opened_public_cursor FROM sessions WHERE session_id = ?")
          .bind(sessionId)
          .first<{ opened_public_cursor: number | null }>(),
      ).toEqual({ opened_public_cursor: null });
    }
  });

  test("a captured session cursor cannot be changed or erased", async () => {
    const f = await statementRaceFixture();
    for (const cursor of [null, 1]) {
      await expect(
        f.db
          .prepare("UPDATE sessions SET opened_public_cursor = ? WHERE session_id = ?")
          .bind(cursor, f.session.session_id)
          .run(),
      ).rejects.toThrow("SESSION_OPENED_PUBLIC_CURSOR_IMMUTABLE");
    }
    expect(
      await f.db
        .prepare("SELECT opened_public_cursor FROM sessions WHERE session_id = ?")
        .bind(f.session.session_id)
        .first<{ opened_public_cursor: number | null }>(),
    ).toEqual({ opened_public_cursor: 0 });
  });

  test("implicit session readback failure releases the committed session slot", async () => {
    const f = await statementRaceFixture();
    await f.post(`${f.path}/close`, { handback: "Continue through a convenience write." });
    f.failImplicitSessionRead();
    const response = await f.post("/v1/p/P-4DSP/hypotheses", {
      route: "Inspect parity residues.",
      mechanism: "Squaring preserves both residues.",
      falsifier: "A changed residue.",
      origin: "proposed",
      body_md: "Check the two exhaustive cases.",
    });
    expect(response.status, await response.clone().text()).toBe(500);
    const implicit = await f.db
      .prepare(`SELECT closed_at, implicit_inflight, opened_public_cursor FROM sessions
        WHERE session_id <> ?`)
      .bind(f.session.session_id)
      .first<{
        closed_at: string | null;
        implicit_inflight: number;
        opened_public_cursor: number;
      }>();
    expect(implicit).toMatchObject({ implicit_inflight: 0, opened_public_cursor: 0 });
    expect(implicit?.closed_at).toBeString();
    expect(
      await f.db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE closed_at IS NULL")
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    expect(await f.count("hypotheses")).toBe(0);
    expect(f.screenings()).toBe(0);
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
      await f.db
        .prepare("SELECT COUNT(*) AS n FROM public_write_attempt_reservations")
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  test("future body and header cursors refuse before publication on every claim entry point", async () => {
    for (const mode of ["session", "direct", "singleton", "multi"] as const) {
      const f = await statementRaceFixture();
      const draft = mode === "session" ? await f.draft() : undefined;
      if (mode !== "session")
        await f.post(`${f.path}/close`, { handback: "Use the direct publication surface." });
      for (const revised of [false, true]) {
        if (revised) await f.appendStatement();
        const head = await f.db
          .prepare("SELECT public_seq FROM problems WHERE id = 'P-4DSP'")
          .first<{ public_seq: number }>();
        if (!head) throw new Error("Missing fixture problem");
        const before = await f.db
          .prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = 'P-4DSP'")
          .first<{ n: number }>();
        for (const cursor of [head.public_seq + 1, Number.MAX_SAFE_INTEGER]) {
          for (const transport of ["body", "header"] as const) {
            const data = {
              ...claim,
              ...(draft === undefined ? {} : { workshop_id: draft.workshop_id }),
              ...(transport === "body" ? { client_context_cursor: cursor } : {}),
            };
            const body =
              mode === "session" || mode === "direct"
                ? data
                : {
                    members: [
                      { tempId: "tmp:claim", action: "claim", causedBy: [], data },
                      ...(mode === "multi"
                        ? [
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
                          ]
                        : []),
                    ],
                  };
            const route =
              mode === "session"
                ? `${f.path}/promote`
                : mode === "direct"
                  ? "/v1/p/P-4DSP/claims"
                  : "/v1/p/P-4DSP/events:batch";
            const response = await f.post(
              route,
              body,
              undefined,
              transport === "header" ? { "asimp-client-context-cursor": String(cursor) } : {},
            );
            expect(response.status, `${mode}/${transport}: ${await response.clone().text()}`).toBe(
              400,
            );
            expect(ProblemDocumentSchema.parse(await response.json())).toMatchObject({
              code: "SCHEMA_INVALID",
              example: { client_context_cursor: head.public_seq },
            });
          }
        }
        expect(
          await f.db
            .prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = 'P-4DSP'")
            .first<{ n: number }>(),
        ).toEqual(before);
        expect(await f.count("claims")).toBe(0);
        expect(await f.count("hypotheses")).toBe(0);
        expect(f.screenings()).toBe(0);
        expect(
          await f.db
            .prepare("SELECT COUNT(*) AS n FROM public_write_attempt_reservations")
            .first<{ n: number }>(),
        ).toEqual({ n: 0 });
        expect(
          await f.db
            .prepare("SELECT COUNT(*) AS n FROM sessions WHERE closed_at IS NULL")
            .first<{ n: number }>(),
        ).toEqual({ n: mode === "session" ? 1 : 0 });
        expect(
          await f.db
            .prepare("SELECT COALESCE(SUM(implicit_inflight), 0) AS n FROM sessions")
            .first<{ n: number }>(),
        ).toEqual({ n: 0 });
      }
    }
  });

  test("future cursor diagnostics do not reveal another sponsor's private problem", async () => {
    const f = await statementRaceFixture();
    const unrelated = await addApprovedFellow(f, {
      suffix: "private-context-outsider",
      scopes: ["promote"],
      sponsor: { type: "sponsor", sponsorId: "usr_private_context_outsider" },
    });
    await f.db
      .prepare(
        "UPDATE problems SET status = 'private-draft', sponsor_id = ?, created_by_fellow_id = ? WHERE id = 'P-4DSP'",
      )
      .bind(f.binding.sponsorId, f.binding.fellowId)
      .run();

    for (const transport of ["body", "header"] as const) {
      for (const problemId of ["P-4DSP", "P-MISSING"]) {
        const response = await f.post(
          `/v1/p/${problemId}/claims`,
          {
            ...claim,
            ...(transport === "body" ? { client_context_cursor: Number.MAX_SAFE_INTEGER } : {}),
          },
          undefined,
          transport === "header"
            ? { "asimp-client-context-cursor": String(Number.MAX_SAFE_INTEGER) }
            : {},
          unrelated.call,
        );
        expect(response.status, `${problemId}/${transport}: ${await response.clone().text()}`).toBe(
          404,
        );
        const problem = ProblemDocumentSchema.parse(await response.json());
        expect(problem).toMatchObject({
          code: "PROBLEM_NOT_FOUND",
          title: "Problem not found",
          detail: `No problem with id '${problemId}' exists.`,
          example: { method: "GET", path: "/problems.json" },
        });
        expect(JSON.stringify(problem)).not.toContain("client_context_cursor");
      }
    }

    expect(
      await f.db
        .prepare("SELECT COUNT(*) AS n FROM public_write_attempt_reservations")
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });

    // The owner may reserve an attempt, but private content cannot supply
    // the verified public context required before screening or publication.
    const owner = await f.post("/v1/p/P-4DSP/claims", {
      ...claim,
      client_context_cursor: Number.MAX_SAFE_INTEGER,
    });
    expect(owner.status, await owner.clone().text()).toBe(503);
    expect(ProblemDocumentSchema.parse(await owner.json()).code).toBe(
      "SCREENING_CONTEXT_UNAVAILABLE",
    );
    expect(await f.count("claims")).toBe(0);
    expect(f.screenings()).toBe(0);
    expect(await f.db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>()).toEqual({
      n: 0,
    });
    expect(await f.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>()).toEqual(
      {
        n: 1,
      },
    );
    expect(
      (
        await f.db
          .prepare("SELECT fellow_id, status FROM public_write_attempt_reservations")
          .all<{ fellow_id: string; status: string }>()
      ).results,
    ).toEqual([{ fellow_id: f.binding.fellowId, status: "settled_failed" }]);
  });

  test("private publication during admission cannot admit a future statement cursor", async () => {
    for (const { cursor, transport } of [
      { cursor: 3, transport: "body" },
      { cursor: Number.MAX_SAFE_INTEGER, transport: "header" },
    ]) {
      let publishAfterHeadRead: (() => Promise<void>) | undefined;
      let claimScreenings = 0;
      const f = await fixture({
        afterRead: async (read) => {
          if (
            publishAfterHeadRead &&
            read.kind === "first" &&
            read.sql ===
              "SELECT public_seq FROM problems WHERE id = ? AND status <> 'private-draft'"
          ) {
            const publish = publishAfterHeadRead;
            publishAfterHeadRead = undefined;
            await publish();
          }
        },
        screenPromotion: async (input) => {
          if (input.kind === "conjecture") claimScreenings++;
          return { decision: "pass", coarse_category: "benign-context", provider_status: "ok" };
        },
      });
      const reviewer = await addApprovedFellow(f, {
        suffix: "publication-race-reviewer",
        scopes: ["review"],
        sponsor: { type: "sponsor", sponsorId: "usr_publication_race_reviewer" },
      });
      await f.db
        .prepare(
          "UPDATE problems SET status = 'private-draft', title = 'Parity publication race', sponsor_id = ?, created_by_fellow_id = ? WHERE id = 'P-4DSP'",
        )
        .bind(f.binding.sponsorId, f.binding.fellowId)
        .run();
      publishAfterHeadRead = async () => {
        const formulation = await f.db
          .prepare(`SELECT p.title, v.statement, v.falsifier, v.motivation
            FROM problems p JOIN problem_statement_versions v
              ON v.problem_id = p.id AND v.version = p.current_statement_version
            WHERE p.id = 'P-4DSP'`)
          .first<{ title: string; statement: string; falsifier: string; motivation: string }>();
        if (!formulation) throw new Error("Missing fixture formulation");
        const createdAt = new Date().toISOString();
        const payloadJson = JSON.stringify(
          ProblemGovernanceEventSchema.parse({
            action: "publish",
            acting_principal: { type: "sponsor", id: f.binding.sponsorId },
            source_fellow_id: f.binding.fellowId,
            scientific_author: {
              fellow_id: f.binding.fellowId,
              sponsor_id: f.binding.sponsorId,
              session_id: null,
              model_self_declared: f.binding.model,
              harness: f.binding.harness,
            },
            previous_statement_version: 1,
            previous_status: "private-draft",
            problem: {
              id: "P-4DSP",
              ...formulation,
              status: "sharpening",
              current_statement_version: 1,
              updated_at: createdAt,
            },
          }),
        );
        await writeLedgerEvent(
          f.db,
          {
            problemId: "P-4DSP",
            eventId: "E-context-publication-race",
            idempotencyKey: "context-publication-race",
            requestDigest: await sha256Hex(payloadJson),
            eventType: "problem.admitted",
            objectKind: "problem",
            objectId: "P-4DSP",
            objectVersion: 1,
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
              f.db.prepare(`UPDATE problems SET status = 'sharpening', admission_mode = 'open'
                WHERE id = 'P-4DSP' AND EXISTS (SELECT 1 FROM events WHERE id = 'E-context-publication-race')`),
            ],
          },
        );
        const opened = await reviewer.call("/v1/sessions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "publication-race-review-session",
          },
          body: JSON.stringify({ problem_id: "P-4DSP", intent: "review" }),
        });
        expect(opened.status, await opened.clone().text()).toBe(201);
        const session = SessionOpenResponseSchema.parse(await opened.json());
        const reviewed = await reviewer.call("/v1/problems/P-4DSP/statement-review", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "publication-race-statement-clear",
          },
          body: JSON.stringify({
            session_id: session.session_id,
            statement_version: 1,
            verdict: "statement-clear",
            basis: "The domain, parity claim, and falsifier are explicit.",
            client_context_cursor: 1,
          }),
        });
        expect(reviewed.status, await reviewed.clone().text()).toBe(200);
      };

      const response = await f.call("/v1/p/P-4DSP/claims", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "publication-race-claim",
          ...(transport === "header" ? { "asimp-client-context-cursor": String(cursor) } : {}),
        },
        body: JSON.stringify({
          ...claim,
          ...(transport === "body" ? { client_context_cursor: cursor } : {}),
        }),
      });
      expect(publishAfterHeadRead).toBeUndefined();
      expect(response.status, `${transport}/${cursor}: ${await response.clone().text()}`).toBe(400);
      expect(ProblemDocumentSchema.parse(await response.json())).toMatchObject({
        code: "SCHEMA_INVALID",
        example: { client_context_cursor: 2 },
      });
      expect(claimScreenings).toBe(1);
      expect(
        await f.db
          .prepare("SELECT status, public_seq FROM problems WHERE id = 'P-4DSP'")
          .first<{ status: string; public_seq: number }>(),
      ).toEqual({ status: "active", public_seq: 2 });
      for (const table of ["claims", "claim_versions"])
        expect(
          await f.db
            .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE problem_id = 'P-4DSP'`)
            .first<{ n: number }>(),
        ).toEqual({ n: 0 });
      expect(
        await f.db
          .prepare(`SELECT COUNT(*) AS n FROM screening_publications s
            JOIN events e ON e.id = s.event_id WHERE e.actor_fellow_id = ?`)
          .bind(f.binding.fellowId)
          .first<{ n: number }>(),
      ).toEqual({ n: 0 });
      expect(
        await f.db
          .prepare("SELECT COUNT(*) AS n FROM session_write_replays WHERE scope = 'promote'")
          .first<{ n: number }>(),
      ).toEqual({ n: 0 });
      expect(
        await f.db
          .prepare("SELECT status FROM public_write_attempt_reservations WHERE fellow_id = ?")
          .bind(f.binding.fellowId)
          .first<{ status: string }>(),
      ).toEqual({ status: "settled_failed" });
      const implicit = await f.db
        .prepare("SELECT closed_at, implicit_inflight FROM sessions WHERE fellow_id = ?")
        .bind(f.binding.fellowId)
        .first<{ closed_at: string | null; implicit_inflight: number }>();
      expect(implicit?.closed_at).toBeString();
      expect(implicit?.implicit_inflight).toBe(0);
    }
  });

  test("a valid completed receipt replays before later cursor validation", async () => {
    const f = await statementRaceFixture();
    const draft = await f.draft();
    const body = { ...claim, workshop_id: draft.workshop_id };
    const accepted = await f.post(`${f.path}/promote`, body, "valid-header-context", {
      "asimp-client-context-cursor": "0",
    });
    expect(accepted.status, await accepted.clone().text()).toBe(201);
    const bytes = await accepted.text();
    const screens = f.screenings();
    await f.appendStatement();
    const replay = await f.post(`${f.path}/promote`, body, "valid-header-context", {
      "asimp-client-context-cursor": String(Number.MAX_SAFE_INTEGER),
    });
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.text()).toBe(bytes);
    expect(f.screenings()).toBe(screens);
    expect(await f.count("claims")).toBe(1);
    expect(
      await f.db
        .prepare("SELECT COUNT(*) AS n FROM public_write_attempt_reservations")
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
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
      await f.db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE closed_at IS NULL")
        .first<{ n: number }>(),
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
        submit = async () =>
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
        submit = async () =>
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
        .first<{ n: number }>(),
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
        await f.db
          .prepare("SELECT COUNT(*) AS n FROM public_write_attempt_reservations")
          .first<{ n: number }>(),
      ).toEqual({ n: 0 });
      expect(
        await f.db
          .prepare("SELECT COUNT(*) AS n FROM sessions WHERE closed_at IS NULL")
          .first<{ n: number }>(),
      ).toEqual({ n: 0 });
      const fresh = await f.post(route, body, undefined, {
        "asimp-client-context-cursor": String(revision.seq),
      });
      expect(fresh.status, `${mode}: ${await fresh.clone().text()}`).toBe(201);
      expect(await f.count("claims")).toBe(1);
    }
  });

  test("convenience reviews and revisions cannot acquire context from an implicit session", async () => {
    for (const [operation, mode] of [
      ["review", "direct"],
      ["review", "singleton"],
      ["review", "multi"],
      ["revise", "singleton"],
      ["revise", "multi"],
    ] as const) {
      const f = await statementRaceFixture();
      const draft = await f.draft();
      const promoted = await f.post(`${f.path}/promote`, {
        ...claim,
        workshop_id: draft.workshop_id,
      });
      const published = PromoteResponseSchema.parse(await promoted.json());
      await f.post(`${f.path}/close`, { handback: "Continue through a convenience write." });
      const backdated = new Date(Date.parse(f.session.opened_at) - 60_000).toISOString();
      const revision = await f.appendStatement(backdated);
      const caller =
        operation === "review"
          ? (
              await addApprovedFellow(f, {
                suffix: `context-review-${mode}`,
                scopes: ["review", "promote"],
                sponsor: { type: "sponsor", sponsorId: "usr_convenience_context_reviewer" },
              })
            ).call
          : f.call;
      const data =
        operation === "review"
          ? {
              target_claim_id: published.claim_id,
              target_version: 1,
              verdict: "inform",
              basis: "Checked both parity residues.",
              capable_of_failure: "A contrary residue refutes the claim.",
              body_md: "The finite calculation covers both residues.",
            }
          : {
              ...claim,
              claim_id: published.claim_id,
              base_version: 1,
              statement: "Every positive odd integer has an odd square.",
            };
      const body =
        mode === "direct"
          ? data
          : {
              members: [
                { tempId: "tmp:write", action: operation, causedBy: [], data },
                ...(mode === "multi"
                  ? [
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
                    ]
                  : []),
              ],
            };
      const route = mode === "direct" ? "/v1/p/P-4DSP/reviews" : "/v1/p/P-4DSP/events:batch";
      const screensBefore = f.screenings();
      const missing = await f.post(route, body, undefined, {}, caller);
      expect(missing.status, `${operation}/${mode}: ${await missing.clone().text()}`).toBe(409);
      expect(ProblemDocumentSchema.parse(await missing.json())).toMatchObject({
        code: "STATEMENT_REVISED_SINCE",
        revised_at_cursor: revision.seq,
        client_context_cursor: 0,
      });
      const malformed = await f.post(
        route,
        body,
        undefined,
        {
          "asimp-client-context-cursor": "not-a-cursor",
        },
        caller,
      );
      expect(malformed.status, await malformed.clone().text()).toBe(400);
      expect(f.screenings()).toBe(screensBefore);
      expect(await f.count("claim_versions")).toBe(1);
      expect(await f.count("reviews")).toBe(0);
      expect(await f.count("hypotheses")).toBe(0);
      expect(
        await f.db
          .prepare("SELECT COUNT(*) AS n FROM sessions WHERE closed_at IS NULL")
          .first<{ n: number }>(),
      ).toEqual({ n: 0 });
      const headers = { "asimp-client-context-cursor": String(revision.seq) };
      const accepted = await f.post(route, body, "convenience-current", headers, caller);
      expect(accepted.status, `${operation}/${mode}: ${await accepted.clone().text()}`).toBe(201);
      const bytes = await accepted.text();
      const screensAfter = f.screenings();
      await f.appendStatement(backdated);
      const replay = await f.post(route, body, "convenience-current", headers, caller);
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(await replay.text()).toBe(bytes);
      expect(f.screenings()).toBe(screensAfter);
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
        .first<{ closed_at: string | null; handback: string | null }>(),
    ).toEqual({ closed_at: null, handback: null });
    expect(
      await f.db
        .prepare("SELECT state FROM workshop_objects WHERE workshop_id = ?")
        .bind(draft.workshop_id)
        .first<{ state: string }>(),
    ).toEqual({ state: "open" });
  });
});
