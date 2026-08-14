// PLANTED NEGATIVE — the Bun global aliased before `.env` is ever written.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const B = Bun;
const secret = B.env.AUTH_SECRET;

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
