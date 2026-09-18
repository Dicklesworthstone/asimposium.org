import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import type { EvidenceReference } from "../../src/ledger/evidence-grounding.ts";

/** Production SQL over SQLite, not a deployed D1/enrollment integration. */
export function groundingFixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems(id TEXT PRIMARY KEY,status TEXT,public_seq INTEGER);
    INSERT INTO problems VALUES('P-DEMO','active',10000),('P-OTHER','active',10000);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,
      object_id TEXT,object_version INTEGER,payload_sha256 TEXT,actor_fellow_id TEXT,actor_sponsor_id TEXT);
    CREATE INDEX evidence_lookup ON events(problem_id,object_id,type,object_version);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE TABLE scientific_withdrawals(source_event_id TEXT PRIMARY KEY);
    CREATE TABLE atomic_writes(id TEXT PRIMARY KEY);
    CREATE TABLE retractions(problem_id TEXT,retraction_id TEXT,seq INTEGER,target_object TEXT,author_fellow_id TEXT);
    CREATE TABLE claim_versions(problem_id TEXT,claim_id TEXT,version INTEGER,content_digest TEXT,statement TEXT);`);
  let calls = 0;
  function prepare(text: string) {
    let values: (string | number | null)[] = [];
    const execute = () => {
      calls++;
      const rows = sql.query(text).all(...values);
      const meta = sql.query("SELECT changes() AS changes").get() as { changes: number };
      return { success: true, results: rows, meta };
    };
    return {
      bind(...args: (string | number | null)[]) {
        values = args;
        return this;
      },
      async all() {
        return execute();
      },
      async first() {
        return execute().results[0] ?? null;
      },
      async run() {
        return execute();
      },
      execute,
      values: () => values,
    };
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sql.exec("BEGIN");
      try {
        const rows = statements.map((s) => s.execute());
        sql.exec("COMMIT");
        return rows;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  let sequence = 0;
  function add(
    id: string,
    extra: Record<string, unknown> = {},
    problem = "P-DEMO",
  ): EvidenceReference {
    const text = JSON.stringify({
      bears_on_kind: "claim",
      bears_on_id: "C-1",
      bears_on_version: 1,
      mode: "confirmatory",
      computed_class: "citation",
      kind: "argument",
      direction: "supports",
      body_md: `Grounded work product ${id}`,
      ...extra,
    });
    const digest = createHash("sha256").update(text).digest("hex");
    sql
      .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        `event-${id}`,
        problem,
        ++sequence,
        "evidence.created",
        "evidence",
        id,
        1,
        digest,
        "fellow-a",
        "sponsor-a",
      );
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(`event-${id}`, digest, text);
    return { evidence_id: id, digest: `sha256:${digest}` };
  }
  function derived(id: string, pins: EvidenceReference[], field: "method" | "check" = "check") {
    return add(
      id,
      field === "check"
        ? { falsification_check: { evidence: pins } }
        : { scientific_provenance: { method: { evidence: pins } } },
    );
  }
  const withdraw = (id: string) =>
    sql.query("INSERT INTO scientific_withdrawals VALUES(?)").run(`event-${id}`);
  return { sql, db, add, derived, withdraw, calls: () => calls };
}
export async function withGroundingFixture(
  run: (f: ReturnType<typeof groundingFixture>) => Promise<void>,
) {
  const f = groundingFixture();
  try {
    await run(f);
  } finally {
    f.sql.close();
  }
}
