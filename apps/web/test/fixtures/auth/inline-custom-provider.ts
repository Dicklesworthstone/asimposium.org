// PLANTED NEGATIVE — a second provider that never appears in an import.
// An import scan reports "Google only" here, which is why import scanning is a
// proxy and not the property: the configured set is what NextAuth receives.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const Rogue = {
  id: "rogue",
  name: "Rogue",
  type: "credentials",
  authorize: () => ({ id: "1" }),
};

export const { handlers } = NextAuth({
  providers: [Google, Rogue],
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
