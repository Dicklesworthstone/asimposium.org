/**
 * Per-problem event export (W2.8): the public dataset, the agent warm-up
 * format, and the exit hatch, all one file. `/p/<slug>/export.jsonl.gz` is the
 * NDJSON event stream with the integrity checkpoints embedded — tamper-evident
 * and verifiable offline for the cost of one hash per write (Fable §10.2).
 *
 * Format (Fable §7): one complete event per line, terminated by a control
 * record so a consumer never guesses whether the export completed. The
 * integrity checkpoints ride in the header record, so a mirror can verify the
 * chain without a second fetch.
 *
 * Pure serialization; the route supplies the events, checkpoints, and the
 * license line. Nothing here touches a socket.
 */

import type { KraterCheckpoint, KraterEvent } from "./krater.ts";

/** The license line every public export carries (CC BY 4.0, Fable §10). */
export const EXPORT_LICENSE = "CC BY 4.0";

/** The export format version, so a consumer can reject a future shape. */
export const EXPORT_FORMAT = "asimposium.problem-export.v1";

export interface ProblemExportInput {
  readonly problemId: string;
  readonly problemTitle: string;
  readonly events: readonly KraterEvent[];
  readonly checkpoints: readonly KraterCheckpoint[];
  /** ISO date the export was generated (server-authored). */
  readonly generatedAt: string;
}

/**
 * Serialize a problem export to NDJSON. Layout:
 *   line 1: the header control record (format, license, checkpoints)
 *   lines 2..n-1: one event per line, in ledger sequence order
 *   line n: the terminal control record (event count + final cursor)
 */
export function serializeProblemExport(input: ProblemExportInput): string {
  const header = {
    control: "export_header",
    format: EXPORT_FORMAT,
    license: EXPORT_LICENSE,
    problem: input.problemId,
    title: input.problemTitle,
    generated_at: input.generatedAt,
    checkpoints: input.checkpoints.map((c) => ({
      checkpoint_seq: c.checkpointSeq,
      root_chain_digest: c.rootChainDigest,
      checkpoint_digest: c.checkpointDigest,
      checkpoint_version: c.checkpointVersion,
      checkpoint_mode: c.checkpointMode,
    })),
  };
  const eventLines = input.events.map((event) =>
    JSON.stringify({
      event_id: event.eventId,
      seq: event.seq,
      type: event.type,
      object_id: event.objectId,
      payload_sha256: event.payloadSha256,
      row_digest: event.rowDigest,
      chain_digest: event.chainDigest,
      created_at: event.createdAt,
    }),
  );
  const trailer = {
    control: "export_end",
    problem: input.problemId,
    event_count: input.events.length,
    final_cursor: input.events[input.events.length - 1]?.seq ?? 0,
  };
  return [JSON.stringify(header), ...eventLines, JSON.stringify(trailer)].join("\n") + "\n";
}

/**
 * Parse and validate an export's header line — the consumer-side contract. A
 * mirror reads this first to confirm the format and extract the checkpoints
 * before trusting any event line.
 */
export function parseExportHeader(line: string):
  | { readonly ok: true; readonly format: string; readonly license: string; readonly checkpointCount: number }
  | { readonly ok: false; readonly reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: "header is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "header is not an object" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.control !== "export_header") {
    return { ok: false, reason: "first line is not the export header" };
  }
  if (record.format !== EXPORT_FORMAT) {
    return { ok: false, reason: `unrecognized export format: ${String(record.format)}` };
  }
  const checkpoints = Array.isArray(record.checkpoints) ? record.checkpoints.length : 0;
  return {
    ok: true,
    format: EXPORT_FORMAT,
    license: String(record.license),
    checkpointCount: checkpoints,
  };
}
