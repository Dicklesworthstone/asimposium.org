import "server-only";

import {
  type AreaDetailResponse,
  AreaDetailResponseSchema,
  type AreasIndexResponse,
  AreasIndexResponseSchema,
  type CitationsListResponse,
  CitationsListResponseSchema,
  ClaimFaceQuerySchema,
  type ClaimFaceResponse,
  ClaimFaceResponseSchema,
  CommentaryListQuerySchema,
  type CommentaryListResponse,
  CommentaryListResponseSchema,
  DeadEndsListQuerySchema,
  type DeadEndsListResponse,
  DeadEndsListResponseSchema,
  FellowCardQuerySchema,
  type FellowCardResponse,
  FellowCardResponseSchema,
  HonorsQuerySchema,
  type HonorsResponse,
  HonorsResponseSchema,
  isTrustedStoaOrigin,
  LedgerContractsSchema,
  NowStripQuerySchema,
  type NowStripResponse,
  NowStripResponseSchema,
  type ProblemFaceResponse,
  ProblemFaceResponseSchema,
  type ProblemsIndexResponse,
  ProblemsIndexResponseSchema,
  PublicClaimTargetSchema,
  PublicLedgerProblemIdSchema,
  PUBLIC_MOVES_PAGE_SIZE,
  PublicMovesQuerySchema,
  type PublicMovesResponse,
  PublicMovesResponseSchema,
  type SearchResponse,
  SearchResponseSchema,
} from "@asimposium/contracts";
import {
  HypothesesQuerySchema,
  type HypothesesResponse,
  HypothesesResponseSchema,
  HypothesisItemQuerySchema,
  PublicHypothesisIdSchema,
} from "@asimposium/contracts/hypotheses";
import type { PublicWatchTarget } from "@asimposium/contracts/public-watch";
import { type ProofGapsResponse, ProofGapsResponseSchema } from "@asimposium/contracts/proof-gaps";
import { type EventTailPage, EventTailResponseSchema, eventTailPath } from "@asimposium/contracts/event-tail";
import {
  ReviewQueueQuerySchema,
  type ReviewQueueResponse,
  ReviewQueueResponseSchema,
} from "@asimposium/contracts/review-queue";
import { deadEndsMatchView } from "./dead-end-view";
import { eventHistoryMatchesQuery, parseEventHistoryQuery } from "./event-history";
import { publicReadWatch } from "./public-watch-view";
import { parsePublicRecord, type PublicRecord, type PublicRecordTarget } from "./public-record";
import { parseProofGapQuery, proofGapQueryString, proofGapsMatchQuery } from "./proof-gap-view";
import { humanReviewQueuePath, reviewQueueMatchesQuery } from "./review-queue-view";
import { configuredStoaOrigin } from "./stoa";

export const PUBLIC_LEDGER_TIMEOUT_MS = 3_000;
export const PUBLIC_LEDGER_MAX_BYTES = 1024 * 1024;
const PUBLIC_READ_USER_AGENT =
  "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)";

export type PublicRead<T> =
  | {
      readonly state: "ok";
      readonly data: T;
      readonly origin: string;
      readonly noindex?: true;
      readonly watch?: PublicWatchTarget;
    }
  | { readonly state: "not_found"; readonly origin: string }
  | {
      readonly state: "unavailable";
      readonly reason:
        | "configuration"
        | "http"
        | "invalid_response"
        | "oversize"
        | "timeout"
        | "network";
    };

/** One bounded read boundary for every public Agora projection. Empty lists are valid data. */
export async function readPublic<T>(
  path: string,
  origin: string | undefined,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  revalidate: number,
  missingCode?: string,
  missingCursorCode?: "CURSOR_INVALID",
): Promise<PublicRead<T>> {
  if (origin === undefined || !isTrustedStoaOrigin(origin)) {
    return { state: "unavailable", reason: "configuration" };
  }
  const controller = new AbortController();
  let expired = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  // The deadline races the fetch itself so an abort-ignoring implementation
  // cannot hold the caller past the configured timeout.
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
    // Cancel pending body reads as well as the connection, including cached response streams.
    void reader?.cancel().catch(() => undefined);
    deadline.reject(new Error("read_deadline"));
  }, PUBLIC_LEDGER_TIMEOUT_MS);
  try {
    const pending = fetch(`${origin}${path}`, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": PUBLIC_READ_USER_AGENT },
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      next: { revalidate },
    });
    // A late response from an abort-ignoring fetch must not leak its body
    // after the caller has already returned timeout.
    void pending.then(
      (late) => {
        if (expired) void late.body?.cancel().catch(() => undefined);
      },
      () => undefined,
    );
    const response = await Promise.race([pending, deadline.promise]);
    if (expired) {
      void response.body?.cancel().catch(() => undefined);
      return { state: "unavailable", reason: "timeout" };
    }
    if (
      response.status !== 200 &&
      !(response.status === 404 && missingCode) &&
      !(response.status === 400 && missingCursorCode)
    ) {
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
    if (response.status === 404 || response.status === 400) {
      // A missing route on an old deployment is not a missing scientific object.
      if (
        typeof value === "object" &&
        value !== null &&
        "code" in value &&
        value.code === (response.status === 404 ? missingCode : missingCursorCode) &&
        "status" in value &&
        value.status === response.status
      ) {
        return { state: "not_found", origin };
      }
      return { state: "unavailable", reason: "http" };
    }
    const parsed = schema.safeParse(value);
    return parsed.success
      ? {
          state: "ok",
          data: parsed.data,
          origin,
          ...publicReadWatch(path, response.headers),
          ...(/(?:^|[,\s])(?:noindex|none)(?:$|[,\s])/i.test(
            response.headers.get("x-robots-tag") ?? "",
          )
            ? { noindex: true as const }
            : {}),
        }
      : { state: "unavailable", reason: "invalid_response" };
  } catch {
    return { state: "unavailable", reason: expired ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}

/** Current public item faces share the bounded transport and source indexing policy. */
export async function stoaFetchPublicRecord(
  target: PublicRecordTarget,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<PublicRead<PublicRecord>> {
  if (target.kind === "event") {
    const sequence = Number(target.recordId);
    if (
      !PublicLedgerProblemIdSchema.safeParse(target.problemId).success ||
      !Number.isSafeInteger(sequence) || sequence < 1
    ) {
      return { state: "unavailable", reason: "invalid_response" };
    }
    const query = { since: sequence - 1, limit: 1 };
    // This generated query has no through/wait and is already a safe integer.
    // The canonical tail can reject its cursor only when it is beyond the head.
    // Scope this missing-event interpretation to exact reads, never history input.
    const result = await readPublic(
      eventTailPath(target.problemId, "json", query),
      stoaOrigin,
      EventTailResponseSchema,
      0,
      "PROBLEM_NOT_FOUND",
      "CURSOR_INVALID",
    );
    if (result.state !== "ok") return result;
    if (!eventHistoryMatchesQuery(result.data, target.problemId, query)) {
      return { state: "unavailable", reason: "invalid_response" };
    }
    if (result.data.events.length === 0) return { state: "not_found", origin: result.origin };
    const record = parsePublicRecord(result.data, target);
    return record === null
      ? { state: "unavailable", reason: "invalid_response" }
      : { ...result, data: record };
  }
  return readPublic<PublicRecord>(
    target.jsonPath,
    stoaOrigin,
    {
      safeParse(value: unknown) {
        const data = parsePublicRecord(value, target);
        return data === null ? { success: false as const } : { success: true as const, data };
      },
    },
    0,
    "PROBLEM_NOT_FOUND",
  );
}

/** Bounded public history. Historical cuts retain current content controls;
 * never cache a formerly disclosed event across a later visibility change. */
export async function stoaFetchEventHistory(
  problemId: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<EventTailPage>> {
  const parsed = parseEventHistoryQuery(query);
  if (!PublicLedgerProblemIdSchema.safeParse(problemId).success || parsed === null) {
    return { state: "unavailable", reason: "invalid_response" };
  }
  const result = await readPublic(
    eventTailPath(problemId, "json", parsed),
    stoaOrigin,
    EventTailResponseSchema,
    0,
    "PROBLEM_NOT_FOUND",
  );
  if (result.state !== "ok") return result;
  return eventHistoryMatchesQuery(result.data, problemId, parsed)
    ? result
    : { state: "unavailable", reason: "invalid_response" };
}

/**
 * Public problem digest face (W6.1 / W8.3).
 * Fetches the canonical JSON face from the configured Stoa deployment.
 */
export async function stoaFetchProblemFace(
  problemId: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<PublicRead<ProblemFaceResponse>> {
  return readPublic(
    `/p/${encodeURIComponent(problemId)}.json`,
    stoaOrigin,
    ProblemFaceResponseSchema,
    0,
    "PROBLEM_NOT_FOUND",
  );
}

/** Public scientific records, freshly revalidated so content withdrawal wins. */
export async function stoaFetchClaimFace(
  problemId: string,
  target: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
  query: { through?: string | string[] } = {},
): Promise<PublicRead<ClaimFaceResponse>> {
  const parsedQuery = ClaimFaceQuerySchema.safeParse(query);
  if (
    !parsedQuery.success ||
    !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
    !PublicClaimTargetSchema.safeParse(target).success
  ) {
    return { state: "unavailable", reason: "invalid_response" };
  }
  const result = await readPublic(
    `/p/${encodeURIComponent(problemId)}/claims/${encodeURIComponent(target)}.json${parsedQuery.data.through === undefined ? "" : `?through=${parsedQuery.data.through}`}`,
    stoaOrigin,
    ClaimFaceResponseSchema,
    0,
    "CLAIM_NOT_FOUND",
  );
  if (result.state !== "ok") return result;
  const [claimId, version] = target.split("@");
  if (
    result.data.problem !== problemId ||
    result.data.claim_state.claim_id !== claimId ||
    (parsedQuery.data.through !== undefined &&
      result.data.cursor !== Number(parsedQuery.data.through)) ||
    (version !== undefined && result.data.claim_state.version !== Number(version))
  ) {
    return { state: "unavailable", reason: "invalid_response" };
  }
  return result;
}

/** Public hypotheses preserve the requested ledger cut and continuation. */
export async function stoaFetchHypotheses(
  problemId: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<HypothesesResponse>> {
  const parsed = HypothesesQuerySchema.safeParse(query);
  if (!parsed.success || !PublicLedgerProblemIdSchema.safeParse(problemId).success) {
    return { state: "unavailable", reason: "invalid_response" };
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) params.set(key, value);
  }
  const result = await readPublic(
    `/p/${encodeURIComponent(problemId)}/hypotheses.json${params.size === 0 ? "" : `?${params}`}`,
    stoaOrigin,
    HypothesesResponseSchema,
    0,
    "PROBLEM_NOT_FOUND",
  );
  if (result.state !== "ok") return result;
  if (
    result.data.problem_id !== problemId ||
    result.data.after !== Number(parsed.data.after ?? 0) ||
    (parsed.data.through !== undefined && result.data.cursor !== Number(parsed.data.through))
  ) {
    return { state: "unavailable", reason: "invalid_response" };
  }
  return result;
}

/** Gap lists and exact targets use the same ledger snapshot and current controls. */
export async function stoaFetchProofGaps(
  problemId: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<ProofGapsResponse>> {
  const parsed = parseProofGapQuery(query);
  if (parsed === null || !PublicLedgerProblemIdSchema.safeParse(problemId).success)
    return { state: "unavailable", reason: "invalid_response" };
  const result = await readPublic(
    `/p/${encodeURIComponent(problemId)}/gaps.json${proofGapQueryString(parsed)}`,
    stoaOrigin, ProofGapsResponseSchema, 0, "PROBLEM_NOT_FOUND",
  );
  if (result.state !== "ok") return result;
  return proofGapsMatchQuery(problemId, parsed, result.data)
    ? result : { state: "unavailable", reason: "invalid_response" };
}

/** Exact hypothesis reads never infer absence from a bounded collection page. */
export async function stoaFetchHypothesis(
  problemId: string,
  hypothesisId: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<HypothesesResponse>> {
  const parsed = HypothesisItemQuerySchema.safeParse(query);
  if (
    !parsed.success ||
    !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
    !PublicHypothesisIdSchema.safeParse(hypothesisId).success
  ) {
    return { state: "unavailable", reason: "invalid_response" };
  }
  const suffix = parsed.data.through === undefined ? "" : `?through=${parsed.data.through}`;
  const result = await readPublic(
    `/p/${encodeURIComponent(problemId)}/hypotheses/${encodeURIComponent(hypothesisId)}.json${suffix}`,
    stoaOrigin,
    HypothesesResponseSchema,
    0,
    "PROBLEM_NOT_FOUND",
  );
  if (result.state !== "ok") return result;
  if (
    result.data.problem_id !== problemId ||
    result.data.hypotheses.length !== 1 ||
    result.data.hypotheses[0]?.hypothesis_id !== hypothesisId ||
    result.data.after !== 0 ||
    result.data.next_after !== null ||
    (parsed.data.through !== undefined && result.data.cursor !== Number(parsed.data.through))
  ) {
    return { state: "unavailable", reason: "invalid_response" };
  }
  return result;
}

/**
 * Public problems index (W6.1 / W8.2).
 * Fetches the problem index list, preserving a verified empty index.
 */
export async function stoaFetchProblemsIndex(
  stoaOrigin: string | undefined = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<ProblemsIndexResponse>> {
  const parsed = LedgerContractsSchema.shape.problems_index_query.unwrap().safeParse(query);
  if (!parsed.success) return { state: "unavailable", reason: "invalid_response" };
  const after = parsed.data.after;
  const result = await readPublic(
    `/problems.json${after === undefined ? "" : `?after=${encodeURIComponent(after)}`}`,
    stoaOrigin,
    ProblemsIndexResponseSchema,
    10,
  );
  if (result.state !== "ok") return result;
  const { problems, next_after } = result.data;
  if (
    problems.some((entry, i) => entry.id <= (problems[i - 1]?.id ?? after ?? "")) ||
    (next_after !== undefined && next_after !== problems.at(-1)?.id)
  ) {
    return { state: "unavailable", reason: "invalid_response" };
  }
  return result;
}

/**
 * Public search (W6.8).
 * Fetches search results, preserving a verified empty match set.
 */
export async function stoaFetchSearch(
  query: string,
  kind?: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
  cursor?: string,
): Promise<PublicRead<SearchResponse>> {
  const params = new URLSearchParams({ q: query });
  if (kind && kind !== "all") params.set("kind", kind);
  // The cursor is bound to q/kind/limit; Agora always uses the default limit.
  if (cursor !== undefined) params.set("cursor", cursor);
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
  return readPublic(
    `/area/${encodeURIComponent(slug)}.json`,
    stoaOrigin,
    AreaDetailResponseSchema,
    15,
    "AREA_NOT_FOUND",
  );
}

/**
 * Public Now strip (W8.2 / Fable §9.6).
 * Fetches the recent material events stream.
 */
export async function stoaFetchNowStrip(
  stoaOrigin: string | undefined = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<NowStripResponse>> {
  const parsed = NowStripQuerySchema.safeParse(query);
  if (!parsed.success) return { state: "unavailable", reason: "invalid_response" };
  const { before } = parsed.data;
  return readPublic(
    `/now.json${before === undefined ? "" : `?before=${encodeURIComponent(before)}`}`,
    stoaOrigin,
    NowStripResponseSchema,
    5,
  );
}

/**
 * Public Honors Record (W9.7 / Fable §9.5).
 * Fetches the chronological settled results stream (/results.json).
 */
export async function stoaFetchHonorsRecord(
  stoaOrigin: string | undefined = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<HonorsResponse>> {
  const parsed = HonorsQuerySchema.safeParse(query);
  if (!parsed.success) return { state: "unavailable", reason: "invalid_response" };
  const { before } = parsed.data;
  return readPublic(
    `/results.json${before === undefined ? "" : `?before=${encodeURIComponent(before)}`}`,
    stoaOrigin,
    HonorsResponseSchema,
    5,
  );
}

/**
 * Public Fellow card (W8.2 / Fable §9.5).
 * Fetches calibration record and promoted contributions for a Fellow by name or ID.
 */
export async function stoaFetchFellowCard(
  nameOrId: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<FellowCardResponse>> {
  const parsed = FellowCardQuerySchema.safeParse(query);
  if (!parsed.success) return { state: "unavailable", reason: "invalid_response" };
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) parameters.set(key, value);
  }
  const path = nameOrId.startsWith("F-")
    ? `/fellows/${encodeURIComponent(nameOrId)}.json`
    : `/a/${encodeURIComponent(nameOrId)}.json`;
  const suffix = parameters.size === 0 ? "" : `?${parameters}`;
  return readPublic(
    `${path}${suffix}`,
    stoaOrigin,
    FellowCardResponseSchema,
    0,
    "FELLOW_NOT_FOUND",
  );
}

/** Public negative evidence, with current and superseded-history views kept distinct. */
export async function stoaFetchDeadEnds(
  problemId: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<DeadEndsListResponse>> {
  const parsed = DeadEndsListQuerySchema.safeParse(query);
  if (
    !parsed.success ||
    !DeadEndsListResponseSchema.shape.problem_id.safeParse(problemId).success
  ) {
    return { state: "unavailable", reason: "invalid_response" };
  }
  const includeSuperseded =
    parsed.data.include_superseded === "true" || parsed.data.include_superseded === "1";
  const suffix = includeSuperseded ? "?include_superseded=true" : "";
  const result = await readPublic(
    `/p/${encodeURIComponent(problemId)}/dead-ends.json${suffix}`,
    stoaOrigin,
    DeadEndsListResponseSchema,
    0,
    "PROBLEM_NOT_FOUND",
  );
  if (result.state !== "ok") return result;
  return deadEndsMatchView(problemId, result.data, includeSuperseded)
    ? result
    : { state: "unavailable", reason: "invalid_response" };
}

/** Public needs use the canonical Worker selection, without browser identity
 * or a persistent cache that could retain hidden work. */
export async function stoaFetchPublicMoves(
  query: unknown = {},
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<PublicRead<PublicMovesResponse>> {
  const parsed = PublicMovesQuerySchema.safeParse(query);
  if (!parsed.success) return { state: "unavailable", reason: "invalid_response" };
  const suffix = parsed.data.after ? `?${new URLSearchParams({ after: parsed.data.after })}` : "";
  const result = await readPublic(`/moves.json${suffix}`, stoaOrigin, PublicMovesResponseSchema, 0);
  if (result.state !== "ok") return result;
  const discovery = result.data.discovery;
  const ids = discovery.problems.map(problem => problem.problem_id);
  if (new Set(ids).size !== ids.length || discovery.scanned !== ids.length ||
    ids.some(id => id <= (parsed.data.after ?? "")) ||
    (discovery.next_after !== null && (ids.length !== PUBLIC_MOVES_PAGE_SIZE || [...ids].sort().at(-1) !== discovery.next_after)))
    return { state: "unavailable", reason: "invalid_response" };
  return result;
}

/** Anonymous review discovery shares the same bounded, uncached public-read seam. */
export async function stoaFetchReviewQueue(
  query: unknown = {},
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<PublicRead<ReviewQueueResponse>> {
  const parsed = ReviewQueueQuerySchema.safeParse(query);
  if (!parsed.success) return { state: "unavailable", reason: "invalid_response" };
  const suffix = humanReviewQueuePath(parsed.data).slice("/reviews".length);
  const result = await readPublic(
    `/reviews.json${suffix}`,
    stoaOrigin,
    ReviewQueueResponseSchema,
    0,
  );
  if (result.state !== "ok") return result;
  return reviewQueueMatchesQuery(parsed.data, result.data)
    ? result
    : { state: "unavailable", reason: "invalid_response" };
}

/**
 * Public sponsor commentary lane (W8.3a / Rule A2).
 * Fenced off from default scientific packs, claims, and moves.
 */
export async function stoaFetchCommentary(
  problemId: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<CommentaryListResponse>> {
  const parsedQuery = CommentaryListQuerySchema.safeParse(query);
  if (!PublicLedgerProblemIdSchema.safeParse(problemId).success || !parsedQuery.success) {
    return { state: "unavailable", reason: "invalid_response" };
  }
  const { cursor, limit } = parsedQuery.data;
  const params = new URLSearchParams();
  if (cursor !== 0) params.set("cursor", String(cursor));
  if (limit !== 50) params.set("limit", String(limit));
  const result = await readPublic(
    `/p/${encodeURIComponent(problemId)}/commentary.json${params.size === 0 ? "" : `?${params.toString()}`}`,
    stoaOrigin,
    CommentaryListResponseSchema,
    0,
    "PROBLEM_NOT_FOUND",
  );
  if (result.state !== "ok") return result;
  const page = result.data;
  let previous = cursor;
  const seen = new Set<string>();
  for (const item of page.commentaries) {
    if (
      item.problem_id !== problemId ||
      item.seq <= previous ||
      seen.has(item.commentary_id) ||
      (item.tombstoned ? item.body !== null || item.relates_to.length !== 0 : item.body === null)
    )
      return { state: "unavailable", reason: "invalid_response" };
    previous = item.seq;
    seen.add(item.commentary_id);
  }
  if (
    page.problem_id !== problemId ||
    page.commentaries.length > limit ||
    page.cursor !== previous ||
    (page.has_more && page.commentaries.length !== limit)
  )
    return { state: "unavailable", reason: "invalid_response" };
  return result;
}

/**
 * Public problem citations list (W5.8c / W8.3).
 * Fetches the committed literature record for a problem.
 */
export async function stoaFetchCitations(
  problemId: string,
  stoaOrigin: string | undefined = configuredStoaOrigin(),
): Promise<PublicRead<CitationsListResponse>> {
  if (!PublicLedgerProblemIdSchema.safeParse(problemId).success) {
    return { state: "unavailable", reason: "invalid_response" };
  }
  return readPublic(
    `/p/${encodeURIComponent(problemId)}/citations.json`,
    stoaOrigin,
    CitationsListResponseSchema,
    0,
    "PROBLEM_NOT_FOUND",
  );
}
