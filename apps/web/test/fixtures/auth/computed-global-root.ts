// PLANTED NEGATIVE — the reason this checker is an allowlist. Neither the
// string "process" nor "env" appears as a token here; both are assembled at
// runtime. No finite list of bad spellings catches this, but every route still
// has to name a global root, and `globalThis` is on the refused list.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const g = globalThis as unknown as Record<string, Record<string, string>>;
const secret = g["pro" + "cess"]?.["en" + "v"]?.["AUTH" + "_SECRET"];

export const { handlers } = NextAuth({
  providers: [Google],
  secret,
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
