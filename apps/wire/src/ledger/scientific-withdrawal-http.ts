import type {
  ScientificWithdrawalReceipt,
  ScientificWithdrawalRequest,
} from "@asimposium/contracts/scientific-withdrawals";
import type { FellowCredentialBinding } from "../enrollment/service.ts";
import type { validatedProblem } from "../http/envelope.ts";

export const WITHDRAWAL_BODY_LIMIT = 16 * 1024;
const BODY_DEADLINE_MS = 10_000;
const PRIVATE = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
export class WithdrawalHttpError extends Error {
  readonly code: "DENIED" | "CONFLICT" | "HELD" | "THROTTLED" | "UNAVAILABLE";
  readonly retryAfter: number;
  constructor(code: "DENIED" | "CONFLICT" | "HELD" | "THROTTLED" | "UNAVAILABLE", retryAfter = 30) {
    super(`SCIENTIFIC_WITHDRAWAL_${code}`);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
export interface ScientificWithdrawalOperations {
  readonly schema: string;
  readonly problem: typeof validatedProblem;
  readonly authenticate: (token: string) => Promise<FellowCredentialBinding | undefined>;
  readonly decode: (value: unknown) => ScientificWithdrawalRequest | undefined;
  readonly withdraw: (
    actor: FellowCredentialBinding,
    session: string,
    kind: "evidence" | "review",
    target: string,
    input: ScientificWithdrawalRequest,
    key: string,
  ) => Promise<ScientificWithdrawalReceipt>;
  /** Internal test seam; no request can choose its own deadline. */
  readonly bodyTimeoutMs?: number;
}
export function scientificWithdrawalRoute(path: string) {
  const match =
    /^\/v1\/sessions\/(S-[A-Za-z0-9]{26})\/(evidence|reviews)\/([ER]-[A-Za-z0-9]{1,78})\/retract$/.exec(
      path,
    );
  if (
    !match ||
    (match[2] === "reviews" ? !match[3]!.startsWith("R-") : !match[3]!.startsWith("E-"))
  )
    return undefined;
  return {
    session: match[1]!,
    kind: match[2] === "reviews" ? ("review" as const) : ("evidence" as const),
    target: match[3]!,
  };
}
function cancel(request: Request): void {
  try {
    if (request.body && !request.body.locked) void request.body.cancel().catch(() => undefined);
  } catch {
    /* best effort */
  }
}
async function readBody(request: Request, timeout: number): Promise<unknown> {
  const length = request.headers.get("content-length"),
    encoding = request.headers.get("content-encoding");
  if (
    request.signal.aborted ||
    (encoding !== null && encoding.toLowerCase() !== "identity") ||
    (length !== null &&
      (!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > WITHDRAWAL_BODY_LIMIT))
  )
    throw new Error("BODY_INVALID");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("BODY_REQUIRED");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const deadline = new Promise<never>((_, reject) => {
    abort = () => {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        /* best effort */
      }
      reject(new Error("BODY_INTERRUPTED"));
    };
    timer = setTimeout(abort, timeout);
    request.signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const bytes = new Uint8Array(WITHDRAWAL_BODY_LIMIT);
    let size = 0;
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.length > bytes.length - size)
        throw new Error("BODY_INVALID");
      bytes.set(next.value, size);
      size += next.value.length;
    }
    if (length !== null && size !== Number(length)) throw new Error("BODY_INVALID");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
  } catch (error) {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      /* best effort */
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    try {
      reader.releaseLock();
    } catch {
      /* do not replace the refusal */
    }
  }
}

/** Transport only. Real auth, Zod, quota, screen and writer are composed by the
 * session router; request text never supplies a principal or a policy verdict. */
export async function handleScientificWithdrawalHttp(
  request: Request,
  ops: ScientificWithdrawalOperations,
): Promise<Response | undefined> {
  const url = new URL(request.url),
    route = scientificWithdrawalRoute(url.pathname);
  if (!route) return undefined;
  const timeout = ops.bodyTimeoutMs ?? BODY_DEADLINE_MS;
  const problem = (input: Parameters<typeof validatedProblem>[0]): Response => {
    const response = ops.problem({ ...input, headers: { ...PRIVATE, ...input.headers } });
    return request.method === "HEAD"
      ? new Response(null, { status: response.status, headers: response.headers })
      : response;
  };
  const contract = (status: number, detail: string, headers?: Record<string, string>) =>
    problem({
      status,
      code: "SCHEMA_INVALID",
      title: "Scientific withdrawal needs correction",
      detail,
      fixHint:
        "Pin the source event and digest and give a public explanation. Use the same Idempotency-Key for an unchanged retry.",
      rule: "P9",
      extensions: {
        schema: ops.schema,
        example: {
          source_event_id: "E-EXAMPLE",
          source_digest: `sha256:${"0".repeat(64)}`,
          reason: "The author identified a substantive error.",
        },
      },
      headers,
    });
  try {
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > BODY_DEADLINE_MS)
      throw new WithdrawalHttpError("UNAVAILABLE");
    if (request.method !== "POST")
      return contract(405, "This correction requires POST.", { allow: "POST" });
    if (url.search) return contract(400, "Withdrawal routes accept no query parameters.");
    if (request.headers.has("asimp-service-envelope")) throw new WithdrawalHttpError("DENIED");
    const bearer = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "");
    if (!bearer?.[1] || bearer[1].length > 256) throw new WithdrawalHttpError("DENIED");
    const actor = await ops.authenticate(bearer[1]);
    if (!actor || actor.credentialProfile !== "bearer") throw new WithdrawalHttpError("DENIED");
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        request.headers.get("content-type") ?? "",
      )
    )
      return contract(415, "Send application/json, not a file or a transcript.");
    const key = request.headers.get("idempotency-key");
    if (key === null || !/^[A-Za-z0-9._-]{1,160}$/.test(key))
      return contract(400, "Supply a valid Idempotency-Key.");
    let value: unknown;
    try {
      value = await readBody(request, timeout);
    } catch {
      return contract(400, "Send complete UTF-8 JSON within 16 KiB and the request deadline.");
    }
    const input = ops.decode(value);
    if (!input)
      return contract(
        422,
        "Supply only source_event_id, source_digest and a substantive reason of 10–2000 characters.",
      );
    const receipt = await ops.withdraw(actor, route.session, route.kind, route.target, input, key);
    if (
      receipt.schema !== ops.schema ||
      receipt.target_object !== route.target ||
      receipt.target_kind !== route.kind ||
      receipt.target_event_id !== input.source_event_id ||
      receipt.target_digest !== input.source_digest
    )
      throw new WithdrawalHttpError("UNAVAILABLE");
    return new Response(JSON.stringify(receipt), {
      headers: { ...PRIVATE, "content-type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    const code = error instanceof WithdrawalHttpError ? error.code : "UNAVAILABLE";
    if (code === "DENIED")
      return problem({
        status: 401,
        code: "UNAUTHORIZED",
        title: "Scientific correction unavailable",
        detail: "This request is not authorized for the correction.",
        fixHint: "Use a current Fellow bearer and an owned source in an authorized session.",
      });
    if (code === "CONFLICT")
      return contract(
        409,
        "The source or Idempotency-Key conflicts with an existing correction. Recover the original receipt before retrying.",
      );
    if (code === "HELD")
      return problem({
        status: 403,
        code: "WRITE_REFUSED",
        title: "Correction not published",
        detail: "The submitted explanation was not admitted for publication.",
        fixHint: "Consult /policy.md for policy and appeal guidance.",
      });
    const retry =
      error instanceof WithdrawalHttpError &&
      Number.isSafeInteger(error.retryAfter) &&
      error.retryAfter > 0
        ? Math.min(error.retryAfter, 3600)
        : 30;
    return problem({
      status: code === "THROTTLED" ? 429 : 503,
      code: code === "THROTTLED" ? "WRITE_REFUSED" : "INTERNAL_ERROR",
      title: "Correction temporarily unavailable",
      detail: "No successful correction receipt is available from this attempt.",
      fixHint: "Retry the unchanged request with the same Idempotency-Key.",
      headers: { "retry-after": String(retry) },
    });
  } finally {
    cancel(request);
  }
}
