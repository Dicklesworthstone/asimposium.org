// PLANTED NEGATIVE — the decisive one. A real, impeccable Auth.js call exists
// and is never used; the exported Propylon surface comes from a local factory
// that configures whatever it likes. Finding a safe call somewhere in the file
// proves nothing about what the application imports, so the exported
// `handlers` binding has to be initialised by that very call.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const unused = NextAuth({
  providers: [Google],
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});

function buildAuth(): {
  handlers: unknown;
  auth: unknown;
  signIn: unknown;
  signOut: unknown;
} {
  return {
    handlers: { GET: () => undefined, POST: () => undefined },
    auth: () => undefined,
    signIn: () => undefined,
    signOut: () => undefined,
  };
}

export const { handlers, auth, signIn, signOut } = buildAuth();
export const alsoUnused = unused;
