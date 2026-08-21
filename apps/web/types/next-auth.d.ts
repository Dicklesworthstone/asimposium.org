import type {} from "next-auth";
import type {} from "next-auth/jwt";

/**
 * Propylon session additions. `authIssuedAt` carries the stable custom JWT
 * claim copied only from Google's validated ID-token `iat` claim (epoch
 * seconds) during an OAuth callback. Auth.js's own JWT `iat` is deliberately
 * unusable here because ordinary session reads can refresh it.
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
