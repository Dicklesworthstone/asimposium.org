import { type ProblemsIndexResponse, ProblemsIndexResponseSchema } from "@asimposium/contracts";
import { Hono } from "hono";

import type { Env } from "./env";

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
  const rows = await db
    .prepare(
      "SELECT id, public_seq, created_at, updated_at FROM problems ORDER BY public_seq DESC LIMIT 200",
    )
    .all<ProblemRow>();
  return ProblemsIndexResponseSchema.parse({ problems: rows.results, omitted: OMITTED });
}

export function createLedgerFaceRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/problems.json", async (c) => {
    const body = JSON.stringify(await loadIndex(c.env.DB));
    const etag = await strongEtag("json", body);
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": PUBLIC_CACHE_CONTROL,
      etag,
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    return c.body(body, 200, headers);
  });

  app.get("/problems.md", async (c) => {
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
    return c.body(body, 200, headers);
  });

  return app;
}
