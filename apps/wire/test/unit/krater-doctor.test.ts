import { describe, expect, test } from "bun:test";

import { doctorProjections } from "../../src/krater/doctor.ts";
import type { ClaimProjection, KraterEvent } from "../../src/krater/krater.ts";

function event(seq: number, claimId: string): KraterEvent {
  return {
    eventId: `E-${seq}`,
    problemId: "P-DOC",
    seq,
    type: "claim.created",
    objectId: claimId,
    payloadSha256: `sha256:${seq}`,
    rowDigest: `rd-${seq}`,
    chainDigest: `cd-${seq}`,
    createdAt: "2026-08-18T00:00:00Z",
  };
}

function projection(claimId: string, seq: number, overrides: Partial<ClaimProjection> = {}): ClaimProjection {
  return {
    claimId,
    problemId: "P-DOC",
    sourceSeq: seq,
    projectionVersion: 1,
    buildDigest: `bd-${seq}`,
    stale: false,
    ...overrides,
  };
}

describe("doctor-projections (W2.6)", () => {
  test("a stored state that equals the log replay is sound", () => {
    const events = [event(1, "C-1"), event(2, "C-2")];
    // Replay to get the exact expected projections.
    const stored = [
      projection("C-1", 1),
      projection("C-2", 2),
    ];
    const report = doctorProjections("P-DOC", events, stored);
    expect(report.sound).toBe(true);
    expect(report.drift).toEqual([]);
    expect(report.rebuildSet).toEqual([]);
    expect(report.replayedCount).toBe(2);
    expect(report.storedCount).toBe(2);
  });

  test("a stored projection with no log event is an orphan (fabricated state)", () => {
    const report = doctorProjections("P-DOC", [], [projection("C-GHOST", 99)]);
    expect(report.sound).toBe(false);
    expect(report.drift[0]?.kind).toBe("orphan_projection");
    expect(report.rebuildSet).toContain("C-GHOST");
  });

  test("a log claim with no projection row is missing", () => {
    const report = doctorProjections("P-DOC", [event(1, "C-1")], []);
    expect(report.sound).toBe(false);
    expect(report.drift[0]?.kind).toBe("missing_projection");
  });

  test("a stale-flagged projection is flagged for rebuild", () => {
    const report = doctorProjections("P-DOC", [event(1, "C-1")], [projection("C-1", 1, { stale: true })]);
    expect(report.sound).toBe(false);
    expect(report.drift.some((d) => d.kind === "stale_projection")).toBe(true);
  });

  test("a version divergence is named with both versions", () => {
    const report = doctorProjections("P-DOC", [event(1, "C-1")], [
      projection("C-1", 1, { projectionVersion: 7 }),
    ]);
    expect(report.sound).toBe(false);
    const drift = report.drift.find((d) => d.kind === "version_divergence");
    expect(drift).toBeDefined();
    if (drift?.kind === "version_divergence") {
      expect(drift.expected).toBe(1);
      expect(drift.actual).toBe(7);
    }
  });

  test("the rebuild set names exactly the divergent claims, sorted", () => {
    const events = [event(1, "C-1"), event(2, "C-2"), event(3, "C-3")];
    const stored = [
      projection("C-2", 2, { stale: true }),
      projection("C-3", 3),
    ];
    const report = doctorProjections("P-DOC", events, stored);
    // C-1 missing, C-2 stale; C-3 sound.
    expect(report.rebuildSet).toEqual(["C-1", "C-2"]);
  });
});
