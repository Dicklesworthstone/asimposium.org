import { afterEach, expect, test } from "bun:test";
import { ProblemPublicationPreviewSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "../../../web/lib/service-envelope.ts";
import { createApp } from "../../src/app.ts";
import { toHex } from "../../src/auth/canonical.ts";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import type { Env } from "../../src/env.ts";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger.ts";
import { readProblemPublicationPreview } from "../../src/problems/publication-preview.ts";
import {
  FELLOW,
  PROBLEM,
  publicationContextFixture,
  SPONSOR,
} from "../support/publication-context.ts";

type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
type Problem = Parameters<typeof applyPublicProblemGovernance>[1];
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});
async function fixture() {
  const f = await publicationContextFixture();
  fixtures.push(f);
  f.sql
    .query(
      "UPDATE problems SET status = 'private-draft', created_by_fellow_id = ?, areas = '[\"algebra\"]', admission_mode = 'approval-required' WHERE id = ?",
    )
    .run(FELLOW, PROBLEM);
  return f;
}
const problem = (f: Fixture) =>
  f.sql.query("SELECT * FROM problems WHERE id = ?").get(PROBLEM) as Problem;
async function reviewed(f: Fixture) {
  const preview = await readProblemPublicationPreview(f.db, PROBLEM, SPONSOR);
  expect(preview).toBeDefined();
  if (!preview) throw new Error("publication preview missing");
  return {
    action: "publish" as const,
    reviewed_statement_version: preview.problem.current_statement_version,
    reviewed_digest: preview.review_digest,
  };
}
const request = (key: string) =>
  new Request(`https://a.asimposium.org/v1/sponsors/problems/${PROBLEM}/lifecycle`, {
    method: "POST",
    headers: { "idempotency-key": key },
  });

test("the mounted preview requires a signed exact-route sponsor read and never becomes anonymous draft access", async () => {
  const f = await fixture();
  const key = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in key)) throw new Error("Expected an Ed25519 key pair");
  const env = {
    DB: f.db,
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
    ENROLLMENT_REPLAY_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    SERVICE_ENVELOPE_KEYS: JSON.stringify([
      {
        kid: "publication-preview",
        notBefore: 0,
        publicKeyHex: toHex(new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey))),
      },
    ]),
  } as Env;
  const app = createApp();
  const path = `/v1/sponsors/problems/${PROBLEM}/publication-preview`;
  const get = async (
    principalId = SPONSOR,
    route = path,
    action = "problem-publication-preview",
    query = "",
  ) => {
    const envelope = await mintServiceEnvelope({
      privateKey: key.privateKey,
      kid: "publication-preview",
      now: Math.floor(Date.now() / 1000),
      method: "GET",
      route,
      action,
      principalId,
      body: "",
    });
    return app.request(
      `https://a.asimposium.org${route}${query}`,
      { headers: serviceEnvelopeHeaders(envelope) },
      env,
    );
  };
  const response = await get();
  expect(response.status).toBe(200);
  const preview = ProblemPublicationPreviewSchema.parse(await response.json());
  expect(preview.problem.statement).toBe("Exact public problem statement.");
  expect(preview.problem.publication_admission_mode).toBe("open");
  expect(preview.author).toMatchObject({ fellow_id: FELLOW, name: "context-0", session_id: null });
  expect(preview.acting_sponsor_id).toBe(SPONSOR);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(response.headers.get("etag")).toBeNull();
  expect((await app.request(`https://a.asimposium.org${path}`, {}, env)).status).toBe(403);
  expect((await get(SPONSOR, path, "list-sponsor-problems")).status).toBe(401);
  const foreign = await get("usr_foreign"),
    missing = await get("usr_foreign", path.replace(PROBLEM, "P-MISSING"));
  expect(foreign.status).toBe(404);
  expect(await foreign.text()).toBe(await missing.text());
  expect(foreign.headers.get("cache-control")).toBe("private, no-store");
  expect((await get(SPONSOR, path, "problem-publication-preview", "?version=1")).status).toBe(400);
  const publicRead = await app.request(`https://a.asimposium.org/v1/problems/${PROBLEM}`, {}, env);
  expect(publicRead.status).toBe(404);
  expect(await publicRead.text()).not.toContain("Exact public problem statement.");
  const lifecyclePath = path.replace("publication-preview", "lifecycle");
  const body = JSON.stringify({ action: "publish" });
  const envelope = await mintServiceEnvelope({
    privateKey: key.privateKey,
    kid: "publication-preview",
    now: Math.floor(Date.now() / 1000),
    method: "POST",
    route: lifecyclePath,
    action: "problem-lifecycle",
    principalId: SPONSOR,
    body,
  });
  const unpublished = await app.request(
    `https://a.asimposium.org${lifecyclePath}`,
    {
      method: "POST",
      body,
      headers: {
        ...serviceEnvelopeHeaders(envelope),
        "content-type": "application/json",
        "idempotency-key": "unreviewed-publication",
      },
    },
    env,
  );
  expect(unpublished.status).toBe(422);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
});

test("publication pins the complete reviewed formulation and retains the accepted exact retry", async () => {
  const f = await fixture(),
    command = await reviewed(f);
  const accepted = await applyPublicProblemGovernance(
    f.db,
    problem(f),
    SPONSOR,
    command,
    request("reviewed-publication"),
  );
  expect(accepted.status).toBe(200);
  const receipt = await accepted.json();
  expect(await readProblemPublicationPreview(f.db, PROBLEM, SPONSOR)).toBeUndefined();
  expect(problem(f).status).toBe("sharpening");
  const record = f.sql
    .query(
      "SELECT c.payload_json FROM events e JOIN event_content c ON c.event_id=e.id WHERE e.type='problem.admitted'",
    )
    .get() as { payload_json: string };
  expect(JSON.parse(record.payload_json).publication_review).toEqual({
    statement_version: command.reviewed_statement_version,
    digest: command.reviewed_digest,
  });
  const replay = await applyPublicProblemGovernance(
    f.db,
    problem(f),
    SPONSOR,
    command,
    request("reviewed-publication"),
  );
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
  expect(
    (
      await applyPublicProblemGovernance(
        f.db,
        problem(f),
        SPONSOR,
        { ...command, reviewed_digest: "f".repeat(64) },
        request("reviewed-publication"),
      )
    ).status,
  ).toBe(409);
});

test("changed formulation or visibility requires a new review before any public write or quota reservation", async () => {
  const f = await fixture(),
    command = await reviewed(f),
    before = f.state();
  f.sql
    .query(
      "INSERT INTO problem_statement_versions(problem_id,version,statement,norm_hash,falsifier,motivation,created_at) VALUES(?,2,'Changed statement','sha256:changed','Changed falsifier','Changed motivation',?)",
    )
    .run(PROBLEM, new Date().toISOString());
  f.sql.query("UPDATE problems SET current_statement_version = 2 WHERE id = ?").run(PROBLEM);
  let screens = 0;
  const refused = await applyPublicProblemGovernance(
    f.db,
    problem(f),
    SPONSOR,
    command,
    request("stale-statement"),
    {
      sponsorLimit: 100,
      screen: async () => {
        screens++;
        return new Response(null, { status: 202 });
      },
    },
  );
  expect(refused.status).toBe(409);
  expect(screens).toBe(0);
  expect(f.state()).toEqual(before);
  const revised = await reviewed(f);
  f.sql.query("UPDATE problems SET unlisted = 1 WHERE id = ?").run(PROBLEM);
  expect(
    (
      await applyPublicProblemGovernance(
        f.db,
        problem(f),
        SPONSOR,
        revised,
        request("stale-visibility"),
      )
    ).status,
  ).toBe(409);
  expect(
    (await readProblemPublicationPreview(f.db, PROBLEM, SPONSOR))?.problem
      .publication_admission_mode,
  ).toBe("approval-required");
  expect(f.sql.query("SELECT COUNT(*) AS n FROM public_write_attempt_reservations").get()).toEqual({
    n: 0,
  });
});

test("a governance race after preview validation rolls back the complete publication transaction", async () => {
  const f = await fixture(),
    command = await reviewed(f),
    before = f.state();
  let raced = false;
  const db = {
    prepare: f.db.prepare.bind(f.db),
    async batch(statements: Parameters<D1Database["batch"]>[0]) {
      if (!raced) {
        raced = true;
        f.sql
          .query("UPDATE problems SET unlisted = 1, areas='[\"number-theory\"]' WHERE id = ?")
          .run(PROBLEM);
      }
      return f.db.batch(statements);
    },
  } as D1Database;
  const response = await applyPublicProblemGovernance(
    db,
    problem(f),
    SPONSOR,
    command,
    request("publication-race"),
  );
  expect(raced).toBe(true);
  expect(response.status).toBe(409);
  expect(f.state()).toEqual(before);
  expect(problem(f).status).toBe("private-draft");
  expect(f.sql.query("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 0 });
});

test("publication refuses a stale router snapshot even if the caller reviewed newer metadata", async () => {
  const f = await fixture(),
    old = problem(f);
  f.sql.query("UPDATE problems SET areas='[\"number-theory\"]' WHERE id = ?").run(PROBLEM);
  const command = await reviewed(f);
  const response = await applyPublicProblemGovernance(
    f.db,
    old,
    SPONSOR,
    command,
    request("stale-router"),
  );
  expect(response.status).toBe(409);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
});

test("preview grants are scoped to current stewards and an active accountable author", async () => {
  const f = await fixture();
  f.sql
    .query("INSERT INTO sponsors(sponsor_id,created_at,last_seen_at) VALUES('usr_steward',?,?)")
    .run(Date.now(), Date.now());
  expect(await readProblemPublicationPreview(f.db, PROBLEM, "usr_steward")).toBeUndefined();
  f.sql
    .query(
      "INSERT INTO problem_stewards(problem_id,sponsor_id,is_founding,created_at) VALUES(?,'usr_steward',0,?)",
    )
    .run(PROBLEM, new Date().toISOString());
  expect(
    (await readProblemPublicationPreview(f.db, PROBLEM, "usr_steward"))?.acting_sponsor_id,
  ).toBe("usr_steward");
  f.sql
    .query("UPDATE sponsors SET tombstoned_at = ? WHERE sponsor_id = 'usr_steward'")
    .run(Date.now());
  expect(await readProblemPublicationPreview(f.db, PROBLEM, "usr_steward")).toBeUndefined();
  await new D1EnrollmentStore(f.db).transitionFellow({
    sponsorId: SPONSOR,
    fellowId: FELLOW,
    toStatus: "paused",
    eventId: "LEV-01HZY8DNBAGPWGJFPND4NM3F7B",
    requestId: "a".repeat(64),
    effectiveAt: Date.now(),
  });
  expect(await readProblemPublicationPreview(f.db, PROBLEM, SPONSOR)).toBeUndefined();
});
