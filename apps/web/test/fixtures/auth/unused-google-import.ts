// PLANTED NEGATIVE — Google is imported but never configured. An import scan
// is satisfied; the running application has no identity provider at all.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const GOOGLE_FOR_LATER = Google;

export const { handlers } = NextAuth({
  providers: [],
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
