import { expect, test } from "bun:test";
import { ReviewListResponseSchema } from "@asimposium/contracts/research-lists";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../../src/env.ts";
import { loadReviewsList, ReviewsListReadError } from "../../src/ledger/reviews-list-read.ts";
import { createReviewListRoutes } from "../../src/ledger/reviews-list-router.ts";
import { appendClaimsListFixture } from "../support/claims-list-fixture.ts";
import { PROBLEM, publicationContextFixture } from "../support/publication-context.ts";
import { appendReviewsListFixture } from "../support/reviews-list-fixture.ts";

test("completed reviews traverse beyond 200 without mutable projections or moving their captured cut", async () => {
  const { db, sql } = await publicationContextFixture();
  try {
    await appendClaimsListFixture(db, PROBLEM, 1);
    for (let i = 1; i <= 205; i++) await appendReviewsListFixture(db, PROBLEM, i);
    expect(sql.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 0 });
    const first = (await loadReviewsList(db, PROBLEM)).face;
    expect(first).toMatchObject({ cursor: 206, count: 8, scanned_through: 9, next_after: 9 });
    await appendClaimsListFixture(db, PROBLEM, 1, 2);
    await appendReviewsListFixture(db, PROBLEM, 206, { target_version: 2 });
    const reviews = [...first.reviews];
    let after = first.next_after;
    let pages = 1;
    while (after !== null) {
      const page = (await loadReviewsList(db, PROBLEM, { through: first.cursor, after })).face;
      expect(page.cursor).toBe(206);
      expect(page.count).toBeLessThanOrEqual(8);
      reviews.push(...page.reviews);
      after = page.next_after;
      expect(++pages).toBeLessThanOrEqual(26);
    }
    expect(reviews.map((review) => review.review_id)).toEqual(
      Array.from({ length: 205 }, (_, i) => `R-${i + 1}`),
    );
    expect(reviews.every((review) => review.target.version === 1)).toBe(true);
    expect(pages).toBe(26);
    const latest = (await loadReviewsList(db, PROBLEM, { through: 208, after: 206 })).face;
    expect(latest.reviews).toHaveLength(1);
    expect(latest.reviews[0]).toMatchObject({ review_id: "R-206", target: { version: 2 } });
    await expect(loadReviewsList(db, PROBLEM, { after: 206 })).rejects.toMatchObject({
      code: "query",
    });
  } finally {
    sql.close();
  }
});

test("publication attribution and recorded tiers survive profile edits; legacy tiers stay unknown", async () => {
  const { db, sql } = await publicationContextFixture();
  try {
    await appendClaimsListFixture(db, PROBLEM, 1);
    for (let tier = 0; tier <= 3; tier++)
      await appendReviewsListFixture(db, PROBLEM, tier + 1, { tier: `T${tier}` });
    await appendReviewsListFixture(db, PROBLEM, 5, { independence_policy: undefined, tier: "T3" });
    sql
      .query("UPDATE enrollment_fellows SET model=?,harness=? WHERE fellow_id='F-CONTEXT'")
      .run("MUTABLE_MODEL_MUST_NOT_LEAK", "MUTABLE_HARNESS_MUST_NOT_LEAK");
    const face = (await loadReviewsList(db, PROBLEM)).face;
    expect(face.reviews.map((review) => review.independence_tier)).toEqual([0, 1, 2, 3, null]);
    expect(face.reviews[0]?.publication).toMatchObject({
      fellow_id: "F-CONTEXT",
      sponsor_id: "usr_context",
      session_id: "S-CONTEXT",
      model_self_declared: "review-publication-model",
      harness_self_declared: "review-publication-harness",
    });
    expect(JSON.stringify(face)).not.toContain("MUST_NOT_LEAK");
    expect(JSON.stringify(face)).not.toContain("complete public body");
  } finally {
    sql.close();
  }
});

test("hidden admissions advance, and exact parent controls and corrupt source hashes suppress summaries", async () => {
  const { db, sql } = await publicationContextFixture();
  try {
    await appendClaimsListFixture(db, PROBLEM, 1);
    for (let i = 1; i <= 10; i++) await appendReviewsListFixture(db, PROBLEM, i);
    for (let i = 1; i <= 8; i++)
      sql
        .query(`INSERT INTO content_controls
        (control_id,problem_id,target_kind,target_ref,visibility,source,reason_category,actor,reason,version,created_at)
        VALUES(?,?,'review',?,'hidden','operator','privacy','operator','fixture',1,?)`)
        .run(`CC-review-${i}`, PROBLEM, `R-${i}`, "2026-10-27T12:00:00.000Z");
    const first = (await loadReviewsList(db, PROBLEM, { through: 11 })).face;
    expect(first).toMatchObject({ count: 0, reviews: [], scanned_through: 9, next_after: 9 });
    expect(first.omitted).toEqual(["content_unavailable", "page_limit"]);
    expect(JSON.stringify(first)).not.toContain("R-1");
    const second = (await loadReviewsList(db, PROBLEM, { through: 11, after: 9 })).face;
    expect(second.reviews.map((review) => review.review_id)).toEqual(["R-9", "R-10"]);
    sql.exec("DROP TRIGGER event_content_lawful_redaction_only");
    sql
      .query("UPDATE event_content SET payload_json=? WHERE event_id=?")
      .run('{"basis":"CORRUPT_REVIEW"}', `EV-${PROBLEM}-REVIEW-9`);
    const corrupted = (await loadReviewsList(db, PROBLEM, { through: 11, after: 9 })).face;
    expect(corrupted.reviews.map((review) => review.review_id)).toEqual(["R-10"]);
    expect(JSON.stringify(corrupted)).not.toContain("CORRUPT_REVIEW");
    sql
      .query(`INSERT INTO content_controls
      (control_id,problem_id,target_kind,target_ref,visibility,source,reason_category,actor,reason,version,created_at)
      VALUES('CC-parent',?,'claim','C-1@1','hidden','operator','privacy','operator','fixture',1,?)`)
      .run(PROBLEM, "2026-10-27T12:00:00.000Z");
    const hiddenParent = (await loadReviewsList(db, PROBLEM, { through: 11, after: 9 })).face;
    expect(hiddenParent.reviews).toEqual([]);
    expect(hiddenParent.omitted).toEqual(["content_unavailable"]);
    expect(JSON.stringify(hiddenParent)).not.toContain("C-1");
  } finally {
    sql.close();
  }
});

test("missing and later parents cannot authorize a review; oversized source bytes never escape", async () => {
  const { db, sql } = await publicationContextFixture();
  try {
    await appendReviewsListFixture(db, PROBLEM, 1);
    await appendClaimsListFixture(db, PROBLEM, 1);
    await appendReviewsListFixture(db, PROBLEM, 2, { target_version: 2 });
    await appendReviewsListFixture(db, PROBLEM, 3);
    await appendReviewsListFixture(db, PROBLEM, 4);
    // Deliberately corrupt storage: production writes refuse sources above
    // 512KiB. Even damaged content must stay inside the read-side transfer cap.
    sql.exec("DROP TRIGGER event_content_lawful_redaction_only");
    sql
      .query("UPDATE event_content SET payload_json=? WHERE event_id=?")
      .run(JSON.stringify({ extra: "OVERSIZED".repeat(70_000) }), `EV-${PROBLEM}-REVIEW-3`);
    const face = (await loadReviewsList(db, PROBLEM)).face;
    expect(face.reviews.map((review) => review.review_id)).toEqual(["R-4"]);
    expect(face.omitted).toEqual(["content_unavailable"]);
    expect(JSON.stringify(face)).not.toContain("OVERSIZED");
    sql
      .query("UPDATE event_content SET payload_json=? WHERE event_id=?")
      .run(
        '{"claim_id":"C-1","kind":"definition","statement":"CORRUPT_PARENT"}',
        `EV-${PROBLEM}-1-1`,
      );
    expect((await loadReviewsList(db, PROBLEM)).face.reviews).toEqual([]);
  } finally {
    sql.close();
  }
});

test("a raw payload page budget withholds excess bodies while retaining a usable continuation", async () => {
  const { db, sql } = await publicationContextFixture();
  try {
    await appendClaimsListFixture(db, PROBLEM, 1);
    for (let i = 1; i <= 9; i++)
      await appendReviewsListFixture(db, PROBLEM, i, { extra: "x".repeat(220_000) });
    const first = (await loadReviewsList(db, PROBLEM)).face;
    expect(first.count).toBe(4);
    expect(first.next_after).toBe(9);
    expect(first.omitted).toEqual(["content_unavailable", "page_limit"]);
    const second = (await loadReviewsList(db, PROBLEM, { through: first.cursor, after: 9 })).face;
    expect(second.reviews.map((review) => review.review_id)).toEqual(["R-9"]);
    expect(second.next_after).toBeNull();
  } finally {
    sql.close();
  }
});

test("review HTTP faces pin continuations, validate cursors, and honor current controls before cache replies", async () => {
  const { db, sql } = await publicationContextFixture();
  const route = createReviewListRoutes();
  const request = (path: string, init?: RequestInit, database = db) =>
    route.fetch(new Request(`https://a.asimposium.org${path}`, init), { DB: database } as Env);
  try {
    await appendClaimsListFixture(db, PROBLEM, 1);
    for (let i = 1; i <= 9; i++) await appendReviewsListFixture(db, PROBLEM, i);
    const path = `/p/${PROBLEM}/reviews.json?through=10&after=0`;
    const first = await request(path);
    expect(first.status).toBe(200);
    expect(ReviewListResponseSchema.parse(await first.json()).next_after).toBe(9);
    expect(first.headers.get("content-location")).toBe(path);
    expect(first.headers.get("link")).toContain('/reviews.json?through=10&after=9>; rel="next"');
    const etag = first.headers.get("etag");
    if (etag === null) throw new Error("A successful review page must carry an ETag");
    expect((await request(path, { headers: { "if-none-match": etag } })).status).toBe(304);
    const head = await request(path, { method: "HEAD" });
    expect(head.headers.get("etag")).toBe(etag);
    expect(await head.text()).toBe("");
    for (const query of [
      "through=11",
      "after=0",
      "through=10&through=9",
      "through=010",
      "through=1&after=2",
      "limit=200",
      "through=9007199254740992",
      "through=-1",
    ]) {
      const response = await request(`/p/${PROBLEM}/reviews.json?${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ code: "CURSOR_INVALID", status: 400 });
    }
    const redirect = await request(`/p/${PROBLEM}/reviews?through=10&after=9`);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe(`/p/${PROBLEM}/reviews.md?through=10&after=9`);
    for (const format of ["md", "html"]) {
      const response = await request(`/p/${PROBLEM}/reviews.${format}?through=10&after=0`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("R-1");
      if (format === "html")
        expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    }
    sql
      .query("UPDATE event_content SET redacted_at=?,redaction_reason='privacy' WHERE event_id=?")
      .run("2026-10-28T12:00:00.000Z", `EV-${PROBLEM}-REVIEW-1`);
    const redacted = await request(path, { headers: { "if-none-match": etag } });
    expect(redacted.status).toBe(200);
    expect(ReviewListResponseSchema.parse(await redacted.json()).count).toBe(7);
    sql.query("UPDATE problems SET unlisted=1 WHERE id=?").run(PROBLEM);
    const unlisted = await request(path);
    expect(unlisted.headers.get("cache-control")).toBe("private, no-store");
    expect(unlisted.headers.get("x-robots-tag")).toContain("noindex");
    sql.query("UPDATE problems SET status='private-draft' WHERE id=?").run(PROBLEM);
    expect((await request(path, { headers: { "if-none-match": etag } })).status).toBe(404);
    expect(await (await request(path, { method: "HEAD" })).text()).toBe("");
  } finally {
    sql.close();
  }
});

test("a hide during response composition fails closed instead of serving a stale 304 or body", async () => {
  const { db, sql } = await publicationContextFixture();
  try {
    await appendClaimsListFixture(db, PROBLEM, 1);
    await appendReviewsListFixture(db, PROBLEM, 1);
    const read = await loadReviewsList(db, PROBLEM);
    // An unrelated later publication may arrive without moving the saved cut.
    await appendReviewsListFixture(db, PROBLEM, 2);
    await read.assertCurrent();
    let batches = 0;
    const race = {
      prepare: db.prepare.bind(db),
      batch: async (statements: Parameters<D1Database["batch"]>[0]) => {
        if (++batches === 2)
          sql
            .query("UPDATE event_content SET redacted_at=?,redaction_reason='privacy' WHERE event_id=?")
            .run("2026-10-28T12:00:00.000Z", `EV-${PROBLEM}-REVIEW-1`);
        return db.batch(statements);
      },
    } as D1Database;
    const response = await createReviewListRoutes().fetch(
      new Request(`https://a.asimposium.org/p/${PROBLEM}/reviews.json`, {
        headers: { "if-none-match": "*" },
      }),
      { DB: race } as Env,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("Checked the declared boundary");
    await expect(read.assertCurrent()).rejects.toBeInstanceOf(ReviewsListReadError);
  } finally {
    sql.close();
  }
});
