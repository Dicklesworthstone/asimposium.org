// PLANTED NEGATIVE — the provider list is spread from elsewhere, so what is
// actually configured cannot be established from this file.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

import { extraProviders } from "./extra-providers";

export const { handlers } = NextAuth({
  providers: [...extraProviders, Google],
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
