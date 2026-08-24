import { describe, expect, test } from "bun:test";

import {
  EXPORT_FORMAT,
  EXPORT_LICENSE,
  parseExportHeader,
  serializeProblemExport,
  verifyProblemExportChain,
} from "../../src/krater/export.ts";
import {
  checkpointDigest,
  eventChainDigest,
  eventEnvelopeRowDigest,
  genesisChainDigest,
  type KraterEvent,
  sha256Hex,
} from "../../src/krater/krater.ts";

function event(seq: number): KraterEvent {
  return {
    eventId: `E-${seq}`,
    problemId: "P-4DSP",
    seq,
    type: "claim.created",
    objectKind: "claim",
    objectId: `C-${seq}`,
    objectVersion: 1,
    payloadSha256: `sha256:${seq}`,
    rowDigest: `rd-${seq}`,
    chainDigest: `cd-${seq}`,
    chainVersion: 2,
    createdAt: "2026-08-18T00:00:00Z",
    actorFellowId: null,
    actorSponsorId: null,
    actorSessionId: null,
    modelStringSelfDeclared: null,
    harness: null,
    writerCredentialId: null,
  };
}

describe("per-problem event export (W2.8)", () => {
  test("the export is header + one event per line + terminal control record", () => {
    const ndjson = serializeProblemExport({
      problemId: "P-4DSP",
      problemTitle: "Four-diamond slider puzzle",
      events: [event(1), event(2), event(3)],
      checkpoints: [],
      generatedAt: "2026-08-18T00:00:00Z",
    });
    const lines = ndjson.trim().split("\n");
    expect(lines).toHaveLength(5); // header + 3 events + trailer
    const trailer = JSON.parse(lines[4] ?? "{}");
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
          rootChainDigest: "a".repeat(64),
          checkpointDigest: "b".repeat(64),
          checkpointVersion: 1,
          chainVersion: 2,
          checkpointMode: "unsigned-v0",
        },
      ],
      generatedAt: "2026-08-18T00:00:00Z",
    });
    const header = JSON.parse(ndjson.split("\n")[0] ?? "{}");
    expect(header.format).toBe(EXPORT_FORMAT);
    expect(header.license).toBe(EXPORT_LICENSE);
    expect(header.checkpoints).toHaveLength(1);
    expect(header.checkpoints[0].checkpoint_digest).toBe("b".repeat(64));
    expect(header.checkpoints[0].problem).toBe("P-4DSP");
  });

  test("the terminal cursor is 0 for an empty event stream, and the consumer never guesses", () => {
    const ndjson = serializeProblemExport({
      problemId: "P-4DSP",
      problemTitle: "t",
      events: [],
      checkpoints: [],
      generatedAt: "2026-08-18T00:00:00Z",
    });
    const lines = ndjson.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? "{}").final_cursor).toBe(0);
  });

  test("the header parses round-trip and rejects a foreign format", () => {
    const ndjson = serializeProblemExport({
      problemId: "P-4DSP",
      problemTitle: "t",
      events: [event(1)],
      checkpoints: [],
      generatedAt: "2026-08-18T00:00:00Z",
    });
    const header = parseExportHeader(ndjson.split("\n")[0] ?? "");
    expect(header.ok).toBe(true);
    if (header.ok) expect(header.license).toBe(EXPORT_LICENSE);

    expect(parseExportHeader("not json").ok).toBe(false);
    expect(parseExportHeader('{"control":"other"}').ok).toBe(false);
  });

  test("foreign format values are typed, bounded, and nonreflecting", async () => {
    const intact = await buildExport(1);
    const lines = intact.trim().split("\n");
    const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    const plantedSecret = "asimp_ag_must-not-reflect";
    const foreignFormats: readonly unknown[] = [
      "asimposium.problem-export.v1",
      "asimposium.problem-export.v3",
      plantedSecret.repeat(5_000),
      null,
      [],
      {},
      { toString: plantedSecret, valueOf: plantedSecret },
    ];

    for (const format of foreignFormats) {
      const forgedHeader = JSON.stringify({ ...header, format });
      const parsed = parseExportHeader(forgedHeader);
      expect(parsed).toEqual({
        ok: false,
        reason: "header carries an unrecognized export format",
      });
      expect(JSON.stringify(parsed)).not.toContain(plantedSecret);

      const forgedExport = [forgedHeader, ...lines.slice(1)].join("\n");
      await expect(verifyProblemExportChain(`${forgedExport}\n`)).resolves.toEqual({
        intact: false,
        brokenAtSeq: null,
        detail: "header carries an unrecognized export format",
      });
    }
  });

  test("every event line is complete and self-contained (one event, one line)", () => {
    const ndjson = serializeProblemExport({
      problemId: "P-4DSP",
      problemTitle: "t",
      events: [event(1), event(2)],
      checkpoints: [],
      generatedAt: "2026-08-18T00:00:00Z",
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

async function chainedEvent(
  seq: number,
  previous: string,
): Promise<{ event: KraterEvent; chain: string }> {
  const payloadSha256 = await sha256Hex(`payload-${seq}`);
  const eventId = `E-${seq}`;
  const objectId = `C-${seq}`;
  const createdAt = "2026-08-18T00:00:00Z";
  const envelope = {
    eventId,
    problemId: "P-4DSP",
    seq,
    type: "claim.created",
    objectKind: "claim",
    objectId,
    objectVersion: 1,
    payloadSha256,
    createdAt,
    actorFellowId: seq === 1 ? "F-alpha" : null,
    actorSponsorId: seq === 1 ? "U-sponsor" : null,
    actorSessionId: seq === 1 ? "S-session" : null,
    modelStringSelfDeclared: seq === 1 ? "model-self-declared" : null,
    harness: seq === 1 ? "codex-cli" : null,
    writerCredentialId: seq === 1 ? "CRD-alpha" : null,
  } as const;
  const rowDigest = await eventEnvelopeRowDigest(envelope);
  const chain = await eventChainDigest("P-4DSP", seq, payloadSha256, rowDigest, previous);
  return {
    chain,
    event: {
      ...envelope,
      rowDigest,
      chainDigest: chain,
      chainVersion: 2,
    },
  };
}

async function buildExport(
  eventCount: number,
  checkpointSeqs: readonly number[] = [],
): Promise<string> {
  const events: KraterEvent[] = [];
  let previous = await genesisChainDigest("P-4DSP");
  for (let seq = 1; seq <= eventCount; seq += 1) {
    const { event, chain } = await chainedEvent(seq, previous);
    events.push(event);
    previous = chain;
  }
  const checkpoints = await Promise.all(
    checkpointSeqs.map(async (checkpointSeq) => {
      const rootChainDigest = events[checkpointSeq - 1]?.chainDigest;
      if (rootChainDigest === undefined) throw new Error("checkpoint fixture exceeds event stream");
      return {
        problemId: "P-4DSP",
        checkpointSeq,
        rootChainDigest,
        checkpointDigest: await checkpointDigest("P-4DSP", checkpointSeq, rootChainDigest),
        checkpointVersion: 1 as const,
        chainVersion: 2 as const,
        checkpointMode: "unsigned-v0" as const,
      };
    }),
  );
  return serializeProblemExport({
    problemId: "P-4DSP",
    problemTitle: "t",
    events,
    checkpoints,
    generatedAt: "2026-08-18T00:00:00Z",
  });
}

describe("export chain verification (W2.8 tamper-evidence)", () => {
  test("an intact export verifies end to end", async () => {
    const ndjson = await buildExport(3);
    const verdict = await verifyProblemExportChain(ndjson);
    expect(verdict.intact).toBe(true);
    if (verdict.intact) expect(verdict.eventCount).toBe(3);
  });

  test("an empty export verifies trivially", async () => {
    const ndjson = await buildExport(0);
    const verdict = await verifyProblemExportChain(ndjson);
    expect(verdict.intact).toBe(true);
  });

  test("a tampered event breaks the chain at its seq", async () => {
    const lines = (await buildExport(3)).trim().split("\n");
    const second = JSON.parse(lines[2] ?? "{}") as Record<string, unknown>;
    // Forge the second event's canonical payload digest without recomputing its row or chain digest.
    lines[2] = JSON.stringify({ ...second, payload_sha256: await sha256Hex("forged-payload") });
    const verdict = await verifyProblemExportChain(`${lines.join("\n")}\n`);
    expect(verdict.intact).toBe(false);
    if (!verdict.intact) expect(verdict.brokenAtSeq).toBe(2);
  });

  test("a sequence gap is detected", async () => {
    const ndjson = await buildExport(3);
    const lines = ndjson.trim().split("\n");
    // Remove the second event line (header + ev1 + ev3 + trailer).
    const gapped = [lines[0], lines[1], lines[3], lines[4]].join("\n");
    const verdict = await verifyProblemExportChain(gapped);
    expect(verdict.intact).toBe(false);
  });

  test("PLANTED: every row-digest-bound envelope field is verified", async () => {
    const mutations: readonly (readonly [string, unknown])[] = [
      ["event_id", "E-forged"],
      ["object_id", "C-forged"],
      ["created_at", "2026-08-19T00:00:00Z"],
      ["row_digest", await sha256Hex("forged-row-digest")],
    ];
    for (const [field, value] of mutations) {
      const lines = (await buildExport(2)).trim().split("\n");
      const first = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
      lines[1] = JSON.stringify({ ...first, [field]: value });
      const verdict = await verifyProblemExportChain(`${lines.join("\n")}\n`);
      expect(verdict).toEqual({
        intact: false,
        brokenAtSeq: 1,
        detail: "row digest mismatch at seq 1 — the event envelope is tampered",
      });
    }
  });

  test("PLANTED: the fixed export event type cannot be widened", async () => {
    const lines = (await buildExport(1)).trim().split("\n");
    const first = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    lines[1] = JSON.stringify({ ...first, type: "claim.updated" });
    const verdict = await verifyProblemExportChain(`${lines.join("\n")}\n`);
    expect(verdict).toEqual({
      intact: false,
      brokenAtSeq: 1,
      detail: "event line carries invalid field types or an unsupported event type",
    });
  });

  test("PLANTED: an extra unbound event field is refused", async () => {
    const lines = (await buildExport(1)).trim().split("\n");
    const first = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    lines[1] = JSON.stringify({ ...first, unbound: "forged" });
    const verdict = await verifyProblemExportChain(`${lines.join("\n")}\n`);
    expect(verdict).toEqual({
      intact: false,
      brokenAtSeq: 1,
      detail: "event line does not have the exact export shape",
    });
  });

  test("PLANTED: a non-object event line is refused without throwing", async () => {
    const lines = (await buildExport(1)).trim().split("\n");
    lines[1] = "null";
    const verdict = await verifyProblemExportChain(`${lines.join("\n")}\n`);
    expect(verdict).toEqual({
      intact: false,
      brokenAtSeq: 1,
      detail: "event line is not an object",
    });
  });

  test("a foreign-format export is refused before any chain work", async () => {
    const verdict = await verifyProblemExportChain('{"control":"other"}\n');
    expect(verdict.intact).toBe(false);
    if (!verdict.intact) expect(verdict.brokenAtSeq).toBeNull();
  });

  // One axis per plant. Each starts from an export that verifies intact, so a
  // refusal is caused by the mutation and never by an already-broken fixture.
  test("PLANTED: a checkpoint-less export missing its trailer is not intact", async () => {
    const ndjson = await buildExport(3);
    expect((await verifyProblemExportChain(ndjson)).intact).toBe(true);
    const lines = ndjson.trim().split("\n");
    // Drop only the terminal record. The remaining prefix still recomputes a
    // clean chain, and the header embedded no checkpoints, so the completion
    // witness is the only thing that can refuse this.
    const truncated = `${lines.slice(0, -1).join("\n")}\n`;
    const verdict = await verifyProblemExportChain(truncated);
    expect(verdict.intact).toBe(false);
    if (!verdict.intact) {
      expect(verdict.brokenAtSeq).toBeNull();
      expect(verdict.detail).toBe("terminal record does not have the exact v1 shape");
    }
  });

  test("PLANTED: a foreign trailer problem id cannot be spliced onto a header", async () => {
    const lines = (await buildExport(2)).trim().split("\n");
    const trailer = JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;
    const spliced = [
      ...lines.slice(0, -1),
      JSON.stringify({ ...trailer, problem: "P-OTHER" }),
    ].join("\n");
    const verdict = await verifyProblemExportChain(`${spliced}\n`);
    expect(verdict.intact).toBe(false);
    if (!verdict.intact) {
      expect(verdict.detail).toBe("the terminal record's problem id does not match the header");
    }
  });

  test("PLANTED: a trailer event count that disagrees with the stream is refused", async () => {
    const lines = (await buildExport(2)).trim().split("\n");
    const trailer = JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;
    expect(trailer.event_count).toBe(2);
    const forged = [...lines.slice(0, -1), JSON.stringify({ ...trailer, event_count: 3 })].join(
      "\n",
    );
    const verdict = await verifyProblemExportChain(`${forged}\n`);
    expect(verdict.intact).toBe(false);
    if (!verdict.intact) {
      expect(verdict.detail).toContain("claims 3 events");
    }
  });

  test("PLANTED: a trailer final cursor that disagrees with the last seq is refused", async () => {
    const lines = (await buildExport(2)).trim().split("\n");
    const trailer = JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;
    expect(trailer.final_cursor).toBe(2);
    const forged = [...lines.slice(0, -1), JSON.stringify({ ...trailer, final_cursor: 9 })].join(
      "\n",
    );
    const verdict = await verifyProblemExportChain(`${forged}\n`);
    expect(verdict.intact).toBe(false);
    if (!verdict.intact) {
      expect(verdict.detail).toContain("final cursor 9");
    }
  });

  test("PLANTED: a duplicated terminal record is refused", async () => {
    const lines = (await buildExport(2)).trim().split("\n");
    const duplicated = [...lines, lines[lines.length - 1]].join("\n");
    const verdict = await verifyProblemExportChain(`${duplicated}\n`);
    expect(verdict.intact).toBe(false);
    if (!verdict.intact) {
      expect(verdict.detail).toBe("event line does not have the exact export shape");
    }
  });

  test("PLANTED: a record appended after the terminal record is refused", async () => {
    const lines = (await buildExport(2)).trim().split("\n");
    // A well-formed event line appended after the completion witness.
    const appended = [...lines, lines[1]].join("\n");
    const verdict = await verifyProblemExportChain(`${appended}\n`);
    expect(verdict.intact).toBe(false);
    if (!verdict.intact) {
      expect(verdict.detail).toBe("terminal record does not have the exact v1 shape");
    }
  });

  // Each plant begins with a schema-valid, chain-intact export. The mutation is
  // one axis only, so these remain causal against the permissive pre-i5bz
  // parser: it accepted malformed/stripped checkpoint metadata, ignored extra
  // header/trailer keys, and filtered blank or CRLF-framed records.
  test("PLANTED: a malformed checkpoint primitive is refused", async () => {
    const intact = await buildExport(3, [3]);
    expect((await verifyProblemExportChain(intact)).intact).toBe(true);
    const lines = intact.trim().split("\n");
    const header = JSON.parse(lines[0] ?? "{}") as {
      checkpoints: Record<string, unknown>[];
    } & Record<string, unknown>;
    lines[0] = JSON.stringify({
      ...header,
      checkpoints: [{ ...(header.checkpoints[0] ?? {}), checkpoint_seq: "3" }],
    });
    await expect(verifyProblemExportChain(`${lines.join("\n")}\n`)).resolves.toEqual({
      intact: false,
      brokenAtSeq: null,
      detail: "header checkpoint 1 carries invalid v1 fields",
    });
  });

  test("PLANTED: a stripped checkpoint digest is refused", async () => {
    const intact = await buildExport(3, [3]);
    expect((await verifyProblemExportChain(intact)).intact).toBe(true);
    const lines = intact.trim().split("\n");
    const header = JSON.parse(lines[0] ?? "{}") as {
      checkpoints: Record<string, unknown>[];
    } & Record<string, unknown>;
    const { checkpoint_digest: _stripped, ...checkpointWithoutDigest } =
      header.checkpoints[0] ?? {};
    lines[0] = JSON.stringify({ ...header, checkpoints: [checkpointWithoutDigest] });
    await expect(verifyProblemExportChain(`${lines.join("\n")}\n`)).resolves.toEqual({
      intact: false,
      brokenAtSeq: null,
      detail: "header checkpoint 1 does not have the exact v1 shape",
    });
  });

  test("PLANTED: a checkpoint foreign to the header problem is refused", async () => {
    const intact = await buildExport(3, [3]);
    expect((await verifyProblemExportChain(intact)).intact).toBe(true);
    const lines = intact.trim().split("\n");
    const header = JSON.parse(lines[0] ?? "{}") as {
      checkpoints: Record<string, unknown>[];
    } & Record<string, unknown>;
    lines[0] = JSON.stringify({
      ...header,
      checkpoints: [{ ...(header.checkpoints[0] ?? {}), problem: "P-OTHER" }],
    });
    await expect(verifyProblemExportChain(`${lines.join("\n")}\n`)).resolves.toEqual({
      intact: false,
      brokenAtSeq: null,
      detail: "header checkpoint 1 is not bound to the header problem",
    });
  });

  test("PLANTED: reordered checkpoints are refused before chain verification", async () => {
    const intact = await buildExport(3, [1, 2, 3]);
    expect((await verifyProblemExportChain(intact)).intact).toBe(true);
    const lines = intact.trim().split("\n");
    const header = JSON.parse(lines[0] ?? "{}") as {
      checkpoints: Record<string, unknown>[];
    } & Record<string, unknown>;
    lines[0] = JSON.stringify({
      ...header,
      // Keep the final checkpoint last: the old verifier checked only its root,
      // so this proves order checking rather than a final-root false green.
      checkpoints: [
        header.checkpoints[1] ?? {},
        header.checkpoints[0] ?? {},
        header.checkpoints[2] ?? {},
      ],
    });
    await expect(verifyProblemExportChain(`${lines.join("\n")}\n`)).resolves.toEqual({
      intact: false,
      brokenAtSeq: null,
      detail: "header checkpoints are not in strict sequence order",
    });
  });

  test("PLANTED: a valid-shaped forged checkpoint digest is recomputed", async () => {
    const intact = await buildExport(3, [3]);
    expect((await verifyProblemExportChain(intact)).intact).toBe(true);
    const lines = intact.trim().split("\n");
    const header = JSON.parse(lines[0] ?? "{}") as {
      checkpoints: Record<string, unknown>[];
    } & Record<string, unknown>;
    lines[0] = JSON.stringify({
      ...header,
      checkpoints: [
        { ...(header.checkpoints[0] ?? {}), checkpoint_digest: await sha256Hex("forged") },
      ],
    });
    await expect(verifyProblemExportChain(`${lines.join("\n")}\n`)).resolves.toEqual({
      intact: false,
      brokenAtSeq: 3,
      detail: "checkpoint digest mismatch at seq 3",
    });
  });

  test("PLANTED: an extra header key is refused", async () => {
    const intact = await buildExport(1);
    expect((await verifyProblemExportChain(intact)).intact).toBe(true);
    const lines = intact.trim().split("\n");
    const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    lines[0] = JSON.stringify({ ...header, unbound: true });
    await expect(verifyProblemExportChain(`${lines.join("\n")}\n`)).resolves.toEqual({
      intact: false,
      brokenAtSeq: null,
      detail: "header does not have the exact v1 shape",
    });
  });

  test("PLANTED: an extra trailer key is refused", async () => {
    const intact = await buildExport(1);
    expect((await verifyProblemExportChain(intact)).intact).toBe(true);
    const lines = intact.trim().split("\n");
    const trailer = JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;
    lines[lines.length - 1] = JSON.stringify({ ...trailer, unbound: true });
    await expect(verifyProblemExportChain(`${lines.join("\n")}\n`)).resolves.toEqual({
      intact: false,
      brokenAtSeq: null,
      detail: "terminal record does not have the exact v1 shape",
    });
  });

  test("PLANTED: a blank record cannot be filtered out", async () => {
    const intact = await buildExport(1);
    expect((await verifyProblemExportChain(intact)).intact).toBe(true);
    const lines = intact.trim().split("\n");
    lines.splice(1, 0, "");
    await expect(verifyProblemExportChain(`${lines.join("\n")}\n`)).resolves.toEqual({
      intact: false,
      brokenAtSeq: null,
      detail: "export carries a blank record",
    });
  });

  test("PLANTED: CRLF framing cannot be silently accepted as v1 LF", async () => {
    const intact = await buildExport(1);
    expect((await verifyProblemExportChain(intact)).intact).toBe(true);
    await expect(verifyProblemExportChain(intact.replaceAll("\n", "\r\n"))).resolves.toEqual({
      intact: false,
      brokenAtSeq: null,
      detail: "export must use LF line endings",
    });
  });
});
