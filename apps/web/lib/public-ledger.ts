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
  type ProblemFaceResponse,
  ProblemFaceResponseSchema,
  type ProblemsIndexResponse,
  ProblemsIndexResponseSchema,
  type SearchResponse,
  SearchResponseSchema,
} from "@asimposium/contracts";
import { configuredStoaOrigin } from "./stoa";

export const PUBLIC_LEDGER_TIMEOUT_MS = 3_000;
export const PUBLIC_LEDGER_MAX_BYTES = 1024 * 1024;
const PUBLIC_READ_USER_AGENT = "OpenAI File Downloader, XaiImageApiFetch/1.0";

export type PublicRead<T> =
  | { readonly state: "ok"; readonly data: T; readonly origin: string }
  | { readonly state: "not_found"; readonly origin: string }
  | {
      readonly state: "unavailable";
      readonly reason: "configuration" | "http" | "invalid_response" | "oversize" | "timeout" | "network";
    };

/** One bounded read boundary for every public Agora projection. Empty lists are valid data. */
async function readPublic<T>(
  path: string,
  origin: string | undefined,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  revalidate: number,
  missingCode?: string,
): Promise<PublicRead<T>> {
  if (origin === undefined || !isTrustedStoaOrigin(origin)) {
    return { state: "unavailable", reason: "configuration" };
  }
  const controller = new AbortController();
  let expired = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
    // Cancel pending body reads as well as the connection, including cached response streams.
    void reader?.cancel().catch(() => undefined);
  }, PUBLIC_LEDGER_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}${path}`, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": PUBLIC_READ_USER_AGENT },
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      next: { revalidate },
    });
    if (response.status !== 200 && !(response.status === 404 && missingCode)) {
      void response.body?.cancel().catch(() => undefined);
      return { state: "unavailable", reason: "http" };
    }
    const length = response.headers.get("content-length");
    if (length !== null && /^\d+$/.test(length) && Number(length) > PUBLIC_LEDGER_MAX_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      return { state: "unavailable", reason: "oversize" };
    }
    reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (expired) return { state: "unavailable", reason: "timeout" };
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > PUBLIC_LEDGER_MAX_BYTES) {
          void reader.cancel().catch(() => undefined);
          return { state: "unavailable", reason: "oversize" };
        }
        chunks.push(chunk.value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return { state: "unavailable", reason: "invalid_response" };
    }
    if (response.status === 404) {
      // A missing route on an old deployment is not a missing scientific object.
      if (typeof value === "object" && value !== null && "code" in value &&
          value.code === missingCode && "status" in value && value.status === 404) {
        return { state: "not_found", origin };
      }
      return { state: "unavailable", reason: "http" };
    }
    const parsed = schema.safeParse(value);
    return parsed.success
      ? { state: "ok", data: parsed.data, origin }
      : { state: "unavailable", reason: "invalid_response" };
  } catch {
    return { state: "unavailable", reason: expired ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}

/**
 * Public problem digest face (W6.1 / W8.3).
 * Fetches the canonical JSON face from the configured Stoa deployment.
 */
export async function stoaFetchProblemFace(
  problemId: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<PublicRead<ProblemFaceResponse>> {
  return readPublic(`/p/${encodeURIComponent(problemId)}.json`, stoaOrigin,
    ProblemFaceResponseSchema, 10, "PROBLEM_NOT_FOUND");
}

/**
 * Public problems index (W6.1 / W8.2).
 * Fetches the problem index list, preserving a verified empty index.
 */
export async function stoaFetchProblemsIndex(
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<PublicRead<ProblemsIndexResponse>> {
  return readPublic("/problems.json", stoaOrigin, ProblemsIndexResponseSchema, 10);
}

/**
 * Public search (W6.8).
 * Fetches search results, preserving a verified empty match set.
 */
export async function stoaFetchSearch(
  query: string,
  kind?: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<PublicRead<SearchResponse>> {
  const params = new URLSearchParams({ q: query });
  if (kind && kind !== "all") params.set("kind", kind);
  return readPublic(`/search.json?${params}`, stoaOrigin, SearchResponseSchema, 10);
}

/**
 * Public areas index (W8.2).
 * Fetches the scientific areas index from Stoa.
 */
export async function stoaFetchAreasIndex(
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<PublicRead<AreasIndexResponse>> {
  return readPublic("/areas.json", stoaOrigin, AreasIndexResponseSchema, 30);
}

/**
 * Public area detail (W8.2).
 * Fetches problem list and active needs for a specific scientific area.
 */
export async function stoaFetchAreaDetail(
  slug: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<PublicRead<AreaDetailResponse>> {
  return readPublic(`/area/${encodeURIComponent(slug)}.json`, stoaOrigin,
    AreaDetailResponseSchema, 15, "AREA_NOT_FOUND");
}

/**
 * Public Now strip (W8.2 / Fable §9.6).
 * Fetches the recent material events stream.
 */
export async function stoaFetchNowStrip(
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<PublicRead<NowStripResponse>> {
  return readPublic("/now.json", stoaOrigin, NowStripResponseSchema, 5);
}

/**
 * Public Fellow card (W8.2 / Fable §9.5).
 * Fetches calibration record and promoted contributions for a Fellow by name or ID.
 */
export async function stoaFetchFellowCard(
  nameOrId: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<PublicRead<FellowCardResponse>> {
  const path = nameOrId.startsWith("F-")
    ? `/fellows/${encodeURIComponent(nameOrId)}.json`
    : `/a/${encodeURIComponent(nameOrId)}.json`;
  return readPublic(path, stoaOrigin, FellowCardResponseSchema, 30, "FELLOW_NOT_FOUND");
}
