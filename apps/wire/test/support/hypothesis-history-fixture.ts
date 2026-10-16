import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import {
  type HypothesisDecoders,
  type HypothesisReadQuery,
  readHypotheses,
} from "../../src/ledger/hypotheses-read.ts";

/** Actual SQLite and content digests; the scientific decoders deliberately
 * accept only fixture work products, not the full production Zod contract. */
export function hypothesisHistoryFixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    INSERT INTO problems VALUES ('P-DEMO',0,'active',0),('P-OTHER',0,'active',0);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT, object_kind TEXT,
      object_id TEXT, object_version INTEGER, created_at TEXT, payload_sha256 TEXT,
      actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT, model_string_self_declared TEXT, harness TEXT,
      UNIQUE(problem_id,seq));
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE hypotheses(hypothesis_id TEXT, route TEXT, status TEXT);
    INSERT INTO hypotheses VALUES ('H-1','PROJECTION-POISON','active');
  `);
  const queries: string[] = [];
  let batches = 0, rows = 0;
  const prepare = (query: string) => ({
    bind: (...args: (string | number | null)[]) => ({
      all: async () => {
        queries.push(query);
        const results = sql.prepare(query).all(...args);
        rows += results.length;
        return { results, success: true, meta: {} };
      },
    }),
  });
  const db = {
    prepare,
    async batch(statements: { all(): Promise<unknown> }[]) {
      batches++;
      sql.exec("BEGIN");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.all());
        sql.exec("COMMIT");
        return result;
      } catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  const decoders: HypothesisDecoders = {
    publication(value) {
      const v = value as NonNullable<ReturnType<HypothesisDecoders["publication"]>> | undefined;
      return v && typeof v.route === "string" && typeof v.body_md === "string" ? v : null;
    },
    kill(value) {
      const v = value as NonNullable<ReturnType<HypothesisDecoders["kill"]>> | undefined;
      return v && typeof v.hypothesis_id === "string" && typeof v.reason === "string" ? v : null;
    },
  };
  const sha = (body: string) => createHash("sha256").update(body).digest("hex");
  function event(seq: number, id = `H-${seq}`, type = "hypothesis.created",
    extra: Record<string, unknown> = {}, problem = "P-DEMO") {
    const created = type === "hypothesis.created";
    const content = created ? {
      route: `Published route ${id}`, mechanism: "A finite construction", falsifier: "A counterexample",
      expected_evidence: null, discriminating_predictions: ["A boundary outcome"], origin: "proposed",
      body_md: `Original work product for ${id}`, ...extra,
    } : { hypothesis_id: id, killed_by_evidence_id: "E-1", reason: "The recorded falsifier fired", ...extra };
    const body = JSON.stringify(content), digest = sha(body), eid = `${problem}-${seq}`;
    sql.prepare("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      eid, problem, seq, type, "hypothesis", id, 1, "2026-10-01T00:00:00.000Z", digest,
      created ? "F-AUTHOR" : "F-KILLER", created ? "SP-AUTHOR" : "SP-KILLER",
      created ? "S-AUTHOR" : "S-KILLER", "declared-model", "declared-harness",
    );
    sql.prepare("INSERT INTO event_content VALUES (?,?,?,NULL)").run(eid,digest,body);
    sql.prepare("UPDATE problems SET public_seq=MAX(public_seq,?) WHERE id=?").run(seq,problem);
    return eid;
  }
  function control(target: string, visibility: "hidden" | "visible", problem = "P-DEMO") {
    sql.prepare(`INSERT INTO content_controls
      SELECT ?,?,?,COALESCE(MAX(version),0)+1 FROM content_controls WHERE problem_id=? AND target_ref=?`)
      .run(problem,target,visibility,problem,target);
  }
  const read = (query: HypothesisReadQuery = {}, selection: Parameters<typeof readHypotheses>[4] = {}, problem = "P-DEMO") =>
    readHypotheses(db,problem,query,decoders,selection);
  return { sql, db, event, control, read, decoders, sha, queries, counts: () => ({ batches, rows }) };
}
