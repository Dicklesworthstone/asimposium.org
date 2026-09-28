import type { MiddlewareHandler } from "hono";

import { faceOf } from "./face-log";

/**
 * Unsuffixed public spellings choose their representation from `Accept`
 * (/moves, /p/:id/events, /v1/hello, ...). A shared cache must key on it, or
 * it can serve a Markdown body to a JSON client. Suffixed faces (.md, .json)
 * name their representation in the path and need no Vary.
 */
export const varyOnAccept: MiddlewareHandler = async (c, next) => {
  await next();
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD") return;
  if (faceOf(new URL(c.req.url).pathname) !== "bare") return;
  const response = c.res;
  if (response.status !== 200 && response.status !== 304) return;
  const vary = response.headers.get("vary") ?? "";
  if (vary === "*" || /(^|,)\s*accept\s*(,|$)/i.test(vary)) return;
  const headers = new Headers(response.headers);
  headers.set("vary", vary.trim() === "" ? "Accept" : `${vary}, Accept`);
  // Hono's res setter copies the previous response's headers onto the new
  // one (which would restore the old Vary); clear it first.
  c.res = undefined;
  c.res = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
