import { handlers } from "@/auth";

/**
 * The single Auth.js v5 endpoint. This is the one route in Agora allowed to
 * export a write method: its POST is the OAuth callback and CSRF endpoint, and
 * it writes a host-only session cookie — never Krater. The exemption is
 * declared explicitly in `scripts/route-contract.ts` and enforced by the
 * contract suite; adding any other write handler under `app/api/**` fails
 * `bun run test:contract` with `WRITE_PATH_FORBIDDEN`.
 */
export const { GET, POST } = handlers;
