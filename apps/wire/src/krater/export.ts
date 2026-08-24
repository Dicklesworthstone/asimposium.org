/**
 * Per-problem event export (W2.8): the public dataset, the agent warm-up
 * format, and the exit hatch, all one file. `/p/<slug>/export.jsonl.gz` is the
 * NDJSON event stream with integrity checkpoints embedded for strict offline
 * self-consistency verification (Fable §10.2).
 *
 * Format (Fable §7): one complete event per line, terminated by a control
 * record so a consumer never guesses whether the export completed. The
 * integrity checkpoints ride in the header record, so a mirror can verify the
 * chain without a second fetch.
 *
 * Pure serialization; the route supplies the events, checkpoints, and the
 * license line. Nothing here touches a socket.
 */

import {
  checkpointDigest,
  eventChainDigest,
  eventEnvelopeRowDigest,
  genesisChainDigest,
  KRATER_CHAIN_VERSION,
  type KraterCheckpoint,
  type KraterEvent,
} from "./krater.ts";

/** The license line every public export carries (CC BY 4.0, Fable §10). */
export const EXPORT_LICENSE = "CC BY 4.0";

/** The export format version, so a consumer can reject a future shape. */
export const EXPORT_FORMAT = "asimposium.problem-export.v2";

/** The `control` value of the first record. Named so the scan cannot drift. */
export const EXPORT_HEADER_CONTROL = "export_header";

/** The `control` value of the terminal record — the completion witness. */
export const EXPORT_TRAILER_CONTROL = "export_end";

const EXPORT_HEADER_KEYS = [
  "checkpoints",
  "control",
  "format",
  "generated_at",
  "license",
  "problem",
  "title",
] as const;

const EXPORT_CHECKPOINT_KEYS = [
  "chain_version",
  "checkpoint_digest",
  "checkpoint_mode",
  "checkpoint_seq",
  "checkpoint_version",
  "problem",
  "root_chain_digest",
] as const;

const EXPORT_EVENT_KEYS = [
  "actor_fellow_id",
  "actor_session_id",
  "actor_sponsor_id",
  "chain_digest",
  "chain_version",
  "created_at",
  "event_id",
  "harness",
  "model_string_self_declared",
  "object_id",
  "object_kind",
  "object_version",
  "payload_sha256",
  "row_digest",
  "seq",
  "type",
  "writer_credential_id",
] as const;

const EXPORT_TRAILER_KEYS = ["control", "event_count", "final_cursor", "problem"] as const;
const PROBLEM_ID = /^P-[A-Z0-9][A-Z0-9-]{1,30}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;
const MAX_IDENTIFIER_LENGTH = 160;
const MAX_TITLE_LENGTH = 160;

interface ParsedCheckpoint {
  readonly checkpointSeq: number;
  readonly rootChainDigest: string;
  readonly checkpointDigest: string;
}

interface ParsedHeader {
  readonly problem: string;
  readonly checkpoints: readonly ParsedCheckpoint[];
}

interface ParsedEvent {
  readonly eventId: string;
  readonly seq: number;
  readonly type: string;
  readonly objectKind: string;
  readonly objectId: string;
  readonly objectVersion: number;
  readonly payloadSha256: string;
  readonly rowDigest: string;
  readonly chainDigest: string;
  readonly createdAt: string;
  readonly actorFellowId: string | null;
  readonly actorSponsorId: string | null;
  readonly actorSessionId: string | null;
  readonly modelStringSelfDeclared: string | null;
  readonly harness: string | null;
  readonly writerCredentialId: string | null;
}

interface ParsedTrailer {
  readonly problem: string;
  readonly eventCount: number;
  readonly finalCursor: number;
}

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

type ExportParseResult =
  | {
      readonly ok: true;
      readonly header: ParsedHeader;
      readonly events: readonly ParsedEvent[];
      readonly trailer: ParsedTrailer;
    }
  | { readonly ok: false; readonly brokenAtSeq: number | null; readonly detail: string };

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function boundedNonBlankString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && value.trim().length > 0;
}

function nullableBoundedNonBlankString(
  value: unknown,
  maximum: number,
): value is string | null {
  return value === null || boundedNonBlankString(value, maximum);
}

function isProblemId(value: unknown): value is string {
  return typeof value === "string" && PROBLEM_ID.test(value);
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = UTC_TIMESTAMP.exec(value);
  if (match === null) return false;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return false;
  return (
    timestamp.getUTCFullYear() === Number(match[1]) &&
    timestamp.getUTCMonth() + 1 === Number(match[2]) &&
    timestamp.getUTCDate() === Number(match[3]) &&
    timestamp.getUTCHours() === Number(match[4]) &&
    timestamp.getUTCMinutes() === Number(match[5]) &&
    timestamp.getUTCSeconds() === Number(match[6])
  );
}

function parseJsonRecord(line: string, label: string): ParseResult<Record<string, unknown>> {
  if (line.includes("\n") || line.includes("\r")) {
    return { ok: false, reason: `${label} must be exactly one LF-free record` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: `${label} is not JSON` };
  }
  if (!isRecord(parsed)) return { ok: false, reason: `${label} is not an object` };
  return { ok: true, value: parsed };
}

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
    control: EXPORT_HEADER_CONTROL,
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
      chain_version: c.chainVersion,
      checkpoint_mode: c.checkpointMode,
      problem: c.problemId,
    })),
  };
  const eventLines = input.events.map((event) =>
    JSON.stringify({
      event_id: event.eventId,
      seq: event.seq,
      type: event.type,
      object_kind: event.objectKind,
      object_id: event.objectId,
      object_version: event.objectVersion,
      payload_sha256: event.payloadSha256,
      row_digest: event.rowDigest,
      chain_digest: event.chainDigest,
      chain_version: event.chainVersion,
      created_at: event.createdAt,
      actor_fellow_id: event.actorFellowId,
      actor_sponsor_id: event.actorSponsorId,
      actor_session_id: event.actorSessionId,
      model_string_self_declared: event.modelStringSelfDeclared,
      harness: event.harness,
      writer_credential_id: event.writerCredentialId,
    }),
  );
  const trailer = {
    control: EXPORT_TRAILER_CONTROL,
    problem: input.problemId,
    event_count: input.events.length,
    final_cursor: input.events[input.events.length - 1]?.seq ?? 0,
  };
  return `${[JSON.stringify(header), ...eventLines, JSON.stringify(trailer)].join("\n")}\n`;
}

function parseCheckpoint(
  value: unknown,
  problem: string,
  index: number,
): ParseResult<ParsedCheckpoint> {
  if (!isRecord(value) || !hasExactKeys(value, EXPORT_CHECKPOINT_KEYS)) {
    return { ok: false, reason: `header checkpoint ${index} does not have the exact v2 shape` };
  }
  if (value.problem !== problem) {
    return { ok: false, reason: `header checkpoint ${index} is not bound to the header problem` };
  }
  if (
    !positiveInteger(value.checkpoint_seq) ||
    !isSha256Hex(value.root_chain_digest) ||
    !isSha256Hex(value.checkpoint_digest) ||
    value.chain_version !== KRATER_CHAIN_VERSION ||
    value.checkpoint_version !== 1 ||
    value.checkpoint_mode !== "unsigned-v0"
  ) {
    return { ok: false, reason: `header checkpoint ${index} carries invalid v2 fields` };
  }
  return {
    ok: true,
    value: {
      checkpointSeq: value.checkpoint_seq,
      rootChainDigest: value.root_chain_digest,
      checkpointDigest: value.checkpoint_digest,
    },
  };
}

function parseHeaderRecord(line: string): ParseResult<ParsedHeader> {
  const parsed = parseJsonRecord(line, "header");
  if (!parsed.ok) return parsed;
  const record = parsed.value;
  if (!hasExactKeys(record, EXPORT_HEADER_KEYS)) {
    return { ok: false, reason: "header does not have the exact v2 shape" };
  }
  if (record.control !== EXPORT_HEADER_CONTROL) {
    return { ok: false, reason: "first line is not the export header" };
  }
  if (record.format !== EXPORT_FORMAT) {
    return { ok: false, reason: "header carries an unrecognized export format" };
  }
  if (record.license !== EXPORT_LICENSE) {
    return { ok: false, reason: "header carries an unrecognized export license" };
  }
  if (!isProblemId(record.problem)) {
    return { ok: false, reason: "header carries no valid problem id" };
  }
  if (!boundedNonBlankString(record.title, MAX_TITLE_LENGTH)) {
    return { ok: false, reason: "header carries no valid problem title" };
  }
  if (!isUtcTimestamp(record.generated_at)) {
    return { ok: false, reason: "header carries no valid generation timestamp" };
  }
  if (!Array.isArray(record.checkpoints)) {
    return { ok: false, reason: "header checkpoints are not an array" };
  }

  const checkpoints: ParsedCheckpoint[] = [];
  let previousCheckpointSeq = 0;
  for (const [offset, checkpoint] of record.checkpoints.entries()) {
    const parsedCheckpoint = parseCheckpoint(checkpoint, record.problem, offset + 1);
    if (!parsedCheckpoint.ok) return parsedCheckpoint;
    if (parsedCheckpoint.value.checkpointSeq <= previousCheckpointSeq) {
      return { ok: false, reason: "header checkpoints are not in strict sequence order" };
    }
    checkpoints.push(parsedCheckpoint.value);
    previousCheckpointSeq = parsedCheckpoint.value.checkpointSeq;
  }
  return { ok: true, value: { problem: record.problem, checkpoints } };
}

/** Parse an exact v2 header record for consumers that read it independently. */
export function parseExportHeader(line: string):
  | {
      readonly ok: true;
      readonly format: string;
      readonly license: string;
      readonly checkpointCount: number;
    }
  | { readonly ok: false; readonly reason: string } {
  const header = parseHeaderRecord(line);
  if (!header.ok) return header;
  return {
    ok: true,
    format: EXPORT_FORMAT,
    license: EXPORT_LICENSE,
    checkpointCount: header.value.checkpoints.length,
  };
}

function parseTrailerRecord(line: string): ParseResult<ParsedTrailer> {
  const parsed = parseJsonRecord(line, "terminal record");
  if (!parsed.ok) return parsed;
  const record = parsed.value;
  if (!hasExactKeys(record, EXPORT_TRAILER_KEYS)) {
    return { ok: false, reason: "terminal record does not have the exact v2 shape" };
  }
  if (record.control !== EXPORT_TRAILER_CONTROL) {
    return { ok: false, reason: "last line is not the export trailer" };
  }
  if (!isProblemId(record.problem)) {
    return { ok: false, reason: "terminal record carries no valid problem id" };
  }
  if (!nonNegativeInteger(record.event_count)) {
    return { ok: false, reason: "terminal record carries no exact event count" };
  }
  if (!nonNegativeInteger(record.final_cursor)) {
    return { ok: false, reason: "terminal record carries no exact final cursor" };
  }
  return {
    ok: true,
    value: {
      problem: record.problem,
      eventCount: record.event_count,
      finalCursor: record.final_cursor,
    },
  };
}

/** Parse an exact v2 terminal record for consumers that read it independently. */
export function parseExportTrailer(line: string):
  | {
      readonly ok: true;
      readonly problem: string;
      readonly eventCount: number;
      readonly finalCursor: number;
    }
  | { readonly ok: false; readonly reason: string } {
  const trailer = parseTrailerRecord(line);
  if (!trailer.ok) return trailer;
  return {
    ok: true,
    problem: trailer.value.problem,
    eventCount: trailer.value.eventCount,
    finalCursor: trailer.value.finalCursor,
  };
}

function parseEventRecord(line: string): ParseResult<ParsedEvent> {
  const parsed = parseJsonRecord(line, "event line");
  if (!parsed.ok) return parsed;
  const event = parsed.value;
  if (!hasExactKeys(event, EXPORT_EVENT_KEYS)) {
    return { ok: false, reason: "event line does not have the exact export shape" };
  }
  if (
    !boundedNonBlankString(event.event_id, MAX_IDENTIFIER_LENGTH) ||
    !positiveInteger(event.seq) ||
    !boundedNonBlankString(event.type, MAX_IDENTIFIER_LENGTH) ||
    !boundedNonBlankString(event.object_kind, MAX_IDENTIFIER_LENGTH) ||
    !boundedNonBlankString(event.object_id, MAX_IDENTIFIER_LENGTH) ||
    !positiveInteger(event.object_version) ||
    !isSha256Hex(event.payload_sha256) ||
    !isSha256Hex(event.row_digest) ||
    !isSha256Hex(event.chain_digest) ||
    event.chain_version !== KRATER_CHAIN_VERSION ||
    !isUtcTimestamp(event.created_at) ||
    !nullableBoundedNonBlankString(event.actor_fellow_id, MAX_IDENTIFIER_LENGTH) ||
    !nullableBoundedNonBlankString(event.actor_sponsor_id, MAX_IDENTIFIER_LENGTH) ||
    !nullableBoundedNonBlankString(event.actor_session_id, MAX_IDENTIFIER_LENGTH) ||
    !nullableBoundedNonBlankString(event.model_string_self_declared, MAX_IDENTIFIER_LENGTH) ||
    !nullableBoundedNonBlankString(event.harness, MAX_IDENTIFIER_LENGTH) ||
    !nullableBoundedNonBlankString(event.writer_credential_id, MAX_IDENTIFIER_LENGTH)
  ) {
    return {
      ok: false,
      reason: "event line carries invalid v2 envelope fields",
    };
  }
  return {
    ok: true,
    value: {
      eventId: event.event_id,
      seq: event.seq,
      type: event.type,
      objectKind: event.object_kind,
      objectId: event.object_id,
      objectVersion: event.object_version,
      payloadSha256: event.payload_sha256,
      rowDigest: event.row_digest,
      chainDigest: event.chain_digest,
      createdAt: event.created_at,
      actorFellowId: event.actor_fellow_id,
      actorSponsorId: event.actor_sponsor_id,
      actorSessionId: event.actor_session_id,
      modelStringSelfDeclared: event.model_string_self_declared,
      harness: event.harness,
      writerCredentialId: event.writer_credential_id,
    },
  };
}

function splitExactLfRecords(ndjson: string): ParseResult<readonly string[]> {
  if (ndjson.length === 0) return { ok: false, reason: "empty export" };
  if (ndjson.includes("\r")) return { ok: false, reason: "export must use LF line endings" };
  if (!ndjson.endsWith("\n")) return { ok: false, reason: "export must end with one LF" };
  const lines = ndjson.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) {
    return { ok: false, reason: "export carries a blank record" };
  }
  return { ok: true, value: lines };
}

/**
 * The sole v2 grammar: exact LF framing, then exact header, event, and trailer
 * records. It parses every record before integrity work so malformed,
 * reordered, appended, or blank records cannot become a tolerated prefix.
 */
function parseProblemExportV2(ndjson: string): ExportParseResult {
  const framed = splitExactLfRecords(ndjson);
  if (!framed.ok) return { ok: false, brokenAtSeq: null, detail: framed.reason };
  if (framed.value.length < 2) {
    return {
      ok: false,
      brokenAtSeq: null,
      detail: "export is missing its terminal control record",
    };
  }

  const header = parseHeaderRecord(framed.value[0] ?? "");
  if (!header.ok) return { ok: false, brokenAtSeq: null, detail: header.reason };
  const trailer = parseTrailerRecord(framed.value[framed.value.length - 1] ?? "");
  if (!trailer.ok) return { ok: false, brokenAtSeq: null, detail: trailer.reason };
  if (trailer.value.problem !== header.value.problem) {
    return {
      ok: false,
      brokenAtSeq: null,
      detail: "the terminal record's problem id does not match the header",
    };
  }

  const events: ParsedEvent[] = [];
  for (const [offset, line] of framed.value.slice(1, -1).entries()) {
    const parsedEvent = parseEventRecord(line);
    if (!parsedEvent.ok) {
      return { ok: false, brokenAtSeq: offset + 1, detail: parsedEvent.reason };
    }
    events.push(parsedEvent.value);
  }
  if (header.value.checkpoints.length > events.length) {
    return { ok: false, brokenAtSeq: null, detail: "export carries more checkpoints than events" };
  }
  if (header.value.checkpoints.some((checkpoint) => checkpoint.checkpointSeq > events.length)) {
    return {
      ok: false,
      brokenAtSeq: null,
      detail: "header checkpoint references an event beyond the export",
    };
  }
  return { ok: true, header: header.value, events, trailer: trailer.value };
}

/**
 * Verify an export's integrity chain (Fable §10.2 tamper-evidence). The strict
 * parser first proves complete v1 framing and record shapes; this then
 * recomputes every row digest, chain link, and checkpoint digest/root.
 *
 * This is self-consistency evidence, not cryptographic authenticity: v1
 * checkpoints are `unsigned-v0`, and 5il1 remains open because the chain
 * preimage does not yet bind `row_digest`. ds62's row-digest verification is
 * intentionally retained here; no parser result may be described as signed or
 * authentic until that separate repair exists.
 */
export async function verifyProblemExportChain(
  ndjson: string,
): Promise<
  | { readonly intact: true; readonly eventCount: number; readonly finalChainDigest: string }
  | { readonly intact: false; readonly brokenAtSeq: number; readonly detail: string }
  | { readonly intact: false; readonly brokenAtSeq: null; readonly detail: string }
> {
  const parsed = parseProblemExportV1(ndjson);
  if (!parsed.ok) {
    return { intact: false, brokenAtSeq: parsed.brokenAtSeq, detail: parsed.detail };
  }

  let previous = await genesisChainDigest(parsed.header.problem);
  let expectedSeq = 1;
  let nextCheckpoint = 0;

  for (const event of parsed.events) {
    if (event.seq !== expectedSeq) {
      return {
        intact: false,
        brokenAtSeq: expectedSeq,
        detail: `sequence gap: expected seq ${expectedSeq}, found ${event.seq}`,
      };
    }
    const recomputedRow = await eventRowDigest(
      {
        eventId: event.eventId,
        problemId: parsed.header.problem,
        claimId: event.objectId,
        // These request-only fields do not participate in eventRowDigest.
        idempotencyKey: "export-verifier",
        statement: "",
        createdAt: event.createdAt,
      },
      event.seq,
      event.payloadSha256,
    );
    if (recomputedRow !== event.rowDigest) {
      return {
        intact: false,
        brokenAtSeq: event.seq,
        detail: `row digest mismatch at seq ${event.seq} — the event envelope is tampered`,
      };
    }
    const recomputedChain = await eventChainDigest(
      parsed.header.problem,
      event.seq,
      event.payloadSha256,
      previous,
    );
    if (recomputedChain !== event.chainDigest) {
      return {
        intact: false,
        brokenAtSeq: event.seq,
        detail: `chain digest mismatch at seq ${event.seq} — the export is tampered or truncated`,
      };
    }
    previous = event.chainDigest;

    const checkpoint = parsed.header.checkpoints[nextCheckpoint];
    if (checkpoint?.checkpointSeq === event.seq) {
      if (checkpoint.rootChainDigest !== previous) {
        return {
          intact: false,
          brokenAtSeq: event.seq,
          detail: `checkpoint root mismatch at seq ${event.seq}`,
        };
      }
      const recomputedCheckpoint = await checkpointDigest(
        parsed.header.problem,
        checkpoint.checkpointSeq,
        checkpoint.rootChainDigest,
      );
      if (recomputedCheckpoint !== checkpoint.checkpointDigest) {
        return {
          intact: false,
          brokenAtSeq: event.seq,
          detail: `checkpoint digest mismatch at seq ${event.seq}`,
        };
      }
      nextCheckpoint += 1;
    }
    expectedSeq += 1;
  }

  if (parsed.trailer.eventCount !== parsed.events.length) {
    return {
      intact: false,
      brokenAtSeq: null,
      detail: `terminal record claims ${parsed.trailer.eventCount} events; the export carries ${parsed.events.length}`,
    };
  }
  const finalSeq = expectedSeq - 1;
  if (parsed.trailer.finalCursor !== finalSeq) {
    return {
      intact: false,
      brokenAtSeq: null,
      detail: `terminal record claims final cursor ${parsed.trailer.finalCursor}; the export ends at ${finalSeq}`,
    };
  }
  if (nextCheckpoint !== parsed.header.checkpoints.length) {
    return {
      intact: false,
      brokenAtSeq: null,
      detail: "header checkpoint references an event absent from the verified chain",
    };
  }

  return { intact: true, eventCount: parsed.events.length, finalChainDigest: previous };
}
