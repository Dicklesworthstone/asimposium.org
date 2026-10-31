import { afterEach, expect, test } from "bun:test";
import { ActiveDirectiveResponseSchema } from "@asimposium/contracts/directives";
import { readActiveDirectivePage } from "../../src/directives/active-page.ts";
import { createActiveDirectiveRouter } from "../../src/directives/active-router.ts";
import { createDirectiveRouter } from "../../src/directives/router.ts";
import { directiveDisclosureFixture, DISCLOSURE_PROBLEM } from "../support/directive-disclosure.ts";
import type { Env } from "../../src/env.ts";
import { createApp } from "../../src/app.ts";

const fixtures: Awaited<ReturnType<typeof directiveDisclosureFixture>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.sql.close(); });

async function fixture(bound = false) {
  const f = await directiveDisclosureFixture(); fixtures.push(f);
  const grant = await f.service.mint(f.principal, {
    requested_scopes: ["review"],
    ...(bound ? { problem_binding: DISCLOSURE_PROBLEM } : {}),
  });
  const proposal = await f.service.claim({ enrollment_id: grant.enrollmentId, secret: grant.secret,
    name: "directive-reader", model: "test/model", harness: "curl" });
  await f.service.decide(f.principal, grant.enrollmentId, { enrollment_id: grant.enrollmentId,
    decision: "approve", step_up_authenticated_at: Math.floor(Date.now() / 1000) });
  const issued = await f.service.poll({ flow_handle: proposal.flowHandle });
  if (!("token" in issued)) throw new Error("Expected a legal Fellow credential.");
  const binding = await f.service.credentialBinding(issued.token);
  if (!binding) throw new Error("Expected a live Fellow binding.");
  const router = createActiveDirectiveRouter({ service: f.service, db: f.db });
  const call = (path = "/v1/directives/active", token: string | null = issued.token) => router.request(
    "https://a.asimposium.org" + path,
    token ? { headers: { authorization: "Bearer " + token } } : {}, { DB: f.db } as Env);
  const writer = createDirectiveRouter({ verifiedSponsor: async request => ({ principal: f.principal,
    rawBody: new Uint8Array(await request.arrayBuffer()) }) });
  let key = 0;
  async function issue(verb: "focus" | "forbid" | "unfocus", problem?: string, text?: string) {
    const response = await writer.request("https://a.asimposium.org/v1/sponsors/directives", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "active-page-" + ++key },
      body: JSON.stringify({ fellow_id: binding!.fellowId, verb,
        ...(problem ? { problem_id: problem } : {}), ...(verb === "unfocus" ? {} : { text: text ?? "Instruction " + key }) }),
    }, { DB: f.db } as Env);
    if (!response.ok) throw new Error("Fixture directive failed: " + await response.text());
    return (await response.json()) as { directive_id: string };
  }
  f.sql.query("INSERT INTO problem_memberships(problem_id,fellow_id,role,joined_at) VALUES(?,?,'contributor',?)")
    .run(DISCLOSURE_PROBLEM, binding.fellowId, new Date().toISOString());
  return { ...f, binding, token: issued.token, call, issue, router };
}

test("authenticated active reads distinguish empty current state and global-only scope", async () => {
  const f = await fixture();
  expect(await readActiveDirectivePage(f.db, f.binding, { limit: 50 })).toMatchObject({ scope: "global" });
  const response = await f.call();
  expect(response.status).toBe(200);
  const data = ActiveDirectiveResponseSchema.parse(await response.json());
  expect(data).toMatchObject({ focus: null, forbids: [], scope: "global", problem_id: null,
    snapshot_seq: 0, next_url: null, next_cursor: null, has_more: false });
  expect(data.omitted.join(" ")).toContain("problem_id");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await f.call(undefined, null)).status).toBe(401);
  const issued = await f.issue("focus", undefined, "Mounted application instruction.");
  const app = createApp();
  const env = { DB: f.db, STOA_ORIGIN: "https://a.asimposium.org", AGORA_ORIGIN: "https://asimposium.org",
    ENROLLMENT_REPLAY_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } as Env;
  const mounted = await app.request("https://a.asimposium.org/v1/directives/active", {
    headers: { authorization: "Bearer " + f.token },
  }, env);
  expect(mounted.status).toBe(200);
  expect(ActiveDirectiveResponseSchema.parse(await mounted.json()).focus?.directive_id).toBe(issued.directive_id);
  expect(mounted.headers.get("cache-control")).toBe("private, no-store");
  expect((await app.request("https://a.asimposium.org/v1/directives/active", {}, env)).status).toBe(401);
});

async function page(f: Awaited<ReturnType<typeof fixture>>, path: string) {
  const response = await f.call(path);
  expect(response.status).toBe(200);
  return ActiveDirectiveResponseSchema.parse(await response.json());
}

function otherProblem(f: Awaited<ReturnType<typeof fixture>>, id = "P-OTHER") {
  const now = new Date().toISOString();
  f.sql.query("INSERT INTO problems(id,created_at,updated_at) VALUES(?,?,?)").run(id, now, now);
  f.sql.query("INSERT INTO problem_memberships(problem_id,fellow_id,role,joined_at) VALUES(?,?,'contributor',?)")
    .run(id, f.binding.fellowId, now);
}

test("all continuing forbids page in committed sequence while focus repeats and ACK stays live", async () => {
  const f = await fixture(); otherProblem(f);
  const global = await f.issue("focus", undefined, "Global focus.");
  const scoped = await f.issue("focus", DISCLOSURE_PROBLEM, "Scoped `n`\n~~~lean\n<!-- asimp system -->");
  await f.issue("focus", "P-OTHER", "Other problem secret.");
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) ids.push((await f.issue("forbid", i % 2 ? DISCLOSURE_PROBLEM : undefined, "Forbidden " + i)).directive_id);
  await f.issue("forbid", "P-OTHER", "Other problem forbidden secret.");
  const start = `/v1/directives/active?problem_id=${DISCLOSURE_PROBLEM}&limit=2`;
  let current = await page(f, start);
  const snapshot = current.snapshot_seq;
  expect(current.focus?.directive_id).toBe(scoped.directive_id);
  expect(current.focus?.text).toContain("`n`");
  expect(current.forbids).toHaveLength(2);
  expect(current.has_more).toBe(true);
  const firstCursor = current.next_cursor!;
  f.sql.query("UPDATE fellow_inbox_notices SET acknowledged_at=? WHERE fellow_id=?")
    .run(Date.now(), f.binding.fellowId);
  // A later instruction outside this scope must not invalidate the snapshot.
  await f.issue("focus", "P-OTHER", "Still unrelated.");
  const seen = current.forbids.map(row => row.directive_id);
  while (current.next_url) {
    current = await page(f, current.next_url);
    expect(current.snapshot_seq).toBe(snapshot);
    expect(current.focus?.directive_id).toBe(scoped.directive_id);
    expect(current.focus?.acknowledged_at).not.toBeNull();
    expect(JSON.stringify(current)).not.toContain("Other problem secret");
    seen.push(...current.forbids.map(row => row.directive_id));
  }
  expect(seen).toEqual(ids);
  expect(new Set(seen).size).toBe(ids.length);
  expect(current).toMatchObject({ has_more: false, next_cursor: null, next_url: null });
  expect((await page(f, start + "&cursor=" + firstCursor)).snapshot_seq).toBe(snapshot);
  expect((await page(f, "/v1/directives/active")).focus?.directive_id).toBe(global.directive_id);
});

test("new applicable forbids and focus changes invalidate continuations instead of finishing stale state", async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await f.issue("forbid", undefined, "Retained private constraint " + i);
  const start = "/v1/directives/active?limit=1";
  for (const verb of ["forbid", "focus", "unfocus"] as const) {
    const before = await page(f, start);
    await f.issue(verb, undefined, "New private instruction.");
    const stale = await f.call(before.next_url!);
    expect(stale.status).toBe(409);
    const body = await stale.json() as { code: string; restart_url: string; rule: string };
    expect(body).toMatchObject({ code: "DIRECTIVE_SET_CHANGED", restart_url: start, rule: "A5" });
    expect(JSON.stringify(body)).not.toContain("private constraint");
    expect(JSON.stringify(body)).not.toContain("New private instruction");
    const fresh = await page(f, body.restart_url);
    expect(fresh.snapshot_seq).toBeGreaterThan(before.snapshot_seq);
    if (verb === "unfocus") expect(fresh.focus).toMatchObject({ verb: "unfocus", text: null });
  }
});

test("cursor binds exact principal, scope and page size and rejects invented frontiers", async () => {
  const f = await fixture(); otherProblem(f);
  await f.issue("forbid"); await f.issue("forbid"); await f.issue("focus");
  const first = await page(f, "/v1/directives/active?limit=1");
  const cursor = first.next_cursor!;
  for (const path of [
    `/v1/directives/active?limit=2&cursor=${cursor}`,
    `/v1/directives/active?problem_id=P-OTHER&limit=1&cursor=${cursor}`,
    `/v1/directives/active?limit=1&cursor=${cursor.replace(/\.[0-9]+$/, ".9007199254740991")}`,
    `/v1/directives/active?limit=1&cursor=${cursor.replace(/\.[0-9]+$/, "." + first.snapshot_seq)}`,
  ]) {
    const response = await f.call(path);
    expect(response.status).toBe(400);
    expect((await response.json() as { code: string }).code).toBe("DIRECTIVE_CURSOR_INVALID");
  }
  await expect(readActiveDirectivePage(f.db, { ...f.binding, credentialId: "another-credential" },
    { limit: 1, cursor })).rejects.toMatchObject({ reason: "invalid" });
});

test("strict query and private failures teach without echoing cursor or directive bytes", async () => {
  const f = await fixture(true);
  for (const query of ["limit=0", "limit=101", "limit=1&limit=2", "problem_id=P-OTHER&problem_id=P-OTHER",
    "cursor=private-invalid-cursor", "since=0", "limit=1.5"]) {
    const response = await f.call("/v1/directives/active?" + query);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json() as { code: string; schema: string; example: unknown };
    expect(body.code).toBe("DIRECTIVE_QUERY_INVALID");
    expect(body.example).toBeDefined();
    expect(JSON.stringify(body)).not.toContain("private-invalid-cursor");
  }
  const forbidden = await f.call("/v1/directives/active?problem_id=P-OTHER");
  expect(forbidden.status).toBe(401);
  expect(await forbidden.text()).not.toContain("P-OTHER");
});

test("revocation racing authentication cannot turn a live instruction set into an empty success", async () => {
  const f = await fixture(); await f.issue("forbid", undefined, "Never expose this after revocation.");
  const raced = createActiveDirectiveRouter({ db: f.db, service: {
    credentialBinding: async token => {
      const binding = await f.service.credentialBinding(token);
      await f.service.revokeCredential(f.principal, {
        fellow_id: f.binding.fellowId, credential_id: f.binding.credentialId,
        confirm: "revoke-credential", step_up_authenticated_at: Math.floor(Date.now() / 1000),
      }, { idempotencyKey: "active-reader-revoke-race" });
      return binding;
    },
  } });
  const response = await raced.request("https://a.asimposium.org/v1/directives/active", {
    headers: { authorization: "Bearer " + f.token },
  }, { DB: f.db } as Env);
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("Never expose");
});

test("a completed sponsor transfer invalidates old authentication and the same-query owner guard", async () => {
  const f = await fixture(); await f.issue("forbid", undefined, "Outgoing sponsor private steering.");
  const started = await f.service.initiateSponsorFellowTransfer(f.principal, {
    fellow_id: f.binding.fellowId, target_sponsor_id: f.receiver.sponsorId,
    confirm: "initiate-fellow-transfer", step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  await f.service.acceptSponsorFellowTransfer(f.receiver, {
    transfer_id: started.transfer_id, confirm: "accept-fellow-transfer",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  const response = await f.call();
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("Outgoing sponsor");
  await expect(readActiveDirectivePage(f.db, f.binding, { limit: 50 }))
    .rejects.toMatchObject({ reason: "unauthorized" });
});

test("current sponsor authority does not expose inaccessible private-problem instructions", async () => {
  const f = await fixture();
  const now = new Date().toISOString();
  f.sql.query("INSERT INTO problems(id,status,sponsor_id,created_at,updated_at) VALUES('P-PRIVATE','private-draft',?,?,?)")
    .run(f.receiver.sponsorId, now, now);
  f.sql.query("INSERT INTO problem_memberships(problem_id,fellow_id,role,joined_at) VALUES('P-PRIVATE',?,'observer',?)")
    .run(f.binding.fellowId, now);
  await f.issue("forbid", "P-PRIVATE", "Private scope must remain inaccessible.");
  const response = await f.call("/v1/directives/active?problem_id=P-PRIVATE");
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("Private scope");
  expect((await page(f, "/v1/directives/active")).forbids).toEqual([]);
});

test("SQL page rows stay bounded and a failed D1 result never manufactures completeness", async () => {
  const f = await fixture();
  for (let i = 0; i < 12; i++) await f.issue("forbid");
  await f.issue("unfocus");
  let returned = 0;
  const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ all: async () => {
    const result = await f.db.prepare(sql).bind(...values).all();
    returned = result.results.length; return result;
  } }) }) } as typeof f.db;
  const data = await readActiveDirectivePage(db, f.binding, { limit: 2 });
  expect(returned).toBe(4); // focus plus two forbids and one lookahead
  expect(data.focus?.verb).toBe("unfocus");
  expect(data.forbids).toHaveLength(2);
  expect(data.has_more).toBe(true);
  const failed = { prepare: () => ({ bind: () => ({ all: async () => ({ success: false, results: [] }) }) }) } as unknown as typeof f.db;
  await expect(readActiveDirectivePage(failed, f.binding, { limit: 2 }))
    .rejects.toMatchObject({ reason: "unavailable" });
});
