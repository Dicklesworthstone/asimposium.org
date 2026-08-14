// PLANTED NEGATIVE — no explicit cookie configuration at all. Auth.js would
// default to a host-only cookie, but the property would rest on a library
// default nobody stated, and a silent default is not a checkable contract.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { handlers } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
});
