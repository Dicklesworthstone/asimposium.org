// PLANTED NEGATIVE — the module never appears in an import statement, so the
// import allowlist cannot see it. Dynamic loading has to be refused outright
// or the allowlist is decorative.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const { env } = await import("./secrets");

export const { handlers } = NextAuth({
  providers: [Google],
  secret: env.AUTH_SECRET,
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
