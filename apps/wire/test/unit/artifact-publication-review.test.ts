import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  ArtifactPublicationRetryReceiptSchema,
  ArtifactPublicationRetryRequestSchema,
  ArtifactPublicationStatusSchema,
} from "@asimposium/contracts/artifact-publications";
import { validatedProblem } from "../../src/http/envelope.ts";
import {
  handleArtifactPublicationHttp,
  type PublicationHttpOperations,
} from "../../src/krater/artifact-publication-http.ts";
import {
  deliverArtifactPublication,
  drainArtifactPublications,
} from "../../src/krater/artifact-publication-outbox.ts";
import { retryArtifactPublication } from "../../src/krater/artifact-publication-retry.ts";
import { artifactPublicationReviewReceiptValid } from "../../src/krater/artifact-publication-review.ts";
import {
  publicationHash,
  publicationStatus,
  readPublicationJob,
  requestArtifactPublication,
} from "../../src/krater/artifact-publication-store.ts";
import { readArtifactManifest } from "../../src/krater/artifact-store.ts";
import {
  decideScreeningAppeal,
  submitScreeningAppeal,
} from "../../src/moderation/appeals-store.ts";
import {
  operatorQuarantineCase,
  operatorQuarantineQueue,
} from "../../src/moderation/operator-http.ts";
import { decideScreeningCase, supersedePendingCase } from "../../src/moderation/store.ts";
import { publicationFixture } from "./artifact-publication-fixture.ts";

async function queued() {
  const f = await publicationFixture();
  const receipt = await requestArtifactPublication(
    f.options,
    f.actor,
    f.upload,
    f.input,
    "publish",
  );
  const options = {
    ...f.options,
    readUpload: (actor: typeof f.actor, id: string, at: number) =>
      readArtifactManifest(f.db, actor, id, at),
  };
  return { ...f, options, id: receipt.publication_id };
}
type Fixture = Awaited<ReturnType<typeof queued>>;
const job = async (f: Fixture) => {
  const result = await readPublicationJob(f.db, f.id);
  assert.ok(result);
  return result;
};
async function hold(
  f: Fixture,
  decision: "quarantine" | "reject" | "allow-with-warning" = "quarantine",
) {
  assert.equal(
    await deliverArtifactPublication(
      {
        ...f.drainer,
        screen: async (j, c) => ({
          ...(await f.drainer.screen(j, c)),
          decision,
          coarse_category: "dual-use-boundary",
        }),
      },
      f.id,
    ),
    "held",
  );
  const row = await job(f);
  assert.ok(row.review_case_id);
  return row.review_case_id;
}
async function approve(f: Fixture) {
  const row = await job(f);
  assert.ok(row.review_case_id);
  const decision = await decideScreeningCase(f.db, "operator-one", {
    caseId: row.review_case_id,
    decision: "release",
    reason: "The complete immutable artifact is legitimate reproducible research.",
  });
  assert.equal(decision.ok, true);
  return decision;
}
const retry = async (f: Fixture, key = "owner-consent", generation?: number, session = f.session) =>
  retryArtifactPublication(
    f.options,
    f.actor,
    f.id,
    {
      session_id: session,
      expected_retry_generation: generation ?? (await job(f)).retry_generation,
    },
    key,
  );
function control(f: Fixture, target = f.targetId, visibility = "hidden") {
  f.sql
    .query(`INSERT INTO content_controls SELECT ?,?,?,COALESCE(MAX(version),0)+1
    FROM content_controls WHERE problem_id=? AND target_ref=?`)
    .run(f.problem, target, visibility, f.problem, target);
}

for (const decision of ["quarantine", "reject", "allow-with-warning"] as const) {
  test(`${decision} artifact hold exposes exact private operator material and requires fresh owner release`, async () => {
    const f = await queued(),
      caseId = await hold(f, decision);
    const initial = await job(f),
      observation = initial.last_screen_json;
    const pending = ArtifactPublicationStatusSchema.parse(publicationStatus(initial));
    assert.equal(pending.delivery, "held");
    if (pending.delivery !== "held") throw new Error("expected held status");
    assert.deepEqual(pending.review, {
      case_id: caseId,
      state: "pending",
      sponsor_case_path: `/v1/sponsors/screening-cases/${caseId}`,
    });
    assert.equal(pending.recovery, null);
    const queue = await operatorQuarantineQueue(f.db),
      detail = await operatorQuarantineCase(f.db, caseId);
    assert.equal(queue.status, 200);
    assert.equal(detail.status, 200);
    const operator = (await detail.json()) as { candidate: { kind: string; statement: string } };
    assert.equal(operator.candidate.kind, "artifact-publication");
    assert.equal(await publicationHash(operator.candidate.statement), initial.screening_sha256);
    assert.equal(
      JSON.parse(operator.candidate.statement).items[0].text,
      new TextDecoder().decode(f.bytes),
    );
    assert.ok(!(await queue.text()).includes("theorem example"));
    assert.ok(!JSON.stringify(pending).includes("theorem example"));
    assert.equal(f.publicStore.writes(), 0);
    await approve(f);
    const notice = f.sql
      .query("SELECT detail FROM fellow_inbox_notices ORDER BY seq DESC LIMIT 1")
      .get() as { detail: string };
    assert.match(notice.detail, /publication status.*current owned session/);
    const accepted = ArtifactPublicationRetryReceiptSchema.parse(await retry(f));
    assert.equal(accepted.initial_delivery, "release-authorized");
    assert.equal(accepted.retry_generation, 0);
    if (accepted.initial_delivery !== "release-authorized")
      throw new Error("expected reviewed release");
    assert.equal(accepted.review_case_id, caseId);
    assert.equal(f.publicStore.writes(), 0);
    const authorized = await job(f);
    assert.equal(authorized.state, "release-authorized");
    assert.equal(authorized.screen_attempts, 1);
    assert.equal(authorized.last_screen_json, observation);
    assert.ok(authorized.screen_receipt_json);
    assert.equal(
      JSON.parse(authorized.screen_receipt_json).version,
      "artifact-publication-operator-review-v1",
    );
    assert.equal(JSON.parse(authorized.screen_receipt_json).provider_status, undefined);
    assert.equal(await artifactPublicationReviewReceiptValid(f.db, authorized), true);
    assert.equal(await deliverArtifactPublication(f.drainer, f.id), "published");
    assert.equal(f.screens(), 1);
    assert.equal(f.publicStore.writes(), 1);
    assert.equal(f.reservations(), 1);
    assert.equal(f.count("artifact_publication_review_releases"), 1);
    assert.deepEqual(await retry(f), accepted);
    assert.deepEqual(
      f.sql.query("SELECT state FROM artifact_publication_audit ORDER BY seq").all(),
      ["queued", "held", "release-authorized", "published"].map((state) => ({ state })),
    );
  });
}

test("exhausted three-call outage can be manually reviewed without another paid screen", async () => {
  const f = await queued();
  const drainer = {
    ...f.drainer,
    screen: async (
      j: Parameters<typeof f.drainer.screen>[0],
      c: Parameters<typeof f.drainer.screen>[1],
    ) => ({
      ...(await f.drainer.screen(j, c)),
      decision: "quarantine" as const,
      provider_status: "timeout" as const,
      coarse_category: "provider-unavailable",
    }),
  };
  for (let n = 0; n < 3; n++) {
    assert.equal(await deliverArtifactPublication(drainer, f.id), n === 2 ? "held" : "retry");
    f.advance(3_600_000);
  }
  assert.equal((await job(f)).screen_attempts, 3);
  await approve(f);
  await retry(f);
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "published");
  assert.equal(f.screens(), 3);
  assert.equal((await job(f)).screen_attempts, 3);
});

test("operator consent retains generation eight after all source recoveries", async () => {
  const f = await queued();
  for (let generation = 0; generation < 8; generation++) {
    control(f);
    assert.equal(await deliverArtifactPublication(f.drainer, f.id), "held");
    control(f, f.targetId, "visible");
    f.advance(1);
    const receipt = await retry(f, `binding-${generation}`, generation);
    assert.equal(receipt.initial_delivery, "queued");
  }
  await hold(f);
  await approve(f);
  const receipt = ArtifactPublicationRetryReceiptSchema.parse(
    await retry(f, "final-owner-consent", 8),
  );
  assert.equal(receipt.retry_generation, 8);
  assert.equal(receipt.initial_delivery, "release-authorized");
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "published");
  assert.equal(f.count("artifact_publication_retries"), 8);
  assert.deepEqual(
    f.sql
      .query(
        "SELECT state FROM artifact_publication_retry_audit WHERE retry_generation=8 ORDER BY seq",
      )
      .all(),
    ["queued", "held", "release-authorized", "published"].map((state) => ({ state })),
  );
});

test("model-only released case stays unavailable and cannot masquerade as operator approval", async () => {
  const f = await queued(),
    caseId = await hold(f);
  f.sql
    .query(
      "UPDATE screening_cases SET state='released',decided_at=?,decided_by='platform:model',decision_reason=? WHERE case_id=?",
    )
    .run(new Date().toISOString(), "A model-only decision is not operator review.", caseId);
  const status = ArtifactPublicationStatusSchema.parse(publicationStatus(await job(f)));
  assert.equal(status.delivery, "held");
  if (status.delivery !== "held") throw new Error("expected held");
  assert.equal(status.review?.state, "unavailable");
  assert.equal(status.recovery, null);
  await assert.rejects(() => retry(f), /CONFLICT/);
  assert.equal(f.publicStore.writes(), 0);
});

for (const state of ["rejected", "superseded"] as const) {
  test(`${state} artifact case cannot release bytes`, async () => {
    const f = await queued(),
      caseId = await hold(f);
    if (state === "rejected")
      await decideScreeningCase(f.db, "operator-one", {
        caseId,
        decision: "confirm_rejection",
        reason: "The complete material remains inappropriate for publication.",
      });
    else {
      const c = f.sql
        .query("SELECT input_digest FROM screening_cases WHERE case_id=?")
        .get(caseId) as { input_digest: string };
      await supersedePendingCase(f.db, f.actor.fellowId, f.problem, c.input_digest);
    }
    assert.equal((await job(f)).review_state, state);
    await assert.rejects(() => retry(f), /CONFLICT/);
    assert.equal(f.count("artifact_publication_review_releases"), 0);
    assert.equal(f.publicStore.writes(), 0);
  });
}

test("independent operator appeal release preserves the original rejection and both audits", async () => {
  const f = await queued(),
    caseId = await hold(f);
  await decideScreeningCase(f.db, "operator-one", {
    caseId,
    decision: "confirm_rejection",
    reason: "The initial reviewer confirmed a contextual policy hold.",
  });
  const appeal = await submitScreeningAppeal(
    f.db,
    f.actor.sponsorId,
    {
      case_id: caseId,
      statement: "The complete artifact contains a benign and reproducible research example.",
    },
    "sponsor-appeal",
  );
  await decideScreeningAppeal(
    f.db,
    "operator-two",
    {
      appeal_id: appeal.appeal_id,
      decision: "release",
      reason: "Independent review of the complete artifact confirms legitimate research.",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    },
    "appeal-decision",
  );
  assert.equal((await job(f)).review_state, "approved");
  const notice = f.sql
    .query("SELECT detail FROM fellow_inbox_notices ORDER BY seq DESC LIMIT 1")
    .get() as { detail: string };
  assert.match(notice.detail, /publication status.*current owned session/);
  await retry(f);
  const release = (await job(f)).screen_receipt_json;
  assert.ok(release);
  const receipt = JSON.parse(release);
  assert.equal(receipt.decision_kind, "operator-appeal");
  assert.equal(f.count("operator_audit"), 2);
  assert.equal(
    (
      f.sql.query("SELECT state FROM screening_cases WHERE case_id=?").get(caseId) as {
        state: string;
      }
    ).state,
    "rejected",
  );
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "published");
  assert.equal(f.screens(), 1);
});

test("same-key concurrent consent replays once and competing keys cannot duplicate authorization", async () => {
  const f = await queued();
  await hold(f);
  await approve(f);
  const receipts = await Promise.all(Array.from({ length: 12 }, () => retry(f)));
  assert.equal(new Set(receipts.map((r) => JSON.stringify(r))).size, 1);
  assert.equal(f.count("artifact_publication_review_releases"), 1);
  await assert.rejects(() => retry(f, "other-key"), /CONFLICT/);
  await assert.rejects(() => retry(f, "owner-consent", 1), /CONFLICT/);
  assert.equal(f.publicStore.writes(), 0);
});

test("approved artifact accepts a replacement active session and replays after session closure", async () => {
  const f = await queued();
  await hold(f);
  await approve(f);
  f.sql
    .query("UPDATE sessions SET closed_at=? WHERE session_id=?")
    .run(new Date(f.clock()).toISOString(), f.session);
  await assert.rejects(() => retry(f), /NOT_ALLOWED/);
  const session = `S-${"B".repeat(26)}`;
  f.sql
    .query("INSERT INTO sessions VALUES(?,?,?,?,?,NULL)")
    .run(
      session,
      f.actor.fellowId,
      f.problem,
      new Date(f.clock() - 1000).toISOString(),
      new Date(f.clock() + 100000).toISOString(),
    );
  const receipt = await retry(f, "owner-consent", 0, session);
  f.sql
    .query("UPDATE sessions SET closed_at=? WHERE session_id=?")
    .run(new Date(f.clock()).toISOString(), session);
  assert.deepEqual(await retry(f, "owner-consent", 0, session), receipt);
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "published");
});

for (const change of [
  "bytes",
  "missing-bytes",
  "evidence",
  "target",
  "publication",
  "private",
  "withdrawn",
  "hidden",
  "revoked",
  "membership",
  "sponsor",
] as const) {
  test(`approval cannot release after ${change} changes`, async () => {
    const f = await queued();
    await hold(f);
    await approve(f);
    if (change === "bytes") {
      const stored = f.privateStore.data.get(`cas/sha256/${f.digest}`);
      assert.ok(stored);
      stored.bytes = new TextEncoder().encode("changed content");
    }
    if (change === "missing-bytes") f.privateStore.data.delete(`cas/sha256/${f.digest}`);
    if (change === "evidence")
      f.sql.query("UPDATE event_content SET payload_json='{}' WHERE event_id='EV-1'").run();
    if (change === "target")
      f.sql.query("UPDATE event_content SET payload_json='{}' WHERE event_id=?").run(f.targetEvent);
    if (change === "publication")
      f.sql
        .query("UPDATE event_content SET payload_json='{}' WHERE event_id=?")
        .run((await job(f)).event_id);
    if (change === "private") f.sql.query("UPDATE problems SET status='private-draft'").run();
    if (change === "withdrawn")
      f.sql.query("INSERT INTO scientific_withdrawals VALUES('EV-1')").run();
    if (change === "hidden") control(f);
    if (change === "revoked") f.sql.query("UPDATE fellow_tokens SET revoked_at=?").run(f.clock());
    if (change === "membership") f.sql.query("DELETE FROM problem_memberships").run();
    if (change === "sponsor")
      f.sql.query("UPDATE enrollment_fellows SET sponsor_id='different-sponsor'").run();
    await assert.rejects(() => retry(f));
    assert.equal((await job(f)).state, "held");
    assert.equal(f.count("artifact_publication_review_releases"), 0);
    assert.equal(f.publicStore.writes(), 0);
  });
}

for (const change of ["source", "session", "revoke", "privacy"] as const) {
  test(`commit-time ${change} race atomically refuses reviewed release and its consent receipt`, async () => {
    const f = await queued();
    await hold(f);
    await approve(f);
    f.hooks.beforeRun = (sql) => {
      if (!sql.startsWith("INSERT INTO artifact_publication_review_releases")) return;
      f.hooks.beforeRun = undefined;
      if (change === "source")
        f.sql.query("UPDATE event_content SET payload_json='{}' WHERE event_id='EV-1'").run();
      if (change === "session") f.sql.query("UPDATE sessions SET closed_at='closed'").run();
      if (change === "revoke") f.sql.query("UPDATE fellow_tokens SET revoked_at=?").run(f.clock());
      if (change === "privacy") f.sql.query("UPDATE problems SET status='private-draft'").run();
    };
    await assert.rejects(() => retry(f));
    assert.equal((await job(f)).state, "held");
    assert.equal(f.count("artifact_publication_review_releases"), 0);
    assert.equal(f.publicStore.writes(), 0);
  });
}

test("a crash before case registration is repaired once without another screen", async () => {
  const f = await queued();
  let interrupted = true;
  f.hooks.beforeRun = (sql) => {
    if (interrupted && sql.startsWith("INSERT INTO artifact_publication_reviews")) {
      interrupted = false;
      throw new Error("modeled interruption");
    }
  };
  await deliverArtifactPublication(
    {
      ...f.drainer,
      screen: async (j, c) => ({
        ...(await f.drainer.screen(j, c)),
        decision: "quarantine" as const,
      }),
    },
    f.id,
  );
  assert.equal(f.count("screening_cases"), 1);
  assert.equal(f.count("artifact_publication_reviews"), 0);
  await drainArtifactPublications(f.drainer);
  await drainArtifactPublications(f.drainer);
  assert.equal(f.count("screening_cases"), 1);
  assert.equal(f.count("artifact_publication_reviews"), 1);
  assert.equal(f.count("moderation_log"), 1);
  assert.equal(f.screens(), 1);
});

test("a failed review registration backs off without monopolizing the pending queue", async () => {
  const f = await queued();
  f.hooks.beforeRun = (sql) => {
    if (sql.startsWith("INSERT INTO artifact_publication_reviews")) throw new Error("interruption");
  };
  await deliverArtifactPublication(
    {
      ...f.drainer,
      screen: async (j, c) => ({
        ...(await f.drainer.screen(j, c)),
        decision: "quarantine" as const,
      }),
    },
    f.id,
  );
  f.hooks.beforeRun = undefined;
  const original = f.privateStore.data.get(`cas/sha256/${f.digest}`);
  assert.ok(original);
  f.privateStore.data.delete(`cas/sha256/${f.digest}`);
  await drainArtifactPublications(f.drainer);
  assert.equal(f.count("artifact_publication_review_attempts"), 1);
  f.privateStore.data.set(`cas/sha256/${f.digest}`, original);
  await drainArtifactPublications(f.drainer);
  assert.equal(f.count("artifact_publication_reviews"), 0);
  f.advance(60001);
  await drainArtifactPublications(f.drainer);
  assert.equal(f.count("artifact_publication_reviews"), 1);
  assert.equal(f.screens(), 1);
});

test("uncertain reviewed public PUT reconciles without rescreening or duplicate copy", async () => {
  const f = await queued();
  await hold(f);
  await approve(f);
  await retry(f);
  let unavailable = true;
  f.publicStore.hooks.get = () => {
    if (unavailable) throw new Error("readback unavailable");
  };
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "retry");
  assert.equal((await job(f)).state, "release-authorized");
  assert.equal(f.publicStore.writes(), 1);
  unavailable = false;
  f.advance(3_600_000);
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "published");
  assert.equal(f.publicStore.writes(), 1);
  assert.equal(f.screens(), 1);
});

test("review and owner consent records are immutable, and a forged unaudited receipt cannot release", async () => {
  const f = await queued();
  await hold(f);
  await approve(f);
  assert.throws(
    () =>
      f.sql.query("UPDATE artifact_publication_reviews SET candidate_digest=?").run("a".repeat(64)),
    /IMMUTABLE/,
  );
  assert.throws(() => f.sql.query("DELETE FROM artifact_publication_reviews").run(), /IMMUTABLE/);
  const row = await job(f);
  assert.throws(
    () =>
      f.sql
        .query(`UPDATE artifact_publication_jobs SET state='release-authorized',
    released_at=updated_at,screen_receipt_json='{"version":"artifact-publication-operator-review-v1"}'
    WHERE publication_id=?`)
        .run(f.id),
    /STATE_CONFLICT/,
  );
  assert.equal((await job(f)).last_screen_json, row.last_screen_json);
  await retry(f);
  assert.throws(
    () =>
      f.sql
        .query("UPDATE artifact_publication_review_releases SET decision_digest=?")
        .run("a".repeat(64)),
    /IMMUTABLE/,
  );
  assert.throws(
    () => f.sql.query("DELETE FROM artifact_publication_review_releases").run(),
    /IMMUTABLE/,
  );
});

test("existing owner retry route returns a truthful validated release-authorized receipt", async () => {
  const f = await queued();
  await hold(f);
  await approve(f);
  const ops: PublicationHttpOperations = {
    authenticate: async () => f.actor,
    problem: validatedProblem,
    decodeRequest: () => undefined,
    decodeRetryRequest: (value) => {
      const p = ArtifactPublicationRetryRequestSchema.safeParse(value);
      return p.success ? p.data : undefined;
    },
    publish: async () => {
      throw new Error("unused");
    },
    retry: async (actor, id, input, key) =>
      ArtifactPublicationRetryReceiptSchema.parse(
        await retryArtifactPublication(f.options, actor, id, input, key),
      ),
    status: async () => ArtifactPublicationStatusSchema.parse(publicationStatus(await job(f))),
    manifest: async () => {
      throw new Error("unused");
    },
    evidence: async () => {
      throw new Error("unused");
    },
  };
  const request = () =>
    new Request(`https://a.asimposium.org/v1/artifact-publications/${f.id}/retry`, {
      method: "POST",
      headers: {
        authorization: "Bearer owner",
        "content-type": "application/json",
        "idempotency-key": "http-consent",
      },
      body: JSON.stringify({ session_id: f.session, expected_retry_generation: 0 }),
    });
  const response = await handleArtifactPublicationHttp(request(), ops);
  assert.ok(response);
  assert.equal(response.status, 202);
  assert.match(response.headers.get("cache-control") ?? "", /private/);
  const receipt = ArtifactPublicationRetryReceiptSchema.parse(await response.json());
  assert.equal(receipt.initial_delivery, "release-authorized");
  const replay = await handleArtifactPublicationHttp(request(), ops);
  assert.ok(replay);
  assert.deepEqual(await replay.json(), receipt);
  assert.equal(f.publicStore.writes(), 0);
});
