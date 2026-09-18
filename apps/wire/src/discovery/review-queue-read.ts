import type {
  ReviewQueueItem,
  ReviewQueueQuery,
  ReviewQueueResponse,
} from "@asimposium/contracts/review-queue";
import {
  REVIEW_QUEUE_BOUNDARY,
  REVIEW_QUEUE_PAGE_SIZE,
  REVIEW_QUEUE_SCHEMA_ID,
  reviewQueueAfter,
} from "@asimposium/contracts/review-queue";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { claimContentDigest } from "../krater/claim-version";
import type { ScientificDisposition, ScientificRow } from "../ledger/scientific-disposition";
import { type ReviewQueueSnapshot, readReviewAdmissions } from "./review-queue-admissions";
import { rankReviewQueue, reviewNeed } from "./review-queue-selection";
import {
  REVIEW_QUEUE_MAX_DEPENDENTS,
  REVIEW_QUEUE_MAX_SCOPE_BYTES,
  REVIEW_QUEUE_MAX_SCOPE_EVENTS,
  REVIEW_QUEUE_METADATA_SQL,
} from "./review-queue-sql";

export interface ReviewAdmission {
  problem_id: string;
  cursor: number;
  claim_id: string;
  admission_id: string;
  created_at: string;
  head_id: string;
  version: number;
  scope_events: number;
  scope_bytes: number;
}
export interface ReviewMetadata {
  problem_id: string;
  event_id: string;
  claim_id: string;
  version: number;
  seq: number;
  payload_sha256: string;
  payload_json: string | null;
  admission_id: string;
  created_at: string;
  author_fellow_id: string;
  author_sponsor_id: string;
  author_payload_sha256: string;
  author_payload_json: string | null;
  kind: string;
  statement: string;
  falsifier: string | null;
  content_digest: string;
  dependents_json: string;
}

/** Only the production adapter supplies these functions. Request data cannot
 * replace the scientific evaluator. The seam lets query/selection unit tests
 * distinguish their own fixtures from a full scientific workflow proof. */
export interface ReviewQueueScience {
  prepare(
    db: D1Database,
    problem: string,
    cursor: number,
    limit: number,
    target: { claimId: string; version: number },
  ): D1PreparedStatement;
  fold(rows: readonly ScientificRow[]): Promise<ScientificDisposition>;
}

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function content(
  text: string | null,
  expected: string,
): Promise<Record<string, unknown> | undefined> {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).byteLength > 32768 ||
    !/^[0-9a-f]{64}$/.test(expected) ||
    (await digest(text)) !== expected
  )
    return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Verify dependency payloads before using their pins as discovery context.
 * The bounded count is explicitly not a proof that those implications hold. */
export async function verifiedReviewDependents(
  row: ReviewMetadata,
): Promise<{ count: number; capped: boolean }> {
  const values: unknown = JSON.parse(row.dependents_json);
  if (!Array.isArray(values) || values.length > REVIEW_QUEUE_MAX_DEPENDENTS + 1) {
    throw new Error("REVIEW_QUEUE_DEPENDENCIES_INVALID");
  }
  const seen = new Set<string>();
  for (const value of values.slice(0, REVIEW_QUEUE_MAX_DEPENDENTS)) {
    if (value === null || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.claim_id !== "string" ||
      entry.claim_id === row.claim_id ||
      typeof entry.payload_json !== "string" ||
      typeof entry.payload_sha256 !== "string"
    )
      continue;
    const payload = await content(entry.payload_json, entry.payload_sha256);
    if (!payload || payload.claim_id !== entry.claim_id || !Array.isArray(payload.dependency_pins))
      continue;
    if (
      payload.dependency_pins.some((value: unknown) => {
        if (value === null || typeof value !== "object") return false;
        const pin = value as Record<string, unknown>;
        return (
          pin.claim_id === row.claim_id &&
          pin.version === row.version &&
          pin.event_id === row.event_id &&
          pin.payload_digest === row.payload_sha256 &&
          pin.content_digest === row.content_digest
        );
      })
    )
      seen.add(entry.claim_id);
  }
  return { count: seen.size, capped: values.length > REVIEW_QUEUE_MAX_DEPENDENTS };
}

/** No mutable statement or sponsor is substituted for the exact publication. */
export async function verifiedReviewMetadata(
  admission: ReviewAdmission,
  row: ReviewMetadata,
): Promise<boolean> {
  if (
    row.problem_id !== admission.problem_id ||
    row.claim_id !== admission.claim_id ||
    row.version !== admission.version ||
    row.event_id !== admission.head_id ||
    row.admission_id !== admission.admission_id ||
    row.created_at !== admission.created_at ||
    !Number.isSafeInteger(row.seq) ||
    row.seq < 1 ||
    row.seq > admission.cursor ||
    ![row.author_fellow_id, row.author_sponsor_id].every(
      (x) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x),
    ) ||
    typeof row.kind !== "string" ||
    typeof row.statement !== "string" ||
    !(row.falsifier === null || typeof row.falsifier === "string")
  )
    return false;
  const payload = await content(row.payload_json, row.payload_sha256);
  const author = await content(row.author_payload_json, row.author_payload_sha256);
  if (
    !payload ||
    !author ||
    author.claim_id !== row.claim_id ||
    payload.claim_id !== row.claim_id ||
    payload.statement !== row.statement ||
    (row.version > 1 && payload.base_version !== row.version - 1)
  )
    return false;
  return (
    (await claimContentDigest(
      { kind: row.kind, statement: row.statement, falsifier: row.falsifier },
      digest,
    )) === row.content_digest
  );
}

export async function readReviewQueue(
  db: D1Database,
  query: ReviewQueueQuery,
  science: ReviewQueueScience,
  snapshot?: ReviewQueueSnapshot,
): Promise<ReviewQueueResponse> {
  const rows = await readReviewAdmissions(db, query, snapshot);
  const scanned = rows.slice(0, REVIEW_QUEUE_PAGE_SIZE);
  const counts = new Map<ReviewQueueResponse["omitted"][number]["reason"], number>();
  const omit = (reason: ReviewQueueResponse["omitted"][number]["reason"]) =>
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const admitted: ReviewAdmission[] = [];
  for (const row of scanned) {
    reviewQueueAfter(row.created_at, row.admission_id);
    if (
      !Number.isSafeInteger(row.cursor) ||
      row.cursor < 1 ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1 ||
      !Number.isSafeInteger(row.scope_events) ||
      row.scope_events < 1 ||
      !Number.isSafeInteger(row.scope_bytes) ||
      row.scope_bytes < 0
    ) {
      throw new Error("REVIEW_QUEUE_DISCOVERY_INVALID");
    }
    if (
      row.scope_events > REVIEW_QUEUE_MAX_SCOPE_EVENTS ||
      row.scope_bytes > REVIEW_QUEUE_MAX_SCOPE_BYTES
    ) {
      omit("scope_budget_exceeded");
    } else admitted.push(row);
  }
  // Captured cuts prevent a later append increasing these guarded histories.
  // Metadata and scientific inputs share one read transaction. No per-review I/O.
  const statements = admitted.flatMap((row) => [
    db
      .prepare(REVIEW_QUEUE_METADATA_SQL)
      .bind(row.cursor, row.cursor, row.cursor, row.head_id, row.problem_id, row.cursor),
    science.prepare(db, row.problem_id, row.cursor, 1, {
      claimId: row.claim_id,
      version: row.version,
    }),
  ]);
  const snapshots = statements.length === 0 ? [] : await db.batch(statements);
  if (snapshots.length !== statements.length) throw new Error("REVIEW_QUEUE_SNAPSHOT_INVALID");
  const candidates: ReviewQueueItem[] = [];
  for (const [index, admission] of admitted.entries()) {
    const row = snapshots[index * 2]?.results[0] as ReviewMetadata | undefined;
    const timeline = snapshots[index * 2 + 1]?.results as ScientificRow[] | undefined;
    if (!row || !(await verifiedReviewMetadata(admission, row))) {
      omit("content_unavailable");
      continue;
    }
    if (!Array.isArray(timeline)) throw new Error("REVIEW_QUEUE_SNAPSHOT_INVALID");
    const fold = await science.fold(
      timeline.filter((row) => row.target_version <= admission.version),
    );
    const need = reviewNeed(fold, row.author_fellow_id);
    if (
      !need ||
      fold.currentVersion !== admission.version ||
      (["conjecture", "theorem-attempt", "counterexample-claim", "bound"].includes(row.kind) &&
        !row.falsifier?.trim())
    ) {
      omit("not_review_ready");
      continue;
    }
    const dependents = await verifiedReviewDependents(row);
    candidates.push({
      problem_id: row.problem_id,
      claim_id: row.claim_id,
      version: row.version,
      cursor: admission.cursor,
      kind: row.kind,
      statement: row.statement,
      falsifier: row.falsifier,
      disposition: fold.disposition as ReviewQueueItem["disposition"],
      need: need.need,
      best_recorded_tier: need.bestRecordedTier,
      direct_dependents: dependents.count,
      dependents_capped: dependents.capped,
      author_fellow_id: row.author_fellow_id,
      author_sponsor_id: row.author_sponsor_id,
      created_at: row.created_at,
      read_url: `/p/${encodeURIComponent(row.problem_id)}/claims/${row.claim_id}@${row.version}.md?through=${admission.cursor}`,
    });
  }
  const last = scanned.at(-1);
  const hasMore = rows.length > REVIEW_QUEUE_PAGE_SIZE;
  if (hasMore) omit("page_limit");
  return {
    schema: REVIEW_QUEUE_SCHEMA_ID,
    policy: "review-discovery-v1",
    problem: query.problem ?? null,
    candidates: rankReviewQueue(candidates),
    scanned: scanned.length,
    next_after: hasMore && last ? reviewQueueAfter(last.created_at, last.admission_id) : null,
    selection_boundary: REVIEW_QUEUE_BOUNDARY,
    omitted: [...counts].map(([reason, count]) => ({ reason, count })),
  };
}
