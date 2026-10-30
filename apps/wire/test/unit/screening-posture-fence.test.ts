import { describe, expect, test } from "bun:test";
import type { Env } from "../../src/env";
import { writeLedgerEvent } from "../../src/krater/krater";
import {
  isScreeningPostureChangedError,
  postureOf,
  recordRefusal,
  screeningPostureGuardStatement,
} from "../../src/moderation/posture";
import { decideScreeningCase } from "../../src/moderation/store";
import type { ScreenedPublication } from "../../src/screening/ingress";
import { screenPublicCandidate } from "../../src/screening/public-candidate";
import {
  FELLOW,
  PROBLEM,
  publicationContextFixture,
  SPONSOR,
} from "../support/publication-context";
import { syntheticScreeningObservation } from "../support/screening";

// Native SQLite unit proof over the shipped migrations and production writer.
// Provider decisions are synthetic; this is not a Workerd/Workers-AI gate.
type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
const refusal = (f: Fixture, n: number) =>
  recordRefusal(f.db, {
    fellowId: FELLOW,
    sponsorId: SPONSOR,
    problemId: PROBLEM,
    outcome: "reject",
    coarseCategory: "injection",
    inputDigest: n.toString(16).padStart(64, "0"),
  });

function publication(value: Response | ScreenedPublication): ScreenedPublication {
  if (value instanceof Response) throw new Error("The test expected a screened publication.");
  return value;
}

async function releasedCandidate(f: Fixture) {
  const candidate = f.input("The exact candidate the operator reviewed.");
  const held = await screenPublicCandidate(
    (input) =>
      syntheticScreeningObservation(input, {
        decision: "quarantine",
        coarse_category: "injection",
        provider_status: "ok",
      }),
    { DB: f.db } as Env,
    candidate,
    { sponsorId: SPONSOR, route: "hypotheses" },
  );
  if (!(held instanceof Response)) throw new Error("Expected a retained private case.");
  const { case_id: caseId } = (await held.json()) as { case_id: string };
  expect(caseId).toMatch(/^QC-/);
  await refusal(f, 2);
  await refusal(f, 3);
  expect((await postureOf(f.db, FELLOW)).quarantineFirst).toBe(true);
  expect(
    (
      await decideScreeningCase(f.db, "operator", {
        caseId,
        decision: "release",
        reason: "Reviewed this exact candidate and its bounded public context.",
      })
    ).ok,
  ).toBe(true);
  return { candidate, screened: publication(await f.screen(candidate)), caseId };
}

describe("publication authority is checked in the ledger transaction", () => {
  test("an engaged posture after screening cannot publish an event or replay receipt", async () => {
    const f = await publicationContextFixture();
    try {
      await refusal(f, 1);
      await refusal(f, 2);
      const candidate = f.input();
      const screened = publication(await f.screen(candidate));
      const before = f.state();
      await refusal(f, 3);
      try {
        await f.write(candidate, screened);
        throw new Error("A stale passing screen published after quarantine engaged.");
      } catch (error) {
        expect(isScreeningPostureChangedError(error)).toBe(true);
      }
      expect(f.state()).toEqual(before);
    } finally {
      f.sql.close();
    }
  });

  test("a committed publication remains replayable after a later posture change", async () => {
    const f = await publicationContextFixture();
    try {
      const candidate = f.input();
      const screened = publication(await f.screen(candidate));
      const member = f.command(candidate, screened);
      const committed = await writeLedgerEvent(f.db, member.input, member.projection);
      const before = f.state();
      for (const n of [1, 2, 3]) await refusal(f, n);
      // A new request attempt mints a fresh event ID but elects the existing
      // idempotency key. Its eventless companion must not gate the old receipt.
      const retry = f.command(candidate, screened, "E-CONTEXT-RETRY");
      const replay = await writeLedgerEvent(
        f.db,
        {
          ...member.input,
          eventId: retry.input.eventId,
        },
        retry.projection,
      );
      expect(replay.eventId).toBe(committed.eventId);
      expect(replay.seq).toBe(committed.seq);
      expect(replay.idempotent).toBe(true);
      expect(f.state()).toEqual(before);
    } finally {
      f.sql.close();
    }
  });

  test("a losing write with no public event does not spuriously abort its transaction", async () => {
    const f = await publicationContextFixture();
    try {
      for (const n of [1, 2, 3]) await refusal(f, n);
      const before = f.state();
      await f.db.batch([
        screeningPostureGuardStatement(f.db, {
          eventId: "E-NOT-COMMITTED",
          problemId: PROBLEM,
          fellowId: FELLOW,
          inputDigest: "a".repeat(64),
          contextDigest: "b".repeat(64),
        }),
      ]);
      expect(f.state()).toEqual(before);
    } finally {
      f.sql.close();
    }
  });

  test("an exact durable operator release permits its reviewed publication under the posture", async () => {
    const f = await publicationContextFixture();
    try {
      const { candidate, screened, caseId } = await releasedCandidate(f);
      expect(screened.provenance.review_case_id).toBe(caseId);
      const committed = await f.write(candidate, screened);
      expect(f.state().events).toEqual([{ id: committed.eventId, seq: committed.seq }]);
      expect((await postureOf(f.db, FELLOW)).quarantineFirst).toBe(true);
    } finally {
      f.sql.close();
    }
  });

  test("a release never authorizes a different case, candidate digest or context", async () => {
    const f = await publicationContextFixture();
    try {
      const { candidate, screened } = await releasedCandidate(f);
      const before = f.state();
      const provenance = screened.provenance;
      if (provenance.decision_path !== "operator-release") throw new Error("Expected an operator release");
      for (const change of [
        { review_case_id: `QC-${"0".repeat(26)}` },
        { input_digest: "0".repeat(64) },
        { context_digest: "0".repeat(64) },
      ]) {
        try {
          await f.write(candidate, {
            ...screened,
            provenance: { ...provenance, ...change },
          });
          throw new Error("A mismatched release authorized publication.");
        } catch (error) {
          expect(isScreeningPostureChangedError(error)).toBe(true);
        }
        expect(f.state()).toEqual(before);
      }
    } finally {
      f.sql.close();
    }
  });
});
