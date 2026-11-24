import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import type { SearchPageQuery } from "@asimposium/contracts/search-pagination";
import { searchQueryString } from "@asimposium/contracts/search-pagination";
import { executeSearch } from "../../src/search/service.ts";
import { searchPaginationFixture } from "./search-pagination-fixture.ts";

// These tests execute the actual search SQL and continuation logic in SQLite;
// the native lane exercises the production entry point on local Workerd/D1.
const fixtures: ReturnType<typeof searchPaginationFixture>[] = [];
function fixture() {
  const f = searchPaginationFixture();
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sqlite.close();
});

test("area and current lifecycle select claims, titles and published statements before paging", async () => {
  const f = fixture();
  f.problem("P-ACTIVE", "active", 0, "Spectral problem", ["algebra", "combinatorics"]);
  f.claim("C-1", "spectral bound", "P-ACTIVE");
  f.problem("P-STATEMENT", "active", 0, "Public formulation", ["algebra"]);
  f.formulation("P-STATEMENT", "The spectral bound holds for finite graphs.");
  f.problem("P-RESOLVED", "resolved", 0, "Spectral resolved", ["algebra"]);
  f.claim("C-2", "spectral bound", "P-RESOLVED");
  f.problem("P-OTHER", "active", 0, "Spectral arithmetic", ["number-theory"]);
  f.claim("C-3", "spectral bound", "P-OTHER");
  f.fellow("F-1", "spectral-fellow");
  const result = await executeSearch(f.db, {
    q: "spectral",
    kind: "all",
    limit: 20,
    area: "algebra",
    status: "active",
  });
  assert.deepEqual(
    result.items.map((item) => `${item.kind}:${item.id}`),
    ["claim:C-1", "problem:P-ACTIVE", "problem:P-STATEMENT"],
  );
  assert.equal(result.total_matches, 3);
  assert.ok(result.omitted.some((item) => item.reason === "problem_filters_applied"));
  assert.ok(
    result.next_actions.some((item) => item.label === "Search all areas and problem statuses"),
  );
  const resolved = await executeSearch(f.db, {
    q: "spectral",
    kind: "all",
    limit: 20,
    area: "algebra",
    status: "resolved",
  });
  assert.deepEqual(
    resolved.items.map((item) => `${item.kind}:${item.id}`),
    ["claim:C-2", "problem:P-RESOLVED"],
  );
});

test("exact IDs and canonical claim URLs obey the same problem filters", async () => {
  const f = fixture();
  f.problem("P-EXACT", "active", 0, "A bounded claim", ["algebra"]);
  f.claim("C-1", "bounded counterexample", "P-EXACT");
  for (const q of ["P-EXACT", "P-EXACT#C-1", "https://asimposium.org/p/P-EXACT/claims/C-1.json"]) {
    const query = {
      q,
      kind: "all" as const,
      limit: 20,
      area: "algebra",
      status: "active" as const,
    };
    const matching = await executeSearch(f.db, query);
    assert.equal(matching.items[0]?.match_type, "exact_reference");
    assert.equal((await executeSearch(f.db, { ...query, area: "number-theory" })).items.length, 0);
    assert.equal((await executeSearch(f.db, { ...query, status: "dormant" })).items.length, 0);
  }
});

test("matching filters cannot reveal hidden, unlisted or private sources", async () => {
  const f = fixture();
  for (const [id, status, unlisted] of [
    ["P-HIDDEN", "active", 0],
    ["P-UNLISTED", "active", 1],
    ["P-PRIVATE", "private-draft", 0],
  ] as const) {
    f.problem(id, status, unlisted, "Private spectral canary", ["algebra"]);
    f.claim("C-1", "Private spectral canary", id);
  }
  f.sqlite.exec("INSERT INTO content_controls VALUES('P-HIDDEN','problem','hidden',1)");
  const base = { kind: "all" as const, limit: 20, area: "algebra" };
  const absent = await executeSearch(f.db, { ...base, q: "P-ABSENT" });
  const normalizeQuery = (result: typeof absent) => ({
    ...result,
    q: "same",
    next_actions: result.next_actions.map((action) => {
      const url = new URL(action.href, "https://a.asimposium.org");
      if (url.searchParams.has("q")) url.searchParams.set("q", "same");
      return { ...action, href: `${url.pathname}${url.search}` };
    }),
  });
  for (const id of ["P-HIDDEN", "P-UNLISTED", "P-PRIVATE"]) {
    for (const q of [id, `${id}#C-1`, `https://asimposium.org/p/${id}`]) {
      const result = await executeSearch(f.db, { ...base, q });
      assert.deepEqual(normalizeQuery(result), normalizeQuery(absent));
      assert.equal(result.items.length, 0);
    }
  }
  assert.equal((await executeSearch(f.db, { ...base, q: "spectral" })).items.length, 0);
});

test("claim-index lag reports only current discoverable work within the selected filters", async () => {
  const f = fixture();
  const id = "P-QUEUED";
  f.problem(id, "active", 0, "Spectral paths", ["algebra"]);
  const event = f.claim("C-1", "spectral bound", id);
  f.sqlite
    .query(`INSERT INTO outbox
    SELECT id,problem_id,payload_sha256,'search.index','pending' FROM events WHERE id=?`)
    .run(event);
  const base = { q: "spectral", kind: "claim" as const, limit: 20 };
  async function pending(query: Parameters<typeof executeSearch>[1] = base) {
    const result = await executeSearch(f.db, query);
    assert.ok(!result.omitted.some((item) => item.reason === "index_freshness_unknown"));
    return result.omitted.some((item) => item.reason === "index_pending");
  }
  assert.equal(await pending(), true);
  assert.equal(await pending({ ...base, area: "analysis" }), false);
  assert.equal(await pending({ ...base, status: "dormant" }), false);
  for (const kind of ["problem", "fellow"] as const)
    assert.equal(await pending({ ...base, kind }), false);
  for (const change of [
    "UPDATE problems SET unlisted=1",
    "UPDATE problems SET status='private-draft'",
    "INSERT INTO content_controls VALUES('P-QUEUED','problem','hidden',1)",
    "INSERT INTO content_controls VALUES('P-QUEUED','C-1@1','hidden',1)",
    "INSERT INTO content_controls VALUES('P-QUEUED','#1','hidden',1)",
    "UPDATE event_content SET redacted_at='now'",
    "UPDATE claims SET source_seq=2",
    "UPDATE outbox SET payload_sha256='obsolete'",
    "UPDATE outbox SET state='delivered'",
  ]) {
    f.sqlite.exec("SAVEPOINT before_change");
    f.sqlite.exec(change);
    assert.equal(await pending(), false, change);
    f.sqlite.exec("ROLLBACK TO before_change; RELEASE before_change");
  }
});

test("Fellow matches are explicitly excluded rather than silently ignoring problem filters", async () => {
  const f = fixture();
  f.fellow("F-01M0HCVW4XTFWMZCQ40EJ0S0J7", "spectral-fellow");
  for (const q of ["spectral", "F-01M0HCVW4XTFWMZCQ40EJ0S0J7"]) {
    const query = { q, kind: "fellow" as const, limit: 20 };
    assert.equal((await executeSearch(f.db, query)).items.length, 1);
    const filtered = await executeSearch(f.db, { ...query, status: "active" });
    assert.equal(filtered.items.length, 0);
    assert.ok(filtered.omitted.some((item) => item.reason === "problem_filters_applied"));
  }
});

test("filtering happens before the 500-result window, including requested other-* areas", async () => {
  const f = fixture();
  for (let n = 0; n < 501; n++) f.problem(`P-A${n}`, "resolved", 0, "Spectral result", ["algebra"]);
  f.problem("P-ZMATCH", "active", 0, "Spectral research", ["other-network-science"]);
  const result = await f.page({
    q: "spectral",
    kind: "problem",
    limit: 1,
    area: "other-network-science",
    status: "active",
  });
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["P-ZMATCH"],
  );
  assert.equal(result.truncated, false);
  assert.equal(result.windowMatches, 1);
});

test("all continuation links retain filters, and changing or removing one refuses before any read", async () => {
  const f = fixture();
  f.problem("P-ACTIVE", "active", 0, "Public work", ["algebra"]);
  for (let n = 1; n <= 3; n++) f.claim(`C-${n}`, "spectral bound", "P-ACTIVE");
  const query = {
    q: "spectral",
    kind: "claim" as const,
    limit: 1,
    area: "algebra",
    status: "active" as const,
  };
  const first = await executeSearch(f.db, query, "/search.json");
  assert.ok(first.cursor);
  const next = first.next_actions.find((item) => item.label === "Next page");
  assert.ok(next);
  const url = new URL(next.href, "https://a.asimposium.org");
  assert.equal(url.searchParams.get("area"), "algebra");
  assert.equal(url.searchParams.get("status"), "active");
  assert.equal(url.searchParams.get("cursor"), first.cursor);
  assert.equal(new URLSearchParams(searchQueryString(query)).get("area"), "algebra");
  const second = await executeSearch(f.db, { ...query, cursor: first.cursor });
  assert.notEqual(first.items[0]?.id, second.items[0]?.id);
  for (const changed of [
    { ...query, area: "analysis" },
    { ...query, status: "resolved" as const },
    { ...query, area: undefined },
    { ...query, status: undefined },
  ]) {
    f.calls.length = 0;
    await assert.rejects(executeSearch(f.db, { ...changed, cursor: first.cursor }), {
      reason: "invalid",
    });
    assert.equal(f.calls.length, 0);
  }
});

for (const mutation of [
  "UPDATE problems SET status='resolved' WHERE id='P-ACTIVE'",
  "UPDATE problems SET areas='[\"analysis\"]' WHERE id='P-ACTIVE'",
]) {
  test(`metadata changes invalidate a filtered continuation: ${mutation}`, async () => {
    const f = fixture();
    f.problem("P-ACTIVE", "active", 0, "Public work", ["algebra"]);
    for (let n = 1; n <= 3; n++) f.claim(`C-${n}`, "spectral bound", "P-ACTIVE");
    const query: SearchPageQuery = {
      q: "spectral",
      kind: "claim",
      limit: 1,
      area: "algebra",
      status: "active",
    };
    const first = await f.page(query);
    assert.ok(first.cursor);
    f.sqlite.exec(mutation);
    await assert.rejects(f.page({ ...query, cursor: first.cursor }), { reason: "changed" });
  });
}

test("a filter change during body hydration does not return an out-of-filter cached excerpt", async () => {
  const f = fixture();
  f.problem("P-ACTIVE", "active", 0, "Public work", ["algebra"]);
  f.claim("C-1", "spectral bound", "P-ACTIVE");
  f.setHook((sql) => {
    if (sql.includes("WITH selected AS")) f.sqlite.exec("UPDATE problems SET status='resolved'");
  });
  await assert.rejects(
    f.page({ q: "spectral", kind: "claim", area: "algebra", status: "active" }),
    { reason: "changed" },
  );
});
