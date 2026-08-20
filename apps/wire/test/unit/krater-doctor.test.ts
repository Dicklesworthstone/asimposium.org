import { describe, expect, test } from "bun:test";

import {
  doctorProjections,
  ProjectionDoctorInputError,
} from "../../src/krater/doctor.ts";
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

function projection(
  claimId: string,
  seq: number,
  overrides: Partial<ClaimProjection> = {},
): ClaimProjection {
  return {
    claimId,
    problemId: "P-DOC",
    sourceSeq: seq,
    projectionVersion: 1,
    buildDigest: `rd-${seq}`,
    stale: false,
    ...overrides,
  };
}

describe("doctor-projections (W2.6)", () => {
  test("a stored state that equals the log replay is sound", () => {
    const events = [event(1, "C-1"), event(2, "C-2")];
    // Replay to get the exact expected projections.
    const stored = [projection("C-1", 1), projection("C-2", 2)];
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
    const report = doctorProjections(
      "P-DOC",
      [event(1, "C-1")],
      [projection("C-1", 1, { stale: true })],
    );
    expect(report.sound).toBe(false);
    expect(report.drift).toContainEqual({
      kind: "stale_projection",
      claimId: "C-1",
      expected: false,
      actual: true,
    });
  });

  test("source sequence and build digest divergence are independently named", () => {
    const source = doctorProjections(
      "P-DOC",
      [event(1, "C-1")],
      [projection("C-1", 1, { sourceSeq: 7 })],
    );
    expect(source.drift).toEqual([
      {
        kind: "source_sequence_divergence",
        claimId: "C-1",
        expected: 1,
        actual: 7,
      },
    ]);

    const digest = doctorProjections(
      "P-DOC",
      [event(1, "C-1")],
      [projection("C-1", 1, { buildDigest: "wrong" })],
    );
    expect(digest.drift).toEqual([
      {
        kind: "build_digest_divergence",
        claimId: "C-1",
        expected: "rd-1",
        actual: "wrong",
      },
    ]);
  });

  test("a version divergence is named with both versions", () => {
    const report = doctorProjections(
      "P-DOC",
      [event(1, "C-1")],
      [projection("C-1", 1, { projectionVersion: 7 })],
    );
    expect(report.sound).toBe(false);
    expect(report.drift).toEqual([
      {
        kind: "version_divergence",
        claimId: "C-1",
        expected: 1,
        actual: 7,
      },
    ]);
  });

  test("the rebuild set names exactly the divergent claims, sorted", () => {
    const events = [event(1, "C-2"), event(2, "C-10"), event(3, "C-3")];
    const stored = [
      projection("C-2", 9, { stale: true, projectionVersion: 7, buildDigest: "wrong" }),
      projection("C-3", 3),
    ];
    const report = doctorProjections("P-DOC", events, stored);
    // C-10 is missing; C-2 diverges in several fields but appears only once.
    expect(report.rebuildSet).toEqual(["C-10", "C-2"]);
  });

  test("scope and duplicate claim-id inputs are refused before Map construction", () => {
    for (const run of [
      () =>
        doctorProjections(
          "P-DOC",
          [{ ...event(1, "C-1"), problemId: "P-OTHER" }],
          [],
        ),
      () =>
        doctorProjections(
          "P-DOC",
          [event(1, "C-1"), { ...event(2, "C-2"), problemId: "P-OTHER" }],
          [],
        ),
      () =>
        doctorProjections(
          "P-DOC",
          [event(1, "C-1")],
          [projection("C-1", 1, { problemId: "P-OTHER" })],
        ),
      () => doctorProjections("P-DOC", [event(1, "C-1"), event(2, "C-1")], []),
      () =>
        doctorProjections(
          "P-DOC",
          [event(1, "C-1")],
          [projection("C-1", 1), projection("C-1", 1)],
        ),
    ]) {
      try {
        run();
        throw new Error("expected projection doctor refusal");
      } catch (error) {
        if (!(error instanceof ProjectionDoctorInputError)) throw error;
        expect(error.code).toBe("PROJECTION_DOCTOR_INPUT_INVALID");
      }
    }
  });
});
