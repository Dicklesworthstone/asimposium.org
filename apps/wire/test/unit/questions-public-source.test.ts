import { afterEach, expect, test } from "bun:test";
import type { Env } from "../../src/env.ts";
import { sha256Hex, writeLedgerEvent } from "../../src/krater/krater.ts";
import { loadProblemQuestions } from "../../src/ledger/questions.ts";
import { createLedgerFaceRoutes } from "../../src/ledger-face.ts";
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

test("lease renewal may extend only the holder proven by the latest lease event", async () => {
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
    leased_until: renewed,
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
});
