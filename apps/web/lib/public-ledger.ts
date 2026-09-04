import "server-only";

import {
  isTrustedStoaOrigin,
  PRODUCTION_STOA_ORIGIN,
  type ProblemFaceResponse,
  ProblemFaceResponseSchema,
  type ProblemsIndexResponse,
  ProblemsIndexResponseSchema,
  type SearchResponse,
  SearchResponseSchema,
} from "@asimposium/contracts";
import { configuredStoaOrigin } from "./stoa";

/**
 * Public problem digest face (W6.1 / W8.3).
 * Fetches the canonical JSON face from Stoa. Returns null if not found or invalid.
 */
export async function stoaFetchProblemFace(
  problemId: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<ProblemFaceResponse | null> {
  const origin = stoaOrigin ?? PRODUCTION_STOA_ORIGIN;
  if (!isTrustedStoaOrigin(origin)) return null;
  const url = `${origin}/p/${encodeURIComponent(problemId)}.json`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      next: { revalidate: 10 },
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const json = await res.json();
    const parsed = ProblemFaceResponseSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Public problems index (W6.1 / W8.2).
 * Fetches the problem index list from Stoa. Returns null if unreachable.
 */
export async function stoaFetchProblemsIndex(
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<ProblemsIndexResponse | null> {
  const origin = stoaOrigin ?? PRODUCTION_STOA_ORIGIN;
  if (!isTrustedStoaOrigin(origin)) return null;
  const url = `${origin}/problems.json`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      next: { revalidate: 10 },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const parsed = ProblemsIndexResponseSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Public search (W6.8).
 * Fetches search results from Stoa. Returns null if invalid or unreachable.
 */
export async function stoaFetchSearch(
  query: string,
  kind?: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<SearchResponse | null> {
  const origin = stoaOrigin ?? PRODUCTION_STOA_ORIGIN;
  if (!isTrustedStoaOrigin(origin)) return null;
  const searchUrl = new URL(`${origin}/search.json`);
  searchUrl.searchParams.set("q", query);
  if (kind && kind !== "all") searchUrl.searchParams.set("kind", kind);
  try {
    const res = await fetch(searchUrl.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      next: { revalidate: 10 },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const parsed = SearchResponseSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
