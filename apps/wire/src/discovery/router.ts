import { AreaSlugSchema } from "@asimposium/contracts";
import { type Context, Hono } from "hono";
import type { Env } from "../env";
import { problem as problemDocument } from "../http/envelope";
import { loadAreaDetail, loadAreasIndex } from "./areas-service";
import { loadFellowCard } from "./fellow-service";
import {
  renderAreaDetailMarkdown,
  renderAreasIndexMarkdown,
  renderFellowCardMarkdown,
  renderNowStripMarkdown,
} from "./markdown";
import { loadNowStrip } from "./now-service";

const DISCOVERY_CACHE_CONTROL = "public, max-age=60, s-maxage=60, stale-while-revalidate=120";

function ifNoneMatchMatches(value: string | undefined, etag: string): boolean {
  if (value === undefined) return false;
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag || normalized === `W/${etag}`;
  });
}

async function computeStrongEtag(face: "json" | "markdown", body: string): Promise<string> {
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
): Response {
  const ifNoneMatch = c.req.header("if-none-match");
  if (ifNoneMatchMatches(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        "cache-control": DISCOVERY_CACHE_CONTROL,
        vary: "Accept, Accept-Encoding",
      },
    });
  }
  return new Response(c.req.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "content-type": contentType,
      etag,
      "cache-control": DISCOVERY_CACHE_CONTROL,
      vary: "Accept, Accept-Encoding",
    },
  });
}

export function createDiscoveryRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // 1. Areas index (/areas, /areas.json, /areas.md)
  async function handleAreas(c: Context<{ Bindings: Env }>, forceFace?: "json" | "markdown") {
    const data = await loadAreasIndex(c.env.DB);
    let targetFace = forceFace;
    if (!targetFace) {
      const accept = c.req.header("accept") ?? "";
      targetFace = accept.includes("application/json") ? "json" : "markdown";
    }

    if (targetFace === "json") {
      const body = JSON.stringify(data);
      const etag = await computeStrongEtag("json", body);
      return serveRepresentation(c, body, "application/json; charset=utf-8", etag);
    }
    const md = renderAreasIndexMarkdown(data);
    const etag = await computeStrongEtag("markdown", md);
    return serveRepresentation(c, md, "text/markdown; charset=utf-8", etag);
  }

  app.on(["GET", "HEAD"], "/areas", (c) => handleAreas(c));
  app.on(["GET", "HEAD"], "/areas.json", (c) => handleAreas(c, "json"));
  app.on(["GET", "HEAD"], "/areas.md", (c) => handleAreas(c, "markdown"));

  // 2. Area detail (/area/:slug, /area/:slug.json, /area/:slug.md)
  async function handleAreaDetail(
    c: Context<{ Bindings: Env }>,
    rawSlug: string,
    forceFace?: "json" | "markdown",
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

    let targetFace = forceFace;
    if (!targetFace) {
      const accept = c.req.header("accept") ?? "";
      targetFace = accept.includes("application/json") ? "json" : "markdown";
    }

    if (targetFace === "json") {
      const body = JSON.stringify(data);
      const etag = await computeStrongEtag("json", body);
      return serveRepresentation(c, body, "application/json; charset=utf-8", etag);
    }
    const md = renderAreaDetailMarkdown(data);
    const etag = await computeStrongEtag("markdown", md);
    return serveRepresentation(c, md, "text/markdown; charset=utf-8", etag);
  }

  app.on(["GET", "HEAD"], "/area/:slug", (c) => {
    let slug = c.req.param("slug");
    let forceFace: "json" | "markdown" | undefined;
    if (slug.endsWith(".json")) {
      slug = slug.slice(0, -".json".length);
      forceFace = "json";
    } else if (slug.endsWith(".md")) {
      slug = slug.slice(0, -".md".length);
      forceFace = "markdown";
    }
    return handleAreaDetail(c, slug, forceFace);
  });

  // 3. Now strip (/now, /now.json, /now.md)
  async function handleNow(c: Context<{ Bindings: Env }>, forceFace?: "json" | "markdown") {
    const data = await loadNowStrip(c.env.DB);
    let targetFace = forceFace;
    if (!targetFace) {
      const accept = c.req.header("accept") ?? "";
      targetFace = accept.includes("application/json") ? "json" : "markdown";
    }

    if (targetFace === "json") {
      const body = JSON.stringify(data);
      const etag = await computeStrongEtag("json", body);
      return serveRepresentation(c, body, "application/json; charset=utf-8", etag);
    }
    const md = renderNowStripMarkdown(data);
    const etag = await computeStrongEtag("markdown", md);
    return serveRepresentation(c, md, "text/markdown; charset=utf-8", etag);
  }

  app.on(["GET", "HEAD"], "/now", (c) => handleNow(c));
  app.on(["GET", "HEAD"], "/now.json", (c) => handleNow(c, "json"));
  app.on(["GET", "HEAD"], "/now.md", (c) => handleNow(c, "markdown"));

  // 4. Fellow card (/a/:name, /a/:name.json, /a/:name.md & /fellows/:id alias)
  async function handleFellow(
    c: Context<{ Bindings: Env }>,
    idOrName: string,
    forceFace?: "json" | "markdown",
  ) {
    const data = await loadFellowCard(c.env.DB, idOrName);
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

    let targetFace = forceFace;
    if (!targetFace) {
      const accept = c.req.header("accept") ?? "";
      targetFace = accept.includes("application/json") ? "json" : "markdown";
    }

    if (targetFace === "json") {
      const body = JSON.stringify(data);
      const etag = await computeStrongEtag("json", body);
      return serveRepresentation(c, body, "application/json; charset=utf-8", etag);
    }
    const md = renderFellowCardMarkdown(data);
    const etag = await computeStrongEtag("markdown", md);
    return serveRepresentation(c, md, "text/markdown; charset=utf-8", etag);
  }

  app.on(["GET", "HEAD"], "/a/:name", (c) => {
    let name = c.req.param("name");
    let forceFace: "json" | "markdown" | undefined;
    if (name.endsWith(".json")) {
      name = name.slice(0, -".json".length);
      forceFace = "json";
    } else if (name.endsWith(".md")) {
      name = name.slice(0, -".md".length);
      forceFace = "markdown";
    }
    return handleFellow(c, name, forceFace);
  });

  app.on(["GET", "HEAD"], "/fellows/:id", (c) => {
    let id = c.req.param("id");
    let forceFace: "json" | "markdown" | undefined;
    if (id.endsWith(".json")) {
      id = id.slice(0, -".json".length);
      forceFace = "json";
    } else if (id.endsWith(".md")) {
      id = id.slice(0, -".md".length);
      forceFace = "markdown";
    }
    return handleFellow(c, id, forceFace);
  });

  return app;
}
