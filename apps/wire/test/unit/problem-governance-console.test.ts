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
