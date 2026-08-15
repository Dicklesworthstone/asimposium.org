import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

/**
 * Propylon, human half (Fable §5.1): Google is the only human identity
 * provider. No passwords, no magic links, no GitHub.
 *
 * Two properties are load-bearing and are asserted by the contract suite:
 *
 *  - The session cookie is **host-only on the apex** (Fable §14.1). It is never
 *    sent to `a.asimposium.org`; a sponsor cookie on an agent route is a
 *    `WRONG_PRINCIPAL` error, and the reverse is too.
 *  - Agora holds no Krater credentials. A signed service envelope to the Worker
 *    is how sponsor writes happen (W8). That path runs in production: the
 *    console's mint, decision, and list calls cross it per request.
 *
 * Credentials come from the environment at runtime — `AUTH_SECRET`,
 * `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`. They are never read at module scope
 * and never appear in a build artifact.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  callbacks: {
    // The sponsor principal id Agora signs envelopes with: `usr_` plus the
    // Google `sub` — opaque, stable, never an email. The console and every
    // Stoa call gate on this canonical shape (isCanonicalSponsorId).
    session({ session, token }) {
      if (token.sub) session.user.id = `usr_${token.sub}`;
      if (typeof token.iat === "number") session.authIssuedAt = token.iat;
      return session;
    },
  },
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
        // Host-only: no `domain` key. Deliberate — see Fable §14.1. Setting a
        // domain here would leak the sponsor cookie onto `a.asimposium.org`.
      },
    },
  },
});
