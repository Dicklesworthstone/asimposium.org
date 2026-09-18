import { publicWatchPath } from "@asimposium/contracts/public-watch";

const EXPOSE = "ETag, Retry-After, X-Robots-Tag";

function eligible(request: Request): boolean {
  const url = new URL(request.url);
  return (
    publicWatchPath(`${url.pathname}${url.search}`) !== undefined &&
    !request.headers.has("authorization") &&
    !request.headers.has("cookie")
  );
}

/** Public, credentialless GET/HEAD only. This is not a general API CORS policy:
 * signed actions, bearer routes and private reads remain entirely untouched.
 * A constant wildcard avoids origin-varying cached scientific representations;
 * browsers cannot use it for credentialed requests. */
export async function publicWatchFetch(
  request: Request,
  next: () => Response | Promise<Response>,
): Promise<Response> {
  if (!eligible(request)) return next();
  if (request.method === "OPTIONS") {
    const method = request.headers.get("access-control-request-method");
    if (!request.headers.has("origin") || (method !== "GET" && method !== "HEAD")) return next();
    const names = (request.headers.get("access-control-request-headers") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    if (names.some((name) => name !== "if-none-match" && name !== "accept")) {
      return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD",
        "access-control-allow-headers": "If-None-Match, Accept",
        "access-control-max-age": "600",
        "cache-control": "public, max-age=600",
        vary: "Access-Control-Request-Method, Access-Control-Request-Headers",
      },
    });
  }
  const response = await next();
  if (
    (request.method !== "GET" && request.method !== "HEAD") ||
    response.status < 200 ||
    response.headers.has("set-cookie")
  )
    return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", EXPOSE);
  headers.delete("access-control-allow-credentials");
  // Preserve streamed bodies, cache validators and error statuses verbatim.
  // Public 404/410/429 responses must remain observable by a paused/retrying
  // browser, rather than being misreported as an opaque network failure.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
