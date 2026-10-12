import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { Env } from "../../src/env";
import {
  genesisChainDigest,
  type KraterLedgerBatchMember,
  writeLedgerEvent,
} from "../../src/krater/krater";
import {
  type ScreenedPublication,
  screeningPublicationStatements,
} from "../../src/screening/ingress";
import { screenPublicCandidate } from "../../src/screening/public-candidate";
import type { PublicationBatchContext } from "../../src/screening/publication-context";
import type { WorkersAIPromotionInput } from "../../src/screening/workers-ai";
import { syntheticScreeningObservation } from "./screening";

export const PROBLEM = "P-CONTEXT";
export const FELLOW = "F-CONTEXT";
export const OTHER = "F-OTHER";
export const SPONSOR = "usr_context";
export const SESSION = "S-CONTEXT";
export const NOW = () => new Date().toISOString();
const MIGRATIONS = new URL("../../../../db/migrations/", import.meta.url).pathname;
export async function publicationContextFixture() {
  const sql = new Database(":memory:");
  for (const name of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sql.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  type Statement = D1PreparedStatement & { text: string; values: (string | number | null)[] };
  const execute = (text: string, values: (string | number | null)[]) => {
    const results = sql.query(text).all(...values);
    const changes = (sql.query("SELECT changes() AS n").get() as { n: number }).n;
    return {
      success: true,
      results,
      meta: { changes, rows_read: results.length, rows_written: changes },
    };
  };
  const prepare = (text: string, values: (string | number | null)[] = []): Statement =>
    ({
      text,
      values,
      bind(...bound: (string | number | null)[]) {
        return prepare(text, bound);
      },
      async first() {
        return sql.query(text).get(...values) ?? null;
      },
      async all() {
        return execute(text, values);
      },
      async run() {
        return execute(text, values);
      },
    }) as unknown as Statement;
  const db = {
    prepare,
    async batch(statements: readonly Statement[]) {
      sql.exec("BEGIN");
      try {
        const results = statements.map((statement) => execute(statement.text, statement.values));
        sql.exec("COMMIT");
        return results;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  sql
    .query("INSERT INTO sponsors(sponsor_id,created_at,last_seen_at) VALUES(?,?,?)")
    .run(SPONSOR, Date.now(), Date.now());
  for (const [index, fellow] of [FELLOW, OTHER].entries())
    sql
      .query(`INSERT INTO enrollment_fellows
    (fellow_id,sponsor_id,name,model,harness,created_at) VALUES(?,?,?,?,?,?)`)
      .run(fellow, SPONSOR, `context-${index}`, "model", "harness", Date.now());
  const seedProblem = async (
    id: string,
    status = "active",
    statement = "Exact public problem statement.",
  ) => {
    sql
      .query(`INSERT INTO problems(id,public_seq,status,title,sponsor_id,created_at,updated_at,chain_version,chain_digest)
      VALUES(?,0,?,'Context problem',?,?,?,2,?)`)
      .run(id, status, SPONSOR, NOW(), NOW(), await genesisChainDigest(id));
    sql
      .query(`INSERT INTO problem_statement_versions(problem_id,version,statement,norm_hash,falsifier,motivation,created_at)
      VALUES(?,1,?,'sha256:legacy-statement','Exact public falsifier.','Exact public motivation.',?)`)
      .run(id, statement, NOW());
    sql
      .query(`INSERT INTO krater_integrity_backfill(problem_id,state,legacy_event_count,completed_at,chain_version)
      VALUES(?,'complete',0,?,2)`)
      .run(id, NOW());
  };
  await seedProblem(PROBLEM);
  let serial = 0;
  const input = (statement = "Complete candidate."): WorkersAIPromotionInput => ({
    problemId: PROBLEM,
    fellowId: FELLOW,
    kind: "hypotheses",
    statement,
    falsifier: "Exact falsifier.",
  });
  const command = (
    candidate: WorkersAIPromotionInput,
    screened?: ScreenedPublication,
    eventId = `E-CONTEXT-${++serial}`,
  ): KraterLedgerBatchMember => ({
    input: {
      problemId: candidate.problemId,
      eventId,
      idempotencyKey: `key-${eventId}`,
      requestDigest: "a".repeat(64),
      eventType: "hypothesis.created",
      objectKind: "hypothesis",
      objectId: `H-${eventId}`,
      objectVersion: 1,
      payloadJson: JSON.stringify({ body_md: candidate.statement, falsifier: candidate.falsifier }),
      createdAt: NOW(),
      attribution: {
        fellowId: candidate.fellowId,
        sponsorId: SPONSOR,
        sessionId: SESSION,
        modelSelfDeclared: "model",
        harness: "harness",
      },
    },
    projection: {
      statementsAfterEvent: () =>
        screened === undefined
          ? []
          : screeningPublicationStatements(db, screened, eventId, SESSION, "a".repeat(64)),
    },
    causedByEventIds: [],
  });
  const write = async (candidate: WorkersAIPromotionInput, screened?: ScreenedPublication) => {
    const member = command(candidate, screened);
    return writeLedgerEvent(db, member.input, member.projection);
  };
  const visible = (target: string, visibility: "hidden" | "visible", version = 1) => {
    sql
      .query(`INSERT INTO content_controls(control_id,problem_id,target_kind,target_ref,visibility,source,
      reason_category,actor,reason,version,created_at) VALUES(?,?,'hypothesis',?,?,'operator','privacy',
      'operator-context','Context visibility control.',?,?)`)
      .run(`CC-${++serial}`, PROBLEM, target, visibility, version, NOW());
  };
  const screen = async (
    candidate = input(),
    during?: () => Promise<void>,
    batch?: PublicationBatchContext,
  ) =>
    screenPublicCandidate(
      async (value) => {
        await during?.();
        return syntheticScreeningObservation(value, {
          decision: "pass",
          coarse_category: "benign-context",
          provider_status: "ok",
        });
      },
      { DB: db } as Env,
      candidate,
      { sponsorId: SPONSOR, route: "hypotheses" },
      batch,
    );
  const state = () => ({
    events: sql.query("SELECT id,seq FROM events ORDER BY seq").all(),
    head: sql.query("SELECT public_seq,chain_digest FROM problems WHERE id=?").get(PROBLEM),
    receipts: sql.query("SELECT event_id FROM screening_publications ORDER BY event_id").all(),
    replay: sql
      .query("SELECT idempotency_key,event_id FROM idempotency ORDER BY idempotency_key")
      .all(),
  });
  return { sql, db, input, command, write, visible, screen, state, seedProblem };
}
