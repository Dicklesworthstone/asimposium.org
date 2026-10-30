import { CursorResponseSchema } from "@asimposium/contracts";
import type { Env } from "../env";
import { validatedProblem } from "../http/envelope";

/** The cursor is a public invalidation hint, never an enrollment operation or
 * a per-problem scientific cursor. Keep its only dependency the D1 authority. */
export async function publicCursorResponse(request: Request, db: Env["DB"]): Promise<Response> {
  try {
    const row = await db
      .prepare("SELECT cursor FROM public_cursor WHERE singleton = 1")
      .first<{ cursor: number }>();
    // SQLite's 64-bit INTEGER and affinity rules are wider than our safe
    // integer wire contract. An absent row is the honest empty-ledger zero.
    const stored = CursorResponseSchema.safeParse(row?.cursor ?? 0);
    if (!stored.success) return cursorUnavailable();
    const body = String(stored.data);
    const etag = await cursorEtag(body);
    const headers = {
      "cache-control": "public, max-age=5",
      "content-type": "text/plain; charset=utf-8",
      etag,
    };
    if (cursorEtagMatches(request.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(request.method === "HEAD" ? null : body, { headers });
  } catch {
    return cursorUnavailable();
  }
}

export async function cursorEtag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `"${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
}

export function cursorEtagMatches(value: string | null, etag: string): boolean {
  return (
    value?.split(",").some((part) => {
      const candidate = part.trim();
      return candidate === "*" || candidate === etag || candidate === `W/${etag}`;
    }) ?? false
  );
}

export function cursorUnavailable(): Response {
  // Neither malformed storage nor a binding exception is a public diagnostic
  // channel: no table name, raw exception or observed cursor is exposed.
  return validatedProblem({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "The public cursor is unavailable",
    detail: "The public change cursor could not be served.",
    fixHint: "Retry shortly. If this persists the operator must repair the cursor.",
    headers: { "cache-control": "private, no-store" },
  });
}
