import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import { selectCollapseDuplicateMove } from "../../src/mega-commands/duplicate-moves.ts";
import { normHash, sha256Hex } from "../../src/split/policy.ts";

/** History/SQL units, including legacy publications without indexed hashes.
 * Modern P11 admission prevents duplicate heads; discovery must still avoid
 * turning old versions, corrupt projections or withheld work into advice. */
async function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, status TEXT, public_seq INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, payload_sha256 TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT,
      payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, version INTEGER, visibility TEXT);
    CREATE TABLE claims(id TEXT, problem_id TEXT, norm_hash TEXT);
    CREATE TABLE claim_relations(problem_id TEXT, kind TEXT, source_claim_id TEXT,
      source_version INTEGER, target_ref TEXT, asserted_by_event TEXT, status TEXT);
    CREATE TABLE retractions(retraction_id TEXT, problem_id TEXT, target_object TEXT);
    INSERT INTO problems VALUES ('P-DEMO','active',0);
  `);
  const queries: string[] = [];
  const reads: unknown[][] = [];
  let beforePairRead: (() => void | Promise<void>) | undefined;
  const db = {
    prepare(query: string) {
      queries.push(query);
      return {
        bind(...values: (string | number | null)[]) {
          return {
            all: async () => {
              const results = sql.query(query).all(...values);
              reads.push(results);
              return { success: true, results };
            },
            first: async () => {
              await beforePairRead?.();
              beforePairRead = undefined;
              return sql.query(query).get(...values);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  let sequence = 0;
  async function event(type: string, kind: string, id: string, version: number, body: unknown) {
    const seq = ++sequence;
    const eventId = `EV-${seq}`;
    const raw = JSON.stringify(body),
      digest = await sha256Hex(raw);
    sql
      .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)")
      .run(eventId, "P-DEMO", seq, type, kind, id, version, digest);
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(eventId, digest, raw);
    sql.query("UPDATE problems SET public_seq=? WHERE id='P-DEMO'").run(seq);
    return { eventId, seq };
  }
  async function claim(id: string, statement: string, version = 1) {
    const published = await event(
      version === 1 ? "claim.created" : "claim.revised",
      "claim",
      id,
      version,
      {
        claim_id: id,
        kind: "conjecture",
        statement,
        ...(version > 1 ? { base_version: version - 1 } : {}),
      },
    );
    if (version === 1)
      sql.query("INSERT INTO claims VALUES(?,'P-DEMO',?)").run(id, await normHash(statement));
    else sql.query("UPDATE claims SET norm_hash=? WHERE id=?").run(await normHash(statement), id);
    return published;
  }
  async function relation(source = "C-1@1", target = "C-2@1") {
    const id = `${source}-equivalent-to-${target}`;
    const published = await event("relation.asserted", "relation", id, 1, {
      source,
      target,
      kind: "equivalent-to",
    });
    const [claimId, version] = source.split("@");
    if (!claimId || !version) throw new Error("Expected an exact relation source");
    sql
      .query("INSERT INTO claim_relations VALUES('P-DEMO','equivalent-to',?,?,?,?, 'asserted')")
      .run(claimId, Number(version), target, published.eventId);
    return { ...published, id };
  }
  await claim("C-1", "Zero squared is even.");
  await claim("C-2", "ZERO  squared is even.");
  return {
    sql,
    db,
    queries,
    reads,
    beforePairRead: (callback: () => void | Promise<void>) => {
      beforePairRead = callback;
    },
    claim,
    event,
    relation,
    read: (cursor = sequence) => selectCollapseDuplicateMove(db, "P-DEMO", cursor),
  };
}

describe("duplicate recommendations from current immutable statements", () => {
  test("legacy claims with no indexed hash remain discoverable with exact read links", async () => {
    const f = await fixture();
    try {
      f.sql.exec("UPDATE claims SET norm_hash=NULL");
      const result = await f.read();
      expect(result.degraded).toBe(false);
      expect(result.move?.refs).toEqual(["P-DEMO", "C-1@1", "C-2@1"]);
      expect(result.move?.contract.preparation).toMatchObject({
        captured_cursor: 2,
        read_first: [
          { method: "GET", path: "/p/P-DEMO/claims/C-1%401.md?through=2" },
          { method: "GET", path: "/p/P-DEMO/claims/C-2%401.md?through=2" },
        ],
      });
      expect(result.move?.why).toContain("not proof of equivalence");
    } finally {
      f.sql.close();
    }
  });

  test("mutable hashes and historical versions cannot create a matching current pair", async () => {
    const f = await fixture();
    try {
      await f.claim("C-2", "One squared is odd.", 2);
      f.sql.exec("UPDATE claims SET norm_hash='forged-equal-projection'");
      expect((await f.read()).move).toBeNull();
      expect((await f.read(2)).degraded).toBe(true);
    } finally {
      f.sql.close();
    }
  });

  test.each(["problem", "C-1", "C-1@1", "#1", "C-2", "C-2@1", "#2"])(
    "current control %s withholds duplicate recommendations",
    async (target) => {
      const f = await fixture();
      try {
        f.sql.query("INSERT INTO content_controls VALUES('P-DEMO',?,1,'hidden')").run(target);
        expect((await f.read()).move).toBeNull();
        f.sql.query("INSERT INTO content_controls VALUES('P-DEMO',?,2,'visible')").run(target);
        expect((await f.read()).move?.move).toBe("collapse-duplicate");
      } finally {
        f.sql.close();
      }
    },
  );

  test.each(["redacted", "tampered", "missing"])(
    "%s source bytes never establish a duplicate",
    async (state) => {
      const f = await fixture();
      try {
        if (state === "redacted")
          f.sql.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='EV-2'");
        if (state === "tampered")
          f.sql.exec("UPDATE event_content SET payload_json='{}' WHERE event_id='EV-2'");
        if (state === "missing") f.sql.exec("DELETE FROM event_content WHERE event_id='EV-2'");
        const result = await f.read();
        expect(result.move).toBeNull();
        expect(result.degraded).toBe(true);
      } finally {
        f.sql.close();
      }
    },
  );

  test("a withdrawn identity or exact pin is not actionable", async () => {
    for (const target of ["C-2", "C-2@1"]) {
      const f = await fixture();
      try {
        await f.event("object.retracted", "retraction", "RET-1", 1, { target_object: target });
        f.sql.query("INSERT INTO retractions VALUES('RET-1','P-DEMO',?)").run(target);
        expect((await f.read()).move).toBeNull();
      } finally {
        f.sql.close();
      }
    }
  });

  test("an exact relation in either direction is not reasserted, even if disputed", async () => {
    for (const reverse of [false, true]) {
      const f = await fixture();
      try {
        const relation = await f.relation(reverse ? "C-2@1" : "C-1@1", reverse ? "C-1@1" : "C-2@1");
        expect((await f.read()).move).toBeNull();
        await f.event("relation.disputed", "relation", relation.id, 1, {
          reason: "Different conventions.",
        });
        expect((await f.read()).move).toBeNull();
      } finally {
        f.sql.close();
      }
    }
  });

  test("a relation between other exact versions does not hide a current duplicate", async () => {
    const f = await fixture();
    try {
      await f.relation("C-1@2", "C-2@1");
      expect((await f.read()).move?.refs).toEqual(["P-DEMO", "C-1@1", "C-2@1"]);
    } finally {
      f.sql.close();
    }
  });

  test("missing storage fails closed instead of invoking a fixture-only fallback", async () => {
    const f = await fixture();
    try {
      f.sql.exec("DROP TABLE events");
      expect(await f.read()).toEqual({ move: null, degraded: true });
      expect(f.queries).toHaveLength(1);
    } finally {
      f.sql.close();
    }
  });

  test("revision, controls and source-byte races fail closed between the two reads", async () => {
    for (const state of ["revised", "hidden", "redacted", "tampered"] as const) {
      const f = await fixture();
      try {
        f.beforePairRead(async () => {
          if (state === "revised") await f.claim("C-2", "One squared is odd.", 2);
          if (state === "hidden")
            f.sql.exec("INSERT INTO content_controls VALUES('P-DEMO','C-2@1',1,'hidden')");
          if (state === "redacted")
            f.sql.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='EV-2'");
          if (state === "tampered")
            f.sql.exec("UPDATE event_content SET payload_json='{}' WHERE event_id='EV-2'");
        });
        expect(await f.read()).toEqual({ move: null, degraded: true });
        expect(f.queries).toHaveLength(2);
      } finally {
        f.sql.close();
      }
    }
  });

  test("SQL bounds each body, aggregate bytes and publication rows before returning them", async () => {
    for (const boundary of ["single-body", "aggregate-and-heads"] as const) {
      const f = await fixture();
      try {
        if (boundary === "single-body") await f.claim("C-1", "x".repeat(40_000), 2);
        else
          for (let id = 3; id <= 70; id++)
            await f.claim(`C-${id}`, `${"x".repeat(20_000)} distinct claim ${id}`);
        expect((await f.read()).degraded).toBe(true);
        const sources = f.reads[0] as { claim_id: string; payload_json: string | null }[];
        const bodyBytes = sources.map((source) =>
          source.payload_json === null
            ? 0
            : new TextEncoder().encode(source.payload_json).byteLength,
        );
        expect(Math.max(...bodyBytes)).toBeLessThanOrEqual(32_768);
        expect(bodyBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(262_144);
        if (boundary === "single-body")
          expect(sources.find((source) => source.claim_id === "C-1")?.payload_json).toBeNull();
        else {
          expect(sources).toHaveLength(65);
          expect(sources.some((source) => source.payload_json === null)).toBe(true);
        }
      } finally {
        f.sql.close();
      }
    }
  });
});
