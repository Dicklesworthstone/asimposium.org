import { type ProblemsIndexResponse, ProblemsIndexResponseSchema } from "@asimposium/contracts";
import { Hono } from "hono";

import type { Env } from "./env";
import { problem as problemDocument } from "./http/envelope";
import { readEvents } from "./krater/krater";

/**
 * The first public ledger face (a W6.1 down payment): the problems index.
 * JSON is canonical; Markdown is the reading face. Rows come from the Krater
 * `problems` projection directly, so an empty ledger answers an honest empty
 * list rather than a dressed-up placeholder. `omitted[]` says what the face
 * leaves out.
 */
const OMITTED = ["titles, statements, and statuses land with the problem lifecycle (W5.1)"];

interface ProblemRow {
  id: string;
  public_seq: number;
  created_at: string;
  updated_at: string;
}

const PUBLIC_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

function ifNoneMatchMatches(value: string | undefined, etag: string): boolean {
  if (value === undefined) return false;
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag || normalized === `W/${etag}`;
  });
}

async function strongEtag(face: "json" | "markdown", body: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${face}\n${body}`),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
}

async function loadIndex(db: Env["DB"]): Promise<ProblemsIndexResponse> {
  // One row over the face limit decides whether the index is complete; when
  // it is not, omitted[] says so rather than silently truncating.
  const rows = await db
    .prepare(
      "SELECT id, public_seq, created_at, updated_at FROM problems ORDER BY public_seq DESC LIMIT 201",
    )
    .all<ProblemRow>();
  const truncated = rows.results.length > 200;
  const omitted = truncated
    ? [...OMITTED, "results beyond the 200 most recent by public_seq"]
    : OMITTED;
  return ProblemsIndexResponseSchema.parse({
    problems: rows.results.slice(0, 200),
    omitted,
  });
}

export function createLedgerFaceRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.on(["GET", "HEAD"], "/problems.json", async (c) => {
    const body = JSON.stringify(await loadIndex(c.env.DB));
    const etag = await strongEtag("json", body);
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": PUBLIC_CACHE_CONTROL,
      etag,
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    return new Response(c.req.method === "HEAD" ? null : body, { status: 200, headers });
  });

  app.on(["GET", "HEAD"], "/problems.md", async (c) => {
    const data = await loadIndex(c.env.DB);
    const listing =
      data.problems.length === 0
        ? "No problems have been promoted to the public ledger yet."
        : data.problems
            .map((p) => `- \`${p.id}\` — seq ${p.public_seq}, opened ${p.created_at}`)
            .join("\n");
    const body = `# Public problems\n\n${listing}\n\nomitted: ${data.omitted.join("; ")}\n`;
    const etag = await strongEtag("markdown", body);
    const headers = {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": PUBLIC_CACHE_CONTROL,
      etag,
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    return new Response(c.req.method === "HEAD" ? null : body, { status: 200, headers });
  });

  // W6.1: the per-problem public face. Anonymous reads only ever see public
  // projection rows — workshop content has no path here (Rule A2).
  app.on(["GET", "HEAD"], "/p/:id{.+\\.json$}", async (c) => {
    const problemId = c.req.param("id").slice(0, -".json".length);
    const problemRow = await c.env.DB.prepare(
      "SELECT id, public_seq, created_at FROM problems WHERE id = ?",
    )
      .bind(problemId)
      .first<{ id: string; public_seq: number; created_at: string }>();
    if (problemRow === null || problemRow === undefined) {
      return problemDocument({
        status: 404,
        code: "PROBLEM_NOT_FOUND",
        title: "No such problem",
        detail: "No public problem with this id exists.",
        fixHint: "Check the id against GET /problems.json.",
      });
    }
    const claims = await c.env.DB.prepare(
      "SELECT id, statement, source_seq, created_at FROM claims WHERE problem_id = ? ORDER BY source_seq ASC",
    )
      .bind(problemId)
      .all<{ id: string; statement: string; source_seq: number; created_at: string }>();
    const body = JSON.stringify(
      {
        schema: "https://a.asimposium.org/schemas/ledger.v1.json",
        problem: {
          id: problemRow.id,
          public_seq: problemRow.public_seq,
          created_at: problemRow.created_at,
        },
        claims: claims.results ?? [],
        omitted: ["dispositions, reviews, hypotheses, and citations land with W5.4/W5.8"],
      },
      null,
      2,
    );
    const etag = await strongEtag("json", body);
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": PUBLIC_CACHE_CONTROL,
      etag,
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    return new Response(c.req.method === "HEAD" ? null : body, { status: 200, headers });
  });

  app.on(["GET", "HEAD"], "/p/:id{.+\\.md$}", async (c) => {
    const problemId = c.req.param("id").slice(0, -".md".length);
    const problemRow = await c.env.DB.prepare(
      "SELECT id, public_seq, created_at FROM problems WHERE id = ?",
    )
      .bind(problemId)
      .first<{ id: string; public_seq: number; created_at: string }>();
    if (problemRow === null || problemRow === undefined) {
      return problemDocument({
        status: 404,
        code: "PROBLEM_NOT_FOUND",
        title: "No such problem",
        detail: "No public problem with this id exists.",
        fixHint: "Check the id against GET /problems.json.",
      });
    }
    const claims = await c.env.DB.prepare(
      "SELECT id, statement, source_seq FROM claims WHERE problem_id = ? ORDER BY source_seq ASC",
    )
      .bind(problemId)
      .all<{ id: string; statement: string; source_seq: number }>();
    const rows = claims.results ?? [];
    const listing =
      rows.length === 0
        ? "No public claims yet."
        : rows
            .map((claim) => `- **${claim.id}** (seq ${claim.source_seq}): ${claim.statement}`)
            .join("\n");
    const body = `# ${problemRow.id}\n\n${listing}\n\nomitted: dispositions, reviews, hypotheses, and citations land with W5.4/W5.8\n`;
    const etag = await strongEtag("markdown", body);
    const headers = {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": PUBLIC_CACHE_CONTROL,
      etag,
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    return new Response(c.req.method === "HEAD" ? null : body, { status: 200, headers });
  });

  // The agent delta read (§7.8): events after a cursor, NDJSON-style paged.
  app.on(["GET", "HEAD"], "/p/:id{.+\\.events\\.json$}", async (c) => {
    const full = c.req.param("id");
    const problemId = full.slice(0, -".events.json".length);
    const problemRow = await c.env.DB.prepare("SELECT id FROM problems WHERE id = ?")
      .bind(problemId)
      .first<{ id: string }>();
    if (problemRow === null || problemRow === undefined) {
      return problemDocument({
        status: 404,
        code: "PROBLEM_NOT_FOUND",
        title: "No such problem",
        detail: "No public problem with this id exists.",
        fixHint: "Check the id against GET /problems.json.",
      });
    }
    const sinceParam = new URL(c.req.url).searchParams.get("since");
    const since = sinceParam === null ? 0 : Number.parseInt(sinceParam, 10);
    if (!Number.isSafeInteger(since) || since < 0) {
      return problemDocument({
        status: 400,
        code: "CURSOR_INVALID",
        title: "The since parameter is not a valid cursor",
        detail: "since must be a non-negative integer event seq.",
        fixHint: "Use ?since=0 for the full public tail or a cursor from a previous page.",
      });
    }
    const events = await readEvents(c.env.DB, problemId, since, 200);
    const body = JSON.stringify(
      {
        schema: "https://a.asimposium.org/schemas/ledger.v1.json",
        problem_id: problemId,
        since,
        events: events.map((event) => ({
          id: event.eventId,
          seq: event.seq,
          type: event.type,
          object_id: event.objectId,
          created_at: event.createdAt,
        })),
        has_more: events.length === 200,
      },
      null,
      2,
    );
    const etag = await strongEtag("json", body);
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": PUBLIC_CACHE_CONTROL,
      etag,
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    return new Response(c.req.method === "HEAD" ? null : body, { status: 200, headers });
  });

  return app;
}
