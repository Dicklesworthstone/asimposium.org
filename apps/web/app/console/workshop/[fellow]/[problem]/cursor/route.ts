import { auth } from "@/auth";
import { stoaSponsorWorkshopCursor } from "@/lib/stoa";
import { loadWorkshopCursorResponse, privateWorkshopCursorResponse } from "@/lib/workshop-page";

export const dynamic = "force-dynamic";

/** Fixed private read: callers cannot select an upstream URL or principal. */
export async function GET(
  request: Request,
  {
    params,
  }: { readonly params: Promise<{ readonly fellow: string; readonly problem: string }> },
): Promise<Response> {
  const url = new URL(request.url);
  if (url.search !== "")
    return privateWorkshopCursorResponse(400, { error: "This workshop check accepts no query." });
  const origin = request.headers.get("origin");
  if (
    request.headers.get("sec-fetch-site") === "cross-site" ||
    (origin !== null && origin !== url.origin)
  )
    return privateWorkshopCursorResponse(403, {
      error: "Open this workshop on the sponsor console.",
    });
  try {
    const session = await auth();
    const { fellow, problem } = await params;
    return await loadWorkshopCursorResponse(
      session?.user?.id,
      fellow,
      problem,
      stoaSponsorWorkshopCursor,
    );
  } catch {
    return privateWorkshopCursorResponse(503, { error: "Workshop checks are unavailable." });
  }
}
