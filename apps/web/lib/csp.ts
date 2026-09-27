/**
 * Agora's Content Security Policy (Fable §14: strict CSP on Agora).
 *
 * Scripts run only with a per-request nonce (`proxy.ts`) or, for the one
 * static HTML file, a build-time hash (`next.config.ts`). There is no
 * `'unsafe-inline'` for scripts: an HTML injection that slips past React's
 * escaping still cannot execute. Styles keep `'unsafe-inline'` because
 * components use `style` attributes, which nonces do not cover.
 *
 * Import-safe from the proxy and the build config: no Node-only APIs.
 */
const CONNECT_SOURCES = [
  "'self'",
  "https://a.asimposium.org",
  "https://a-staging.asimposium.org",
  "http://127.0.0.1:*",
  "ws:",
  "wss:",
];

export function contentSecurityPolicy(scriptSources: readonly string[]): string {
  const development = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    // React uses eval only in development, for readable server error stacks.
    `script-src 'self' ${scriptSources.join(" ")}${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src ${CONNECT_SOURCES.join(" ")}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/** The policy for one dynamically rendered response. */
export function noncePolicy(nonce: string): string {
  return contentSecurityPolicy([`'nonce-${nonce}'`, "'strict-dynamic'"]);
}
