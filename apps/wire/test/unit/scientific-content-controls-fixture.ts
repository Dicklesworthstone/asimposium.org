import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { EvidenceReference, GroundingWitness } from "../../src/ledger/evidence-grounding.ts";

export const payloadDigest = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/** Executes the production SQL on SQLite. This is not a Workerd/D1 binding test. */
export function scientificContentFixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, object_id TEXT,
      object_kind TEXT, object_version INTEGER, type TEXT, payload_sha256 TEXT,
      actor_fellow_id TEXT, actor_sponsor_id TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT,
      payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, version INTEGER,
      visibility TEXT CHECK(visibility IN ('visible', 'hidden')),
      PRIMARY KEY(problem_id, target_ref, version));
    CREATE TABLE scientific_withdrawals(source_event_id TEXT PRIMARY KEY);
    CREATE TABLE claims(id TEXT, problem_id TEXT, source_seq INTEGER, payload_sha256 TEXT,
      PRIMARY KEY(problem_id, id));
    CREATE TABLE transaction_effects(id TEXT PRIMARY KEY);
    INSERT INTO problems VALUES('P-DEMO',1000,'active'),('P-OTHER',1000,'active');
  `);
  const statements: { text: string; parameters: unknown[] }[] = [];
  const db = {
    prepare(text: string) {
      const observed = { text, parameters: [] as unknown[] };
      statements.push(observed);
      return {
        bind(...parameters: (string | number | null)[]) {
          observed.parameters = parameters;
          return this;
        },
        async all() {
          return {
            success: true,
            results: sql.query(text).all(...(observed.parameters as never[])),
            meta: {},
          };
        },
        async first() {
          return sql.query(text).get(...(observed.parameters as never[])) ?? null;
        },
        async run() {
          const result = sql.query(text).run(...(observed.parameters as never[]));
          return { success: true, results: [], meta: { changes: result.changes } };
        },
      };
    },
    async batch(batch: D1PreparedStatement[]) {
      sql.exec("BEGIN");
      try {
        const results = [];
        for (const statement of batch) results.push(await statement.all());
        sql.exec("COMMIT");
        return results;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;

  function event(
    sequence: number,
    objectId: string,
    kind: "claim" | "evidence" = "evidence",
    body: Record<string, unknown> = { body_md: "Readable work product" },
    version = 1,
    problem = "P-DEMO",
  ): GroundingWitness {
    const eventId = `EV-${problem}-${sequence}`;
    const payloadJson = JSON.stringify(body);
    const digest = payloadDigest(payloadJson);
    sql.query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      eventId, problem, sequence, objectId, kind, version,
      kind === "claim" && version > 1 ? "claim.revised" : `${kind}.created`,
      digest, "F-author", "usr-author",
    );
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(eventId, digest, payloadJson);
    if (kind === "claim")
      sql.query("INSERT OR REPLACE INTO claims VALUES(?,?,?,?)").run(
        objectId, problem, sequence, digest,
      );
    return { eventId, payloadDigest: digest, payloadJson, problemId: problem };
  }

  function evidence(
    sequence: number,
    dependencies: readonly EvidenceReference[] = [],
    patch: Record<string, unknown> = {},
    problem = "P-DEMO",
  ) {
    const evidenceId = `E-${sequence}`;
    const witness = event(sequence, evidenceId, "evidence", {
      bears_on_kind: "claim",
      bears_on_id: "C-1",
      bears_on_version: 1,
      mode: "confirmatory",
      computed_class: "computation",
      kind: "computation",
      direction: "supports",
      body_md: `RESTRICTED-CANARY-${sequence}: a reproducible finite enumeration`,
      scientific_provenance: { method: { evidence: dependencies } },
      ...patch,
    }, 1, problem);
    return {
      ...witness,
      ref: { evidence_id: evidenceId, digest: `sha256:${witness.payloadDigest}` },
    };
  }

  function control(target: string, visibility: "hidden" | "visible" = "hidden", problem = "P-DEMO") {
    sql.query(`INSERT INTO content_controls
      SELECT ?, ?, COALESCE(MAX(version), 0) + 1, ? FROM content_controls
      WHERE problem_id = ? AND target_ref = ?`).run(problem, target, visibility, problem, target);
  }

  return { sql, db, statements, event, evidence, control, close: () => sql.close() };
}
