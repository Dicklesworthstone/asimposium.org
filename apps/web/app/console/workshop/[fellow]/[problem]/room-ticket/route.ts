import { auth } from "@/auth";
import { stoaSponsorWorkshopRoomTicket } from "@/lib/stoa";
import {
  isSameOriginWorkshopRequest,
  loadWorkshopRoomTicketResponse,
  privateWorkshopCursorResponse,
} from "@/lib/workshop-page";

export const dynamic = "force-dynamic";

/** Same-origin CSRF-checked ticket minter. The host-only Auth.js session cookie
 * authenticates ONLY this Agora route (S-6) and is NEVER sent to a.asimposium.org. */
export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly fellow: string; readonly problem: string }> },
): Promise<Response> {
  const url = new URL(request.url);
  if (url.search !== "")
    return privateWorkshopCursorResponse(400, {
      error: "This workshop ticket route accepts no query.",
    });
  if (!isSameOriginWorkshopRequest(request, url))
    return privateWorkshopCursorResponse(403, {
      error: "Open this workshop on the sponsor console.",
    });
  try {
    const session = await auth();
    const { fellow, problem } = await params;
    return await loadWorkshopRoomTicketResponse(
      session?.user?.id,
      fellow,
      problem,
      stoaSponsorWorkshopRoomTicket,
    );
  } catch {
    return privateWorkshopCursorResponse(503, { error: "Workshop live room is unavailable." });
  }
}
