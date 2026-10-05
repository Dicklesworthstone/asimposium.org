import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Glob } from "bun";

import {
  eventTypeIsKnown,
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

// 79n: unknown event types. Every event type the Worker writes is either
// replayed or known not to project; any other type in a log is unreplayable.
// The scans below are textual: a writer in a form none of them reads is missed
// here and caught only by the runtime census each real-bindings lane runs
// (problem-lifecycle-real-bindings.mjs, qnw4).
describe("replay knows every event type the Worker writes (79n)", () => {
  const src = resolve(import.meta.dir, "../../src");
  const written = new Set<string>();
  // Found by each qnw4 scan alone, so the nonvacuity test proves each scan.
  const sqlWritten = new Set<string>();
  const templated = new Set<string>();
  const chosen = new Set<string>();
  for (const file of new Glob("**/*.ts").scanSync(src)) {
    if (file.endsWith(".test.ts")) continue;
    const text = readFileSync(join(src, file), "utf8");
    // `eventType:` at the writers, `type:` in Krater's own claim writers.
    for (const match of text.matchAll(
      /\b(?:eventType|type): "((?:claim|review|evidence|hypothesis|dead_end|question|object|citation|gap|conflict|synthesis|relation|problem|lease|commentary|artifact)\.[a-z_.-]+)"/g,
    )) {
      written.add(match[1] as string);
    }
    // qnw4: SQL writers name the type as a single-quoted literal inside the
    // event insert itself (INSERT INTO events ... SELECT ..., 'relation.disputed').
    // Reads, display maps and tamper fixtures elsewhere are not writers.
    for (const insert of text.matchAll(/INSERT INTO events\b[^`]*`/g)) {
      for (const match of insert[0].matchAll(
        /'((?:claim|review|evidence|hypothesis|dead_end|question|object|citation|gap|conflict|synthesis|relation|problem|lease|commentary|artifact)\.[a-z_-]+(?:\.[a-z_-]+)*)'/g,
      )) {
        sqlWritten.add(match[1] as string);
        written.add(match[1] as string);
      }
    }
    // qnw4: a type chosen before the write (`const eventType = cond ? "a" : "b";`).
    for (const statement of text.matchAll(/\bconst eventType = ([^;]+);/g)) {
      for (const match of (statement[1] as string).matchAll(/"([a-z_]+\.[a-z_.-]+)"/g)) {
        chosen.add(match[1] as string);
        written.add(match[1] as string);
      }
    }
    // qnw4: a type templated on its writer's mode (`gap.${input.mode}`) is
    // each literal that file's `readonly mode:` unions allow.
    const modes = [...text.matchAll(/readonly mode: ((?:"[a-z_-]+"(?: \| )?)+);/g)].flatMap(
      (match) => [...(match[1] as string).matchAll(/"([a-z_-]+)"/g)].map((m) => m[1] as string),
    );
    for (const match of text.matchAll(/([a-z_]+)\.\$\{input\.mode\}/g)) {
      for (const mode of modes) {
        templated.add(`${match[1]}.${mode}`);
        written.add(`${match[1]}.${mode}`);
      }
    }
  }
  const governance = readFileSync(join(src, "problems/lifecycle-ledger.ts"), "utf8");
  const table = /const governanceEventTypes = \{([\s\S]*?)\} as const;/.exec(governance)?.[1] ?? "";
  for (const match of table.matchAll(/: "([a-z_]+\.[a-z_.-]+)"/g)) written.add(match[1] as string);

  test("the census finds the written types", () => {
    // Nonvacuity: the scan must see the main ledger writers.
    for (const type of ["claim.created", "review.created", "problem.merged", "lease.acquired"]) {
      expect([...written]).toContain(type);
    }
    // qnw4: the SQL-literal scan alone sees krater's relation dispute insert,
    // and the template expansion alone sees every gap writer mode.
    expect([...sqlWritten]).toContain("relation.disputed");
    expect([...templated].sort()).toEqual(["gap.closed-by", "gap.filed", "gap.withdrawn"]);
    expect([...chosen]).toContain("commentary.superseded");
  });

  test.each([...written].sort())("%s is replayed or known not to project", (type) => {
    expect(eventTypeIsKnown(type)).toBe(true);
  });

  test("an unknown type is unreplayable, a known non-projecting one is not", async () => {
    const event = (seq: number, type: string): LogEvent =>
      ({
        id: `E-${seq}`,
        seq,
        type,
        objectKind: "x",
        objectId: null,
        objectVersion: null,
        createdAt: "2026-10-05T00:00:00.000Z",
        payload: {},
      }) as unknown as LogEvent;
    const replay = await replayProjections("P-4DSP", [
      event(1, "lease.acquired"),
      event(2, "lane.unknown-write"),
    ]);
    expect(replay.unreplayable).toEqual(["E-2"]);
  });
});
