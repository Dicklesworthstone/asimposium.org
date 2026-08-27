/**
 * W2.8 restore: rebuild one problem's durable Krater state from a v3 export
 * bundle — the inverse of backup.ts's nightly export.
 *
 * The verify-first law: the export's integrity chain is verified BEFORE any
 * write is attempted, so a tampered or truncated bundle can never become a
 * half-restored problem. Refusals throw `KraterRestoreRefusedError` (code
 * `KRATER_RESTORE_REFUSED`) and no row is written by the refused restore.
 *
 * What is rebuilt, per verified event in sequence order:
 *   - the `problems` head row (public_seq/chain_digest advanced to each event,
 *     created_at from the first event, updated_at from the last event);
 *   - the `krater_integrity_backfill` completion marker the chain-head trigger
 *     requires;
 *   - the `events` envelope row, its `event_content` payload bytes, and the
 *     v2 chain sidecars (installed by the schema's own insert triggers);
 *   - the `integrity_checkpoints` rows carried in the header;
 *   - for `object_kind === "claim"` events, the `claims` projection row. A
 *     revision event re-naming an existing claim id is tolerated (first
 *     source wins) because claim-version replay is doctor/W2.6 scope.
 *
 * Projection rebuild for NON-claim kinds (gaps, relations, reviews,
 * hypotheses, evidence, ...) is doctor/W2.6 replay scope and deliberately not
 * attempted here — the ledger rows restore losslessly, the projections do not.
 *
 * Staged D1/R2 restore (pointing this routine at a live database with a
 * bucket-resident bundle) is provider execution and remains an ops item.
 */

import type { D1Database } from "@cloudflare/workers-types";

import { parseProblemExport, verifyProblemExportChain } from "./export.ts";
import { genesisChainDigest } from "./krater.ts";

/** Refusal of a restore BEFORE any durable write (the verify-first law). */
export class KraterRestoreRefusedError extends Error {
  readonly code = "KRATER_RESTORE_REFUSED";
}

export interface RestoreResult {
  /** The problem id the bundle restored (header problem authority). */
  readonly restored: string;
  readonly eventCount: number;
  readonly finalSeq: number;
  /** The last restored event's chain digest — the restored problem head. */
  readonly chainDigest: string;
}

function refused(detail: string): never {
  throw new KraterRestoreRefusedError(`restore refused: ${detail}`);
}

export async function restoreProblemExport(db: D1Database, ndjson: string): Promise<RestoreResult> {
  // Verify-first: refuse before any write. No problem row, no event row, no
  // sidecar may exist until the bundle has proven its own chain.
  const verification = await verifyProblemExportChain(ndjson);
  if (!verification.intact) {
    refused(
      verification.brokenAtSeq === null
        ? verification.detail
        : `${verification.detail} (broken at seq ${verification.brokenAtSeq})`,
    );
  }

  const parsed = parseProblemExport(ndjson);
  if (!parsed.ok) {
    // Unreachable: verifyProblemExportChain runs the same grammar. Refuse
    // rather than invent a write path from an unparseable bundle.
    refused(parsed.detail);
  }
  const problemId = parsed.header.problem;
  const events = parsed.events;
  const checkpoints = parsed.header.checkpoints;
  const first = events[0];
  const last = events[events.length - 1];
  if (first === undefined || last === undefined) {
    refused("an export with no events carries no restorable problem state");
  }

  // The chain-head trigger requires a v2-complete problem head at the exact
  // event being inserted, so the head row advances one event at a time.
  await db
    .prepare(
      "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_digest, chain_version) VALUES (?, 0, ?, ?, ?, 2)",
    )
    .bind(problemId, first.createdAt, first.createdAt, await genesisChainDigest(problemId))
    .run();
  await db
    .prepare(
      "INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version) VALUES (?, 'complete', 0, ?, 2)",
    )
    .bind(problemId, last.createdAt)
    .run();

  let nextCheckpoint = 0;
  for (const event of events) {
    await db
      .prepare("UPDATE problems SET public_seq = ?, chain_digest = ?, updated_at = ? WHERE id = ?")
      .bind(event.seq, event.chainDigest, event.createdAt, problemId)
      .run();
    await db
      .prepare(
        "INSERT INTO events (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, row_digest, chain_digest, created_at, actor_fellow_id, actor_sponsor_id, actor_session_id, model_string_self_declared, harness, writer_credential_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        event.eventId,
        problemId,
        event.seq,
        event.type,
        event.objectKind,
        event.objectId,
        event.objectVersion,
        event.payloadSha256,
        event.rowDigest,
        event.chainDigest,
        event.createdAt,
        event.actorFellowId,
        event.actorSponsorId,
        event.actorSessionId,
        event.modelStringSelfDeclared,
        event.harness,
        event.writerCredentialId,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO event_content (event_id, payload_sha256, payload_json) VALUES (?, ?, ?)",
      )
      .bind(event.eventId, event.payloadSha256, event.payloadJson)
      .run();

    const checkpoint = checkpoints[nextCheckpoint];
    if (checkpoint && checkpoint.checkpointSeq === event.seq) {
      await db
        .prepare(
          "INSERT INTO integrity_checkpoints (problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest, checkpoint_version, checkpoint_mode, created_at) VALUES (?, ?, ?, ?, 1, 'unsigned-v0', ?)",
        )
        .bind(
          problemId,
          checkpoint.checkpointSeq,
          checkpoint.rootChainDigest,
          checkpoint.checkpointDigest,
          event.createdAt,
        )
        .run();
      nextCheckpoint += 1;
    }

    if (event.objectKind === "claim") {
      let statement: unknown;
      try {
        const payload: unknown = JSON.parse(event.payloadJson);
        statement =
          payload !== null && typeof payload === "object" && "statement" in payload
            ? payload.statement
            : undefined;
      } catch {
        statement = undefined;
      }
      if (typeof statement !== "string") {
        refused(`claim event ${event.eventId} payload does not carry a statement`);
      }
      await db
        .prepare(
          "INSERT OR IGNORE INTO claims (id, problem_id, statement, payload_sha256, source_seq, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(event.objectId, problemId, statement, event.payloadSha256, event.seq, event.createdAt)
        .run();
    }
  }

  return {
    restored: problemId,
    eventCount: events.length,
    finalSeq: parsed.trailer.finalCursor,
    chainDigest: last.chainDigest,
  };
}
