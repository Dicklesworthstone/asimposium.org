import { afterEach, expect, setSystemTime, test } from "bun:test";
import {
  ProblemAccessActionReceiptSchema,
  type ProblemLifecycleActionRequest,
  SponsorProblemGovernanceResponseSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "../../../web/lib/service-envelope.ts";
import { createApp } from "../../src/app.ts";
import { toHex } from "../../src/auth/canonical.ts";
import type { Env } from "../../src/env.ts";
import { hardDeletePrivateDraft } from "../../src/krater/retention.ts";
import {
  applyPrivateProblemAccessAction,
  replayPrivateProblemAccessAction,
} from "../../src/problems/access-actions.ts";
import { readSponsorProblemGovernance } from "../../src/problems/governance-read.ts";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger.ts";
import { readProblemPublicationPreview } from "../../src/problems/publication-preview.ts";
import {
  FELLOW,
  OTHER,
  PROBLEM,
  publicationContextFixture,
  SPONSOR,
} from "../support/publication-context.ts";

type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
type Problem = Parameters<typeof applyPublicProblemGovernance>[1];
const fixtures: Fixture[] = [];
afterEach(() => {
  setSystemTime();
  for (const fixture of fixtures.splice(0)) fixture.sql.close();
});
async function fixture() {
  const f = await publicationContextFixture();
  fixtures.push(f);
  f.sql
    .query(
      "UPDATE problems SET status='private-draft', created_by_fellow_id=?, admission_mode='approval-required' WHERE id=?",
    )
    .run(FELLOW, PROBLEM);
  return f;
}
const problem = (f: Fixture) =>
  f.sql.query("SELECT * FROM problems WHERE id=?").get(PROBLEM) as Problem;
const request = (key: string) =>
  new Request(`https://a.asimposium.org/v1/sponsors/problems/${PROBLEM}/lifecycle`, {
    method: "POST",
    headers: { "idempotency-key": key },
  });
const mode = (value: "open" | "invite-only" | "approval-required") => ({
  action: "set-admission-mode" as const,
  mode: value,
});
async function receipt(response: Response) {
  expect(response.status).toBe(200);
  return ProblemAccessActionReceiptSchema.parse(
    ((await response.json()) as { governance_action: unknown }).governance_action,
  );
}
async function signedApp(f: Fixture) {
  const key = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const env = {
    DB: f.db,
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
    ENROLLMENT_REPLAY_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    SERVICE_ENVELOPE_KEYS: JSON.stringify([
      {
        kid: "governance",
        notBefore: 0,
        publicKeyHex: toHex(new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey))),
      },
    ]),
  } as Env;
  const app = createApp();
  const call = async (
    path: string,
    action: string,
    sponsor = SPONSOR,
    command?: ProblemLifecycleActionRequest,
    idempotencyKey = "console-access",
    query = "",
  ) => {
    const method = command ? "POST" : "GET",
      body = command ? JSON.stringify(command) : "";
    const envelope = await mintServiceEnvelope({
      privateKey: key.privateKey,
      kid: "governance",
      now: Math.floor(Date.now() / 1000),
      method,
      route: path,
      action,
      principalId: sponsor,
      body,
    });
    return app.request(
      `https://a.asimposium.org${path}${query}`,
      {
        method,
        headers: {
          ...serviceEnvelopeHeaders(envelope),
          ...(command
            ? { "content-type": "application/json", "idempotency-key": idempotencyKey }
            : {}),
        },
        ...(command ? { body } : {}),
      },
      env,
    );
  };
  return { app, env, call };
}

test("signed governance read isolates member metadata and includes non-owner stewards in the console list", async () => {
  const f = await fixture(),
    { app, env, call } = await signedApp(f);
  f.sql
    .query("INSERT INTO sponsors(sponsor_id,created_at,last_seen_at) VALUES('usr_steward',?,?)")
    .run(Date.now(), Date.now());
  f.sql
    .query(
      "INSERT INTO problem_stewards(problem_id,sponsor_id,is_founding,created_at) VALUES(?,'usr_steward',0,?)",
    )
    .run(PROBLEM, new Date().toISOString());
  f.sql
    .query(
      "INSERT INTO problem_memberships(problem_id,fellow_id,role,joined_at) VALUES(?,?,'observer',?)",
    )
    .run(PROBLEM, FELLOW, new Date().toISOString());
  const path = `/v1/sponsors/problems/${PROBLEM}/governance`;
  const ownerResponse = await call(path, "problem-governance-read");
  expect(ownerResponse.status).toBe(200);
  expect(ownerResponse.headers.get("cache-control")).toBe("private, no-store");
  expect(ownerResponse.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  const owner = SponsorProblemGovernanceResponseSchema.parse(await ownerResponse.json());
  expect(owner.authority).toEqual({ owner: true, steward: false, can_edit_access: true });
  expect(owner.members.map((member) => member.fellow_id)).toEqual([FELLOW]);
  expect(JSON.stringify(owner)).not.toContain("context-1");
  expect(owner.member_counts).toEqual({ total: 1, observer: 1, contributor: 0, steward: 0 });
  const steward = SponsorProblemGovernanceResponseSchema.parse(
    await (await call(path, "problem-governance-read", "usr_steward")).json(),
  );
  expect(steward.authority).toEqual({ owner: false, steward: true, can_edit_access: true });
  const listed = (await (
    await call("/v1/sponsors/problems", "list-sponsor-problems", "usr_steward")
  ).json()) as { problems: { id: string }[] };
  expect(listed.problems.map((item) => item.id)).toContain(PROBLEM);
  const foreign = await call(path, "problem-governance-read", "usr_foreign");
  const absent = await call(
    path.replace(PROBLEM, "P-MISSING"),
    "problem-governance-read",
    "usr_foreign",
  );
  expect(foreign.status).toBe(404);
  expect(await foreign.text()).toBe(await absent.text());
  expect(foreign.headers.get("cache-control")).toBe("private, no-store");
  expect((await app.request(`https://a.asimposium.org${path}`, {}, env)).status).toBe(403);
  expect((await call(path, "list-sponsor-problems")).status).toBe(401);
  expect(
    (await call(path, "problem-governance-read", SPONSOR, undefined, "unused", "?after=x&after=y"))
      .status,
  ).toBe(400);
  expect(
    (
      await call(
        path,
        "problem-governance-read",
        SPONSOR,
        undefined,
        "unused",
        "?problem_id=P-FOREIGN",
      )
    ).status,
  ).toBe(400);
  f.sql
    .query("DELETE FROM problem_stewards WHERE problem_id=? AND sponsor_id='usr_steward'")
    .run(PROBLEM);
  expect((await call(path, "problem-governance-read", "usr_steward")).status).toBe(404);
  f.sql.query("UPDATE sponsors SET tombstoned_at=? WHERE sponsor_id=?").run(Date.now(), SPONSOR);
  expect(await readSponsorProblemGovernance(f.db, PROBLEM, SPONSOR)).toBeUndefined();
});

test("membership pages disclose their continuation and complete role counts without enumerating unrelated Fellows", async () => {
  const f = await fixture(),
    now = new Date().toISOString();
  for (let i = 0; i < 103; i++) {
    const id = `F-MEMBER-${String(i).padStart(3, "0")}`;
    const memberSponsor = `usr_member_${i}`;
    f.sql
      .query("INSERT INTO sponsors(sponsor_id,created_at,last_seen_at) VALUES(?,?,?)")
      .run(memberSponsor, Date.now(), Date.now());
    f.sql
      .query(
        "INSERT INTO enrollment_fellows(fellow_id,sponsor_id,name,model,harness,created_at) VALUES(?,?,?,'model','harness',?)",
      )
      .run(id, memberSponsor, `member-${i}`, Date.now());
    f.sql
      .query("INSERT INTO problem_memberships(problem_id,fellow_id,role,joined_at) VALUES(?,?,?,?)")
      .run(PROBLEM, id, i === 0 ? "steward" : i < 3 ? "observer" : "contributor", now);
  }
  const first = await readSponsorProblemGovernance(f.db, PROBLEM, SPONSOR);
  expect(first?.members).toHaveLength(100);
  expect(first?.has_more).toBe(true);
  expect(first?.next_after).toBe("F-MEMBER-099");
  expect(first?.member_counts).toEqual({ total: 103, observer: 2, contributor: 100, steward: 1 });
  const last = await readSponsorProblemGovernance(f.db, PROBLEM, SPONSOR, {
    after: first?.next_after ?? "",
  });
  expect(last?.members.map((member) => member.fellow_id)).toEqual([
    "F-MEMBER-100",
    "F-MEMBER-101",
    "F-MEMBER-102",
  ]);
  expect(last?.has_more).toBe(false);
  expect(last?.next_after).toBeNull();
  expect(last?.member_counts).toEqual(first?.member_counts);
  const { call } = await signedApp(f);
  const continuation = await call(
    `/v1/sponsors/problems/${PROBLEM}/governance/after/${encodeURIComponent(first?.next_after ?? "")}`,
    "problem-governance-read",
  );
  expect(continuation.status).toBe(200);
  expect(SponsorProblemGovernanceResponseSchema.parse(await continuation.json())).toEqual(last);
  expect(JSON.stringify(first)).not.toContain("context-0");
  f.sql.query("UPDATE problems SET status='retired' WHERE id=?").run(PROBLEM);
  expect(
    (await readSponsorProblemGovernance(f.db, PROBLEM, SPONSOR))?.authority.can_edit_access,
  ).toBe(false);
});

test("private access retries retain exact receipts without overwriting later decisions or emitting public events", async () => {
  const f = await fixture(),
    { call } = await signedApp(f);
  const path = `/v1/sponsors/problems/${PROBLEM}/lifecycle`;
  const first = await receipt(
    await call(path, "problem-lifecycle", SPONSOR, mode("invite-only"), "first-mode"),
  );
  expect(first).toMatchObject({
    action: "set-admission-mode",
    mode: "invite-only",
    problem_id: PROBLEM,
    event_id: null,
  });
  await receipt(await call(path, "problem-lifecycle", SPONSOR, mode("open"), "later-mode"));
  expect(
    await receipt(
      await call(path, "problem-lifecycle", SPONSOR, mode("invite-only"), "first-mode"),
    ),
  ).toEqual(first);
  expect(problem(f).admission_mode).toBe("open");
  expect(
    (await call(path, "problem-lifecycle", SPONSOR, mode("approval-required"), "first-mode"))
      .status,
  ).toBe(409);
  const add = {
    action: "manage-member" as const,
    operation: "set-role" as const,
    target_fellow_id: OTHER,
    role: "observer" as const,
  };
  const added = await receipt(await call(path, "problem-lifecycle", SPONSOR, add, "member-add"));
  expect(added).toMatchObject({ target_fellow_id: OTHER, operation: "set-role", role: "observer" });
  const removed = await receipt(
    await call(
      path,
      "problem-lifecycle",
      SPONSOR,
      { action: "manage-member", operation: "remove", target_fellow_id: OTHER },
      "member-remove",
    ),
  );
  expect(removed).toMatchObject({ target_fellow_id: OTHER, operation: "remove", role: null });
  expect(await receipt(await call(path, "problem-lifecycle", SPONSOR, add, "member-add"))).toEqual(
    added,
  );
  expect((await readSponsorProblemGovernance(f.db, PROBLEM, SPONSOR))?.members).toEqual([]);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
  expect(f.sql.query("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 0 });
  const preview = await readProblemPublicationPreview(f.db, PROBLEM, SPONSOR);
  if (!preview) throw new Error("missing publication preview");
  expect(
    (
      await applyPublicProblemGovernance(
        f.db,
        problem(f),
        SPONSOR,
        {
          action: "publish",
          reviewed_statement_version: preview.problem.current_statement_version,
          reviewed_digest: preview.review_digest,
        },
        request("publish-after-access"),
      )
    ).status,
  ).toBe(200);
  expect(
    await receipt(
      await call(path, "problem-lifecycle", SPONSOR, mode("invite-only"), "first-mode"),
    ),
  ).toEqual(first);
  expect(problem(f).admission_mode).toBe("open");
  expect(f.sql.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
});

test("commit-time loss of private stewardship aborts membership and replay together", async () => {
  const f = await fixture();
  f.sql
    .query("INSERT INTO sponsors(sponsor_id,created_at,last_seen_at) VALUES('usr_steward',?,?)")
    .run(Date.now(), Date.now());
  f.sql
    .query(
      "INSERT INTO problem_stewards(problem_id,sponsor_id,is_founding,created_at) VALUES(?,'usr_steward',0,?)",
    )
    .run(PROBLEM, new Date().toISOString());
  let raced = false;
  const db = {
    prepare: f.db.prepare.bind(f.db),
    async batch(statements: Parameters<D1Database["batch"]>[0]) {
      if (!raced) {
        raced = true;
        f.sql
          .query("DELETE FROM problem_stewards WHERE problem_id=? AND sponsor_id='usr_steward'")
          .run(PROBLEM);
      }
      return f.db.batch(statements);
    },
  } as D1Database;
  const denied = await applyPrivateProblemAccessAction(
    db,
    PROBLEM,
    "usr_steward",
    { action: "manage-member", operation: "set-role", target_fellow_id: OTHER },
    request("authority-race"),
  );
  expect(denied.status).toBe(409);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM problem_memberships").get()).toEqual({ n: 0 });
  expect(f.sql.query("SELECT COUNT(*) AS n FROM private_problem_access_replays").get()).toEqual({
    n: 0,
  });
});

test("public access receipts bind exact targets and removing a member affects only that workspace", async () => {
  const f = await fixture(),
    { call } = await signedApp(f);
  f.sql.query("UPDATE problems SET status='active' WHERE id=?").run(PROBLEM);
  await f.seedProblem("P-OTHER");
  f.sql
    .query(
      "INSERT INTO problem_memberships(problem_id,fellow_id,role,joined_at) VALUES('P-OTHER',?,'contributor',?)",
    )
    .run(OTHER, new Date().toISOString());
  const identityBefore = f.sql
    .query("SELECT * FROM enrollment_fellows WHERE fellow_id=?")
    .get(OTHER);
  const path = `/v1/sponsors/problems/${PROBLEM}/lifecycle`;
  const add = {
    action: "manage-member" as const,
    operation: "set-role" as const,
    target_fellow_id: OTHER,
    role: "contributor" as const,
  };
  const added = await receipt(await call(path, "problem-lifecycle", SPONSOR, add, "public-add"));
  expect(added.event_id).toStartWith("PG-");
  const removed = await receipt(
    await call(
      path,
      "problem-lifecycle",
      SPONSOR,
      { action: "manage-member", operation: "remove", target_fellow_id: OTHER },
      "public-remove",
    ),
  );
  expect(removed).toMatchObject({ action: "manage-member", target_fellow_id: OTHER, role: null });
  expect(await receipt(await call(path, "problem-lifecycle", SPONSOR, add, "public-add"))).toEqual(
    added,
  );
  expect(
    f.sql.query("SELECT problem_id,role FROM problem_memberships WHERE fellow_id=?").all(OTHER),
  ).toEqual([{ problem_id: "P-OTHER", role: "contributor" }]);
  expect(f.sql.query("SELECT * FROM enrollment_fellows WHERE fellow_id=?").get(OTHER)).toEqual(
    identityBefore,
  );
  expect(
    (
      await call(
        path,
        "problem-lifecycle",
        SPONSOR,
        { action: "manage-member", operation: "set-role", target_fellow_id: "F-MISSING" },
        "missing-member",
      )
    ).status,
  ).toBe(422);
  f.sql.query("UPDATE problems SET status='retired' WHERE id=?").run(PROBLEM);
  expect(
    (await call(path, "problem-lifecycle", SPONSOR, mode("open"), "closed-problem")).status,
  ).toBe(422);
});

test("private access receipts expire after 24 hours and journaled erasure prevents restored replay resurrection", async () => {
  const f = await fixture();
  const started = Date.now();
  await receipt(
    await applyPrivateProblemAccessAction(
      f.db,
      PROBLEM,
      SPONSOR,
      mode("invite-only"),
      request("expiring"),
    ),
  );
  setSystemTime(started + 25 * 60 * 60 * 1000);
  await receipt(
    await applyPrivateProblemAccessAction(
      f.db,
      PROBLEM,
      SPONSOR,
      mode("open"),
      request("expiring"),
    ),
  );
  expect(problem(f).admission_mode).toBe("open");
  expect(f.sql.query("SELECT COUNT(*) AS n FROM private_problem_access_replays").get()).toEqual({
    n: 1,
  });
  const retained = f.sql.query("SELECT * FROM private_problem_access_replays").get() as {
    problem_id: string;
    sponsor_id: string;
    key_hash: string;
    request_digest: string;
    receipt_json: string;
    created_at: string;
    expires_at: string;
  };
  await hardDeletePrivateDraft(f.db, PROBLEM, SPONSOR);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM private_problem_access_replays").get()).toEqual({
    n: 0,
  });
  expect(await readSponsorProblemGovernance(f.db, PROBLEM, SPONSOR)).toBeUndefined();
  expect(
    await replayPrivateProblemAccessAction(
      f.db,
      PROBLEM,
      SPONSOR,
      mode("open"),
      request("expiring"),
    ),
  ).toBeUndefined();
  expect(() =>
    f.sql
      .query("INSERT INTO private_problem_access_replays VALUES(?,?,?,?,?,?,?)")
      .run(
        retained.problem_id,
        retained.sponsor_id,
        retained.key_hash,
        retained.request_digest,
        retained.receipt_json,
        retained.created_at,
        retained.expires_at,
      ),
  ).toThrow("PRIVATE_PROBLEM_ACCESS_NOT_CURRENT");
});

test("account tombstoning removes private access receipts and blocks both reads and new commands", async () => {
  const f = await fixture();
  await receipt(
    await applyPrivateProblemAccessAction(
      f.db,
      PROBLEM,
      SPONSOR,
      mode("invite-only"),
      request("account-erased"),
    ),
  );
  expect(f.sql.query("SELECT COUNT(*) AS n FROM private_problem_access_replays").get()).toEqual({
    n: 1,
  });
  f.sql.query("UPDATE sponsors SET tombstoned_at=? WHERE sponsor_id=?").run(Date.now(), SPONSOR);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM private_problem_access_replays").get()).toEqual({
    n: 0,
  });
  expect(await readSponsorProblemGovernance(f.db, PROBLEM, SPONSOR)).toBeUndefined();
  expect(
    (
      await applyPrivateProblemAccessAction(
        f.db,
        PROBLEM,
        SPONSOR,
        mode("open"),
        request("after-account-erased"),
      )
    ).status,
  ).toBe(409);
  expect(problem(f).admission_mode).toBe("invite-only");
});

const lineageProblem = (f: Fixture, id: string) =>
  f.sql.query("SELECT * FROM problems WHERE id=?").get(id) as Problem;
const lineageAction = (
  f: Fixture,
  id: string,
  action: ProblemLifecycleActionRequest,
  key: string,
  db = f.db,
) => applyPublicProblemGovernance(db, lineageProblem(f, id), SPONSOR, action, request(key));
async function publishLineageProblem(f: Fixture, id = PROBLEM) {
  if (id !== PROBLEM) await f.seedProblem(id, "private-draft");
  f.sql.query("UPDATE problems SET created_by_fellow_id=? WHERE id=?").run(FELLOW, id);
  const preview = await readProblemPublicationPreview(f.db, id, SPONSOR);
  if (!preview) throw new Error("lineage publication preview missing");
  const response = await lineageAction(
    f,
    id,
    {
      action: "publish",
      reviewed_statement_version: preview.problem.current_statement_version,
      reviewed_digest: preview.review_digest,
    },
    `publish-${id}`,
  );
  expect(response.status, await response.clone().text()).toBe(200);
}
function lineageState(f: Fixture) {
  return {
    problems: f.sql.query("SELECT * FROM problems ORDER BY id").all(),
    events: f.sql.query("SELECT * FROM events ORDER BY problem_id,seq").all(),
    content: f.sql.query("SELECT * FROM event_content ORDER BY event_id").all(),
    statements: f.sql
      .query("SELECT * FROM problem_statement_versions ORDER BY problem_id,version")
      .all(),
    forks: f.sql.query("SELECT * FROM problem_forks ORDER BY problem_id").all(),
    merges: f.sql.query("SELECT * FROM problem_merges ORDER BY problem_id").all(),
    idempotency: f.sql.query("SELECT * FROM idempotency ORDER BY problem_id,idempotency_key").all(),
    checkpoints: f.sql
      .query("SELECT * FROM integrity_checkpoints ORDER BY problem_id,checkpoint_seq")
      .all(),
    outbox: f.sql.query("SELECT * FROM outbox ORDER BY id").all(),
    global: f.sql.query("SELECT * FROM public_cursor").all(),
  };
}
function beforeLineageBatch(f: Fixture, mutate: () => void | Promise<void>) {
  let happened = false;
  const db = {
    prepare: f.db.prepare.bind(f.db),
    async batch(statements: Parameters<D1Database["batch"]>[0]) {
      if (
        !happened &&
        statements.some((statement) =>
          /INSERT INTO idempotency/.test((statement as unknown as { text: string }).text),
        )
      ) {
        happened = true;
        await mutate();
      }
      return f.db.batch(statements);
    },
  } as D1Database;
  return { db, happened: () => happened };
}
function hideLineageSource(f: Fixture, id: string, target = "problem") {
  f.sql
    .query(`INSERT INTO content_controls(control_id,problem_id,target_kind,target_ref,
    visibility,source,reason_category,actor,reason,version,created_at)
    VALUES(?,?,'problem',?,'hidden','operator','privacy','operator-test',
    'Temporarily unavailable for review.',1,?)`)
    .run(`CC-${id}-${target}`, id, target, new Date().toISOString());
}

test("private draft forks cannot publish their source formulation through governance", async () => {
  const f = await fixture(),
    { call } = await signedApp(f);
  const before = lineageState(f);
  const response = await call(
    `/v1/sponsors/problems/${PROBLEM}/lifecycle`,
    "problem-lifecycle",
    SPONSOR,
    { action: "fork", title: "Private fork" },
    "private-fork",
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "OBJECT_VERSION_CONFLICT" });
  expect(lineageState(f)).toEqual(before);
});

test("forks freeze the parent's local event cursor and exact replay does not create another child", async () => {
  const f = await fixture();
  await publishLineageProblem(f);
  await publishLineageProblem(f, "P-UNRELATED");
  await f.write({ ...f.input("Unrelated public activity."), problemId: "P-UNRELATED" });
  const parentCursor = lineageProblem(f, PROBLEM).public_seq;
  const global = f.sql.query("SELECT cursor FROM public_cursor WHERE singleton=1").get() as {
    cursor: number;
  };
  expect(global.cursor).toBeGreaterThan(parentCursor);
  const action = { action: "fork", title: "Independent variant" } as const;
  const response = await lineageAction(f, PROBLEM, action, "fork-local-cursor");
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { forked_problem_id: string };
  const fork = f.sql
    .query("SELECT * FROM problem_forks WHERE problem_id=?")
    .get(body.forked_problem_id) as {
    parent_problem_id: string;
    parent_cursor: number;
    event_id: string;
  };
  expect(fork).toMatchObject({ parent_problem_id: PROBLEM, parent_cursor: parentCursor });
  expect(
    f.sql
      .query("SELECT forked_from_problem_id,forked_from_cursor,status FROM problems WHERE id=?")
      .get(body.forked_problem_id),
  ).toEqual({
    forked_from_problem_id: PROBLEM,
    forked_from_cursor: parentCursor,
    status: "private-draft",
  });
  const event = f.sql
    .query(`SELECT e.seq,c.payload_json FROM events e
    JOIN event_content c ON c.event_id=e.id WHERE e.id=?`)
    .get(fork.event_id) as {
    seq: number;
    payload_json: string;
  };
  expect(event.seq).toBe(parentCursor + 1);
  expect(JSON.parse(event.payload_json)).toMatchObject({
    parent_problem_id: PROBLEM,
    parent_cursor: parentCursor,
  });
  const beforeReplay = lineageState(f);
  expect(await (await lineageAction(f, PROBLEM, action, "fork-local-cursor")).json()).toEqual(body);
  expect(lineageState(f)).toEqual(beforeReplay);
});

test("a parent event committed after fork preparation refuses without a child or orphan event", async () => {
  const f = await fixture();
  await publishLineageProblem(f);
  let afterRace: ReturnType<typeof lineageState> | undefined;
  const race = beforeLineageBatch(f, async () => {
    await f.write(f.input("A concurrent parent contribution."));
    afterRace = lineageState(f);
  });
  const response = await lineageAction(
    f,
    PROBLEM,
    { action: "fork", title: "Racing fork" },
    "fork-race",
    race.db,
  );
  expect(race.happened()).toBe(true);
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({ code: "OBJECT_VERSION_CONFLICT" });
  expect(lineageState(f)).toEqual(afterRace);
});

test("fork publication rechecks current source controls after reading the public formulation", async () => {
  const f = await fixture();
  await publishLineageProblem(f);
  let afterRace: ReturnType<typeof lineageState> | undefined;
  const race = beforeLineageBatch(f, () => {
    hideLineageSource(f, PROBLEM);
    afterRace = lineageState(f);
  });
  const response = await lineageAction(
    f,
    PROBLEM,
    { action: "fork", title: "Hidden fork" },
    "fork-hidden-race",
    race.db,
  );
  expect(race.happened()).toBe(true);
  expect(response.status, await response.clone().text()).toBe(409);
  expect(lineageState(f)).toEqual(afterRace);
});

test("merges refuse unpublished, retired, redirected, hidden, or redacted canonical targets", async () => {
  for (const unavailable of [
    "missing",
    "draft",
    "unpublished",
    "retired",
    "redirected",
    "hidden",
    "version-hidden",
    "event-hidden",
    "redacted",
  ] as const) {
    const f = await fixture();
    await publishLineageProblem(f);
    const target = "P-CANONICAL";
    if (unavailable === "draft" || unavailable === "unpublished") {
      await f.seedProblem(target, unavailable === "draft" ? "private-draft" : "active");
    } else if (unavailable !== "missing") {
      await publishLineageProblem(f, target);
      if (unavailable === "retired") {
        f.sql.query("UPDATE problems SET status=? WHERE id=?").run(unavailable, target);
      } else if (unavailable === "redirected") {
        f.sql.query("UPDATE problems SET canonical_problem_id=? WHERE id=?").run(PROBLEM, target);
      } else if (
        unavailable === "hidden" ||
        unavailable === "version-hidden" ||
        unavailable === "event-hidden"
      ) {
        hideLineageSource(
          f,
          target,
          unavailable === "version-hidden"
            ? `${target}@1`
            : unavailable === "event-hidden"
              ? "#1"
              : "problem",
        );
      } else {
        f.sql
          .query(`UPDATE event_content SET payload_json='{}',redacted_at=?,redaction_reason='lawful removal'
          WHERE event_id IN (SELECT id FROM events WHERE problem_id=?)`)
          .run(new Date().toISOString(), target);
      }
    }
    const before = lineageState(f);
    const response = await lineageAction(
      f,
      PROBLEM,
      { action: "merge", canonical_problem_id: target },
      `merge-${unavailable}`,
    );
    expect(response.status, `${unavailable}: ${await response.clone().text()}`).toBe(409);
    expect(await response.json()).toMatchObject({ code: "OBJECT_VERSION_CONFLICT" });
    expect(lineageState(f), unavailable).toEqual(before);
  }
});

test("visible unlisted and resolved merge targets remain valid and retired sources retain exact retries", async () => {
  for (const status of ["sharpening", "resolved"]) {
    const f = await fixture();
    await publishLineageProblem(f);
    await publishLineageProblem(f, "P-CANONICAL");
    f.sql.query("UPDATE problems SET unlisted=1,status=? WHERE id='P-CANONICAL'").run(status);
    const action = { action: "merge", canonical_problem_id: "P-CANONICAL" } as const;
    const response = await lineageAction(f, PROBLEM, action, "merge-unlisted");
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json();
    expect(lineageProblem(f, PROBLEM)).toMatchObject({
      status: "retired",
      canonical_problem_id: "P-CANONICAL",
    });
    hideLineageSource(f, "P-CANONICAL");
    const beforeReplay = lineageState(f);
    expect(await (await lineageAction(f, PROBLEM, action, "merge-unlisted")).json()).toEqual(body);
    expect(lineageState(f)).toEqual(beforeReplay);
  }
});

test("canonical visibility lost between merge preflight and commit leaves source and lineage untouched", async () => {
  for (const change of ["hide", "retire", "revise"] as const) {
    const f = await fixture();
    await publishLineageProblem(f);
    await publishLineageProblem(f, "P-CANONICAL");
    let afterRace: ReturnType<typeof lineageState> | undefined;
    const race = beforeLineageBatch(f, () => {
      if (change === "hide") hideLineageSource(f, "P-CANONICAL");
      else if (change === "retire")
        f.sql.query("UPDATE problems SET status='retired' WHERE id='P-CANONICAL'").run();
      else
        f.sql.query("UPDATE problems SET current_statement_version=2 WHERE id='P-CANONICAL'").run();
      afterRace = lineageState(f);
    });
    const response = await lineageAction(
      f,
      PROBLEM,
      { action: "merge", canonical_problem_id: "P-CANONICAL" },
      `merge-race-${change}`,
      race.db,
    );
    expect(race.happened()).toBe(true);
    expect(response.status, `${change}: ${await response.clone().text()}`).toBe(409);
    expect(lineageState(f)).toEqual(afterRace);
  }
});

test("reciprocal merges cannot both commit after each target passed preflight", async () => {
  const f = await fixture();
  await publishLineageProblem(f);
  await publishLineageProblem(f, "P-CANONICAL");
  let afterWinner: ReturnType<typeof lineageState> | undefined;
  const race = beforeLineageBatch(f, async () => {
    const winner = await lineageAction(
      f,
      "P-CANONICAL",
      { action: "merge", canonical_problem_id: PROBLEM },
      "merge-winner",
    );
    expect(winner.status, await winner.clone().text()).toBe(200);
    afterWinner = lineageState(f);
  });
  const loser = await lineageAction(
    f,
    PROBLEM,
    { action: "merge", canonical_problem_id: "P-CANONICAL" },
    "merge-loser",
    race.db,
  );
  expect(race.happened()).toBe(true);
  expect(loser.status, await loser.clone().text()).toBe(409);
  expect(lineageState(f)).toEqual(afterWinner);
  expect(lineageProblem(f, PROBLEM).canonical_problem_id).toBeNull();
  expect(lineageProblem(f, "P-CANONICAL").canonical_problem_id).toBe(PROBLEM);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM problem_merges").get()).toEqual({ n: 1 });
});
