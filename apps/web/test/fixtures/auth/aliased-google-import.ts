// VALID — the local binding name is arbitrary; the module it came from is not.
// A checker that matched the identifier `Google` would reject this correct
// configuration, so it resolves the binding to its module instead.
import NextAuth from "next-auth";
import Idp from "next-auth/providers/google";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Idp({ allowDangerousEmailAccountLinking: false })],
  callbacks: {
    jwt({ token, account, profile }) {
      if (account) {
        token.authTime =
          typeof profile?.auth_time === "number" &&
          Number.isSafeInteger(profile.auth_time) &&
          profile.auth_time >= 0
            ? profile.auth_time
            : undefined;
      }
      return token;
    },
    session({ session, token }) {
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
