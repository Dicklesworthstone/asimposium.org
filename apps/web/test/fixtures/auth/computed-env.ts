// PLANTED NEGATIVE — a computed key hides the variable name from static
// reasoning, and Bun.env is a second accessor onto the same environment.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const which = "AUTH_SECRET";
const secret = Bun.env[which];

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
