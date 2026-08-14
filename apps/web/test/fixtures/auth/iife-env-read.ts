// PLANTED NEGATIVE — an import-time secret read wearing a function's clothes.
// The arrow is a function boundary, but it is invoked immediately, so the read
// happens when the module is loaded.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const secret = (() => process.env.AUTH_SECRET)();

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
