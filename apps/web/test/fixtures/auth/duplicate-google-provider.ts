// PLANTED NEGATIVE — the same provider twice. Every entry resolves to Google,
// so a "no non-Google provider" rule is satisfied; the acceptance is exactly
// one configured provider expression, and this is two.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { handlers } = NextAuth({
  providers: [Google, Google],
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
