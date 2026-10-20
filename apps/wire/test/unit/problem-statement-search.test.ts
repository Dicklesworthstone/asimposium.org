import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readPublishedProblemFormulations } from "../../src/ledger/problem-formulation-read.ts";
import { SEARCH_PROBLEM_STATEMENT_KEYS_SQL } from "../../src/search/window.ts";
import { searchPaginationFixture } from "./search-pagination-fixture.ts";

/** Real local SQLite queries and canonical payload verification. These unit
 * regressions do not certify Cloudflare D1, the HTTP boundary or deployment. */
describe("current published problem statement discovery", () => {
  const fixtures: ReturnType<typeof searchPaginationFixture>[] = [];
  function fixture() {
    const f = searchPaginationFixture();
    fixtures.push(f);
    return f;
  }
  afterEach(() => {
    for (const f of fixtures.splice(0)) f.sqlite.close();
  });

  test("finds the scientific question before there are claims or matching title words", async () => {
    const f = fixture();
    const statement = "Determine the sharp graph coloring bound for this family.";
    f.formulation("P-A17", statement);
    // A mutable title is not the formulation returned for a statement match.
    f.sqlite.exec("UPDATE problems SET title='Retained unrelated title' WHERE id='P-A17'");
    const page = await f.page({ q: "graph coloring", kind: "problem" });
    assert.equal(page.windowMatches, 1);
    assert.deepEqual(page.items.map((item) => [item.kind, item.id]), [["problem", "P-A17"]]);
    assert.equal(page.items[0]?.title, "Published research");
    assert.equal(page.items[0]?.statement, statement);
    assert.equal(page.items[0]?.version, 1);
    assert.match(page.items[0]?.snippet ?? "", /^S@1 · .*graph coloring/);
    assert.equal(page.items[0]?.score_explanation, "current_published_statement_literal_match");
  });

  test("searches the current published version and never an obsolete statement", async () => {
    const f = fixture();
    f.formulation("P-A17", "The obsolete formulation asks about triangular lattices.");
    f.formulation("P-A17", "The revised formulation asks about graph coloring.", 2);
    assert.equal((await f.page({ q: "triangular", kind: "problem" })).windowMatches, 0);
    const page = await f.page({ q: "graph coloring", kind: "problem" });
    assert.equal(page.items[0]?.version, 2);
    assert.match(page.items[0]?.snippet ?? "", /^S@2 ·/);
  });

  test("a withdrawn current publication never falls back to an earlier matching version", async () => {
    const f = fixture();
    f.formulation("P-A17", "The original graph coloring problem.");
    const current = f.formulation("P-A17", "The revised graph coloring problem.", 2);
    f.sqlite.query("UPDATE event_content SET redacted_at='withdrawn' WHERE event_id=?").run(current.eventId);
    assert.equal((await f.page({ q: "graph coloring", kind: "problem" })).windowMatches, 0);
  });

  test("drafts and retained statement projections cannot become a second source", async () => {
    const f = fixture();
    f.problem("P-A17", "active", 0, "Research question");
    f.sqlite.exec(`CREATE TABLE problem_statement_versions(problem_id TEXT, version INTEGER, statement TEXT);
      INSERT INTO problem_statement_versions VALUES('P-A17',1,'unpublished-canary');
      CREATE TABLE workshop_objects(body TEXT);
      INSERT INTO workshop_objects VALUES('unpublished-canary');
      CREATE TABLE sponsor_problem_briefs(statement TEXT);
      INSERT INTO sponsor_problem_briefs VALUES('unpublished-canary');`);
    assert.equal((await f.page({ q: "unpublished-canary", kind: "problem" })).windowMatches, 0);
  });

  for (const visibility of ["private", "unlisted", "problem", "object", "version", "event"] as const) {
    test(`${visibility} scientific content is absent from matches and pagination`, async () => {
      const f = fixture();
      f.formulation("P-A17", "Public graph coloring question.");
      const hidden = f.formulation("P-B18", "Hidden graph coloring canary.");
      if (visibility === "private") {
        f.sqlite.exec("UPDATE problems SET status='private-draft' WHERE id='P-B18'");
      } else if (visibility === "unlisted") {
        f.sqlite.exec("UPDATE problems SET unlisted=1 WHERE id='P-B18'");
      } else {
        const ref = visibility === "problem" ? "problem" : visibility === "object" ? "P-B18"
          : visibility === "version" ? "P-B18@1" : `#${hidden.seq}`;
        f.sqlite.query("INSERT INTO content_controls VALUES('P-B18',?,'hidden',1)").run(ref);
      }
      const page = await f.page({ q: "graph coloring", kind: "problem", limit: 1 });
      assert.deepEqual(page.items.map((item) => item.id), ["P-A17"]);
      assert.equal(page.windowMatches, 1);
      assert.equal(page.cursor, null);
      assert.doesNotMatch(JSON.stringify(page), /Hidden|canary|P-B18/);
    });
  }

  test("an object restore does not override a separately hidden event", async () => {
    const f = fixture();
    const source = f.formulation("P-A17", "Graph coloring under independent constraints.");
    f.sqlite.query("INSERT INTO content_controls VALUES('P-A17',?,'hidden',1)").run(`#${source.seq}`);
    f.sqlite.exec(`INSERT INTO content_controls VALUES
      ('P-A17','P-A17','hidden',1), ('P-A17','P-A17','visible',2)`);
    assert.equal((await f.page({ q: "Graph coloring", kind: "problem" })).windowMatches, 0);
    f.sqlite.query("INSERT INTO content_controls VALUES('P-A17',?,'visible',2)").run(`#${source.seq}`);
    assert.equal((await f.page({ q: "Graph coloring", kind: "problem" })).windowMatches, 1);
  });

  test("hash-mismatched scientific bytes fail closed during page hydration", async () => {
    const f = fixture();
    const source = f.formulation("P-A17", "The graph coloring question.");
    f.sqlite.query("UPDATE event_content SET payload_json=? WHERE event_id=?").run(
      source.payload.replace("The graph coloring question.", "Forged graph coloring canary."), source.eventId,
    );
    await assert.rejects(f.page({ q: "graph coloring", kind: "problem" }), { reason: "changed" });
  });

  test("a correctly hashed but invalid governance payload cannot supply an excerpt", async () => {
    const f = fixture();
    const source = f.formulation("P-A17", "The graph coloring question.");
    const value = JSON.parse(source.payload);
    value.acting_principal = { type: "sponsor", id: "invalid-principal" };
    const payload = JSON.stringify(value);
    const digest = createHash("sha256").update(payload).digest("hex");
    f.sqlite.query("UPDATE events SET payload_sha256=? WHERE id=?").run(digest, source.eventId);
    f.sqlite.query("UPDATE event_content SET payload_sha256=?, payload_json=? WHERE event_id=?").run(
      digest, payload, source.eventId,
    );
    await assert.rejects(f.page({ q: "graph coloring", kind: "problem" }), { reason: "changed" });
  });

  for (const query of ["100%", "x_y", "x\\y", "' OR 1=1 --", "λ-calculus"]) {
    test(`statement search treats ${JSON.stringify(query)} literally`, async () => {
      const f = fixture();
      f.formulation("P-A17", `Determine the exact boundary for ${query}.`);
      f.formulation("P-B18", "Unrelated statement about 1000 xay xy.");
      assert.deepEqual((await f.page({ q: query, kind: "problem" })).items.map((item) => item.id), ["P-A17"]);
    });
  }

  test("a matching passage near the end remains visible in the bounded snippet", async () => {
    const f = fixture();
    f.formulation("P-A17", `${"Context. ".repeat(700)}Find the graph coloring obstruction.`);
    const page = await f.page({ q: "graph coloring", kind: "problem" });
    assert.match(page.items[0]?.snippet ?? "", /graph coloring obstruction/);
    assert.ok((page.items[0]?.snippet.length ?? 0) <= 2000);
  });

  test("title matches precede statement matches without duplicate problem identities", async () => {
    const f = fixture();
    f.claim("C-1", "graph coloring claim");
    f.problem("P-A17", "active", 0, "Graph coloring title");
    f.formulation("P-A17", "This graph coloring question also matches the title.");
    f.formulation("P-B18", "A separate graph coloring question.");
    f.fellow("F-matching", "graph coloring fellow");
    const page = await f.page({ q: "graph coloring", kind: "all", limit: 50 });
    assert.deepEqual(page.items.map((item) => [item.kind, item.id]), [
      ["claim", "C-1"], ["problem", "P-A17"], ["problem", "P-B18"], ["fellow", "F-matching"],
    ]);
  });

  test("a changed formulation invalidates continuation even when the query still matches", async () => {
    const f = fixture();
    f.formulation("P-A17", "Graph coloring question A.");
    f.formulation("P-B18", "Graph coloring question B.");
    const query = { q: "Graph coloring", kind: "problem" as const, limit: 1 };
    const first = await f.page(query);
    assert.ok(first.cursor);
    f.formulation("P-B18", "Graph coloring question B with sharper quantifiers.", 2);
    await assert.rejects(f.page({ ...query, cursor: first.cursor }), { reason: "changed" });
  });

  for (const mutation of ["hide", "unlist", "revise"] as const) {
    test(`${mutation} between hydration and final visibility check returns no stale page`, async () => {
      const f = fixture();
      f.formulation("P-A17", "Graph coloring question A.");
      let reads = 0;
      f.setHook((sql) => {
        if (sql !== SEARCH_PROBLEM_STATEMENT_KEYS_SQL || ++reads !== 2) return;
        if (mutation === "hide") {
          f.sqlite.exec("INSERT INTO content_controls VALUES('P-A17','P-A17@1','hidden',1)");
        } else if (mutation === "unlist") {
          f.sqlite.exec("UPDATE problems SET unlisted=1 WHERE id='P-A17'");
        } else {
          f.formulation("P-A17", "Graph coloring question A with changed quantifiers.", 2);
        }
      });
      await assert.rejects(f.page({ q: "Graph coloring", kind: "problem" }), { reason: "changed" });
    });
  }

  test("the window stays at 500 pins while only one page of bodies is hydrated", async () => {
    const f = fixture();
    for (let i = 0; i < 501; i++) {
      f.formulation(`P-${String(i).padStart(4, "0")}`, "Graph coloring in an independent family.");
    }
    const query = { q: "Graph coloring", kind: "problem" as const, limit: 50 };
    const first = await f.page(query);
    assert.equal(first.windowMatches, 500);
    assert.equal(first.items.length, 50);
    assert.equal(first.truncated, true);
    assert.ok(first.cursor);
    const bodyReads = f.calls.filter((call) => call.sql.includes("FROM selected JOIN problems p"));
    assert.equal(bodyReads.length, 1);
    assert.equal(JSON.parse(String(bodyReads[0]?.bindings[0])).length, 50);
    const second = await f.page({ ...query, cursor: first.cursor });
    assert.equal(second.items[0]?.id, "P-0050");
    assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 100);
  });

  test("the shared formulation page refuses duplicate or over-budget targets before reading", async () => {
    const f = fixture();
    const target = { problem_id: "P-A17", through: 1 };
    await assert.rejects(readPublishedProblemFormulations(f.db, [target, target]), /Invalid/);
    await assert.rejects(readPublishedProblemFormulations(f.db, Array(51).fill(target)), /bound/);
    assert.equal(f.calls.length, 0);
  });
});
