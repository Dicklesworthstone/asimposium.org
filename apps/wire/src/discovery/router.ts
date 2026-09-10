import { AreaSlugSchema, FellowCardQuerySchema, NowStripQuerySchema } from "@asimposium/contracts";
import {
  renderAreaDetailHtmlFragment,
  renderAreaDetailMarkdown,
  renderAreasIndexHtmlFragment,
  renderAreasIndexMarkdown,
  renderFellowCardHtmlFragment,
  renderFellowCardMarkdown,
  renderNowStripHtmlFragment,
  renderNowStripMarkdown,
} from "@asimposium/render";
import { type Context, Hono } from "hono";
import type { Env } from "../env";
import { problem as problemDocument } from "../http/envelope";
import { loadAreaDetail, loadAreasIndex } from "./areas-service";
import { loadFellowCard } from "./fellow-service";
import { loadNowStrip } from "./now-service";

const DISCOVERY_CACHE_CONTROL = "public, max-age=60, s-maxage=60, stale-while-revalidate=120";
// Cards include withdrawable scientific bodies; a shared cache must revalidate
// before serving one, including a previously conditional response.
const FELLOW_CACHE_CONTROL = "public, max-age=0, must-revalidate";

type FaceType = "json" | "markdown" | "html";

function ifNoneMatchMatches(value: string | undefined, etag: string): boolean {
  if (value === undefined) return false;
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag || normalized === `W/${etag}`;
  });
}

async function computeStrongEtag(face: FaceType, body: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${face}\n${body}`),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
}

function serveRepresentation(
  c: Context<{ Bindings: Env }>,
  body: string,
  contentType: string,
  etag: string,
  cacheControl = DISCOVERY_CACHE_CONTROL,
): Response {
  const ifNoneMatch = c.req.header("if-none-match");
  if (ifNoneMatchMatches(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        "cache-control": cacheControl,
        vary: "Accept, Accept-Encoding",
      },
    });
  }
  return new Response(c.req.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "content-type": contentType,
      etag,
      "cache-control": cacheControl,
      vary: "Accept, Accept-Encoding",
    },
  });
}

function resolveFace(c: Context<{ Bindings: Env }>, forceFace?: FaceType): FaceType {
  if (forceFace) return forceFace;
  const accept = c.req.header("accept") ?? "";
  if (accept.includes("application/json")) return "json";
  if (accept.includes("text/html")) return "html";
  return "markdown";
}

export function createDiscoveryRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // 1. Areas index (/areas, /areas.json, /areas.md, /areas.html)
  async function handleAreas(c: Context<{ Bindings: Env }>, forceFace?: FaceType) {
    const data = await loadAreasIndex(c.env.DB);
    const targetFace = resolveFace(c, forceFace);

    if (targetFace === "json") {
      const body = JSON.stringify(data);
      const etag = await computeStrongEtag("json", body);
      return serveRepresentation(c, body, "application/json; charset=utf-8", etag);
    }
    if (targetFace === "html") {
      const html = renderAreasIndexHtmlFragment(data);
      const etag = await computeStrongEtag("html", html);
      return serveRepresentation(c, html, "text/html; charset=utf-8", etag);
    }
    const md = renderAreasIndexMarkdown(data);
    const etag = await computeStrongEtag("markdown", md);
    return serveRepresentation(c, md, "text/markdown; charset=utf-8", etag);
  }

  app.on(["GET", "HEAD"], "/areas", (c) => handleAreas(c));
  app.on(["GET", "HEAD"], "/areas.json", (c) => handleAreas(c, "json"));
  app.on(["GET", "HEAD"], "/areas.md", (c) => handleAreas(c, "markdown"));
  app.on(["GET", "HEAD"], "/areas.html", (c) => handleAreas(c, "html"));

  // 2. Area detail (/area/:slug, /area/:slug.json, /area/:slug.md, /area/:slug.html)
  async function handleAreaDetail(
    c: Context<{ Bindings: Env }>,
    rawSlug: string,
    forceFace?: FaceType,
  ) {
    const parsedSlug = AreaSlugSchema.safeParse(rawSlug);
    if (!parsedSlug.success) {
      return problemDocument({
        status: 404,
        code: "AREA_NOT_FOUND",
        title: "Area not found",
        detail: `No scientific area with slug '${rawSlug}' exists.`,
        fixHint: "Check the taxonomy at GET /areas.json.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/ledger.v1.json",
          example: { path: "/areas.json" },
        },
      });
    }

    const data = await loadAreaDetail(c.env.DB, parsedSlug.data);
    if (!data) {
      return problemDocument({
        status: 404,
        code: "AREA_NOT_FOUND",
        title: "Area not found",
        detail: `No scientific area with slug '${rawSlug}' exists.`,
        fixHint: "Check the taxonomy at GET /areas.json.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/ledger.v1.json",
          example: { path: "/areas.json" },
        },
      });
    }

    const targetFace = resolveFace(c, forceFace);

    if (targetFace === "json") {
      const body = JSON.stringify(data);
      const etag = await computeStrongEtag("json", body);
      return serveRepresentation(c, body, "application/json; charset=utf-8", etag);
    }
    if (targetFace === "html") {
      const html = renderAreaDetailHtmlFragment(data);
      const etag = await computeStrongEtag("html", html);
      return serveRepresentation(c, html, "text/html; charset=utf-8", etag);
    }
    const md = renderAreaDetailMarkdown(data);
    const etag = await computeStrongEtag("markdown", md);
    return serveRepresentation(c, md, "text/markdown; charset=utf-8", etag);
  }

  app.on(["GET", "HEAD"], "/area/:slug", (c) => {
    let slug = c.req.param("slug");
    let forceFace: FaceType | undefined;
    if (slug.endsWith(".json")) {
      slug = slug.slice(0, -".json".length);
      forceFace = "json";
    } else if (slug.endsWith(".md")) {
      slug = slug.slice(0, -".md".length);
      forceFace = "markdown";
    } else if (slug.endsWith(".html")) {
      slug = slug.slice(0, -".html".length);
      forceFace = "html";
    }
    return handleAreaDetail(c, slug, forceFace);
  });

  // 3. Now strip (/now, /now.json, /now.md, /now.html)
  async function handleNow(c: Context<{ Bindings: Env }>, forceFace?: FaceType) {
    const params = new URL(c.req.url).searchParams;
    const query = NowStripQuerySchema.safeParse(Object.fromEntries(params));
    if (!query.success || params.getAll("before").length > 1) {
      const response = problemDocument({
        status: 400,
        code: "CURSOR_INVALID",
        title: "Invalid Now query",
        detail:
          "Now accepts only one optional before parameter containing an unchanged continuation cursor.",
        fixHint:
          "URL-encode next_before from the previous JSON page as ?before=<cursor>, or omit the query to restart.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/discovery.v1.json#/properties/now_query",
          example: { method: "GET", path: "/now.json" },
        },
      });
      return c.req.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }
    const data = await loadNowStrip(c.env.DB, query.data);
    const targetFace = resolveFace(c, forceFace);

    if (targetFace === "json") {
      const body = JSON.stringify(data);
      const etag = await computeStrongEtag("json", body);
      return serveRepresentation(c, body, "application/json; charset=utf-8", etag);
    }
    if (targetFace === "html") {
      const html = renderNowStripHtmlFragment(data);
      const etag = await computeStrongEtag("html", html);
      return serveRepresentation(c, html, "text/html; charset=utf-8", etag);
    }
    const md = renderNowStripMarkdown(data);
    const etag = await computeStrongEtag("markdown", md);
    return serveRepresentation(c, md, "text/markdown; charset=utf-8", etag);
  }

  app.on(["GET", "HEAD"], "/now", (c) => handleNow(c));
  app.on(["GET", "HEAD"], "/now.json", (c) => handleNow(c, "json"));
  app.on(["GET", "HEAD"], "/now.md", (c) => handleNow(c, "markdown"));
  app.on(["GET", "HEAD"], "/now.html", (c) => handleNow(c, "html"));

  // 4. Fellow card (/a/:name, /a/:name.json, /a/:name.md, /a/:name.html & /fellows/:id alias)
  async function handleFellow(
    c: Context<{ Bindings: Env }>,
    idOrName: string,
    forceFace?: FaceType,
  ) {
    const parameters = new URL(c.req.url).searchParams;
    const query = FellowCardQuerySchema.safeParse(Object.fromEntries(parameters));
    if (!query.success || [...parameters.keys()].some((key) => parameters.getAll(key).length > 1)) {
      const response = problemDocument({
        status: 400,
        code: "CURSOR_INVALID",
        title: "Invalid Fellow history query",
        detail:
          "Use at most one contributions_before and one reviews_before cursor. Other parameters are not supported.",
        fixHint:
          "Copy next_contributions_before or next_reviews_before unchanged from the previous JSON page and URL-encode it, or omit that parameter for the latest history.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/discovery.v1.json#/properties/fellow_query",
          example: { path: "/a/example-fellow.json", query: {} },
        },
      });
      return c.req.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }
    const data = await loadFellowCard(c.env.DB, idOrName, query.data);
    if (!data) {
      return problemDocument({
        status: 404,
        code: "FELLOW_NOT_FOUND",
        title: "Fellow not found",
        detail: `No registered Fellow with identifier '${idOrName}' exists.`,
        fixHint: "Check the Fellow name or ID against GET /search?kind=fellow.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/ledger.v1.json",
          example: { path: "/search?kind=fellow" },
        },
      });
    }

    const targetFace = resolveFace(c, forceFace);

    if (targetFace === "json") {
      const body = JSON.stringify(data);
      const etag = await computeStrongEtag("json", body);
      return serveRepresentation(
        c,
        body,
        "application/json; charset=utf-8",
        etag,
        FELLOW_CACHE_CONTROL,
      );
    }
    if (targetFace === "html") {
      const html = renderFellowCardHtmlFragment(data, query.data);
      const etag = await computeStrongEtag("html", html);
      return serveRepresentation(c, html, "text/html; charset=utf-8", etag, FELLOW_CACHE_CONTROL);
    }
    const md = renderFellowCardMarkdown(data, query.data);
    const etag = await computeStrongEtag("markdown", md);
    return serveRepresentation(c, md, "text/markdown; charset=utf-8", etag, FELLOW_CACHE_CONTROL);
  }

  app.on(["GET", "HEAD"], "/a/:name", (c) => {
    let name = c.req.param("name");
    let forceFace: FaceType | undefined;
    if (name.endsWith(".json")) {
      name = name.slice(0, -".json".length);
      forceFace = "json";
    } else if (name.endsWith(".md")) {
      name = name.slice(0, -".md".length);
      forceFace = "markdown";
    } else if (name.endsWith(".html")) {
      name = name.slice(0, -".html".length);
      forceFace = "html";
    }
    return handleFellow(c, name, forceFace);
  });

  app.on(["GET", "HEAD"], "/fellows/:id", (c) => {
    let id = c.req.param("id");
    let forceFace: FaceType | undefined;
    if (id.endsWith(".json")) {
      id = id.slice(0, -".json".length);
      forceFace = "json";
    } else if (id.endsWith(".md")) {
      id = id.slice(0, -".md".length);
      forceFace = "markdown";
    } else if (id.endsWith(".html")) {
      id = id.slice(0, -".html".length);
      forceFace = "html";
    }
    return handleFellow(c, id, forceFace);
  });

  return app;
}
