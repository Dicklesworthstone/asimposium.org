import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  AdminQuarantineCaseDetailSchema,
  ProblemDocumentSchema,
  ScreeningPromotionHoldResponseSchema,
  ScreeningPublicationProvenanceSchema,
} from "@asimposium/contracts";
import type { Env } from "../../src/env";
import { redactEventContent, writeLedgerBatch, writeLedgerEvent } from "../../src/krater/krater";
import { assessEvidenceClass } from "../../src/ledger/evidence-class";
import { operatorQuarantineCase } from "../../src/moderation/operator-http";
import { decideScreeningCase } from "../../src/moderation/store";
import type { ScreenedPublication } from "../../src/screening/ingress";
import { screenPublicCandidate } from "../../src/screening/public-candidate";
import {
  isScreeningContextStaleError,
  MAX_PUBLICATION_SCREENING_BODY_BYTES,
  readPublicationContext,
  screeningContextStaleProblem,
  screeningContextUnavailableProblem,
} from "../../src/screening/publication-context";
import { POLICY_CATEGORIES } from "../../src/screening/types";
import {
  promotionScreeningBinding,
  screenPromotionWithWorkersAI,
  type WorkersAiBinding,
} from "../../src/screening/workers-ai";
import {
  FELLOW,
  publicationContextFixture as fixture,
  NOW,
  OTHER,
  PROBLEM,
  SPONSOR,
} from "../support/publication-context";
import { syntheticScreeningObservation } from "../support/screening";

const classification = (decision = "pass", category = "benign-context") => ({
  response: JSON.stringify({
    decision,
    coarse_category: category,
    bands: Object.fromEntries(POLICY_CATEGORIES.map((name) => [name, null])),
  }),
});

function publication(value: Response | ScreenedPublication): ScreenedPublication {
  assert.ok(!(value instanceof Response), "screening should produce a bound publication");
  return value;
}

async function scientificHistory(
  f: Awaited<ReturnType<typeof fixture>>,
  kind: "evidence-hypothesis" | "evidence-claim" | "review-claim",
) {
  const targetKind = kind === "evidence-hypothesis" ? "hypothesis" : "claim";
  const targetId = targetKind === "hypothesis" ? "H-ABCD" : "C-1";
  const targetInput = f.command(
    { ...f.input("Public target"), fellowId: OTHER },
    undefined,
    "EV-CONTEXT-TARGET",
  ).input;
  const target = await writeLedgerEvent(
    f.db,
    {
      ...targetInput,
      eventType: targetKind === "hypothesis" ? "hypothesis.created" : "claim.created",
      objectKind: targetKind,
      objectId: targetId,
      payloadJson: JSON.stringify(
        targetKind === "hypothesis"
          ? {
              route: "Public route",
              mechanism: "Public mechanism",
              falsifier: "A counterexample",
              origin: "proposed",
            }
          : {
              claim_id: targetId,
              kind: "conjecture",
              statement: "Public target",
              falsifier: "A counterexample",
              dependency_pins: [],
            },
      ),
    },
    {
      statementsAfterEvent: ({ sequence, eventId, payloadSha256, createdAt }) =>
        targetKind === "hypothesis"
          ? [
              f.db
                .prepare(`INSERT INTO hypotheses
                (hypothesis_id,problem_id,route,mechanism,falsifier,origin,author_fellow_id,created_at,source_event_id,source_seq)
                VALUES(?,?,'Public route','Public mechanism','A counterexample','proposed',?,?,?,?)`)
                .bind(targetId, PROBLEM, OTHER, createdAt, eventId, sequence),
            ]
          : [
              f.db
                .prepare(`INSERT INTO claims(id,problem_id,statement,payload_sha256,source_seq,created_at)
                VALUES(?,?,'Public target',?,?,?)`)
                .bind(targetId, PROBLEM, payloadSha256, sequence, createdAt),
              f.db
                .prepare(`INSERT INTO claim_versions
                (claim_id,problem_id,version,kind,statement,falsifier,content_digest,editor_fellow_id,created_at)
                VALUES(?,?,1,'conjecture','Public target','A counterexample',?,?,?)`)
                .bind(targetId, PROBLEM, `sha256:${payloadSha256}`, OTHER, createdAt),
            ],
    },
  );
  const review = kind === "review-claim";
  const recordId = review ? "R-ABCD" : "E-ABCD";
  const canary = `PUBLIC-DEPENDENT-CONTENT-${kind}`;
  const assessment = assessEvidenceClass({ source: { kind: "model_memory" }, mode: "exploratory" });
  const payload = review
    ? {
        target_claim_id: targetId,
        target_version: 1,
        tier: "T0",
        verdict: "inform",
        basis: "looks-right",
        capable_of_failure: "A counterexample",
        rubric: [],
        body_md: canary,
      }
    : {
        bears_on_kind: targetKind,
        bears_on_id: targetId,
        bears_on_version: targetKind === "claim" ? 1 : null,
        direction: "informs",
        kind: "argument",
        source: { kind: "model_memory" },
        mode: "exploratory",
        computed_class: assessment.class,
        coercion_flags: assessment.flags,
        body_md: canary,
      };
  const childInput = f.command(f.input(canary), undefined, "EV-CONTEXT-DEPENDENT").input;
  const child = await writeLedgerEvent(
    f.db,
    {
      ...childInput,
      eventType: review ? "review.created" : "evidence.created",
      objectKind: review ? "review" : "evidence",
      objectId: recordId,
      payloadJson: JSON.stringify(payload),
    },
    {
      statementsAfterEvent: ({ sequence, eventId, createdAt }) =>
        review
          ? [
              f.db
                .prepare(`INSERT INTO reviews
                (review_id,problem_id,target_claim_id,target_version,reviewer_fellow_id,tier,verdict,basis,capable_of_failure,body_md,created_at,source_event_id,source_seq)
                VALUES(?,?,?,1,?,'T0','inform','looks-right','A counterexample',?,?,?,?)`)
                .bind(recordId, PROBLEM, targetId, FELLOW, canary, createdAt, eventId, sequence),
            ]
          : [
              f.db
                .prepare(`INSERT INTO evidence
                (evidence_id,problem_id,bears_on_kind,bears_on_id,bears_on_version,direction,kind,source_kind,mode,computed_class,coercion_flags_json,author_fellow_id,body_md,created_at,source_event_id,source_seq)
                VALUES(?,?,?,?,?,'informs','argument','model_memory','exploratory',?,?,?,?,?,?,?)`)
                .bind(
                  recordId,
                  PROBLEM,
                  targetKind,
                  targetId,
                  targetKind === "claim" ? 1 : null,
                  assessment.class,
                  JSON.stringify(assessment.flags),
                  FELLOW,
                  canary,
                  createdAt,
                  eventId,
                  sequence,
                ),
            ],
    },
  );
  const visibility = (value: "hidden" | "visible", version = 1) => {
    f.sql
      .query(`INSERT INTO content_controls
      (control_id,problem_id,target_kind,target_ref,visibility,source,reason_category,actor,reason,version,created_at)
      VALUES(?,?,?,?,?,'operator','privacy','operator-context','Target visibility change.',?,?)`)
      .run(`CC-TARGET-${version}`, PROBLEM, targetKind, targetId, value, version, NOW());
  };
  return { target, targetId, child, canary, visibility };
}

for (const kind of ["evidence-hypothesis", "evidence-claim", "review-claim"] as const)
  for (const change of ["hidden", "redacted"] as const)
    test(`${kind} target ${change} removes dependent history, refuses retained case access and aborts its stale screen`, async () => {
      const f = await fixture();
      try {
        const source = await scientificHistory(f, kind);
        const initial = await readPublicationContext(f.db, f.input());
        assert.equal(initial.visiblePublicationCount, 1);
        assert.equal(initial.recentPublications[0]?.eventId, source.child.eventId);
        assert.ok(JSON.stringify(initial).includes(source.canary));

        const held = await screenPublicCandidate(
          (input) =>
            syntheticScreeningObservation(input, {
              decision: "quarantine",
              coarse_category: "operational-harm",
              provider_status: "ok",
            }),
          { DB: f.db } as Env,
          f.input("Candidate retained with its public target context"),
          { sponsorId: SPONSOR, route: "hypotheses" },
        );
        assert.ok(held instanceof Response);
        assert.equal(held.status, 202);
        const hold = ScreeningPromotionHoldResponseSchema.parse(await held.json());
        assert.ok(hold.case_id);
        const visibleCase = await operatorQuarantineCase(f.db, hold.case_id);
        assert.equal(visibleCase.status, 200);
        assert.ok((await visibleCase.text()).includes(source.canary));

        const candidate = f.input("Publication pinned before target visibility changed");
        const screened = publication(await f.screen(candidate));
        if (change === "hidden") source.visibility("hidden");
        else await redactEventContent(f.db, source.target.eventId, "privacy", NOW());

        const current = await readPublicationContext(f.db, candidate);
        assert.equal(current.visiblePublicationCount, 0);
        assert.equal(current.recentPublications.length, 0);
        assert.equal(current.sameFellowHead?.eventId, source.child.eventId);
        assert.ok(!JSON.stringify(current).includes(source.canary));
        let providerBody = "";
        const afterChange = publication(
          await screenPublicCandidate(
            (input) =>
              screenPromotionWithWorkersAI(
                {
                  async run(_model, request) {
                    providerBody =
                      request.messages.find((message) => message.role === "user")?.content ?? "";
                    return classification();
                  },
                },
                input,
              ),
            { DB: f.db } as Env,
            candidate,
            { sponsorId: SPONSOR, route: "hypotheses" },
          ),
        );
        assert.ok(providerBody.includes(candidate.statement));
        assert.ok(!providerBody.includes(source.canary));
        const unavailableCase = await operatorQuarantineCase(f.db, hold.case_id);
        assert.equal(unavailableCase.status, 503);
        assert.ok(!(await unavailableCase.text()).includes(source.canary));
        const before = f.state();
        await assert.rejects(f.write(candidate, screened), isScreeningContextStaleError);
        assert.deepEqual(f.state(), before);

        if (change === "hidden") {
          source.visibility("visible", 2);
          const restored = await readPublicationContext(f.db, candidate);
          assert.equal(restored.visiblePublicationCount, 1);
          assert.ok(JSON.stringify(restored).includes(source.canary));
          const restoredCase = await operatorQuarantineCase(f.db, hold.case_id);
          assert.equal(restoredCase.status, 200);
          assert.ok((await restoredCase.text()).includes(source.canary));
          const beforeRestoreWrite = f.state();
          await assert.rejects(f.write(candidate, afterChange), isScreeningContextStaleError);
          assert.deepEqual(f.state(), beforeRestoreWrite);
        }
      } finally {
        f.sql.close();
      }
    });

test("historical claim review context keeps its exact target when a later version is redacted", async () => {
  const f = await fixture();
  try {
    const source = await scientificHistory(f, "review-claim");
    const nextInput = f.command(
      { ...f.input("Later formulation"), fellowId: OTHER },
      undefined,
      "EV-LATER-CLAIM",
    ).input;
    const later = await writeLedgerEvent(
      f.db,
      {
        ...nextInput,
        eventType: "claim.revised",
        objectKind: "claim",
        objectId: source.targetId,
        objectVersion: 2,
        payloadJson: JSON.stringify({
          claim_id: source.targetId,
          base_version: 1,
          statement: "Later formulation",
          dependency_pins: [],
        }),
      },
      {
        statementsAfterEvent: ({ sequence, payloadSha256, createdAt }) => [
          f.db
            .prepare(
              "UPDATE claims SET statement='Later formulation',payload_sha256=?,source_seq=? WHERE problem_id=? AND id=?",
            )
            .bind(payloadSha256, sequence, PROBLEM, source.targetId),
          f.db
            .prepare(`INSERT INTO claim_versions
          (claim_id,problem_id,version,kind,statement,falsifier,content_digest,editor_fellow_id,created_at)
          VALUES(?,?,2,'conjecture','Later formulation','A counterexample',?,?,?)`)
            .bind(source.targetId, PROBLEM, `sha256:${payloadSha256}`, OTHER, createdAt),
        ],
      },
    );
    await redactEventContent(f.db, later.eventId, "privacy", NOW());
    const current = await readPublicationContext(f.db, f.input());
    assert.equal(current.visiblePublicationCount, 1);
    assert.equal(current.recentPublications[0]?.eventId, source.child.eventId);
    assert.ok(JSON.stringify(current).includes(source.canary));
    const candidate = f.input("Publication using the still-public historical review");
    await f.write(candidate, publication(await f.screen(candidate)));
  } finally {
    f.sql.close();
  }
});

test("production context contains exact public statement and six verified same-Fellow bodies only", async () => {
  const f = await fixture();
  try {
    await f.seedProblem("P-PRIVATE", "private-draft", "PRIVATE-DRAFT-CONTEXT-CANARY");
    await f.write({ ...f.input("OTHER-FELLOW-CANARY"), fellowId: OTHER });
    const hidden = await f.write(f.input("HIDDEN-HISTORY-CANARY"));
    f.visible(`H-${hidden.eventId}`, "hidden");
    const redacted = await f.write(f.input("REDACTED-HISTORY-CANARY"));
    await redactEventContent(f.db, redacted.eventId, "privacy", NOW());
    for (let index = 0; index < 7; index++) await f.write(f.input(`PUBLIC-OWN-${index}`));
    const snapshot = await readPublicationContext(f.db, f.input());
    assert.equal(snapshot.statement?.statement, "Exact public problem statement.");
    assert.equal(snapshot.statement?.falsifier, "Exact public falsifier.");
    assert.equal(snapshot.recentPublications.length, 6);
    assert.equal(snapshot.visiblePublicationCount, 7);
    const serialized = JSON.stringify(snapshot);
    for (const hiddenValue of [
      "OTHER-FELLOW-CANARY",
      "HIDDEN-HISTORY-CANARY",
      "REDACTED-HISTORY-CANARY",
      "PRIVATE-DRAFT-CONTEXT-CANARY",
      "PUBLIC-OWN-0",
    ])
      assert.ok(!serialized.includes(hiddenValue));
    for (let index = 1; index < 7; index++) assert.ok(serialized.includes(`PUBLIC-OWN-${index}`));
    assert.equal(snapshot.sameFellowHead?.eventId, snapshot.recentPublications[0]?.eventId);
  } finally {
    f.sql.close();
  }
});

test("live adapter evaluates complete candidate, public history and unpublished prefix as one context", async () => {
  const f = await fixture();
  try {
    await f.write(f.input("PUBLIC-AGGREGATE-PART"));
    const candidate = f.input(
      JSON.stringify({
        title: "TITLE-CANARY",
        extract: "EXTRACT-CANARY",
        body_md: "CURRENT-AGGREGATE-PART",
        public_artifact_md: "ARTIFACT-CANARY",
      }),
    );
    const snapshot = await readPublicationContext(f.db, candidate);
    let received = "";
    const ai: WorkersAiBinding = {
      async run(_model, input) {
        received = input.messages.find((message) => message.role === "user")?.content ?? "";
        assert.ok(input.messages[0]?.content.includes("cumulative capability"));
        return received.includes("PUBLIC-AGGREGATE-PART") &&
          received.includes("PENDING-AGGREGATE-PART")
          ? classification("quarantine", "operational-harm")
          : classification();
      },
    };
    const result = await screenPublicCandidate(
      (input) => screenPromotionWithWorkersAI(ai, input),
      { DB: f.db } as Env,
      candidate,
      { sponsorId: SPONSOR, route: "hypotheses" },
      {
        snapshot,
        precedingCandidates: [
          { eventId: "E-PENDING-NOT-PUBLIC", input: f.input("PENDING-AGGREGATE-PART") },
        ],
      },
    );
    assert.ok(result instanceof Response);
    assert.equal(result.status, 202);
    const hold = ScreeningPromotionHoldResponseSchema.parse(await result.json());
    assert.ok(hold.case_id);
    for (const text of [
      "TITLE-CANARY",
      "EXTRACT-CANARY",
      "ARTIFACT-CANARY",
      "CURRENT-AGGREGATE-PART",
      "PUBLIC-AGGREGATE-PART",
      "PENDING-AGGREGATE-PART",
      "Exact public problem statement.",
      "Exact falsifier.",
    ])
      assert.ok(received.includes(text), `${text} must be evaluated`);
    assert.ok(!received.includes("E-PENDING-NOT-PUBLIC"));
    const detail = await operatorQuarantineCase(f.db, hold.case_id);
    assert.equal(detail.status, 200);
    const parsed = AdminQuarantineCaseDetailSchema.parse(await detail.json());
    assert.equal(parsed.candidate.statement, candidate.statement);
    assert.equal(
      parsed.candidate.context?.pending_batch_candidates[0]?.statement,
      "PENDING-AGGREGATE-PART",
    );
    assert.equal(f.state().events.length, 1, "a held candidate and prefix remain unpublished");
  } finally {
    f.sql.close();
  }
});

test("production adapter cannot fall back to a candidate-only model call", async () => {
  let calls = 0;
  await assert.rejects(
    screenPromotionWithWorkersAI(
      {
        async run() {
          calls++;
          return classification();
        },
      },
      {
        problemId: PROBLEM,
        fellowId: FELLOW,
        kind: "claim",
        statement: "Exact candidate",
        falsifier: null,
      },
    ),
  );
  assert.equal(calls, 0);
});

test("initial publication has no private draft context and other private-problem screening refuses", async () => {
  const f = await fixture();
  try {
    await f.seedProblem("P-PRIVATE", "private-draft", "PRIVATE-STORED-WORDING");
    const initial = {
      ...f.input("Proposed public wording"),
      problemId: "P-PRIVATE",
      kind: "problem-proposal",
    };
    const snapshot = await readPublicationContext(f.db, initial);
    assert.equal(snapshot.mode, "initial-publication");
    assert.equal(snapshot.statement, null);
    const binding = await promotionScreeningBinding({
      ...initial,
      publicationContext: { snapshot, precedingCandidates: [] },
    });
    assert.ok(!binding.body.includes("PRIVATE-STORED-WORDING"));
    assert.ok(binding.body.includes("Proposed public wording"));
    const refused = await f.screen({ ...initial, kind: "hypotheses" });
    assert.ok(refused instanceof Response);
    assert.equal(
      ProblemDocumentSchema.parse(await refused.json()).code,
      "SCREENING_CONTEXT_UNAVAILABLE",
    );
  } finally {
    f.sql.close();
  }
});

test("overlapping same-Fellow publication invalidates a stale screen and rolls the whole candidate back", async () => {
  const f = await fixture();
  try {
    const screened = publication(
      await f.screen(f.input("Screened against old author history"), async () => {
        await f.write(f.input("Concurrent aggregate addition"));
      }),
    );
    const before = f.state();
    await assert.rejects(
      f.write(f.input("Screened against old author history"), screened),
      isScreeningContextStaleError,
    );
    assert.deepEqual(f.state(), before);
    const refusal = screeningContextStaleProblem();
    assert.equal(refusal.status, 409);
    assert.equal(ProblemDocumentSchema.parse(await refusal.json()).code, "SCREENING_CONTEXT_STALE");
  } finally {
    f.sql.close();
  }
});

test("unrelated Fellow publication does not invalidate an otherwise exact contextual screen", async () => {
  const f = await fixture();
  try {
    const candidate = f.input();
    const screened = publication(
      await f.screen(candidate, async () => {
        await f.write({ ...f.input("Another Fellow's new event"), fellowId: OTHER });
      }),
    );
    const written = await f.write(candidate, screened);
    const row = f.sql
      .query("SELECT provenance_json FROM screening_publications WHERE event_id=?")
      .get(written.eventId) as { provenance_json: string };
    const receipt = ScreeningPublicationProvenanceSchema.parse(JSON.parse(row.provenance_json));
    assert.equal(receipt.scope, "candidate-and-public-context");
    assert.ok(row.provenance_json.length <= 4096);
    assert.ok(!row.provenance_json.includes(candidate.statement));
  } finally {
    f.sql.close();
  }
});

for (const change of ["hidden", "redacted", "statement", "restored"] as const)
  test(`consumed-context ${change} change invalidates a screen even without a new Fellow event`, async () => {
    const f = await fixture();
    try {
      const old = await f.write(f.input("Context source"));
      if (change === "restored") f.visible(`H-${old.eventId}`, "hidden");
      const candidate = f.input("Pending publication");
      const screened = publication(
        await f.screen(candidate, async () => {
          if (change === "hidden") f.visible(`H-${old.eventId}`, "hidden");
          else if (change === "redacted")
            await redactEventContent(f.db, old.eventId, "privacy", NOW());
          else if (change === "restored") f.visible(`H-${old.eventId}`, "visible", 2);
          else {
            f.sql
              .query(`INSERT INTO problem_statement_versions(problem_id,version,statement,norm_hash,falsifier,motivation,created_at)
            VALUES(?,2,'New public formulation','sha256:new','New falsifier','New motivation',?)`)
              .run(PROBLEM, NOW());
            f.sql.query("UPDATE problems SET current_statement_version=2 WHERE id=?").run(PROBLEM);
          }
        }),
      );
      const before = f.state();
      await assert.rejects(f.write(candidate, screened), isScreeningContextStaleError);
      assert.deepEqual(f.state(), before);
    } finally {
      f.sql.close();
    }
  });

test("atomic prefix is screened as pending, then commits only with its matching contextual receipt", async () => {
  const f = await fixture();
  try {
    const first = f.input("Earlier atomic candidate");
    const second = f.input("Later atomic candidate");
    const snapshot = await readPublicationContext(f.db, first);
    const screenedFirst = publication(
      await f.screen(first, undefined, { snapshot, precedingCandidates: [] }),
    );
    const firstCommand = f.command(first, screenedFirst, "E-CONTEXT-BATCH-A");
    const screenedSecond = publication(
      await f.screen(second, undefined, {
        snapshot,
        precedingCandidates: [{ eventId: firstCommand.input.eventId, input: first }],
      }),
    );
    const secondCommand = {
      ...f.command(second, screenedSecond, "E-CONTEXT-BATCH-B"),
      causedByEventIds: [firstCommand.input.eventId],
    };
    await writeLedgerBatch(f.db, [firstCommand, secondCommand], () => []);
    assert.equal(f.state().events.length, 2);
    assert.equal(f.state().receipts.length, 2);
    assert.equal(screenedSecond.provenance.version, "ledger-publication-screening.v2");
    if (screenedSecond.provenance.version === "ledger-publication-screening.v2")
      assert.equal(screenedSecond.provenance.context.pending_batch_candidate_count, 1);
  } finally {
    f.sql.close();
  }
});

test("unknown concurrent author event aborts a whole screened atomic prefix", async () => {
  const f = await fixture();
  try {
    const first = f.input("First candidate"),
      second = f.input("Second candidate");
    const snapshot = await readPublicationContext(f.db, first);
    const one = f.command(
      first,
      publication(await f.screen(first, undefined, { snapshot, precedingCandidates: [] })),
      "E-CONTEXT-RACE-A",
    );
    const two = f.command(
      second,
      publication(
        await f.screen(second, undefined, {
          snapshot,
          precedingCandidates: [{ eventId: one.input.eventId, input: first }],
        }),
      ),
      "E-CONTEXT-RACE-B",
    );
    await f.write(f.input("Outside the screened prefix"));
    const before = f.state();
    await assert.rejects(
      writeLedgerBatch(f.db, [one, two], () => []),
      isScreeningContextStaleError,
    );
    assert.deepEqual(f.state(), before);
  } finally {
    f.sql.close();
  }
});

test("operator release binds the evaluated public context; changed context receives a fresh held case", async () => {
  const f = await fixture();
  try {
    const history = await f.write(f.input("History visible to the operator"));
    let calls = 0;
    const hold = async () =>
      screenPublicCandidate(
        async (input) => {
          calls++;
          return syntheticScreeningObservation(input, {
            decision: "quarantine",
            coarse_category: "operational-harm",
            provider_status: "ok",
          });
        },
        { DB: f.db } as Env,
        f.input("Held exact candidate"),
        { sponsorId: SPONSOR, route: "hypotheses" },
      );
    const first = await hold();
    assert.ok(first instanceof Response);
    const caseId = ScreeningPromotionHoldResponseSchema.parse(await first.json()).case_id;
    assert.ok(caseId);
    assert.equal(
      (
        await decideScreeningCase(f.db, "operator-context", {
          caseId,
          decision: "release",
          reason: "Reviewed the complete evaluated context.",
        })
      ).ok,
      true,
    );
    const released = publication(await hold());
    assert.equal(released.provenance.decision_path, "operator-release");
    assert.equal(calls, 1);
    await f.write(f.input("Later same-Fellow public context"));
    const changed = await hold();
    assert.ok(changed instanceof Response);
    const changedId = ScreeningPromotionHoldResponseSchema.parse(await changed.json()).case_id;
    assert.ok(changedId && changedId !== caseId);
    assert.equal(calls, 2);
    await redactEventContent(f.db, history.eventId, "privacy", NOW());
    const oldDetail = await operatorQuarantineCase(f.db, caseId);
    assert.equal(oldDetail.status, 503);
    assert.ok(!(await oldDetail.text()).includes("History visible to the operator"));
    assert.throws(
      () =>
        f.sql
          .query("UPDATE screening_cases SET contextual_input_json='{}' WHERE case_id=?")
          .run(caseId),
      /IMMUTABLE/,
    );
  } finally {
    f.sql.close();
  }
});

test("combined input budget refuses before the model or case store and never truncates a candidate", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const result = await screenPublicCandidate(
      async (input) => {
        calls++;
        return syntheticScreeningObservation(input, {
          decision: "pass",
          coarse_category: "benign-context",
          provider_status: "ok",
        });
      },
      { DB: f.db } as Env,
      f.input("x".repeat(MAX_PUBLICATION_SCREENING_BODY_BYTES)),
      { sponsorId: SPONSOR, route: "hypotheses" },
    );
    assert.ok(result instanceof Response);
    assert.equal(result.status, 503);
    const body = ProblemDocumentSchema.parse(await result.json());
    assert.equal(body.code, "SCREENING_CONTEXT_UNAVAILABLE");
    assert.equal(calls, 0);
    assert.equal(
      (f.sql.query("SELECT COUNT(*) AS n FROM screening_cases").get() as { n: number }).n,
      0,
    );
    assert.equal(f.state().events.length, 0);
    assert.equal(screeningContextUnavailableProblem().status, 503);
  } finally {
    f.sql.close();
  }
});
