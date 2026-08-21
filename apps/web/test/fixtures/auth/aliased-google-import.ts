// VALID — the local binding name is arbitrary; the module it came from is not.
// A checker that matched the identifier `Google` would reject this correct
// configuration, so it resolves the binding to its module instead.
import NextAuth from "next-auth";
import Idp from "next-auth/providers/google";
import { authTimeFromIdToken as signedAuthTime } from "./lib/auth-time";
import {
  isCanonicalSponsorId as isSponsorId,
  sponsorIdFromGoogleSubject as sponsorIdFor,
} from "./lib/sponsor-id";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Idp({ allowDangerousEmailAccountLinking: false })],
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account) {
        token.sub = await sponsorIdFor(profile?.sub);
        token.authTime = signedAuthTime(account.id_token);
      }
      return token;
    },
    session({ session, token }) {
      if (isSponsorId(token.sub)) session.user.id = token.sub;
      else Reflect.deleteProperty(session.user, "id");
      if (typeof token.authTime === "number") session.authIssuedAt = token.authTime;
      return session;
    },
  },
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
