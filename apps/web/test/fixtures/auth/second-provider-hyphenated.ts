// PLANTED NEGATIVE — a second provider whose package name contains a hyphen.
// The old regex used \w+, which cannot match "microsoft-entra-id", so the
// "Google is the only provider" test stayed green with two providers wired.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Entra from "next-auth/providers/microsoft-entra-id";

export const { handlers } = NextAuth({
  providers: [Google, Entra],
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
