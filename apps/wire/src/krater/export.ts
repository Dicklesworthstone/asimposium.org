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
  return `${[JSON.stringify(header), ...eventLines, JSON.stringify(trailer)].join("\n")}\n`;
}

/**
 * Parse and validate an export's header line — the consumer-side contract. A
 * mirror reads this first to confirm the format and extract the checkpoints
 * before trusting any event line.
 */
export function parseExportHeader(line: string):
  | {
      readonly ok: true;
      readonly format: string;
      readonly license: string;
      readonly checkpointCount: number;
    }
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

/**
 * Verify an export's integrity chain (Fable §10.2 tamper-evidence, and the
 * restore drill's core check). Recomputes the chain over the event lines and
 * confirms each link, then confirms the final chain digest matches the last
 * embedded checkpoint's root. A mirror can run this offline against only the
 * export bytes — no D1, no Worker.
 *
 * Returns the first broken link, or null when the chain is intact end to end.
 * This is async because the digest is a WebCrypto SHA-256.
 */
export async function verifyProblemExportChain(
  ndjson: string,
): Promise<
  | { readonly intact: true; readonly eventCount: number; readonly finalChainDigest: string }
  | { readonly intact: false; readonly brokenAtSeq: number; readonly detail: string }
  | { readonly intact: false; readonly brokenAtSeq: null; readonly detail: string }
> {
  const lines = ndjson.split("\n").filter((line) => line.length > 0);
  const headerLine = lines[0];
  if (headerLine === undefined) {
    return { intact: false, brokenAtSeq: null, detail: "empty export" };
  }
  const header = parseExportHeader(headerLine);
  if (!header.ok) {
    return { intact: false, brokenAtSeq: null, detail: header.reason };
  }

  const headerRecord = JSON.parse(headerLine) as {
    readonly problem?: string;
    readonly checkpoints?: readonly { readonly root_chain_digest?: string }[];
  };
  const problemId = headerRecord.problem;
  if (typeof problemId !== "string" || problemId.length === 0) {
    return { intact: false, brokenAtSeq: null, detail: "header carries no problem id" };
  }

  // Event lines are everything between the header and the terminal control
  // record. The trailer is the last line; anything after the header that is
  // not the trailer is an event.
  const eventLines = lines.slice(1, -1);
  const { genesisChainDigest, eventChainDigest } = await import("./krater.ts");
  let previous = await genesisChainDigest(problemId);
  let expectedSeq = 1;

  for (const line of eventLines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { intact: false, brokenAtSeq: expectedSeq, detail: "event line is not JSON" };
    }
    const seq = event.seq;
    const payloadSha256 = event.payload_sha256;
    const chainDigest = event.chain_digest;
    if (
      typeof seq !== "number" ||
      typeof payloadSha256 !== "string" ||
      typeof chainDigest !== "string"
    ) {
      return {
        intact: false,
        brokenAtSeq: expectedSeq,
        detail: "event line is missing seq or digests",
      };
    }
    if (seq !== expectedSeq) {
      return {
        intact: false,
        brokenAtSeq: expectedSeq,
        detail: `sequence gap: expected seq ${expectedSeq}, found ${seq}`,
      };
    }
    const recomputed = await eventChainDigest(problemId, seq, payloadSha256, previous);
    if (recomputed !== chainDigest) {
      return {
        intact: false,
        brokenAtSeq: seq,
        detail: `chain digest mismatch at seq ${seq} — the export is tampered or truncated`,
      };
    }
    previous = chainDigest;
    expectedSeq += 1;
  }

  // If the header embedded checkpoints, the final chain must match the last
  // one's root. Absent checkpoints, the recomputed chain is the evidence.
  const checkpoints = headerRecord.checkpoints ?? [];
  const lastRoot = checkpoints[checkpoints.length - 1]?.root_chain_digest;
  if (lastRoot !== undefined && lastRoot !== previous) {
    return {
      intact: false,
      brokenAtSeq: null,
      detail: "the final chain digest does not match the embedded checkpoint root",
    };
  }

  return { intact: true, eventCount: eventLines.length, finalChainDigest: previous };
}
