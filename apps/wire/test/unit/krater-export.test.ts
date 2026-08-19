import { describe, expect, test } from "bun:test";

import {
  EXPORT_FORMAT,
  EXPORT_LICENSE,
  parseExportHeader,
  serializeProblemExport,
} from "../../src/krater/export.ts";
import type { KraterEvent } from "../../src/krater/krater.ts";

function event(seq: number): KraterEvent {
  return {
    eventId: `E-${seq}`,
    problemId: "P-4DSP",
    seq,
    type: "claim.created",
    objectId: `C-${seq}`,
    payloadSha256: `sha256:${seq}`,
    rowDigest: `rd-${seq}`,
    chainDigest: `cd-${seq}`,
    createdAt: "2026-08-18T00:00:00Z",
  };
}

describe("per-problem event export (W2.8)", () => {
  test("the export is header + one event per line + terminal control record", () => {
    const ndjson = serializeProblemExport({
      problemId: "P-4DSP",
      problemTitle: "Four-diamond slider puzzle",
      events: [event(1), event(2), event(3)],
      checkpoints: [],
      generatedAt: "2026-08-18",
    });
    const lines = ndjson.trim().split("\n");
    expect(lines).toHaveLength(5); // header + 3 events + trailer
    const trailer = JSON.parse(lines[4]);
    expect(trailer.control).toBe("export_end");
    expect(trailer.event_count).toBe(3);
    expect(trailer.final_cursor).toBe(3);
  });

  test("the header carries the format, license, and embedded checkpoints", () => {
    const ndjson = serializeProblemExport({
      problemId: "P-4DSP",
      problemTitle: "t",
      events: [event(1)],
      checkpoints: [
        {
          problemId: "P-4DSP",
          checkpointSeq: 3,
          rootChainDigest: "root",
          checkpointDigest: "cp",
          checkpointVersion: 1,
          checkpointMode: "unsigned-v0",
        },
      ],
      generatedAt: "2026-08-18",
    });
    const header = JSON.parse(ndjson.split("\n")[0]);
    expect(header.format).toBe(EXPORT_FORMAT);
    expect(header.license).toBe(EXPORT_LICENSE);
    expect(header.checkpoints).toHaveLength(1);
    expect(header.checkpoints[0].checkpoint_digest).toBe("cp");
  });

  test("the terminal cursor is 0 for an empty event stream, and the consumer never guesses", () => {
    const ndjson = serializeProblemExport({
      problemId: "P-4DSP",
      problemTitle: "t",
      events: [],
      checkpoints: [],
      generatedAt: "2026-08-18",
    });
    const lines = ndjson.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).final_cursor).toBe(0);
  });

  test("the header parses round-trip and rejects a foreign format", () => {
    const ndjson = serializeProblemExport({
      problemId: "P-4DSP",
      problemTitle: "t",
      events: [event(1)],
      checkpoints: [],
      generatedAt: "2026-08-18",
    });
    const header = parseExportHeader(ndjson.split("\n")[0]);
    expect(header.ok).toBe(true);
    if (header.ok) expect(header.license).toBe(EXPORT_LICENSE);

    expect(parseExportHeader("not json").ok).toBe(false);
    expect(parseExportHeader('{"control":"other"}').ok).toBe(false);
  });

  test("every event line is complete and self-contained (one event, one line)", () => {
    const ndjson = serializeProblemExport({
      problemId: "P-4DSP",
      problemTitle: "t",
      events: [event(1), event(2)],
      checkpoints: [],
      generatedAt: "2026-08-18",
    });
    const lines = ndjson.trim().split("\n");
    for (const line of lines.slice(1, -1)) {
      const event = JSON.parse(line);
      expect(event.event_id).toBeDefined();
      expect(event.seq).toBeGreaterThan(0);
      expect(event.chain_digest).toBeDefined();
    }
  });
});
