import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { SearchPageQuery } from "@asimposium/contracts/search-pagination";
import { SEARCH_PROBLEM_KEYS_SQL } from "../../src/search/window.ts";
import { searchPaginationFixture } from "./search-pagination-fixture.ts";

/** Executes the production window/page SQL and continuation checks. This is
 * local SQLite proof, not deployed D1 or the HTTP/Zod boundary. */
describe("public problem title discovery", () => {
  const fixtures: ReturnType<typeof searchPaginationFixture>[] = [];
  function fixture() {
    const value = searchPaginationFixture();
    fixtures.push(value);
    return value;
  }
  afterEach(() => {
    for (const value of fixtures.splice(0)) value.sqlite.close();
  });

  test("finds a research title without knowing its P-ID or having a published claim", async () => {
    const f = fixture();
    f.problem("P-A17", "active", 0, "Independent verification of graph coloring bounds");
    const page = await f.page({ q: "graph coloring", kind: "problem" });
    assert.deepEqual(page.items.map((item) => item.id), ["P-A17"]);
    assert.equal(page.items[0]?.title, "Independent verification of graph coloring bounds");
    assert.match(page.items[0]?.snippet ?? "", /graph coloring/);
    assert.equal(page.items[0]?.score_explanation, "problem_id_or_title_literal_match");
  });

  test("all-kind discovery still orders claims before title matches and Fellows", async () => {
    const f = fixture();
    f.claim("C-1", "test science");
    f.problem("P-A17", "active", 0, "test research");
    f.fellow("F-title-test", "test-fellow");
    const page = await f.page({ q: "test", kind: "all", limit: 50 });
    assert.deepEqual(page.items.map((item) => item.kind), ["claim", "problem", "fellow"]);
  });

  test("private, unlisted and currently hidden titles do not affect matches", async () => {
    const f = fixture();
    f.problem("P-PUBLIC", "active", 0, "Canary topic");
    f.problem("P-PRIVATE", "private-draft", 0, "Canary private");
    f.problem("P-UNLISTED", "active", 1, "Canary unlisted");
    f.problem("P-HIDDEN", "active", 0, "Canary hidden");
    f.sqlite.exec("INSERT INTO content_controls VALUES('P-HIDDEN','problem','hidden',1)");
    const page = await f.page({ q: "canary", kind: "problem" });
    assert.deepEqual(page.items.map((item) => item.id), ["P-PUBLIC"]);
    assert.equal(page.windowMatches, 1);
    assert.equal(page.cursor, null);
    for (const q of ["P-PRIVATE", "P-UNLISTED", "P-HIDDEN"]) {
      assert.equal((await f.page({ q, kind: "problem" })).windowMatches, 0);
    }
  });

  test("only the latest control governs hiding and restoration", async () => {
    const f = fixture();
    f.problem("P-A17", "active", 0, "Restored topic");
    f.sqlite.exec(`INSERT INTO content_controls VALUES
      ('P-A17','problem','hidden',1), ('P-A17','problem','visible',2),
      ('P-A17','C-1','hidden',1)`);
    assert.equal((await f.page({ q: "Restored", kind: "problem" })).windowMatches, 1);
    f.sqlite.exec("INSERT INTO content_controls VALUES('P-A17','problem','hidden',3)");
    assert.equal((await f.page({ q: "Restored", kind: "problem" })).windowMatches, 0);
  });

  for (const q of ["100%", "x_y", "x\\y", "' OR 1=1 --", "λ-calculus"]) {
    test(`matches the literal title query ${JSON.stringify(q)}`, async () => {
      const f = fixture();
      f.problem("P-A17", "active", 0, `A study of ${q}`);
      f.problem("P-B18", "active", 0, "Unrelated study of 1000 xay xy");
      const page = await f.page({ q, kind: "problem" });
      assert.deepEqual(page.items.map((item) => item.id), ["P-A17"]);
    });
  }

  test("pages tied titles deterministically without duplicate or lost problems", async () => {
    const f = fixture();
    for (const id of ["P-C19", "P-A17", "P-B18"])
      f.problem(id, "active", 0, "Shared topic");
    const query: SearchPageQuery = { q: "Shared", kind: "problem", limit: 2 };
    const first = await f.page(query);
    assert.deepEqual(first.items.map((item) => item.id), ["P-A17", "P-B18"]);
    assert.ok(first.cursor);
    const second = await f.page({ ...query, cursor: first.cursor });
    assert.deepEqual(second.items.map((item) => item.id), ["P-C19"]);
    assert.equal(second.cursor, null);
  });

  test("a title-only rename invalidates continuation even with unchanged sequence and timestamp", async () => {
    const f = fixture();
    f.problem("P-A17", "active", 0, "Shared topic A");
    f.problem("P-B18", "active", 0, "Shared topic B");
    const query: SearchPageQuery = { q: "Shared", kind: "problem", limit: 1 };
    const first = await f.page(query);
    assert.ok(first.cursor);
    f.sqlite.exec("UPDATE problems SET title='Shared renamed B' WHERE id='P-B18'");
    await assert.rejects(f.page({ ...query, cursor: first.cursor }), { reason: "changed" });
  });

  test("a title or visibility change during page composition never serves the stale window", async () => {
    for (const mutation of [
      "UPDATE problems SET title='Shared renamed A' WHERE id='P-A17'",
      "INSERT INTO content_controls VALUES('P-A17','problem','hidden',1)",
    ]) {
      const f = fixture();
      f.problem("P-A17", "active", 0, "Shared topic A");
      let reads = 0;
      f.setHook((sql) => {
        if (sql === SEARCH_PROBLEM_KEYS_SQL && ++reads === 2) f.sqlite.exec(mutation);
      });
      await assert.rejects(f.page({ q: "Shared", kind: "problem" }), { reason: "changed" });
    }
  });

  test("null or blank historical titles fall back to their public ID", async () => {
    const f = fixture();
    f.problem("P-A17");
    f.problem("P-B18", "active", 0, "   ");
    const page = await f.page({ q: "P-", kind: "problem" });
    assert.deepEqual(page.items.map((item) => item.title), ["P-A17", "P-B18"]);
  });

  test("an exact result is not duplicated when its title also matches", async () => {
    const f = fixture();
    f.problem("P-A17", "active", 0, "P-A17 research");
    const exact = {
      kind: "problem" as const, id: "P-A17", title: "P-A17 research",
      url: "https://asimposium.org/p/P-A17", snippet: "P-A17 research",
      match_type: "exact_reference" as const, score_explanation: "exact_problem_id",
    };
    const page = await f.page({ q: "P-A17", kind: "problem" }, [exact]);
    assert.deepEqual(page.items, [exact]);
    assert.equal(page.windowMatches, 1);
  });

  test("the 500-entry window remains bounded and discloses truncation", async () => {
    const f = fixture();
    for (let i = 0; i < 501; i++) f.problem(`P-${String(i).padStart(4, "0")}`, "active", 0, "Shared topic");
    const page = await f.page({ q: "Shared", kind: "problem", limit: 50 });
    assert.equal(page.windowMatches, 500);
    assert.equal(page.items.length, 50);
    assert.equal(page.truncated, true);
    assert.ok(page.cursor);
  });
});
