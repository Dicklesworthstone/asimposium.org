import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { FullPackPageSchema, FullPackQuerySchema, PackResponseSchema } from "@asimposium/contracts";
import { composedPackToProjection, renderProjection } from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import { type FullPackInput, readFullPack } from "../../src/sessions/full-pack.ts";

const AT = "2026-10-27T00:00:00.000Z";
const PRIVATE = "PRIVATE-WORKSHOP-CREDENTIAL-HANDBACK-CANARY";
const input: FullPackInput = {
  session: `S-${"0".repeat(26)}`,
  problem: "P-DEMO",
  after: 0,
  through: 0,
  requestedMaxTokens: 8000,
  membership: "contributor",
};
const claim = (id: string, statement: string) => ({
  claim_id: id,
  kind: "conjecture",
  statement,
  falsifier: "An integer violating the stated relation.",
  dependency_pins: [],
  workshop_id: PRIVATE,
  private_payload: PRIVATE,
});
const hypothesis = {
  route: "Compare parity classes",
  mechanism: "Examine the two residues modulo two.",
  falsifier: "A residue class violating the proposed relation.",
  origin: "proposed",
  body_md: "Public hypothesis body",
  discriminating_predictions: ["Both residues have equal parity."],
  expected_evidence: null,
};
const evidence = (body = "Public evidence body") => ({
  bears_on_kind: "claim",
  bears_on_id: "C-1",
  bears_on_version: 1,
  direction: "informs",
  kind: "argument",
  mode: "exploratory",
  source: { kind: "model_memory" },
  body_md: body,
  reproduction: null,
});
const review = (body = "Public review body") => ({
  target_claim_id: "C-1",
  target_version: 1,
  verdict: "inform",
  basis: "Checked parity classes.",
  body_md: body,
  rubric: [],
  capable_of_failure: null,
  scientific_provenance: null,
  verification: null,
});

// Executes the production selectors against actual SQLite. This is a local
// unit fixture, not a Workerd/D1 or R2 claim.
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems (id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, created_at TEXT,
      payload_sha256 TEXT, actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT,
      model_string_self_declared TEXT, harness TEXT, writer_credential_id TEXT);
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls (problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE workshop_objects (body_md TEXT);
    CREATE TABLE sessions (handback TEXT);
    INSERT INTO problems VALUES ('P-DEMO',0,'active',0);
  `);
  sql.prepare("INSERT INTO workshop_objects VALUES (?)").run(PRIVATE);
  sql.prepare("INSERT INTO sessions VALUES (?)").run(PRIVATE);
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      queries.push(query);
      return {
        bind(...values: (string | number | null)[]) {
          return { all: async <T>() => ({ results: sql.prepare(query).all(...values) as T[] }) };
        },
      };
    },
  } as unknown as D1Database;
  let cursor = 0;
  async function append(type: string, kind: string, id: string, payload: object, version = 1) {
    const seq = ++cursor;
    const bytes = JSON.stringify(payload);
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    sql
      .prepare(`INSERT INTO events VALUES (?, 'P-DEMO', ?, ?, ?, ?, ?, ?, ?,
      'F-AUTHOR','usr_author','SESSION-AUTHOR','declared-model','declared-harness',?)`)
      .run(`EVENT-${seq}`, seq, type, kind, id, version, AT, hash, PRIVATE);
    sql.prepare("INSERT INTO event_content VALUES (?,?,?,NULL)").run(`EVENT-${seq}`, hash, bytes);
    sql.prepare("UPDATE problems SET public_seq=? WHERE id='P-DEMO'").run(cursor);
    return seq;
  }
  async function read(options: Partial<FullPackInput> = {}) {
    const pack = await readFullPack(db, { ...input, through: cursor, ...options });
    const body = renderProjection(composedPackToProjection(pack), "json").body;
    const face = PackResponseSchema.parse(JSON.parse(body));
    const pageItem = face.items.find((item) => item.kind === "full-page");
    if (pageItem === undefined) throw new Error("full pack omitted its continuation control");
    const control = FullPackPageSchema.parse(JSON.parse(pageItem.body));
    const records = face.items
      .filter((item) => item.kind === "full-event")
      .map((item) => JSON.parse(item.body));
    return { body, face, control, records };
  }
  function control(target: string, visibility: "hidden" | "visible") {
    sql
      .prepare(`INSERT INTO content_controls SELECT 'P-DEMO',?,?,
      COALESCE(MAX(version),0)+1 FROM content_controls WHERE problem_id='P-DEMO' AND target_ref=?`)
      .run(target, visibility, target);
  }
  return { sql, db, append, read, control, queries };
}

describe("full public ledger packs", () => {
  test("hydrates committed claim, hypothesis, evidence and review bodies without private bookkeeping", async () => {
    const f = fixture();
    try {
      await f.append("claim.created", "claim", "C-1", claim("C-1", "Public original claim"));
      await f.append("hypothesis.created", "hypothesis", "H-1", hypothesis);
      await f.append("evidence.created", "evidence", "E-PUBLIC", evidence());
      await f.append("review.created", "review", "R-PUBLIC", review());
      await f.append(
        "claim.revised",
        "claim",
        "C-1",
        {
          ...claim("C-1", "Public revised claim"),
          base_version: 1,
          depends_on: [],
        },
        2,
      );
      const result = await f.read();
      expect(result.records.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(result.records.map((record) => record.content_omitted)).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
      expect(result.records[0].content.statement).toBe("Public original claim");
      expect(result.records[4].content.statement).toBe("Public revised claim");
      expect(result.records[1].content.body_md).toBe(hypothesis.body_md);
      expect(result.records[2].content.body_md).toBe("Public evidence body");
      expect(result.records[3].content.body_md).toBe("Public review body");
      expect(result.body).not.toContain(PRIVATE);
      expect(
        f.queries.every(
          (query) => !/\b(workshop_objects|sessions|sponsor_directives)\b/.test(query),
        ),
      ).toBe(true);
      expect(result.control).toMatchObject({
        after: 0,
        through: 5,
        has_more: false,
        next_after: null,
        records: 5,
      });
      expect(result.face.omitted).not.toContainEqual({
        reason: "profile_section_not_composed",
        detail: "paginated-export",
      });
    } finally {
      f.sql.close();
    }
  });

  test.each([800, 1500, 2500, 4000, 8000])(
    "budget %i traverses every sequence once, including oversized and private records",
    async (budget) => {
      const f = fixture();
      try {
        await f.append(
          "evidence.created",
          "evidence",
          "E-BIG",
          evidence("Large public body. ".repeat(2000)),
        );
        await f.append(
          "claim.created",
          "claim",
          "C-1",
          claim("C-1", "A moderate claim. ".repeat(90)),
        );
        await f.append("workshop.updated", "workshop", PRIVATE, { body_md: PRIVATE });
        await f.append("question.asked", "question", "Q-1", {
          body_md: "Unsupported typed question body",
        });
        await f.append("review.created", "review", "R-1", review());
        const sequences: number[] = [];
        let after = 0;
        for (let page = 0; page < 6; page++) {
          const result = await f.read({ after, through: 5, requestedMaxTokens: budget });
          if (after === 0 && (budget === 800 || budget === 1500))
            expect(
              (await f.read({ after, through: 5, requestedMaxTokens: budget === 800 ? 799 : 801 }))
                .body,
            ).toBe(result.body);
          expect(result.face.tokens_estimate).toBeLessThanOrEqual(budget);
          expect(result.records.length).toBeGreaterThan(0);
          expect(result.records[0].seq).toBe(after + 1);
          expect(result.body).not.toContain(PRIVATE);
          expect(result.body).not.toContain("Unsupported typed question body");
          for (const record of result.records) {
            sequences.push(record.seq);
            if (record.seq === 1) {
              expect(record.content).toBe(null);
              expect(record.content_omitted).toBe("item_size_limit");
              expect(record.content_url).toBe(null);
            }
            if (record.seq === 3) expect(record.content_omitted).toBe("undisclosed_event");
            if (record.seq === 4) expect(record.content_omitted).toBe("unsupported_record");
          }
          if (!result.control.has_more) break;
          expect(result.control.next_after).toBe(result.records.at(-1).seq);
          const continuation = result.face.next_actions.find((action) =>
            action.url.includes("profile=full"),
          );
          expect(continuation?.url).toContain(`through=5&after=${result.control.next_after}`);
          if (result.control.next_after === null) throw new Error("full pack omitted its next cursor");
          after = result.control.next_after;
        }
        expect(sequences).toEqual([1, 2, 3, 4, 5]);
      } finally {
        f.sql.close();
      }
    },
  );

  test("frozen pages replay after new publications while exact-version and event controls change their bytes", async () => {
    const f = fixture();
    try {
      await f.append("claim.created", "claim", "C-1", claim("C-1", "Original historical content"));
      await f.append("evidence.created", "evidence", "E-1", evidence());
      const original = await f.read({ through: 2 });
      await f.append(
        "claim.revised",
        "claim",
        "C-1",
        {
          ...claim("C-1", "Later replacement content"),
          base_version: 1,
        },
        2,
      );
      expect((await f.read({ through: 2 })).body).toBe(original.body);
      for (const target of ["C-1@1", "#1", "E-1@1", "#2"]) {
        f.control(target, "hidden");
        const hidden = await f.read({ through: 2 });
        const index = target === "C-1@1" || target === "#1" ? 0 : 1;
        expect(hidden.body).not.toBe(original.body);
        expect(hidden.records[index].content).toBe(null);
        expect(hidden.records[index].content_omitted).toBe("content_unavailable");
        f.control(target, "visible");
        expect((await f.read({ through: 2 })).body).toBe(original.body);
      }
      f.sql.prepare("UPDATE event_content SET redacted_at=? WHERE event_id='EVENT-1'").run(AT);
      f.control("C-1@1", "visible");
      expect((await f.read({ through: 2 })).records[0].content).toBe(null);
    } finally {
      f.sql.close();
    }
  });

  test("committed dependency pins survive without fabricating empty request-default relationships", async () => {
    const f = fixture();
    try {
      const pins = [
        {
          claim_id: "C-1",
          version: 1,
          event_id: "EVENT-PREMISE",
          content_digest: `sha256:${"a".repeat(64)}`,
          payload_digest: "b".repeat(64),
        },
      ];
      await f.append("claim.created", "claim", "C-2", {
        ...claim("C-2", "The dependent claim uses the pinned premise."),
        dependency_pins: pins,
      });
      const result = await f.read();
      expect(result.records[0].content.dependency_pins).toEqual(pins);
      expect(result.records[0].content).not.toHaveProperty("depends_on");
      expect(result.records[0].content).not.toHaveProperty("relates_to");
    } finally {
      f.sql.close();
    }
  });

  test("citation versions retain anchors and corrections, and dead ends retain their failure and retry condition", async () => {
    const f = fixture();
    try {
      const citation = {
        citation_id: "L-1",
        title: "A source for the parity argument",
        authors: ["Example Author"],
        year: 2020,
        locator_kind: "url",
        locator: "https://example.org/parity#lemma-2",
        excerpt: "A bounded public excerpt.",
        retrieved_at: AT,
        source_provenance: "retrieved",
        private_note: PRIVATE,
      };
      await f.append("citation.recorded", "citation", "L-1", citation);
      await f.append(
        "citation.corrected",
        "citation",
        "L-1",
        {
          ...citation,
          base_version: 1,
          title: "Corrected source title",
          correction_rationale: "The original title omitted its subtitle.",
        },
        2,
      );
      await f.append("dead_end.recorded", "dead_end", "DE-1", {
        approach: "Enumerated both residue classes directly.",
        why_it_fails: "This route does not extend to the proposed larger modulus.",
        retry_predicate: "Retry after the problem statement changes.",
        retry_when: { kind: "statement-revised" },
        what_was_examined: "The two residues modulo two.",
      });
      const result = await f.read();
      expect(result.records.map((record) => record.content_omitted)).toEqual([null, null, null]);
      expect(result.records[0].content.locator).toBe(citation.locator);
      expect(result.records[1].content.correction_rationale).toBe(
        "The original title omitted its subtitle.",
      );
      expect(result.records[1].content_url).toBe("/p/P-DEMO/citations/L-1@2.json?through=3");
      expect(result.records[2].content.retry_when).toEqual({ kind: "statement-revised" });
      expect(result.body).not.toContain(PRIVATE);
    } finally {
      f.sql.close();
    }
  });

  test("digest corruption, invalid nested fields and oversized source bytes remain explicit unavailable records", async () => {
    const f = fixture();
    try {
      await f.append("claim.created", "claim", "C-1", claim("C-1", "Original commitment"));
      f.sql
        .prepare("UPDATE event_content SET payload_json=? WHERE event_id='EVENT-1'")
        .run(JSON.stringify(claim("C-1", "CORRUPTED-CONTENT-CANARY")));
      await f.append("evidence.created", "evidence", "E-2", {
        ...evidence(),
        source: { kind: "model_memory", private_credential: PRIVATE },
      });
      await f.append("review.created", "review", "R-3", review("Δ".repeat(40_000)));
      const result = await f.read();
      expect(result.records.map((record) => record.content_omitted)).toEqual([
        "content_unavailable",
        "content_unavailable",
        "source_byte_limit",
      ]);
      expect(result.body).not.toContain("CORRUPTED-CONTENT-CANARY");
      expect(result.body).not.toContain(PRIVATE);
      expect(result.records.map((record) => record.seq)).toEqual([1, 2, 3]);
    } finally {
      f.sql.close();
    }
  });

  test("an empty cut is complete, but a missing public sequence cannot mint a successful continuation", async () => {
    const f = fixture();
    try {
      expect((await f.read()).control).toMatchObject({
        records: 0,
        next_after: null,
        has_more: false,
      });
      await f.append("claim.created", "claim", "C-1", claim("C-1", "First public claim"));
      await f.append("review.created", "review", "R-2", review());
      f.sql.prepare("DELETE FROM events WHERE seq=1").run();
      await expect(f.read()).rejects.toThrow("EVENT_TAIL_UNAVAILABLE");
    } finally {
      f.sql.close();
    }
  });

  test("continuation contracts reject unpinned, backwards and unsafe cursors", () => {
    expect(FullPackQuerySchema.safeParse({ profile: "full" }).success).toBe(true);
    expect(FullPackQuerySchema.safeParse({ profile: "full", after: 2, through: 9 }).success).toBe(
      true,
    );
    for (const value of [
      { profile: "full", after: 1 },
      { profile: "full", after: 3, through: 2 },
      { profile: "working", after: 0, through: 2 },
      { profile: "full", through: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(FullPackQuerySchema.safeParse(value).success).toBe(false);
    expect(
      FullPackPageSchema.safeParse({
        control: "full_pack_page",
        after: 1,
        through: 3,
        next_after: 3,
        has_more: false,
        records: 1,
      }).success,
    ).toBe(false);
    expect(
      FullPackPageSchema.safeParse({
        control: "full_pack_page",
        after: 1,
        through: 3,
        next_after: 1,
        has_more: true,
        records: 0,
      }).success,
    ).toBe(false);
  });
});
