import type { NextRequest } from "next/server";
import { handlers } from "@/auth";
import { BARE_CALLBACK_REDIRECT, isBareOAuthCallback } from "@/lib/auth-callback";

/**
 * The single Auth.js v5 endpoint. This is the one route in Agora allowed to
 * export a write method: its POST is the OAuth callback and CSRF endpoint, and
 * it writes a host-only session cookie — never Krater. The exemption is
 * declared explicitly in `scripts/route-contract.ts` and enforced by the
 * contract suite; adding any other write handler under `app/api/**` fails
 * `bun run test:contract` with `WRITE_PATH_FORBIDDEN`.
 *
 * A callback with neither `code` nor `error` (a reload or restored tab) has
 * nothing to exchange; it goes to the honest stale-state face rather than
 * surfacing as a deployment `Configuration` fault.
 */
export async function GET(request: NextRequest): Promise<Response> {
  if (isBareOAuthCallback(request.nextUrl)) {
    return Response.redirect(new URL(BARE_CALLBACK_REDIRECT, request.nextUrl), 303);
  }
  return handlers.GET(request);
}

export const { POST } = handlers;
