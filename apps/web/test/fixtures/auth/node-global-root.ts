// PLANTED NEGATIVE — Node's `global` is a fourth syntactic route to the
// environment, distinct from process, Bun and globalThis.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const secret = global.process.env.AUTH_SECRET;

export const { handlers } = NextAuth({
  providers: [Google],
  secret,
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
