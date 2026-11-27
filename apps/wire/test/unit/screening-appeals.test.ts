import { describe, expect, test } from "bun:test";
import { ScreeningPromotionDeniedResponseSchema } from "@asimposium/contracts";
import {
  ScreeningAppealDecisionSchema,
  ScreeningAppealRequestSchema,
} from "@asimposium/contracts/appeals";
import type { Env } from "../../src/env";
import { hardDeletePrivateDraft } from "../../src/krater/retention";
import {
  decideScreeningAppeal,
  operatorScreeningAppeals,
  sponsorScreeningCases,
  submitScreeningAppeal,
} from "../../src/moderation/appeals-store";
import { operatorQuarantineCase } from "../../src/moderation/operator-http";
import { decideScreeningCase, screeningCaseFor } from "../../src/moderation/store";
import { screenPublicCandidate } from "../../src/screening/public-candidate";
import {
  FELLOW,
  PROBLEM,
  publicationContextFixture,
  SPONSOR,
} from "../support/publication-context";
import { syntheticScreeningObservation } from "../support/screening";

const original = "usr_original_operator",
  appellate = "usr_appeal_operator";
const explanation =
  "The held candidate is a mathematical statement; please reconsider its precise scope.";
const reason =
  "I reviewed the exact candidate, context, original rejection and sponsor's explanation.";
type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
async function hold(f: Fixture, candidate = f.input()) {
  const r = await screenPublicCandidate(
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
  if (!(r instanceof Response)) throw new Error("Expected hold");
  return ((await r.json()) as { case_id: string }).case_id;
}
async function rejected(f: Fixture, candidate = f.input()) {
  const caseId = await hold(f, candidate);
  expect(
    (await decideScreeningCase(f.db, original, { caseId, decision: "confirm_rejection", reason }))
      .ok,
  ).toBe(true);
  return caseId;
}
async function machineDenied(f: Fixture, candidate = f.input()) {
  const response = await screenPublicCandidate(
    (input) =>
      syntheticScreeningObservation(input, {
        decision: "reject",
        coarse_category: "injection",
        provider_status: "ok",
      }),
    { DB: f.db } as Env,
    candidate,
    { sponsorId: SPONSOR, route: "hypotheses" },
  );
  if (!(response instanceof Response)) throw new Error("Expected a publication refusal");
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return ScreeningPromotionDeniedResponseSchema.parse(await response.json());
}
function decision(appealId: string, outcome: "release" | "uphold" = "release") {
  return {
    appeal_id: appealId,
    decision: outcome,
    reason,
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  };
}
async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const f = await publicationContextFixture();
  try {
    await fn(f);
  } finally {
    f.sql.close();
  }
}
describe("human screening appeals", () => {
  test("a direct model denial retains one exact private review case without inventing a human decision", () =>
    withFixture(async (f) => {
      const candidate = f.input("DIRECT_REJECTION_PRIVATE_CANARY: a bounded mathematical claim.");
      const before = f.state();
      const denied = await machineDenied(f, candidate);
      expect(denied.case_id).toMatch(/^QC-[0-9A-HJKMNP-TV-Z]{26}$/);
      if (denied.case_id === undefined) throw new Error("The rejected candidate was not retained");
      expect(Object.keys(denied).sort()).toEqual(["appeal", "case_id", "coarse_category", "code"]);
      expect(await machineDenied(f, candidate)).toEqual(denied);
      expect(f.sql.query("SELECT COUNT(*) AS n FROM screening_cases").get()).toEqual({ n: 1 });
      expect(f.sql.query("SELECT COUNT(*) AS n FROM screening_refusals").get()).toEqual({ n: 1 });
      expect(f.sql.query("SELECT COUNT(*) AS n FROM operator_audit").get()).toEqual({ n: 0 });
      expect(
        f.sql
          .query("SELECT state,outcome,decision_path,decided_at,decided_by FROM screening_cases")
          .get(),
      ).toEqual({
        state: "pending",
        outcome: "quarantine",
        decision_path: "provider",
        decided_at: null,
        decided_by: null,
      });
      const own = await sponsorScreeningCases(f.db, SPONSOR, denied.case_id);
      expect(own.cases[0]).toMatchObject({
        case_id: denied.case_id,
        state: "pending",
        appeal: null,
      });
      expect((await sponsorScreeningCases(f.db, "usr_other", denied.case_id)).cases).toEqual([]);
      const detail = await operatorQuarantineCase(f.db, denied.case_id);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        state: "pending",
        candidate: { statement: candidate.statement, falsifier: candidate.falsifier },
        item: { decision_path: "provider" },
      });
      for (const value of [denied, own, f.sql.query("SELECT * FROM moderation_log").all()])
        expect(JSON.stringify(value)).not.toContain(candidate.statement);
      expect(f.state()).toEqual(before);
    }));

  test("a model denial reaches a real operator decision and independent sponsor appeal before explicit publication", () =>
    withFixture(async (f) => {
      const candidate = f.input();
      const denied = await machineDenied(f, candidate);
      const caseId = denied.case_id;
      if (caseId === undefined) throw new Error("The rejected candidate was not retained");
      const before = f.state();
      await expect(
        submitScreeningAppeal(f.db, SPONSOR, { case_id: caseId, statement: explanation }, "early"),
      ).rejects.toThrow("NOT_FOUND");
      await decideScreeningCase(f.db, original, {
        caseId,
        decision: "confirm_rejection",
        reason,
      });
      expect(await machineDenied(f, candidate)).toEqual(denied);
      const appeal = await submitScreeningAppeal(
        f.db,
        SPONSOR,
        { case_id: caseId, statement: explanation },
        "direct-rejection-appeal",
      );
      await expect(
        decideScreeningAppeal(f.db, original, decision(appeal.appeal_id), "original"),
      ).rejects.toThrow("REVIEWER");
      await expect(
        decideScreeningAppeal(f.db, SPONSOR, decision(appeal.appeal_id), "sponsor"),
      ).rejects.toThrow("REVIEWER");
      await decideScreeningAppeal(f.db, appellate, decision(appeal.appeal_id), "independent");
      expect(f.state()).toEqual(before);
      const screened = await f.screen(candidate);
      if (screened instanceof Response) throw new Error("The exact released candidate was held");
      expect(screened.provenance.decision_path).toBe("operator-release");
      expect(screened.provenance.review_case_id).toBe(caseId);
      await f.write(candidate, screened);
      expect(f.state().events).toHaveLength(1);
      const changed = await machineDenied(f, {
        ...candidate,
        statement: `${candidate.statement} A different candidate is not authorized by that appeal.`,
      });
      expect(changed.case_id).not.toBe(caseId);
      expect(f.state().events).toHaveLength(1);
    }));

  test("failure to retain a directly rejected candidate never weakens the refusal or fabricates a case", () =>
    withFixture(async (f) => {
      f.sql.exec(`CREATE TRIGGER refuse_case_retention BEFORE INSERT ON screening_cases
        BEGIN SELECT RAISE(ABORT, 'LOCAL_CASE_RETENTION_UNAVAILABLE'); END`);
      const before = f.state();
      expect(await machineDenied(f)).toEqual({
        code: "POLICY_DENIED",
        coarse_category: "injection",
        appeal: "SPONSOR_APPEAL_AVAILABLE",
      });
      expect(f.sql.query("SELECT COUNT(*) AS n FROM screening_cases").get()).toEqual({ n: 0 });
      expect(f.sql.query("SELECT COUNT(*) AS n FROM moderation_log").get()).toEqual({ n: 0 });
      expect(f.sql.query("SELECT COUNT(*) AS n FROM operator_audit").get()).toEqual({ n: 0 });
      expect(f.state()).toEqual(before);
    }));

  test("strict contracts reject caller identities, scientific overrides and forged freshness", () => {
    const req = { case_id: `QC-${"0".repeat(26)}`, statement: explanation };
    expect(ScreeningAppealRequestSchema.safeParse(req).success).toBe(true);
    expect(ScreeningAppealRequestSchema.safeParse({ ...req, sponsor_id: SPONSOR }).success).toBe(
      false,
    );
    expect(
      ScreeningAppealDecisionSchema.safeParse({
        ...decision(`AP-${"0".repeat(26)}`),
        disposition: "strongly-supported",
      }).success,
    ).toBe(false);
  });
  test("only the current accountable sponsor can appeal an operator rejection", () =>
    withFixture(async (f) => {
      const pending = await hold(f);
      await expect(
        submitScreeningAppeal(
          f.db,
          SPONSOR,
          { case_id: pending, statement: explanation },
          "pending",
        ),
      ).rejects.toThrow("NOT_FOUND");
      await decideScreeningCase(f.db, original, {
        caseId: pending,
        decision: "confirm_rejection",
        reason,
      });
      expect((await sponsorScreeningCases(f.db, "usr_other")).cases).toEqual([]);
      await expect(
        submitScreeningAppeal(
          f.db,
          "usr_other",
          { case_id: pending, statement: explanation },
          "foreign",
        ),
      ).rejects.toThrow("NOT_FOUND");
      const receipts = await Promise.all(
        [1, 2].map(() =>
          submitScreeningAppeal(
            f.db,
            SPONSOR,
            { case_id: pending, statement: explanation },
            "once",
          ),
        ),
      );
      expect(receipts[0]).toEqual(receipts[1]);
      expect(f.sql.query("SELECT COUNT(*) AS n FROM screening_case_appeals").get()).toEqual({
        n: 1,
      });
      await expect(
        submitScreeningAppeal(
          f.db,
          SPONSOR,
          { case_id: pending, statement: `${explanation} Changed.` },
          "once",
        ),
      ).rejects.toThrow("CONFLICT");
      await expect(
        submitScreeningAppeal(
          f.db,
          SPONSOR,
          { case_id: pending, statement: explanation },
          "another",
        ),
      ).rejects.toThrow("CONFLICT");
    }));
  test("an appellate release preserves original rejection and authorizes only explicit exact-byte publication", () =>
    withFixture(async (f) => {
      const candidate = f.input(),
        caseId = await rejected(f, candidate);
      const before = f.state(),
        submitted = await submitScreeningAppeal(
          f.db,
          SPONSOR,
          { case_id: caseId, statement: explanation },
          "appeal",
        );
      const queue = await operatorScreeningAppeals(f.db);
      expect(queue.appeals[0]?.statement).toBe(explanation);
      expect(queue.appeals[0]?.original_operator_id).toBe(original);
      await expect(
        decideScreeningAppeal(f.db, original, decision(submitted.appeal_id), "original"),
      ).rejects.toThrow("REVIEWER");
      await expect(
        decideScreeningAppeal(f.db, SPONSOR, decision(submitted.appeal_id), "sponsor"),
      ).rejects.toThrow("REVIEWER");
      await expect(
        decideScreeningAppeal(
          f.db,
          appellate,
          { ...decision(submitted.appeal_id), step_up_authenticated_at: 0 },
          "old",
        ),
      ).rejects.toThrow("STEP_UP");
      const receipts = await Promise.all(
        [1, 2].map(() =>
          decideScreeningAppeal(f.db, appellate, decision(submitted.appeal_id), "release"),
        ),
      );
      expect(receipts[0]).toEqual(receipts[1]);
      expect(f.state()).toEqual(before);
      expect(
        f.sql.query("SELECT state,decided_by FROM screening_cases WHERE case_id=?").get(caseId),
      ).toEqual({ state: "rejected", decided_by: original });
      expect(
        f.sql
          .query("SELECT COUNT(*) AS n FROM operator_audit WHERE action='screening-appeal.release'")
          .get(),
      ).toEqual({ n: 1 });
      expect((await sponsorScreeningCases(f.db, SPONSOR, caseId)).cases[0]?.appeal?.state).toBe(
        "released",
      );
      expect((await operatorScreeningAppeals(f.db)).appeals).toEqual([]);
      expect((await operatorScreeningAppeals(f.db, submitted.appeal_id)).appeals[0]?.state).toBe(
        "released",
      );
      const screened = await f.screen(candidate);
      if (screened instanceof Response) throw new Error(`Unexpected ${screened.status}`);
      expect(screened.provenance.decision_path).toBe("operator-release");
      await f.write(candidate, screened);
      expect(f.state().events.length).toBe(1);
      expect(
        await hold(f, { ...candidate, statement: `${candidate.statement} Different bytes.` }),
      ).not.toBe(caseId);
      await expect(
        decideScreeningAppeal(f.db, appellate, decision(submitted.appeal_id, "uphold"), "release"),
      ).rejects.toThrow("CONFLICT");
    }));
  test("upholding an appeal remains a denial and never creates a scientific event", () =>
    withFixture(async (f) => {
      const caseId = await rejected(f),
        before = f.state();
      const a = await submitScreeningAppeal(
        f.db,
        SPONSOR,
        { case_id: caseId, statement: explanation },
        "appeal",
      );
      expect(
        (await decideScreeningAppeal(f.db, appellate, decision(a.appeal_id, "uphold"), "uphold"))
          .state,
      ).toBe("upheld");
      const result = await f.screen();
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(403);
      expect(f.state()).toEqual(before);
      const publicLog = f.sql.query("SELECT * FROM moderation_log").all();
      expect(JSON.stringify(publicLog)).not.toContain(explanation);
      expect(JSON.stringify(publicLog)).not.toContain(reason);
      expect(JSON.stringify(await sponsorScreeningCases(f.db, SPONSOR))).not.toContain(
        "configuration_digest",
      );
    }));
  test("a late notice failure rolls back appellate authority, audit and public log", () =>
    withFixture(async (f) => {
      const caseId = await rejected(f),
        a = await submitScreeningAppeal(
          f.db,
          SPONSOR,
          { case_id: caseId, statement: explanation },
          "appeal",
        );
      f.sql.exec(
        "CREATE TRIGGER fail_appeal_notice BEFORE INSERT ON fellow_inbox_notices WHEN NEW.title = 'A screening appeal was released' BEGIN SELECT RAISE(ABORT,'TEST_NOTICE_FAILED'); END;",
      );
      await expect(
        decideScreeningAppeal(f.db, appellate, decision(a.appeal_id), "release"),
      ).rejects.toThrow("TEST_NOTICE_FAILED");
      expect((await operatorScreeningAppeals(f.db)).appeals[0]?.state).toBe("pending");
      expect(
        f.sql
          .query("SELECT COUNT(*) AS n FROM operator_audit WHERE action LIKE 'screening-appeal.%'")
          .get(),
      ).toEqual({ n: 0 });
      expect(
        (
          await screeningCaseFor(
            f.db,
            FELLOW,
            PROBLEM,
            (
              f.sql
                .query("SELECT input_digest FROM screening_cases WHERE case_id=?")
                .get(caseId) as { input_digest: string }
            ).input_digest,
          )
        )?.state,
      ).toBe("rejected");
    }));
  test("an exact case lookup reaches a rejected receipt beyond the newest fifty cases", () =>
    withFixture(async (f) => {
      const old = await rejected(f);
      for (let i = 0; i < 51; i++) await hold(f, f.input(`A separate held statement number ${i}.`));
      const page = await sponsorScreeningCases(f.db, SPONSOR);
      expect(page.has_more).toBe(true);
      expect(page.cases).toHaveLength(50);
      expect(page.cases.some((item) => item.case_id === old)).toBe(false);
      const exact = await sponsorScreeningCases(f.db, SPONSOR, old);
      expect(exact.has_more).toBe(false);
      expect(exact.cases.map((item) => item.case_id)).toEqual([old]);
      expect(
        (
          await submitScreeningAppeal(
            f.db,
            SPONSOR,
            { case_id: old, statement: explanation },
            "old-case",
          )
        ).state,
      ).toBe("pending");
    }));
  test("competing decisions have one terminal outcome and one audit", () =>
    withFixture(async (f) => {
      const caseId = await rejected(f),
        a = await submitScreeningAppeal(
          f.db,
          SPONSOR,
          { case_id: caseId, statement: explanation },
          "appeal",
        );
      const results = await Promise.allSettled([
        decideScreeningAppeal(f.db, appellate, decision(a.appeal_id, "release"), "release"),
        decideScreeningAppeal(
          f.db,
          "usr_other_appeal_operator",
          decision(a.appeal_id, "uphold"),
          "uphold",
        ),
      ]);
      expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
      expect(
        f.sql
          .query("SELECT COUNT(*) AS n FROM operator_audit WHERE action LIKE 'screening-appeal.%'")
          .get(),
      ).toEqual({ n: 1 });
      expect(f.state().events).toHaveLength(0);
    }));
  test("a transferred Fellow cannot spend an old appellate release", () =>
    withFixture(async (f) => {
      const candidate = f.input(),
        caseId = await rejected(f, candidate);
      const a = await submitScreeningAppeal(
        f.db,
        SPONSOR,
        { case_id: caseId, statement: explanation },
        "appeal",
      );
      await decideScreeningAppeal(f.db, appellate, decision(a.appeal_id), "release");
      const screened = await f.screen(candidate);
      if (screened instanceof Response) throw new Error("Expected exact released candidate");
      const next = "usr_next_owner",
        at = Date.now();
      f.sql
        .query("INSERT INTO sponsors(sponsor_id,created_at,last_seen_at) VALUES(?,?,?)")
        .run(next, at, at);
      f.sql
        .query(`INSERT INTO sponsor_fellow_transfers
      (transfer_id,fellow_id,source_sponsor_id,target_sponsor_id,status,transfer_manifest_json,request_digest,created_at,expires_at,resolved_at)
      VALUES(?,?,?,?,'accepted','{}',?,?,?,?)`)
        .run(`TRF-${"A".repeat(26)}`, FELLOW, SPONSOR, next, "a".repeat(64), at, at + 1000, at);
      f.sql.query("UPDATE enrollment_fellows SET sponsor_id=? WHERE fellow_id=?").run(next, FELLOW);
      expect((await sponsorScreeningCases(f.db, SPONSOR, caseId)).cases).toEqual([]);
      expect((await sponsorScreeningCases(f.db, next, caseId)).cases).toEqual([]);
      expect((await operatorScreeningAppeals(f.db, a.appeal_id)).appeals).toEqual([]);
      await expect(
        submitScreeningAppeal(f.db, SPONSOR, { case_id: caseId, statement: explanation }, "appeal"),
      ).rejects.toThrow("NOT_FOUND");
      await expect(f.write(candidate, screened)).rejects.toThrow();
      expect(f.state().events).toHaveLength(0);
    }));
  test("private erasure scrubs appeal text and removes release authority while retaining decisions", () =>
    withFixture(async (f) => {
      const caseId = await rejected(f),
        a = await submitScreeningAppeal(
          f.db,
          SPONSOR,
          { case_id: caseId, statement: explanation },
          "appeal",
        );
      await decideScreeningAppeal(f.db, appellate, decision(a.appeal_id), "release");
      f.sql
        .query("UPDATE problems SET status='private-draft' WHERE id=? AND public_seq=0")
        .run(PROBLEM);
      await hardDeletePrivateDraft(f.db, PROBLEM, SPONSOR);
      expect(
        f.sql
          .query("SELECT statement,state FROM screening_case_appeals WHERE appeal_id=?")
          .get(a.appeal_id),
      ).toEqual({ statement: "[erased]", state: "released" });
      expect((await sponsorScreeningCases(f.db, SPONSOR, caseId)).cases).toEqual([]);
      expect((await operatorScreeningAppeals(f.db, a.appeal_id)).appeals).toEqual([]);
      expect(f.sql.query("SELECT state FROM screening_cases WHERE case_id=?").get(caseId)).toEqual({
        state: "rejected",
      });
      await expect(
        decideScreeningAppeal(f.db, appellate, decision(a.appeal_id), "release"),
      ).rejects.toThrow("NOT_FOUND");
    }));
  test("account erasure scrubs private appeal statements and suppresses receipt access", () =>
    withFixture(async (f) => {
      const caseId = await rejected(f),
        a = await submitScreeningAppeal(
          f.db,
          SPONSOR,
          { case_id: caseId, statement: explanation },
          "appeal",
        );
      f.sql
        .query("UPDATE sponsors SET tombstoned_at=? WHERE sponsor_id=?")
        .run(Date.now(), SPONSOR);
      expect(
        f.sql
          .query("SELECT statement FROM screening_case_appeals WHERE appeal_id=?")
          .get(a.appeal_id),
      ).toEqual({ statement: "[erased]" });
      expect((await sponsorScreeningCases(f.db, SPONSOR, caseId)).cases).toEqual([]);
      expect((await operatorScreeningAppeals(f.db, a.appeal_id)).appeals).toEqual([]);
      await expect(
        decideScreeningAppeal(f.db, appellate, decision(a.appeal_id), "release"),
      ).rejects.toThrow("NOT_FOUND");
    }));
  test("an automated rejection without attributable case ownership still refuses publication without fabricating a case", () =>
    withFixture(async (f) => {
      let screeningCalls = 0;
      const result = await screenPublicCandidate(
        (input) => {
          screeningCalls++;
          return syntheticScreeningObservation(input, {
            decision: "reject",
            coarse_category: "injection",
            provider_status: "ok",
          });
        },
        { DB: f.db } as Env,
        f.input(),
      );
      expect(screeningCalls).toBe(1);
      if (!(result instanceof Response)) throw new Error("Expected a publication refusal");
      expect(result.status).toBe(403);
      expect(await result.json()).toEqual({
        code: "POLICY_DENIED",
        coarse_category: "injection",
        appeal: "SPONSOR_APPEAL_AVAILABLE",
      });
      expect(f.sql.query("SELECT COUNT(*) AS n FROM screening_cases").get()).toEqual({ n: 0 });
      expect(f.sql.query("SELECT COUNT(*) AS n FROM screening_refusals").get()).toEqual({ n: 0 });
    }));
  test("direct automated 403 POLICY_DENIED retains a pending QC case for operator confirmation, independent appeal, and release (qot3)", () =>
    withFixture(async (f) => {
      const candidate = f.input();
      const rejectOnce = () =>
        screenPublicCandidate(
          (input) =>
            syntheticScreeningObservation(input, {
              decision: "reject",
              coarse_category: "injection",
              provider_status: "ok",
            }),
          { DB: f.db } as Env,
          candidate,
          { sponsorId: SPONSOR, route: "hypotheses" },
        );
      const first = await rejectOnce();
      expect(first).toBeInstanceOf(Response);
      const res = first as Response;
      expect(res.status).toBe(403);
      const rawText = await res.text();
      // ADR-18 oracle starvation: zero pattern names, scores, or prompt excerpts.
      expect(rawText).not.toContain("category_score_bands");
      expect(rawText).not.toContain("matched_pattern");
      expect(rawText).not.toContain("decision_path");
      expect(rawText).not.toContain("prompt");
      const body = JSON.parse(rawText) as {
        code: string;
        coarse_category: string;
        appeal: string;
        case_id?: string;
      };
      expect(body.code).toBe("POLICY_DENIED");
      expect(body.coarse_category).toBe("injection");
      expect(body.case_id).toMatch(/^QC-[0-9A-HJKMNP-TV-Z]{26}$/);
      const caseId = body.case_id as string;

      // Retry of identical bytes returns the exact same QC case idempotently without fabricating a human decision.
      const second = await rejectOnce();
      expect(second).toBeInstanceOf(Response);
      expect((second as Response).status).toBe(403);
      expect(await (second as Response).json()).toEqual(body);
      expect(f.sql.query("SELECT COUNT(*) AS n FROM screening_cases").get()).toEqual({ n: 1 });
      expect(f.sql.query("SELECT COUNT(*) AS n FROM screening_refusals").get()).toEqual({ n: 1 });
      expect(
        f.sql.query("SELECT COUNT(*) AS n FROM moderation_log WHERE action='quarantined'").get(),
      ).toEqual({ n: 1 });

      // Unreviewed automated rejection cases cannot be used as human-reviewed egregious cases for sponsor suspension.
      const { suspendSponsor } = await import("../../src/moderation/sponsor-suspension");
      await expect(
        suspendSponsor(
          f.db,
          SPONSOR,
          appellate,
          {
            sponsor_id: SPONSOR,
            expected_revision: 0,
            reviewed_case_id: caseId,
            basis: "egregious-reviewed-case",
            reason: "Attempting suspension on an unreviewed automated rejection case.",
            step_up_authenticated_at: Math.floor(Date.now() / 1000),
          },
          "suspend-auto-reject",
        ),
      ).rejects.toThrow("CASE");

      // Operator confirms rejection before sponsor appeal opens; no fabricated decided_by.
      expect(
        (
          await decideScreeningCase(f.db, original, {
            caseId,
            decision: "confirm_rejection",
            reason,
          })
        ).ok,
      ).toBe(true);
      expect(
        f.sql.query("SELECT COUNT(*) AS n FROM moderation_log WHERE action='rejected'").get(),
      ).toEqual({ n: 1 });

      // Foreign sponsor cannot view or appeal the case.
      expect((await sponsorScreeningCases(f.db, "usr_other", caseId)).cases).toEqual([]);
      await expect(
        submitScreeningAppeal(
          f.db,
          "usr_other",
          { case_id: caseId, statement: explanation },
          "foreign-direct",
        ),
      ).rejects.toThrow("NOT_FOUND");

      // Accountable sponsor sees the confirmed-rejected case and submits an appeal.
      const owned = await sponsorScreeningCases(f.db, SPONSOR, caseId);
      expect(owned.cases).toHaveLength(1);
      expect(owned.cases[0]?.state).toBe("rejected");
      const appeal = await submitScreeningAppeal(
        f.db,
        SPONSOR,
        { case_id: caseId, statement: explanation },
        "appeal-direct-reject",
      );

      // Operator queue preserves the real confirming operator for independent appellate review.
      const queue = await operatorScreeningAppeals(f.db, appeal.appeal_id);
      expect(queue.appeals).toHaveLength(1);
      expect(queue.appeals[0]?.original_operator_id).toBe(original);

      // Appealing sponsor and original confirming operator cannot decide the appeal.
      await expect(
        decideScreeningAppeal(f.db, SPONSOR, decision(appeal.appeal_id), "self-direct"),
      ).rejects.toThrow("REVIEWER");
      await expect(
        decideScreeningAppeal(f.db, original, decision(appeal.appeal_id), "same-op-direct"),
      ).rejects.toThrow("REVIEWER");

      // An independent allowlisted operator can release with fresh step-up auth.
      const released = await decideScreeningAppeal(
        f.db,
        appellate,
        decision(appeal.appeal_id, "release"),
        "release-direct",
      );
      expect(released.state).toBe("released");
      expect(released.audit_event_id).toMatch(/^OA-/);

      // Exact-byte resubmission now publishes via operator-release without re-asking the model.
      const screened = await f.screen(candidate);
      if (screened instanceof Response) throw new Error(`Unexpected ${screened.status}`);
      expect(screened.provenance.decision_path).toBe("operator-release");
      await f.write(candidate, screened);
      expect(f.state().events).toHaveLength(1);
    }));

  test("upholding an operator-confirmed rejection appeal binds subsequent resubmissions against later model passes (qot3)", () =>
    withFixture(async (f) => {
      const candidate = f.input(
        "For every positive integer n, an automated reject upheld by human review stays bound.",
      );
      const rejected = await screenPublicCandidate(
        (input) =>
          syntheticScreeningObservation(input, {
            decision: "reject",
            coarse_category: "injection",
            provider_status: "ok",
          }),
        { DB: f.db } as Env,
        candidate,
        { sponsorId: SPONSOR, route: "hypotheses" },
      );
      expect(rejected).toBeInstanceOf(Response);
      if (!(rejected instanceof Response)) throw new Error("expected Response");
      expect(rejected.status).toBe(403);
      const body = (await rejected.json()) as { code: string; case_id?: string };
      expect(body.code).toBe("POLICY_DENIED");
      const caseId = body.case_id;
      if (!caseId) throw new Error("expected case_id");

      expect(
        (
          await decideScreeningCase(f.db, original, {
            caseId,
            decision: "confirm_rejection",
            reason,
          })
        ).ok,
      ).toBe(true);
      const appeal = await submitScreeningAppeal(
        f.db,
        SPONSOR,
        { case_id: caseId, statement: "Requesting human review of this direct rejection." },
        "appeal-uphold-direct",
      );
      const upheld = await decideScreeningAppeal(
        f.db,
        appellate,
        decision(appeal.appeal_id, "uphold"),
        "uphold-direct",
      );
      expect(upheld.state).toBe("upheld");

      // Even if the model would now return pass, human-upheld rejection binds deterministically.
      let modelCalled = false;
      const retry = await screenPublicCandidate(
        (input) => {
          modelCalled = true;
          return syntheticScreeningObservation(input, {
            decision: "pass",
            coarse_category: "benign-context",
            provider_status: "ok",
          });
        },
        { DB: f.db } as Env,
        candidate,
        { sponsorId: SPONSOR, route: "hypotheses" },
      );
      expect(modelCalled).toBe(false);
      expect(retry).toBeInstanceOf(Response);
      if (!(retry instanceof Response)) throw new Error("expected Response");
      expect(retry.status).toBe(403);
      expect(await retry.json()).toMatchObject({
        code: "POLICY_DENIED",
        case_id: caseId,
      });
    }));
});
