/**
 * Launch-scope Fable §10.2 transactional outbox consumers (cn2n).
 *
 * Consumer registry:
 *   - search.index          (existing FTS5 indexer in outbox-do.ts)
 *   - embedding.compute     PUBLIC CONTENT ONLY — hard PRIVATE_CONTENT_FORBIDDEN
 *                           fence against workshop_objects & private-draft;
 *                           persists model/version provenance + cosine-similarity
 *                           possible-duplicate advisories feeding collapse-duplicate.
 *   - synthesis.staleness   Marks published syntheses stale when newer material
 *                           events land past covers_through (Fable §9.6).
 *   - og.invalidate         Records cursor-keyed share-card invalidation watermark.
 *   - notification.fanout   Idempotent unified inbox + Herald wake-up dispatch.
 *   - screening.enrich      SSRF-safe local metadata/citation extraction only
 *                           (zero outbound fetches; never alters L1 screening).
 *
 * `webhook.deliver` remains explicitly Tier-2 deferred per Fable §17.2.
 */

import type { Ai, D1Database } from "@cloudflare/workers-types";
import { deliverHeraldRooms, type HeraldNamespace } from "../herald/outbox.ts";
import { deliverInboxEvents } from "../inbox/event-delivery.ts";
import { synthesisMaterialEventSql } from "../ledger/synthesis-events.ts";
import { sha256Hex } from "./krater.ts";
import { eventContentHiddenSql, hiddenByContentControlSql } from "./public-content.ts";

export const OUTBOX_LAUNCH_KINDS = [
  "search.index",
  "embedding.compute",
  "synthesis.staleness",
  "og.invalidate",
  "notification.fanout",
  "screening.enrich",
] as const;

export type OutboxJobKind = (typeof OUTBOX_LAUNCH_KINDS)[number];

export const OUTBOX_LAUNCH_KIND_SET: ReadonlySet<string> = new Set(OUTBOX_LAUNCH_KINDS);

export const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const DEFAULT_EMBEDDING_MODEL_VERSION = "workers-ai-v1";
export const SEMANTIC_DUPLICATE_THRESHOLD = 0.85;
export const MAX_EMBEDDING_TEXT_CHARS = 8_192;
export const MAX_PEER_EMBEDDINGS_PER_PROBLEM = 200;

export interface EmbeddingResult {
  readonly vector: readonly number[];
  readonly modelId: string;
  readonly modelVersion: string;
}

export type EmbedTextFn = (text: string) => Promise<EmbeddingResult>;

export interface OutboxConsumerRow {
  readonly id: number;
  readonly event_id: string;
  readonly problem_id: string;
  readonly kind: string;
  readonly dedupe_key: string;
  readonly payload_sha256: string;
}

export interface OutboxConsumerEnv {
  readonly DB: D1Database;
  readonly AI?: Ai;
  readonly HERALD_ROOMS?: HeraldNamespace;
  readonly embedText?: EmbedTextFn;
}

export class OutboxConsumerSourceError extends Error {
  readonly code: "OUTBOX_PAYLOAD_INVALID" | "PRIVATE_CONTENT_FORBIDDEN";
  constructor(
    code: "OUTBOX_PAYLOAD_INVALID" | "PRIVATE_CONTENT_FORBIDDEN" = "OUTBOX_PAYLOAD_INVALID",
  ) {
    super(code);
    this.code = code;
  }
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? Number.NaN;
    const y = b[i] ?? Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA <= 0 || normB <= 0) return 0;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Number.isFinite(sim) ? Math.max(0, Math.min(1, sim)) : 0;
}

function normalizeVector(raw: readonly number[]): number[] | null {
  if (raw.length === 0 || raw.length > 4096) return null;
  let normSq = 0;
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    normSq += v * v;
  }
  if (normSq <= 0) return null;
  const norm = Math.sqrt(normSq);
  return raw.map((v) => Math.round((v / norm) * 1_000_000) / 1_000_000);
}

async function computeWorkersAiEmbedding(ai: Ai, text: string): Promise<EmbeddingResult> {
  const output = (await ai.run(DEFAULT_EMBEDDING_MODEL as Parameters<Ai["run"]>[0], {
    text: [text.slice(0, MAX_EMBEDDING_TEXT_CHARS)],
  })) as { data?: number[][] };
  const first = output?.data?.[0];
  if (!Array.isArray(first) || first.length === 0) {
    throw new Error("EMBEDDING_PROVIDER_EMPTY");
  }
  return {
    vector: first,
    modelId: DEFAULT_EMBEDDING_MODEL,
    modelVersion: DEFAULT_EMBEDDING_MODEL_VERSION,
  };
}

/** Enqueue an idempotent outbox job in D1 (`INSERT OR IGNORE` on `dedupe_key`). */
export async function enqueueOutboxJob(
  db: D1Database,
  input: {
    readonly eventId: string;
    readonly problemId: string;
    readonly kind: OutboxJobKind;
    readonly payloadSha256: string;
    readonly createdAt?: string;
  },
): Promise<void> {
  const dedupeKey = `${input.kind}:${input.eventId}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO outbox (event_id, problem_id, kind, dedupe_key, payload_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.eventId,
      input.problemId,
      input.kind,
      dedupeKey,
      input.payloadSha256,
      input.createdAt ?? new Date().toISOString(),
    )
    .run();
}

interface PublicClaimEmbeddingSource {
  readonly event_id: string;
  readonly problem_id: string;
  readonly problem_status: string;
  readonly object_kind: string;
  readonly claim_id: string;
  readonly version: number;
  readonly seq: number;
  readonly public_seq: number;
  readonly payload_sha256: string;
  readonly payload_json: string | null;
  readonly redacted_at: string | null;
  readonly hidden: number;
}

/**
 * PUBLIC-ONLY embedding consumer (Rule A2 / Fable §10.3).
 * Hard fail-closed guard: workshop IDs (`W-*`), non-public problems
 * (`private-draft`), hidden controls, and redacted rows ALWAYS throw
 * `PRIVATE_CONTENT_FORBIDDEN` BEFORE invoking any embedding provider.
 */
async function applyEmbeddingCompute(
  row: OutboxConsumerRow,
  env: OutboxConsumerEnv,
): Promise<void> {
  if (row.event_id.startsWith("W-") || row.problem_id.startsWith("W-")) {
    throw new OutboxConsumerSourceError("PRIVATE_CONTENT_FORBIDDEN");
  }
  // Explicitly verify the ID is NOT a private workshop object even if someone
  // bypassed foreign-key checks or forged an outbox row in SQLite.
  const workshopHit = await env.DB.prepare(
    "SELECT 1 AS hit FROM workshop_objects WHERE workshop_id = ? LIMIT 1",
  )
    .bind(row.event_id)
    .first<{ hit: number }>()
    .catch(() => null);
  if (workshopHit !== null) {
    throw new OutboxConsumerSourceError("PRIVATE_CONTENT_FORBIDDEN");
  }

  const source = await env.DB.prepare(
    `SELECT e.id AS event_id, e.problem_id, p.status AS problem_status, e.object_kind,
            e.object_id AS claim_id, e.object_version AS version, e.seq, p.public_seq,
            e.payload_sha256, c.payload_json, c.redacted_at,
            CASE WHEN ${hiddenByContentControlSql("p.id", "'problem'")}
                   OR ${eventContentHiddenSql("e")} THEN 1 ELSE 0 END AS hidden
     FROM events e
     JOIN problems p ON p.id = e.problem_id
     LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
     WHERE e.id = ? AND e.problem_id = ? AND e.payload_sha256 = ?`,
  )
    .bind(row.event_id, row.problem_id, row.payload_sha256)
    .first<PublicClaimEmbeddingSource>();

  if (source === null) {
    throw new OutboxConsumerSourceError("OUTBOX_PAYLOAD_INVALID");
  }
  if (
    source.problem_status === "private-draft" ||
    source.object_kind === "workshop" ||
    source.hidden === 1 ||
    source.redacted_at !== null ||
    source.seq > source.public_seq
  ) {
    throw new OutboxConsumerSourceError("PRIVATE_CONTENT_FORBIDDEN");
  }
  if (source.object_kind !== "claim" || source.payload_json === null) {
    throw new OutboxConsumerSourceError("OUTBOX_PAYLOAD_INVALID");
  }
  const actualSha = await sha256Hex(source.payload_json);
  if (actualSha !== source.payload_sha256) {
    throw new OutboxConsumerSourceError("OUTBOX_PAYLOAD_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.payload_json);
  } catch {
    throw new OutboxConsumerSourceError("OUTBOX_PAYLOAD_INVALID");
  }
  const statement =
    parsed !== null &&
    typeof parsed === "object" &&
    typeof (parsed as { statement?: unknown }).statement === "string"
      ? (parsed as { statement: string }).statement.trim()
      : "";
  if (statement.length === 0) {
    throw new OutboxConsumerSourceError("OUTBOX_PAYLOAD_INVALID");
  }

  let embedding: EmbeddingResult;
  if (env.embedText !== undefined) {
    embedding = await env.embedText(statement.slice(0, MAX_EMBEDDING_TEXT_CHARS));
  } else if (env.AI !== undefined) {
    embedding = await computeWorkersAiEmbedding(env.AI, statement);
  } else {
    throw new Error("EMBEDDING_PROVIDER_UNAVAILABLE");
  }

  const normalized = normalizeVector(embedding.vector);
  if (normalized === null) {
    throw new Error("EMBEDDING_VECTOR_INVALID");
  }
  const nowIso = new Date().toISOString();

  // Re-verify public, non-redacted, non-hidden visibility atomically at commit time
  // so a claim hidden/redacted concurrently during async embedding inference never
  // persists an embedding or emits duplicate advisories.
  const stored = await env.DB.prepare(
    `INSERT INTO public_claim_embeddings
       (problem_id, claim_id, version, event_id, payload_sha256, model_id, model_version, dimensions, vector_json, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM events e
       JOIN problems p ON p.id = e.problem_id
       JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
       WHERE e.id = ? AND e.problem_id = ? AND e.payload_sha256 = ?
         AND p.status <> 'private-draft'
         AND e.seq <= p.public_seq
         AND c.redacted_at IS NULL
         AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
         AND NOT ${eventContentHiddenSql("e")}
     )
     ON CONFLICT(problem_id, claim_id, version) DO UPDATE SET
       event_id = excluded.event_id,
       payload_sha256 = excluded.payload_sha256,
       model_id = excluded.model_id,
       model_version = excluded.model_version,
       dimensions = excluded.dimensions,
       vector_json = excluded.vector_json,
       created_at = excluded.created_at`,
  )
    .bind(
      source.problem_id,
      source.claim_id,
      source.version,
      source.event_id,
      source.payload_sha256,
      embedding.modelId,
      embedding.modelVersion,
      normalized.length,
      JSON.stringify(normalized),
      nowIso,
      source.event_id,
      source.problem_id,
      source.payload_sha256,
    )
    .run();
  if ((stored.meta?.changes ?? 0) !== 1) {
    throw new OutboxConsumerSourceError("PRIVATE_CONTENT_FORBIDDEN");
  }

  // Compare against latest embeddings of other non-retracted, non-hidden public claims in the same problem.
  const peers = await env.DB.prepare(
    `SELECT e.claim_id, e.version, e.vector_json
     FROM public_claim_embeddings e
     JOIN claims c ON c.problem_id = e.problem_id AND c.id = e.claim_id
     JOIN events ev ON ev.id = e.event_id AND ev.problem_id = e.problem_id
     JOIN event_content ec ON ec.event_id = ev.id AND ec.payload_sha256 = ev.payload_sha256
       AND ec.redacted_at IS NULL
     WHERE e.problem_id = ? AND e.claim_id <> ?
       AND e.model_id = ? AND e.model_version = ? AND e.dimensions = ?
       AND NOT ${eventContentHiddenSql("ev")}
       AND e.version = (
         SELECT MAX(v.version) FROM public_claim_embeddings v
         WHERE v.problem_id = e.problem_id AND v.claim_id = e.claim_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM retractions r
         WHERE r.problem_id = e.problem_id
           AND r.target_object IN (e.claim_id, e.claim_id || '@' || e.version)
       )
     ORDER BY e.claim_id ASC
     LIMIT ?`,
  )
    .bind(
      source.problem_id,
      source.claim_id,
      embedding.modelId,
      embedding.modelVersion,
      normalized.length,
      MAX_PEER_EMBEDDINGS_PER_PROBLEM,
    )
    .all<{ claim_id: string; version: number; vector_json: string }>();

  for (const peer of peers.results) {
    let peerVec: unknown;
    try {
      peerVec = JSON.parse(peer.vector_json);
    } catch {
      continue;
    }
    if (!Array.isArray(peerVec)) continue;
    const sim = cosineSimilarity(normalized, peerVec as number[]);
    if (sim < SEMANTIC_DUPLICATE_THRESHOLD) continue;

    // Canonical lexical pair ordering guarantees exactly-once rows under concurrent/replayed runs.
    const [leftClaim, leftVer, rightClaim, rightVer] =
      source.claim_id < peer.claim_id
        ? [source.claim_id, source.version, peer.claim_id, peer.version]
        : [peer.claim_id, peer.version, source.claim_id, source.version];

    await env.DB.prepare(
      `INSERT INTO public_duplicate_advisories
         (problem_id, source_claim_id, source_version, matched_claim_id, matched_version,
          similarity, model_id, model_version, source_event_id, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM events se
         JOIN problems sp ON sp.id = se.problem_id
         JOIN event_content sc ON sc.event_id = se.id AND sc.payload_sha256 = se.payload_sha256
         WHERE se.id = ? AND se.problem_id = ? AND se.payload_sha256 = ?
           AND sp.status <> 'private-draft'
           AND se.seq <= sp.public_seq
           AND sc.redacted_at IS NULL
           AND NOT ${hiddenByContentControlSql("sp.id", "'problem'")}
           AND NOT ${eventContentHiddenSql("se")}
       ) AND EXISTS (
         SELECT 1 FROM public_claim_embeddings pe
         JOIN events pev ON pev.id = pe.event_id AND pev.problem_id = pe.problem_id
         JOIN event_content pec ON pec.event_id = pev.id AND pec.payload_sha256 = pev.payload_sha256
         WHERE pe.problem_id = ? AND pe.claim_id = ? AND pe.version = ?
           AND pec.redacted_at IS NULL
           AND NOT ${eventContentHiddenSql("pev")}
       )
       ON CONFLICT(problem_id, source_claim_id, source_version, matched_claim_id, matched_version)
       DO UPDATE SET
         similarity = excluded.similarity,
         model_id = excluded.model_id,
         model_version = excluded.model_version,
         source_event_id = excluded.source_event_id,
         created_at = excluded.created_at`,
    )
      .bind(
        source.problem_id,
        leftClaim,
        leftVer,
        rightClaim,
        rightVer,
        Math.round(sim * 10_000) / 10_000,
        embedding.modelId,
        embedding.modelVersion,
        source.event_id,
        nowIso,
        source.event_id,
        source.problem_id,
        source.payload_sha256,
        source.problem_id,
        peer.claim_id,
        peer.version,
      )
      .run();
  }
}

async function applySynthesisStaleness(
  row: OutboxConsumerRow,
  env: OutboxConsumerEnv,
): Promise<void> {
  const ev = await env.DB.prepare(
    `SELECT e.id, e.problem_id, e.seq, p.status AS problem_status,
            CASE WHEN ${synthesisMaterialEventSql("e")} THEN 1 ELSE 0 END AS is_material
     FROM events e JOIN problems p ON p.id = e.problem_id
     WHERE e.id = ? AND e.problem_id = ? AND e.payload_sha256 = ?`,
  )
    .bind(row.event_id, row.problem_id, row.payload_sha256)
    .first<{
      id: string;
      problem_id: string;
      seq: number;
      problem_status: string;
      is_material: number;
    }>();
  if (ev === null) throw new OutboxConsumerSourceError("OUTBOX_PAYLOAD_INVALID");
  if (ev.problem_status === "private-draft") {
    throw new OutboxConsumerSourceError("PRIVATE_CONTENT_FORBIDDEN");
  }
  if (ev.is_material !== 1) return;

  const nowIso = new Date().toISOString();
  // Conditional upsert WHERE avoids SQLite's left-to-right SET evaluation trap
  // (where mutating stale_since_seq first would make a subsequent CASE compare
  // against the already-updated value and leave stale_since_event_id stale).
  await env.DB.prepare(
    `INSERT INTO synthesis_staleness_markers (problem_id, synthesis_id, stale_since_seq, stale_since_event_id, updated_at)
     SELECT s.problem_id, s.synthesis_id, ?, ?, ?
     FROM syntheses s
     WHERE s.problem_id = ? AND s.covers_through < ?
     ON CONFLICT(problem_id, synthesis_id) DO UPDATE SET
       stale_since_seq = excluded.stale_since_seq,
       stale_since_event_id = excluded.stale_since_event_id,
       updated_at = excluded.updated_at
     WHERE excluded.stale_since_seq < synthesis_staleness_markers.stale_since_seq`,
  )
    .bind(ev.seq, ev.id, nowIso, ev.problem_id, ev.seq)
    .run();
}

async function applyOgInvalidate(row: OutboxConsumerRow, env: OutboxConsumerEnv): Promise<void> {
  const ev = await env.DB.prepare(
    `SELECT e.id, e.problem_id, e.seq, p.status AS problem_status
     FROM events e JOIN problems p ON p.id = e.problem_id
     WHERE e.id = ? AND e.problem_id = ? AND e.payload_sha256 = ?`,
  )
    .bind(row.event_id, row.problem_id, row.payload_sha256)
    .first<{ id: string; problem_id: string; seq: number; problem_status: string }>();
  if (ev === null) throw new OutboxConsumerSourceError("OUTBOX_PAYLOAD_INVALID");
  if (ev.problem_status === "private-draft") {
    throw new OutboxConsumerSourceError("PRIVATE_CONTENT_FORBIDDEN");
  }
  const nowIso = new Date().toISOString();
  // Conditional upsert WHERE ensures both last_invalidated_seq and last_event_id
  // advance atomically only on strictly higher sequences.
  await env.DB.prepare(
    `INSERT INTO og_invalidation_markers (problem_id, last_invalidated_seq, last_event_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(problem_id) DO UPDATE SET
       last_invalidated_seq = excluded.last_invalidated_seq,
       last_event_id = excluded.last_event_id,
       updated_at = excluded.updated_at
     WHERE excluded.last_invalidated_seq > og_invalidation_markers.last_invalidated_seq`,
  )
    .bind(ev.problem_id, ev.seq, ev.id, nowIso)
    .run();
}

async function applyNotificationFanout(
  row: OutboxConsumerRow,
  env: OutboxConsumerEnv,
): Promise<void> {
  const ev = await env.DB.prepare(
    `SELECT e.id, p.status AS problem_status
     FROM events e JOIN problems p ON p.id = e.problem_id
     WHERE e.id = ? AND e.problem_id = ? AND e.payload_sha256 = ?`,
  )
    .bind(row.event_id, row.problem_id, row.payload_sha256)
    .first<{ id: string; problem_status: string }>();
  if (ev === null) throw new OutboxConsumerSourceError("OUTBOX_PAYLOAD_INVALID");
  if (ev.problem_status === "private-draft") {
    throw new OutboxConsumerSourceError("PRIVATE_CONTENT_FORBIDDEN");
  }
  // Both dispatchers are already idempotent/CAS-guarded on their own outboxes.
  await deliverInboxEvents(env.DB);
  if (env.HERALD_ROOMS !== undefined) {
    await deliverHeraldRooms(env.DB, env.HERALD_ROOMS);
  }
}

/** SSRF-safe async metadata/citation enrichment (zero network I/O; never alters L1 screening). */
async function applyScreeningEnrich(row: OutboxConsumerRow, env: OutboxConsumerEnv): Promise<void> {
  const ev = await env.DB.prepare(
    `SELECT e.id, e.problem_id, e.object_kind, e.seq, p.public_seq, e.payload_sha256,
            c.payload_json, c.redacted_at, p.status AS problem_status,
            CASE WHEN ${hiddenByContentControlSql("p.id", "'problem'")}
                   OR ${eventContentHiddenSql("e")} THEN 1 ELSE 0 END AS hidden
     FROM events e
     JOIN problems p ON p.id = e.problem_id
     LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
     WHERE e.id = ? AND e.problem_id = ? AND e.payload_sha256 = ?`,
  )
    .bind(row.event_id, row.problem_id, row.payload_sha256)
    .first<{
      id: string;
      problem_id: string;
      object_kind: string;
      seq: number;
      public_seq: number;
      payload_sha256: string;
      payload_json: string | null;
      redacted_at: string | null;
      problem_status: string;
      hidden: number;
    }>();
  if (ev === null) throw new OutboxConsumerSourceError("OUTBOX_PAYLOAD_INVALID");
  if (ev.problem_status === "private-draft" || ev.hidden === 1 || ev.seq > ev.public_seq) {
    throw new OutboxConsumerSourceError("PRIVATE_CONTENT_FORBIDDEN");
  }
  if (ev.redacted_at !== null || ev.payload_json === null) return;
  const actualSha = await sha256Hex(ev.payload_json);
  if (actualSha !== ev.payload_sha256)
    throw new OutboxConsumerSourceError("OUTBOX_PAYLOAD_INVALID");

  // Purely local lexical extraction of DOI / arXiv / HTTPS locator counts (SSRF-safe: zero HTTP fetches).
  const citationMatches = ev.payload_json.match(
    /\b(?:10\.\d{4,9}\/[^\s"\\]+|arXiv:\d{4}\.\d{4,5})\b/gi,
  );
  const locatorMatches = ev.payload_json.match(/https:\/\/[^\s"\\]+/gi);
  const citationCount = citationMatches?.length ?? 0;
  const locatorCount = locatorMatches?.length ?? 0;
  const nowIso = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO screening_enrichment_records
       (event_id, problem_id, object_kind, citation_count, locator_count, enriched_at)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM events e
       JOIN problems p ON p.id = e.problem_id
       JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
       WHERE e.id = ? AND e.problem_id = ? AND e.payload_sha256 = ?
         AND p.status <> 'private-draft'
         AND e.seq <= p.public_seq
         AND c.redacted_at IS NULL
         AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
         AND NOT ${eventContentHiddenSql("e")}
     )
     ON CONFLICT(event_id) DO UPDATE SET
       citation_count = excluded.citation_count,
       locator_count = excluded.locator_count,
       enriched_at = excluded.enriched_at`,
  )
    .bind(
      ev.id,
      ev.problem_id,
      ev.object_kind,
      citationCount,
      locatorCount,
      nowIso,
      ev.id,
      ev.problem_id,
      ev.payload_sha256,
    )
    .run();
}

export async function dispatchExtendedOutboxConsumer(
  row: OutboxConsumerRow,
  env: OutboxConsumerEnv,
): Promise<void> {
  switch (row.kind) {
    case "embedding.compute":
      await applyEmbeddingCompute(row, env);
      return;
    case "synthesis.staleness":
      await applySynthesisStaleness(row, env);
      return;
    case "og.invalidate":
      await applyOgInvalidate(row, env);
      return;
    case "notification.fanout":
      await applyNotificationFanout(row, env);
      return;
    case "screening.enrich":
      await applyScreeningEnrich(row, env);
      return;
    default:
      throw new OutboxConsumerSourceError("OUTBOX_PAYLOAD_INVALID");
  }
}
