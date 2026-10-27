import { describe, expect, test } from "bun:test";
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
});
