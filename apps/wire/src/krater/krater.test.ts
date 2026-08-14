import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  cursorMatchesEvents,
  deterministicWorkload,
  eventChainDigest,
  eventChainMatches,
  genesisChainDigest,
  type KraterEvent,
  KraterReplayError,
  KraterValidationError,
  outboxMatchesEvents,
  projectionReplayMatches,
  replayClaimProjections,
  sha256Hex,
  transactionBoundaryMatches,
  validateFtsReadInput,
} from "./krater";

function event(
  problemId: string,
  seq: number,
  payloadSha256: string,
  rowDigest = `${seq}`.repeat(64).slice(0, 64),
  chainDigest = `${seq + 4}`.repeat(64).slice(0, 64),
): KraterEvent {
  return {
    eventId: `E-${problemId}-${seq}`,
    problemId,
    seq,
    type: "claim.created",
    objectId: `C-${problemId}-${seq}`,
    payloadSha256,
    rowDigest,
    chainDigest,
    createdAt: "2026-08-14T00:00:00.000Z",
  };
}

/**
 * Pure contract checks only. The real D1 transaction, FTS, trigger, pagination,
 * disconnect, and restart evidence is executed by scripts/e2e-s2-krater.sh.
 * No D1-shaped substitute is constructed here.
 */
describe("Krater deterministic contracts", () => {
  test("canonicalizes object keys independently of construction order", async () => {
    const left = canonicalJson({ statement: "synthetic", claim_id: "C-1", kind: "claim" });
    const right = canonicalJson({ kind: "claim", claim_id: "C-1", statement: "synthetic" });

    expect(left).toBe(right);
    expect(await sha256Hex(left)).toBe(await sha256Hex(right));
  });

  test("generates a stable large bounded synthetic workload with unique idempotency keys", () => {
    const first = deterministicWorkload("s2seed", 201, "2026-08-14T00:00:00.000Z");
    const second = deterministicWorkload("s2seed", 201, "2026-08-14T00:00:00.000Z");

    expect(first).toEqual(second);
    expect(first[0]?.idempotencyKey).toBe("IK-s2seed-001");
    expect(first[200]?.idempotencyKey).toBe("IK-s2seed-201");
    expect(new Set(first.map((item) => item.idempotencyKey)).size).toBe(201);
  });

  test("keeps sequence allocation per problem scope", () => {
    const alpha = [event("P-alpha", 1, "a".repeat(64))];
    const beta = [event("P-beta", 1, "b".repeat(64))];

    expect(replayClaimProjections(alpha)[0]).toMatchObject({ problemId: "P-alpha", sourceSeq: 1 });
    expect(replayClaimProjections(beta)[0]).toMatchObject({ problemId: "P-beta", sourceSeq: 1 });
    expect(cursorMatchesEvents(1, alpha)).toBe(true);
    expect(cursorMatchesEvents(1, beta)).toBe(true);
  });

  test("models one-event transaction boundaries across cursor, projection, and outbox", () => {
    const events = [event("P-s2", 1, "a".repeat(64)), event("P-s2", 2, "b".repeat(64))];
    const projections = replayClaimProjections(events);
    const outbox = events.map((current) => ({
      eventId: current.eventId,
      kind: "search.index" as const,
      state: "pending" as const,
    }));

    expect(projectionReplayMatches(events, projections)).toBe(true);
    expect(outboxMatchesEvents(events, outbox)).toBe(true);
    expect(transactionBoundaryMatches(2, events, projections, outbox)).toBe(true);
    expect(transactionBoundaryMatches(1, events, projections, outbox)).toBe(false);
  });

  test("validates bounded FTS read inputs before the real-D1 FTS query", () => {
    expect(() => validateFtsReadInput("synthetic AND claim", 10)).not.toThrow();
    expect(() => validateFtsReadInput("", 10)).toThrow(KraterValidationError);
    expect(() => validateFtsReadInput("synthetic", 51)).toThrow(KraterValidationError);
  });

  test("replays contiguous envelopes and rejects sequence gaps or mixed scopes", () => {
    const first = event("P-s2", 1, "a".repeat(64));
    const second = event("P-s2", 2, "b".repeat(64));
    const events = [first, second];
    expect(replayClaimProjections(events)).toHaveLength(2);
    expect(() => replayClaimProjections([event("P-s2", 2, "c".repeat(64))])).toThrow(
      KraterReplayError,
    );
    expect(() => replayClaimProjections([first, event("P-other", 2, "d".repeat(64))])).toThrow(
      KraterReplayError,
    );
  });

  test("derives a per-problem chain and detects a planted envelope mutation", async () => {
    const problemId = "P-chain";
    const firstPayload = "a".repeat(64);
    const secondPayload = "b".repeat(64);
    const genesis = await genesisChainDigest(problemId);
    const firstChain = await eventChainDigest(problemId, 1, firstPayload, genesis);
    const secondChain = await eventChainDigest(problemId, 2, secondPayload, firstChain);
    const first = event(problemId, 1, firstPayload, "1".repeat(64), firstChain);
    const second = event(problemId, 2, secondPayload, "2".repeat(64), secondChain);
    const valid = [first, second];

    expect(await eventChainMatches(valid)).toBe(true);
    expect(await eventChainMatches([first, { ...second, payloadSha256: "c".repeat(64) }])).toBe(
      false,
    );
  });

  test("rejects an invalid deterministic-workload seed", () => {
    expect(() => deterministicWorkload("seed with spaces", 1, "2026-08-14T00:00:00.000Z")).toThrow(
      KraterValidationError,
    );
  });
});
