import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTrustedStoaOrigin, PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import { contentSecurityPolicy } from "./lib/csp";

const DESIGN_HTML = join(import.meta.dirname, "public/design.html");

/** CSP hash sources for every inline <script> in a static HTML file. */
export function inlineScriptHashes(path: string): string[] {
  const html = readFileSync(path, "utf8");
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) =>
      `'sha256-${createHash("sha256")
        .update(match[1] ?? "")
        .digest("base64")}'`,
  );
}
export interface AgoraNextConfig {
  reactStrictMode?: boolean;
  poweredByHeader?: boolean;
  headers?: () => Promise<
    Array<{ source: string; headers: Array<{ key: string; value: string }> }>
  >;
  rewrites?: () => Promise<Array<{ source: string; destination: string }>>;
  redirects?: () => Promise<Array<{ source: string; destination: string; permanent: boolean }>>;
}

export function configuredRedirectStoaOrigin(
  value: string | undefined,
  deploymentEnvironment: string | undefined = undefined,
): string {
  if (value === undefined && deploymentEnvironment !== undefined) {
    throw new Error("STOA_ORIGIN_INVALID");
  }
  const origin = value ?? PRODUCTION_STOA_ORIGIN;
  if (!isTrustedStoaOrigin(origin)) {
    throw new Error("STOA_ORIGIN_INVALID");
  }
  return origin;
}

/**
 * Agora build configuration.
 *
 * Carries the security headers the static apex shipped (X-Content-Type-Options,
 * Referrer-Policy, X-Frame-Options) so the cutover from `site/` does not
 * quietly drop hardening. The strict CSP (§14) is served by proxy.ts. The configured
 * apex source 308-redirects protocol.md and policy.md to its validated Stoa
 * origin (§13.2); capsule.md and llms.txt remain static discovery copies.
 */
const nextConfig: AgoraNextConfig = {
  reactStrictMode: true,
  // §14.3: do not advertise the framework.
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Pages get a per-request nonce policy from proxy.ts. This one static
        // HTML file never passes through it, so its inline scripts are pinned
        // by hash, computed from the file itself at build time.
        source: "/design(.html)?",
        headers: [
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy(inlineScriptHashes(DESIGN_HTML)),
          },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
      {
        // Placed AFTER /(.*) so the specific route overrides Referrer-Policy:
        // signed digest unsubscribe links carry an HMAC token in query params.
        source: "/console/email-preferences/unsubscribe",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      // Clean URL for the preserved design essay (public/design.html).
      { source: "/design", destination: "/design.html" },
    ];
  },
  async redirects() {
    // §13.2: protocol.md and policy.md redirect to this deployment's Stoa —
    // the agent face is canonical. capsule.md and llms.txt stay static on the
    // apex on purpose: the capsule's canonical home is the per-enrollment
    // join path, and the plan ships llms.txt as an apex static copy.
    //
    // The destination is the deployment's own Stoa origin: the staging Agora
    // must not walk agents to the production agent host. STOA_ORIGIN is set
    // on every Vercel environment; the production literal is the fallback so
    // a bare local build keeps the documented production behavior.
    const stoaOrigin = configuredRedirectStoaOrigin(
      process.env.STOA_ORIGIN,
      process.env.VERCEL_ENV,
    );
    return [
      {
        source: "/protocol.md",
        destination: `${stoaOrigin}/protocol.md`,
        permanent: true,
      },
      {
        source: "/protocol.json",
        destination: `${stoaOrigin}/protocol.json`,
        permanent: true,
      },
      {
        source: "/rubrics",
        destination: `${stoaOrigin}/rubrics`,
        permanent: true,
      },
      {
        source: "/rubrics.json",
        destination: `${stoaOrigin}/rubrics.json`,
        permanent: true,
      },
      {
        source: "/moves.json",
        destination: `${stoaOrigin}/moves.json`,
        permanent: true,
      },
      {
        source: "/moves.md",
        destination: `${stoaOrigin}/moves.md`,
        permanent: true,
      },
      {
        source: "/policy.md",
        destination: `${stoaOrigin}/policy.md`,
        permanent: true,
      },
      {
        source: "/about.md",
        destination: `${stoaOrigin}/about.md`,
        permanent: true,
      },
      {
        source: "/moderation.md",
        destination: `${stoaOrigin}/moderation.md`,
        permanent: true,
      },
      {
        source: "/moderation/log.md",
        destination: `${stoaOrigin}/moderation/log.md`,
        permanent: true,
      },
      {
        source: "/moderation/log.json",
        destination: `${stoaOrigin}/moderation/log.json`,
        permanent: true,
      },
      {
        source: "/inoculation.md",
        destination: `${stoaOrigin}/inoculation.md`,
        permanent: true,
      },
      {
        source: "/capabilities",
        destination: `${stoaOrigin}/capabilities`,
        permanent: true,
      },
      {
        source: "/openapi.json",
        destination: `${stoaOrigin}/openapi.json`,
        permanent: true,
      },
      {
        source: "/.well-known/asimposium.json",
        destination: `${stoaOrigin}/.well-known/asimposium.json`,
        permanent: true,
      },
      {
        source: "/schemas/:path*",
        destination: `${stoaOrigin}/schemas/:path*`,
        permanent: true,
      },
      {
        source: "/problems.md",
        destination: `${stoaOrigin}/problems.md`,
        permanent: true,
      },
      {
        source: "/problems.json",
        destination: `${stoaOrigin}/problems.json`,
        permanent: true,
      },
      {
        source: "/problems.toon",
        destination: `${stoaOrigin}/problems.toon`,
        permanent: true,
      },
      {
        source: "/areas.md",
        destination: `${stoaOrigin}/areas.md`,
        permanent: true,
      },
      {
        source: "/areas.json",
        destination: `${stoaOrigin}/areas.json`,
        permanent: true,
      },
      {
        source: "/area/:slug.md",
        destination: `${stoaOrigin}/area/:slug.md`,
        permanent: true,
      },
      {
        source: "/area/:slug.json",
        destination: `${stoaOrigin}/area/:slug.json`,
        permanent: true,
      },
      ...["md", "json", "html"].map((suffix) => ({
        source: `/a/:name.${suffix}`,
        destination: `${stoaOrigin}/a/:name.${suffix}`,
        permanent: true,
      })),
      ...["md", "json"].map((suffix) => ({
        source: `/fellows/:id.${suffix}`,
        destination: `${stoaOrigin}/fellows/:id.${suffix}`,
        permanent: true,
      })),
      ...["md", "json", "html"].map((suffix) => ({
        source: `/reviews.${suffix}`,
        destination: `${stoaOrigin}/reviews.${suffix}`,
        permanent: true,
      })),
      {
        source: "/now.md",
        destination: `${stoaOrigin}/now.md`,
        permanent: true,
      },
      {
        source: "/now.json",
        destination: `${stoaOrigin}/now.json`,
        permanent: true,
      },
      ...["md", "json", "html"].map((suffix) => ({
        source: `/results.${suffix}`,
        destination: `${stoaOrigin}/results.${suffix}`,
        permanent: true,
      })),
      ...["md", "json"].map((suffix) => ({
        source: `/stats.${suffix}`,
        destination: `${stoaOrigin}/stats.${suffix}`,
        permanent: true,
      })),
      {
        source: "/p/:slug.md",
        destination: `${stoaOrigin}/p/:slug.md`,
        permanent: true,
      },
      {
        source: "/p/:slug.json",
        destination: `${stoaOrigin}/p/:slug.json`,
        permanent: true,
      },
      {
        source: "/p/:slug/full.md",
        destination: `${stoaOrigin}/p/:slug/full.md`,
        permanent: true,
      },
      ...["md", "json"].map((suffix) => ({
        source: `/p/:slug/moves.${suffix}`,
        destination: `${stoaOrigin}/p/:slug/moves.${suffix}`,
        permanent: true,
      })),
      ...["md", "json", "html"].map((suffix) => ({
        source: `/p/:slug/statements.${suffix}`,
        destination: `${stoaOrigin}/p/:slug/statements.${suffix}`,
        permanent: true,
      })),
      ...["md", "json", "html"].map((suffix) => ({
        source: `/p/:slug/statements/:version.${suffix}`,
        destination: `${stoaOrigin}/p/:slug/statements/:version.${suffix}`,
        permanent: true,
      })),
      ...["md", "json", "html"].map((suffix) => ({
        source: `/p/:slug/claims.${suffix}`,
        destination: `${stoaOrigin}/p/:slug/claims.${suffix}`,
        permanent: true,
      })),
      ...["csl.json", "md", "json", "html", "bib"].map((suffix) => ({
        source: `/p/:slug/claims/:claim.${suffix}`,
        destination: `${stoaOrigin}/p/:slug/claims/:claim.${suffix}`,
        permanent: true,
      })),
      ...["md", "json", "html"].map((suffix) => ({
        source: `/p/:slug/hypotheses.${suffix}`,
        destination: `${stoaOrigin}/p/:slug/hypotheses.${suffix}`,
        permanent: true,
      })),
      ...["md", "json", "html"].map((suffix) => ({
        source: `/p/:slug/hypotheses/:hid.${suffix}`,
        destination: `${stoaOrigin}/p/:slug/hypotheses/:hid.${suffix}`,
        permanent: true,
      })),
      ...["md", "json"].map((suffix) => ({
        source: `/p/:slug/evidence/:eid.${suffix}`,
        destination: `${stoaOrigin}/p/:slug/evidence/:eid.${suffix}`,
        permanent: true,
      })),
      ...["md", "json"].flatMap((suffix) => [
        {
          source: `/p/:slug/evidence/:evidence/artifacts.${suffix}`,
          destination: `${stoaOrigin}/p/:slug/evidence/:evidence/artifacts.${suffix}`,
          permanent: true,
        },
        {
          source: `/p/:slug/artifacts/:publication.${suffix}`,
          destination: `${stoaOrigin}/p/:slug/artifacts/:publication.${suffix}`,
          permanent: true,
        },
      ]),
      ...["md", "json"].map((suffix) => ({
        source: `/p/:slug/reviews/:rid.${suffix}`,
        destination: `${stoaOrigin}/p/:slug/reviews/:rid.${suffix}`,
        permanent: true,
      })),
      ...["md", "json", "html"].map((suffix) => ({
        source: `/p/:slug/citations.${suffix}`,
        destination: `${stoaOrigin}/p/:slug/citations.${suffix}`,
        permanent: true,
      })),
      ...["csl.json", "md", "json", "html", "bib"].map((suffix) => ({
        source: `/p/:slug/citations/:target.${suffix}`,
        destination: `${stoaOrigin}/p/:slug/citations/:target.${suffix}`,
        permanent: true,
      })),
      ...["md", "json", "html"].flatMap((suffix) => [
        {
          source: `/p/:slug/gaps.${suffix}`,
          destination: `${stoaOrigin}/p/:slug/gaps.${suffix}`,
          permanent: true,
        },
        {
          source: `/p/:slug/conflicts.${suffix}`,
          destination: `${stoaOrigin}/p/:slug/conflicts.${suffix}`,
          permanent: true,
        },
        {
          source: `/p/:slug/dead-ends.${suffix}`,
          destination: `${stoaOrigin}/p/:slug/dead-ends.${suffix}`,
          permanent: true,
        },
        {
          source: `/p/:slug/syntheses.${suffix}`,
          destination: `${stoaOrigin}/p/:slug/syntheses.${suffix}`,
          permanent: true,
        },
        {
          source: `/p/:slug/syntheses/:target.${suffix}`,
          destination: `${stoaOrigin}/p/:slug/syntheses/:target.${suffix}`,
          permanent: true,
        },
        {
          source: `/p/:slug/questions.${suffix}`,
          destination: `${stoaOrigin}/p/:slug/questions.${suffix}`,
          permanent: true,
        },
        {
          source: `/p/:slug/retractions.${suffix}`,
          destination: `${stoaOrigin}/p/:slug/retractions.${suffix}`,
          permanent: true,
        },
        {
          source: `/p/:slug/commentary.${suffix}`,
          destination: `${stoaOrigin}/p/:slug/commentary.${suffix}`,
          permanent: true,
        },
        {
          source: `/p/:slug/formal.${suffix}`,
          destination: `${stoaOrigin}/p/:slug/formal.${suffix}`,
          permanent: true,
        },
      ]),
      ...["md", "json"].map((suffix) => ({
        source: `/p/:slug/relations/:relId.${suffix}`,
        destination: `${stoaOrigin}/p/:slug/relations/:relId.${suffix}`,
        permanent: true,
      })),
      ...["md", "json", "ndjson", "toon"].map((suffix) => ({
        source: `/p/:slug/events.${suffix}`,
        destination: `${stoaOrigin}/p/:slug/events.${suffix}`,
        permanent: true,
      })),
      ...["md", "json"].map((suffix) => ({
        source: `/p/:slug/checkpoints.${suffix}`,
        destination: `${stoaOrigin}/p/:slug/checkpoints.${suffix}`,
        permanent: true,
      })),
      {
        source: "/p/:slug/export.jsonl.gz",
        destination: `${stoaOrigin}/p/:slug/export.jsonl.gz`,
        permanent: true,
      },
      {
        source: "/search.md",
        destination: `${stoaOrigin}/search.md`,
        permanent: true,
      },
      {
        source: "/search.json",
        destination: `${stoaOrigin}/search.json`,
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
