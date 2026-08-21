import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { authTimeFromIdToken } from "./lib/auth-time";
import { isCanonicalSponsorId, sponsorIdFromGoogleSubject } from "./lib/sponsor-id";

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
  // OAuth failures land on a themed, honest face instead of the framework
  // default; the route renders the provider's raw code for correlation.
  pages: { error: "/auth/error" },
  callbacks: {
    // Auth.js refreshes its own JWT's standard `iat` whenever it serves a
    // session. Preserve a separate timestamp copied only from the Google ID
    // token issued for an OAuth callback; ordinary session reads cannot move it.
    async jwt({ token, account, profile }) {
      if (account) {
        // Adapterless Auth.js deliberately assigns a fresh internal UUID to
        // each OAuth callback. Replace it with a deterministic application
        // principal derived from Google's validated, stable subject.
        token.sub = await sponsorIdFromGoogleSubject(profile?.sub);
        // Google's ID-token `iat` is signed for this relying-party response.
        // Never prefer the optional `auth_time`: it can describe an old Google
        // session and caused the approval step-up to remain stale forever.
        token.authTime = authTimeFromIdToken(account.id_token);
      }
      return token;
    },
    // The sponsor principal id Agora signs envelopes with: `usr_` plus the
    // digest of Google's `sub` — opaque, stable, never an email or raw provider
    // identifier. The console and Stoa both gate on the canonical shape.
    session({ session, token }) {
      if (isCanonicalSponsorId(token.sub)) session.user.id = token.sub;
      else Reflect.deleteProperty(session.user, "id");
      if (typeof token.authTime === "number") session.authIssuedAt = token.authTime;
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
