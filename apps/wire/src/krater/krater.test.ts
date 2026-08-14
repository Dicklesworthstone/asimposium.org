import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  deterministicWorkload,
  KraterReplayError,
  KraterValidationError,
  projectionReplayMatches,
  replayClaimProjections,
  sha256Hex,
} from "./krater";

/**
 * These are deterministic unit contracts for canonicalization, workload
 * generation, and replay. They deliberately do not construct a D1-shaped
 * object: real D1 transaction and fault proof lives in e2e-s2-krater.sh.
 */
describe("Krater deterministic contracts", () => {
  test("canonicalizes object keys independently of construction order", async () => {
    const left = canonicalJson({ statement: "synthetic", claim_id: "C-1", kind: "claim" });
    const right = canonicalJson({ kind: "claim", claim_id: "C-1", statement: "synthetic" });

    expect(left).toBe(right);
    expect(await sha256Hex(left)).toBe(await sha256Hex(right));
  });

  test("generates a stable bounded synthetic workload", () => {
    const first = deterministicWorkload("s2seed", 3, "2026-08-14T00:00:00.000Z");
    const second = deterministicWorkload("s2seed", 3, "2026-08-14T00:00:00.000Z");

    expect(first).toEqual(second);
    expect(first.map((item) => item.idempotencyKey)).toEqual([
      "IK-s2seed-001",
      "IK-s2seed-002",
      "IK-s2seed-003",
    ]);
  });

  test("replays contiguous envelopes into the projection shape", () => {
    const events = [
      {
        eventId: "E-s2-001",
        problemId: "P-s2",
        seq: 1,
        type: "claim.created" as const,
        objectId: "C-s2-001",
        payloadSha256: "a".repeat(64),
        createdAt: "2026-08-14T00:00:00.000Z",
      },
      {
        eventId: "E-s2-002",
        problemId: "P-s2",
        seq: 2,
        type: "claim.created" as const,
        objectId: "C-s2-002",
        payloadSha256: "b".repeat(64),
        createdAt: "2026-08-14T00:00:01.000Z",
      },
    ];

    const projections = replayClaimProjections(events);
    expect(projections).toHaveLength(2);
    expect(projections[1]).toMatchObject({ claimId: "C-s2-002", sourceSeq: 2, stale: false });
    expect(projectionReplayMatches(events, projections)).toBe(true);
  });

  test("planted replay fault rejects a sequence gap", () => {
    expect(() =>
      replayClaimProjections([
        {
          eventId: "E-s2-gap",
          problemId: "P-s2",
          seq: 2,
          type: "claim.created",
          objectId: "C-s2-gap",
          payloadSha256: "c".repeat(64),
          createdAt: "2026-08-14T00:00:00.000Z",
        },
      ]),
    ).toThrow(KraterReplayError);
  });

  test("planted workload fault rejects an invalid seed", () => {
    expect(() => deterministicWorkload("seed with spaces", 1, "2026-08-14T00:00:00.000Z")).toThrow(
      KraterValidationError,
    );
  });
});
