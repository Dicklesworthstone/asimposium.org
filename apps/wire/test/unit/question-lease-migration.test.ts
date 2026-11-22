import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SponsorLeaseIdSchema } from "@asimposium/contracts";

const readMigration = (name: string) =>
  readFileSync(new URL(`../../../../db/migrations/${name}`, import.meta.url), "utf8");
const migration = readMigration("0151_unified_question_leases.sql");
const P = "P-LEGACY-QUESTION";
const CREATED = "2026-01-01T00:00:00.000Z";
const TERMINAL = "2026-01-01T00:01:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE = "2100-01-01T00:00:00.000Z";
const RENEWED = "2100-01-01T01:00:00.000Z";
const FELLOW = "F-00000000000000000000000001";
const SPONSOR = "usr_legacy_question_sponsor";
const CORRUPTED = "CORRUPTED-AUTHORED-LEASE-TERMS-MUST-NOT-BE-ADOPTED";
type Row = Record<string, string | number | null>;

/** Direct populated migration unit proof. Use the shipped question/lease table
 * definitions with minimal parent tables; this is not a native D1 journey. */
function fixture() {
  const sql = new Database(":memory:", { strict: true });
  sql.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER NOT NULL);
    CREATE TABLE sessions(session_id TEXT PRIMARY KEY, problem_id TEXT NOT NULL REFERENCES problems(id),
      fellow_id TEXT NOT NULL, closed_at TEXT, idle_close_at TEXT NOT NULL);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT NOT NULL REFERENCES problems(id),
      seq INTEGER NOT NULL, type TEXT NOT NULL, object_kind TEXT NOT NULL, object_id TEXT NOT NULL,
      object_version INTEGER NOT NULL, actor_session_id TEXT, actor_fellow_id TEXT, actor_sponsor_id TEXT,
      payload_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(problem_id,seq));
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY REFERENCES events(id),
      payload_sha256 TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE session_write_replays(scope TEXT NOT NULL, principal_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL, response_ciphertext TEXT NOT NULL,
      response_initialization_vector TEXT NOT NULL, expires_at INTEGER NOT NULL, claim_token TEXT,
      PRIMARY KEY(scope,principal_scope,idempotency_key));
    CREATE TABLE public_cursor(singleton INTEGER PRIMARY KEY, cursor INTEGER NOT NULL);
    INSERT INTO public_cursor VALUES(1,314159);`);
  sql.query("INSERT INTO problems VALUES(?,100000)").run(P);
  sql.query("INSERT INTO problems VALUES('P-OTHER',100000)").run();
  const questions = readMigration("0053_questions_and_retractions_replay_scope.sql");
  sql.exec(
    questions.slice(
      questions.indexOf("CREATE TABLE questions_widened ("),
      questions.indexOf("INSERT INTO questions_widened ("),
    ),
  );
  sql.exec("ALTER TABLE questions_widened RENAME TO questions");
  const leases = readMigration("0056_leases_and_replay_scope.sql");
  sql.exec(leases.slice(leases.indexOf("CREATE TABLE leases (")));
  sql
    .query(
      "INSERT INTO session_write_replays VALUES('lease_question',?,'original-key',?,?,?,2100000000000,'original-claim-token')",
    )
    .run(FELLOW, "original-request-digest", "original-encrypted-receipt-✓", "original-iv");

  function event(input: {
    seq: number;
    questionId: string;
    type: string;
    sessionId: string;
    eventId?: string;
    fellowId?: string;
    sponsorId?: string | null;
    createdAt?: string;
  }) {
    const id = input.eventId ?? `E-${String(input.seq).padStart(26, "0")}`;
    const payload = JSON.stringify({
      question_id: input.questionId,
      objective: "Original precise objective.",
      deliverable: "Original finite work product.",
      leased_until: FUTURE,
    });
    const digest = createHash("sha256").update(payload).digest("hex");
    sql
      .query("INSERT INTO events VALUES(?,?,?,?,'question',?,1,?,?,?,?,?)")
      .run(
        id,
        P,
        input.seq,
        input.type,
        input.questionId,
        input.sessionId,
        input.fellowId ?? FELLOW,
        input.sponsorId === undefined ? SPONSOR : input.sponsorId,
        digest,
        input.createdAt ?? CREATED,
      );
    sql.query("INSERT INTO event_content VALUES(?,?,?)").run(id, digest, payload);
    return id;
  }

  function question(
    index: number,
    options: {
      status?: "open" | "leased" | "resolved" | "withdrawn";
      leasedUntil?: string;
      closedAt?: string | null;
      idleCloseAt?: string;
      terminal?: "question.answered" | "question.withdrawn";
      leasedBy?: string;
      sessionFellow?: string;
      sessionProblem?: string;
      eventId?: string;
      creationSeq?: number;
      sponsorId?: string | null;
    } = {},
  ) {
    const questionId = `Q-legacy-${index}`;
    const sessionId = `S-${String(index).padStart(26, "0")}`;
    const seq = index * 10;
    sql
      .query("INSERT INTO sessions VALUES(?,?,?,?,?)")
      .run(
        sessionId,
        options.sessionProblem ?? P,
        options.sessionFellow ?? FELLOW,
        options.closedAt ?? null,
        options.idleCloseAt ?? FUTURE,
      );
    event({ seq, questionId, type: "question.asked", sessionId });
    const sourceId = event({
      seq: seq + 1,
      questionId,
      type: "question.leased",
      sessionId,
      ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
      ...(options.sponsorId === undefined ? {} : { sponsorId: options.sponsorId }),
    });
    if (options.terminal)
      event({ seq: seq + 2, questionId, type: options.terminal, sessionId, createdAt: TERMINAL });
    sql
      .query(`INSERT INTO questions(question_id,problem_id,seq,target_refs_json,blocking,
      body_md,author_fellow_id,status,leased_by,leased_until,resolved_by_object,created_at)
      VALUES(?,?,?,'[ "C-1@1" ]','Exact legacy blocker','Original question body.\nKeep every byte.',?,?,?,?,?,?)`)
      .run(
        questionId,
        P,
        options.creationSeq ?? seq,
        FELLOW,
        options.status ?? "leased",
        options.leasedBy ?? FELLOW,
        options.leasedUntil ?? FUTURE,
        options.status === "resolved" ? "C-1@1" : null,
        CREATED,
      );
    return { questionId, sessionId, seq, sourceId, leaseId: `L-${sourceId.slice(2)}` };
  }

  function generic(
    q: ReturnType<typeof question>,
    index: number,
    status: "active" | "challenged" = "active",
  ) {
    const id = `L-${String(900000 + index).padStart(26, "0")}`;
    sql
      .query(`INSERT INTO leases(lease_id,problem_id,object_ref,object_kind,object_id,
      session_id,fellow_id,sponsor_id,objective,deliverable,parallel_safe,status,
      leased_at,leased_until,created_at,updated_at)
      VALUES(?,?,?,'question',?,?,?,?,'Existing generic objective','Existing generic deliverable',0,?,?,?, ?,?)`)
      .run(
        id,
        P,
        `Q-${q.seq}`,
        q.questionId,
        q.sessionId,
        FELLOW,
        SPONSOR,
        status,
        CREATED,
        FUTURE,
        CREATED,
        CREATED,
      );
    return id;
  }

  function rows(table: string) {
    return sql.query(`SELECT * FROM ${table} ORDER BY 1,2`).all() as Row[];
  }
  function history() {
    return Object.fromEntries(
      [
        "events",
        "event_content",
        "questions",
        "problems",
        "sessions",
        "session_write_replays",
        "public_cursor",
      ].map((table) => [table, JSON.stringify(rows(table))]),
    );
  }
  function upgrade() {
    sql.transaction(() => sql.exec(migration))();
  }
  return { sql, event, question, generic, rows, history, upgrade };
}

test("question lease adoption preserves ledger, receipts and nonterminal collisions with exact legacy attribution", () => {
  const f = fixture();
  try {
    const active = f.question(1, { leasedUntil: RENEWED });
    // A later reservation from the same session wins by immutable event order.
    const latestId = f.event({
      seq: active.seq + 2,
      questionId: active.questionId,
      type: "question.leased",
      sessionId: active.sessionId,
    });
    // Restored bytes do not match their retained digest labels. The migration
    // must retain them verbatim without copying authored terms as authority.
    f.sql
      .query("UPDATE event_content SET payload_json=? WHERE event_id=?")
      .run(JSON.stringify({ objective: CORRUPTED, deliverable: CORRUPTED }), latestId);
    const expired = f.question(2, { leasedUntil: PAST });
    const closed = f.question(3, { closedAt: CREATED });
    const idle = f.question(4, { idleCloseAt: PAST });
    const resolved = f.question(5, { status: "resolved", terminal: "question.answered" });
    const withdrawn = f.question(6, { status: "withdrawn", terminal: "question.withdrawn" });
    const collision = f.generic(active, 1);
    const resolvedGeneric = f.generic(resolved, 2);
    const withdrawnGeneric = f.generic(withdrawn, 3, "challenged");
    const originalLeases = f.rows("leases");
    const originalHistory = f.history();
    f.upgrade();
    expect(f.history()).toEqual(originalHistory);
    const rows = f.rows("leases");
    expect(rows).toHaveLength(9);
    expect(rows.find((row) => row.lease_id === collision)).toEqual(
      originalLeases.find((row) => row.lease_id === collision),
    );
    const adoptedId = `L-${latestId.slice(2)}`;
    expect(rows.find((row) => row.lease_id === adoptedId)).toMatchObject({
      problem_id: P,
      object_ref: `Q-${active.seq}`,
      object_kind: "question",
      object_id: active.questionId,
      session_id: active.sessionId,
      fellow_id: FELLOW,
      sponsor_id: SPONSOR,
      status: "active",
      parallel_safe: 0,
      leased_until: RENEWED,
      objective: `Legacy question reservation; inspect source event ${latestId}`,
      deliverable: `Historical deliverable remains in source event ${latestId}`,
      leased_at: CREATED,
      created_at: CREATED,
      updated_at: CREATED,
    });
    expect(rows.some((row) => row.lease_id === active.leaseId)).toBe(false);
    for (const [q, status] of [
      [expired, "expired"],
      [closed, "released"],
      [idle, "expired"],
      [resolved, "released"],
      [withdrawn, "released"],
    ] as const)
      expect(rows.find((row) => row.lease_id === q.leaseId)?.status).toBe(status);
    for (const id of [resolvedGeneric, withdrawnGeneric]) {
      expect(rows.find((row) => row.lease_id === id)).toEqual({
        ...originalLeases.find((row) => row.lease_id === id),
        status: "released",
        released_by: FELLOW,
        released_at: TERMINAL,
        updated_at: TERMINAL,
      });
    }
    for (const row of rows) expect(SponsorLeaseIdSchema.safeParse(row.lease_id).success).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(CORRUPTED);
    expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.sql.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    f.sql.close();
  }
});

test("question lease adoption rejects inconsistent source identity, clocks and stale lifecycle projections", () => {
  const f = fixture();
  try {
    f.question(1, { leasedBy: "F-00000000000000000000000002" });
    f.question(2, { sessionFellow: "F-00000000000000000000000002" });
    f.question(3, { sessionProblem: "P-OTHER" });
    f.question(4, { creationSeq: 10 });
    f.question(5, { eventId: "E-not-a-valid-lease-id" });
    f.question(6, { leasedUntil: "not-a-clock" });
    f.question(7, { status: "open" });
    f.question(8, { terminal: "question.answered" });
    f.question(9, { sponsorId: null });
    const unpublished = f.question(10);
    f.sql.query("UPDATE problems SET public_seq=? WHERE id=?").run(unpublished.seq, P);
    const before = f.history();
    f.upgrade();
    expect(f.rows("leases")).toEqual([]);
    expect(f.history()).toEqual(before);
    expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    f.sql.close();
  }
});
