import { isTrustedStoaOrigin } from "@asimposium/contracts";
import { isCanonicalSponsorId } from "./sponsor-id";

const ROUTE_PUBLIC_EMAIL_UNSUBSCRIBE = "/v1/email/unsubscribe";
const UNSUBSCRIBE_TIMEOUT_MS = 8_000;
const MAX_UNSUBSCRIBE_RESPONSE_BYTES = 16_384;

export interface PublicEmailUnsubscribeResult {
  readonly unsubscribed: true;
  readonly sponsor_id: string;
  readonly digest_opt_in: false;
  readonly updated_at: string;
}

export type PublicEmailUnsubscribeOutcome =
  | { readonly ok: true; readonly data: PublicEmailUnsubscribeResult }
  | {
      readonly ok: false;
      readonly reason: "unconfigured" | "unreachable" | "refused";
      readonly status?: number;
    };

function resolvedTrustedStoaOrigin(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || !isTrustedStoaOrigin(trimmed)) return undefined;
  return trimmed.replace(/\/$/, "");
}

async function readBoundedUtf8Text(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
  }
  const stream = response.body;
  if (!stream) {
    const raw = await response.text();
    const encoded = new TextEncoder().encode(raw);
    return encoded.byteLength <= maxBytes ? raw : undefined;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(merged);
}

/**
 * OPS.7: Submit a signed public one-click digest unsubscribe to Stoa
 * (`POST /v1/email/unsubscribe`). Kept outside `lib/stoa.ts` so `lib/stoa.ts`
 * remains exclusively bound to signed Ed25519 sponsor/operator envelopes.
 * Invoked ONLY from an explicit POST Server Action — never during a GET render.
 */
export async function stoaPublicEmailUnsubscribe(
  input: {
    readonly sponsor_id: string;
    readonly ref: string;
    readonly sig: string;
  },
  stoaOriginOverride?: string,
): Promise<PublicEmailUnsubscribeOutcome> {
  const stoaOrigin = resolvedTrustedStoaOrigin(stoaOriginOverride ?? process.env.STOA_ORIGIN);
  if (stoaOrigin === undefined) {
    return { ok: false, reason: "unconfigured" };
  }
  if (
    !isCanonicalSponsorId(input.sponsor_id) ||
    input.ref !== `unsub-${input.sponsor_id}` ||
    !/^[A-Za-z0-9_-]{32}$/.test(input.sig)
  ) {
    return { ok: false, reason: "refused", status: 422 };
  }
  try {
    const response = await fetch(new URL(ROUTE_PUBLIC_EMAIL_UNSUBSCRIBE, stoaOrigin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sponsor_id: input.sponsor_id,
        ref: input.ref,
        sig: input.sig,
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(UNSUBSCRIBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        reason: response.status >= 500 ? "unreachable" : "refused",
        status: response.status,
      };
    }
    const text = await readBoundedUtf8Text(response, MAX_UNSUBSCRIBE_RESPONSE_BYTES);
    if (text === undefined) {
      return { ok: false, reason: "unreachable" };
    }
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: "unreachable" };
    }
    const obj = parsed as Record<string, unknown>;
    if (
      obj.unsubscribed !== true ||
      obj.sponsor_id !== input.sponsor_id ||
      obj.digest_opt_in !== false ||
      typeof obj.updated_at !== "string"
    ) {
      return { ok: false, reason: "unreachable" };
    }
    return {
      ok: true,
      data: {
        unsubscribed: true,
        sponsor_id: obj.sponsor_id,
        digest_opt_in: false,
        updated_at: obj.updated_at,
      },
    };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
