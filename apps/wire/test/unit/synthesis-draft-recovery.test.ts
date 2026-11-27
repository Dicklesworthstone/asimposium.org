import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import {
  readSynthesisDraft,
  readSynthesisDraftDirectory,
  SYNTHESIS_DRAFT_DIRECTORY_SQL,
  SYNTHESIS_DRAFT_READ_SQL,
  SynthesisDraftRecoveryUnavailable,
} from "../../src/sessions/synthesis-draft-recovery.ts";

const scope = {
  sessionId: "S-00000000000000000000000002",
  problemId: "P-4DSP",
  fellowId: "fellow-own",
};

/** SQL-only unit evidence; mounted authentication, publication and transfer
 * are exercised separately by synthesis-real-bindings.mjs. */
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE synthesis_drafts (
    synthesis_id TEXT PRIMARY KEY, problem_id TEXT, covers_through INTEGER,
    body_md TEXT, anchors_json TEXT, omitted_json TEXT, selection_policy TEXT,
    closing_resolution_json TEXT, dropped_single_author_count INTEGER,
    author_fellow_id TEXT, author_sponsor_id TEXT, session_id TEXT, declared_model TEXT,
    harness TEXT, state TEXT, published_by_principal_id TEXT, published_event_id TEXT,
    published_seq INTEGER, published_at TEXT, created_at TEXT);
    CREATE TABLE private_draft_erasures (problem_id TEXT PRIMARY KEY);`);
  let afterRead: ((query: string) => void) | undefined;
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      let values: (string | number | null)[] = [];
      const read = () => {
        queries.push(query);
        const rows = sql.query(query).all(...values);
        afterRead?.(query);
        return rows;
      };
      return {
        bind(...bound: (string | number | null)[]) {
          values = bound;
          return this;
        },
        async all() {
          return { success: true, results: read() };
        },
        async first() {
          return read()[0] ?? null;
        },
      };
    },
  } as unknown as D1Database;
  const add = (id: string, fellow = scope.fellowId, problem = scope.problemId) =>
    sql
      .query(
        `INSERT INTO synthesis_drafts VALUES (?, ?, 3, 'PRIVATE_BODY_CANARY',
      '[{"target_kind":"claim","target_id":"C-1","target_version":1}]',
      '["PRIVATE_OMISSION_CANARY"]', 'PRIVATE_POLICY_CANARY', NULL, 0, ?, 'sponsor-original',
      'S-00000000000000000000000001', 'test-model', 'test-harness', 'draft', NULL, NULL, NULL, NULL,
      '2026-11-20T12:00:00.000Z')`,
      )
      .run(id, problem, fellow);
  const publish = (id: string) =>
    sql
      .query(`UPDATE synthesis_drafts SET state='published',
    published_by_principal_id='sponsor-current', published_event_id='EV-1', published_seq=4,
    published_at='2026-11-20T12:01:00.000Z' WHERE synthesis_id=?`)
      .run(id);
  return {
    sql,
    db,
    queries,
    add,
    publish,
    afterRead(callback: (query: string) => void) {
      afterRead = callback;
    },
  };
}

test("synthesis recovery pages own metadata across sessions and recovers publication pins without reading directory bodies", async () => {
  const f = fixture();
  for (const id of ["SYNTH-1", "SYNTH-2", "SYNTH-3", "SYNTH-4"]) f.add(id);
  f.add("SYNTH-5", "foreign-fellow");
  f.add("SYNTH-6", scope.fellowId, "P-OTHER");
  const first = await readSynthesisDraftDirectory(f.db, scope, { limit: 2 });
  expect(first.items.map((item) => item.synthesis_id)).toEqual(["SYNTH-1", "SYNTH-2"]);
  expect(first.next_after).toBe("SYNTH-2");
  f.publish("SYNTH-1");
  const next = await readSynthesisDraftDirectory(f.db, scope, {
    limit: 2,
    after: first.next_after!,
  });
  expect(next.items.map((item) => item.synthesis_id)).toEqual(["SYNTH-3", "SYNTH-4"]);
  expect(next.next_after).toBeNull();
  const published = await readSynthesisDraftDirectory(f.db, scope, { state: "published" });
  expect(published.items).toHaveLength(1);
  expect(published.items[0]?.publication).toMatchObject({
    event_id: "EV-1",
    read_url: "/p/P-4DSP/syntheses/SYNTH-1.json",
    shared_handoff: { synthesis_id: "SYNTH-1", event_id: "EV-1" },
  });
  expect(JSON.stringify([first, next, published])).not.toContain("PRIVATE_");
  for (const query of f.queries)
    expect(query).not.toMatch(/body_md|omitted_json|selection_policy|SELECT d\.\*/);
  const exact = await readSynthesisDraft(f.db, scope, "SYNTH-1");
  expect(exact?.draft).toMatchObject({
    body_md: "PRIVATE_BODY_CANARY",
    author_sponsor_id: "sponsor-original",
    state: "published",
  });
  expect(exact?.publication).toEqual(published.items[0]?.publication ?? null);
  expect(await readSynthesisDraft(f.db, scope, "SYNTH-5")).toBeNull();
  expect(await readSynthesisDraft(f.db, scope, "SYNTH-6")).toBeNull();
  expect(await readSynthesisDraft(f.db, scope, "SYNTH-MISSING")).toBeNull();
});

test("erasure, publication and ownership races fail closed before returning metadata, continuation or body", async () => {
  for (const query of [SYNTHESIS_DRAFT_DIRECTORY_SQL, SYNTHESIS_DRAFT_READ_SQL]) {
    for (const mutation of [
      "UPDATE synthesis_drafts SET author_fellow_id='foreign-fellow'",
      "UPDATE synthesis_drafts SET problem_id='P-OTHER'",
      "INSERT INTO private_draft_erasures VALUES('P-4DSP')",
      "UPDATE synthesis_drafts SET state='published', published_event_id='EV-1', published_seq=4, published_at='2026-11-20T12:01:00.000Z'",
    ]) {
      const f = fixture();
      f.add("SYNTH-1");
      let changed = false;
      f.afterRead((read) => {
        if (read === query && !changed) {
          changed = true;
          f.sql.exec(mutation);
        }
      });
      const result =
        query === SYNTHESIS_DRAFT_DIRECTORY_SQL
          ? readSynthesisDraftDirectory(f.db, scope, {})
          : readSynthesisDraft(f.db, scope, "SYNTH-1");
      await expect(result).rejects.toBeInstanceOf(SynthesisDraftRecoveryUnavailable);
    }
  }
  const f = fixture();
  f.add("SYNTH-1");
  f.afterRead((query) => {
    if (query === SYNTHESIS_DRAFT_READ_SQL)
      f.sql.exec("UPDATE synthesis_drafts SET body_md='RACED_PRIVATE_BODY'");
  });
  await expect(readSynthesisDraft(f.db, scope, "SYNTH-1")).rejects.toBeInstanceOf(
    SynthesisDraftRecoveryUnavailable,
  );
  f.sql.exec("INSERT INTO private_draft_erasures VALUES('P-4DSP')");
  expect((await readSynthesisDraftDirectory(f.db, scope, {})).items).toEqual([]);
  expect(await readSynthesisDraft(f.db, scope, "SYNTH-1")).toBeNull();
});
