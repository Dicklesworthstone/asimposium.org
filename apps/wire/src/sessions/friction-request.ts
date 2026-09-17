import type { EvidenceRequest } from "@asimposium/contracts";

export const FRICTION_REQUEST_MAX_BYTES = 98304;
export class FrictionRequestError extends Error {
  constructor() { super("FRICTION_REQUEST_INVALID"); }
}

/** Transform an explicit typed work product, never dispatch over the network.
 * The caller forwards this Request to its already-constructed ledger router.
 * No new principal, grant, idempotency key or scientific result is created. */
export function prepareFrictionEvidenceRequest(
  request: Request,
  bytes: Uint8Array,
  encode: (input: unknown) => EvidenceRequest,
): Request {
  const url = new URL(request.url);
  const key = request.headers.get("idempotency-key") ?? "";
  if (request.method !== "POST" || !/^\/v1\/sessions\/[^/]+\/friction$/.test(url.pathname) ||
      url.search !== "" || url.hash !== "" ||
      !/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "") ||
      (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity") ||
      /^[A-Za-z0-9._-]{1,160}$/.exec(key)?.[0] !== key ||
      bytes.byteLength > FRICTION_REQUEST_MAX_BYTES) throw new FrictionRequestError();
  let body: string;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    body = JSON.stringify(encode(value));
  } catch { throw new FrictionRequestError(); }
  // Keep the exact session, credential and caller-owned replay key. It is the
  // SAME evidence operation and shares that operation's replay namespace.
  url.pathname = url.pathname.replace(/\/friction$/, "/evidence");
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  return new Request(url, { method: "POST", headers, body, signal: request.signal });
}
