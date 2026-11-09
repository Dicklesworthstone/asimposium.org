import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import {
  readWorkshopDirectory,
  WORKSHOP_DIRECTORY_SQL,
  WorkshopDirectoryUnavailable,
} from "../../src/sessions/workshop-directory.ts";

const session = (n: number) => `S-${String(n).padStart(26, "0")}`;
const object = (n: number) => `W-${String(n).padStart(26, "0")}`;
const scope = { sessionId: session(2), fellowId: "fellow-own", problemId: "P-4DSP" };

/** bun:sqlite verifies SQL and bounded-read invariants as unit evidence.
 * A separate native Workerd journey covers the mounted authenticated route. */
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE sessions(session_id TEXT PRIMARY KEY, fellow_id TEXT, problem_id TEXT, closed_at TEXT);
    CREATE TABLE workshop_objects(workshop_id TEXT PRIMARY KEY, current_version INTEGER, workshop_seq INTEGER,
      state TEXT, type TEXT, title TEXT, fellow_id TEXT, problem_id TEXT, session_id TEXT, body_md TEXT, cas_hash TEXT);
    CREATE TABLE workshop_revisions(workshop_id TEXT, version INTEGER, problem_id TEXT, fellow_id TEXT,
      session_id TEXT, type TEXT, title TEXT, created_at TEXT, body_md TEXT, PRIMARY KEY(workshop_id,version));
    CREATE TABLE private_draft_erasures(problem_id TEXT PRIMARY KEY);`);
  for (const n of [1, 2])
    sql
      .query("INSERT INTO sessions VALUES(?,?,?,?)")
      .run(
        session(n),
        scope.fellowId,
        scope.problemId,
        n === 1 ? "2026-11-09T09:00:00.000Z" : null,
      );
  let afterPage: (() => void) | undefined;
  let failed = false;
  const queries: string[] = [];
  const db = {
    prepare(text: string) {
      let values: (string | number | null)[] = [];
      const execute = () => {
        queries.push(text);
        const result = sql.query(text).all(...values);
        if (text === WORKSHOP_DIRECTORY_SQL) afterPage?.();
        return result;
      };
      return {
        bind(...bindings: (string | number | null)[]) {
          values = bindings;
          return this;
        },
        async all() {
          return failed ? { success: false, results: [] } : { success: true, results: execute() };
        },
        async first() {
          return execute()[0] ?? null;
        },
      };
    },
  } as unknown as D1Database;
  function add(
    n: number,
    state = "open",
    revision = true,
    fellow = scope.fellowId,
    problem = scope.problemId,
  ) {
    sql
      .query(
        "INSERT INTO workshop_objects VALUES(?,1,?,?, 'scratch',?,?,?,?, 'PRIVATE_BODY_CANARY','PRIVATE_CAS_KEY')",
      )
      .run(object(n), n, state, `Draft ${n}`, fellow, problem, session(1));
    if (revision)
      sql
        .query(
          "INSERT INTO workshop_revisions VALUES(?,1,?,?,?,'scratch',?,'2026-11-09T10:00:00.000Z','PRIVATE_REVISION_BODY')",
        )
        .run(object(n), problem, fellow, session(1), `Draft ${n}`);
  }
  return {
    sql,
    db,
    add,
    queries,
    afterPage(callback: () => void) {
      afterPage = callback;
    },
    fail() {
      failed = true;
    },
  };
}

test("workshop directory recovers every own retained ID across authoring sessions without fetching bodies", async () => {
  const f = fixture();
  for (let n = 1; n <= 7; n++) f.add(n * 10, n === 4 ? "archived" : n === 5 ? "discarded" : "open");
  f.add(80, "open", true, "other-fellow");
  f.add(90, "open", true, scope.fellowId, "P-OTHER");
  // A later authoring session need not equal the immutable creation context.
  f.sql
    .query("UPDATE workshop_revisions SET session_id=? WHERE workshop_id=?")
    .run(session(2), object(30));
  let page = await readWorkshopDirectory(f.db, scope, { limit: 2 });
  expect(page.items.map((item) => item.workshop_id)).toEqual([object(10), object(20)]);
  const ids = page.items.map((item) => item.workshop_id);
  // Editing an already seen object cannot move it past the ID cursor.
  f.sql.query("UPDATE workshop_objects SET workshop_seq=999 WHERE workshop_id=?").run(object(10));
  while (page.next_after !== null) {
    page = await readWorkshopDirectory(f.db, scope, { limit: 2, after: page.next_after });
    ids.push(...page.items.map((item) => item.workshop_id));
  }
  expect(ids).toEqual([10, 20, 30, 40, 50, 60, 70].map(object));
  expect(new Set(ids).size).toBe(7);
  const all = await readWorkshopDirectory(f.db, scope, {});
  expect(all.items[2]?.read_url).toBe(
    `/v1/sessions/${session(2)}/workshop/${object(30)}?version=1`,
  );
  // Automatic archive state is current metadata; no new revision is needed.
  expect(
    (await readWorkshopDirectory(f.db, scope, { state: "archived" })).items.map(
      (item) => item.workshop_id,
    ),
  ).toEqual([object(40)]);
  expect(
    (await readWorkshopDirectory(f.db, scope, { state: "discarded" })).items.map(
      (item) => item.workshop_id,
    ),
  ).toEqual([object(50)]);
  expect((await readWorkshopDirectory(f.db, scope, { state: "open" })).items).toHaveLength(5);
  for (const query of f.queries)
    expect(query).not.toMatch(/body_md|cas_hash|publication_json|relates_to_json/);
  expect(JSON.stringify(all)).not.toContain("PRIVATE_");
});

test("revisionless and mismatched sources are disclosed omissions that cannot block later recovery", async () => {
  const f = fixture();
  f.add(10, "discarded", false);
  f.add(20);
  f.add(30);
  f.add(40);
  f.sql
    .query(
      "UPDATE workshop_revisions SET fellow_id='foreign',title='FOREIGN_TITLE_CANARY' WHERE workshop_id=?",
    )
    .run(object(20));
  f.sql
    .query("UPDATE workshop_objects SET title='UNVERIFIED_HEAD_CANARY' WHERE workshop_id=?")
    .run(object(40));
  const first = await readWorkshopDirectory(f.db, scope, { limit: 2 });
  expect(first.items).toEqual([]);
  expect(first.scanned_through).toBe(object(20));
  expect(first.next_after).toBe(object(20));
  expect(first.omitted).toEqual(["source_unavailable", "page_limit"]);
  const second = await readWorkshopDirectory(f.db, scope, { after: first.next_after!, limit: 2 });
  expect(second.items.map((item) => item.workshop_id)).toEqual([object(30)]);
  expect(second.scanned_through).toBe(object(40));
  expect(second.next_after).toBeNull();
  expect(second.omitted).toEqual(["source_unavailable"]);
  expect(JSON.stringify([first, second])).not.toContain("CANARY");
});

test("directory page and lookahead are revalidated after source, ownership, version or erasure races", async () => {
  for (const mutation of [
    "UPDATE workshop_objects SET current_version=2 WHERE workshop_id=?",
    "UPDATE workshop_objects SET fellow_id='foreign' WHERE workshop_id=?",
    "UPDATE workshop_objects SET problem_id='P-OTHER' WHERE workshop_id=?",
    "UPDATE workshop_objects SET state='archived' WHERE workshop_id=?",
    "UPDATE workshop_revisions SET title='RACED_TITLE_CANARY' WHERE workshop_id=?",
    "UPDATE workshop_revisions SET session_id='S-missing' WHERE workshop_id=?",
  ]) {
    const f = fixture();
    f.add(10);
    f.add(20);
    f.afterPage(() => f.sql.query(mutation).run(object(20)));
    await expect(readWorkshopDirectory(f.db, scope, { limit: 1 })).rejects.toBeInstanceOf(
      WorkshopDirectoryUnavailable,
    );
  }
  const erased = fixture();
  erased.add(10);
  erased.afterPage(() =>
    erased.sql.query("INSERT INTO private_draft_erasures VALUES(?)").run(scope.problemId),
  );
  await expect(readWorkshopDirectory(erased.db, scope, {})).rejects.toBeInstanceOf(
    WorkshopDirectoryUnavailable,
  );
});

test("default bounds inspect twenty candidates and refuse a failed empty database result", async () => {
  const f = fixture();
  for (let n = 1; n <= 21; n++) f.add(n);
  const page = await readWorkshopDirectory(f.db, scope, {});
  expect(page.items).toHaveLength(20);
  expect(page.next_after).toBe(object(20));
  expect(page.omitted).toEqual(["page_limit"]);
  expect((await readWorkshopDirectory(f.db, scope, { after: object(21) })).scanned_through).toBe(
    object(21),
  );
  await expect(readWorkshopDirectory(f.db, scope, { limit: 101 })).rejects.toBeInstanceOf(
    WorkshopDirectoryUnavailable,
  );
  f.fail();
  await expect(readWorkshopDirectory(f.db, scope, {})).rejects.toBeInstanceOf(
    WorkshopDirectoryUnavailable,
  );
});
