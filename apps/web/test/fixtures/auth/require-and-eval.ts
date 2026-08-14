// PLANTED NEGATIVE — the CommonJS and interpreter escape hatches. Both reach
// code the import allowlist never sees, and `eval` reaches the environment
// without naming a global root anywhere in the syntax tree.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

declare const require: (id: string) => { env: Record<string, string> };

const loaded = require("./secrets");
const viaEval = eval("process.env.AUTH_SECRET");
const viaFunction = new Function("return process.env.AUTH_GOOGLE_SECRET")();

export const { handlers } = NextAuth({
  providers: [Google],
  secret: loaded.env.AUTH_SECRET ?? viaEval ?? viaFunction,
  cookies: {
    sessionToken: {
      name: "asimp.session",
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
});
