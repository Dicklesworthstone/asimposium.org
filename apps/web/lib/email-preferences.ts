import { isCanonicalSponsorId } from "./sponsor-id";

const UNSUBSCRIBE_REF_PREFIX = "unsub-";
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ParsedUnsubscribeToken {
  readonly sponsorId: string;
  readonly ref: string;
  readonly sig: string;
}

/**
 * Strictly parse signed digest unsubscribe query parameters emitted by Stoa's
 * `renderTransactionalEmail` (`?ref=unsub-<sponsorId>&sig=<32-char-hmac>`).
 * Rejects duplicate params, malformed sponsor IDs, invalid signature shapes,
 * or unexpected extra query keys.
 */
export function parseUnsubscribeQuery(
  query: Record<string, string | readonly string[] | undefined>,
): ParsedUnsubscribeToken | undefined {
  if (!Object.keys(query).every((key) => key === "ref" || key === "sig")) {
    return undefined;
  }
  const ref = query.ref;
  const sig = query.sig;
  if (typeof ref !== "string" || typeof sig !== "string") return undefined;
  if (!ref.startsWith(UNSUBSCRIBE_REF_PREFIX)) return undefined;
  const sponsorId = ref.slice(UNSUBSCRIBE_REF_PREFIX.length);
  if (!isCanonicalSponsorId(sponsorId)) return undefined;
  if (!SIGNATURE_PATTERN.test(sig)) return undefined;
  return { sponsorId, ref, sig };
}

export type ParsedNotificationEmailInput =
  | { readonly ok: true; readonly mode: "unchanged" }
  | { readonly ok: true; readonly mode: "clear"; readonly email: null }
  | { readonly ok: true; readonly mode: "set"; readonly email: string }
  | { readonly ok: false };

/**
 * Parse sponsor console email-preferences form fields cleanly:
 *  - `clearRequested`: explicitly sets `notification_email: null`
 *  - blank input without clear: leaves stored notification email unchanged
 *  - non-empty input: enforces CRLF-free, <=254 char syntactic email address
 */
export function parseNotificationEmailInput(opts: {
  readonly rawEmail: string;
  readonly clearRequested: boolean;
}): ParsedNotificationEmailInput {
  if (opts.clearRequested) {
    return { ok: true, mode: "clear", email: null };
  }
  const trimmed = opts.rawEmail.trim();
  if (trimmed.length === 0) {
    return { ok: true, mode: "unchanged" };
  }
  if (
    trimmed.length < 3 ||
    trimmed.length > 254 ||
    /[\r\n\0]/.test(trimmed) ||
    !EMAIL_PATTERN.test(trimmed)
  ) {
    return { ok: false };
  }
  return { ok: true, mode: "set", email: trimmed.toLowerCase() };
}
