// PLANTED NEGATIVE — the whole environment object escapes into a module-scope
// alias, after which every read through it is invisible to any name-based
// check. Taking the reference is the violation.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const env = process.env;

export const { handlers } = NextAuth({
  providers: [Google],
  secret: env.AUTH_SECRET,
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
