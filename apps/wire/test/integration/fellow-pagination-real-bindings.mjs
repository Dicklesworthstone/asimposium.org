import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContractProblemSchema,
  encodeNowPageCursor,
  FellowCardResponseSchema,
} from "@asimposium/contracts";
import { ensureProblem, writeLedgerEvent } from "../../src/krater/krater.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

const time = "2020-01-01T00:00:00.000Z";
const hash = (text) => createHash("sha256").update(text).digest("hex");

// Real HTTP enrollment/session/promotion plus explicit retained-history fixtures
// through Krater on actual D1. Fixtures do not prove current review admission,
// sponsor transfer, Google login, deployed caching or live model screening.
export async function seedFellowPagination({ call, enroll, fixtures, env }) {
  const name = "fellow-page-author";
  const sponsor = "usr_fellow_pages";
  const token = await enroll(name, sponsor);
  const fellow = (await call("/v1/hello", undefined, token)).fellow.fellow_id;
  const actualProblem = "P-FELLOW-LIVE";
  await fixtures.seedProblem(actualProblem);
  const session = await call(
    "/v1/sessions",
    { problem_id: actualProblem, intent: "prove" },
    token,
    201,
  );
  const sessionPath = `/v1/sessions/${session.session_id}`;
  const draft = await call(
    `${sessionPath}/workshop`,
    {
      type: "draft",
      title: "Finite parity claim",
      body_md: "FELLOW_PAGES_WORKSHOP_CANARY",
      relates_to: [],
    },
    token,
    201,
  );
  const actualClaim = await call(
    `${sessionPath}/promote`,
    {
      workshop_id: draft.workshop_id,
      kind: "conjecture",
      statement: "Every integer divisible by six is even.",
      falsifier: "An odd integer divisible by six.",
      relates_to: [],
    },
    token,
    201,
  );
  const actual = FellowCardResponseSchema.parse(await call(`/a/${name}.json`));
  assert.equal(actual.promoted_contributions[0].id, actualClaim.claim_id);
  assert.equal(actual.promoted_contributions[0].sponsor_at_event, sponsor);

  async function record(
    problem,
    kind,
    id,
    { version = 1, actor = fellow, invalid = false, at = time } = {},
  ) {
    const eventId = `EV-${problem}-${kind}-${id}-${version}`;
    const payload =
      kind === "claim"
        ? {
            claim_id: invalid ? "C-WRONG" : id,
            statement: `Retained ${problem} ${id} version ${version}.`,
          }
        : {
            target_claim_id: invalid ? "C-WRONG" : "C-TARGET",
            target_version: 1,
            tier: "T3",
            verdict: "inform",
            basis: `Retained ${problem} ${id} review.`,
          };
    const json = JSON.stringify(payload);
    const digest = hash(json);
    const result = await writeLedgerEvent(
      env.DB,
      {
        problemId: problem,
        eventId,
        idempotencyKey: eventId,
        requestDigest: digest,
        eventType:
          kind === "review" ? "review.created" : version === 1 ? "claim.created" : "claim.revised",
        objectKind: kind,
        objectId: id,
        objectVersion: version,
        payloadJson: json,
        createdAt: at,
        attribution: {
          fellowId: actor,
          sponsorId: actor === fellow ? "usr_historical_pages" : "usr_other_pages",
          sessionId: session.session_id,
          modelSelfDeclared: "retained-fixture",
          harness: "local-workerd",
        },
      },
      {
        statementsAfterEvent: ({ sequence, eventId }) =>
          kind === "claim"
            ? [
                ...(version === 1
                  ? [
                      env.DB.prepare(`INSERT INTO claims
        (id, problem_id, statement, payload_sha256, source_seq, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(
                        id,
                        problem,
                        payload.statement,
                        digest,
                        sequence,
                        at,
                      ),
                    ]
                  : []),
                env.DB.prepare(`INSERT INTO claim_versions
        (claim_id, problem_id, version, kind, statement, content_digest, editor_fellow_id, created_at)
        VALUES (?, ?, ?, 'conjecture', ?, ?, ?, ?)`).bind(
                  id,
                  problem,
                  version,
                  payload.statement,
                  `sha256:${digest}`,
                  actor,
                  at,
                ),
              ]
            : [
                env.DB.prepare(`INSERT INTO reviews
        (review_id, problem_id, target_claim_id, target_version, reviewer_fellow_id, tier,
         verdict, basis, body_md, created_at, source_event_id, source_seq)
        VALUES (?, ?, 'C-TARGET', 1, ?, 'T3', 'inform', ?, 'Retained fixture', ?, ?, ?)`).bind(
                  id,
                  problem,
                  actor,
                  payload.basis,
                  at,
                  eventId,
                  sequence,
                ),
              ],
      },
    );
    return { event_id: eventId, problem_id: problem, seq: result.seq, created_at: at, id, version };
  }
  const expectedContributions = [];
  const expectedReviews = [];
  const problems = [
    "P-FELLOW-A",
    "P-FELLOW-B",
    "P-FELLOW-PRIVATE",
    "P-FELLOW-UNLISTED",
    "P-FELLOW-UNPUBLISHED",
  ];
  for (const problem of problems) {
    await ensureProblem(env.DB, problem, time);
    await env.DB.prepare("UPDATE problems SET status = ?, unlisted = ? WHERE id = ?")
      .bind(
        problem.endsWith("PRIVATE") ? "private-draft" : "active",
        problem.endsWith("UNLISTED") ? 1 : 0,
        problem,
      )
      .run();
    await record(problem, "claim", "C-TARGET", { actor: "F-RETAINED-OTHER" });
    const visible = problem === "P-FELLOW-A" || problem === "P-FELLOW-B";
    for (let i = 1; i <= (visible ? 28 : 1); i++) {
      const contribution = await record(problem, "claim", `C-${i}`);
      const review = await record(problem, "review", `R-${i}`);
      if (visible) {
        expectedContributions.push(contribution);
        expectedReviews.push(review);
      }
    }
  }
  expectedContributions.push(await record("P-FELLOW-A", "claim", "C-1", { version: 2 }));
  // Deliberate projection lag only; immutable event bytes and guards stay intact.
  await env.DB.prepare(
    "UPDATE problems SET public_seq = 0 WHERE id = 'P-FELLOW-UNPUBLISHED'",
  ).run();
  const order = (a, b) =>
    b.created_at.localeCompare(a.created_at) ||
    a.problem_id.localeCompare(b.problem_id) ||
    b.seq - a.seq ||
    a.event_id.localeCompare(b.event_id);
  expectedContributions.sort(order);
  expectedReviews.sort(order);
  return { name, fellow, token, actual, record, expectedContributions, expectedReviews };
}

async function fellowPaginationJourney(context) {
  const { call, env, worker, origin, userAgent, fixtures, enroll } = context;
  const seeded = await seedFellowPagination(context);
  const { name, fellow, record, actual, expectedContributions, expectedReviews } = seeded;
  const key = (item) => `${item.problem_id}/${item.id ?? item.review_id}@${item.version ?? 1}`;
  const first = FellowCardResponseSchema.parse(await call(`/a/${name}.json`));
  assert.equal(first.promoted_contributions.length, 50);
  assert.equal(first.reviews.length, 50);
  assert.equal(
    first.calibration.conjectures_promoted,
    57,
    "Totals exclude revisions and private, unlisted or unpublished history",
  );
  assert.equal(first.calibration.theorems_attempted, 0);
  assert.equal(first.calibration.reviews_verified_survival, null);
  assert.ok(first.omitted.some((note) => note.includes("live traversal")));
  const query = {
    contributions_before: first.next_contributions_before,
    reviews_before: first.next_reviews_before,
  };
  assert.ok(query.contributions_before && query.reviews_before);
  const queryString = new URLSearchParams(query).toString();
  const second = FellowCardResponseSchema.parse(await call(`/a/${name}.json?${queryString}`));
  assert.equal(second.promoted_contributions.length, 8);
  assert.equal(second.reviews.length, 6);
  assert.equal(second.next_contributions_before, undefined);
  assert.equal(second.next_reviews_before, undefined);
  assert.deepEqual(second.calibration, first.calibration);
  assert.deepEqual(
    [...first.promoted_contributions, ...second.promoted_contributions].map(key),
    [...actual.promoted_contributions, ...expectedContributions].map(key),
  );
  assert.deepEqual([...first.reviews, ...second.reviews].map(key), expectedReviews.map(key));
  assert.ok([...first.reviews, ...second.reviews].every((r) => r.tier === "T1"));
  assert.ok(
    second.promoted_contributions.every((c) => c.sponsor_at_event === "usr_historical_pages"),
  );
  for (const field of ["contributions_before", "reviews_before"]) {
    const single = FellowCardResponseSchema.parse(
      await call(`/a/${name}.json?${new URLSearchParams({ [field]: query[field] })}`),
    );
    assert.deepEqual(
      single.promoted_contributions,
      field === "contributions_before"
        ? second.promoted_contributions
        : first.promoted_contributions,
    );
    assert.deepEqual(single.reviews, field === "reviews_before" ? second.reviews : first.reviews);
  }
  // An event before the boundary cannot displace the older page.
  await record("P-FELLOW-A", "claim", "C-NEW", { at: "2021-01-01T00:00:00.000Z" });
  const afterInsert = await call(`/a/${name}.json?${queryString}`);
  assert.deepEqual(afterInsert.promoted_contributions, second.promoted_contributions);
  assert.equal(
    afterInsert.calibration.conjectures_promoted,
    first.calibration.conjectures_promoted + 1,
  );
  const boundary = expectedReviews[49];
  const fabricated = encodeNowPageCursor({ ...boundary, event_id: "A" });
  const tie = await call(`/a/${name}.json?${new URLSearchParams({ reviews_before: fabricated })}`);
  assert.equal(key(tie.reviews[0]), key(boundary), "The final event-ID key compares strictly");

  const etags = new Map();
  for (const base of [`/a/${name}`, `/fellows/${fellow}`])
    for (const suffix of ["json", "md", "html"]) {
      const path = `${base}.${suffix}?${queryString}`;
      const response = await worker.fetch(`${origin}${path}`, {
        headers: { "User-Agent": userAgent },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
      const body = await response.text();
      for (const canary of [
        "FELLOW_PAGES_WORKSHOP_CANARY",
        "P-FELLOW-PRIVATE",
        "P-FELLOW-UNLISTED",
        "P-FELLOW-UNPUBLISHED",
        seeded.token,
      ])
        assert.ok(!body.includes(canary));
      if (suffix === "json") assert.deepEqual(JSON.parse(body), afterInsert);
      else {
        assert.ok(body.includes("Latest contributions"));
        assert.ok(body.includes("Latest reviews"));
        assert.ok(!body.includes("Older contributions"));
      }
      const etag = response.headers.get("etag");
      assert.ok(etag);
      etags.set(path, etag);
      const unchanged = await worker.fetch(`${origin}${path}`, {
        headers: { "User-Agent": userAgent, "If-None-Match": etag },
      });
      assert.equal(unchanged.status, 304);
      const head = await worker.fetch(`${origin}${path}`, {
        method: "HEAD",
        headers: { "User-Agent": userAgent },
      });
      assert.equal(head.headers.get("etag"), etag);
      assert.equal(await head.text(), "");
    }
  let rejected = 0;
  for (const query of [
    "contributions_before=",
    "reviews_before=",
    "before=unknown",
    "unknown=value",
    "reviews_before=invalid-secret-marker",
    `reviews_before=${encodeURIComponent(fabricated)}&reviews_before=${encodeURIComponent(fabricated)}`,
    "contributions_before=%5B%5D",
    `reviews_before=${"x".repeat(1025)}`,
  ]) {
    for (const base of [`/a/${name}.json`, `/fellows/${fellow}.md`]) {
      const response = await worker.fetch(`${origin}${base}?${query}`, {
        headers: { "User-Agent": userAgent },
      });
      assert.equal(response.status, 400);
      const problem = ContractProblemSchema.parse(await response.json());
      assert.equal(problem.code, "CURSOR_INVALID");
      assert.ok(!JSON.stringify(problem).includes("invalid-secret-marker"));
      rejected++;
    }
  }
  // Withdrawal invalidates every representation of the already visited older page.
  const withdrawn = expectedReviews.at(-1);
  await fixtures.redactPublicContent(withdrawn.event_id);
  for (const [path, etag] of etags) {
    const response = await worker.fetch(`${origin}${path}`, {
      headers: { "User-Agent": userAgent, "If-None-Match": etag },
    });
    assert.equal(response.status, 200);
    assert.notEqual(response.headers.get("etag"), etag);
    assert.ok(
      !(await response.text()).includes(`Retained ${withdrawn.problem_id} ${withdrawn.id} review.`),
    );
  }
  await env.DB.prepare("UPDATE problems SET unlisted = 1 WHERE id = 'P-FELLOW-B'").run();
  const hidden = await call(`/a/${name}.json?${queryString}`);
  assert.deepEqual(hidden.promoted_contributions, []);
  assert.deepEqual(hidden.reviews, []);

  // Fifty invalid legacy records must yield an empty but continuable page.
  const unreadableToken = await enroll("unreadable-page", "usr_unreadable_pages");
  const actor = (await call("/v1/hello", undefined, unreadableToken)).fellow.fellow_id;
  for (let i = 0; i <= 50; i++)
    await record("P-FELLOW-A", "review", `R-UNREADABLE-${i}`, { actor, invalid: i > 0 });
  const empty = await call("/a/unreadable-page.json");
  assert.deepEqual(empty.reviews, []);
  assert.ok(empty.next_reviews_before);
  assert.ok(empty.omitted.some((note) => note.includes("50 review records on this page")));
  const recovered = await call(
    `/a/unreadable-page.json?${new URLSearchParams({ reviews_before: empty.next_reviews_before })}`,
  );
  assert.equal(recovered.reviews.length, 1);
  assert.equal(recovered.reviews[0].review_id, "R-UNREADABLE-0");
  assert.equal(recovered.next_reviews_before, undefined);
  return {
    kind: "fellow-pagination-real-bindings",
    status: "pass",
    contributions: 58,
    reviews: 56,
    pages: 2,
    invalid_queries: rejected,
    conditional_faces: 6,
    empty_page_recovery: true,
    boundary:
      "actual D1/Workerd, one HTTP promotion and explicit retained-history fixtures; no deployed or fresh-agent acceptance",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLocalWorkerJourney(fellowPaginationJourney)
    .then((receipt) => {
      console.log(JSON.stringify(receipt));
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
