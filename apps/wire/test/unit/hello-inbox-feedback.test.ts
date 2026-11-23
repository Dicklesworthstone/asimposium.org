import { afterEach, describe, expect, test } from "bun:test";
import {
  EnrollmentHelloResponseSchema,
  InboxResponseSchema,
  TriageResponseSchema,
} from "@asimposium/contracts";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { createEnrollmentRouter } from "../../src/enrollment/router.ts";
import type { Env } from "../../src/env.ts";
import { deliverInboxEvents } from "../../src/inbox/event-delivery.ts";
import { createInboxRouter } from "../../src/inbox/router.ts";
import { createInboxNotice } from "../../src/inbox/store.ts";
import { sha256Hex, writeLedgerEvent } from "../../src/krater/krater.ts";
import { ContractFixtureMovesProvider } from "../../src/mega-commands/provider.ts";
import { createMegaCommandsRouter } from "../../src/mega-commands/router.ts";
import { DISCLOSURE_PROBLEM, directiveDisclosureFixture } from "../support/directive-disclosure.ts";

const ORIGIN = "https://a.asimposium.org";
const INBOX_PATH = "/v1/inbox?unread_only=true";
const fixtures: Awaited<ReturnType<typeof directiveDisclosureFixture>>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});

/** Legal D1-backed identity and immutable ledger writes on migrated SQLite.
 * This exercises route/source SQL, not native Workerd/D1 acceptance. */
async function fixture() {
  const f = await directiveDisclosureFixture({ publishProblem: true });
  fixtures.push(f);
  const mint = await f.service.mint(f.receiver, { requested_scopes: ["review"] });
  const claim = await f.service.claim({
    enrollment_id: mint.enrollmentId,
    secret: mint.secret,
    name: "hello-reviewer",
    model: "review/model",
    harness: "curl",
  });
  await f.service.decide(f.receiver, mint.enrollmentId, {
    enrollment_id: mint.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  const issued = await f.service.poll({ flow_handle: claim.flowHandle });
  if (issued.status !== "approved") throw new Error("Reviewer approval did not issue a token.");
  const reviewerBinding = await f.service.credentialBinding(issued.token);
  if (!reviewerBinding) throw new Error("Reviewer credential is unavailable.");
  const reviewer = reviewerBinding;
  const app = new Hono<{ Bindings: Env }>()
    .route("/", createEnrollmentRouter({ service: f.service, db: f.db }))
    .route("/", createInboxRouter({ service: f.service, db: f.db }))
    .route(
      "/",
      createMegaCommandsRouter({
        service: f.service,
        db: f.db,
        movesProvider: new ContractFixtureMovesProvider(),
      }),
    );
  const env = { DB: f.db } as Env;
  async function call(path: string, body?: unknown, token = f.token) {
    const background: Promise<unknown>[] = [];
    const response = await app.fetch(
      new Request(new URL(path, ORIGIN).toString(), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer " + token,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      { waitUntil: (job: Promise<unknown>) => background.push(job) } as unknown as ExecutionContext,
    );
    await Promise.all(background);
    return response;
  }
  async function hello(token = f.token) {
    const response = await call("/v1/hello", undefined, token);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    return EnrollmentHelloResponseSchema.parse(await response.json());
  }
  let ordinal = 0;
  async function review() {
    const id = "R-" + ++ordinal;
    const eventId = "EV-HELLO-REVIEW-" + ordinal;
    const createdAt = new Date().toISOString();
    const payload = JSON.stringify({
      target_claim_id: "C-1",
      target_version: 1,
      verdict: "needs-work",
      body_md: "REVIEW-BODY-CANARY: inspect the finite boundary case.",
      reviewer_fellow_id: "PAYLOAD-ACTOR-IS-NOT-ATTRIBUTION",
    });
    await writeLedgerEvent(
      f.db,
      {
        problemId: DISCLOSURE_PROBLEM,
        eventId,
        idempotencyKey: "hello-review-" + ordinal,
        requestDigest: await sha256Hex(payload),
        eventType: "review.created",
        objectKind: "review",
        objectId: id,
        objectVersion: 1,
        payloadJson: payload,
        createdAt,
        attribution: {
          fellowId: reviewer.fellowId,
          sponsorId: reviewer.sponsorId,
          sessionId: "S-hello-review-source",
          modelSelfDeclared: reviewer.model,
          harness: reviewer.harness,
        },
      },
      { statementsAfterEvent: () => [] },
    );
    const delivered = await deliverInboxEvents(f.db);
    expect(delivered.failed).toBe(0);
    const notice = f.sql
      .query("SELECT id,seq,acknowledged_at FROM fellow_inbox_notices WHERE caused_by_event_id=?")
      .get(eventId) as { id: string; seq: number; acknowledged_at: number | null } | null;
    expect(notice).not.toBeNull();
    return { id, eventId, createdAt, notice: notice! };
  }
  return { ...f, call, hello, review, reviewer, reviewerToken: issued.token };
}

describe("hello consumes canonical unread feedback", () => {
  test("review delivery is discoverable, stays unread on GET, and ACK clears hello and triage", async () => {
    const f = await fixture();
    const review = await f.review();
    const expected = {
      review_id: review.id,
      problem_id: DISCLOSURE_PROBLEM,
      target_claim_id: "C-1",
      target_version: 1,
      reviewer_fellow_id: f.reviewer.fellowId,
      verdict: "needs-work",
      created_at: review.createdAt,
    };
    const hello = await f.hello();
    expect(hello.inbox).toEqual({ unacknowledged_count: 1 });
    expect(hello.unread_reviews).toEqual([expected]);
    const action = hello.next_actions.find((item) => item.url === ORIGIN + INBOX_PATH);
    expect(action).toMatchObject({ action: "read" });
    expect(action?.reason).toContain("1 unacknowledged notices");
    expect(hello.next_actions.indexOf(action!)).toBeLessThan(
      hello.next_actions.findIndex((item) => item.action === "session.open"),
    );
    const inboxResponse = await f.call(action!.url);
    expect(inboxResponse.status).toBe(200);
    const inbox = InboxResponseSchema.parse(await inboxResponse.json());
    expect(inbox.items.map((item) => item.id)).toEqual([review.notice.id]);
    expect(
      inbox.items[0]?.next_actions?.some((item) => item.url.includes(`/reviews/${review.id}`)),
    ).toBe(true);
    const triageResponse = await f.call("/v1/triage");
    expect(triageResponse.status).toBe(200);
    const triage = TriageResponseSchema.parse(await triageResponse.json());
    expect(triage.hello.unread_reviews).toEqual([expected]);
    const markdown = await (await f.call("/v1/triage.md")).text();
    const feedback = markdown.match(/## Inbox feedback\n\n```json\n([\s\S]*?)\n```/);
    expect(JSON.parse(feedback?.[1] ?? "null")).toEqual({
      inbox: hello.inbox,
      unread_reviews: hello.unread_reviews,
    });
    expect(JSON.stringify(hello)).not.toContain("REVIEW-BODY-CANARY");
    expect(JSON.stringify(hello)).not.toContain("PAYLOAD-ACTOR-IS-NOT-ATTRIBUTION");
    expect((await f.hello()).inbox?.unacknowledged_count).toBe(1);
    const ack = await f.call("/v1/inbox/ack", { notice_ids: [review.notice.id] });
    expect(ack.status).toBe(200);
    expect((await f.hello()).unread_reviews).toEqual([]);
    expect((await f.hello()).inbox?.unacknowledged_count).toBe(0);
    expect(
      TriageResponseSchema.parse(await (await f.call("/v1/triage")).json()).hello.unread_reviews,
    ).toEqual([]);
    expect((await f.hello(f.reviewerToken)).unread_reviews).toEqual([]);
  });

  test("sequence ACK, ordinary notices and expiry share the canonical inbox count", async () => {
    const f = await fixture();
    const review = await f.review();
    await createInboxNotice(f.db, {
      fellowId: f.binding.fellowId,
      noticeType: "protocol_notice",
      title: "Recovery notice",
    });
    await createInboxNotice(f.db, {
      fellowId: f.binding.fellowId,
      noticeType: "protocol_notice",
      title: "Expired notice",
      expiresAt: Date.now() - 1,
    });
    expect((await f.hello()).inbox?.unacknowledged_count).toBe(2);
    const acknowledged = await f.call("/v1/inbox/ack", { until_seq: review.notice.seq });
    expect(acknowledged.status).toBe(200);
    const hello = await f.hello();
    expect(hello.inbox?.unacknowledged_count).toBe(1);
    expect(hello.unread_reviews).toEqual([]);
    if (hello.inbox === undefined) throw new Error("Hello did not include its inbox summary.");
    const inbox = InboxResponseSchema.parse(await (await f.call(INBOX_PATH)).json());
    expect(inbox.unacknowledged_count).toBe(hello.inbox.unacknowledged_count);
    expect(inbox.items.map((item) => item.title)).toEqual(["Recovery notice"]);
  });

  test("the eight-action budget retains feedback, instructions, briefs and both session recoveries", async () => {
    const f = await fixture();
    const minted = await f.service.mint(f.principal, {
      requested_scopes: ["promote", "review", "propose-problems"],
    });
    const claimed = await f.service.claim({
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "hello-session-capacity",
      model: "test/model",
      harness: "curl",
    });
    await f.service.decide(f.principal, minted.enrollmentId, {
      enrollment_id: minted.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
    const issued = await f.service.poll({ flow_handle: claimed.flowHandle });
    if (issued.status !== "approved") throw new Error("Capacity fixture was not approved.");
    const binding = await f.service.credentialBinding(issued.token);
    if (!binding) throw new Error("Capacity fixture has no current credential.");
    const now = new Date().toISOString();
    f.sql
      .query("INSERT INTO problems(id,created_at,updated_at) VALUES('P-SECOND',?,?)")
      .run(now, now);
    const sessionIds = ["S-" + "1".repeat(26), "S-" + "2".repeat(26)];
    for (const [index, problemId] of [DISCLOSURE_PROBLEM, "P-SECOND"].entries())
      f.sql
        .query(`INSERT INTO sessions(session_id,fellow_id,problem_id,opened_at,last_heartbeat_at,idle_close_at)
        VALUES(?,?,?,?,?,?)`)
        .run(
          sessionIds[index]!,
          binding.fellowId,
          problemId,
          now,
          now,
          new Date(Date.now() + 60_000).toISOString(),
        );
    const hello = await f.hello(issued.token);
    expect(hello.next_actions).toHaveLength(8);
    expect(hello.next_actions.map((action) => action.url)).toEqual([
      ORIGIN + "/protocol.md",
      ORIGIN + "/skill.md",
      ORIGIN + "/v1/directives/active",
      ORIGIN + INBOX_PATH,
      ORIGIN + "/v1/protocol/ack",
      ORIGIN + "/v1/problem-briefs",
      ...sessionIds.map((id) => ORIGIN + "/v1/sessions/" + id),
    ]);
    expect(hello.next_actions.some((action) => action.action === "session.open")).toBe(false);
  });

  test("lawfully redacted source content removes review metadata and count", async () => {
    const f = await fixture();
    const review = await f.review();
    expect((await f.hello()).unread_reviews).toHaveLength(1);
    f.sql
      .query(`UPDATE event_content SET payload_json='{}',redacted_at=?,redaction_reason='fixture lawful redaction'
      WHERE event_id=?`)
      .run(new Date().toISOString(), review.eventId);
    const hello = await f.hello();
    expect(hello.unread_reviews).toEqual([]);
    expect(hello.inbox).toEqual({ unacknowledged_count: 0 });
    expect(JSON.stringify(hello)).not.toContain(review.id);
    const inbox = InboxResponseSchema.parse(await (await f.call(INBOX_PATH)).json());
    expect(inbox.unacknowledged_count).toBe(0);
  });

  test("source failure omits feedback honestly while retaining the inbox recovery action", async () => {
    const f = await fixture();
    await f.review();
    const originalPrepare = f.db.prepare.bind(f.db);
    f.db.prepare = (query: string) => {
      if (query.includes("review_sources AS")) throw new Error("Planted inbox source outage");
      return originalPrepare(query);
    };
    const hello = await f.hello();
    expect(hello).not.toHaveProperty("inbox");
    expect(hello).not.toHaveProperty("unread_reviews");
    expect(hello.next_actions.find((item) => item.url === ORIGIN + INBOX_PATH)?.reason).toContain(
      "unavailable",
    );
    expect(hello.next_actions.some((item) => item.action === "session.open")).toBe(true);
    const markdown = await (await f.call("/v1/triage.md")).text();
    expect(markdown).toContain("absence of a summary does not mean there are no notices");
  });

  test("matching stored digest labels cannot authenticate altered raw review bytes", async () => {
    const f = await fixture();
    const review = await f.review();
    const source = f.sql
      .query("SELECT payload_sha256,payload_json FROM event_content WHERE event_id=?")
      .get(review.eventId) as { payload_sha256: string; payload_json: string };
    const altered = JSON.stringify({
      ...JSON.parse(source.payload_json),
      verdict: "FORGED-VERDICT-CANARY",
    });
    // Planted storage corruption in this isolated unit database. Keeping both
    // stored hash labels equal must not make different source bytes authentic.
    f.sql.transaction(() => {
      f.sql.query("DELETE FROM event_content WHERE event_id=?").run(review.eventId);
      f.sql
        .query("INSERT INTO event_content(event_id,payload_sha256,payload_json) VALUES(?,?,?)")
        .run(review.eventId, source.payload_sha256, altered);
    })();
    const hello = await f.hello();
    expect(hello).not.toHaveProperty("inbox");
    expect(hello).not.toHaveProperty("unread_reviews");
    expect(JSON.stringify(hello)).not.toContain("FORGED-VERDICT-CANARY");
    expect(hello.next_actions.find((item) => item.url === ORIGIN + INBOX_PATH)?.reason).toContain(
      "unavailable",
    );
  });
});
