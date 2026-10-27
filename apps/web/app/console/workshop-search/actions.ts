"use server";

import { auth } from "@/auth";
import { stoaSearchWorkshops } from "@/lib/stoa-workshop-search";
import { searchOwnedWorkshops, type WorkshopSearchResult } from "@/lib/workshop-search";

export async function searchPrivateWorkshops(input: unknown): Promise<WorkshopSearchResult> {
  const session = await auth();
  return searchOwnedWorkshops(session?.user?.id, input, stoaSearchWorkshops);
}
