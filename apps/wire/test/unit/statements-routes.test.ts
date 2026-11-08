import { afterEach, expect, test } from "bun:test";
import {
  StatementHistoryResponseSchema,
  StatementResponseSchema,
} from "@asimposium/contracts/statements";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { redactEventContent } from "../../src/krater/krater.ts";
import { loadStatementHistory, loadStatementVersion } from "../../src/ledger/statements-read.ts";
import { PROBLEM, STATEMENT_BOUNDARIES, statementsFixture } from "../support/statements-fixture.ts";

type Fixture = Awaited<ReturnType<typeof statementsFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.sql.close();
});
async function fixture() {
  const f = await statementsFixture();
  fixtures.push(f);
  return f;
}
function control(f: Fixture, target: string, visibility: "hidden" | "visible", version: number) {
  f.sql
    .query(`INSERT INTO content_controls(control_id,problem_id,target_kind,target_ref,visibility,source,reason_category,actor,reason,version,created_at)
    VALUES(?,?,'problem',?,?,'operator','privacy','statement-test','Current availability control.',?,?)`)
    .run(
      `CC-statement-${target}-${version}`,
      PROBLEM,
      target,
      visibility,
      version,
      new Date().toISOString(),
    );
}

test("the legacy pinned statement URL cannot silently return today's formulation", async () => {
  const f = await fixture();
  const response = await f.read(`/p/${PROBLEM}.json?statement=2`);
  expect(response.status).toBe(308);
  expect(response.headers.get("location")).toBe(`/p/${PROBLEM}/statements/2.json`);
});

test("public statement history excludes private drafts and retains complete exact public versions", async () => {
  const f = await fixture();
  const response = await f.read(`/p/${PROBLEM}/statements.json`);
  expect(response.status).toBe(200);
  const face = StatementHistoryResponseSchema.parse(await response.json());
  expect(face.statements.map((statement) => statement.version)).toEqual([2, 3]);
  const original = face.statements[0];
  if (!original) throw new Error("Expected the original public statement");
  expect(original).toMatchObject(STATEMENT_BOUNDARIES);
  expect(face.statements[1]?.scope).toBe("Finite rooted trees.");
  expect((await f.read(`/p/${PROBLEM}/statements/1.json`)).status).toBe(404);
  const exact = await f.read(`/p/${PROBLEM}/statements/2.json?through=1`);
  expect(exact.status).toBe(200);
  expect(StatementResponseSchema.parse(await exact.json()).statement).toEqual(original);
});

test("history pages keep one cut across later revisions and advance over entirely withheld pages", async () => {
  const f = await fixture();
  for (let version = 4; version <= 7; version++)
    await f.revise(`Finite trees in boundary ${version}.`);
  const first = StatementHistoryResponseSchema.parse(
    await (await f.read(`/p/${PROBLEM}/statements.json`)).json(),
  );
  expect(first.cursor).toBe(6);
  expect(first.statements.map((statement) => statement.version)).toEqual([2, 3, 4, 5]);
  expect(first.next_after).toBe(4);
  await f.revise("A later formulation outside the saved cut.");
  const next = StatementHistoryResponseSchema.parse(
    await (
      await f.read(
        `/p/${PROBLEM}/statements.json?through=${first.cursor}&after=${first.next_after}`,
      )
    ).json(),
  );
  expect(next.cursor).toBe(first.cursor);
  expect(next.statements.map((statement) => statement.version)).toEqual([6, 7]);
  expect(next.next_after).toBeNull();
  for (let seq = 1; seq <= 4; seq++) control(f, `#${seq}`, "hidden", 1);
  const withheld = StatementHistoryResponseSchema.parse(
    await (await f.read(`/p/${PROBLEM}/statements.json?through=6`)).json(),
  );
  expect(withheld.statements).toEqual([]);
  expect(withheld.omitted).toEqual(["content_unavailable", "page_limit"]);
  expect(withheld.next_after).toBe(4);
  const continuation = await f.read(`/p/${PROBLEM}/statements.json?through=6&after=4`);
  expect(StatementHistoryResponseSchema.parse(await continuation.json())).toEqual(next);
});

test("current problem, version and event controls override historical ETags and restore exact bytes", async () => {
  const f = await fixture();
  const path = `/p/${PROBLEM}/statements/2.json?through=1`;
  const visible = await f.read(path);
  const body = await visible.text();
  const etag = visible.headers.get("etag");
  if (!etag) throw new Error("Expected an exact publication ETag");
  const historyEtag = (await f.read(`/p/${PROBLEM}/statements.json?through=1`)).headers.get("etag");
  if (!historyEtag) throw new Error("Expected a captured history ETag");
  for (const target of ["problem", PROBLEM, `${PROBLEM}@2`, "#1"]) {
    control(f, target, "hidden", 1);
    const hidden = await f.read(path, { headers: { "if-none-match": etag } });
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain(STATEMENT_BOUNDARIES.scope.trim());
    expect(hidden.headers.get("cache-control")).toBe("private, no-store");
    const history = await f.read(`/p/${PROBLEM}/statements.json?through=1`, {
      headers: { "if-none-match": historyEtag },
    });
    expect(history.status).toBe(target === "problem" || target === PROBLEM ? 404 : 200);
    control(f, target, "visible", 2);
    const restored = await f.read(path);
    expect(restored.status).toBe(200);
    expect(await restored.text()).toBe(body);
    expect(restored.headers.get("etag")).toBe(etag);
  }
});

test("redacted source bytes cannot be recovered through retained projection rows or old cache validators", async () => {
  const f = await fixture();
  const path = `/p/${PROBLEM}/statements/2.json`;
  const before = await f.read(path);
  const exact = StatementResponseSchema.parse(await before.json());
  const etag = before.headers.get("etag");
  if (!etag) throw new Error("Expected exact publication ETag");
  await redactEventContent(
    f.db,
    exact.statement.publication.event_id,
    "privacy",
    new Date().toISOString(),
  );
  const source = f.sql
    .query("SELECT scope FROM problem_statement_versions WHERE problem_id=? AND version=2")
    .get(PROBLEM);
  expect(source).toEqual({ scope: STATEMENT_BOUNDARIES.scope });
  const hidden = await f.read(path, { headers: { "if-none-match": etag } });
  expect(hidden.status).toBe(404);
  const page = StatementHistoryResponseSchema.parse(
    await (await f.read(`/p/${PROBLEM}/statements.json`)).json(),
  );
  expect(page.statements.map((statement) => statement.version)).toEqual([3]);
  expect(page.omitted).toEqual(["content_unavailable"]);
  expect(page.scanned_through).toBe(2);
});

test("visibility changes between head capture and source hydration are fenced by the read batch", async () => {
  const f = await fixture();
  let raced = false;
  const db = Object.assign(Object.create(f.db) as D1Database, {
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      if (!raced) {
        raced = true;
        control(f, "problem", "hidden", 1);
      }
      return f.db.batch<T>(statements);
    },
  });
  await expect(loadStatementVersion(db, PROBLEM, 2)).rejects.toMatchObject({ code: "not-found" });
  expect(raced).toBe(true);
  control(f, "problem", "visible", 2);
  let redacted = false;
  const source = (await loadStatementVersion(f.db, PROBLEM, 2)).face.statement.publication.event_id;
  const redacting = Object.assign(Object.create(f.db) as D1Database, {
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      if (!redacted) {
        redacted = true;
        await redactEventContent(f.db, source, "privacy", new Date().toISOString());
      }
      return f.db.batch<T>(statements);
    },
  });
  const result = await loadStatementHistory(redacting, PROBLEM);
  expect(result.face.statements.map((statement) => statement.version)).toEqual([3]);
  expect(result.face.omitted).toContain("content_unavailable");
});

test("JSON, Markdown, HTML and HEAD preserve the same exact versions and safe transport", async () => {
  const f = await fixture();
  for (const tail of ["statements", "statements/2"]) {
    for (const format of ["json", "md", "html"]) {
      const path = `/p/${PROBLEM}/${tail}.${format}`;
      const response = await f.read(path);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Finite labelled trees.");
      expect(response.headers.get("content-location")).toContain("through=2");
      if (format === "html") {
        expect(body).not.toContain("<script>unsafe()</script>");
        expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      }
      const head = await f.read(path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.get("etag")).toBe(response.headers.get("etag"));
      const conditional = await f.read(path, {
        headers: { "if-none-match": response.headers.get("etag") ?? "" },
      });
      expect(conditional.status).toBe(304);
    }
  }
  f.sql.query("UPDATE problems SET unlisted=1 WHERE id=?").run(PROBLEM);
  const unlisted = await f.read(`/p/${PROBLEM}/statements/2.json`);
  expect(unlisted.headers.get("cache-control")).toBe("private, no-store");
  expect(unlisted.headers.get("x-robots-tag")).toBe("noindex, nofollow");
});

test("selectors reject ambiguous or unsafe versions and cuts without falling through to the current digest", async () => {
  const f = await fixture();
  for (const query of [
    "through=01",
    "through=-1",
    "through=1e2",
    "through=9007199254740992",
    "through=3",
    "through=1&through=2",
    "through=1&after=2",
    "limit=50",
    "after=0&after=1",
  ]) {
    expect((await f.read(`/p/${PROBLEM}/statements.json?${query}`)).status, query).toBe(400);
  }
  for (const version of ["0", "01", "-1", "1e2", "9007199254740992", "2%0A", "2.0"]) {
    expect((await f.read(`/p/${PROBLEM}/statements/${version}.json`)).status, version).toBe(400);
    expect((await f.read(`/p/${PROBLEM}.md?statement=${version}`)).status, version).toBe(400);
  }
  for (const query of [
    "statement=2&statement=3",
    "statement=2&after=0",
    "statement=2&through=01",
  ]) {
    expect((await f.read(`/p/${PROBLEM}.json?${query}`)).status).toBe(400);
  }
  expect((await f.read(`/p/${PROBLEM}/statements/3.json?through=1`)).status).toBe(404);
  const empty = await f.read(`/p/${PROBLEM}/statements.json?through=0`);
  expect(empty.status).toBe(200);
  expect(StatementHistoryResponseSchema.parse(await empty.json()).statements).toEqual([]);
  expect((await f.read(`/p/${PROBLEM}/statements/2`)).headers.get("location")).toBe(
    `/p/${PROBLEM}/statements/2.md`,
  );
  expect((await f.read(`/p/${PROBLEM}.md?statement=2&through=1`)).headers.get("location")).toBe(
    `/p/${PROBLEM}/statements/2.md?through=1`,
  );
});
