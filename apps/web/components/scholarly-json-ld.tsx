import { serializeSafeJsonLd } from "@/lib/scholarly-metadata";

/**
 * Reads the per-request CSP nonce stamped by `proxy.ts` when inside a Next.js
 * request context; returns `undefined` outside a request scope (e.g. direct
 * component renders in unit tests).
 */
export async function readOptionalRequestNonce(): Promise<string | undefined> {
  try {
    const { headers } = await import("next/headers");
    return (await headers()).get("x-nonce") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Renders Schema.org ScholarlyArticle JSON-LD with escaped HTML-breaking tokens
 * and the per-request CSP nonce when available.
 */
export function ScholarlyJsonLd({
  data,
  nonce,
}: {
  readonly data: Record<string, unknown>;
  readonly nonce?: string;
}) {
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: serializeSafeJsonLd escapes <, >, &, U+2028, and U+2029 for application/ld+json.
      dangerouslySetInnerHTML={{ __html: serializeSafeJsonLd(data) }}
    />
  );
}
