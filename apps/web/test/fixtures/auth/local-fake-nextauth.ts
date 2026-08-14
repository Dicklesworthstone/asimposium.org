// PLANTED NEGATIVE — a local function named NextAuth. A checker that matches
// the identifier by name validates this object happily, while Auth.js never
// receives it. The callee has to resolve to the imported binding.
import Google from "next-auth/providers/google";

function NextAuth(config: unknown): { handlers: unknown } {
  return { handlers: config };
}

export const { handlers } = NextAuth({
  providers: [Google],
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
