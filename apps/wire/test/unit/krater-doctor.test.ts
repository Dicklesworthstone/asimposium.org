import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import {
  doctorIntegrity,
  doctorProblemIdentifiers,
  doctorProjections,
  MAX_PROBLEM_ID_AUDIT_FINDINGS,
  MAX_PROJECTION_DOCTOR_INPUT_ROWS,
  ProjectionDoctorInputError,
} from "../../src/krater/doctor.ts";
import type { ClaimProjection, KraterEvent } from "../../src/krater/krater.ts";
import {
  eventChainDigest,
  eventEnvelopeRowDigest,
  genesisChainDigest,
  type KraterOutboxRecord,
  projectionReplayMatches,
  transactionBoundaryMatches,
} from "../../src/krater/krater.ts";

function event(seq: number, claimId: string): KraterEvent {
  return {
    eventId: `E-${seq}`,
    problemId: "P-DOC",
    seq,
    type: "claim.created",
    objectKind: "claim",
    objectId: claimId,
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

function sqliteD1(
  sqlite: Database,
  observe?: (query: string, bindings: readonly (string | number | null)[]) => void,
): D1Database {
  type Binding = string | number | null;
  return {
    prepare(query: string) {
      return {
        bind(...bindings: Binding[]) {
          observe?.(query, bindings);
          return {
            async all<T>() {
              return {
                results: sqlite.prepare<unknown, Binding[]>(query).all(...bindings) as T[],
              };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("problem-identifier doctor (ZDZ.10)", () => {
  test("reports renderer-invalid durable ids without rewriting or filtering them", async () => {
    expect(MAX_PROBLEM_ID_AUDIT_FINDINGS).toBe(200);
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.run("CREATE TABLE problems (id TEXT PRIMARY KEY)");
    const insert = sqlite.prepare("INSERT INTO problems (id) VALUES (?)");
    for (const id of ["P-SAFE", "P-B--C", "P-A--B"]) insert.run(id);

    const report = await doctorProblemIdentifiers(sqliteD1(sqlite));
    expect(report).toEqual({
      sound: false,
      invalidProblemIds: ["P-A--B", "P-B--C"],
      truncated: false,
    });

    const safeSqlite = new Database(":memory:", { strict: true });
    safeSqlite.run("CREATE TABLE problems (id TEXT PRIMARY KEY)");
    safeSqlite.run("INSERT INTO problems (id) VALUES ('P-4DSP')");
    expect(await doctorProblemIdentifiers(sqliteD1(safeSqlite))).toEqual({
      sound: true,
      invalidProblemIds: [],
      truncated: false,
    });
  });

  test("bounds the durable-id report and declares the 201st invalid row", async () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.run("CREATE TABLE problems (id TEXT PRIMARY KEY)");
    const insert = sqlite.prepare("INSERT INTO problems (id) VALUES (?)");
    for (let index = 0; index <= MAX_PROBLEM_ID_AUDIT_FINDINGS; index += 1) {
      insert.run(`P-${String(index).padStart(3, "0")}--X`);
    }
    insert.run("P-SAFE");

    let observedQuery = "";
    let observedBindings: readonly (string | number | null)[] = [];
    const report = await doctorProblemIdentifiers(
      sqliteD1(sqlite, (query, bindings) => {
        observedQuery = query;
        observedBindings = bindings;
      }),
    );
    expect(report.sound).toBe(false);
    expect(report.truncated).toBe(true);
    expect(report.invalidProblemIds).toHaveLength(MAX_PROBLEM_ID_AUDIT_FINDINGS);
    expect(report.invalidProblemIds[0]).toBe("P-000--X");
    expect(report.invalidProblemIds.at(-1)).toBe("P-199--X");
    expect(report.invalidProblemIds).not.toContain("P-200--X");
    expect(report.invalidProblemIds).not.toContain("P-SAFE");
    expect(observedQuery).toContain("WHERE instr(id, '--') > 0");
    expect(observedQuery).toContain("LIMIT ?");
    expect(observedBindings).toEqual([MAX_PROBLEM_ID_AUDIT_FINDINGS + 1]);
  });
});

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

describe("replay and transaction boundary matchers pin buildDigest (asimposiumorg-z4ai)", () => {
  // The mounted POST /__s2/replay verdict is the conjunction of these matchers
  // (krater/worker.ts), so a stored projection whose build_digest drifted from
  // the replayed event rowDigest must never read as integrity=true. The plants
  // below mutate exactly one field on an otherwise-exact persistence, so each
  // refusal is attributable to that field alone.
  const events = [event(1, "C-1"), event(2, "C-2")];
  const exactProjections = [projection("C-1", 1), projection("C-2", 2)];
  const exactOutbox: KraterOutboxRecord[] = [
    { eventId: "E-1", state: "pending", kind: "search.index" },
    { eventId: "E-2", state: "delivered", kind: "search.index" },
  ];

  test("an exact replay with a consistent cursor and outbox boundary matches positively", () => {
    expect(projectionReplayMatches(events, exactProjections)).toBe(true);
    expect(transactionBoundaryMatches(2, events, exactProjections, exactOutbox)).toBe(true);
  });

  test("a one-field buildDigest mutation is refused by both matchers", () => {
    const corrupted = [projection("C-1", 1), projection("C-2", 2, { buildDigest: "wrong" })];
    expect(projectionReplayMatches(events, corrupted)).toBe(false);
    expect(transactionBoundaryMatches(2, events, corrupted, exactOutbox)).toBe(false);
  });

  test("every other compared field still carries its own refusal", () => {
    for (const [label, override] of [
      ["claimId", { claimId: "C-other" }],
      ["problemId", { problemId: "P-other" }],
      ["sourceSeq", { sourceSeq: 9 }],
      ["projectionVersion", { projectionVersion: 7 }],
      ["stale", { stale: true }],
    ] as const) {
      const mutated = [projection("C-1", 1), projection("C-2", 2, { ...override })];
      expect(projectionReplayMatches(events, mutated), label).toBe(false);
      expect(transactionBoundaryMatches(2, events, mutated, exactOutbox), label).toBe(false);
    }
  });

  test("the cursor and outbox conjuncts refuse their own corruption", () => {
    expect(transactionBoundaryMatches(1, events, exactProjections, exactOutbox)).toBe(false);
    expect(
      transactionBoundaryMatches(2, events, exactProjections, [
        { eventId: "E-1", state: "pending", kind: "search.index" },
      ]),
    ).toBe(false);
    expect(transactionBoundaryMatches(2, events, [projection("C-1", 1)], exactOutbox)).toBe(false);
  });
});

describe("integrity doctor v2 checkpoint pin", () => {
  test("a recomputed envelope mutation fails the independently supplied root", async () => {
    const draft: KraterEvent = {
      ...event(1, "C-1"),
      payloadSha256: "a".repeat(64),
      rowDigest: "0".repeat(64),
      chainDigest: "0".repeat(64),
      actorFellowId: "F-alpha",
    };
    const rowDigest = await eventEnvelopeRowDigest({
      eventId: draft.eventId,
      problemId: draft.problemId,
      seq: draft.seq,
      type: draft.type,
      objectKind: draft.objectKind,
      objectId: draft.objectId,
      objectVersion: draft.objectVersion,
      payloadSha256: draft.payloadSha256,
      createdAt: draft.createdAt,
      actorFellowId: draft.actorFellowId,
      actorSponsorId: draft.actorSponsorId,
      actorSessionId: draft.actorSessionId,
      modelStringSelfDeclared: draft.modelStringSelfDeclared,
      harness: draft.harness,
      writerCredentialId: draft.writerCredentialId,
    });
    const chainDigest = await eventChainDigest(
      draft.problemId,
      draft.seq,
      draft.payloadSha256,
      rowDigest,
      await genesisChainDigest(draft.problemId),
    );
    const canonical = { ...draft, rowDigest, chainDigest };
    const pin = { problemId: "P-DOC", checkpointSeq: 1, rootChainDigest: chainDigest };
    expect((await doctorIntegrity("P-DOC", [canonical], pin)).sound).toBe(true);

    const forgedDraft = { ...canonical, actorFellowId: "F-forged" };
    const forgedRow = await eventEnvelopeRowDigest({
      eventId: forgedDraft.eventId,
      problemId: forgedDraft.problemId,
      seq: forgedDraft.seq,
      type: forgedDraft.type,
      objectKind: forgedDraft.objectKind,
      objectId: forgedDraft.objectId,
      objectVersion: forgedDraft.objectVersion,
      payloadSha256: forgedDraft.payloadSha256,
      createdAt: forgedDraft.createdAt,
      actorFellowId: forgedDraft.actorFellowId,
      actorSponsorId: forgedDraft.actorSponsorId,
      actorSessionId: forgedDraft.actorSessionId,
      modelStringSelfDeclared: forgedDraft.modelStringSelfDeclared,
      harness: forgedDraft.harness,
      writerCredentialId: forgedDraft.writerCredentialId,
    });
    const forged = { ...forgedDraft, rowDigest: forgedRow };
    expect((await doctorIntegrity("P-DOC", [forged], pin)).sound).toBe(false);
  });
});
