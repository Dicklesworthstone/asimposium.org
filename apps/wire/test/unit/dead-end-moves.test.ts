import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import {
  DEAD_END_MOVE_SOURCE_LIMIT,
  selectRecordDeadEndMove,
} from "../../src/mega-commands/dead-end-moves.ts";
import { sha256Hex } from "../../src/split/policy.ts";

/** SQL/history units. The production moves journey separately exercises real
 * Workerd publication, next/triage/working parity and the executable contract. */
async function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, status TEXT, public_seq INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, payload_sha256 TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT,
      payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, version INTEGER, visibility TEXT);
    INSERT INTO problems VALUES('P-DEMO','active',0);
  `);
  let sequence = 0;
  let reads = 0;
  let beforeRecheck: (() => void | Promise<void>) | undefined;
  const db = {
    prepare(query: string) {
      return {
        bind(...values: (string | number | null)[]) {
          return {
            all: async () => {
              if (++reads === 2) await beforeRecheck?.();
              return { success: true, results: sql.query(query).all(...values) };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  async function event(type: string, kind: string, id: string, body: unknown, version = 1) {
    const seq = ++sequence;
    const eventId = `EV-${seq}`;
    const raw = JSON.stringify(body);
    const digest = await sha256Hex(raw);
    sql
      .query("INSERT INTO events VALUES(?,'P-DEMO',?,?,?,?,?,?)")
      .run(eventId, seq, type, kind, id, version, digest);
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(eventId, digest, raw);
    sql.query("UPDATE problems SET public_seq=? WHERE id='P-DEMO'").run(seq);
    return eventId;
  }
  const claim = (id = "C-1", version = 1) =>
    event(
      version === 1 ? "claim.created" : "claim.revised",
      "claim",
      id,
      {
        claim_id: id,
        statement: `Exact statement ${id} version ${version}.`,
        ...(version > 1 ? { base_version: version - 1 } : {}),
      },
      version,
    );
  const evidence = (id: string, patch: Record<string, unknown> = {}) =>
    event("evidence.created", "evidence", id, {
      bears_on_kind: "claim",
      bears_on_id: "C-1",
      bears_on_version: 1,
      kind: "argument",
      direction: "supports",
      source: { kind: "model_memory" },
      mode: "exploratory",
      body_md: `Distinct supporting anecdote ${id}.`,
      computed_class: "assertion",
      coercion_flags: ["p8_model_memory_caps_at_assertion"],
      ...patch,
    });
  await claim();
  return {
    sql,
    event,
    claim,
    evidence,
    read: (cursor = sequence) => {
      reads = 0;
      return selectRecordDeadEndMove(db, "P-DEMO", cursor);
    },
    beforeRecheck: (callback: () => void | Promise<void>) => {
      beforeRecheck = callback;
    },
    plateau: async () => {
      for (const id of ["E-1", "E-2", "E-3"]) await evidence(id);
    },
  };
}

describe("grounded record-dead-end recommendations", () => {
  test("a claim alone or fewer than three supporting anecdotes is not an exhausted route", async () => {
    const f = await fixture();
    try {
      expect(await f.read()).toEqual({ move: null, degraded: false });
      await f.evidence("E-1");
      await f.evidence("E-2");
      expect(await f.read()).toEqual({ move: null, degraded: false });
    } finally {
      f.sql.close();
    }
  });

  test("three distinct assertions provide exact read links but no invented failure", async () => {
    const f = await fixture();
    try {
      await f.plateau();
      const selected = await f.read();
      expect(selected.degraded).toBe(false);
      expect(selected.move?.refs).toEqual(["P-DEMO", "C-1@1", "E-1", "E-2", "E-3"]);
      expect(selected.move?.contract.prefilled_hints).toEqual({});
      expect(selected.move?.contract.preparation).toMatchObject({
        captured_cursor: 4,
        read_first: { method: "GET", path: "/p/P-DEMO/claims/C-1%401.md?through=4" },
        additional_reads: [
          { method: "GET", path: "/p/P-DEMO/evidence/E-1.md" },
          { method: "GET", path: "/p/P-DEMO/evidence/E-2.md" },
          { method: "GET", path: "/p/P-DEMO/evidence/E-3.md" },
        ],
      });
      expect(selected.move?.why).toContain("does not establish a failure or refute the claim");
      expect(JSON.stringify(selected)).not.toContain("finite fields");
      expect(JSON.stringify(selected)).not.toContain("Distinct supporting anecdote");
      expect(await f.read()).toEqual(selected);
    } finally {
      f.sql.close();
    }
  });

  test("repeating identical or normalized-equivalent anecdotes cannot earn the trigger", async () => {
    const f = await fixture();
    try {
      for (const [index, body] of [
        "One observation.",
        "ONE  OBSERVATION.",
        "One observation.",
      ].entries())
        await f.evidence(`E-${index + 1}`, { body_md: body });
      expect(await f.read()).toEqual({ move: null, degraded: false });
    } finally {
      f.sql.close();
    }
  });

  test("duplicate immutable evidence identities cannot manufacture three reports", async () => {
    const f = await fixture();
    try {
      for (const body of ["First observation.", "Second observation.", "Third observation."])
        await f.evidence("E-1", { body_md: body });
      expect(await f.read()).toEqual({ move: null, degraded: true });
    } finally {
      f.sql.close();
    }
  });

  test.each(["citation", "computation", "refutes", "verification"])(
    "%s input supersedes the anecdote-only recommendation",
    async (kind) => {
      const f = await fixture();
      try {
        await f.plateau();
        if (kind === "verification")
          await f.event("review.created", "review", "R-1", {
            target_claim_id: "C-1",
            target_version: 1,
            verdict: "confirm",
            verification: {},
          });
        else if (kind === "refutes") await f.evidence("E-4", { direction: "refutes" });
        else
          await f.evidence("E-4", {
            kind: kind === "computation" ? "computation" : "argument",
            source: {
              kind: "locator",
              locator: "https://example.org/report",
              excerpt: "Reported observation.",
            },
            ...(kind === "computation"
              ? { computation_domain_or_floor: "Integers zero through ten." }
              : {}),
            computed_class: kind,
            coercion_flags: [],
          });
        expect(await f.read()).toEqual({ move: null, degraded: false });
      } finally {
        f.sql.close();
      }
    },
  );

  test("assertions on a superseded version do not describe the new claim", async () => {
    const f = await fixture();
    try {
      await f.plateau();
      await f.claim("C-1", 2);
      expect(await f.read()).toEqual({ move: null, degraded: false });
      expect((await f.read(4)).degraded).toBe(true);
      f.sql.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='EV-5'");
      expect((await f.read()).move).toBeNull();
    } finally {
      f.sql.close();
    }
  });

  test.each(["C-1", "C-1@1", "E-1"])("withdrawal of %s removes the trigger", async (target) => {
    const f = await fixture();
    try {
      await f.plateau();
      await f.event("object.retracted", "retraction", "R-1", { target_object: target });
      expect(await f.read()).toEqual({ move: null, degraded: false });
    } finally {
      f.sql.close();
    }
  });

  test.each(["problem", "C-1", "C-1@1", "#1", "E-1", "E-1@1", "#2"])(
    "current content control %s cannot contribute to a recommendation",
    async (target) => {
      const f = await fixture();
      try {
        await f.plateau();
        f.sql.query("INSERT INTO content_controls VALUES('P-DEMO',?,1,'hidden')").run(target);
        expect((await f.read()).move).toBeNull();
        f.sql.query("INSERT INTO content_controls VALUES('P-DEMO',?,2,'visible')").run(target);
        expect((await f.read()).move?.move).toBe("record-dead-end");
      } finally {
        f.sql.close();
      }
    },
  );

  test.each(["missing", "tampered", "redacted", "wrong-class"])(
    "%s source fails closed",
    async (kind) => {
      const f = await fixture();
      try {
        await f.plateau();
        if (kind === "missing") f.sql.exec("DELETE FROM event_content WHERE event_id='EV-2'");
        if (kind === "redacted")
          f.sql.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='EV-2'");
        if (kind === "tampered")
          f.sql.exec("UPDATE event_content SET payload_json='{}' WHERE event_id='EV-2'");
        if (kind === "wrong-class") await f.evidence("E-4", { computed_class: "computation" });
        expect(await f.read()).toEqual({ move: null, degraded: true });
      } finally {
        f.sql.close();
      }
    },
  );

  test("an incomplete source history cannot prove the absence of a better class", async () => {
    const f = await fixture();
    try {
      await f.plateau();
      for (let i = 4; i <= DEAD_END_MOVE_SOURCE_LIMIT; i++)
        await f.evidence(`E-${i}`, { body_md: `Recorded observation ${i}.` });
      expect(await f.read()).toEqual({ move: null, degraded: true });
    } finally {
      f.sql.close();
    }
  });

  test.each(["cursor", "control", "body"])(
    "%s change during hashing prevents mixed-source advice",
    async (kind) => {
      const f = await fixture();
      try {
        await f.plateau();
        f.beforeRecheck(() => {
          if (kind === "cursor") f.sql.exec("UPDATE problems SET public_seq=5");
          if (kind === "control")
            f.sql.exec("INSERT INTO content_controls VALUES('P-DEMO','E-1',1,'hidden')");
          if (kind === "body")
            f.sql.exec("UPDATE event_content SET payload_json='{}' WHERE event_id='EV-2'");
        });
        expect(await f.read()).toEqual({ move: null, degraded: true });
      } finally {
        f.sql.close();
      }
    },
  );
});
