import { SponsorDataExportRequestSchema } from "@asimposium/contracts/account-export";
import { auth } from "@/auth";
import { stoaSponsorDataExportPage } from "@/lib/account-export";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { readBoundedStoaJson } from "@/lib/stoa";

const headers = {
  "cache-control": "private, no-store",
  vary: "Cookie",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function refusal(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers });
}

/** One bounded private read per request; identity is resolved again on every page. */
async function authenticatedExport(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get("origin") !== url.origin || url.search !== "") {
    return refusal(403, "EXPORT_REQUEST_REFUSED");
  }
  const session = await auth();
  const principalId = session?.user?.id;
  if (!isCanonicalSponsorId(principalId)) return refusal(401, "AUTHENTICATION_REQUIRED");
  const input = await readBoundedStoaJson(new Response(request.body), 4_096);
  const parsed = SponsorDataExportRequestSchema.safeParse(input);
  if (!parsed.success) return refusal(400, "EXPORT_REQUEST_INVALID");
  const result = await stoaSponsorDataExportPage(principalId, parsed.data);
  if (!result.ok) {
    if (result.reason === "unconfigured") return refusal(503, "EXPORT_UNCONFIGURED");
    if (result.reason === "refused" && result.status === 409) return refusal(409, "EXPORT_CHANGED");
    if (result.reason === "refused" && (result.status === 401 || result.status === 403)) {
      return refusal(result.status, "EXPORT_ACCESS_REFUSED");
    }
    return refusal(502, "EXPORT_UNAVAILABLE");
  }
  return Response.json(result.data, { headers });
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await authenticatedExport(request);
  } catch {
    // Authentication and transport failures must not expose a raw exception or
    // lose the private response headers on this account-data endpoint.
    return refusal(502, "EXPORT_UNAVAILABLE");
  }
}
