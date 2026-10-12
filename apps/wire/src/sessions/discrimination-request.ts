import type { EventBatchRequest } from "@asimposium/contracts";
import {
  DISCRIMINATION_BATCH_MAX_BYTES,
  DISCRIMINATION_REQUEST_MAX_BYTES,
} from "@asimposium/contracts/discrimination-model";

export class DiscriminationRequestError extends Error {
  constructor() {
    super("DISCRIMINATION_REQUEST_INVALID");
  }
}

/** Keep the same problem, bearer, caller key and abort signal. No database read
 * precedes the batch's own replay lookup and no request is sent over a network.
 * Both original and expanded bytes are bounded before entering the writer. */
export function prepareDiscriminationBatchRequest(
  request: Request,
  bytes: Uint8Array,
  encode: (input: unknown, problemId: string) => EventBatchRequest,
): Request {
  const url = new URL(request.url);
  const match = /^\/v1\/p\/([^/]+)\/discrimination$/.exec(url.pathname);
  const key = request.headers.get("idempotency-key") ?? "";
  if (
    request.method !== "POST" ||
    !match ||
    url.search ||
    url.hash ||
    !/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "") ||
    (request.headers.has("content-encoding") &&
      request.headers.get("content-encoding") !== "identity") ||
    /^[A-Za-z0-9._-]{1,160}$/.exec(key)?.[0] !== key ||
    bytes.byteLength > DISCRIMINATION_REQUEST_MAX_BYTES
  ) {
    throw new DiscriminationRequestError();
  }
  let body: string;
  let problemId: string;
  try {
    problemId = decodeURIComponent(match[1]!);
    // Segment safety only. The canonical encoder owns the actual problem-ID
    // grammar; duplicating it here would incorrectly reject retained IDs.
    if (!problemId || /[\s/\\?#\u0000-\u001f\u007f]/u.test(problemId)) {
      throw new DiscriminationRequestError();
    }
    const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    body = JSON.stringify(encode(input, problemId));
    if (
      typeof body !== "string" ||
      new TextEncoder().encode(body).byteLength > DISCRIMINATION_BATCH_MAX_BYTES
    ) {
      throw new DiscriminationRequestError();
    }
  } catch {
    throw new DiscriminationRequestError();
  }
  url.pathname = `/v1/p/${encodeURIComponent(problemId)}/events:batch`;
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  for (const name of ["content-length", "content-encoding", "transfer-encoding"]) {
    headers.delete(name);
  }
  return new Request(url, { method: "POST", headers, body, signal: request.signal });
}
