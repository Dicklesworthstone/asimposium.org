import {
  ProblemFaceResponseSchema,
  type ProblemIndexEntry,
  type ProblemsIndexResponse,
  ProblemsIndexResponseSchema,
  PublicLedgerProblemIdSchema,
} from "@asimposium/contracts";
import {
  type ComposedPack,
  composePack,
  type Projection,
  type RenderedFace,
  renderProjection,
} from "@asimposium/render";
import { Hono } from "hono";

import type { Env } from "./env";
import { validatedProblem as problemDocument } from "./http/envelope";
import { readEvents } from "./krater/krater";

/**
 * Public ledger read faces. JSON is canonical; Markdown is the reading face.
 * Rows come from Krater's public projections directly, so an empty ledger
 * answers honestly and every bounded digest declares what it omitted.
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
const PROBLEM_DIGEST_CANDIDATE_LIMIT = 200;
const PROBLEM_DIGEST_TOKEN_BUDGET = 4_000;
const PROBLEM_DIGEST_SELECT = `SELECT
  p.id AS problem_id,
  p.public_seq AS public_seq,
  c.id AS claim_id,
  c.statement AS statement,
  c.source_seq AS source_seq
FROM problems p
LEFT JOIN claims c
  ON c.problem_id = p.id
 AND c.source_seq <= p.public_seq
WHERE p.id = ?
ORDER BY c.source_seq ASC, c.id ASC
LIMIT ${PROBLEM_DIGEST_CANDIDATE_LIMIT + 1}`;

interface ProblemDigestRow {
  readonly problem_id: string;
  readonly public_seq: number;
  readonly claim_id: string | null;
  readonly statement: string | null;
  readonly source_seq: number | null;
}

interface ProblemFaceFaces {
  readonly json: RenderedFace;
  readonly markdown: RenderedFace;
}

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

function problemFaceProjection(
  composed: ComposedPack,
  itemCount: number,
  forceBudgetOmission: boolean,
): Projection {
  const omitted =
    forceBudgetOmission && !composed.omitted.some((entry) => entry.reason === "budget_exceeded")
      ? [...composed.omitted, { reason: "budget_exceeded" }].sort((left, right) =>
          left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0,
        )
      : composed.omitted;
  return {
    schema: "asimposium.problem-face.v1",
    kind: "problem-face",
    problem: composed.problem,
    profile: "face",
    cursor: composed.cursor,
    title: `${composed.problem} — public ledger digest`,
    preamble: composed.preamble,
    items: composed.items.slice(0, itemCount).map((item) => ({
      kind: item.kind,
      id: item.id,
      scope: item.scope,
      untrusted: item.untrusted,
      body: item.body,
      why_included: item.why_included,
    })),
    omitted,
    next_actions: composed.next_actions,
    degraded: composed.degraded,
  };
}

function renderProblemFacePair(projection: Projection): ProblemFaceFaces {
  return {
    json: renderProjection(projection, "json"),
    markdown: renderProjection(projection, "md"),
  };
}

function facesFitDigestBudget(faces: ProblemFaceFaces): boolean {
  return (
    Math.ceil(Math.max(faces.json.bytes, faces.markdown.bytes) / 4) <= PROBLEM_DIGEST_TOKEN_BUDGET
  );
}

/**
 * composePack gives us its validated, stable-prefix O(n) selector. The served
 * problem projection has a different envelope and Markdown can be larger than
 * JSON, so measure the actual pair and use a logarithmic tail drop if needed.
 */
function renderBudgetedProblemFace(composed: ComposedPack): ProblemFaceFaces {
  const initial = renderProblemFacePair(
    problemFaceProjection(composed, composed.items.length, false),
  );
  if (facesFitDigestBudget(initial)) return initial;

  let low = 0;
  let high = composed.items.length - 1;
  let best: ProblemFaceFaces | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = renderProblemFacePair(problemFaceProjection(composed, middle, true));
    if (facesFitDigestBudget(candidate)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best === undefined) {
    throw new Error("the mandatory problem-face envelope exceeds its public digest budget");
  }
  return best;
}

async function loadProblemFace(
  db: Env["DB"],
  requestedProblemId: string,
): Promise<ProblemFaceFaces | null> {
  if (!PublicLedgerProblemIdSchema.safeParse(requestedProblemId).success) return null;
  const query = await db
    .prepare(PROBLEM_DIGEST_SELECT)
    .bind(requestedProblemId)
    .all<ProblemDigestRow>();
  const rows = query.results ?? [];
  if (rows.length === 0) return null;
  if (rows.length > PROBLEM_DIGEST_CANDIDATE_LIMIT + 1) {
    throw new Error("the problem digest query exceeded its declared candidate bound");
  }

  const first = rows[0];
  if (first === undefined) return null;
  if (
    first.problem_id !== requestedProblemId ||
    !PublicLedgerProblemIdSchema.safeParse(first.problem_id).success ||
    !Number.isSafeInteger(first.public_seq) ||
    first.public_seq < 0
  ) {
    throw new Error("the problem digest snapshot returned invalid problem metadata");
  }

  const claims: Array<{ readonly id: string; readonly statement: string; readonly seq: number }> =
    [];
  for (const row of rows) {
    if (row.problem_id !== first.problem_id || row.public_seq !== first.public_seq) {
      throw new Error("the problem digest snapshot mixed problem heads");
    }
    const { claim_id: claimId, statement, source_seq: sourceSeq } = row;
    const nullFields = [claimId, statement, sourceSeq].filter((value) => value === null).length;
    if (nullFields === 3) {
      if (rows.length !== 1) throw new Error("the problem digest mixed an empty row with claims");
      continue;
    }
    if (
      nullFields !== 0 ||
      typeof claimId !== "string" ||
      typeof statement !== "string" ||
      !Number.isSafeInteger(sourceSeq) ||
      sourceSeq === null ||
      sourceSeq < 1 ||
      sourceSeq > first.public_seq
    ) {
      throw new Error("the problem digest snapshot returned an invalid or future claim row");
    }
    claims.push({ id: claimId, statement, seq: sourceSeq });
  }

  const candidateTruncated = claims.length > PROBLEM_DIGEST_CANDIDATE_LIMIT;
  const composed = composePack({
    schema: "asimposium.problem-face.v1",
    session: "PUBLIC-FACE",
    problem: first.problem_id,
    profile: "face",
    cursor: first.public_seq,
    requested_max_tokens: PROBLEM_DIGEST_TOKEN_BUDGET,
    viewer: { audience: "public", membership: "none", effective_permissions: [] },
    candidates: claims.slice(0, PROBLEM_DIGEST_CANDIDATE_LIMIT).map((claim) => ({
      kind: "claim",
      id: claim.id,
      scope: "ledger",
      tokens: 1,
      untrusted: true,
      body: `${claim.id} (seq ${claim.seq}): ${claim.statement}`,
      why_included: "a public claim on this problem in ledger sequence order",
      stable_prefix: claim.seq,
    })),
    action_candidates: [
      {
        method: "GET",
        url: `/p/${first.problem_id}.md`,
        why: "the canonical readable Markdown face",
        public_read: true,
      },
      {
        method: "GET",
        url: "/problems.json",
        why: "the public problem index",
        public_read: true,
      },
    ],
    omitted: [
      {
        reason: "digest_fields",
        detail:
          "This digest omits claim kind, falsifier, attribution, version history, disposition, dependencies, evidence, reviews, citations, hypotheses, gaps, conflicts, dead ends, and relation details.",
      },
      ...(candidateTruncated
        ? [
            {
              reason: "candidate_limit",
              detail: `Claims beyond the first ${PROBLEM_DIGEST_CANDIDATE_LIMIT} in ledger sequence order were not considered for this digest.`,
            },
          ]
        : []),
    ],
    degraded: [],
  });
  const faces = renderBudgetedProblemFace(composed);
  ProblemFaceResponseSchema.parse(JSON.parse(faces.json.body));
  return faces;
}

function problemNotFound(method: string): Response {
  const response = problemDocument({
    status: 404,
    code: "PROBLEM_NOT_FOUND",
    title: "No such problem",
    detail: "No public problem with this id exists.",
    fixHint: "Check the id against GET /problems.json.",
    rule: "A5",
    extensions: {
      schema: "https://a.asimposium.org/schemas/ledger.v1.json",
      example: { method: "GET", path: "/problems.json" },
    },
  });
  return method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
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

  app.on(["GET", "HEAD"], "/p/:id/events.json", async (c) => {
    const problemId = c.req.param("id");
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

  app.on(["GET", "HEAD"], "/p/:id{.+\\.json$}", async (c) => {
    const problemId = c.req.param("id").slice(0, -".json".length);
    const faces = await loadProblemFace(c.env.DB, problemId);
    if (faces === null) return problemNotFound(c.req.method);
    const etag = await strongEtag("json", faces.json.body);
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": PUBLIC_CACHE_CONTROL,
      etag,
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    return new Response(c.req.method === "HEAD" ? null : faces.json.body, {
      status: 200,
      headers,
    });
  });

  app.on(["GET", "HEAD"], "/p/:id{.+\\.md$}", async (c) => {
    const problemId = c.req.param("id").slice(0, -".md".length);
    const faces = await loadProblemFace(c.env.DB, problemId);
    if (faces === null) return problemNotFound(c.req.method);
    const etag = await strongEtag("markdown", faces.markdown.body);
    const headers = {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": PUBLIC_CACHE_CONTROL,
      etag,
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    return new Response(c.req.method === "HEAD" ? null : faces.markdown.body, {
      status: 200,
      headers,
    });
  });

  return app;
}
