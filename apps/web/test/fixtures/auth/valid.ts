// Baseline: the shape the shipped auth.ts has. Must produce zero violations.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
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
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },
});
