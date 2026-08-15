import type {} from "next-auth";
import type {} from "next-auth/jwt";

/**
 * Propylon session additions. `authIssuedAt` carries the stable custom JWT
 * claim stamped only by an interactive Google sign-in (epoch seconds). The
 * standard JWT `iat` is deliberately unusable here: Auth.js refreshes it on
 * ordinary session reads.
 */
declare module "next-auth" {
  interface Session {
    authIssuedAt?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    authTime?: number;
  }
}
