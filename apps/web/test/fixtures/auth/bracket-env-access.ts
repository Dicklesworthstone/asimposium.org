// PLANTED NEGATIVE — bracket spellings of the environment object. Neither
// `process["env"]` nor `Bun["env"]` contains the text "process.env".
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const secret = process["env"].AUTH_SECRET;
const clientSecret = Bun["env"]["AUTH_GOOGLE_SECRET"];

export const { handlers } = NextAuth({
  providers: [Google],
  secret: secret ?? clientSecret,
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
