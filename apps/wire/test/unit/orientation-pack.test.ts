import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { ProblemDetailSchema, type ProblemStatementBoundaries } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { EnrollmentService } from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { readPublicEventTail } from "../../src/ledger/event-tail-read.ts";
import {
  readPublishedProblemFormulation,
  readPublishedProblemFormulations,
} from "../../src/ledger/problem-formulation-read.ts";
import { createProblemRouter } from "../../src/problems/router.ts";
import {
  type OrientationPackSection,
  readOrientationPack,
} from "../../src/sessions/orientation-pack.ts";

const AT = "2026-09-24T00:00:00.000Z";
const STATEMENT = "For every integer n, n squared and n have the same parity.";
const FALSIFIER = "An integer whose square has different parity from the integer.";
const MOTIVATION = "Check both residue classes modulo two.";
const BOUNDARIES = {
  scope: "  Integers, including negative values.\nRetain this exact spacing.  ",
  out_of_scope: "Real and complex non-integers are outside this problem.",
  success_criteria: "A proof covering both residue classes modulo two.",
} satisfies ProblemStatementBoundaries;

function formulation(version = 1, boundaries?: ProblemStatementBoundaries) {
  return {
    action: version === 1 ? "publish" : "revise-statement",
    acting_principal: { type: "sponsor", id: "usr_pack_owner" },
    source_fellow_id: "F-AUTHOR",
    previous_status: version === 1 ? "private-draft" : "sharpening",
    previous_statement_version: Math.max(1, version - 1),
    problem: {
      id: "P-DEMO",
      title: "Parity target",
      current_statement_version: version,
      statement: version === 1 ? STATEMENT : "The strengthened parity formulation.",
      falsifier: FALSIFIER,
      motivation: MOTIVATION,
      ...boundaries,
      status: "sharpening",
      updated_at: AT,
    },
  };
}

// The actual selector SQL runs against SQLite. This adapter supplies only the
// read interface D1 exposes; the HTTP integration lane also uses real Workerd/D1.
async function fixture(boundaries?: ProblemStatementBoundaries) {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems (
      id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER,
      title TEXT DEFAULT 'UNCOMMITTED-TITLE-CANARY',
      current_statement_version INTEGER DEFAULT 1, areas TEXT DEFAULT '[]',
      created_at TEXT DEFAULT '2026-09-24T00:00:00.000Z',
      updated_at TEXT DEFAULT '2026-09-24T00:00:00.000Z'
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, created_at TEXT,
      payload_sha256 TEXT, actor_fellow_id TEXT, actor_sponsor_id TEXT,
      actor_session_id TEXT, model_string_self_declared TEXT, harness TEXT,
      UNIQUE(problem_id, seq)
    );
    CREATE TABLE event_content (
      event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT
    );
    CREATE TABLE screening_publications (event_id TEXT PRIMARY KEY, provenance_json TEXT NOT NULL);
    CREATE TABLE content_controls (
      problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER
    );
    CREATE TABLE workshop_objects (body TEXT);
    CREATE TABLE problem_statement_versions (
      problem_id TEXT, version INTEGER, statement TEXT, falsifier TEXT, motivation TEXT,
      scope TEXT, out_of_scope TEXT, success_criteria TEXT
    );
    CREATE TABLE problem_stewards (problem_id TEXT, sponsor_id TEXT, created_at TEXT);
    INSERT INTO problems (id, public_seq, status, unlisted) VALUES ('P-DEMO', 0, 'active', 0);
    INSERT INTO workshop_objects VALUES ('PRIVATE-WORKSHOP-CANARY');
    INSERT INTO problem_statement_versions VALUES (
      'P-DEMO', 1, 'UNCOMMITTED-FORMULATION-CANARY', 'UNCOMMITTED-FALSIFIER', 'UNCOMMITTED-MOTIVATION',
      'UNCOMMITTED-SCOPE', 'UNCOMMITTED-EXCLUSIONS', 'UNCOMMITTED-SUCCESS'
    );
  `);
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      queries.push(query);
      return {
        bind(...values: (string | number | null)[]) {
          return {
            async all<T>() {
              return { results: sql.prepare(query).all(...values) as T[] };
            },
            async first<T>() {
              return sql.prepare(query).get(...values) as T | null;
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
    payload: unknown = {},
    version = 1,
    objectId?: string,
  ) {
    cursor += 1;
    const body = JSON.stringify(payload);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const id = `E-${cursor}`;
    sql
      .prepare(
        "INSERT INTO events VALUES (?, 'P-DEMO', ?, ?, ?, ?, ?, ?, ?, 'F-AUTHOR', 'usr_pack_owner', 'S-AUTHOR', 'declared-model', 'declared-harness')",
      )
      .run(
        id,
        cursor,
        type,
        kind,
        objectId ?? (kind === "problem" ? "P-DEMO" : `C-${cursor}`),
        version,
        AT,
        hash,
      );
    sql.prepare("INSERT INTO event_content VALUES (?, ?, ?, NULL)").run(id, hash, body);
    sql.prepare("UPDATE problems SET public_seq = ? WHERE id = 'P-DEMO'").run(cursor);
    if (type === "problem.statement-revised") {
      sql
        .prepare("UPDATE problems SET current_statement_version = ? WHERE id = 'P-DEMO'")
        .run(version);
    }
  }
  await append("problem.admitted", "problem", formulation(1, boundaries));
  return {
    sql,
    db,
    queries,
    append,
    get cursor() {
      return cursor;
    },
  };
}

function sequences(section: OrientationPackSection): number[] {
  return section.candidates
    .filter((item) => item.kind === "orientation-event")
    .map((item) => (JSON.parse(item.body) as { seq: number }).seq);
}

function statement(section: OrientationPackSection) {
  const item = section.candidates.find((candidate) => candidate.kind === "problem-formulation");
  return item === undefined ? undefined : JSON.parse(item.body);
}

async function publicDetail(db: D1Database): Promise<Response> {
  const router = createProblemRouter({
    service: {
      credentialBinding: async () => undefined,
    } as unknown as EnrollmentService,
    verifiedSponsor: async () => new Response(null, { status: 403 }),
  });
  return router.fetch(new Request("https://a.asimposium.org/v1/problems/P-DEMO"), {
    DB: db,
  } as Env);
}

describe("cursor-aware orientation context", () => {
  test("versioned boundaries retain exact publication bytes across singleton, page, pack and complete reads", async () => {
    const f = await fixture(BOUNDARIES);
    try {
      const next = {
        scope: "Only positive integers.",
        out_of_scope: "Zero and negative integers are excluded from this revision.",
        success_criteria: "An explicit proof for each positive integer.",
      };
      await f.append("problem.statement-revised", "problem", formulation(2, next), 2);
      for (const [cursor, expected] of [
        [1, BOUNDARIES],
        [2, next],
      ] as const) {
        const single = await readPublishedProblemFormulation(f.db, "P-DEMO", cursor);
        const page = await readPublishedProblemFormulations(f.db, [
          { problem_id: "P-DEMO", through: cursor },
        ]);
        expect(single?.problem).toMatchObject(expected);
        expect(page.get("P-DEMO")).toEqual(single);
        const pack = await readOrientationPack(f.db, "P-DEMO", cursor);
        expect(statement(pack)).toMatchObject({ ...expected, statement_version: cursor });
        expect(JSON.stringify(pack)).not.toContain("UNCOMMITTED-");
      }
      const detail = await publicDetail(f.db);
      expect(detail.status).toBe(200);
      expect(((await detail.json()) as { problem: unknown }).problem).toMatchObject(next);
    } finally {
      f.sql.close();
    }
  });

  test("legacy formulation boundaries stay absent even after a later version declares them", async () => {
    const f = await fixture();
    try {
      await f.append("problem.statement-revised", "problem", formulation(2, BOUNDARIES), 2);
      const legacy = await readPublishedProblemFormulation(f.db, "P-DEMO", 1);
      const historical = statement(await readOrientationPack(f.db, "P-DEMO", 1));
      for (const field of ["scope", "out_of_scope", "success_criteria"]) {
        expect(legacy?.problem).not.toHaveProperty(field);
        expect(historical).not.toHaveProperty(field);
      }
      expect(JSON.stringify(historical)).not.toContain("UNCOMMITTED-");
      expect(statement(await readOrientationPack(f.db, "P-DEMO", 2))).toMatchObject(BOUNDARIES);
    } finally {
      f.sql.close();
    }
  });

  test("invalid current boundary bundles cannot fall back to older formulation bytes", async () => {
    for (const invalid of [
      { scope: "Partial scope" },
      { ...BOUNDARIES, scope: " \n " },
      { ...BOUNDARIES, out_of_scope: null },
      { ...BOUNDARIES, success_criteria: "x".repeat(4097) },
    ]) {
      const f = await fixture(BOUNDARIES);
      try {
        const next = formulation(2);
        await f.append(
          "problem.statement-revised",
          "problem",
          {
            ...next,
            problem: { ...next.problem, ...invalid },
          },
          2,
        );
        expect(await readPublishedProblemFormulation(f.db, "P-DEMO", 2)).toBeUndefined();
        expect(
          (await readPublishedProblemFormulations(f.db, [{ problem_id: "P-DEMO", through: 2 }]))
            .size,
        ).toBe(0);
        const pack = await readOrientationPack(f.db, "P-DEMO", 2);
        expect(statement(pack)).toBeUndefined();
        expect(JSON.stringify(pack)).not.toContain(BOUNDARIES.success_criteria);
      } finally {
        f.sql.close();
      }
    }
  });

  test("current controls and source integrity protect historical boundary bundles as a whole", async () => {
    for (const mutation of [
      "INSERT INTO content_controls VALUES ('P-DEMO', 'problem', 'hidden', 1)",
      "INSERT INTO content_controls VALUES ('P-DEMO', 'P-DEMO', 'hidden', 1)",
      "INSERT INTO content_controls VALUES ('P-DEMO', 'P-DEMO@1', 'hidden', 1)",
      "INSERT INTO content_controls VALUES ('P-DEMO', '#1', 'hidden', 1)",
      "UPDATE event_content SET redacted_at = '2026-09-25' WHERE event_id = 'E-1'",
      "UPDATE event_content SET payload_json = replace(payload_json, 'negative', 'positive') WHERE event_id = 'E-1'",
    ]) {
      const f = await fixture(BOUNDARIES);
      try {
        await f.append("problem.statement-revised", "problem", formulation(2, BOUNDARIES), 2);
        f.sql.exec(mutation);
        expect(await readPublishedProblemFormulation(f.db, "P-DEMO", 1)).toBeUndefined();
        const pack = await readOrientationPack(f.db, "P-DEMO", 1);
        expect(statement(pack)).toBeUndefined();
        expect(JSON.stringify(pack)).not.toContain(BOUNDARIES.success_criteria);
        if (mutation.startsWith("INSERT")) {
          f.sql.exec("UPDATE content_controls SET visibility = 'visible', version = 2");
          expect(statement(await readOrientationPack(f.db, "P-DEMO", 1))).toMatchObject(BOUNDARIES);
        }
      } finally {
        f.sql.close();
      }
    }
  });

  test("boundary bytes count toward whole-formulation pack limits while the complete read retains all fields", async () => {
    const largeBoundaries = {
      scope: "s".repeat(4096),
      out_of_scope: "o".repeat(4096),
      success_criteria: "c".repeat(4096),
    };
    const f = await fixture();
    try {
      const large = formulation(2, largeBoundaries);
      large.problem.statement = "p".repeat(8192);
      await f.append("problem.statement-revised", "problem", large, 2);
      const pack = await readOrientationPack(f.db, "P-DEMO", 2);
      expect(statement(pack)).toMatchObject({ content_omitted: "whole-formulation-size-limit" });
      for (const field of ["statement", "scope", "out_of_scope", "success_criteria"])
        expect(statement(pack)).not.toHaveProperty(field);
      expect(pack.actions.some((action) => action.url === "/v1/problems/P-DEMO")).toBe(true);
      const detail = await publicDetail(f.db);
      expect(detail.status).toBe(200);
      expect(((await detail.json()) as { problem: unknown }).problem).toMatchObject(
        largeBoundaries,
      );
    } finally {
      f.sql.close();
    }
  });

  test("a fresh pack carries the committed formulation and attribution, with no private projections", async () => {
    const f = await fixture();
    try {
      const pack = await readOrientationPack(f.db, "P-DEMO", f.cursor);
      expect(statement(pack)).toMatchObject({
        problem_id: "P-DEMO",
        statement_version: 1,
        statement: STATEMENT,
        falsifier: FALSIFIER,
        motivation: MOTIVATION,
        source_fellow_id: "F-AUTHOR",
        acting_principal: { type: "sponsor", id: "usr_pack_owner" },
        publication: { event_id: "E-1", seq: 1 },
      });
      expect(sequences(pack)).toEqual([1]);
      const serialized = JSON.stringify(pack);
      expect(serialized).not.toContain("PRIVATE-WORKSHOP-CANARY");
      expect(serialized).not.toContain("UNCOMMITTED-FORMULATION-CANARY");
      expect(
        f.queries.some((query) =>
          /FROM\s+(workshop_objects|problem_statement_versions|sessions)\b/i.test(query),
        ),
      ).toBe(false);
    } finally {
      f.sql.close();
    }
  });

  test("standing context is stable across deltas and only advances at a committed statement revision", async () => {
    const f = await fixture();
    try {
      const first = await readOrientationPack(f.db, "P-DEMO", f.cursor);
      await f.append("claim.created", "claim");
      const atTwo = await readOrientationPack(f.db, "P-DEMO", f.cursor);
      expect(statement(atTwo)).toEqual(statement(first));
      await f.append("problem.statement-revised", "problem", formulation(2), 2);
      const pinned = await readOrientationPack(f.db, "P-DEMO", 2);
      expect(statement(pinned)).toEqual(statement(first));
      expect(sequences(pinned)).toEqual([1, 2]);
      const current = await readOrientationPack(f.db, "P-DEMO", f.cursor);
      expect(statement(current).statement_version).toBe(2);
      expect(sequences(current)).toEqual([1, 2, 3]);
      expect(await readOrientationPack(f.db, "P-DEMO", f.cursor)).toEqual(current);
    } finally {
      f.sql.close();
    }
  });

  test("initial orientation chooses the newest five; since chooses earliest changes and links the complete window", async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 8; i += 1) await f.append("claim.created", "claim");
      expect(sequences(await readOrientationPack(f.db, "P-DEMO", f.cursor))).toEqual([
        5, 6, 7, 8, 9,
      ]);
      const caught = await readOrientationPack(f.db, "P-DEMO", f.cursor, 2);
      expect(sequences(caught)).toEqual([3, 4, 5, 6, 7]);
      expect(caught.omitted.some((entry) => entry.reason === "candidate_limit")).toBe(true);
      const action = caught.actions.find((entry) => entry.url.includes("/events.json?"));
      expect(action).toBeDefined();
      const params = new URL(action?.url ?? "", "https://a.asimposium.org").searchParams;
      const complete = await readPublicEventTail(f.db, "P-DEMO", {
        since: Number(params.get("since")),
        through: Number(params.get("through")),
        limit: Number(params.get("limit")),
      });
      expect(complete?.page.events.map((event) => event.seq)).toEqual([3, 4, 5, 6, 7, 8, 9]);
      expect(complete?.page.page_end.next_cursor).toBe(9);
      const current = await readOrientationPack(f.db, "P-DEMO", f.cursor, 9);
      expect(sequences(current)).toEqual([]);
      expect(statement(current).statement).toBe(STATEMENT);
    } finally {
      f.sql.close();
    }
  });

  test("process and low-substance events do not crowd material changes, and event bodies stay absent", async () => {
    const f = await fixture();
    try {
      await f.append("workshop.pushed", "workshop", { body: "PRIVATE-EVENT-CANARY" });
      await f.append("synthesis.created", "synthesis", { body: "SYNTHESIS-NARRATIVE-CANARY" });
      await f.append("dead_end.recorded", "dead-end", { flags: ["low-substance-dead-end"] });
      await f.append("dead_end.recorded", "dead-end", { finding: "SUBSTANTIVE-BODY-CANARY" });
      await f.append("evidence.created", "evidence", { body: "EVIDENCE-BODY-CANARY" });
      const pack = await readOrientationPack(f.db, "P-DEMO", f.cursor, 1);
      expect(sequences(pack)).toEqual([5, 6]);
      expect(pack.omitted.some((entry) => entry.reason === "profile_summary")).toBe(true);
      for (const canary of [
        "PRIVATE-EVENT-CANARY",
        "SYNTHESIS-NARRATIVE-CANARY",
        "SUBSTANTIVE-BODY-CANARY",
        "EVIDENCE-BODY-CANARY",
      ]) {
        expect(JSON.stringify(pack)).not.toContain(canary);
      }
    } finally {
      f.sql.close();
    }
  });

  test("orientation warnings remain platform metadata while citation events stay outside the material summary", async () => {
    const f = await fixture();
    try {
      await f.append(
        "evidence.created",
        "evidence",
        { body_md: "WARNED-EVIDENCE-NARRATIVE-CANARY" },
        1,
        "E-WARNED",
      );
      await f.append(
        "citation.recorded",
        "citation",
        { title: "CITATION-NARRATIVE-CANARY" },
        1,
        "L-1",
      );
      const receipt = await Bun.file(
        new URL(
          "../../../../packages/contracts/test/fixtures/valid/screening-publication-warning-provenance.json",
          import.meta.url,
        ),
      ).json();
      for (const id of ["E-2", "E-3"])
        f.sql
          .prepare("INSERT INTO screening_publications VALUES (?, ?)")
          .run(id, JSON.stringify(receipt));
      const pack = await readOrientationPack(f.db, "P-DEMO", 3, 1);
      expect(sequences(pack)).toEqual([2]);
      const evidence = pack.candidates.find((item) => item.id === "DELTA-2");
      expect(evidence?.screening_notice).toEqual(receipt.public_action);
      expect(JSON.parse(evidence?.body ?? "{}").event.screening_notice).toEqual(
        receipt.public_action,
      );
      expect(pack.omitted.some((entry) => entry.reason === "profile_summary")).toBe(true);
      for (const hidden of [
        "WARNED-EVIDENCE-NARRATIVE-CANARY",
        "CITATION-NARRATIVE-CANARY",
        "configuration_digest",
        "input_digest",
      ])
        expect(JSON.stringify(pack)).not.toContain(hidden);
      f.sql
        .prepare("UPDATE screening_publications SET provenance_json = ? WHERE event_id = 'E-2'")
        .run(JSON.stringify({ private_detail: "PRIVATE_SCREENING_CANARY" }));
      const unavailable = await readOrientationPack(f.db, "P-DEMO", 3, 1);
      expect(sequences(unavailable)).toEqual([]);
      expect(
        unavailable.omitted.some((entry) => entry.reason === "orientation_events_unavailable"),
      ).toBe(true);
      expect(JSON.stringify(unavailable)).not.toContain("PRIVATE_SCREENING_CANARY");
    } finally {
      f.sql.close();
    }
  });

  test("statement-review materiality uses its published previous lifecycle, never today's status", async () => {
    const f = await fixture();
    try {
      const review = {
        problem_id: "P-DEMO",
        session_id: "S-abcdefghijklmnopqrstuvwxyz",
        statement_version: 1,
        verdict: "statement-clear",
        basis: "Both residue classes are precise.",
        previous_status: "sharpening",
        status: "active",
      };
      await f.append("problem.statement-reviewed", "problem", review);
      await f.append("problem.statement-reviewed", "problem", {
        ...review,
        previous_status: "active",
      });
      const pack = await readOrientationPack(f.db, "P-DEMO", f.cursor, 1);
      expect(sequences(pack)).toEqual([2]);
      expect(pack.omitted.some((entry) => entry.reason === "materiality_unavailable")).toBe(false);
      f.sql.exec("UPDATE event_content SET redacted_at = '2026-09-25' WHERE event_id = 'E-2'");
      const unavailable = await readOrientationPack(f.db, "P-DEMO", f.cursor, 1);
      expect(sequences(unavailable)).toEqual([]);
      expect(unavailable.omitted.some((entry) => entry.reason === "materiality_unavailable")).toBe(
        true,
      );
    } finally {
      f.sql.close();
    }
  });

  test("a missing or corrupt latest formulation never falls back to older publication text", async () => {
    for (const mutation of [
      "redacted_at = '2026-09-25T00:00:00.000Z'",
      "payload_json = '{}'",
      "payload_sha256 = 'invalid'",
    ]) {
      const f = await fixture();
      try {
        await f.append("problem.statement-revised", "problem", formulation(2), 2);
        f.sql.exec(`UPDATE event_content SET ${mutation} WHERE event_id = 'E-2'`);
        const pack = await readOrientationPack(f.db, "P-DEMO", f.cursor);
        expect(statement(pack)).toBeUndefined();
        expect(
          pack.omitted.some((entry) => entry.reason === "problem_formulation_unavailable"),
        ).toBe(true);
        expect(JSON.stringify(pack)).not.toContain(STATEMENT);
        expect(JSON.stringify(pack)).not.toContain("The strengthened parity formulation.");
      } finally {
        f.sql.close();
      }
    }
  });

  test("current whole-problem controls also protect requests captured at an earlier cursor", async () => {
    const f = await fixture();
    try {
      await f.append("claim.created", "claim");
      f.sql.exec("INSERT INTO content_controls VALUES ('P-DEMO', 'problem', 'hidden', 1)");
      const pack = await readOrientationPack(f.db, "P-DEMO", 1);
      expect(pack.candidates).toEqual([]);
      expect(pack.omitted.some((entry) => entry.reason === "orientation_events_unavailable")).toBe(
        true,
      );
      expect(JSON.stringify(pack)).not.toContain(STATEMENT);
    } finally {
      f.sql.close();
    }
  });

  test("exact object, statement-version and event controls hide formulation bytes until restored", async () => {
    for (const target of ["P-DEMO", "P-DEMO@2", "#2"]) {
      const f = await fixture();
      try {
        await f.append("problem.statement-revised", "problem", formulation(2), 2);
        f.sql.prepare("INSERT INTO content_controls VALUES ('P-DEMO', ?, 'hidden', 1)").run(target);
        const hidden = await readOrientationPack(f.db, "P-DEMO", f.cursor);
        expect(statement(hidden)).toBeUndefined();
        expect(JSON.stringify(hidden)).not.toContain("The strengthened parity formulation.");
        f.sql
          .prepare("INSERT INTO content_controls VALUES ('P-DEMO', ?, 'visible', 2)")
          .run(target);
        expect(
          statement(await readOrientationPack(f.db, "P-DEMO", f.cursor)).statement_version,
        ).toBe(2);
      } finally {
        f.sql.close();
      }
    }
  });

  test("oversized formulations keep a whole publication reference and a complete-read action", async () => {
    const f = await fixture();
    try {
      const large = formulation(2);
      large.problem.statement = "s".repeat(8192);
      large.problem.falsifier = "f".repeat(8192);
      large.problem.motivation = "m".repeat(8192);
      await f.append("problem.statement-revised", "problem", large, 2);
      const pack = await readOrientationPack(f.db, "P-DEMO", f.cursor);
      expect(statement(pack)).toMatchObject({
        statement_version: 2,
        publication: { event_id: "E-2", seq: 2 },
        content_omitted: "whole-formulation-size-limit",
      });
      expect(statement(pack)).not.toHaveProperty("statement");
      expect(pack.omitted.some((entry) => entry.reason === "item_too_large")).toBe(true);
      expect(pack.actions.some((action) => action.url === "/v1/problems/P-DEMO")).toBe(true);
    } finally {
      f.sql.close();
    }
  });

  test("the complete public fallback reads committed text, including a formulation too large for one pack item", async () => {
    const f = await fixture();
    try {
      const first = await publicDetail(f.db);
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { problem: unknown };
      const initial = ProblemDetailSchema.parse(firstBody.problem);
      expect(initial.title).toBe("Parity target");
      expect(initial.statement).toBe(STATEMENT);
      expect(initial.status).toBe("active");
      expect(JSON.stringify(initial)).not.toContain("UNCOMMITTED-");
      const large = formulation(2);
      large.problem.statement = "漢".repeat(8192);
      large.problem.falsifier = "字".repeat(8192);
      large.problem.motivation = "文".repeat(8192);
      await f.append("problem.statement-revised", "problem", large, 2);
      const complete = await publicDetail(f.db);
      expect(complete.status).toBe(200);
      const completeBody = (await complete.json()) as { problem: unknown };
      const current = ProblemDetailSchema.parse(completeBody.problem);
      expect(current.current_statement_version).toBe(2);
      expect(current.statement).toBe(large.problem.statement);
      expect(current.falsifier).toBe(large.problem.falsifier);
      expect(current.motivation).toBe(large.problem.motivation);
    } finally {
      f.sql.close();
    }
  });

  test("the full public fallback refuses withdrawn, corrupt, hidden or uncommitted current formulations", async () => {
    for (const mutation of [
      "UPDATE event_content SET redacted_at = '2026-09-25' WHERE event_id = 'E-2'",
      "UPDATE event_content SET payload_json = '{}' WHERE event_id = 'E-2'",
      "UPDATE event_content SET payload_sha256 = 'invalid' WHERE event_id = 'E-2'",
      "UPDATE problems SET current_statement_version = 3",
      "UPDATE problems SET public_seq = 1",
      "INSERT INTO content_controls VALUES ('P-DEMO', 'problem', 'hidden', 1)",
      "INSERT INTO content_controls VALUES ('P-DEMO', 'P-DEMO', 'hidden', 1)",
      "INSERT INTO content_controls VALUES ('P-DEMO', 'P-DEMO@2', 'hidden', 1)",
      "INSERT INTO content_controls VALUES ('P-DEMO', '#2', 'hidden', 1)",
    ]) {
      const f = await fixture();
      try {
        await f.append("problem.statement-revised", "problem", formulation(2), 2);
        f.sql.exec(mutation);
        const response = await publicDetail(f.db);
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toContain("no-store");
        const body = await response.text();
        expect(JSON.parse(body).code).toBe("PROBLEM_NOT_FOUND");
        expect(body).not.toContain(STATEMENT);
        expect(body).not.toContain("The strengthened parity formulation.");
        expect(body).not.toContain("UNCOMMITTED-");
      } finally {
        f.sql.close();
      }
    }
  });

  test("the full public fallback retains the private-draft authorization boundary", async () => {
    const f = await fixture();
    try {
      f.sql.exec("UPDATE problems SET status = 'private-draft'");
      const response = await publicDetail(f.db);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("UNCOMMITTED-");
      expect(f.queries.some((query) => query.includes("FROM events"))).toBe(false);
    } finally {
      f.sql.close();
    }
  });

  test("the scan stays bounded and discloses both initial history and catch-up continuation", async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 209; i += 1) await f.append("claim.created", "claim");
      const initial = await readOrientationPack(f.db, "P-DEMO", f.cursor);
      expect(sequences(initial)).toEqual([206, 207, 208, 209, 210]);
      expect(initial.omitted.some((entry) => entry.reason === "history_window")).toBe(true);
      const caught = await readOrientationPack(f.db, "P-DEMO", f.cursor, 0);
      expect(sequences(caught)).toEqual([1, 2, 3, 4, 5]);
      expect(caught.omitted.some((entry) => entry.reason === "candidate_limit")).toBe(true);
    } finally {
      f.sql.close();
    }
  });
});
