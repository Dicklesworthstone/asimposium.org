import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
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
  // Google does not support relying parties forcing Google-account
  // reauthentication. Request its signed `auth_time` claim instead and use
  // that provider evidence verbatim; an old or missing claim fails closed for
  // sensitive actions rather than turning a fresh OAuth callback into proof.
  providers: [
    Google({
      authorization: {
        params: { claims: { id_token: { auth_time: { essential: true } } } },
      },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    // Auth.js refreshes the JWT's standard `iat` whenever it serves a session,
    // so `iat` cannot prove a recent Google sign-in. Preserve our own stable
    // authentication time and replace it only from the validated Google ID
    // token on an OAuth callback, never from callback arrival or session read.
    async jwt({ token, account, profile }) {
      if (account) {
        // Adapterless Auth.js deliberately assigns a fresh internal UUID to
        // each OAuth callback. Replace it with a deterministic application
        // principal derived from Google's validated, stable subject.
        token.sub = await sponsorIdFromGoogleSubject(profile?.sub);
        token.authTime =
          typeof profile?.auth_time === "number" &&
          Number.isSafeInteger(profile.auth_time) &&
          profile.auth_time >= 0
            ? profile.auth_time
            : undefined;
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
