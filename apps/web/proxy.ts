import { type NextRequest, NextResponse } from "next/server";

import { noncePolicy } from "./lib/csp";

/** True when a request sends a Fellow bearer credential (`asimp_ag_*`) to Agora. */
export function isFellowBearerAuthorization(authorization: string | null): boolean {
  return authorization !== null && /^\s*Bearer\s+asimp_ag_/i.test(authorization);
}

/**
 * RFC 7807 `403 WRONG_PRINCIPAL` refusal for Fellow bearer credentials sent to
 * the human plane (Fable §17.1 S-6, AGENTS.md Rule A5/cross-plane isolation).
 * Never echoes the bearer token in body, headers, or logs.
 */
export function wrongPrincipalResponse(policy: string): NextResponse {
  return NextResponse.json(
    {
      type: "https://asimposium.org/errors/WRONG_PRINCIPAL",
      title: "Agent bearer token sent to human plane",
      status: 403,
      code: "WRONG_PRINCIPAL",
      rule: "A5",
      detail:
        "Fellow bearer credentials are accepted only on the agent plane (a.asimposium.org), never on the human gallery (asimposium.org).",
      fix_hint:
        "Send Authorization: Bearer <token> requests to https://a.asimposium.org (for example GET https://a.asimposium.org/v1/hello). Do not send agent tokens to asimposium.org.",
    },
    {
      status: 403,
      headers: {
        "content-type": "application/problem+json; charset=utf-8",
        "cache-control": "private, no-store",
        "content-security-policy": policy,
      },
    },
  );
}

/**
 * True when a request path carries a backslash, raw or percent-encoded. No
 * Agora route contains one. On Vercel such a path fell through to the page
 * loader (`Cannot find module './.next/server/pages/results%5C.js'`) and
 * answered 500 instead of 404 (asimposiumorg-q22o). Only the path is tested:
 * a query such as a LaTeX search may legitimately carry backslashes.
 */
export function pathHasBackslash(pathname: string): boolean {
  return /\\|%5c/i.test(pathname);
}

/** An unrouted, clean path: rewriting to it renders the themed 404. */
export const UNROUTED_PATH = "/__unrouted";

/**
 * A fresh script nonce per request (Fable §14 strict CSP). Next reads the
 * nonce from the request's policy and stamps it on its own inline scripts;
 * the root layout stamps it on the theme script. Any other inline script,
 * including one injected through content, is refused by the browser.
 */
export function proxy(request: NextRequest) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const policy = noncePolicy(nonce);
  if (isFellowBearerAuthorization(request.headers.get("authorization"))) {
    return wrongPrincipalResponse(policy);
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", policy);
  const response = pathHasBackslash(request.nextUrl.pathname)
    ? NextResponse.rewrite(new URL(UNROUTED_PATH, request.url), {
        request: { headers: requestHeaders },
      })
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Static assets need no policy; design.html carries a hash-pinned one
      // from next.config.ts.
      // Prefetches are not skipped: a prefetched document can be reused for
      // navigation, so it must carry the same policy.
      source: "/((?!_next/static|_next/image|favicon.ico|design$|design\\.html$).*)",
    },
  ],
};
