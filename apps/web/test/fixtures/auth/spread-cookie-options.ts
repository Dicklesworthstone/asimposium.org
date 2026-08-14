// PLANTED NEGATIVE — the cookie options are spread from elsewhere, so `domain`
// cannot be proven absent. Unprovable is a refusal, not a pass: the guard must
// not read "I did not see it" as "it is not there".
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

import { sharedCookieOptions } from "./shared-cookie-options";

export const { handlers } = NextAuth({
  providers: [Google],
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { ...sharedCookieOptions, httpOnly: true },
    },
  },
});
