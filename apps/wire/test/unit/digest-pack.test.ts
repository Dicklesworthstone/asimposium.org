import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import type { FellowCredentialBinding } from "../../src/enrollment/service.ts";
import { readPublishedProblemFormulation } from "../../src/ledger/problem-formulation-read.ts";
import { type DigestPackDependencies, readDigestPack } from "../../src/sessions/digest.ts";
import type { WorkingMovesPackSection } from "../../src/sessions/working-moves.ts";

const PROBLEM = "P-DIGEST";
const STATEMENT = "For every integer n, n squared and n have equal parity.";
const AT = "2026-10-27T00:00:00.000Z";
async function hash(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function moveSection(overrides: Partial<WorkingMovesPackSection> = {}): WorkingMovesPackSection {
  return {
    candidates: [],
    omitted: [],
    alternatives: [],
    degraded: false,
    primaryMove: {
      move: "review",
      refs: [PROBLEM, "C-1@2"],
      why: "Independent check.",
      contract: {},
    },
    ...overrides,
  };
}

// Unit adapter: execute the production selector SQL on SQLite. This is not
// presented as proof of provider D1 behavior; mounted Workerd coverage is separate.
async function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems (id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, payload_sha256 TEXT,
      UNIQUE(problem_id, seq));
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT,
      payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls (problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE scientific_withdrawals (source_event_id TEXT);
    CREATE TABLE claim_projections (problem_id TEXT, stale INTEGER);
    CREATE TABLE projection_health (problem_id TEXT, status TEXT);
    INSERT INTO problems VALUES ('P-DIGEST', 0, 'active');
  `);
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      queries.push(query);
      return {
        bind(...values: (string | number | null)[]) {
          return {
            async first<T>() {
              return sql.prepare(query).get(...values) as T | null;
            },
            async all<T>() {
              return { results: sql.prepare(query).all(...values) as T[] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  let cursor = 0;
  async function append(
    type: string,
    kind: string,
    object: string,
    version = 1,
    value: unknown = {},
  ) {
    cursor++;
    const id = `E-${cursor}`;
    const body = JSON.stringify(value);
    const digest = await hash(body);
    sql
      .prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, PROBLEM, cursor, type, kind, object, version, digest);
    sql.prepare("INSERT INTO event_content VALUES (?, ?, ?, NULL)").run(id, digest, body);
    sql.prepare("UPDATE problems SET public_seq = ? WHERE id = ?").run(cursor, PROBLEM);
    return { id, seq: cursor, digest };
  }
  const publication = await append("problem.admitted", "problem", PROBLEM, 1, {
    action: "publish",
    previous_status: "private-draft",
    previous_statement_version: 1,
    acting_principal: { type: "sponsor", id: "usr_digest_owner" },
    source_fellow_id: "F-DIGEST",
    problem: {
      id: PROBLEM,
      title: "Parity",
      status: "sharpening",
      current_statement_version: 1,
      statement: STATEMENT,
      falsifier: "An integer with different parity after squaring.",
      motivation: "Check both residues modulo two.",
      updated_at: AT,
    },
  });
  const dependencies: DigestPackDependencies = {
    formulation: readPublishedProblemFormulation,
    moves: async () => moveSection(),
  };
  const read = (overrides: Partial<DigestPackDependencies> = {}, cut = cursor) =>
    readDigestPack(
      {
        db,
        problemId: PROBLEM,
        sessionId: "S-DIGEST",
        cursor: cut,
        role: "contributor",
        credential: {} as FellowCredentialBinding,
      },
      { ...dependencies, ...overrides },
    );
  return { sql, db, queries, append, read, publication, cursor: () => cursor };
}
function summary(section: Awaited<ReturnType<typeof readDigestPack>>) {
  const candidate = section.candidates.find((item) => item.id === "SYS-digest");
  expect(candidate).toBeDefined();
  return JSON.parse(candidate!.body);
}

describe("compact digest pack", () => {
  test("hashes the verified statement and counts visible publication records without transferring bodies", async () => {
    const f = await fixture();
    await f.append("claim.created", "claim", "C-1");
    await f.append("claim.revised", "claim", "C-1", 2);
    await f.append("hypothesis.created", "hypothesis", "H-1");
    await f.append("review.created", "review", "R-1");
    await f.append("dead_end.recorded", "dead_end", "DE-1");
    const result = await f.read();
    const digest = summary(result);
    expect(digest.statement).toEqual({ version: 1, sha256: await hash(STATEMENT) });
    expect(digest.statement.sha256).not.toBe(f.publication.digest);
    expect(digest.counts).toEqual({ claim_heads: 1, hypotheses: 1, reviews: 1 });
    expect(digest.next_move).toEqual({ move: "review", refs: ["C-1@2"] });
    expect(digest.move_status).toBe("available");
    expect(digest.projection_health).toBe("no-recorded-drift");
    expect(digest.counts_meaning).toContain("not active outcomes");
    expect(JSON.stringify(result)).not.toContain(STATEMENT);
    expect(JSON.stringify(result)).not.toContain("DE-1");
    expect(result.actions).toEqual([
      {
        method: "GET",
        url: "/v1/p/P-DIGEST/next",
        public_read: false,
        why: "Read the current complete move contract before writing.",
      },
    ]);
    expect(
      f.queries.some((query) => /workshop_objects|FROM sessions|FROM leases/.test(query)),
    ).toBe(false);
    expect(await f.read()).toEqual(result);
  });

  test("latest hidden or missing claim versions do not fall back to older publication counts", async () => {
    const f = await fixture();
    await f.append("claim.created", "claim", "C-1");
    const revised = await f.append("claim.revised", "claim", "C-1", 2);
    const hypothesis = await f.append("hypothesis.created", "hypothesis", "H-1");
    const review = await f.append("review.created", "review", "R-1");
    f.sql.prepare("INSERT INTO content_controls VALUES (?, 'C-1@2', 'hidden', 1)").run(PROBLEM);
    f.sql
      .prepare("UPDATE event_content SET redacted_at = ? WHERE event_id = ?")
      .run(AT, hypothesis.id);
    f.sql.prepare("INSERT INTO scientific_withdrawals VALUES (?)").run(review.id);
    expect(summary(await f.read()).counts).toEqual({ claim_heads: 0, hypotheses: 0, reviews: 0 });
    f.sql.prepare("INSERT INTO content_controls VALUES (?, 'C-1@2', 'visible', 2)").run(PROBLEM);
    expect(summary(await f.read()).counts.claim_heads).toBe(1);
    // Even a malformed tombstone with no redaction timestamp is unavailable.
    f.sql
      .prepare("UPDATE event_content SET payload_json = NULL WHERE event_id = ?")
      .run(revised.id);
    expect(summary(await f.read()).counts.claim_heads).toBe(0);
    f.sql
      .prepare("UPDATE event_content SET payload_json = '{}' WHERE event_id = ?")
      .run(revised.id);
    f.sql
      .prepare("UPDATE event_content SET redacted_at = ? WHERE event_id = ?")
      .run(AT, revised.id);
    expect(summary(await f.read()).counts.claim_heads).toBe(0);
  });

  test("missing or digest-detached formulation is unavailable, not a hash of retained or forged text", async () => {
    const f = await fixture();
    f.sql
      .prepare("UPDATE event_content SET payload_json = ? WHERE event_id = ?")
      .run('{"statement":"FORGED-FORMULATION"}', f.publication.id);
    const result = await f.read();
    expect(summary(result).statement).toBeNull();
    expect(summary(result).counts).toEqual({ claim_heads: 0, hypotheses: 0, reviews: 0 });
    expect(result.omitted).toContainEqual({ reason: "problem_formulation_unavailable" });
    expect(JSON.stringify(result)).not.toContain("FORGED-FORMULATION");
  });

  for (const change of ["advance", "control", "redact"] as const) {
    test(`a ${change} during selection discards sampled fields even without a new ledger cursor`, async () => {
      const f = await fixture();
      await f.append("claim.created", "claim", "C-1");
      const cut = f.cursor();
      const result = await f.read(
        {
          moves: async () => {
            if (change === "advance") await f.append("claim.created", "claim", "C-2");
            else if (change === "control")
              f.sql
                .prepare("INSERT INTO content_controls VALUES (?, '#1', 'hidden', 1)")
                .run(PROBLEM);
            else
              f.sql
                .prepare("UPDATE event_content SET redacted_at = ? WHERE event_id = ?")
                .run(AT, f.publication.id);
            return moveSection();
          },
        },
        cut,
      );
      const digest = summary(result);
      expect(digest.statement).toBeNull();
      expect(digest.counts).toBeNull();
      expect(digest.next_move).toBeNull();
      expect(digest.move_status).toBe("unavailable");
      expect(result.omitted).toContainEqual({ reason: "digest_snapshot_changed" });
      if (change !== "advance") expect(f.cursor()).toBe(cut);
    });
  }

  test("separates empty, unavailable and partial recommendations with bounded target references", async () => {
    const f = await fixture();
    const none = await f.read({ moves: async () => moveSection({ primaryMove: null }) });
    expect(summary(none).move_status).toBe("none-permitted");
    expect(summary(none).next_move).toBeNull();
    const missing = await f.read({
      moves: async () => {
        throw new Error("PRIVATE-MOVE-FAILURE");
      },
    });
    expect(summary(missing).move_status).toBe("unavailable");
    expect(missing.degraded).toContain("digest_moves_unavailable");
    expect(JSON.stringify(missing)).not.toContain("PRIVATE-MOVE-FAILURE");
    const partial = await f.read({
      moves: async () =>
        moveSection({
          degraded: true,
          primaryMove: {
            move: "review",
            refs: [PROBLEM, "C-1@1", "C-2@1", "C-3@1"],
            why: "A bounded selection.",
            contract: {},
          },
        }),
    });
    expect(summary(partial).next_move).toEqual({
      move: "review",
      refs: ["C-1@1", "C-2@1"],
      refs_omitted: 1,
    });
    expect(summary(partial).move_status).toBe("partial");
    expect(partial.degraded).toContain("digest_moves_incomplete");
  });

  test("recorded projection drift remains visible without exposing a private maintenance tally", async () => {
    const f = await fixture();
    f.sql.prepare("INSERT INTO projection_health VALUES (?, 'drift')").run(PROBLEM);
    expect(summary(await f.read()).projection_health).toBe("STALE");
    expect(summary(await f.read()).counts).toEqual({ claim_heads: 0, hypotheses: 0, reviews: 0 });
  });

  test("a hidden whole problem returns no statement, recommendation or false zero counts", async () => {
    const f = await fixture();
    f.sql.prepare("INSERT INTO content_controls VALUES (?, 'problem', 'hidden', 1)").run(PROBLEM);
    const digest = summary(await f.read());
    expect(digest.statement).toBeNull();
    expect(digest.counts).toBeNull();
    expect(digest.next_move).toBeNull();
  });
});
