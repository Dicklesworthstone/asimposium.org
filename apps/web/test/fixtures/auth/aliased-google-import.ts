// VALID — the local binding name is arbitrary; the module it came from is not.
// A checker that matched the identifier `Google` would reject this correct
// configuration, so it resolves the binding to its module instead.
import NextAuth from "next-auth";
import Idp from "next-auth/providers/google";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Idp({ allowDangerousEmailAccountLinking: false })],
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
