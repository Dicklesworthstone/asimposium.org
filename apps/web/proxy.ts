import { type NextRequest, NextResponse } from "next/server";

import { noncePolicy } from "./lib/csp";

/**
 * A fresh script nonce per request (Fable §14 strict CSP). Next reads the
 * nonce from the request's policy and stamps it on its own inline scripts;
 * the root layout stamps it on the theme script. Any other inline script,
 * including one injected through content, is refused by the browser.
 */
export function proxy(request: NextRequest) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const policy = noncePolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Static assets need no policy; design.html carries a hash-pinned one
      // from next.config.ts.
      source: "/((?!_next/static|_next/image|favicon.ico|design$|design\\.html$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
