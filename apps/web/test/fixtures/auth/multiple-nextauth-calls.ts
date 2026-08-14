// PLANTED NEGATIVE — two factory calls. The first is impeccable and would
// satisfy a checker that stops at the first match; the second is the one whose
// handlers are exported. Which configuration is live is not decidable from
// syntax, so the only honest verdict is a refusal.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const Rogue = { id: "rogue", type: "credentials", authorize: () => ({ id: "1" }) };

export const safe = NextAuth({
  providers: [Google],
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});

export const { handlers } = NextAuth({
  providers: [Google, Rogue],
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, domain: ".asimposium.org" },
    },
  },
});
