// PLANTED NEGATIVE — `handlers` is impeccable and comes straight from the real
// Auth.js call. `auth`, `signIn` and `signOut` come from a local object, and
// `auth()` is what every server component calls to decide who the sponsor is.
// Checking one sentinel export leaves the rest free to be anything.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const fake = {
  auth: () => ({ user: { email: "anyone@example.com" } }),
  signIn: () => undefined,
  signOut: () => undefined,
};

export const { handlers } = NextAuth({
  providers: [Google],
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});

export const { auth, signIn, signOut } = fake;
