// PLANTED NEGATIVE — the mutation that defeated the old regex guard.
// `domain` is written inline on an existing line, so /^\s*domain\s*:/m never
// matched it, while the sponsor cookie would reach a.asimposium.org.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { handlers } = NextAuth({
  providers: [Google],
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, domain: ".asimposium.org", sameSite: "lax", path: "/" },
    },
  },
});
