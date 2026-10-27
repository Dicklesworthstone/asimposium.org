import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { NormalizeConflictRequestSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { selectNormalizeConflictMove } from "../../src/mega-commands/conflict-moves.ts";
import { sha256Hex } from "../../src/split/policy.ts";

/** SQL/history unit tests. The matching real Workerd lane exercises HTTP
 * publication, moderation, revision, dispute and normalization end to end. */
async function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, status TEXT, public_seq INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, payload_sha256 TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT,
      payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, version INTEGER, visibility TEXT);
    CREATE TABLE claim_relations(problem_id TEXT, kind TEXT, source_claim_id TEXT,
      source_version INTEGER, target_ref TEXT, asserted_by_event TEXT, status TEXT);
    CREATE TABLE conflicts(conflict_id TEXT, problem_id TEXT, seq INTEGER,
      claim_a_id TEXT, claim_a_version INTEGER, claim_b_id TEXT, claim_b_version INTEGER);
    CREATE TABLE retractions(retraction_id TEXT, problem_id TEXT, target_object TEXT);
    INSERT INTO problems VALUES ('P-DEMO','active',0),('P-OTHER','active',0);
  `);
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      queries.push(query);
      return {
        bind(...values: (string | number | null)[]) {
          return { all: async () => ({ results: sql.query(query).all(...values) }) };
        },
      };
    },
  } as unknown as D1Database;
  async function event(
    seq: number,
    type: string,
    kind: string,
    id: string,
    version: number,
    body: Record<string, unknown>,
    problem = "P-DEMO",
  ) {
    const eventId = `${problem}-E-${seq}`;
    const raw = JSON.stringify(body),
      digest = await sha256Hex(raw);
    sql
      .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)")
      .run(eventId, problem, seq, type, kind, id, version, digest);
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(eventId, digest, raw);
    sql.query("UPDATE problems SET public_seq=MAX(public_seq,?) WHERE id=?").run(seq, problem);
    return eventId;
  }
  async function claim(id: string, version: number, seq: number) {
    return event(seq, version === 1 ? "claim.created" : "claim.revised", "claim", id, version, {
      claim_id: id,
      kind: "conjecture",
      statement: `The exact statement of ${id} version ${version}.`,
    });
  }
  async function relation(seq: number, source = "C-1", version = 1, target = "C-2@1") {
    const id = `${source}@${version}-contradicts-${target}`;
    const eventId = await event(seq, "relation.asserted", "relation", id, 1, {
      kind: "contradicts",
      source: `${source}@${version}`,
      target,
    });
    sql
      .query("INSERT INTO claim_relations VALUES('P-DEMO','contradicts',?,?,?,?, 'asserted')")
      .run(source, version, target, eventId);
    return { id, eventId };
  }
  await claim("C-1", 1, 1);
  await claim("C-2", 1, 2);
  const assertion = await relation(3);
  const read = (cursor = 3) => selectNormalizeConflictMove(db, "P-DEMO", cursor);
  return { sql, db, queries, event, claim, relation, assertion, read };
}

describe("current, visible conflict normalization recommendations", () => {
  test("returns executable pins and exact source reads without inventing completed alignment", async () => {
    const f = await fixture();
    try {
      const selected = await f.read();
      expect(selected.degraded).toBe(false);
      expect(selected.move?.refs).toEqual(["P-DEMO", "C-1@1", "C-2@1"]);
      const hints = selected.move?.contract.prefilled_hints;
      if (hints === null || typeof hints !== "object" || Array.isArray(hints)) {
        throw new Error("The selected move must provide a request object.");
      }
      expect(hints).toEqual({
        claims: [
          { claim_id: "C-1", version: 1 },
          { claim_id: "C-2", version: 1 },
        ],
      });
      expect(
        NormalizeConflictRequestSchema.safeParse({
          ...hints,
          aligned_definitions: "Both use the same integer arithmetic definitions.",
          aligned_scope: "The two assertions concern the exact same finite domain.",
          aligned_quantifiers: "Both universally quantify over that same finite domain.",
          smallest_disagreement: "The assertions differ on the parity of the same value.",
          agreed_facts: ["Integer parity is reduction modulo two."],
          discriminating_tests: ["Compute the disputed value modulo two."],
        }).success,
      ).toBe(true);
      expect(selected.move?.contract.preparation).toEqual(
        expect.objectContaining({
          read_first: { method: "GET", path: "/p/P-DEMO/relations/3.md" },
        }),
      );
      expect(f.queries).toHaveLength(1);
      expect((await f.read(2)).move).toBeNull();
    } finally {
      f.sql.close();
    }
  });

  test.each(["C-1", "C-2"])("a revision of %s retires the edge at the new cut", async (id) => {
    const f = await fixture();
    try {
      await f.claim(id, 2, 4);
      expect((await f.read(4)).move).toBeNull();
      expect((await f.read(3)).move?.refs).toEqual(["P-DEMO", "C-1@1", "C-2@1"]);
      // Withholding the newest statement cannot resurrect the older pin.
      f.sql.query("UPDATE event_content SET redacted_at='now' WHERE event_id='P-DEMO-E-4'").run();
      expect((await f.read(4)).move).toBeNull();
    } finally {
      f.sql.close();
    }
  });

  test("a later dispute retires current recommendations without rewriting the old cut", async () => {
    const f = await fixture();
    try {
      await f.event(4, "relation.disputed", "relation", f.assertion.id, 1, {
        kind: "contradicts",
        source: "C-1@1",
        target: "C-2@1",
      });
      f.sql.exec("UPDATE claim_relations SET status='disputed'");
      expect((await f.read(4)).move).toBeNull();
      expect((await f.read(3)).move?.move).toBe("normalize-conflict");
      f.sql.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='P-DEMO-E-4'");
      expect((await f.read(4)).move).toBeNull();
    } finally {
      f.sql.close();
    }
  });

  test("only a normalized exact pair on this problem and at this cut retires the move", async () => {
    const f = await fixture();
    try {
      await f.event(4, "conflict.normalized", "conflict", "CF-1", 1, {});
      f.sql.exec("INSERT INTO conflicts VALUES('CF-1','P-DEMO',4,'C-2',2,'C-1',1)");
      expect((await f.read(4)).move?.move).toBe("normalize-conflict");
      f.sql.exec("UPDATE conflicts SET claim_a_version=1");
      expect((await f.read(4)).move).toBeNull();
      expect((await f.read(3)).move?.move).toBe("normalize-conflict");
      f.sql.exec("UPDATE conflicts SET problem_id='P-OTHER'");
      expect((await f.read(4)).move?.move).toBe("normalize-conflict");
    } finally {
      f.sql.close();
    }
  });

  test.each([
    "problem",
    "C-1",
    "C-1@1",
    "#1",
    "C-2",
    "C-2@1",
    "#2",
    "C-1@1-contradicts-C-2@1",
    "#3",
  ])("current control %s also applies to historical reads", async (target) => {
    const f = await fixture();
    try {
      f.sql.query("INSERT INTO content_controls VALUES('P-DEMO',?,1,'hidden')").run(target);
      expect((await f.read()).move).toBeNull();
      f.sql.query("INSERT INTO content_controls VALUES('P-DEMO',?,2,'visible')").run(target);
      expect((await f.read()).move?.move).toBe("normalize-conflict");
    } finally {
      f.sql.close();
    }
  });

  test.each([1, 2, 3])(
    "redacted publication %s never contributes a recommendation",
    async (seq) => {
      const f = await fixture();
      try {
        f.sql
          .query("UPDATE event_content SET redacted_at='now' WHERE event_id=?")
          .run(`P-DEMO-E-${seq}`);
        expect((await f.read()).move).toBeNull();
      } finally {
        f.sql.close();
      }
    },
  );

  test.each(["C-1", "C-2@1"])(
    "withdrawn target %s is not a live normalization task",
    async (target) => {
      const f = await fixture();
      try {
        await f.event(4, "object.retracted", "retraction", "RT-1", 1, { target_object: target });
        f.sql.query("INSERT INTO retractions VALUES('RT-1','P-DEMO',?)").run(target);
        expect((await f.read(4)).move).toBeNull();
        expect((await f.read(3)).move?.move).toBe("normalize-conflict");
      } finally {
        f.sql.close();
      }
    },
  );

  test("invalid source bytes degrade without trusting a matching digest column", async () => {
    const f = await fixture();
    try {
      f.sql.exec("UPDATE event_content SET payload_json='{}' WHERE event_id='P-DEMO-E-1'");
      expect(await f.read()).toEqual({ move: null, degraded: true });
    } finally {
      f.sql.close();
    }
  });

  test("foreign assertion envelopes cannot lend authority to a local projection", async () => {
    const f = await fixture();
    try {
      f.sql.exec("UPDATE events SET problem_id='P-OTHER' WHERE id='P-DEMO-E-3'");
      expect((await f.read()).move).toBeNull();
      expect(await f.read(10)).toEqual({ move: null, degraded: true });
      expect(await f.read(-1)).toEqual({ move: null, degraded: true });
    } finally {
      f.sql.close();
    }
  });

  test("checks at most eight source triples and discloses the remaining candidate", async () => {
    const f = await fixture();
    try {
      let seq = 3;
      for (let i = 3; i <= 9; i++) {
        await f.claim(`C-${i}`, 1, ++seq);
        await f.relation(++seq, "C-1", 1, `C-${i}@1`);
      }
      await f.claim("C-10", 1, ++seq);
      await f.relation(++seq, "C-10", 1, "C-2@1");
      const bounded = await f.read(seq);
      expect(bounded.move?.refs).toEqual(["P-DEMO", "C-1@1", "C-2@1"]);
      expect(bounded.degraded).toBe(true);
      // The ninth candidate is valid but lies beyond the advertised bound.
      f.sql.exec("UPDATE event_content SET payload_json='{}' WHERE event_id='P-DEMO-E-1'");
      expect(await f.read(seq)).toEqual({ move: null, degraded: true });
      expect(f.queries).toHaveLength(2);
    } finally {
      f.sql.close();
    }
  });
});
