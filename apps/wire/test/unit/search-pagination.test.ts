import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  SEARCH_CURSOR_MAX_LENGTH,
  SEARCH_WINDOW_MAX,
  searchQueryString,
} from "@asimposium/contracts/search-pagination";
import {
  nextSearchCursor,
  readSearchContinuation,
  SearchContinuationError,
  searchDigest,
} from "../../src/search/continuation.ts";
import { searchPaginationFixture } from "./search-pagination-fixture.ts";

test("walk every ranked page without duplicates, including the exact-limit last page", async () => {
  const f = searchPaginationFixture();
  try {
    for (let i = 1; i <= 6; i++) f.claim(`C-${i}`, i === 3 ? "test test test" : "test science");
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await f.page({
        q: "test",
        kind: "claim",
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      assert.equal(page.windowMatches, 6);
      assert.equal(page.truncated, false);
      ids.push(...page.items.map((item) => item.id));
      cursor = page.cursor ?? undefined;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.equal(ids[0], "C-3");
    assert.equal(new Set(ids).size, 6);
    assert.equal(ids.length, 6);
    assert.ok(!f.calls.some((call) => /\bOFFSET\b/.test(call.sql)));
    assert.ok(
      f.calls
        .filter((call) => call.sql.includes("json_each(?)"))
        .every((call) => JSON.parse(call.bindings[0] as string).length === 2),
    );
  } finally {
    f.sqlite.close();
  }
});

test("exact claim occurs once, then claim/problem/Fellow phases continue without losing filters", async () => {
  const f = searchPaginationFixture();
  try {
    f.claim("C-1");
    f.claim("C-2");
    f.problem("P-test");
    f.fellow("F-1");
    f.fellow("F-2");
    const exact = {
      kind: "claim" as const,
      id: "C-1",
      problem_id: "P-DEMO",
      url: "https://asimposium.org/p/P-DEMO/claims/C-1",
      title: "Exact",
      snippet: "test science",
      match_type: "exact_reference" as const,
      score_explanation: "exact_claim_id",
    };
    let cursor: string | undefined;
    const identities: string[] = [];
    do {
      const page = await f.page(
        { q: "test", kind: "all", limit: 2, ...(cursor ? { cursor } : {}) },
        [exact],
      );
      identities.push(...page.items.map((item) => `${item.kind}:${item.id}`));
      cursor = page.cursor ?? undefined;
    } while (cursor);
    assert.deepEqual(identities, [
      "claim:C-1",
      "claim:C-2",
      "problem:P-test",
      "fellow:F-1",
      "fellow:F-2",
    ]);
    const filtered = await f.page({ q: "test", kind: "fellow", limit: 1 });
    assert.equal(filtered.windowMatches, 2);
    assert.deepEqual(
      filtered.items.map((item) => item.kind),
      ["fellow"],
    );
    assert.ok(filtered.cursor);
    assert.equal(
      (await f.page({ q: "test", kind: "fellow", limit: 1, cursor: filtered.cursor })).items[0]?.id,
      "F-2",
    );
  } finally {
    f.sqlite.close();
  }
});

for (const query of [
  { q: "other", kind: "claim" as const, limit: 2 },
  { q: "test", kind: "fellow" as const, limit: 2 },
  { q: "test", kind: "claim" as const, limit: 3 },
]) {
  test(`cursor rejects a changed query/filter/limit: ${JSON.stringify(query)}`, async () => {
    const f = searchPaginationFixture();
    try {
      for (let i = 1; i <= 4; i++) f.claim(`C-${i}`);
      const first = await f.page({ q: "test", kind: "claim", limit: 2 });
      assert.ok(first.cursor);
      f.calls.length = 0;
      await assert.rejects(f.page({ ...query, cursor: first.cursor }), { reason: "invalid" });
      assert.equal(f.calls.length, 0);
    } finally {
      f.sqlite.close();
    }
  });
}

test("cursor grammar and page alignment are strict and bounded", async () => {
  const q = { q: "test", kind: "all" as const, limit: 2 };
  const bound = await readSearchContinuation(q);
  const digest = await searchDigest("window");
  const cursor = nextSearchCursor(bound.queryDigest, digest, 2);
  assert.ok(cursor.length <= SEARCH_CURSOR_MAX_LENGTH);
  assert.equal((await readSearchContinuation({ ...q, cursor })).offset, 2);
  for (const bad of [
    "",
    cursor + "\n",
    cursor + "x",
    cursor.replace(/\.2$/, ".02"),
    cursor.replace(/\.2$/, ".0"),
    cursor.replace(/\.2$/, ".3"),
    cursor.replace(/\.2$/, ".500"),
    cursor.replace(/\.2$/, ".9007199254740992"),
    cursor.replace("sc1", "sc2"),
    cursor.toUpperCase(),
  ]) {
    await assert.rejects(readSearchContinuation({ ...q, cursor: bad }), { reason: "invalid" });
  }
});

for (const damage of [
  "redact",
  "hide",
  "private",
  "delete-index",
  "stale-index",
  "changed-digest",
  "unpublished-source",
]) {
  test(`current publication law excludes ${damage} before forming a cursor`, async () => {
    const f = searchPaginationFixture();
    try {
      f.claim("C-1");
      f.claim("C-2");
      const event = f.claim("C-3", "test", "P-OTHER");
      if (damage === "redact")
        f.sqlite.query("UPDATE event_content SET redacted_at='now' WHERE event_id=?").run(event);
      if (damage === "hide") f.sqlite.exec("UPDATE problems SET unlisted=1 WHERE id='P-OTHER'");
      if (damage === "private")
        f.sqlite.exec("UPDATE problems SET status='private-draft' WHERE id='P-OTHER'");
      if (damage === "delete-index")
        f.sqlite.exec("DELETE FROM public_claim_fts WHERE claim_id='C-3'");
      if (damage === "stale-index")
        f.sqlite.exec("UPDATE public_claim_fts SET statement='test stale' WHERE claim_id='C-3'");
      if (damage === "changed-digest")
        f.sqlite.exec("UPDATE claims SET payload_sha256='changed' WHERE id='C-3'");
      if (damage === "unpublished-source")
        f.sqlite.exec("UPDATE problems SET public_seq=0 WHERE id='P-OTHER'");
      const page = await f.page();
      assert.equal(page.windowMatches, 2);
      assert.equal(page.cursor, null);
      assert.ok(page.items.every((item) => item.problem_id !== "P-OTHER"));
    } finally {
      f.sqlite.close();
    }
  });
}

for (const change of [
  "withdraw-next",
  "withdraw-earlier",
  "new-match",
  "new-bm25-corpus",
  "fellow-change",
]) {
  test(`continuation restarts instead of skipping or reordering after ${change}`, async () => {
    const f = searchPaginationFixture();
    try {
      for (let i = 1; i <= 4; i++) f.claim(`C-${i}`);
      f.fellow("F-test");
      const first = await f.page();
      assert.ok(first.cursor);
      if (change === "withdraw-next")
        f.sqlite.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='EV-3'");
      if (change === "withdraw-earlier")
        f.sqlite.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='EV-1'");
      if (change === "new-match") f.claim("C-5");
      if (change === "new-bm25-corpus") f.claim("C-5", "unrelated words in the corpus");
      if (change === "fellow-change")
        f.sqlite.exec("UPDATE enrollment_fellows SET name='test-renamed' WHERE fellow_id='F-test'");
      await assert.rejects(f.page({ q: "test", kind: "all", limit: 2, cursor: first.cursor }), {
        reason: "changed",
      });
    } finally {
      f.sqlite.close();
    }
  });
}

test("an unrelated nonmatching problem does not expire a query-local window", async () => {
  const f = searchPaginationFixture();
  try {
    for (let i = 1; i <= 4; i++) f.claim(`C-${i}`);
    const first = await f.page();
    assert.ok(first.cursor);
    f.problem("P-UNRELATED");
    const next = await f.page({ q: "test", kind: "all", limit: 2, cursor: first.cursor });
    assert.equal(next.items.length, 2);
    assert.equal(next.cursor, null);
  } finally {
    f.sqlite.close();
  }
});

test("withdrawal between keys and bodies fails closed rather than returning a stale cached page", async () => {
  const f = searchPaginationFixture();
  try {
    f.claim("C-1");
    f.claim("C-2");
    f.setHook((sql) => {
      if (sql.includes("WITH selected AS"))
        f.sqlite.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='EV-2'");
    });
    await assert.rejects(f.page(), SearchContinuationError);
  } finally {
    f.sqlite.close();
  }
});

test("an exact match is refreshed after hydration, not retained across a withdrawal race", async () => {
  const f = searchPaginationFixture();
  try {
    const exact = {
      kind: "problem" as const,
      id: "P-test",
      url: "https://asimposium.org/p/P-test",
      snippet: "test",
      match_type: "exact_reference" as const,
      score_explanation: "exact_problem_id",
    };
    await assert.rejects(
      f.page({ q: "test", kind: "all", limit: 2 }, [exact], async () => []),
      { reason: "changed" },
    );
  } finally {
    f.sqlite.close();
  }
});

test("a full bounded window has explicit truncation, never an unbounded offset", async () => {
  const f = searchPaginationFixture();
  try {
    for (let i = 1; i <= SEARCH_WINDOW_MAX + 1; i++) f.claim(`C-${String(i).padStart(4, "0")}`);
    let cursor: string | undefined;
    let count = 0;
    do {
      const page = await f.page({
        q: "test",
        kind: "claim",
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      assert.equal(page.truncated, true);
      assert.equal(page.windowMatches, SEARCH_WINDOW_MAX);
      count += page.items.length;
      cursor = page.cursor ?? undefined;
    } while (cursor);
    assert.equal(count, SEARCH_WINDOW_MAX);
    const reads = f.calls.filter((call) => call.sql.includes("AS kind"));
    assert.ok(reads.every((call) => call.bindings.at(-1) === SEARCH_WINDOW_MAX + 1));
  } finally {
    f.sqlite.close();
  }
});

test("lookahead distinguishes exactly 500 from more than 500 matches", async () => {
  const f = searchPaginationFixture();
  try {
    for (let i = 1; i <= SEARCH_WINDOW_MAX; i++) f.claim(`C-${i}`);
    assert.equal((await f.page({ q: "test", kind: "claim", limit: 50 })).truncated, false);
  } finally {
    f.sqlite.close();
  }
});

test("continuation navigation preserves Unicode, literal operators, and all query parameters", () => {
  const q = { q: "α & β #? + OR", kind: "claim" as const, limit: 7, cursor: "opaque" };
  const params = new URLSearchParams(searchQueryString(q));
  assert.equal(params.get("q"), q.q);
  assert.equal(params.get("kind"), "claim");
  assert.equal(params.get("limit"), "7");
  assert.equal(params.get("cursor"), "opaque");
  assert.equal(params.size, 4);
});
