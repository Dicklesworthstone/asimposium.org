import { SearchQueryRequestSchema } from "@asimposium/contracts";
import { type Context, Hono } from "hono";
import type { Env } from "../env";
import { validatedProblem as problemDocument } from "../http/envelope";
import { renderSearchMarkdown } from "./markdown";
import { executeSearch } from "./service";

const PUBLIC_SEARCH_CACHE_CONTROL = "public, max-age=30, s-maxage=60, stale-while-revalidate=120";

function ifNoneMatchMatches(value: string | undefined, etag: string): boolean {
  if (value === undefined) return false;
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag || normalized === `W/${etag}`;
  });
}

async function searchStrongEtag(face: "json" | "markdown", body: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${face}\n${body}`),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
}

export function createSearchRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  async function handleSearch(
    c: Context<{ Bindings: Env }>,
    forcedFace?: "json" | "markdown",
  ): Promise<Response> {
    const url = new URL(c.req.url);
    const rawQ = url.searchParams.get("q");
    const rawKind = url.searchParams.get("kind");
    const rawLimit = url.searchParams.get("limit");
    const rawCursor = url.searchParams.get("cursor");

    const parseResult = SearchQueryRequestSchema.safeParse({
      q: rawQ ?? "",
      kind: rawKind ?? undefined,
      limit: rawLimit ?? undefined,
      cursor: rawCursor ?? undefined,
    });

    if (!parseResult.success) {
      const issue = parseResult.error.issues[0];
      const detail = issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid search query";
      return problemDocument({
        status: 400,
        code: "SCHEMA_INVALID",
        title: "Search query is invalid",
        detail,
        fixHint: "Provide a valid non-empty query, e.g. GET /search?q=riemann",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/ledger.v1.json",
          example: { path: "/search?q=riemann" },
        },
      });
    }

    const query = parseResult.data;
    const searchResponse = await executeSearch(c.env.DB, query);

    // Determine target face: forced or negotiated
    let targetFace: "json" | "markdown" = forcedFace ?? "markdown";
    if (forcedFace === undefined) {
      const accept = c.req.header("accept") ?? "";
      const format = url.searchParams.get("format");
      if (format === "json" || (!format && accept.includes("application/json"))) {
        targetFace = "json";
      }
    }

    const ifNoneMatch = c.req.header("if-none-match");

    if (targetFace === "json") {
      const jsonBody = JSON.stringify(searchResponse);
      const etag = await searchStrongEtag("json", jsonBody);
      if (ifNoneMatchMatches(ifNoneMatch, etag)) {
        return new Response(null, {
          status: 304,
          headers: {
            etag,
            "cache-control": PUBLIC_SEARCH_CACHE_CONTROL,
            vary: "Accept, Accept-Encoding",
          },
        });
      }
      return new Response(c.req.method === "HEAD" ? null : jsonBody, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          etag,
          "cache-control": PUBLIC_SEARCH_CACHE_CONTROL,
          vary: "Accept, Accept-Encoding",
        },
      });
    }

    // Markdown face (canonical Diptych)
    const markdownBody = renderSearchMarkdown(searchResponse);
    const etag = await searchStrongEtag("markdown", markdownBody);
    if (ifNoneMatchMatches(ifNoneMatch, etag)) {
      return new Response(null, {
        status: 304,
        headers: {
          etag,
          "cache-control": PUBLIC_SEARCH_CACHE_CONTROL,
          vary: "Accept, Accept-Encoding",
        },
      });
    }
    return new Response(c.req.method === "HEAD" ? null : markdownBody, {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        etag,
        "cache-control": PUBLIC_SEARCH_CACHE_CONTROL,
        vary: "Accept, Accept-Encoding",
      },
    });
  }

  app.on(["GET", "HEAD"], "/search", async (c) => handleSearch(c));
  app.on(["GET", "HEAD"], "/search.json", async (c) => handleSearch(c, "json"));
  app.on(["GET", "HEAD"], "/search.md", async (c) => handleSearch(c, "markdown"));

  return app;
}
