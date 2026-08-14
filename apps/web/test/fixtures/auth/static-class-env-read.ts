// PLANTED NEGATIVE — a static field initialiser and a static block. Both run
// when the class is defined, which is import time, even though a class body
// otherwise defers everything inside it.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

class Secrets {
  static readonly value = process.env.AUTH_SECRET;
  static google = "";
  static {
    Secrets.google = process.env.AUTH_GOOGLE_SECRET ?? "";
  }
}

export const { handlers } = NextAuth({
  providers: [Google],
  secret: Secrets.value,
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
