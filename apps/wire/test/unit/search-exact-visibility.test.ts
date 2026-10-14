import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { executeSearch, LEXICAL_SEARCH_UNAVAILABLE } from "../../src/search/service.ts";
import { SEARCH_CLAIM_KEYS_SQL, SEARCH_PROBLEM_KEYS_SQL } from "../../src/search/window.ts";
import { searchPaginationFixture } from "./search-pagination-fixture.ts";

/** Service-level regressions execute real query, cursor and fallback paths
 * over SQLite. They do not establish HTTP middleware or deployed D1 behavior. */
describe("exact search visibility and outage recovery", () => {
  const fixtures: ReturnType<typeof searchPaginationFixture>[] = [];
  function fixture() {
    const f = searchPaginationFixture();
    f.sqlite.exec("CREATE TABLE outbox(kind TEXT, state TEXT)");
    fixtures.push(f);
    return f;
  }
  afterEach(() => {
    for (const f of fixtures.splice(0)) f.sqlite.close();
  });
  const request = (q: string) => ({ q, kind: "all" as const, limit: 20 });

  test("exact ID and canonical URL retain the public title, without duplicates", async () => {
    const f = fixture();
    f.problem("P-A17", "active", 0, "P-A17 graph coloring bounds");
    for (const q of ["P-A17", "https://asimposium.org/p/P-A17"]) {
      const response = await executeSearch(f.db, request(q));
      assert.equal(response.total_matches, 1);
      assert.equal(response.items[0]?.title, "P-A17 graph coloring bounds");
      assert.equal(response.items[0]?.match_type, "exact_reference");
      assert.match(response.items[0]?.snippet ?? "", /graph coloring bounds/);
    }
  });

  test("hidden, unlisted and private exact references have the same no-match face as absence", async () => {
    const f = fixture();
    f.problem("P-HIDDEN", "active", 0, "Hidden canary");
    f.problem("P-UNLISTED", "active", 1, "Unlisted canary");
    f.problem("P-PRIVATE", "private-draft", 0, "Private canary");
    f.sqlite.exec("INSERT INTO content_controls VALUES('P-HIDDEN','problem','hidden',1)");
    const absent = await executeSearch(f.db, request("P-ABSENT"));
    for (const id of ["P-HIDDEN", "P-UNLISTED", "P-PRIVATE"]) {
      for (const q of [id, `https://asimposium.org/p/${id}`]) {
        const result = await executeSearch(f.db, request(q));
        assert.deepEqual({ ...result, q: "normalized" }, { ...absent, q: "normalized" });
      }
    }
  });

  test("a later restore makes the exact reference readable again", async () => {
    const f = fixture();
    f.problem("P-A17", "active", 0, "Restored research");
    f.sqlite.exec(`INSERT INTO content_controls VALUES
      ('P-A17','problem','hidden',1), ('P-A17','problem','visible',2)`);
    assert.equal((await executeSearch(f.db, request("P-A17"))).items[0]?.title, "Restored research");
  });

  test("legacy exact references without titles fall back to their ID", async () => {
    const f = fixture();
    for (const title of [null, "   "]) {
      f.problem("P-A17", "active", 0, title);
      f.sqlite.query("UPDATE problems SET title=? WHERE id='P-A17'").run(title);
      assert.equal((await executeSearch(f.db, request("P-A17"))).items[0]?.title, "P-A17");
    }
  });

  test("an unchanged exact reference survives a lexical failure with an explicit omission", async () => {
    const f = fixture();
    f.problem("P-A17", "active", 0, "Public research");
    f.setHook((sql) => {
      if (sql === SEARCH_CLAIM_KEYS_SQL) throw new Error("fixture lexical outage");
    });
    const result = await executeSearch(f.db, request("P-A17"));
    assert.equal(result.total_matches, 1);
    assert.equal(result.items[0]?.title, "Public research");
    assert.ok(result.omitted.some((item) => item.reason === LEXICAL_SEARCH_UNAVAILABLE));
    assert.equal(result.cursor, undefined);
  });

  for (const [label, mutation] of [
    ["hidden", "INSERT INTO content_controls VALUES('P-A17','problem','hidden',1)"],
    ["unlisted", "UPDATE problems SET unlisted=1 WHERE id='P-A17'"],
    ["private", "UPDATE problems SET status='private-draft' WHERE id='P-A17'"],
    ["renamed", "UPDATE problems SET title='Changed public research' WHERE id='P-A17'"],
  ] as const) {
    test(`a ${label} problem cannot escape through the lexical-outage fallback`, async () => {
      const f = fixture();
      f.problem("P-A17", "active", 0, "Public research");
      f.setHook((sql) => {
        if (sql === SEARCH_CLAIM_KEYS_SQL) {
          f.sqlite.exec(mutation);
          throw new Error("fixture lexical outage");
        }
      });
      await assert.rejects(executeSearch(f.db, request("P-A17")), { reason: "changed" });
    });
  }

  test("redacted exact claim content cannot escape through the outage fallback", async () => {
    const f = fixture();
    const event = f.claim("C-1", "Public claim canary", "P-A17");
    f.setHook((sql) => {
      if (sql === SEARCH_CLAIM_KEYS_SQL) {
        f.sqlite.query("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(event);
        throw new Error("fixture lexical outage");
      }
    });
    await assert.rejects(executeSearch(f.db, request("P-A17#C-1")), { reason: "changed" });
  });

  test("a failed exact recheck does not return the initially readable copy", async () => {
    const f = fixture();
    f.problem("P-A17", "active", 0, "Public research");
    let failed = false;
    f.setHook((sql) => {
      if (sql === SEARCH_CLAIM_KEYS_SQL) {
        failed = true;
        throw new Error("fixture lexical outage");
      }
      if (failed) throw new Error("fixture exact recheck unavailable");
    });
    await assert.rejects(executeSearch(f.db, request("P-A17")), /exact recheck unavailable/);
  });

  test("visibility changes on a healthy lexical path also fail closed", async () => {
    const f = fixture();
    f.problem("P-A17", "active", 0, "Public research");
    let changed = false;
    f.setHook((sql) => {
      if (sql === SEARCH_PROBLEM_KEYS_SQL && !changed) {
        changed = true;
        f.sqlite.exec("INSERT INTO content_controls VALUES('P-A17','problem','hidden',1)");
      }
    });
    await assert.rejects(executeSearch(f.db, request("P-A17")), { reason: "changed" });
  });

  test("an outage without an exact reference is not an empty search result", async () => {
    const f = fixture();
    f.setHook((sql) => {
      if (sql === SEARCH_CLAIM_KEYS_SQL) throw new Error("fixture lexical outage");
    });
    await assert.rejects(executeSearch(f.db, request("research")), /lexical outage/);
  });
});
