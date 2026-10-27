import { describe, expect, test } from "bun:test";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { Env } from "../../src/env";
import { writeLedgerEvent } from "../../src/krater/krater";
import { decideScreeningCase } from "../../src/moderation/store";
import {
  isScreeningDecisionChangedError,
  type ScreenedPublication,
  screeningDecisionGuardStatement,
} from "../../src/screening/ingress";
import { screenPublicCandidate } from "../../src/screening/public-candidate";
import type { WorkersAIPromotionInput } from "../../src/screening/workers-ai";
import { OTHER, publicationContextFixture, SPONSOR } from "../support/publication-context";
import { syntheticScreeningObservation } from "../support/screening";

// Native SQLite unit proof over every shipped migration and the real writer.
// The screening provider is synthetic; this does not claim a Workerd/AI gate.
type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;

function publication(value: Response | ScreenedPublication): ScreenedPublication {
  if (value instanceof Response) throw new Error("Expected a passing screened candidate.");
  return value;
}

async function heldCase(f: Fixture, candidate = f.input()) {
  const result = await screenPublicCandidate(
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
  if (!(result instanceof Response)) throw new Error("Expected a retained held case.");
  const { case_id: caseId } = (await result.json()) as { case_id: string };
  expect(caseId).toMatch(/^QC-/);
  return caseId;
}

async function decide(f: Fixture, caseId: string, decision: "release" | "confirm_rejection") {
  expect(
    (
      await decideScreeningCase(f.db, "operator", {
        caseId,
        decision,
        reason: "Reviewed the exact synthetic candidate and its public context.",
      })
    ).ok,
  ).toBe(true);
}

function unavailableCaseReads(db: D1Database): D1Database {
  const faulty = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key, receiver) {
        if (key === "bind") return (...values: unknown[]) => faulty(target.bind(...values));
        if (key === "first")
          return async () => {
            throw new Error("PRIVATE-CASE-READ-FAILURE");
          };
        return Reflect.get(target, key, receiver);
      },
    });
  return {
    ...db,
    prepare(query: string) {
      const statement = db.prepare(query);
      return query.includes("SELECT * FROM screening_cases WHERE fellow_id =")
        ? faulty(statement)
        : statement;
    },
  } as D1Database;
}

describe("durable screening decisions authorize the public transaction", () => {
  test("a reviewer rejection after a passing rescreen vetoes every publication companion", async () => {
    const f = await publicationContextFixture();
    try {
      const candidate = f.input();
      const caseId = await heldCase(f, candidate);
      const screened = publication(await f.screen(candidate));
      expect(screened.supersedeInputDigest).toBeDefined();
      await decide(f, caseId, "confirm_rejection");
      const before = f.state();
      try {
        await f.write(candidate, screened);
        throw new Error("A model pass overruled an operator's committed rejection.");
      } catch (error) {
        expect(isScreeningDecisionChangedError(error)).toBe(true);
      }
      expect(f.state()).toEqual(before);
      expect(
        f.sql.query("SELECT state FROM screening_cases WHERE case_id = ?").get(caseId),
      ).toEqual({ state: "rejected" });
      const retry = await f.screen(candidate);
      expect(retry instanceof Response && retry.status).toBe(403);
    } finally {
      f.sql.close();
    }
  });

  test("an unreadable case store cannot bypass an existing rejection or buy a model decision", async () => {
    const f = await publicationContextFixture();
    try {
      const candidate = f.input();
      const caseId = await heldCase(f, candidate);
      await decide(f, caseId, "confirm_rejection");
      let calls = 0;
      const before = f.state();
      const result = await screenPublicCandidate(
        (input) => {
          calls++;
          return syntheticScreeningObservation(input, {
            decision: "pass",
            coarse_category: "benign-context",
            provider_status: "ok",
          });
        },
        { DB: unavailableCaseReads(f.db) } as Env,
        candidate,
        { sponsorId: SPONSOR, route: "hypotheses" },
      );
      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = await response.text();
      expect(body).not.toContain("PRIVATE-CASE-READ-FAILURE");
      expect(JSON.parse(body)).toEqual({
        code: "SCREENING_HOLD",
        coarse_category: "provider-unavailable",
        appeal: "SPONSOR_APPEAL_AVAILABLE",
      });
      expect(calls).toBe(0);
      expect(f.state()).toEqual(before);
    } finally {
      f.sql.close();
    }
  });

  test("a new candidate waits for unavailable authority and publishes after the read recovers", async () => {
    const f = await publicationContextFixture();
    try {
      const candidate = f.input();
      const result = await screenPublicCandidate(
        async () => {
          throw new Error("The provider must not be called.");
        },
        { DB: unavailableCaseReads(f.db) } as Env,
        candidate,
        { sponsorId: SPONSOR, route: "hypotheses" },
      );
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(202);
      expect(f.state().events).toEqual([]);
      const accepted = await f.write(candidate, publication(await f.screen(candidate)));
      expect(f.state().events).toEqual([{ id: accepted.eventId, seq: accepted.seq }]);
    } finally {
      f.sql.close();
    }
  });

  test("a committed receipt replays after an overlapping old-context hold is rejected", async () => {
    const f = await publicationContextFixture();
    let resume: (() => void) | undefined;
    let arrived: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const suspended = new Promise<void>((resolve) => {
      resume = resolve;
    });
    try {
      const candidate = f.input();
      const held = screenPublicCandidate(
        async (input: WorkersAIPromotionInput) => {
          arrived?.();
          await suspended;
          return syntheticScreeningObservation(input, {
            decision: "quarantine",
            coarse_category: "injection",
            provider_status: "ok",
          });
        },
        { DB: f.db } as Env,
        candidate,
        { sponsorId: SPONSOR, route: "hypotheses" },
      );
      await entered;
      const screened = publication(await f.screen(candidate));
      const member = f.command(candidate, screened);
      const accepted = await writeLedgerEvent(f.db, member.input, member.projection);
      resume?.();
      const response = await held;
      if (!(response instanceof Response))
        throw new Error("Expected the overlapping private hold.");
      const { case_id: caseId } = (await response.json()) as { case_id: string };
      await decide(f, caseId, "confirm_rejection");
      const before = f.state();
      const retry = f.command(candidate, screened, "E-DECISION-REPLAY");
      const replayed = await writeLedgerEvent(
        f.db,
        { ...member.input, eventId: retry.input.eventId },
        retry.projection,
      );
      expect(replayed.idempotent).toBe(true);
      expect(replayed.eventId).toBe(accepted.eventId);
      expect(f.state()).toEqual(before);
    } finally {
      resume?.();
      f.sql.close();
    }
  });

  test("an eventless losing attempt is a no-op even for a rejected candidate", async () => {
    const f = await publicationContextFixture();
    try {
      const candidate = f.input();
      const caseId = await heldCase(f, candidate);
      const screened = publication(await f.screen(candidate));
      await decide(f, caseId, "confirm_rejection");
      const before = f.state();
      await f.db.batch([screeningDecisionGuardStatement(f.db, screened, "E-NOT-WRITTEN")]);
      expect(f.state()).toEqual(before);
    } finally {
      f.sql.close();
    }
  });

  test("operator-release authority requires the exact durable case, actor, problem and digests", async () => {
    const f = await publicationContextFixture();
    try {
      const candidate = f.input();
      const caseId = await heldCase(f, candidate);
      await decide(f, caseId, "release");
      const screened = publication(await f.screen(candidate));
      const before = f.state();
      for (const changed of [
        { ...screened, fellowId: OTHER },
        { ...screened, problemId: "P-ANOTHER" },
        ...[
          { review_case_id: `QC-${"0".repeat(26)}` },
          { input_digest: "0".repeat(64) },
          { context_digest: "0".repeat(64) },
        ].map((patch) => ({ ...screened, provenance: { ...screened.provenance, ...patch } })),
      ]) {
        const member = f.command(candidate);
        try {
          await writeLedgerEvent(f.db, member.input, {
            statementsAfterEvent: () => [
              screeningDecisionGuardStatement(f.db, changed, member.input.eventId),
            ],
          });
          throw new Error("An inexact reviewer release authorized publication.");
        } catch (error) {
          expect(isScreeningDecisionChangedError(error)).toBe(true);
        }
        expect(f.state()).toEqual(before);
      }
      const accepted = await f.write(candidate, screened);
      expect(f.state().events).toEqual([{ id: accepted.eventId, seq: accepted.seq }]);
    } finally {
      f.sql.close();
    }
  });
});
