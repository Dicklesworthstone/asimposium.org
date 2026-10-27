import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { EventTailResponseSchema } from "@asimposium/contracts/event-tail";
import {
  EVENT_TAIL_MAX_BYTES,
  parseEventTailQuery,
  renderEventTail,
} from "../../../../packages/contracts/src/event-tail-model.ts";
import {
  parseEventTailToon,
  renderEventTailMarkdown,
  renderEventTailSse,
  renderEventTailToon,
} from "../../src/ledger/event-tail-http.ts";
import {
  type EventTailDatabase,
  EventTailReadError,
  readPublicEventTail,
} from "../../src/ledger/event-tail-read.ts";

function fixture(count = 0) {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems (id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, created_at TEXT,
      payload_sha256 TEXT, actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT,
      model_string_self_declared TEXT, harness TEXT, writer_credential_id TEXT,
      UNIQUE(problem_id, seq));
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls (problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE workshop_objects (body TEXT);
    INSERT INTO problems VALUES ('P-DEMO', 0, 'open', 0);
    INSERT INTO workshop_objects VALUES ('PRIVATE-WORKSHOP-CANARY');`);
  const digest = "a".repeat(64);
  const queries: string[] = [];
  const db: EventTailDatabase = {
    prepare(query: string) {
      queries.push(query);
      return {
        bind(...values: (string | number | null)[]) {
          return { all: async <T>() => ({ results: sql.prepare(query).all(...values) as T[] }) };
        },
      };
    },
  };
  const append = (seq: number, kind = "claim", type = "claim.created", problem = "P-DEMO") => {
    const id = `${problem}-event-${seq}`;
    sql
      .prepare(
        "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'F-1', 'S-1', 'SES-1', 'model', 'harness', 'PRIVATE-CREDENTIAL-CANARY')",
      )
      .run(id, problem, seq, type, kind, `C-${seq}`, "2026-09-15T00:00:00.000Z", digest);
    sql
      .prepare("INSERT INTO event_content VALUES (?, ?, ?, NULL)")
      .run(id, digest, '{"secret":"PRIVATE-CONTENT-CANARY"}');
    sql.prepare("UPDATE problems SET public_seq=? WHERE id=?").run(seq, problem);
  };
  for (let i = 1; i <= count; i++) append(i);
  return { sql, db, append, queries };
}

async function expectCode(
  run: () => Promise<unknown>,
  code: "CURSOR_INVALID" | "EVENT_TAIL_UNAVAILABLE",
) {
  try {
    await run();
    throw new Error("expected refusal");
  } catch (error) {
    expect(error instanceof EventTailReadError).toBe(true);
    expect((error as EventTailReadError).code).toBe(code);
  }
}

describe("W6.4 actual SQLite public event tail", () => {
  for (const count of [0, 1, 49, 50, 51, 199, 200, 201]) {
    test(`exact ${count}-event boundary with honest lookahead`, async () => {
      const f = fixture(count);
      try {
        const result = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 50 });
        if (!result) throw new Error("missing public problem");
        expect(result.page.events.length).toBe(Math.min(50, count));
        expect(result.page.page_end.next_cursor).toBe(Math.min(50, count));
        expect(result.page.page_end.has_more).toBe(count > 50);
        expect(result.page.page_end.through).toBe(count);
        expect(f.queries.length).toBe(1);
        expect(f.queries[0]).toContain("json_extract(c.payload_json, '$.caused_by')");
        expect(f.queries[0]).not.toMatch(/\bSELECT\s+(?:c\.)?payload_json/i);
        expect(JSON.stringify(result)).not.toContain("PRIVATE-CONTENT-CANARY");
        expect(f.queries[0]).not.toContain("writer_credential_id");
      } finally {
        f.sql.close();
      }
    });
  }
  test("empty public problem has a terminal page, missing and private do not", async () => {
    const f = fixture();
    try {
      expect(await readPublicEventTail(f.db, "P-MISSING", { since: 0, limit: 10 })).toBeNull();
      f.sql.exec("UPDATE problems SET status='private-draft'");
      expect(await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10 })).toBeNull();
    } finally {
      f.sql.close();
    }
  });
  test("unlisted direct reads retain noindex authority", async () => {
    const f = fixture(1);
    try {
      f.sql.exec("UPDATE problems SET unlisted=1");
      const result = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10 });
      expect(result?.unlisted).toBe(true);
    } finally {
      f.sql.close();
    }
  });
  test("concurrent appends do not shift a pinned traversal; polling discovers them", async () => {
    const f = fixture(5);
    try {
      const first = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 2 });
      if (!first?.page.page_end.next) throw new Error("missing continuation");
      const seen = first.page.events.map((event) => event.seq);
      f.append(6);
      f.append(7);
      let next: string | null = first.page.page_end.next;
      let poll = first.page.page_end.poll;
      while (next !== null) {
        const query = parseEventTailQuery(new URL(next, "https://a.asimposium.org").searchParams);
        if (!query) throw new Error("invalid server continuation");
        const result = await readPublicEventTail(f.db, "P-DEMO", query);
        if (!result) throw new Error("lost public problem");
        expect(result.page.page_end.through).toBe(5);
        seen.push(...result.page.events.map((event) => event.seq));
        next = result.page.page_end.next;
        poll = result.page.page_end.poll;
      }
      expect(seen).toEqual([1, 2, 3, 4, 5]);
      const query = parseEventTailQuery(new URL(poll, "https://a.asimposium.org").searchParams);
      if (!query) throw new Error("invalid poll link");
      const fresh = await readPublicEventTail(f.db, "P-DEMO", query);
      expect(fresh?.page.events.map((event) => event.seq)).toEqual([6, 7]);
    } finally {
      f.sql.close();
    }
  });
  test("unknown/private producers retain sequences, not identifiers or actor fields", async () => {
    const f = fixture(1);
    try {
      f.append(2, "workshop", "workshop.changed");
      f.append(3, "commentary", "commentary.posted");
      f.append(4, "claim", "claim.internal-secret");
      const result = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10 });
      if (!result) throw new Error("missing problem");
      expect(result.page.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
      for (const entry of result.page.events.slice(1)) {
        expect(entry.event).toBeNull();
        expect(entry.body_omitted).toBe("undisclosed_event");
      }
      const body = renderEventTail(result.page, "ndjson");
      for (const secret of ["PRIVATE-", "workshop.changed", "commentary.posted", "internal-secret"])
        expect(body).not.toContain(secret);
      expect(result.page.page_end.next_cursor).toBe(4);
    } finally {
      f.sql.close();
    }
  });
  test("the mounted dead-end producer spelling is a public event without exposing its raw payload", async () => {
    const f = fixture();
    try {
      f.append(1, "dead_end", "dead_end.recorded");
      f.sql.prepare("UPDATE events SET object_id='DE-1' WHERE seq=1").run();
      const result = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 1 });
      const page = EventTailResponseSchema.parse(result?.page);
      expect(page.events[0]?.event).toMatchObject({
        type: "dead_end.recorded",
        object_kind: "dead_end",
        object_id: "DE-1",
      });
      expect(page.events[0]?.body_omitted).toBe("separate_object_face");
      for (const body of [
        renderEventTail(page, "json"),
        renderEventTail(page, "ndjson"),
        renderEventTailMarkdown(page),
        renderEventTailToon(page),
      ]) {
        expect(body).toContain("dead_end.recorded");
        expect(body).not.toContain("PRIVATE-");
      }
      expect(parseEventTailToon(renderEventTailToon(page)).events[0]).toMatchObject({
        type: "dead_end.recorded",
        object_id: "DE-1",
      });
    } finally {
      f.sql.close();
    }
  });
  test("real relation composite IDs remain public across every event face with bounded object IDs", async () => {
    const f = fixture();
    const prefix = "C-1@1-implies-C-";
    const ids = ["C-1@1-implies-C-2@3", `${prefix}${"2".repeat(256 - prefix.length - 2)}@3`];
    try {
      for (const [index, id] of ids.entries()) {
        f.append(index + 1, "relation", index === 0 ? "relation.asserted" : "relation.disputed");
        f.sql.prepare("UPDATE events SET object_id=? WHERE seq=?").run(id, index + 1);
      }
      const result = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10 });
      const page = EventTailResponseSchema.parse(result?.page);
      expect(page.events.map((entry) => entry.event?.object_id)).toEqual(ids);
      expect(page.events.map((entry) => entry.body_omitted)).toEqual([
        "separate_object_face",
        "separate_object_face",
      ]);
      for (const body of [
        renderEventTail(page, "json"),
        renderEventTail(page, "ndjson"),
        renderEventTailMarkdown(page),
        renderEventTailSse(page),
        renderEventTailToon(page),
      ]) {
        for (const id of ids) expect(body).toContain(id);
        expect(body).not.toContain("PRIVATE-");
      }
      expect(
        parseEventTailToon(renderEventTailToon(page)).events.map((row) => row.object_id),
      ).toEqual(ids);
    } finally {
      f.sql.close();
    }
  });
  test("composite object grammar rejects markup, control characters and oversized IDs before disclosure", async () => {
    const f = fixture();
    const ids = [
      "C-1@1-implies-C-2@3\n",
      "C-1@1-implies-C-2@3\u0000",
      "C-1@1/implies/C-2@3",
      "<relation>",
      `C-${"2".repeat(255)}`,
    ];
    try {
      for (const [index, id] of ids.entries()) {
        f.append(index + 1, "relation", "relation.asserted");
        f.sql.prepare("UPDATE events SET object_id=? WHERE seq=?").run(id, index + 1);
      }
      const result = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10 });
      expect(result?.page.events.map((entry) => entry.event)).toEqual(ids.map(() => null));
      expect(result?.page.events.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(JSON.stringify(result)).not.toContain("PRIVATE-");
    } finally {
      f.sql.close();
    }
  });
  test("redaction retains only the immutable public envelope and changes output", async () => {
    const f = fixture(1);
    try {
      const before = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10 });
      f.sql.exec("UPDATE event_content SET redacted_at='2026-09-15T01:00:00.000Z'");
      const after = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10, through: 1 });
      expect(before?.page.events[0]?.body_omitted).toBe("separate_object_face");
      expect(after?.page.events[0]?.body_omitted).toBe("content_unavailable");
      expect(after?.page.events[0]?.event?.object_url).toBe(
        "/p/P-DEMO/claims/C-1@1.json?through=1",
      );
      expect(JSON.stringify(after)).not.toContain("PRIVATE-");
    } finally {
      f.sql.close();
    }
  });
  test("missing or digest-detached content never appears available", async () => {
    const f = fixture(2);
    try {
      f.sql.exec(
        "DELETE FROM event_content WHERE event_id='P-DEMO-event-1'; UPDATE event_content SET payload_sha256='mismatch'",
      );
      const result = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10 });
      expect(result?.page.events.map((event) => event.body_omitted)).toEqual([
        "content_unavailable",
        "content_unavailable",
      ]);
    } finally {
      f.sql.close();
    }
  });
  for (const [kind, type] of [
    ["claim", "claim.created"],
    ["hypothesis", "hypothesis.created"],
    ["evidence", "evidence.created"],
    ["review", "review.created"],
    ["citation", "citation.recorded"],
    ["gap", "gap.filed"],
    ["question", "question.asked"],
    ["conflict", "conflict.normalized"],
    ["dead-end", "dead_end.recorded"],
    ["synthesis", "synthesis.created"],
  ] as const) {
    for (const target of ["C-1", "C-1@1", "#1"]) {
      test(`${kind} ${target}: historical tails obey current controls and restore exactly`, async () => {
        const f = fixture();
        try {
          f.append(1, kind, type);
          const query = { since: 0, through: 1, limit: 1 };
          const before = await readPublicEventTail(f.db, "P-DEMO", query);
          expect(before?.page.events[0]?.body_omitted).toBe("separate_object_face");
          f.sql
            .prepare("INSERT INTO content_controls VALUES ('P-DEMO', ?, 'hidden', 1)")
            .run(target);
          const hidden = await readPublicEventTail(f.db, "P-DEMO", query);
          expect(hidden?.page.events[0]?.body_omitted).toBe("content_unavailable");
          expect(hidden?.page.events[0]?.event?.causality_omitted).toBe("unavailable");
          expect(hidden?.page.events[0]?.event?.id).toBe("P-DEMO-event-1");
          expect(hidden?.page.page_end.next_cursor).toBe(1);
          expect(EventTailResponseSchema.safeParse(hidden?.page).success).toBe(true);
          f.sql
            .prepare("INSERT INTO content_controls VALUES ('P-DEMO', ?, 'visible', 2)")
            .run(target);
          expect(await readPublicEventTail(f.db, "P-DEMO", query)).toEqual(before);
        } finally {
          f.sql.close();
        }
      });
    }
  }
  test("an unrelated version or problem cannot hide a tail publication", async () => {
    const f = fixture(1);
    try {
      const query = { since: 0, through: 1, limit: 1 };
      const before = await readPublicEventTail(f.db, "P-DEMO", query);
      f.sql.exec(`INSERT INTO content_controls VALUES ('P-DEMO', 'C-1@2', 'hidden', 1);
        INSERT INTO content_controls VALUES ('P-DEMO', '#2', 'hidden', 1);
        INSERT INTO content_controls VALUES ('P-OTHER', 'C-1@1', 'hidden', 1);
        INSERT INTO content_controls VALUES ('P-OTHER', '#1', 'hidden', 1);`);
      expect(await readPublicEventTail(f.db, "P-DEMO", query)).toEqual(before);
    } finally {
      f.sql.close();
    }
  });
  test("batch ancestry retains exact earlier parents across pagination and every event face", async () => {
    const f = fixture(3);
    try {
      const parents = [1, 2].map((seq) => ({
        scope: "problem" as const,
        scope_id: "P-DEMO",
        event_id: `P-DEMO-event-${seq}`,
        seq,
      }));
      f.sql
        .prepare("UPDATE event_content SET payload_json=? WHERE event_id=?")
        .run('{"caused_by":[],"body":"PRIVATE-ROOT"}', "P-DEMO-event-1");
      f.sql
        .prepare("UPDATE event_content SET payload_json=? WHERE event_id=?")
        .run(JSON.stringify({ caused_by: parents, body: "PRIVATE-EVIDENCE" }), "P-DEMO-event-3");
      const result = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 3 });
      if (!result) throw new Error("missing public problem");
      const page = EventTailResponseSchema.parse(result.page);
      expect(page.events[0]?.event).toMatchObject({ caused_by: [], causality_omitted: null });
      expect(page.events[1]?.event).toMatchObject({
        caused_by: null,
        causality_omitted: "not_recorded",
      });
      expect(page.events[2]?.event).toMatchObject({ caused_by: parents, causality_omitted: null });
      const resumed = await readPublicEventTail(f.db, "P-DEMO", { since: 2, through: 3, limit: 1 });
      expect(resumed?.page.events[0]?.event?.caused_by).toEqual(parents);
      expect(JSON.parse(renderEventTail(page, "json")).events[2].event.caused_by).toEqual(parents);
      expect(JSON.parse(renderEventTail(page, "ndjson").split("\n")[2]!).event.caused_by).toEqual(
        parents,
      );
      expect(parseEventTailToon(renderEventTailToon(page)).events[2]?.caused_by).toEqual(parents);
      const markdown = renderEventTailMarkdown(page);
      expect(markdown).toContain("explicitly recorded as empty for this batch root");
      expect(markdown).toContain("not recorded; no empty parent set is asserted");
      expect(markdown).toContain("P-DEMO-event-1 at P-DEMO#1, P-DEMO-event-2 at P-DEMO#2");
      for (const face of [
        renderEventTail(page, "json"),
        renderEventTail(page, "ndjson"),
        renderEventTailToon(page),
        markdown,
        renderEventTailSse(page),
      ]) {
        expect(face).not.toContain("PRIVATE-");
      }
    } finally {
      f.sql.close();
    }
  });
  test("malformed, cross-scope, duplicate, future and invented parents are unavailable, never empty", async () => {
    const f = fixture(3);
    try {
      const first = { scope: "problem", scope_id: "P-DEMO", event_id: "P-DEMO-event-1", seq: 1 };
      const second = { ...first, event_id: "P-DEMO-event-2", seq: 2 };
      const invalid = [
        null,
        "PRIVATE-NOT-AN-ARRAY",
        [{}],
        [{ ...first, scope: "workshop" }],
        [{ ...first, scope_id: "P-PRIVATE" }],
        [{ ...first, event_id: "PRIVATE-EVENT" }],
        [{ ...first, seq: 2 }],
        [{ ...first, seq: 4 }],
        [{ ...first, event_id: "P-DEMO-event-3", seq: 3 }],
        [first, first],
        [second, first],
        [{ ...first, body: "PRIVATE-PARENT-BODY" }],
        Array.from({ length: 16 }, () => first),
      ];
      for (const caused_by of invalid) {
        f.sql
          .prepare("UPDATE event_content SET payload_json=? WHERE event_id='P-DEMO-event-3'")
          .run(JSON.stringify({ caused_by }));
        const result = await readPublicEventTail(f.db, "P-DEMO", { since: 2, limit: 1 });
        expect(result?.page.events[0]?.event).toMatchObject({
          caused_by: null,
          causality_omitted: "unavailable",
        });
        expect(JSON.stringify(result)).not.toContain("PRIVATE-");
      }
      f.sql.exec("UPDATE event_content SET payload_json='{' WHERE event_id='P-DEMO-event-3'");
      const malformed = await readPublicEventTail(f.db, "P-DEMO", { since: 2, limit: 1 });
      expect(malformed?.page.events[0]?.event?.causality_omitted).toBe("unavailable");
    } finally {
      f.sql.close();
    }
  });
  test.each([
    "UPDATE event_content SET redacted_at='2026-09-15T01:00:00.000Z' WHERE event_id='P-DEMO-event-2'",
    "UPDATE event_content SET payload_sha256='mismatch' WHERE event_id='P-DEMO-event-2'",
    "DELETE FROM event_content WHERE event_id='P-DEMO-event-2'",
    "UPDATE event_content SET redacted_at='2026-09-15T01:00:00.000Z' WHERE event_id='P-DEMO-event-1'",
    "UPDATE event_content SET payload_sha256='mismatch' WHERE event_id='P-DEMO-event-1'",
    "UPDATE events SET object_kind='workshop', type='workshop.changed' WHERE seq=1",
    "INSERT INTO content_controls VALUES ('P-DEMO', 'C-1', 'hidden', 1)",
    "INSERT INTO content_controls VALUES ('P-DEMO', 'C-1@1', 'hidden', 1)",
    "INSERT INTO content_controls VALUES ('P-DEMO', '#1', 'hidden', 1)",
    "INSERT INTO content_controls VALUES ('P-DEMO', 'C-2@1', 'hidden', 1)",
    "INSERT INTO content_controls VALUES ('P-DEMO', '#2', 'hidden', 1)",
    "UPDATE events SET object_kind='evidence', type='evidence.created' WHERE seq=1; INSERT INTO content_controls VALUES ('P-DEMO', 'C-1', 'hidden', 1)",
  ])("withdrawn or undisclosed content cannot leak a causal parent (%s)", async (mutation) => {
    const f = fixture(2);
    try {
      f.sql.prepare("UPDATE event_content SET payload_json=? WHERE event_id='P-DEMO-event-2'").run(
        JSON.stringify({
          caused_by: [{ scope: "problem", scope_id: "P-DEMO", event_id: "P-DEMO-event-1", seq: 1 }],
        }),
      );
      expect(
        (await readPublicEventTail(f.db, "P-DEMO", { since: 1, limit: 1 }))?.page.events[0]?.event
          ?.caused_by,
      ).toHaveLength(1);
      f.sql.exec(mutation);
      const result = await readPublicEventTail(f.db, "P-DEMO", { since: 1, through: 2, limit: 1 });
      expect(result?.page.events[0]?.event).toMatchObject({
        caused_by: null,
        causality_omitted: "unavailable",
      });
      expect(JSON.stringify(result)).not.toContain("P-DEMO-event-1");
    } finally {
      f.sql.close();
    }
  });
  test("fifteen-parent events paginate by whole records within the byte cap without losing ancestry", async () => {
    const f = fixture(200);
    try {
      const parents = Array.from({ length: 15 }, (_, index) => {
        const seq = index + 1;
        const event_id = `E-${seq}-${"x".repeat(128)}`.slice(0, 128);
        f.sql.prepare("UPDATE events SET id=? WHERE seq=?").run(event_id, seq);
        f.sql
          .prepare("UPDATE event_content SET event_id=? WHERE event_id=?")
          .run(event_id, `P-DEMO-event-${seq}`);
        return { scope: "problem" as const, scope_id: "P-DEMO", event_id, seq };
      });
      const payload = JSON.stringify({ caused_by: parents, body: "PRIVATE-LONG-CAUSAL-BODY" });
      for (let seq = 16; seq <= 200; seq++)
        f.sql
          .prepare("UPDATE event_content SET payload_json=? WHERE event_id=?")
          .run(payload, `P-DEMO-event-${seq}`);
      const first = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 200 });
      if (!first?.page.page_end.next) throw new Error("expected byte-bounded continuation");
      expect(first.page.events.length).toBeGreaterThan(15);
      expect(first.page.events.length).toBeLessThan(200);
      expect(new TextEncoder().encode(renderEventTail(first.page, "json")).length).toBeLessThan(
        EVENT_TAIL_MAX_BYTES,
      );
      const query = parseEventTailQuery(
        new URL(first.page.page_end.next, "https://a.asimposium.org").searchParams,
      );
      if (!query) throw new Error("invalid byte-bounded continuation");
      const second = await readPublicEventTail(f.db, "P-DEMO", query);
      if (!second) throw new Error("missing continuation page");
      const entries = [...first.page.events, ...second.page.events];
      expect(entries.map((entry) => entry.seq)).toEqual(
        Array.from({ length: 200 }, (_, index) => index + 1),
      );
      expect(second.page.page_end.has_more).toBe(false);
      for (const entry of entries.slice(15)) expect(entry.event?.caused_by).toEqual(parents);
      expect(EventTailResponseSchema.safeParse(first.page).success).toBe(true);
      expect(EventTailResponseSchema.safeParse(second.page).success).toBe(true);
    } finally {
      f.sql.close();
    }
  });
  test("other problems and unpublished events cannot bleed into a tail", async () => {
    const f = fixture(2);
    try {
      f.sql.exec("INSERT INTO problems VALUES ('P-OTHER', 0, 'open', 0)");
      f.append(1, "claim", "claim.created", "P-OTHER");
      f.append(3);
      f.sql.exec("UPDATE problems SET public_seq=2 WHERE id='P-DEMO'");
      const result = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10 });
      expect(result?.page.events.map((event) => event.seq)).toEqual([1, 2]);
      expect(JSON.stringify(result)).not.toContain("P-OTHER");
    } finally {
      f.sql.close();
    }
  });
  test("a missing sequence refuses instead of certifying a completed page", async () => {
    const f = fixture(3);
    try {
      f.sql.exec("DELETE FROM events WHERE seq=2");
      await expectCode(
        () => readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 2 }),
        "EVENT_TAIL_UNAVAILABLE",
      );
    } finally {
      f.sql.close();
    }
  });
  test("future or regressed cuts cannot skip undiscovered data", async () => {
    const f = fixture(3);
    try {
      await expectCode(
        () => readPublicEventTail(f.db, "P-DEMO", { since: 4, limit: 10 }),
        "CURSOR_INVALID",
      );
      await expectCode(
        () => readPublicEventTail(f.db, "P-DEMO", { since: 0, through: 4, limit: 10 }),
        "CURSOR_INVALID",
      );
    } finally {
      f.sql.close();
    }
  });
  test("malformed/overlong envelopes remain bounded sequence-only entries", async () => {
    const f = fixture(3);
    try {
      f.sql.prepare("UPDATE events SET object_id=? WHERE seq=1").run("x".repeat(100000));
      f.sql.exec(
        "UPDATE events SET created_at='2026-02-30T00:00:00.000Z' WHERE seq=2; UPDATE events SET payload_sha256='broken' WHERE seq=3",
      );
      const result = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 10 });
      expect(result?.page.events.map((event) => event.event)).toEqual([null, null, null]);
      expect(JSON.stringify(result).length < 2000).toBe(true);
    } finally {
      f.sql.close();
    }
  });
  test("privacy change wins even during a pinned traversal", async () => {
    const f = fixture(3);
    try {
      const first = await readPublicEventTail(f.db, "P-DEMO", { since: 0, limit: 1 });
      expect(first?.page.page_end.has_more).toBe(true);
      f.sql.exec("UPDATE problems SET status='private-draft'");
      expect(
        await readPublicEventTail(f.db, "P-DEMO", { since: 1, limit: 1, through: 3 }),
      ).toBeNull();
    } finally {
      f.sql.close();
    }
  });
  test("invalid programmatic inputs never touch the binding", async () => {
    const f = fixture();
    try {
      for (const query of [
        { since: -1, limit: 1 },
        { since: 0, limit: 201 },
        { since: 0, limit: 1, through: NaN },
      ])
        await expectCode(() => readPublicEventTail(f.db, "P-DEMO", query), "CURSOR_INVALID");
      await expectCode(
        () => readPublicEventTail(f.db, "../private", { since: 0, limit: 1 }),
        "CURSOR_INVALID",
      );
      expect(f.queries.length).toBe(0);
    } finally {
      f.sql.close();
    }
  });
});
