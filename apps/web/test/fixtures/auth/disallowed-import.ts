// PLANTED NEGATIVE — the environment arrives from another module, so no rule
// about `process` in this file can see it. The import allowlist is what closes
// that hole, and it is why the allowlist carries so much weight.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

import { env } from "./secrets";

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
