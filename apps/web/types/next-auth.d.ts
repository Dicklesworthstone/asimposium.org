import type {} from "next-auth";

/**
 * Propylon session additions. `authIssuedAt` carries the session JWT's `iat`
 * (epoch seconds) so sponsor decisions can require a recent sign-in (W3.4's
 * recent-auth rule) without trusting any client-supplied timestamp.
 */
declare module "next-auth" {
  interface Session {
    authIssuedAt?: number;
  }
}
