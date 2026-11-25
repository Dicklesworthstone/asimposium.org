import { afterEach, expect, test } from "bun:test";
import {
  EnrollmentHelloResponseSchema,
  InboxResponseSchema,
  SessionOpenResponseSchema,
} from "@asimposium/contracts";
import { SponsorDirectiveReceiptSchema } from "@asimposium/contracts/directives";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { reviewDirectiveText } from "../../../web/lib/review-handoff.ts";
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "../../../web/lib/service-envelope.ts";
import { createApp } from "../../src/app.ts";
import { toHex } from "../../src/auth/canonical.ts";
import type { Env } from "../../src/env.ts";
import {
  DISCLOSURE_OTHER,
  DISCLOSURE_PROBLEM,
  DISCLOSURE_SPONSOR,
  directiveDisclosureFixture,
} from "../support/directive-disclosure.ts";

const ORIGIN = "https://a.asimposium.org";
const ROUTE = "/v1/sponsors/directives";
type BaseFixture = Awaited<ReturnType<typeof directiveDisclosureFixture>>;
const fixtures: BaseFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});

// Mounted application and real service-envelope signatures over migrated SQLite.
// This is route-unit evidence, not a native Workerd/D1 integration claim.
async function fixture() {
  const f = await directiveDisclosureFixture({ publishProblem: true });
  fixtures.push(f);
  f.sql
    .query("UPDATE problems SET status='active', admission_mode='open', unlisted=0 WHERE id=?")
    .run(DISCLOSURE_PROBLEM);

  async function enroll(name: string, problemBinding?: string) {
    const grant = await f.service.mint(f.receiver, {
      requested_scopes: ["review"],
      ...(problemBinding === undefined ? {} : { problem_binding: problemBinding }),
    });
    const proposal = await f.service.claim({
      enrollment_id: grant.enrollmentId,
      secret: grant.secret,
      name,
      model: "test/reviewer",
      harness: "curl",
    });
    await f.service.decide(f.receiver, grant.enrollmentId, {
      enrollment_id: grant.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
    const issued = await f.service.poll({ flow_handle: proposal.flowHandle });
    if (!("token" in issued)) throw new Error("Recruitment fixture did not issue a token");
    const binding = await f.service.credentialBinding(issued.token);
    if (!binding) throw new Error("Recruitment fixture did not bind its credential");
    return { token: issued.token, binding };
  }
  const recruit = await enroll("review-arrival");
  let beforeBatch: (() => void) | undefined;
  const db = {
    ...f.db,
    async batch<T>(statements: D1PreparedStatement[]) {
      const callback = beforeBatch;
      beforeBatch = undefined;
      callback?.();
      return f.db.batch<T>(statements);
    },
  };
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  if (!("privateKey" in keys)) throw new Error("Expected an Ed25519 key pair");
  const env = {
    DB: db,
    STOA_ORIGIN: ORIGIN,
    AGORA_ORIGIN: "https://asimposium.org",
    ENROLLMENT_REPLAY_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    SERVICE_ENVELOPE_KEYS: JSON.stringify([
      {
        kid: "directive-recruitment",
        notBefore: 0,
        publicKeyHex: toHex(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))),
      },
    ]),
  } as Env;
  const app = createApp();
  const cursor = f.sql
    .query("SELECT public_seq FROM problems WHERE id=?")
    .get(DISCLOSURE_PROBLEM) as {
    public_seq: number;
  };
  const focus = {
    fellow_id: recruit.binding.fellowId,
    problem_id: DISCLOSURE_PROBLEM,
    verb: "focus" as const,
    text: reviewDirectiveText({
      problemId: DISCLOSURE_PROBLEM,
      target: "C-1@1",
      through: String(cursor.public_seq),
    }),
  };
  const issue = async (
    body: unknown = focus,
    key = "review-arrival",
    sponsor = DISCLOSURE_OTHER,
    action = "issue-directive",
  ) => {
    const serialized = JSON.stringify(body);
    const envelope = await mintServiceEnvelope({
      privateKey: keys.privateKey,
      kid: "directive-recruitment",
      now: Math.floor(Date.now() / 1000),
      method: "POST",
      route: ROUTE,
      action,
      principalId: sponsor,
      body: serialized,
    });
    return app.request(
      ORIGIN + ROUTE,
      {
        method: "POST",
        headers: {
          ...serviceEnvelopeHeaders(envelope),
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: serialized,
      },
      env,
    );
  };
  const fellow = (path: string, init: RequestInit = {}) =>
    app.request(
      ORIGIN + path,
      {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${recruit.token}` },
      },
      env,
    );
  const authority = () => ({
    memberships: f.sql
      .query("SELECT * FROM problem_memberships ORDER BY problem_id,fellow_id")
      .all(),
    grants: f.sql
      .query(
        "SELECT fellow_id,sponsor_id,granted_scopes_json,granted_resources_json FROM enrollment_grants ORDER BY fellow_id",
      )
      .all(),
    credentials: f.sql
      .query(
        "SELECT credential_id,fellow_id,sponsor_id,granted_scopes_json,granted_resources_json,revoked_at FROM fellow_tokens ORDER BY credential_id",
      )
      .all(),
    sessions: f.sql.query("SELECT * FROM sessions ORDER BY session_id").all(),
    events: f.sql.query("SELECT id,problem_id,seq FROM events ORDER BY id").all(),
    cursor: f.sql.query("SELECT * FROM public_cursor").all(),
  });
  const delivery = () => ({
    directives: f.sql.query("SELECT * FROM sponsor_directives ORDER BY id").all(),
    notices: f.sql.query("SELECT * FROM fellow_inbox_notices ORDER BY id").all(),
  });
  function visibility(target: string, state: "hidden" | "visible") {
    f.sql
      .query(
        "INSERT INTO content_controls " +
          "(control_id,problem_id,target_kind,target_ref,visibility,source,reason_category,actor,reason,version,created_at) " +
          "SELECT ?,?,'problem',?,?,'operator','other','operator','Recruitment visibility regression'," +
          "COALESCE(MAX(version),0)+1,? FROM content_controls WHERE problem_id=? AND target_ref=?",
      )
      .run(
        `CC-${crypto.randomUUID()}`,
        DISCLOSURE_PROBLEM,
        target,
        state,
        new Date().toISOString(),
        DISCLOSURE_PROBLEM,
        target,
      );
  }
  return {
    ...f,
    app,
    env,
    recruit,
    enroll,
    focus,
    issue,
    fellow,
    authority,
    delivery,
    visibility,
    beforeBatch(callback: () => void) {
      beforeBatch = callback;
    },
  };
}

test("a signed review focus reaches an unbound Fellow before joining and grants no problem access", async () => {
  const f = await fixture();
  expect(f.recruit.binding.grantedResources.problemBinding).toBeUndefined();
  expect(
    f.sql
      .query("SELECT COUNT(*) AS n FROM problem_memberships WHERE fellow_id=?")
      .get(f.recruit.binding.fellowId),
  ).toEqual({ n: 0 });
  const before = f.authority();
  const sent = await f.issue();
  expect(sent.status, await sent.clone().text()).toBe(201);
  expect(sent.headers.get("cache-control")).toBe("private, no-store");
  const receipt = SponsorDirectiveReceiptSchema.parse(await sent.json());
  expect(receipt).toMatchObject({
    fellow_id: f.recruit.binding.fellowId,
    problem_id: DISCLOSURE_PROBLEM,
    verb: "focus",
    text: f.focus.text,
    delivered: true,
    acknowledged_at: null,
  });
  expect(f.authority()).toEqual(before);

  const inboxResponse = await f.fellow("/v1/inbox");
  expect(inboxResponse.status, await inboxResponse.clone().text()).toBe(200);
  const inbox = InboxResponseSchema.parse(await inboxResponse.json());
  expect(inbox.items).toHaveLength(1);
  expect(inbox.items[0]).toMatchObject({
    type: "sponsor_directive",
    problem_id: DISCLOSURE_PROBLEM,
    detail: f.focus.text,
    target_id: receipt.directive_id,
  });
  const helloResponse = await f.fellow("/v1/hello");
  expect(helloResponse.status, await helloResponse.clone().text()).toBe(200);
  const hello = EnrollmentHelloResponseSchema.parse(await helloResponse.json());
  expect(hello.fellow.fellow_id).toBe(f.recruit.binding.fellowId);
  expect(hello.inbox).toBeDefined();
  expect(hello.next_actions.some((action) => action.url.includes("/v1/inbox"))).toBe(true);
  const instructions = await f.fellow(`/v1/directives/active?problem_id=${DISCLOSURE_PROBLEM}`);
  expect(instructions.status, await instructions.clone().text()).toBe(200);
  const instructionText = await instructions.text();
  expect(instructionText).toContain(receipt.directive_id);
  expect(instructionText).toContain(f.focus.text);
  expect(f.authority()).toEqual(before);

  // The delivered focus cannot substitute for current session admission.
  f.sql
    .query("UPDATE problems SET admission_mode='invite-only' WHERE id=?")
    .run(DISCLOSURE_PROBLEM);
  const open = () =>
    f.fellow("/v1/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "recruited-review-session",
      },
      body: JSON.stringify({ problem_id: DISCLOSURE_PROBLEM, intent: "review" }),
    });
  const refused = await open();
  expect(refused.status, await refused.clone().text()).toBe(403);
  expect(f.authority()).toEqual(before);
  f.sql.query("UPDATE problems SET admission_mode='open' WHERE id=?").run(DISCLOSURE_PROBLEM);
  const opened = await open();
  expect(opened.status, await opened.clone().text()).toBe(201);
  expect(SessionOpenResponseSchema.parse(await opened.json()).problem_id).toBe(DISCLOSURE_PROBLEM);
  expect(
    f.sql
      .query("SELECT COUNT(*) AS n FROM problem_memberships WHERE problem_id=? AND fellow_id=?")
      .get(DISCLOSURE_PROBLEM, f.recruit.binding.fellowId),
  ).toEqual({ n: 1 });
  expect((await f.service.credentialBinding(f.recruit.token))?.grantedScopes).toEqual(
    f.recruit.binding.grantedScopes,
  );
});

test("recruitment refuses unavailable problems, other verbs, foreign sponsors and inactive or bound Fellows", async () => {
  const f = await fixture();
  const before = f.delivery();
  const denied = async (body: unknown, key: string, sponsor = DISCLOSURE_OTHER) => {
    const authority = f.authority();
    const response = await f.issue(body, key, sponsor);
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await response.json()).toMatchObject({ code: "DIRECTIVE_TARGET_NOT_FOUND" });
    expect(f.delivery()).toEqual(before);
    expect(f.authority()).toEqual(authority);
  };
  await denied({ ...f.focus, problem_id: "P-MISSING" }, "missing");
  await denied({ ...f.focus, verb: "forbid" }, "unassigned-forbid");
  await denied(
    { fellow_id: f.recruit.binding.fellowId, problem_id: DISCLOSURE_PROBLEM, verb: "unfocus" },
    "unassigned-unfocus",
  );
  await denied(f.focus, "foreign-sponsor", DISCLOSURE_SPONSOR);
  const wrongAction = await f.issue(f.focus, "wrong-action", DISCLOSURE_OTHER, "list-directives");
  expect(wrongAction.status).toBe(401);
  expect(f.delivery()).toEqual(before);

  for (const status of ["private-draft", "resolved", "retired"]) {
    f.sql.query("UPDATE problems SET status=? WHERE id=?").run(status, DISCLOSURE_PROBLEM);
    await denied(f.focus, `status-${status}`);
  }
  f.sql.query("UPDATE problems SET status='active',unlisted=1 WHERE id=?").run(DISCLOSURE_PROBLEM);
  await denied(f.focus, "unlisted");
  f.sql.query("UPDATE problems SET unlisted=0 WHERE id=?").run(DISCLOSURE_PROBLEM);
  for (const mode of ["approval-required", "invite-only", "archived-read-only"]) {
    f.sql.query("UPDATE problems SET admission_mode=? WHERE id=?").run(mode, DISCLOSURE_PROBLEM);
    await denied(f.focus, `admission-${mode}`);
  }
  f.sql.query("UPDATE problems SET admission_mode='open' WHERE id=?").run(DISCLOSURE_PROBLEM);
  for (const target of ["problem", DISCLOSURE_PROBLEM]) {
    f.visibility(target, "hidden");
    await denied(f.focus, `hidden-${target}`);
    f.visibility(target, "visible");
  }

  const now = new Date().toISOString();
  f.sql.query("INSERT INTO problems(id,created_at,updated_at) VALUES('P-BOUND',?,?)").run(now, now);
  const bound = await f.enroll("review-bound", "P-BOUND");
  await denied({ ...f.focus, fellow_id: bound.binding.fellowId }, "bound-elsewhere");
  await f.service.transitionFellow(
    f.receiver,
    {
      fellow_id: f.recruit.binding.fellowId,
      status: "paused",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    },
    { idempotencyKey: "pause-review-recruit" },
  );
  await denied(f.focus, "paused");
});

test("each open public writable state permits focus without silently joining the Fellow", async () => {
  const f = await fixture();
  const before = f.authority();
  for (const status of ["sharpening", "active", "dormant", "under-result-review"]) {
    f.sql.query("UPDATE problems SET status=? WHERE id=?").run(status, DISCLOSURE_PROBLEM);
    const response = await f.issue(f.focus, `eligible-${status}`);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(SponsorDirectiveReceiptSchema.parse(await response.json()).problem_id).toBe(
      DISCLOSURE_PROBLEM,
    );
    expect(f.authority()).toEqual(before);
  }
});

test("recruitment rechecks visibility in its transaction and never leaves a partial receipt", async () => {
  const f = await fixture();
  let raced = false;
  let afterHide: ReturnType<typeof f.authority> | undefined;
  f.beforeBatch(() => {
    raced = true;
    f.visibility(DISCLOSURE_PROBLEM, "hidden");
    afterHide = f.authority();
  });
  const before = { authority: f.authority(), delivery: f.delivery() };
  const hidden = await f.issue(f.focus, "recruitment-race");
  expect(hidden.status, await hidden.clone().text()).toBe(404);
  expect(raced).toBe(true);
  if (afterHide === undefined)
    throw new Error("The concurrent hide did not capture its committed state");
  expect({ authority: f.authority(), delivery: f.delivery() }).toEqual({
    authority: afterHide,
    delivery: before.delivery,
  });
  f.visibility(DISCLOSURE_PROBLEM, "visible");
  const beforePartial = { authority: f.authority(), delivery: f.delivery() };

  // Exercise the repeated predicate after the notice INSERT, not only before
  // the batch. The final guard must roll back the notice and the raced change.
  f.sql.exec(
    "CREATE TEMP TRIGGER close_recruitment_after_notice AFTER INSERT ON fellow_inbox_notices " +
      "WHEN NEW.notice_type='sponsor_directive' AND NEW.problem_id='" +
      DISCLOSURE_PROBLEM +
      "' " +
      "BEGIN UPDATE problems SET admission_mode='invite-only' WHERE id=NEW.problem_id; END",
  );
  const partial = await f.issue(f.focus, "recruitment-race");
  expect(partial.status, await partial.clone().text()).toBe(404);
  expect({ authority: f.authority(), delivery: f.delivery() }).toEqual(beforePartial);
  expect(
    f.sql.query("SELECT admission_mode FROM problems WHERE id=?").get(DISCLOSURE_PROBLEM),
  ).toEqual({
    admission_mode: "open",
  });
  f.sql.exec("DROP TRIGGER close_recruitment_after_notice");
  const retry = await f.issue(f.focus, "recruitment-race");
  expect(retry.status, await retry.clone().text()).toBe(201);
});

test("a committed recruitment replays after a hide and concurrent identical requests deliver once", async () => {
  const f = await fixture();
  const responses = await Promise.all([
    f.issue(f.focus, "same-review"),
    f.issue(f.focus, "same-review"),
  ]);
  for (const response of responses) expect([200, 201]).toContain(response.status);
  const receipts = await Promise.all(
    responses.map(async (response) => SponsorDirectiveReceiptSchema.parse(await response.json())),
  );
  const [accepted, duplicate] = receipts;
  if (accepted === undefined || duplicate === undefined)
    throw new Error("Both concurrent requests must return a directive receipt");
  expect(accepted).toEqual(duplicate);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM sponsor_directives").get()).toEqual({ n: 1 });
  expect(
    f.sql
      .query("SELECT COUNT(*) AS n FROM fellow_inbox_notices WHERE fellow_id=?")
      .get(f.recruit.binding.fellowId),
  ).toEqual({ n: 1 });
  f.visibility("problem", "hidden");
  const before = { authority: f.authority(), delivery: f.delivery() };
  const replay = await f.issue(f.focus, "same-review");
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(SponsorDirectiveReceiptSchema.parse(await replay.json())).toEqual(accepted);
  const conflict = await f.issue(
    { ...f.focus, text: "A different review direction." },
    "same-review",
  );
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const fresh = await f.issue(f.focus, "new-review");
  expect(fresh.status).toBe(404);
  expect({ authority: f.authority(), delivery: f.delivery() }).toEqual(before);
});

test("global and already assigned steering retains its existing routing", async () => {
  const f = await fixture();
  const global = await f.issue(
    { fellow_id: f.recruit.binding.fellowId, verb: "focus", text: "Global research direction." },
    "global",
  );
  expect(global.status).toBe(201);
  expect(SponsorDirectiveReceiptSchema.parse(await global.json()).problem_id).toBeNull();
  const bound = await f.enroll("assigned-review", DISCLOSURE_PROBLEM);
  f.sql
    .query(
      "INSERT INTO problem_memberships(problem_id,fellow_id,role,joined_at) VALUES(?,?,'observer',?)",
    )
    .run(DISCLOSURE_PROBLEM, f.recruit.binding.fellowId, new Date().toISOString());
  f.sql
    .query("UPDATE problems SET admission_mode='invite-only',unlisted=1 WHERE id=?")
    .run(DISCLOSURE_PROBLEM);
  const before = f.authority();
  for (const selected of [f.recruit, bound]) {
    for (const verb of ["focus", "forbid", "unfocus"] as const) {
      const response = await f.issue(
        {
          fellow_id: selected.binding.fellowId,
          problem_id: DISCLOSURE_PROBLEM,
          verb,
          ...(verb === "unfocus" ? {} : { text: "Private assigned instruction." }),
        },
        `${selected.binding.fellowId}-${verb}`,
      );
      expect(response.status, await response.clone().text()).toBe(201);
      expect(SponsorDirectiveReceiptSchema.parse(await response.json()).problem_id).toBe(
        DISCLOSURE_PROBLEM,
      );
      expect(f.authority()).toEqual(before);
    }
  }
  const boundDefault = await f.issue(
    { fellow_id: bound.binding.fellowId, verb: "focus", text: "Keep the existing assignment." },
    "bound-default",
  );
  expect(boundDefault.status).toBe(201);
  expect(SponsorDirectiveReceiptSchema.parse(await boundDefault.json()).problem_id).toBe(
    DISCLOSURE_PROBLEM,
  );
  expect(f.authority()).toEqual(before);
});
