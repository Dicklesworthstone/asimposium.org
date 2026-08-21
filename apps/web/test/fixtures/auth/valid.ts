// Baseline: the shape the shipped auth.ts has. Must produce zero violations.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { authTimeFromIdToken } from "./lib/auth-time";
import { isCanonicalSponsorId, sponsorIdFromGoogleSubject } from "./lib/sponsor-id";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account) {
        token.sub = await sponsorIdFromGoogleSubject(profile?.sub);
        token.authTime = authTimeFromIdToken(account.id_token);
      }
      return token;
    },
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
      },
    },
  },
});
