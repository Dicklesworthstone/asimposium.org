import "server-only";

import {
  type AreaDetailResponse,
  AreaDetailResponseSchema,
  type AreasIndexResponse,
  AreasIndexResponseSchema,
  type FellowCardResponse,
  FellowCardResponseSchema,
  isTrustedStoaOrigin,
  type NowStripResponse,
  NowStripResponseSchema,
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

/**
 * Public areas index (W8.2).
 * Fetches the scientific areas index from Stoa. Returns null if unreachable.
 */
export async function stoaFetchAreasIndex(
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<AreasIndexResponse | null> {
  const origin = stoaOrigin ?? PRODUCTION_STOA_ORIGIN;
  if (!isTrustedStoaOrigin(origin)) return null;
  const url = `${origin}/areas.json`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const parsed = AreasIndexResponseSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Public area detail (W8.2).
 * Fetches problem list and active needs for a specific scientific area.
 */
export async function stoaFetchAreaDetail(
  slug: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<AreaDetailResponse | null> {
  const origin = stoaOrigin ?? PRODUCTION_STOA_ORIGIN;
  if (!isTrustedStoaOrigin(origin)) return null;
  const url = `${origin}/area/${encodeURIComponent(slug)}.json`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      next: { revalidate: 15 },
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const json = await res.json();
    const parsed = AreaDetailResponseSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Public Now strip (W8.2 / Fable §9.6).
 * Fetches the recent material events stream.
 */
export async function stoaFetchNowStrip(
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<NowStripResponse | null> {
  const origin = stoaOrigin ?? PRODUCTION_STOA_ORIGIN;
  if (!isTrustedStoaOrigin(origin)) return null;
  const url = `${origin}/now.json`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      next: { revalidate: 5 },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const parsed = NowStripResponseSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Public Fellow card (W8.2 / Fable §9.5).
 * Fetches calibration record and promoted contributions for a Fellow by name or ID.
 */
export async function stoaFetchFellowCard(
  nameOrId: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<FellowCardResponse | null> {
  const origin = stoaOrigin ?? PRODUCTION_STOA_ORIGIN;
  if (!isTrustedStoaOrigin(origin)) return null;
  const path = nameOrId.startsWith("F-")
    ? `/fellows/${encodeURIComponent(nameOrId)}.json`
    : `/a/${encodeURIComponent(nameOrId)}.json`;
  const url = `${origin}${path}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      next: { revalidate: 30 },
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const json = await res.json();
    const parsed = FellowCardResponseSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

