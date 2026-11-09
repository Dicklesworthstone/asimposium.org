import { expect, test } from "bun:test";
import { ClaimsListResponseSchema } from "@asimposium/contracts/claims-list";
import type { Env } from "../../src/env.ts";
import { writeLedgerEvent } from "../../src/krater/krater.ts";
import { loadClaimsList } from "../../src/ledger/claims-list-read.ts";
import { createLedgerFaceRoutes } from "../../src/ledger-face.ts";
import { appendClaimsListFixture } from "../support/claims-list-fixture.ts";
import { PROBLEM, publicationContextFixture } from "../support/publication-context.ts";

test("bounded claims traversal reaches every publication beyond the old 200-row truncation", async () => {
  const { db, sql } = await publicationContextFixture();
  try {
    for (let i = 1; i <= 205; i++) await appendClaimsListFixture(db, PROBLEM, i);
    const first = (await loadClaimsList(db, PROBLEM)).face;
    expect(first.cursor).toBe(205);
    expect(first.claims).toHaveLength(8);
    // A revision and a new claim after capture must not reorder historical pages.
    await appendClaimsListFixture(db, PROBLEM, 1, 2);
    await appendClaimsListFixture(db, PROBLEM, 206);
    const ids = first.claims.map((claim) => claim.id);
    let after = first.next_after;
    let pages = 1;
    while (after !== null) {
      const page = (await loadClaimsList(db, PROBLEM, { through: first.cursor, after })).face;
      expect(page.cursor).toBe(205);
      expect(page.claims.length).toBeLessThanOrEqual(8);
      ids.push(...page.claims.map((claim) => claim.id));
      after = page.next_after;
      expect(++pages).toBeLessThanOrEqual(26);
    }
    expect(ids).toEqual(Array.from({ length: 205 }, (_, index) => `C-${index + 1}`));
    expect(pages).toBe(26);
    expect((await loadClaimsList(db, PROBLEM, { through: 205 })).face.claims[0]).toMatchObject({
      id: "C-1",
      version: 1,
      source_seq: 1,
    });
    const latestTail = (await loadClaimsList(db, PROBLEM, { after: 205 })).face;
    expect(latestTail.claims.map((claim) => [claim.id, claim.version])).toEqual([
      ["C-1", 2],
      ["C-206", 1],
    ]);
  } finally {
    sql.close();
  }
});

test("all-withheld pages still advance and hidden revised heads never resurrect older text", async () => {
  const { db, sql } = await publicationContextFixture();
  try {
    for (let i = 1; i <= 10; i++) await appendClaimsListFixture(db, PROBLEM, i);
    for (let i = 1; i <= 8; i++)
      sql
        .query(`INSERT INTO content_controls
      (control_id,problem_id,target_kind,target_ref,visibility,source,reason_category,actor,reason,version,created_at)
      VALUES(?,?,'claim',?,'hidden','operator','privacy','operator','fixture',1,?)`)
        .run(`CC-${i}`, PROBLEM, `C-${i}`, "2026-10-27T12:00:00.000Z");
    const first = (await loadClaimsList(db, PROBLEM, { through: 10 })).face;
    expect(first).toMatchObject({ claims: [], count: 0, scanned_through: 8, next_after: 8 });
    expect(first.omitted).toEqual(["content_unavailable", "page_limit"]);
    expect(JSON.stringify(first)).not.toContain("C-1");
    expect(
      (await loadClaimsList(db, PROBLEM, { through: 10, after: 8 })).face.claims.map(
        (claim) => claim.id,
      ),
    ).toEqual(["C-9", "C-10"]);
    await appendClaimsListFixture(db, PROBLEM, 9, 2);
    sql
      .query(`INSERT INTO content_controls
      (control_id,problem_id,target_kind,target_ref,visibility,source,reason_category,actor,reason,version,created_at)
      VALUES('CC-version',?,'claim','C-9@2','hidden','operator','privacy','operator','fixture',1,?)`)
      .run(PROBLEM, "2026-10-27T12:00:00.000Z");
    const latest = (await loadClaimsList(db, PROBLEM, { after: 8 })).face;
    expect(latest.claims.map((claim) => claim.id)).toEqual(["C-10"]);
    expect(latest.omitted).toContain("content_unavailable");
    // The original exact version remains visible at a cut before the hidden revision.
    expect(
      (await loadClaimsList(db, PROBLEM, { through: 10, after: 8 })).face.claims[0]?.version,
    ).toBe(1);
    // Deliberately damaged storage fixture: production triggers refuse this
    // mutation. The reader must still detect bytes that fail their envelope hash.
    sql.exec("DROP TRIGGER event_content_lawful_redaction_only");
    sql
      .query("UPDATE event_content SET payload_json=? WHERE event_id=?")
      .run('{"claim_id":"C-10","kind":"definition","statement":"CORRUPT"}', `EV-${PROBLEM}-10-1`);
    const corrupted = (await loadClaimsList(db, PROBLEM, { after: 8 })).face;
    expect(corrupted.claims).toEqual([]);
    expect(JSON.stringify(corrupted)).not.toContain("CORRUPT");
    expect(JSON.stringify(corrupted)).not.toContain("distinguished endpoints");
  } finally {
    sql.close();
  }
});

test("HTTP faces validate cursors, pin links and recheck current visibility before conditional replies", async () => {
  const { db, sql } = await publicationContextFixture();
  const route = createLedgerFaceRoutes();
  const request = (path: string, init?: RequestInit) =>
    route.fetch(new Request(`https://a.asimposium.org${path}`, init), { DB: db } as Env);
  try {
    for (let i = 1; i <= 9; i++) await appendClaimsListFixture(db, PROBLEM, i);
    const path = `/p/${PROBLEM}/claims.json?through=9&after=0`;
    const first = await request(path);
    expect(first.status).toBe(200);
    expect(ClaimsListResponseSchema.parse(await first.json()).next_after).toBe(8);
    expect(first.headers.get("content-location")).toBe(path);
    expect(first.headers.get("link")).toContain(`/claims.json?through=9&after=8>; rel="next"`);
    const etag = first.headers.get("etag");
    if (etag === null) throw new Error("A successful collection response must carry an ETag");
    expect((await request(path, { headers: { "if-none-match": etag } })).status).toBe(304);
    const head = await request(path, { method: "HEAD" });
    expect(head.headers.get("etag")).toBe(etag);
    expect(await head.text()).toBe("");
    for (const query of [
      "through=10",
      "after=10",
      "through=9&through=8",
      "through=09",
      "through=1&after=2",
      "limit=200",
      "after=9007199254740992",
    ]) {
      const response = await request(`/p/${PROBLEM}/claims.json?${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ code: "CURSOR_INVALID", status: 400 });
    }
    sql
      .query("UPDATE event_content SET redacted_at=?,redaction_reason='privacy' WHERE event_id=?")
      .run("2026-10-28T12:00:00.000Z", `EV-${PROBLEM}-1-1`);
    const afterWithdrawal = await request(path, { headers: { "if-none-match": etag } });
    expect(afterWithdrawal.status).toBe(200);
    const bytes = await afterWithdrawal.text();
    const withdrawn = ClaimsListResponseSchema.parse(JSON.parse(bytes));
    expect(withdrawn.claims.some((claim) => claim.id === "C-1")).toBe(false);
    expect(withdrawn.count).toBe(7);
    expect(withdrawn.omitted).toContain("content_unavailable");
    sql.query("UPDATE problems SET unlisted=1 WHERE id=?").run(PROBLEM);
    const unlisted = await request(path);
    expect(unlisted.headers.get("cache-control")).toBe("private, no-store");
    expect(unlisted.headers.get("x-robots-tag")).toContain("noindex");
    sql.query("UPDATE problems SET status='private-draft' WHERE id=?").run(PROBLEM);
    expect((await request(path, { headers: { "if-none-match": etag } })).status).toBe(404);
  } finally {
    sql.close();
  }
});

test("over-budget scientific sources omit the entire assessment without suppressing readable neighbors", async () => {
  const { db, sql } = await publicationContextFixture();
  try {
    await appendClaimsListFixture(db, PROBLEM, 1);
    const body = "An untrusted evidence paragraph. ".repeat(600);
    const time = "2026-10-27T12:00:00.000Z";
    await writeLedgerEvent(
      db,
      {
        problemId: PROBLEM,
        eventId: "EV-CLAIMS-LARGE-EVIDENCE",
        idempotencyKey: "claims-large-evidence",
        requestDigest: "a".repeat(64),
        eventType: "evidence.created",
        objectKind: "evidence",
        objectId: "E-1",
        objectVersion: 1,
        createdAt: time,
        payloadJson: JSON.stringify({
          bears_on_kind: "claim",
          bears_on_id: "C-1",
          bears_on_version: 1,
          kind: "argument",
          direction: "informs",
          source: { kind: "model_memory" },
          mode: "exploratory",
          body_md: body,
        }),
        attribution: {
          fellowId: "F-CLAIMS-FIXTURE",
          sponsorId: "usr_claims_fixture",
          sessionId: "S-CLAIMS-FIXTURE",
          modelSelfDeclared: "synthetic",
          harness: "read-fixture",
        },
      },
      {
        statementsAfterEvent: (context) => [
          db
            .prepare(`INSERT INTO evidence
        (evidence_id,problem_id,bears_on_kind,bears_on_id,bears_on_version,direction,kind,source_kind,
         mode,computed_class,coercion_flags_json,author_fellow_id,body_md,created_at,source_event_id,source_seq)
        VALUES('E-1',?,'claim','C-1',1,'informs','argument','model_memory','exploratory','assertion','[]',
         'F-CLAIMS-FIXTURE',?,?,?,?)`)
            .bind(PROBLEM, body, time, context.eventId, context.sequence),
        ],
      },
    );
    await appendClaimsListFixture(db, PROBLEM, 2);
    const current = (await loadClaimsList(db, PROBLEM)).face;
    expect(current.claims.map((claim) => claim.id)).toEqual(["C-2"]);
    expect(current.omitted).toEqual(["standing_unavailable"]);
    expect(
      (await loadClaimsList(db, PROBLEM, { through: 1 })).face.claims.map((claim) => claim.id),
    ).toEqual(["C-1"]);
  } finally {
    sql.close();
  }
});

test("scientific history lookahead omits an overlong history without folding the first 128 events", async () => {
  const { db, sql } = await publicationContextFixture();
  try {
    for (let version = 1; version <= 129; version++)
      await appendClaimsListFixture(db, PROBLEM, 1, version);
    await appendClaimsListFixture(db, PROBLEM, 2);
    const face = (await loadClaimsList(db, PROBLEM)).face;
    expect(face.claims.map((claim) => claim.id)).toEqual(["C-2"]);
    expect(face.omitted).toEqual(["standing_unavailable"]);
    expect(face.scanned_through).toBe(130);
    expect((await loadClaimsList(db, PROBLEM, { through: 128 })).face.claims[0]).toMatchObject({
      id: "C-1",
      version: 128,
    });
  } finally {
    sql.close();
  }
});
