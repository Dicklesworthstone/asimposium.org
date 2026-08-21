import { describe, expect, test } from "bun:test";

import {
  doctorProjections,
  MAX_PROJECTION_DOCTOR_INPUT_ROWS,
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

function projectionWithRuntimeInvalidStale(stale: unknown): ClaimProjection {
  const result = projection("C-1", 1);
  Object.defineProperty(result, "stale", { enumerable: true, value: stale });
  return result;
}

function denseRowsAtReportCap(): {
  events: KraterEvent[];
  stored: ClaimProjection[];
} {
  const events = Array.from({ length: 256 }, (_, index) => event(index + 1, `C-${index + 1}`));
  return {
    events,
    stored: Array.from({ length: 256 }, (_, index) => projection(`C-${index + 1}`, index + 1)),
  };
}

describe("doctor-projections (W2.6)", () => {
  test("PLANTED: the projection-doctor input cap remains the literal safe value", () => {
    expect(MAX_PROJECTION_DOCTOR_INPUT_ROWS).toBe(512);
  });

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

  test("PLANTED: a dense replay at the exact report cap is decided completely", () => {
    const { events, stored } = denseRowsAtReportCap();

    const report = doctorProjections("P-DOC", events, stored);

    expect(events).toHaveLength(256);
    expect(stored).toHaveLength(256);
    expect(events.length + stored.length).toBe(512);
    expect(report.replayedCount).toBe(events.length);
    expect(report.storedCount).toBe(stored.length);
    expect(report.sound).toBe(true);
    expect(report.drift).toEqual([]);
    expect(report.rebuildSet).toEqual([]);
  });

  test("PLANTED: one dense row beyond the report cap fails closed", () => {
    const { events, stored } = denseRowsAtReportCap();
    const oneOverCap = [...stored, projection(`C-${stored.length + 1}`, stored.length + 1)];

    expect(events).toHaveLength(256);
    expect(oneOverCap).toHaveLength(257);
    expect(events.length + oneOverCap.length).toBe(513);
    expect(() => doctorProjections("P-DOC", events, oneOverCap)).toThrow(
      "PROJECTION_DOCTOR_INPUT_INVALID: combined input exceeds the 512-row report cap",
    );
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

  for (const [label, stale, actualType] of [
    ["number zero", 0, "number"],
    ["undefined", undefined, "undefined"],
    ["string false", "false", "string"],
  ] as const) {
    test(`runtime-invalid ${label} stale shape is rejected from the boolean diagnostic`, () => {
      const report = doctorProjections(
        "P-DOC",
        [event(1, "C-1")],
        [projectionWithRuntimeInvalidStale(stale)],
      );

      expect(report.sound).toBe(false);
      expect(report.drift).toEqual([
        {
          kind: "invalid_stale_shape",
          claimId: "C-1",
          expected: "boolean",
          actualType,
        },
      ]);
      expect(report.rebuildSet).toEqual(["C-1"]);
    });
  }

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

  test("PLANTED: a changed V2 builder has exact drift diagnostics and one rebuild target", () => {
    const persistedBody = Object.freeze({
      statement:
        "The durable event body stays identical while a V2 projection builder changes its projection digest.",
    });
    const events = [event(1, "C-v2-builder")];
    // This is a persisted V2 result, deliberately specified without calling
    // the production replay builder to form the stored row or its digest.
    const stored = [
      projection("C-v2-builder", 1, {
        projectionVersion: 2,
        buildDigest: "v2:independently-specified-projection-digest",
      }),
    ];
    const before = JSON.stringify({ body: persistedBody, events, stored });

    const report = doctorProjections("P-DOC", events, stored);

    expect(report).toEqual({
      problemId: "P-DOC",
      replayedCount: 1,
      storedCount: 1,
      sound: false,
      drift: [
        {
          kind: "version_divergence",
          claimId: "C-v2-builder",
          expected: 1,
          actual: 2,
        },
        {
          kind: "build_digest_divergence",
          claimId: "C-v2-builder",
          expected: "rd-1",
          actual: "v2:independently-specified-projection-digest",
        },
      ],
      rebuildSet: ["C-v2-builder"],
    });
    expect(JSON.stringify({ body: persistedBody, events, stored })).toBe(before);
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

  test("PLANTED: complete diagnostics are invariant to stored orphan permutation", () => {
    const events = [event(1, "C-2"), event(2, "C-10")];
    const stored = [
      projection("C-9", 9),
      projection("C-2", 1, { buildDigest: "wrong" }),
      projection("C-11", 11),
    ];
    const expected = [
      {
        kind: "build_digest_divergence" as const,
        claimId: "C-2",
        expected: "rd-1",
        actual: "wrong",
      },
      {
        kind: "missing_projection" as const,
        claimId: "C-10",
        detail: "the log carries this claim but no projection row exists",
      },
      {
        kind: "orphan_projection" as const,
        claimId: "C-11",
        detail: "a projection row exists with no backing log event — fabricated state",
      },
      {
        kind: "orphan_projection" as const,
        claimId: "C-9",
        detail: "a projection row exists with no backing log event — fabricated state",
      },
    ];

    for (const current of [stored, [...stored].reverse()]) {
      const report = doctorProjections("P-DOC", events, current);
      expect(report.drift).toEqual(expected);
      expect(report.rebuildSet).toEqual(["C-10", "C-11", "C-2", "C-9"]);
    }
  });

  test("scope and duplicate claim-id inputs are refused before Map construction", () => {
    for (const run of [
      () => doctorProjections("P-DOC", [{ ...event(1, "C-1"), problemId: "P-OTHER" }], []),
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
        doctorProjections("P-DOC", [event(1, "C-1")], [projection("C-1", 1), projection("C-1", 1)]),
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
