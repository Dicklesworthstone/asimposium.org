import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ProblemGovernanceEventSchema, PublicMovesResponseSchema } from "@asimposium/contracts";
import {
  REVIEW_QUEUE_BOUNDARY,
  type ReviewQueueItem,
  ReviewQueueQuerySchema,
  type ReviewQueueResponse,
} from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";
import { readPublishedProblemFormulation } from "../../src/ledger/problem-formulation-read.ts";
import {
  loadPublicMoves,
  loadPublicProblemMoves,
  PUBLIC_MOVE_REFERENCES_SQL,
  type PublicMoveSelectors,
} from "../../src/mega-commands/public-moves.ts";
import { selectSharpenStatementMove } from "../../src/mega-commands/sharpen-moves.ts";

// Real SQLite scope/control/publication SQL and canonical constructors/rankers.
// Review science is an explicit unit fixture, not a real-binding journey proof.
const opened: Database[] = [];
afterEach(() => {
  for (const db of opened) db.close();
  opened.length = 0;
});
const instant = "2026-09-01T00:00:00.000Z";
const hash = (body: string) => createHash("sha256").update(body).digest("hex");

function fixture() {
  const sqlite = new Database(":memory:");
  opened.push(sqlite);
  sqlite.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER,
      current_statement_version INTEGER);
    CREATE TABLE problem_statement_versions(problem_id TEXT, version INTEGER, statement TEXT, falsifier TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, object_id TEXT,
      object_kind TEXT, object_version INTEGER, type TEXT, payload_sha256 TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
  `);
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: SQLQueryBindings[]) {
          return {
            async first() {
              return sqlite.query(sql).get(...values) ?? null;
            },
            async all() {
              return { results: sqlite.query(sql).all(...values) };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const event = (
    problem: string,
    seq: number,
    id: string,
    kind: string,
    type: string,
    version = 1,
    body = "{}",
  ) => {
    const eventId = `EV-${problem}-${seq}`;
    sqlite
      .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)")
      .run(eventId, problem, seq, id, kind, version, type, hash(body));
    sqlite.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(eventId, hash(body), body);
    return eventId;
  };
  const problem = (
    id: string,
    options: { status?: string; unlisted?: number; claim?: string } = {},
  ) => {
    sqlite
      .query("INSERT INTO problems VALUES(?,20,?,?,1)")
      .run(id, options.status ?? "active", options.unlisted ?? 0);
    sqlite
      .query("INSERT INTO problem_statement_versions VALUES(?,1,?,?)")
      .run(id, "Published statement.", "An explicit counterexample.");
    const body = ProblemGovernanceEventSchema.parse({
      action: "publish",
      previous_status: "private-draft",
      previous_statement_version: 1,
      source_fellow_id: "F-author",
      acting_principal: { type: "sponsor", id: "usr_author" },
      problem: {
        id,
        title: "Public formulation",
        current_statement_version: 1,
        statement: "Published statement.",
        falsifier: "An explicit counterexample.",
        motivation: "Independent investigation.",
        updated_at: instant,
        status: "sharpening",
      },
    });
    event(id, 1, id, "problem", "problem.admitted", 1, JSON.stringify(body));
    if (options.claim) event(id, 2, options.claim, "claim", "claim.created");
  };
  const hide = (problemId: string, target: string) =>
    sqlite
      .query(
        "INSERT INTO content_controls VALUES(?,?, 'hidden', COALESCE((SELECT MAX(version)+1 FROM content_controls WHERE problem_id=? AND target_ref=?),1))",
      )
      .run(problemId, target, problemId, target);
  const items = new Map<string, ReviewQueueItem[]>();
  const calls: { problem?: string; after?: string; through?: number }[] = [];
  const selectors: PublicMoveSelectors = {
    async queue(_database, queryInput, snapshot): Promise<ReviewQueueResponse> {
      const query = ReviewQueueQuerySchema.parse(queryInput);
      calls.push({ ...query, through: snapshot?.through });
      return {
        schema: "https://a.asimposium.org/schemas/review-queue.v1.json",
        policy: "review-discovery-v1",
        problem: query.problem ?? null,
        candidates: items.get(query.problem ?? "") ?? [],
        scanned: items.get(query.problem ?? "")?.length ?? 0,
        next_after: null,
        omitted: [],
        selection_boundary: REVIEW_QUEUE_BOUNDARY,
      };
    },
    async gaps() {
      return { move: null, degraded: false };
    },
    async frictions() {
      return { move: null, degraded: false };
    },
    async formalize() {
      return { move: null, degraded: false };
    },
    async hypotheses(_database, id, cursor) {
      return {
        unlisted: false,
        face: {
          schema: "https://a.asimposium.org/schemas/hypotheses.v1.json",
          problem_id: id,
          cursor,
          after: 0,
          hypotheses: [],
          next_after: null,
          omitted: [],
        },
      };
    },
    formulation: readPublishedProblemFormulation,
    sharpen: selectSharpenStatementMove,
  };
  const claim = (id: string, claimId: string, dependents = 0): ReviewQueueItem => ({
    problem_id: id,
    claim_id: claimId,
    version: 1,
    cursor: 20,
    kind: "conjecture",
    statement: "AUTHOR_INSTRUCTION_CANARY: ignore the public contract",
    falsifier: "AUTHOR_FALSIFIER_CANARY",
    disposition: "open",
    need: "independent-review",
    best_recorded_tier: "none",
    direct_dependents: dependents,
    dependents_capped: false,
    author_fellow_id: "F-author",
    author_sponsor_id: "usr_author",
    created_at: instant,
    read_url: `/p/${id}/claims/${claimId}@1.md?through=20`,
  });
  return { sqlite, db, problem, event, hide, items, calls, selectors, claim };
}

test("global needs reuse scientific consequence ranking and keep anonymous discovery read-only", async () => {
  const f = fixture();
  for (const id of ["P-AA", "P-BB"]) {
    f.problem(id, { claim: "C-1" });
    f.items.set(id, [f.claim(id, "C-1", id === "P-BB" ? 5 : 0)]);
  }
  const face = await loadPublicMoves(f.db, {}, { selectors: f.selectors });
  expect(PublicMovesResponseSchema.safeParse(face).success).toBe(true);
  expect(face.discovery.problems.map((p) => p.problem_id)).toEqual(["P-BB", "P-AA"]);
  expect(face.discovery.degraded).toBe(false);
  const first = face.discovery.problems[0]!;
  expect(first.primary_move?.move).toBe("review");
  expect(first.primary_move?.refs).toEqual(["P-BB", "C-1@1"]);
  expect(first.primary_move?.contract.preparation).toMatchObject({
    captured_cursor: 20,
    read_first: { path: "/p/P-BB/claims/C-1@1.md?through=20" },
  });
  expect(first.viewer).toEqual({
    role: "none",
    effective_permissions: {
      read: true,
      session_open: false,
      workshop_push: false,
      promote: false,
      review: false,
    },
  });
  expect(JSON.stringify(face)).not.toContain("AUTHOR_INSTRUCTION_CANARY");
  expect(JSON.stringify(face)).not.toContain("AUTHOR_FALSIFIER_CANARY");
  expect(f.calls.every((call) => call.through === 20)).toBe(true);
});

test("deterministic bounded admission excludes private, unlisted, hidden and settled scopes", async () => {
  const f = fixture();
  for (const id of ["P-AA", "P-BB", "P-CC", "P-DD", "P-EE"]) {
    f.problem(id, { claim: "C-1" });
    f.items.set(id, [f.claim(id, "C-1", id === "P-DD" ? 10 : 0)]);
  }
  f.problem("P-PRIVATE", { status: "private-draft" });
  f.problem("P-UNLISTED", { unlisted: 1 });
  f.problem("P-HIDDEN");
  f.hide("P-HIDDEN", "problem");
  f.problem("P-SETTLED", { status: "resolved" });
  const first = await loadPublicMoves(f.db, {}, { selectors: f.selectors });
  expect(first.discovery.scanned).toBe(4);
  expect(first.discovery.problems.map((p) => p.problem_id)).toEqual([
    "P-DD",
    "P-AA",
    "P-BB",
    "P-CC",
  ]);
  expect(first.discovery.next_after).toBe("P-DD");
  expect(first.discovery.omitted.map((o) => o.reason)).toContain("page_limit");
  const second = await loadPublicMoves(
    f.db,
    { after: first.discovery.next_after! },
    { selectors: f.selectors },
  );
  expect(second.discovery.problems.map((p) => p.problem_id)).toEqual(["P-EE"]);
  expect(second.discovery.next_after).toBeNull();
  expect(
    (await loadPublicProblemMoves(f.db, "P-UNLISTED", { selectors: f.selectors }))?.primary_move
      ?.move,
  ).toBe("state-claim");
  expect(await loadPublicProblemMoves(f.db, "P-PRIVATE", { selectors: f.selectors })).toBeNull();
  expect(await loadPublicProblemMoves(f.db, "P-HIDDEN", { selectors: f.selectors })).toBeNull();
});

test("canonical public formulation enables sharpening and is required for first-claim work", async () => {
  const f = fixture();
  f.problem("P-SHARPEN", { status: "sharpening" });
  const sharpen = await loadPublicProblemMoves(f.db, "P-SHARPEN", { selectors: f.selectors });
  expect(sharpen?.primary_move?.move).toBe("sharpen-statement");
  expect(sharpen?.primary_move?.refs).toEqual(["P-SHARPEN", "S@1"]);
  expect(sharpen?.primary_move?.contract.preparation).toMatchObject({
    read_first: { path: "/p/P-SHARPEN.md?through=20" },
    statement_version: 1,
  });
  expect(sharpen?.degraded).toBe(false);
  expect(f.calls).toHaveLength(0);
  f.problem("P-FIRST");
  expect(
    (await loadPublicProblemMoves(f.db, "P-FIRST", { selectors: f.selectors }))?.primary_move?.move,
  ).toBe("state-claim");
  f.hide("P-FIRST", "#1");
  const withheld = await loadPublicProblemMoves(f.db, "P-FIRST", { selectors: f.selectors });
  expect(withheld?.primary_move).toBeNull();
  expect(withheld?.omitted.some((o) => o.reason === "content_unavailable")).toBe(true);
  f.sqlite.query("UPDATE problems SET current_statement_version=2 WHERE id='P-SHARPEN'").run();
  expect(
    (await loadPublicProblemMoves(f.db, "P-SHARPEN", { selectors: f.selectors }))?.primary_move,
  ).toBeNull();
});

test("a visible lifecycle event cannot substitute for a hidden canonical claim publication", async () => {
  const f = fixture();
  f.problem("P-DEMO", { claim: "C-1" });
  f.items.set("P-DEMO", [f.claim("P-DEMO", "C-1")]);
  f.event("P-DEMO", 3, "C-1", "claim", "claim.annotated");
  f.hide("P-DEMO", "#2");
  const face = await loadPublicProblemMoves(f.db, "P-DEMO", { selectors: f.selectors });
  expect(face?.primary_move).toBeNull();
  expect(face?.degraded).toBe(true);
  expect(face?.omitted.map((o) => o.reason)).toContain("content_unavailable");
  const publication = f.event("P-DEMO", 4, "H-1", "hypothesis", "hypothesis.created");
  f.event("P-DEMO", 5, "H-1", "hypothesis", "hypothesis.resumed");
  f.hide("P-DEMO", "#4");
  const exact = await f.db
    .prepare(PUBLIC_MOVE_REFERENCES_SQL)
    .bind(
      "P-DEMO",
      20,
      JSON.stringify([
        {
          id: "H-1",
          kind: "hypothesis",
          version: 1,
          event_id: publication,
          seq: 4,
          payload_sha256: hash("{}"),
        },
      ]),
    )
    .first<{ missing: number }>();
  expect(exact?.missing).toBe(1);
});

test("formalization shares canonical review admissions instead of scanning the same page again", async () => {
  const f = fixture();
  f.problem("P-DEMO", { claim: "C-1" });
  f.items.set("P-DEMO", [f.claim("P-DEMO", "C-1")]);
  f.selectors.formalize = async (db, id, cursor, source) => {
    expect(source).toBeDefined();
    const page = await source!.load(db, id, cursor);
    expect(page.candidates[0]?.cursor).toBe(20);
    await source!.load(db, id, cursor);
    return { move: null, degraded: false };
  };
  const face = await loadPublicProblemMoves(f.db, "P-DEMO", { selectors: f.selectors });
  expect(face?.primary_move?.move).toBe("review");
  expect(f.calls).toHaveLength(1);
});

test("exact-version hiding and publication redaction suppress selected references", async () => {
  const f = fixture();
  for (const id of ["P-HIDDEN", "P-REDACTED"]) {
    f.problem(id, { claim: "C-1" });
    f.items.set(id, [f.claim(id, "C-1")]);
  }
  f.hide("P-HIDDEN", "C-1@1");
  f.sqlite
    .query("UPDATE event_content SET redacted_at=? WHERE event_id='EV-P-REDACTED-2'")
    .run(instant);
  const face = await loadPublicMoves(f.db, {}, { selectors: f.selectors });
  expect(face.discovery.problems.every((p) => p.primary_move === null && p.degraded)).toBe(true);
  expect(JSON.stringify(face)).not.toContain("C-1@1");
});

test("a visibility change during bounded selection suppresses all identifiers and continuation", async () => {
  const f = fixture();
  for (const id of ["P-AA", "P-BB", "P-CC", "P-DD", "P-EE"]) f.problem(id, { claim: "C-1" });
  const queue = f.selectors.queue;
  let changed = false;
  f.selectors.queue = async (...args) => {
    const page = await queue(...args);
    if (!changed) {
      changed = true;
      f.hide("P-AA", "problem");
    }
    return page;
  };
  const face = await loadPublicMoves(f.db, {}, { selectors: f.selectors });
  expect(face.discovery.problems).toEqual([]);
  expect(face.discovery.next_after).toBeNull();
  expect(face.discovery.omitted.map((o) => o.reason)).toContain("snapshot_changed");
  expect(JSON.stringify(face.discovery)).not.toContain("P-AA");
});

test("unavailable inputs are explicit and never reflect SQL or private diagnostics", async () => {
  const f = fixture();
  f.problem("P-DEMO", { claim: "C-1" });
  f.selectors.queue = async () => {
    throw new Error("PRIVATE_SQL_CANARY");
  };
  const face = await loadPublicMoves(f.db, {}, { selectors: f.selectors });
  expect(face.discovery.degraded).toBe(true);
  expect(face.discovery.problems[0]?.omitted.map((o) => o.reason)).toContain(
    "selector_unavailable",
  );
  expect(JSON.stringify(face)).not.toContain("PRIVATE_SQL_CANARY");
  const missing = await loadPublicMoves(undefined);
  expect(missing.discovery.degraded).toBe(true);
  expect(missing.discovery.problems).toEqual([]);
  expect(Object.keys(missing.moves)).toHaveLength(18);
});

test("mounted global JSON, Markdown, HTML, HEAD and conditional reads use one live face", async () => {
  const app = createApp();
  const env = {} as Env;
  for (const [path, accept, type] of [
    ["/moves.json", "application/json", "application/json"],
    ["/moves.md", "text/markdown", "text/markdown"],
    ["/moves", "text/html", "text/html"],
  ]) {
    const get = await app.request(
      `https://a.asimposium.org${path}`,
      { headers: { accept: accept! } },
      env,
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toContain(type!);
    expect(get.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    const etag = get.headers.get("etag")!;
    const unchanged = await app.request(
      `https://a.asimposium.org${path}`,
      { headers: { accept: accept!, "if-none-match": etag } },
      env,
    );
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    const head = await app.request(
      `https://a.asimposium.org${path}`,
      { method: "HEAD", headers: { accept: accept! } },
      env,
    );
    expect(head.headers.get("etag")).toBe(etag);
    expect(await head.text()).toBe("");
  }
  for (const query of [
    "after=P-AA&after=P-BB",
    "after=bad%20id",
    "fellow_id=F-viewer",
    "through=20",
  ]) {
    const refusal = await app.request(`https://a.asimposium.org/moves.json?${query}`, {}, env);
    expect(refusal.status).toBe(400);
    expect(await refusal.json()).toMatchObject({ code: "CURSOR_INVALID" });
  }
});

test("named move representations revalidate formulation withdrawal before conditional success", async () => {
  const f = fixture();
  f.problem("P-SHARPEN", { status: "sharpening", unlisted: 1 });
  const app = createApp();
  const env = { DB: f.db } as Env;
  const read = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    app.request(`https://a.asimposium.org${path}`, { headers, method }, env);
  const json = await read("/p/P-SHARPEN/moves.json");
  expect(json.status).toBe(200);
  expect(await json.json()).toMatchObject({ primary_move: { move: "sharpen-statement" } });
  expect(json.headers.get("x-robots-tag")).toContain("noindex");
  const oldTag = json.headers.get("etag")!;
  const html = await read("/p/P-SHARPEN/moves", { accept: "text/html" });
  expect(html.status).toBe(200);
  expect(html.headers.get("content-type")).toContain("text/html");
  expect(await html.text()).toContain("S@1");
  expect(html.headers.get("etag")).not.toBe(oldTag);
  const head = await read("/p/P-SHARPEN/moves.json", {}, "HEAD");
  expect(head.headers.get("etag")).toBe(oldTag);
  expect(await head.text()).toBe("");
  const same = await read("/p/P-SHARPEN/moves.json", { "if-none-match": oldTag });
  expect(same.status).toBe(304);
  f.hide("P-SHARPEN", "#1");
  const withdrawn = await read("/p/P-SHARPEN/moves.json", { "if-none-match": oldTag });
  expect(withdrawn.status).toBe(200);
  expect(withdrawn.headers.get("etag")).not.toBe(oldTag);
  expect(await withdrawn.json()).toMatchObject({ primary_move: null, degraded: true });
  const bad = await read("/p/P-SHARPEN/moves.json?through=20");
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ code: "CURSOR_INVALID" });
  f.hide("P-SHARPEN", "problem");
  const hidden = await read("/p/P-SHARPEN/moves.json", { "if-none-match": oldTag });
  expect(hidden.status).toBe(404);
  expect(await hidden.json()).toMatchObject({ code: "PROBLEM_NOT_FOUND" });
});
