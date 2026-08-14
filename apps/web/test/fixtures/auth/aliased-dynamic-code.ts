// PLANTED NEGATIVE — the constructors are aliased first, so the call site is
// `f(...)` and `e(...)` and the dangerous part is a string. Checking call
// shapes misses this; refusing every reference to the names does not.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const f = Function;
const e = eval;

const secret = f("return process.env.AUTH_SECRET")();
const other = e("process.env.AUTH_GOOGLE_SECRET");

export const { handlers } = NextAuth({
  providers: [Google],
  secret: secret ?? other,
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
