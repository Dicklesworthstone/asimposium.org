// PLANTED NEGATIVE — a module-scope credential read via destructuring.
// The old regex looked for the literal text "process.env.AUTH_", which this
// spelling never produces, yet the secret is read at import time.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const { AUTH_SECRET, AUTH_GOOGLE_SECRET } = process.env;

export const { handlers } = NextAuth({
  providers: [Google],
  secret: AUTH_SECRET ?? AUTH_GOOGLE_SECRET,
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
