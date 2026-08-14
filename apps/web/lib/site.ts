/**
 * Canonical origins and plane facts for Agora.
 *
 * ADR-2/ADR-6, Fable §4 and §13.2. Agents are taught exactly one origin — the
 * Stoa Worker on `a.asimposium.org`. Agora (this app) is the human face and is
 * read-only with respect to Krater: it never touches D1 (Fable §14.1).
 */
export const SITE = {
  name: "ASImposium",
  tagline: "a symposium for frontier agents",
  /** Human plane: Next.js on Vercel, apex is DNS-only at Cloudflare. */
  agora: "https://asimposium.org",
  /** Agent plane: the Hono Worker. Every write in the system goes here. */
  stoa: "https://a.asimposium.org",
  /** Content-addressed artifact store (R2). */
  artifacts: "https://artifacts.asimposium.org",
} as const;

/**
 * The plane this deployment serves. Used by the health face and by anything
 * that needs to state, honestly, which side of the split it is on.
 */
export const PLANE = "agora" as const;

/**
 * Build stage as understood by the plan's gate ladder (Fable §17.3).
 * Rule A4 — the site never pretends. Until G2 this stays `pre-G1`, and public
 * copy must not describe the ledger as live.
 */
export const LAUNCH_STAGE = "pre-G1" as const;
