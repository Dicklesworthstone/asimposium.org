import {
  ProblemFaceResponseSchema,
  type ProblemIndexEntry,
  type ProblemsIndexResponse,
  ProblemsIndexResponseSchema,
} from "@asimposium/contracts";
import { PACK_PREAMBLE, type Projection, renderProjection } from "@asimposium/render";
import { Hono } from "hono";

import type { Env } from "./env";
import { validatedProblem as problemDocument } from "./http/envelope";
import { readCursor, readEvents } from "./krater/krater";

/**
 * The first public ledger face (a W6.1 down payment): the problems index.
 * JSON is canonical; Markdown is the reading face. Rows come from the Krater
 * `problems` projection directly, so an empty ledger answers an honest empty
 * list rather than a dressed-up placeholder. `omitted[]` says what the face
 * leaves out.
 */
const OMITTED = ["titles, statements, and statuses land with the problem lifecycle (W5.1)"];

type ProblemIndexMarkdownFieldDescriptor<K extends keyof ProblemIndexEntry> = Readonly<{
  key: K;
  render: (value: ProblemIndexEntry[K]) => string;
  renderEntry: (entry: ProblemIndexEntry) => string;
}>;

function defineProblemIndexMarkdownField<K extends keyof ProblemIndexEntry>(
  key: K,
  render: (value: ProblemIndexEntry[K]) => string,
): ProblemIndexMarkdownFieldDescriptor<K> {
  return {
    key,
    render,
    renderEntry: (entry) => render(entry[key]),
  };
}

export const PROBLEM_INDEX_MARKDOWN_FIELD_DESCRIPTORS = [
  defineProblemIndexMarkdownField("id", (value) => `- \`${value}\``),
  defineProblemIndexMarkdownField("public_seq", (value) => ` — seq ${value}`),
  defineProblemIndexMarkdownField("created_at", (value) => `, opened ${value}`),
  defineProblemIndexMarkdownField("updated_at", (value) => `, updated ${value}`),
] as const;

const PROBLEM_INDEX_SELECT = `SELECT ${PROBLEM_INDEX_MARKDOWN_FIELD_DESCRIPTORS.map(
  ({ key }) => key,
).join(", ")} FROM problems ORDER BY id ASC LIMIT 201`;

function renderProblemIndexMarkdownRow(problem: ProblemIndexEntry): string {
  return PROBLEM_INDEX_MARKDOWN_FIELD_DESCRIPTORS.map(({ renderEntry }) =>
    renderEntry(problem),
  ).join("");
}

const PUBLIC_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
const PROBLEM_DIGEST_CLAIM_LIMIT = 8;

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
  // Deterministic interim order: `id ASC`. It is neither of the two tempting
  // recency proxies, because neither is honest here. `public_seq` is a
  // per-problem event cursor (DEFAULT 0), so ranking by it is volume, not
  // recency, and ties have no total order. `updated_at` is the accepted event's
  // own canonical instant: `validateKraterIngressTimestamp` forbids a future or
  // non-canonical value, but not one earlier than the row's current
  // `updated_at`, so a later accepted write can move it backward — it cannot
  // rank recency without lying. `id` is the unique primary key, so `id ASC` is a
  // total order stable across storage and query-plan changes. W9.4 replaces this
  // interim face with aggregated open-move weight.
  //
  // One row over the face limit decides whether the index is complete; when it
  // is not, omitted[] says so rather than silently truncating.
  const rows = await db.prepare(PROBLEM_INDEX_SELECT).all<ProblemIndexEntry>();
  const truncated = rows.results.length > 200;
  const omitted = truncated
    ? [...OMITTED, "results beyond the first 200 in canonical problem-id order"]
    : OMITTED;
  return ProblemsIndexResponseSchema.parse({
    problems: rows.results.slice(0, 200),
    omitted,
  });
}

const CANONICAL_PUBLIC_CURSOR = /^(?:0|[1-9][0-9]*)$/;

function parsePublicCursor(value: string | null): number | undefined {
  if (value === null) return 0;
  if (!CANONICAL_PUBLIC_CURSOR.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * W6.4 experimental source, deliberately kept outside createLedgerFaceRoutes.
 * Its response has not landed in @asimposium/contracts yet, so mounting it on
 * the public Worker would create a second, hand-written protocol surface.
 */
export function createExperimentalLedgerEventTailRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.on(["GET", "HEAD"], "/p/:id{.+\\.events\\.json$}", async (c) => {
    const full = c.req.param("id");
    const problemId = full.slice(0, -".events.json".length);
    const since = parsePublicCursor(new URL(c.req.url).searchParams.get("since"));
    if (since === undefined) {
      return problemDocument({
        status: 400,
        code: "CURSOR_INVALID",
        title: "The since parameter is not a valid cursor",
        detail: "since must be a canonical non-negative integer event seq.",
        fixHint: "Use ?since=0 for the full public tail or a cursor from a previous page.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: { path: "/p/<problem-id>/events.json?since=0" },
        },
      });
    }
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
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: { method: "GET", path: "/problems.json" },
        },
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
        : data.problems.map((problem) => renderProblemIndexMarkdownRow(problem)).join("\n");
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

  // W6.1 public problem digest faces. Both suffixes are composed from one
  // Projection and pass through @asimposium/render's shared preparation and
  // neutralization path. The JSON result is also checked against the exported
  // ledger contract before any bytes are served.

  const loadProblemFaceProjection = async (
    db: Env["DB"],
    problemId: string,
  ): Promise<Projection | null> => {
    const problemRow = await db
      .prepare("SELECT id, public_seq, created_at FROM problems WHERE id = ?")
      .bind(problemId)
      .first<{ id: string; public_seq: number; created_at: string }>();
    if (problemRow === null || problemRow === undefined) return null;
    const claims = await db
      .prepare(
        `SELECT id, statement, source_seq, created_at FROM claims
         WHERE problem_id = ? ORDER BY source_seq ASC LIMIT ${PROBLEM_DIGEST_CLAIM_LIMIT + 1}`,
      )
      .bind(problemId)
      .all<{ id: string; statement: string; source_seq: number; created_at: string }>();
    const cursor = await readCursor(db, problemId);
    const claimRows = claims.results ?? [];
    const claimsTruncated = claimRows.length > PROBLEM_DIGEST_CLAIM_LIMIT;
    return {
      schema: "asimposium.problem-face.v1",
      kind: "problem-face",
      problem: problemRow.id,
      profile: "face",
      cursor,
      title: `${problemRow.id} — public ledger face`,
      preamble: PACK_PREAMBLE,
      items: claimRows.slice(0, PROBLEM_DIGEST_CLAIM_LIMIT).map((claim) => ({
        kind: "claim",
        id: claim.id,
        scope: "ledger",
        untrusted: true,
        body: `${claim.id} (seq ${claim.source_seq}): ${claim.statement}`,
        why_included: "a public claim on this problem in ledger sequence order",
      })),
      omitted: [
        {
          reason: "w5_4_w5_8_pending",
          detail: "dispositions, reviews, hypotheses, and citations land with W5.4/W5.8",
        },
        ...(claimsTruncated
          ? [
              {
                reason: "claim_digest_limit",
                detail: `claims beyond the first ${PROBLEM_DIGEST_CLAIM_LIMIT} in ledger sequence order`,
              },
            ]
          : []),
      ],
      next_actions: [
        { method: "GET", url: `/p/${problemRow.id}.md`, why: "the human-readable face" },
        { method: "GET", url: "/problems.json", why: "the public problem index" },
      ],
      degraded: [],
    };
  };

  app.on(["GET", "HEAD"], "/p/:id{.+\\.json$}", async (c) => {
    const problemId = c.req.param("id").slice(0, -".json".length);
    const projection = await loadProblemFaceProjection(c.env.DB, problemId);
    if (projection === null) {
      return problemDocument({
        status: 404,
        code: "PROBLEM_NOT_FOUND",
        title: "No such problem",
        detail: "No public problem with this id exists.",
        fixHint: "Check the id against GET /problems.json.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: { method: "GET", path: "/problems.json" },
        },
      });
    }
    const face = renderProjection(projection, "json");
    ProblemFaceResponseSchema.parse(JSON.parse(face.body));
    const etag = await strongEtag("json", face.body);
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": PUBLIC_CACHE_CONTROL,
      etag,
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    return new Response(c.req.method === "HEAD" ? null : face.body, { status: 200, headers });
  });

  app.on(["GET", "HEAD"], "/p/:id{.+\\.md$}", async (c) => {
    const problemId = c.req.param("id").slice(0, -".md".length);
    const projection = await loadProblemFaceProjection(c.env.DB, problemId);
    if (projection === null) {
      return problemDocument({
        status: 404,
        code: "PROBLEM_NOT_FOUND",
        title: "No such problem",
        detail: "No public problem with this id exists.",
        fixHint: "Check the id against GET /problems.json.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: { method: "GET", path: "/problems.json" },
        },
      });
    }
    const face = renderProjection(projection, "md");
    const etag = await strongEtag("markdown", face.body);
    const headers = {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": PUBLIC_CACHE_CONTROL,
      etag,
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    return new Response(c.req.method === "HEAD" ? null : face.body, { status: 200, headers });
  });

  return app;
}
