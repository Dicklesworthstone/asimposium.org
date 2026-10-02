import { describe, expect, test } from "bun:test";

import {
  type LogEvent,
  repairOutcome,
  replayProjections,
  restoredProblemHead,
} from "../../src/krater/projection-replay.ts";

// ys2o: a repair's refusal must describe what it actually wrote. The inserted
// path is proven on real D1 by projection-doctor-real-bindings.mjs step 3b;
// the zero-insert path needs drift that appears between a clean first check
// and the re-check with no insert to hang a trigger on, so it is decided here.
describe("projection repair outcome (ys2o)", () => {
  test("consistent after the re-check is no refusal, whatever was inserted", () => {
    expect(repairOutcome(0, 0)).toBeNull();
    expect(repairOutcome(3, 0)).toBeNull();
  });

  test("drift after committed inserts says rows were inserted", () => {
    expect(repairOutcome(1, 1)).toBe("PROJECTION_REPAIR_INCOMPLETE");
  });

  test("drift with nothing inserted never claims an insert", () => {
    expect(repairOutcome(0, 2)).toBe("PROJECTION_DRIFT_NOT_REPAIRABLE");
  });
});

// 48js review: a publish event written before unlisted was recorded cannot say
// whether the sponsor chose an index listing, so restore never lists it.
describe("restored problem head (48js)", () => {
  test("the log's unlisted value is kept either way", () => {
    expect(restoredProblemHead({ status: "sharpening", unlisted: 0 }).unlisted).toBe(0);
    expect(restoredProblemHead({ status: "sharpening", unlisted: 1 }).unlisted).toBe(1);
  });

  test("a published problem with no recorded unlisted is restored unlisted", () => {
    expect(restoredProblemHead({ status: "sharpening", title: "T" })).toEqual({
      status: "sharpening",
      title: "T",
      unlisted: 1,
    });
  });

  test("a head the log does not determine at all is left alone", () => {
    expect(restoredProblemHead({})).toEqual({});
  });
});

// 48js review: a redacted governance event hides a head change, so the doctor
// must say "unreplayable" rather than report drift it cannot judge.
describe("redacted governance events (48js)", () => {
  const event = (seq: number, type: string, payload: Record<string, unknown> | null): LogEvent => ({
    id: `PG-${seq}`,
    seq,
    type,
    objectId: "P-X",
    objectVersion: 1,
    payloadSha256: null,
    rowDigest: null,
    createdAt: "2026-10-02T00:00:00.000Z",
    actorFellowId: null,
    actorSponsorId: "usr_s",
    actorSessionId: null,
    actorModel: null,
    actorHarness: null,
    payload,
  });
  const problem = { title: "T", status: "sharpening", current_statement_version: 1 };

  test("a redacted head-only event is unreplayable", async () => {
    const replay = await replayProjections("P-X", [
      event(1, "problem.writer-cap-changed", { problem }),
      event(2, "problem.retired", null),
    ]);
    expect(replay.unreplayable).toEqual(["PG-2"]);
    expect(replay.head.status).toBe("sharpening");
  });

  test("a redacted publish is listed once", async () => {
    const replay = await replayProjections("P-X", [event(1, "problem.admitted", null)]);
    expect(replay.unreplayable).toEqual(["PG-1"]);
  });

  test("unredacted governance events are replayable", async () => {
    const replay = await replayProjections("P-X", [
      event(1, "problem.writer-cap-changed", { problem }),
      event(2, "problem.retired", { problem: { ...problem, status: "retired" } }),
    ]);
    expect(replay.unreplayable).toEqual([]);
    expect(replay.head.status).toBe("retired");
  });
});
