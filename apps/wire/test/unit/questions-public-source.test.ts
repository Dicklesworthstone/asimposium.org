import { afterEach, expect, test } from "bun:test";
import {
  AdminContentControlResponseSchema,
  AskQuestionRequestSchema,
  ProblemDocumentSchema,
  QuestionsListResponseSchema,
} from "@asimposium/contracts";
import type { Env } from "../../src/env.ts";
import { sha256Hex, writeLedgerEvent } from "../../src/krater/krater.ts";
import { loadProblemQuestions, validateQuestionSubstance } from "../../src/ledger/questions.ts";
import { createLedgerFaceRoutes } from "../../src/ledger-face.ts";
import { operatorContentControl } from "../../src/moderation/operator-http.ts";
import {
  directiveDisclosureFixture,
  DISCLOSURE_PROBLEM as problemId,
  DISCLOSURE_SPONSOR as sponsorId,
} from "../support/directive-disclosure.ts";

type Fixture = Awaited<ReturnType<typeof directiveDisclosureFixture>>;
const fixtures: Fixture[] = [];
const body = "Which finite boundary case decides the stated conjecture?";
const formats = ["json", "md", "html"] as const;
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});

// All shipped migrations, actual legal enrollment and the atomic ledger
// writer. Payloads model admitted questions; HTTP write admission is separate.
async function fixture() {
  const f = await directiveDisclosureFixture();
  fixtures.push(f);
  return f;
}
async function publish(
  f: Fixture,
  questionId = "Q-1",
  type = "question.asked",
  extra: Record<string, unknown> = {},
) {
  const payload =
    type === "question.asked"
      ? {
          question_id: questionId,
          problem_id: problemId,
          target_refs: ["C-1@1"],
          blocking: "C-1@1",
          body_md: body,
          ...extra,
        }
      : { question_id: questionId, ...extra };
  const payloadJson = JSON.stringify(payload),
    createdAt = new Date().toISOString();
  const eventId = `E-question-${crypto.randomUUID()}`;
  return writeLedgerEvent(
    f.db,
    {
      problemId,
      eventId,
      idempotencyKey: eventId,
      requestDigest: await sha256Hex(payloadJson),
      eventType: type,
      objectKind: "question",
      objectId: questionId,
      objectVersion: 1,
      payloadJson,
      createdAt,
      attribution: {
        fellowId: f.binding.fellowId,
        sponsorId,
        sessionId: "S-question",
        modelSelfDeclared: "test/model",
        harness: "curl",
      },
    },
    {
      statementsAfterEvent: ({ sequence }) =>
        type === "question.asked"
          ? [
              f.db
                .prepare(
                  `INSERT INTO questions(question_id,problem_id,seq,target_refs_json,blocking,
        body_md,author_fellow_id,status,created_at) VALUES(?,?,?,'["C-1@1"]','C-1@1',?,?,'open',?)`,
                )
                .bind(questionId, problemId, sequence, body, f.binding.fellowId, createdAt),
            ]
          : [],
    },
  );
}
function control(f: Fixture, ref: string, visibility: "hidden" | "visible", version: number) {
  f.sql
    .query(`INSERT INTO content_controls(control_id,problem_id,target_kind,target_ref,
    visibility,source,reason_category,actor,reason,version,created_at)
    VALUES(?,?,'question',?,?,'operator','privacy','usr_operator','Fixture control.',?,?)`)
    .run(
      `CC-${crypto.randomUUID()}`,
      problemId,
      ref,
      visibility,
      version,
      new Date().toISOString(),
    );
}
function face(f: Fixture, format: string, init?: RequestInit) {
  return createLedgerFaceRoutes().request(
    `https://a.asimposium.org/p/${problemId}/questions.${format}`,
    init,
    { DB: f.db } as Env,
  );
}

test("question faces use immutable content, attribution and state despite poisoned projections", async () => {
  const f = await fixture(),
    admitted = await publish(f);
  f.sql
    .query(`UPDATE questions SET body_md='PROJECTION-SECRET', target_refs_json='["PRIVATE-TARGET"]',
    blocking='PRIVATE-BLOCK', author_fellow_id='forged-author', status='resolved',
    resolved_by_object='PRIVATE-ANSWER', seq=999, created_at='forged-time'`)
    .run();
  const result = await loadProblemQuestions(f.db, problemId);
  expect(result.questions).toHaveLength(1);
  expect(result.questions[0]).toMatchObject({
    body_md: body,
    target_refs: ["C-1@1"],
    blocking: "C-1@1",
    author_fellow_id: f.binding.fellowId,
    status: "open",
    seq: admitted.seq,
    resolved_by_object: null,
  });
  for (const format of formats) {
    const response = await face(f, format),
      text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain(body);
    expect(text).not.toMatch(
      /PROJECTION-SECRET|PRIVATE-TARGET|PRIVATE-BLOCK|PRIVATE-ANSWER|forged-author|forged-time/,
    );
    const cached = await face(f, format, {
      headers: { "if-none-match": response.headers.get("etag") ?? "" },
    });
    expect(cached.status).toBe(304);
  }
});

test("redacted, corrupt and missing question bytes never fall back to the projection", async () => {
  for (const mode of ["redacted", "corrupt", "missing"] as const) {
    const f = await fixture(),
      admitted = await publish(f);
    if (mode === "redacted") {
      f.sql
        .query(`UPDATE event_content SET payload_json='{}', redacted_at=?, redaction_reason='privacy'
        WHERE event_id=?`)
        .run(new Date().toISOString(), admitted.eventId);
    } else if (mode === "corrupt") {
      // Deliberately plant storage corruption below the immutable-write guard.
      f.sql.exec("DROP TRIGGER event_content_lawful_redaction_only");
      f.sql
        .query("UPDATE event_content SET payload_json=? WHERE event_id=?")
        .run(JSON.stringify({ question_id: "Q-1", body_md: "CORRUPT-BODY" }), admitted.eventId);
    } else {
      f.sql.query("DELETE FROM event_content WHERE event_id=?").run(admitted.eventId);
    }
    for (const format of formats) {
      const response = await face(f, format),
        text = await response.text();
      expect(response.status).toBe(200);
      expect(text).not.toContain(body);
      expect(text).not.toContain("CORRUPT-BODY");
      expect(text).toContain("unavailable");
      expect(text).not.toContain("No questions recorded");
    }
  }
});

test("current object, exact-version and event controls win over every old question ETag", async () => {
  for (const kind of ["object", "version", "event"] as const) {
    const f = await fixture(),
      admitted = await publish(f);
    const etags = await Promise.all(
      formats.map(async (format) => (await face(f, format)).headers.get("etag") ?? ""),
    );
    const ref = kind === "object" ? "Q-1" : kind === "version" ? "Q-1@1" : `#${admitted.seq}`;
    control(f, ref, "hidden", 1);
    for (const [i, format] of formats.entries()) {
      for (const method of ["GET", "HEAD"]) {
        const response = await face(f, format, {
          method,
          headers: { "if-none-match": etags[i] ?? "" },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("etag")).not.toBe(etags[i]);
        expect(await response.text()).not.toContain(body);
      }
    }
    control(f, ref, "visible", 2);
    expect((await loadProblemQuestions(f.db, problemId)).questions[0]?.body_md).toBe(body);
  }
});

test("whole-problem controls refuse question faces before conditional responses and preserve unlisted policy", async () => {
  const f = await fixture();
  await publish(f);
  f.sql.query("UPDATE problems SET unlisted=1 WHERE id=?").run(problemId);
  const initial = await face(f, "json");
  expect(initial.headers.get("x-robots-tag")).toContain("noindex");
  control(f, "problem", "hidden", 1);
  for (const format of formats)
    for (const method of ["GET", "HEAD"]) {
      const response = await face(f, format, {
        method,
        headers: { "if-none-match": initial.headers.get("etag") ?? "" },
      });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(body);
    }
  control(f, "problem", "visible", 2);
  expect((await face(f, "json")).status).toBe(200);
});

test("operator question controls hide pinned sources before validators and restore their exact content", async () => {
  const f = await fixture();
  const admitted = await publish(f);
  const sourceSuffix = `?through=${admitted.seq}&target=Q-1`;
  const originals = new Map<string, { etag: string; text: string }>();
  for (const format of formats) {
    const response = await face(f, `${format}${sourceSuffix}`);
    expect(response.status).toBe(200);
    originals.set(format, {
      etag: response.headers.get("etag") ?? "",
      text: await response.text(),
    });
  }
  const apply = async (action: "hide" | "restore") => {
    const response = await operatorContentControl(f.db, "usr_operator", {
      target_id: `${problemId}/Q-1`,
      target_kind: "question",
      action,
      reason: "Verify current question controls over immutable historical sources.",
    });
    if (response === undefined) throw new Error("Expected an operator control response.");
    expect(response.status).toBe(200);
    return AdminContentControlResponseSchema.parse(await response.json());
  };
  for (const invalid of [
    { target_id: `${problemId}/Q-1@1`, target_kind: "question" },
    { target_id: `${problemId}/Q-1`, target_kind: "conflict" },
    { target_id: "P-OTHER/Q-1", target_kind: "question" },
    { target_id: `${problemId}/Q-ABSENT`, target_kind: "question" },
  ] as const) {
    const response = await operatorContentControl(f.db, "usr_operator", {
      ...invalid,
      action: "hide",
      reason: "An ambiguous or incorrectly scoped target must never change visibility.",
    });
    expect(response?.status).toBe(404);
    expect(ProblemDocumentSchema.parse(await response?.json()).code).toBe(
      "MODERATION_TARGET_NOT_FOUND",
    );
  }
  const hidden = await apply("hide");
  expect(hidden.target_id).toBe(`${problemId}/Q-1`);
  for (const format of formats) {
    const original = originals.get(format);
    if (original === undefined || !original.etag) throw new Error("Expected a cache validator.");
    for (const method of ["GET", "HEAD"]) {
      const response = await face(f, `${format}${sourceSuffix}`, {
        method,
        headers: { "if-none-match": original.etag },
      });
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).not.toContain(body);
    }
  }
  const restored = await apply("restore");
  expect(restored.audit_event_id).not.toBe(hidden.audit_event_id);
  for (const format of formats) {
    const original = originals.get(format);
    if (original === undefined) throw new Error("Expected the original question representation.");
    const response = await face(f, `${format}${sourceSuffix}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(original.etag);
    expect(await response.text()).toBe(original.text);
  }
});

test("answer and withdrawal states are verified from events, never stale projection fields", async () => {
  const f = await fixture();
  await publish(f);
  const answer = await publish(f, "Q-1", "question.answered", { resolved_by_object: "C-1@1" });
  f.sql.query("UPDATE questions SET status='open', resolved_by_object='FORGED-ANSWER'").run();
  expect((await loadProblemQuestions(f.db, problemId)).questions[0]).toMatchObject({
    status: "resolved",
    resolved_by_object: "C-1@1",
  });
  control(f, `#${answer.seq}`, "hidden", 1);
  const hidden = await loadProblemQuestions(f.db, problemId);
  expect(hidden.questions).toHaveLength(0);
  expect(hidden.omitted).toContain("Some question content or lifecycle history is unavailable.");
  control(f, `#${answer.seq}`, "visible", 2);
  await publish(f, "Q-2");
  await publish(f, "Q-2", "question.withdrawn", {
    reason: "The exact obligation is no longer needed.",
  });
  expect((await loadProblemQuestions(f.db, problemId)).questions[1]).toMatchObject({
    status: "withdrawn",
    resolved_by_object: null,
    leased_by: null,
  });
});

test("question snapshots retain the committed lease term despite operational projection changes", async () => {
  const f = await fixture();
  await publish(f);
  const deadline = "2099-01-01T02:00:00.000Z",
    renewed = "2099-01-01T03:00:00.000Z";
  await publish(f, "Q-1", "question.leased", {
    leased_by: f.binding.fellowId,
    leased_until: deadline,
    objective: "Check the boundary",
    deliverable: "A cited counterexample",
  });
  f.sql
    .query("UPDATE questions SET status='leased', leased_by=?, leased_until=?")
    .run(f.binding.fellowId, renewed);
  expect((await loadProblemQuestions(f.db, problemId)).questions[0]).toMatchObject({
    status: "leased",
    leased_by: f.binding.fellowId,
    leased_until: deadline,
  });
  f.sql.query("UPDATE questions SET leased_by='FORGED-HOLDER', leased_until=?").run(renewed);
  expect((await loadProblemQuestions(f.db, problemId)).questions[0]).toMatchObject({
    status: "leased",
    leased_by: f.binding.fellowId,
    leased_until: deadline,
  });
});

test("hidden admissions retain the bounded page boundary instead of manufacturing an empty history", async () => {
  const f = await fixture();
  await publish(f);
  await publish(f, "Q-2");
  control(f, "Q-1", "hidden", 1);
  const result = await loadProblemQuestions(f.db, problemId, { limit: 1 });
  expect(result.questions).toHaveLength(0);
  expect(result.omitted).toContain("truncated at limit of 1 questions");
  expect(result.omitted).toContain("Some question content or lifecycle history is unavailable.");
  expect(result.next_after).toBeGreaterThan(0);
  if (result.next_after === null)
    throw new Error("Expected a continuation over the withheld page.");
  const continued = await loadProblemQuestions(f.db, problemId, {
    through: result.cursor,
    after: result.next_after,
    limit: 1,
  });
  expect(continued.questions.map((question) => question.question_id)).toEqual(["Q-2"]);
  expect(continued.next_after).toBeNull();
  expect(continued.scanned_through).toBe(continued.cursor);
});

test("exact question targets beyond the default collection page never substitute earlier records", async () => {
  const f = await fixture();
  for (let n = 1; n <= 51; n++)
    await publish(f, `Q-${n}`, "question.asked", {
      body_md: `Which verified boundary instance decides research question number ${n}?`,
    });
  const initial = QuestionsListResponseSchema.parse(await (await face(f, "json")).json());
  expect(initial.questions).toHaveLength(50);
  expect(
    initial.questions.some((question: { question_id: string }) => question.question_id === "Q-51"),
  ).toBe(false);
  expect(initial.next_after).toBeGreaterThan(0);
  const next = await face(f, `json?through=${initial.cursor}&after=${initial.next_after}`);
  expect(
    QuestionsListResponseSchema.parse(await next.json()).questions.map(
      (question) => question.question_id,
    ),
  ).toEqual(["Q-51"]);
  for (const format of formats) {
    const response = await face(f, `${format}?target=Q-51`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-location")).toContain("target=Q-51");
    const text = await response.text();
    expect(text).toContain("research question number 51?");
    expect(text).not.toContain("research question number 1?");
    expect(text).not.toContain("research question number 50?");
  }
  const exact = QuestionsListResponseSchema.parse(await (await face(f, "json?target=Q-51")).json());
  expect(exact.questions).toHaveLength(1);
  expect(exact.target).toBe("Q-51");
  expect(exact.next_after).toBeNull();
});

test("question pagination and exact reads freeze lifecycle state before concurrent answers and new asks", async () => {
  const f = await fixture();
  await publish(f);
  await publish(f, "Q-2");
  const response = await face(f, "json?limit=1");
  const first = QuestionsListResponseSchema.parse(await response.json());
  expect(first.questions.map((question: { question_id: string }) => question.question_id)).toEqual([
    "Q-1",
  ]);
  expect(response.headers.get("link")).toContain(
    `through=${first.cursor}&after=${first.next_after}&limit=1`,
  );
  const canonical = response.headers.get("content-location") ?? "";
  expect(canonical).toContain("questions.json");
  const frozenInitial = await face(f, `json?through=${first.cursor}&limit=1`);
  const frozenText = await frozenInitial.text();
  await publish(f, "Q-1", "question.answered", { resolved_by_object: "C-1@1" });
  await publish(f, "Q-2", "question.withdrawn", {
    reason: "The original obligation is withdrawn.",
  });
  await publish(f, "Q-3");
  expect(await (await face(f, `json?through=${first.cursor}&limit=1`)).text()).toBe(frozenText);
  const reproduced = await createLedgerFaceRoutes().request(
    `https://a.asimposium.org${canonical}`,
    undefined,
    { DB: f.db } as Env,
  );
  expect(QuestionsListResponseSchema.parse(await reproduced.json()).questions[0]?.status).toBe(
    "open",
  );
  const continued = await face(f, `json?through=${first.cursor}&after=${first.next_after}&limit=1`);
  const second = QuestionsListResponseSchema.parse(await continued.json());
  expect(second.questions).toHaveLength(1);
  expect(second.questions[0]).toMatchObject({ question_id: "Q-2", status: "open" });
  expect(second.next_after).toBeNull();
  expect(second.cursor).toBe(first.cursor);
  const beforeAnswer = QuestionsListResponseSchema.parse(
    await (await face(f, `json?target=Q-1&through=${first.cursor}`)).json(),
  );
  expect(beforeAnswer.questions[0]?.status).toBe("open");
  const afterAnswer = QuestionsListResponseSchema.parse(
    await (await face(f, "json?target=Q-1")).json(),
  );
  expect(afterAnswer.questions[0]).toMatchObject({
    status: "resolved",
    resolved_by_object: "C-1@1",
  });
  expect((await face(f, `json?target=Q-3&through=${first.cursor}`)).status).toBe(404);
});

test("question status filters advance over nonmatching pages with links on every representation", async () => {
  const f = await fixture();
  await publish(f);
  await publish(f, "Q-2");
  await publish(f, "Q-1", "question.answered", { resolved_by_object: "C-1@1" });
  const first = QuestionsListResponseSchema.parse(
    await (await face(f, "json?limit=1&status=open")).json(),
  );
  expect(first.questions).toHaveLength(0);
  expect(first.status).toBe("open");
  expect(first.next_after).toBeGreaterThan(first.after);
  const suffix = `?through=${first.cursor}&after=${first.next_after}&limit=1&status=open`;
  const next = QuestionsListResponseSchema.parse(await (await face(f, `json${suffix}`)).json());
  expect(next.questions.map((question: { question_id: string }) => question.question_id)).toEqual([
    "Q-2",
  ]);
  for (const format of ["md", "html"] as const) {
    const response = await face(f, `${format}?limit=1&status=open`);
    expect(response.headers.get("link")).toContain(`questions.${format}${suffix}`);
    expect(await response.text()).toContain("More questions");
  }
});

test("question byte-bounded pages retain every complete legal record through continuation", async () => {
  const f = await fixture();
  const source = AskQuestionRequestSchema.parse({
    body_md: "Which finite boundary cases decide this conjecture? ".padEnd(4000, "\u0001"),
    target_refs: Array.from({ length: 32 }, (_, index) => String(index).padEnd(128, "\u0001")),
    blocking: "\u0001".repeat(128),
  });
  expect(validateQuestionSubstance(source)).toEqual({ valid: true });
  for (let index = 1; index <= 90; index++)
    await publish(f, `Q-${index}`, "question.asked", source);
  const response = await face(f, "json?limit=200");
  expect(response.status).toBe(200);
  const first = QuestionsListResponseSchema.parse(await response.json());
  expect(first.questions.length).toBeGreaterThan(0);
  expect(first.questions.length).toBeLessThan(90);
  expect(first.omitted).toContain(
    "Question source-byte budget reached; continue at the same snapshot.",
  );
  expect(first.next_after).toBe(first.scanned_through);
  if (first.next_after === null) throw new Error("Expected a source-byte continuation.");
  expect(response.headers.get("link")).toContain(
    `through=${first.cursor}&after=${first.next_after}&limit=200`,
  );
  const continued = await face(
    f,
    `json?through=${first.cursor}&after=${first.next_after}&limit=200`,
  );
  expect(continued.status).toBe(200);
  const second = QuestionsListResponseSchema.parse(await continued.json());
  expect(second.next_after).toBeNull();
  expect(second.scanned_through).toBe(first.cursor);
  const all = [...first.questions, ...second.questions];
  expect(all.map((question) => question.question_id)).toEqual(
    Array.from({ length: 90 }, (_, index) => `Q-${index + 1}`),
  );
  for (const question of all) {
    expect(question.body_md).toBe(source.body_md);
    expect(question.target_refs).toEqual(source.target_refs);
    expect(question.blocking).toBe(source.blocking);
  }
});

test("question selectors refuse ambiguity and unavailable exact sources before conditional responses", async () => {
  const f = await fixture();
  const admitted = await publish(f);
  for (const query of [
    "after=1",
    "through=1&after=2",
    "through=9007199254740992",
    "through=01",
    "through=1%0A",
    "limit=201",
    "limit=0",
    "target=Q-1&status=open",
    "target=Q-1&through=80&after=0",
    "target=Q-1&target=Q-2",
    "target=Q-1%0A",
    "status=closed",
    "unrecognized=value",
  ])
    for (const format of formats) {
      const response = await face(f, `${format}?${query}`, { headers: { "if-none-match": "*" } });
      expect(response.status).toBe(400);
      expect(ProblemDocumentSchema.parse(await response.json()).code).toBe("CURSOR_INVALID");
    }
  expect((await face(f, "json?through=9007199254740991")).status).toBe(400);
  expect((await face(f, "json?target=Q-UNKNOWN")).status).toBe(404);
  for (const [index, format] of formats.entries()) {
    const exact = await face(f, `${format}?target=Q-1`);
    const etag = exact.headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    control(f, "Q-1", "hidden", 2 * index + 1);
    for (const method of ["GET", "HEAD"]) {
      const hidden = await face(f, `${format}?target=Q-1`, {
        method,
        headers: { "if-none-match": etag },
      });
      expect(hidden.status).toBe(404);
      expect(hidden.headers.get("cache-control")).toContain("no-store");
      expect(await hidden.text()).not.toContain(body);
    }
    control(f, "Q-1", "visible", 2 * index + 2);
  }
  f.sql.query("DELETE FROM event_content WHERE event_id=?").run(admitted.eventId);
  for (const format of formats) {
    const unavailable = await face(f, `${format}?target=Q-1`, {
      headers: { "if-none-match": "*" },
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("5");
    expect(ProblemDocumentSchema.parse(await unavailable.json()).code).toBe("INTERNAL_ERROR");
  }
});
