import {
  ClaimDependencyPinsSchema,
  GapFileRequestSchema,
  GapTransitionRequestSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import { readProofGaps } from "../ledger/proof-gaps-read.ts";
import { checkedScientificPayload, ScientificInputError } from "../ledger/scientific-checks.ts";
import type { HonorsClaimRecord, HonorsSourceWitness } from "./honors-provenance.ts";

/** Context describes real publication relationships, not mutable graph caches
 * or an author's unearned assertion that addressing a gap closed it. Reads
 * are bounded; the feed names incomplete context rather than claiming absence. */
export async function readHonorsDagContexts(
  db: D1Database,
  problem: string,
  through: number,
  records: ReadonlyMap<string, HonorsClaimRecord>,
): Promise<{ omitted: string[] }> {
  const omitted = new Set<string>();
  const result = await db
    .prepare(`WITH publications AS MATERIALIZED (
      SELECT e.*, c.payload_json,
        ROW_NUMBER() OVER (ORDER BY e.seq DESC) AS ordinal,
        SUM(CASE WHEN length(CAST(c.payload_json AS BLOB))<=65536
          THEN length(CAST(c.payload_json AS BLOB)) ELSE 0 END)
          OVER (ORDER BY e.seq DESC) AS total_bytes
      FROM events e LEFT JOIN event_content c ON c.event_id=e.id
        AND c.payload_sha256=e.payload_sha256 AND c.redacted_at IS NULL
      WHERE e.problem_id=? AND e.seq<=? AND e.object_kind='claim'
        AND e.type IN ('claim.created','claim.revised')
        AND NOT EXISTS (SELECT 1 FROM events newer WHERE newer.problem_id=e.problem_id
          AND newer.object_kind='claim' AND newer.object_id=e.object_id
          AND newer.type IN ('claim.created','claim.revised') AND newer.seq>e.seq AND newer.seq<=?)
        AND NOT ${eventContentHiddenSql("e")}
      ORDER BY e.seq DESC LIMIT 101
    ) SELECT id, seq, type, object_id, object_version, payload_sha256,
      actor_fellow_id AS fellow, actor_sponsor_id AS sponsor,
      CASE WHEN ordinal<=100 AND total_bytes<=262144
        AND length(CAST(payload_json AS BLOB))<=65536 THEN payload_json END AS payload_json
    FROM publications ORDER BY seq`)
    .bind(problem, through, through)
    .all<{
      id: string;
      seq: number;
      type: string;
      object_id: string;
      object_version: number;
      payload_sha256: string;
      payload_json: string | null;
      fellow: string | null;
      sponsor: string | null;
    }>();
  for (const row of result.results) {
    if (row.payload_json === null) {
      omitted.add(
        "some downstream publication context is unavailable or exceeds its 100-publication / 256 KiB budget",
      );
      continue;
    }
    try {
      const body = await checkedScientificPayload({
        payload_json: row.payload_json,
        payload_sha256: row.payload_sha256,
      });
      const pins = ClaimDependencyPinsSchema.safeParse(body.dependency_pins);
      if (
        body.claim_id !== row.object_id ||
        !pins.success ||
        (row.object_version > 1 && body.base_version !== row.object_version - 1)
      ) {
        omitted.add("some downstream publication context has unavailable dependency pins");
        continue;
      }
      for (const pin of pins.data) {
        const record = records.get(`${pin.claim_id}@${pin.version}`);
        if (
          record &&
          pin.event_id === record.publication.eventId &&
          pin.payload_digest === record.publication.payloadDigest &&
          pin.content_digest === record.publication.contentDigest
        ) {
          record.item.dag_context.unlocks.push(`${row.object_id}@${row.object_version}`);
          record.contextWitnesses.push({
            event: row.id,
            seq: row.seq,
            digest: row.payload_sha256,
            body: row.payload_json,
            fellow: row.fellow,
            sponsor: row.sponsor,
          });
        }
      }
    } catch (error) {
      if (!(error instanceof ScientificInputError)) throw error;
      omitted.add("some downstream publication context has unavailable source bytes");
    }
  }
  const page = await readProofGaps(
    db,
    problem,
    { through },
    {
      filed: (value) => GapFileRequestSchema.safeParse(value).data ?? null,
      settled: (value) => GapTransitionRequestSchema.safeParse(value).data ?? null,
    },
  );
  for (const gap of page.face.gaps) {
    if (gap.status !== "closed-by" || gap.closed_by === null) continue;
    const credited: HonorsClaimRecord[] = [];
    for (const record of records.values()) {
      if (
        gap.closed_by !== record.item.result_id &&
        gap.closed_by !== `${record.item.result_id}@${record.version}`
      )
        continue;
      // A closure that names only an identity cannot credit a later revision.
      // The closing event must have occurred during this exact version's life.
      const publication = await db
        .prepare(`SELECT object_version FROM events
        WHERE problem_id=? AND object_id=? AND object_kind='claim'
          AND type IN ('claim.created','claim.revised') AND seq<=?
        ORDER BY seq DESC LIMIT 1`)
        .bind(problem, record.item.result_id, gap.last_event.seq)
        .first<{ object_version: number }>();
      if (publication?.object_version === record.version) credited.push(record);
    }
    if (credited.length === 0) continue;
    // The canonical gap face has verified its bounded history, but returns
    // decoded content. Retain its exact filing and closure bytes as well so
    // the final honors page check can detect later hiding or redaction.
    const pins = [
      { ...gap.filing, type: "gap.filed" },
      { ...gap.last_event, type: "gap.closed-by" },
    ];
    const sources = await db
      .prepare(`SELECT e.id AS event, e.seq, e.payload_sha256 AS digest,
        c.payload_json AS body, e.actor_fellow_id AS fellow, e.actor_sponsor_id AS sponsor
      FROM json_each(?) pin JOIN events e
        ON e.id=json_extract(pin.value,'$.event_id') AND e.problem_id=?
        AND e.seq=json_extract(pin.value,'$.seq')
        AND e.payload_sha256=json_extract(pin.value,'$.payload_sha256')
        AND e.created_at=json_extract(pin.value,'$.created_at')
        AND e.actor_fellow_id IS json_extract(pin.value,'$.fellow_id')
        AND e.actor_sponsor_id IS json_extract(pin.value,'$.sponsor_id')
        AND e.type=json_extract(pin.value,'$.type')
        AND e.object_kind='gap' AND e.object_id=? AND e.object_version=1 AND e.seq<=?
      JOIN event_content c ON c.event_id=e.id AND c.payload_sha256=e.payload_sha256
        AND c.redacted_at IS NULL AND length(CAST(c.payload_json AS BLOB))<=16384
      JOIN problems p ON p.id=e.problem_id AND p.status<>'private-draft' AND p.unlisted=0
      WHERE NOT ${eventContentHiddenSql("e")}
      ORDER BY e.seq LIMIT 2`)
      .bind(JSON.stringify(pins), problem, gap.gap_id, through)
      .all<HonorsSourceWitness>();
    if (sources.results.length !== 2) {
      omitted.add("some proof-gap closure sources are no longer publicly available");
      continue;
    }
    try {
      for (const source of sources.results)
        await checkedScientificPayload({
          payload_json: source.body,
          payload_sha256: source.digest,
        });
    } catch (error) {
      if (!(error instanceof ScientificInputError)) throw error;
      omitted.add("some proof-gap closure sources have unavailable source bytes");
      continue;
    }
    for (const record of credited) {
      record.item.dag_context.closes_gaps.push(gap.gap_id);
      record.contextWitnesses.push(...sources.results);
    }
  }
  if (page.face.omitted.length > 0)
    omitted.add(
      "proof-gap context is bounded to eight canonical filings; unavailable or later closures are omitted",
    );
  for (const record of records.values()) {
    record.item.dag_context.unlocks = [...new Set(record.item.dag_context.unlocks)].sort();
    record.item.dag_context.closes_gaps.sort();
  }
  return { omitted: [...omitted] };
}
