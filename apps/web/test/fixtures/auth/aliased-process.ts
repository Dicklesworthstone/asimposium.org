// PLANTED NEGATIVE — `process` itself is aliased before `.env` is ever
// written, so every later read is invisible to a check that looks for the
// environment object. Letting the root escape is the violation.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const p = process;
const secret = p.env.AUTH_SECRET;

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
