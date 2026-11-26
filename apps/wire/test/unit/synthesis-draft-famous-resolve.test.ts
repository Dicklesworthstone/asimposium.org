import { expect, test } from "bun:test";
import {
  type ClaimDependencyPin,
  ExternalExpertReviewRecordSchema,
  ProblemDocumentSchema,
  type ProblemLifecycleActionRequest,
  SynthesisDraftListResponseSchema,
  SynthesisDraftPublishResponseSchema,
  SynthesisDraftResponseSchema,
  SynthesisItemSchema,
} from "@asimposium/contracts";
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "../../../web/lib/service-envelope.ts";
import { createApp } from "../../src/app.ts";
import { toHex } from "../../src/auth/canonical.ts";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import {
  canonicalJson,
  type KraterLedgerProjectionPlan,
  sha256Hex,
  writeLedgerEvent,
} from "../../src/krater/krater.ts";
import { SCIENTIFIC_INDEPENDENCE_POLICY } from "../../src/ledger/scientific-checks.ts";
import { readSynthesisPage } from "../../src/ledger/synthesis-read.ts";
import { sponsorScreeningCases } from "../../src/moderation/appeals-store.ts";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger.ts";
import { createSynthesisDraftsAndExternalReviewsApp } from "../../src/problems/nkz2-router.ts";
import {
  type PublishDraftResult,
  publishSynthesisDraftForSponsor,
} from "../../src/problems/synthesis-drafts.ts";
import {
  type PublicCandidateScreener,
  screenPublicCandidate,
} from "../../src/screening/public-candidate.ts";
import type { WorkersAIPromotionInput } from "../../src/screening/workers-ai.ts";
import {
  FELLOW,
  NOW,
  PROBLEM,
  publicationContextFixture,
  SPONSOR,
} from "../support/publication-context.ts";
import { syntheticScreeningObservation } from "../support/screening.ts";

type Problem = Parameters<typeof applyPublicProblemGovernance>[1];

const CLAIM = "C-1";
const SUMMARY = "Two equals two within the exact declared finite scope.";
const BOUNDARY = {
  verified: ["The exact equality two equals two."],
  mechanisms: ["An attempted falsifier and two independent full write-up verifications."],
  independence_tiers: ["T2"],
  remaining_external_validation: ["Independent domain-expert referee confirmation recorded."],
};
const TITLE = "A famous finite equality benchmark";
const FAMOUS_GUARDRAIL = JSON.stringify({
  canonical_formulation: "Determine whether 2 = 2 in Peano arithmetic.",
  variant_distinctions: "Restricted to exact finite Peano equality.",
  authoritative_references: ["Peano, Arithmetices principia (1889)"],
  standing_banner: "Famous benchmark problem; external expert review required for resolution.",
});

function expectPublishResult(result: PublishDraftResult | Response): PublishDraftResult {
  if (result instanceof Response)
    throw new Error(`Expected a publication result, received HTTP ${result.status}`);
  return result;
}

function draftScreening(
  db: Env["DB"],
  sponsorId = SPONSOR,
  screener: PublicCandidateScreener = (input) =>
    syntheticScreeningObservation(input, {
      decision: "pass",
      coarse_category: "benign-context",
      provider_status: "ok",
    }),
) {
  return {
    sponsorLimit: 60,
    screen: (input: WorkersAIPromotionInput, authorSponsorId = sponsorId) =>
      screenPublicCandidate(screener, { DB: db } as Env, input, {
        sponsorId: authorSponsorId,
        route: "synthesize",
      }),
  };
}

async function seedResolvedFixture(options: { famous: boolean }) {
  const f = await publicationContextFixture();
  let serial = 0;
  const source = async (
    type: string,
    kind: string,
    objectId: string | null,
    payload: Record<string, unknown>,
    projection?: KraterLedgerProjectionPlan["statementsAfterEvent"],
    fellow: string | null = FELLOW,
    sponsor = SPONSOR,
  ) => {
    const eventId = `EV-NKZ2-${++serial}`;
    const body = canonicalJson(payload);
    const result = await writeLedgerEvent(
      f.db,
      {
        problemId: PROBLEM,
        eventId,
        idempotencyKey: `seed-nkz2-${eventId}`,
        requestDigest: await sha256Hex(body),
        eventType: type,
        objectKind: kind,
        objectId: objectId ?? eventId,
        objectVersion: 1,
        payloadJson: body,
        createdAt: NOW(),
        attribution:
          fellow === null
            ? {
                principalType: "sponsor",
                sponsorId: sponsor,
                fellowId: null,
                sessionId: null,
                modelSelfDeclared: null,
                harness: null,
              }
            : {
                sponsorId: sponsor,
                fellowId: fellow,
                sessionId: "S-CONTEXT",
                modelSelfDeclared: `model-${fellow}`,
                harness: "native-fixture",
              },
      },
      { statementsAfterEvent: projection ?? (() => []) },
    );
    return { eventId, seq: result.seq, hash: result.payloadSha256, body };
  };

  f.sql
    .query(
      "UPDATE problems SET title = ?, created_by_fellow_id = ?, famous_guardrail = ? WHERE id = ?",
    )
    .run(TITLE, FELLOW, options.famous ? FAMOUS_GUARDRAIL : null, PROBLEM);

  const formulation = {
    id: PROBLEM,
    title: TITLE,
    current_statement_version: 1,
    statement: "Exact public problem statement.",
    falsifier: "Exact public falsifier.",
    motivation: "Exact public motivation.",
    updated_at: NOW(),
  };

  await source(
    "problem.admitted",
    "problem",
    PROBLEM,
    {
      action: "publish",
      acting_principal: { type: "sponsor", id: SPONSOR },
      source_fellow_id: FELLOW,
      previous_status: "private-draft",
      previous_statement_version: 1,
      problem: { ...formulation, status: "sharpening" },
    },
    undefined,
    null,
  );

  const claimBody = {
    falsifier: "An unequal result.",
    kind: "lemma",
    statement: "Two equals two.",
  };
  const contentDigest = `sha256:${await sha256Hex(canonicalJson(claimBody))}`;
  const claim = await source(
    "claim.created",
    "claim",
    CLAIM,
    {
      claim_id: CLAIM,
      ...claimBody,
      dependency_pins: [],
      scientific_provenance: { model_family_self_declared: "gpt" },
    },
    ({ sequence, payloadSha256, createdAt }) => [
      f.db
        .prepare(
          `INSERT INTO claims
            (id,problem_id,statement,payload_sha256,source_seq,created_at) VALUES(?,?,?,?,?,?)`,
        )
        .bind(CLAIM, PROBLEM, claimBody.statement, payloadSha256, sequence, createdAt),
      f.db
        .prepare(
          `INSERT INTO claim_versions
            (claim_id,problem_id,version,kind,statement,falsifier,content_digest,editor_fellow_id,created_at)
           VALUES(?,?,1,?,?,?,?,?,?)`,
        )
        .bind(
          CLAIM,
          PROBLEM,
          claimBody.kind,
          claimBody.statement,
          claimBody.falsifier,
          contentDigest,
          FELLOW,
          createdAt,
        ),
    ],
  );

  const resultClaim: ClaimDependencyPin = {
    claim_id: CLAIM,
    version: 1,
    content_digest: contentDigest,
    event_id: claim.eventId,
    payload_digest: claim.hash,
  };

  const evidence = async (
    id: string,
    direction: "supports" | "informs",
    fields: Record<string, unknown>,
  ) =>
    source(
      "evidence.created",
      "evidence",
      id,
      {
        bears_on_kind: "claim",
        bears_on_id: CLAIM,
        bears_on_version: 1,
        kind: "argument",
        source_kind: "locator",
        mode: "confirmatory",
        computed_class: "citation",
        direction,
        body_md: "The complete finite argument.",
        ...fields,
      },
      ({ eventId, sequence, createdAt }) => [
        f.db
          .prepare(
            `INSERT INTO evidence
              (evidence_id,problem_id,bears_on_kind,bears_on_id,bears_on_version,direction,kind,source_kind,
               mode,computed_class,author_fellow_id,body_md,created_at,source_event_id,source_seq)
             VALUES(?,?,'claim',?,1,?,'argument','locator','confirmatory','citation',?,?,?,?,?)`,
          )
          .bind(
            id,
            PROBLEM,
            CLAIM,
            direction,
            FELLOW,
            "The complete finite argument.",
            createdAt,
            eventId,
            sequence,
          ),
      ],
    );

  const proof = await evidence("E-PROOF", "supports", {});
  const reference = { evidence_id: "E-PROOF", digest: `sha256:${proof.hash}` };
  await evidence("E-CHECK", "informs", {
    falsification_check: {
      target_digest: contentDigest,
      attempted_falsifier: "Compare the two values.",
      capable_of_failure: "The values could differ.",
      result: "survived",
      evidence: [reference],
    },
  });

  for (const [id, family] of [
    ["ONE", "claude"],
    ["TWO", "gemini"],
  ]) {
    const reviewer = `F-${id}`;
    await source(
      "review.created",
      "review",
      `R-${id}`,
      {
        target_claim_id: CLAIM,
        target_version: 1,
        verdict: "confirm",
        basis: "full-write-up",
        capable_of_failure: "The equality could fail.",
        body_md: "Independently verified the complete argument.",
        tier: "T2",
        independence_policy: SCIENTIFIC_INDEPENDENCE_POLICY,
        scientific_provenance: { model_family_self_declared: family },
        verification: {
          kind: "full-write-up",
          target_digest: contentDigest,
          evidence: reference,
          coverage: ["The complete equality argument."],
          result: "verified",
        },
      },
      ({ eventId, sequence, createdAt }) => [
        f.db
          .prepare(
            `INSERT INTO reviews
              (review_id,problem_id,target_claim_id,target_version,reviewer_fellow_id,tier,verdict,basis,
               capable_of_failure,body_md,created_at,source_event_id,source_seq)
             VALUES(?,?,?,1,?,'T2','confirm','full-write-up',?,?,?,?,?)`,
          )
          .bind(
            `R-${id}`,
            PROBLEM,
            CLAIM,
            reviewer,
            "The equality could fail.",
            "Independently verified the complete argument.",
            createdAt,
            eventId,
            sequence,
          ),
      ],
      reviewer,
      `usr_${id}`,
    );
  }

  const lineage = await sha256Hex("resolution-lineage");
  const scope = await sha256Hex("resolution-scope");
  const coverage = await sha256Hex("resolution-coverage");
  const disclosureBody = {
    kind: "directive-disclosure",
    target: {
      problem_id: PROBLEM,
      claim_id: CLAIM,
      version: 1,
      content_digest: contentDigest,
      publication_event_id: claim.eventId,
    },
    sponsor_id: SPONSOR,
    fellow_id: FELLOW,
    scope_id: scope,
    coverage_digest: coverage,
    revision: 1,
    decision: "no-undisclosed",
  };
  await source(
    "directive.disclosure-recorded",
    "directive-disclosure",
    null,
    disclosureBody,
    ({ eventId, sequence, payloadSha256, createdAt }) => [
      f.db
        .prepare(
          `INSERT INTO directive_disclosure_records
            (event_id,problem_id,claim_id,claim_version,content_digest,source_event_id,sponsor_id,fellow_id,
             scope_id,coverage_digest,lineage_digest,revision,decision,seq,idempotency_key_digest,request_digest,
             public_payload_sha256,public_payload_json,recorded_at)
           VALUES(?,?,?,1,?,?,?,?,?,?,?,1,'no-undisclosed',?,?,?,?,?,?)`,
        )
        .bind(
          eventId,
          PROBLEM,
          CLAIM,
          contentDigest,
          claim.eventId,
          SPONSOR,
          FELLOW,
          scope,
          coverage,
          lineage,
          sequence,
          "a".repeat(64),
          "b".repeat(64),
          payloadSha256,
          canonicalJson(disclosureBody),
          createdAt,
        ),
      f.db
        .prepare(
          `INSERT INTO directive_disclosure_targets
            (problem_id,claim_id,claim_version,content_digest,source_event_id,lineage_digest,lineage_json,
             scope_requirements_json,invalidated,last_event_id,last_event_seq)
           VALUES(?,?,1,?,?,?,?,?,0,?,?)`,
        )
        .bind(
          PROBLEM,
          CLAIM,
          contentDigest,
          claim.eventId,
          lineage,
          JSON.stringify({
            pins: [{ ...resultClaim, payload_json: claim.body }],
            fellows: [{ fellow_id: FELLOW, sponsor_id: SPONSOR }],
          }),
          JSON.stringify([{ scope_id: scope, coverage_digest: coverage }]),
          eventId,
          sequence,
        ),
    ],
    null,
  );

  const problemRow = () =>
    f.sql.query("SELECT * FROM problems WHERE id = ?").get(PROBLEM) as Problem;
  const apply = (action: Parameters<typeof applyPublicProblemGovernance>[3], key: string) =>
    applyPublicProblemGovernance(
      f.db,
      problemRow(),
      SPONSOR,
      action,
      new Request(`https://a.asimposium.org/v1/sponsors/problems/${PROBLEM}/lifecycle`, {
        method: "POST",
        headers: { "idempotency-key": key },
      }),
    );

  const enterRes = await apply(
    { action: "enter-result-review", result_claim: { claim_id: CLAIM, version: 1 } },
    "enter-rr",
  );
  expect(enterRes.status).toBe(200);

  const through = (
    f.sql.query("SELECT public_seq FROM problems WHERE id = ?").get(PROBLEM) as {
      public_seq: number;
    }
  ).public_seq;
  await source("synthesis.created", "synthesis", "SYNTH-CLOSING", {
    covers_through: through,
    body_md: SUMMARY,
    anchors: [{ target_kind: "claim", target_id: CLAIM, target_version: 1, target_seq: claim.seq }],
    omitted: [],
    selection_policy: "Include the complete earned result basis.",
    dropped_single_author_count: 0,
    closing_resolution: {
      result_claim: { claim_id: CLAIM, version: 1 },
      direction: "affirmed",
      no_claim_boundary: BOUNDARY,
    },
  });

  return { f, claim, contentDigest, through, apply, problemRow };
}

async function privateSynthesisFixture() {
  const fixture = await seedResolvedFixture({ famous: false });
  const synthesisId = `SYNTH-${"P".repeat(26)}`;
  const candidate = {
    covers_through: fixture.problemRow().public_seq,
    body_md: "A private synthesis of the exact finite equality result.",
    anchors: [
      { target_kind: "claim", target_id: CLAIM, target_version: 1, target_seq: fixture.claim.seq },
    ],
    omitted: ["Unverified alternatives remain outside this summary."],
    selection_policy: "Include the exact supported claim and its scope.",
  };
  fixture.f.sql
    .query(
      `INSERT INTO synthesis_drafts
        (synthesis_id, problem_id, covers_through, body_md, anchors_json, omitted_json,
         selection_policy, dropped_single_author_count, author_fellow_id, author_sponsor_id,
         session_id, declared_model, harness, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'S-CONTEXT', 'model', 'harness', 'draft', ?)`,
    )
    .run(
      synthesisId,
      PROBLEM,
      candidate.covers_through,
      candidate.body_md,
      JSON.stringify(candidate.anchors),
      JSON.stringify(candidate.omitted),
      candidate.selection_policy,
      FELLOW,
      SPONSOR,
      NOW(),
    );
  const publicState = () => ({
    head: fixture.problemRow().public_seq,
    cursor: fixture.f.sql.query("SELECT cursor FROM public_cursor WHERE singleton = 1").get(),
    event: fixture.f.sql.query("SELECT id FROM events WHERE object_id = ?").get(synthesisId),
    synthesis: fixture.f.sql
      .query("SELECT synthesis_id FROM syntheses WHERE synthesis_id = ?")
      .get(synthesisId),
    draft: fixture.f.sql
      .query("SELECT state, published_event_id FROM synthesis_drafts WHERE synthesis_id = ?")
      .get(synthesisId),
  });
  const reservations = () =>
    fixture.f.sql
      .query(
        "SELECT status FROM public_write_attempt_reservations WHERE route = 'synthesis-draft-publish'",
      )
      .all();
  return { ...fixture, synthesisId, candidate, publicState, reservations };
}

for (const decision of ["quarantine", "reject", "provider-error", "wrong-digest"] as const) {
  test(`draft publication preserves private work and public state on ${decision}`, async () => {
    const { f, synthesisId, candidate, publicState, reservations } =
      await privateSynthesisFixture();
    try {
      const before = publicState();
      const observed: WorkersAIPromotionInput[] = [];
      const result = await publishSynthesisDraftForSponsor(
        f.db,
        PROBLEM,
        synthesisId,
        SPONSOR,
        draftScreening(f.db, SPONSOR, async (bound) => {
          observed.push(bound);
          const observation = await syntheticScreeningObservation(bound, {
            decision:
              decision === "reject" ? "reject" : decision === "quarantine" ? "quarantine" : "pass",
            coarse_category:
              decision === "reject" || decision === "quarantine" ? "harassment" : "benign-context",
            provider_status: decision === "provider-error" ? "error" : "ok",
          });
          return decision === "wrong-digest"
            ? { ...observation, evaluated_body_digest: `sha256:${"0".repeat(64)}` }
            : observation;
        }),
      );
      expect(result).toBeInstanceOf(Response);
      if (!(result instanceof Response)) throw new Error("Expected a screening refusal.");
      expect(result.status).toBe(decision === "reject" ? 403 : 202);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(observed).toHaveLength(1);
      const evaluated = observed[0];
      if (evaluated === undefined) throw new Error("No candidate reached screening.");
      expect(JSON.parse(evaluated.statement)).toEqual(candidate);
      expect(evaluated.publicationContext).toBeDefined();
      expect(publicState()).toEqual(before);
      const refusal = (await result.json()) as { case_id?: string };
      expect(refusal.case_id).toBeDefined();
      if (refusal.case_id === undefined) throw new Error("The refused draft needs a review case.");
      expect(
        f.sql.query("SELECT state FROM screening_cases WHERE case_id = ?").get(refusal.case_id),
      ).toEqual({ state: "pending" });
      expect(reservations()).toEqual([
        { status: decision === "reject" ? "settled_rejected" : "settled_held" },
      ]);
    } finally {
      f.sql.close();
    }
  });
}

test("a steward's held synthesis stays in the author's sponsor review queue", async () => {
  const { f, synthesisId, publicState } = await privateSynthesisFixture();
  try {
    const steward = "usr_draft_steward";
    f.sql
      .query("INSERT INTO sponsors(sponsor_id, created_at, last_seen_at) VALUES(?, ?, ?)")
      .run(steward, Date.now(), Date.now());
    f.sql
      .query(
        "INSERT INTO problem_stewards(problem_id, sponsor_id, is_founding, created_at) VALUES(?, ?, 0, ?)",
      )
      .run(PROBLEM, steward, NOW());
    const before = publicState();
    const held = await publishSynthesisDraftForSponsor(
      f.db,
      PROBLEM,
      synthesisId,
      steward,
      draftScreening(f.db, steward, (input) =>
        syntheticScreeningObservation(input, {
          decision: "quarantine",
          coarse_category: "harassment",
          provider_status: "ok",
        }),
      ),
    );
    expect(held).toBeInstanceOf(Response);
    if (!(held instanceof Response)) throw new Error("Expected a review hold.");
    expect(held.status).toBe(202);
    const body = (await held.json()) as { case_id?: string };
    if (body.case_id === undefined) throw new Error("The held draft needs a review case.");
    expect(
      f.sql
        .query("SELECT sponsor_id, fellow_id FROM screening_cases WHERE case_id = ?")
        .get(body.case_id),
    ).toEqual({ sponsor_id: SPONSOR, fellow_id: FELLOW });
    const ownerCases = await sponsorScreeningCases(f.db, SPONSOR, body.case_id);
    const stewardCases = await sponsorScreeningCases(f.db, steward, body.case_id);
    expect(ownerCases.cases.map((entry) => entry.case_id)).toEqual([body.case_id]);
    expect(stewardCases.cases).toEqual([]);
    expect(
      f.sql
        .query(
          "SELECT sponsor_id, status FROM public_write_attempt_reservations WHERE route = 'synthesis-draft-publish'",
        )
        .get(),
    ).toEqual({ sponsor_id: steward, status: "settled_held" });
    expect(publicState()).toEqual(before);
  } finally {
    f.sql.close();
  }
});

test("draft publication stores its contextual warning and replays without screening or quota", async () => {
  const { f, synthesisId, reservations } = await privateSynthesisFixture();
  try {
    let calls = 0;
    const screen = draftScreening(f.db, SPONSOR, async (bound) => {
      calls++;
      return syntheticScreeningObservation(bound, {
        decision: "allow-with-warning",
        coarse_category: "off-topic",
        provider_status: "ok",
      });
    });
    const result = expectPublishResult(
      await publishSynthesisDraftForSponsor(f.db, PROBLEM, synthesisId, SPONSOR, {
        ...screen,
        sponsorLimit: 1,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    const stored = f.sql
      .query("SELECT provenance_json FROM screening_publications WHERE event_id = ?")
      .get(result.body.event_id) as { provenance_json: string };
    const provenance = JSON.parse(stored.provenance_json);
    expect(provenance.scope).toBe("candidate-and-public-context");
    const notice = {
      category: "off-topic",
      action: "published-with-warning",
      notice: "off-scope",
    } as const;
    expect(provenance.public_action).toEqual(notice);
    const page = await readSynthesisPage(f.db, PROBLEM, {}, (value) =>
      SynthesisItemSchema.parse(value),
    );
    const item = page.items.find((entry) => entry.synthesis.synthesis_id === synthesisId);
    expect(item?.synthesis.screening_notice).toEqual(notice);
    expect(item?.synthesis.authoring_principal).toBe(FELLOW);
    expect(item?.synthesis.published_by_principal_id).toBe(SPONSOR);

    // No screener is supplied and the sponsor's only slot is occupied.
    // An exact committed receipt still replays for free.
    const replay = expectPublishResult(
      await publishSynthesisDraftForSponsor(f.db, PROBLEM, synthesisId, SPONSOR),
    );
    expect(replay).toEqual({ ...result, status: 200 });
    expect(calls).toBe(1);
    expect(reservations()).toEqual([{ status: "settled_published" }]);
  } finally {
    f.sql.close();
  }
});

test("draft publication fails closed without a screener or available sponsor quota", async () => {
  const { f, synthesisId, publicState, reservations } = await privateSynthesisFixture();
  try {
    const before = publicState();
    const unavailable = await publishSynthesisDraftForSponsor(f.db, PROBLEM, synthesisId, SPONSOR);
    expect(unavailable).toBeInstanceOf(Response);
    if (!(unavailable instanceof Response)) throw new Error("Expected unavailable screening.");
    expect(unavailable.status).toBe(503);
    expect(ProblemDocumentSchema.parse(await unavailable.json()).code).toBe(
      "SCREENING_CONTEXT_UNAVAILABLE",
    );
    let calls = 0;
    const exhausted = await publishSynthesisDraftForSponsor(f.db, PROBLEM, synthesisId, SPONSOR, {
      sponsorLimit: 0,
      screen: async () => {
        calls++;
        throw new Error("Quota must stop paid screening.");
      },
    });
    expect(exhausted).toBeInstanceOf(Response);
    if (!(exhausted instanceof Response)) throw new Error("Expected quota refusal.");
    expect(exhausted.status).toBe(429);
    expect(ProblemDocumentSchema.parse(await exhausted.json()).code).toBe("PROMOTION_RATE_LIMITED");
    expect(calls).toBe(0);
    expect(publicState()).toEqual(before);
    expect(reservations()).toEqual([]);
  } finally {
    f.sql.close();
  }
});

test("draft bytes changed after screening cannot enter the publication transaction", async () => {
  const { f, synthesisId, publicState, reservations } = await privateSynthesisFixture();
  try {
    const before = publicState();
    const pass = draftScreening(f.db);
    const result = await publishSynthesisDraftForSponsor(f.db, PROBLEM, synthesisId, SPONSOR, {
      ...pass,
      screen: async (candidate) => {
        const screened = await pass.screen(candidate);
        if (screened instanceof Response) return screened;
        f.sql
          .query("UPDATE synthesis_drafts SET body_md = ? WHERE synthesis_id = ?")
          .run("Changed unscreened draft bytes.", synthesisId);
        return screened;
      },
    });
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("Expected changed-draft refusal.");
    expect(result.status).toBe(409);
    expect(ProblemDocumentSchema.parse(await result.json()).code).toBe("OBJECT_VERSION_CONFLICT");
    expect(publicState()).toEqual(before);
    expect(reservations()).toEqual([{ status: "settled_failed" }]);
  } finally {
    f.sql.close();
  }
});

test("Fable §6.1: draft synthesis stays private until steward/sponsor publishes, preserves Fellow authorship, and keeps prior syntheses intact", async () => {
  const { f, claim } = await seedResolvedFixture({ famous: false });
  try {
    // Issue a live Fellow credential + session via EnrollmentService so we exercise the real HTTP route!
    const replayKeyB64Url = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
      "base64url",
    );
    const replayProtector = await enrollmentReplayProtectorFromBase64Url(replayKeyB64Url);
    const enrollmentService = new EnrollmentService({
      store: new D1EnrollmentStore(f.db),
      replayProtector,
      stoaOrigin: "https://a.asimposium.org",
      agoraOrigin: "https://asimposium.org",
    });
    const minted = await enrollmentService.mint(
      { type: "sponsor", sponsorId: SPONSOR },
      { requested_scopes: ["promote", "review"], problem_binding: PROBLEM },
    );
    const claimed = await enrollmentService.claim({
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "draft-author-fellow",
      model: "claude-opus-4-6",
      harness: "claude-code",
    });
    const flowHandle = claimed.flowHandle;
    await enrollmentService.decide({ type: "sponsor", sponsorId: SPONSOR }, minted.enrollmentId, {
      enrollment_id: minted.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1_000),
    });
    const polled = await enrollmentService.poll({ flow_handle: flowHandle });
    if (polled.status !== "approved") throw new Error(`unexpected poll status: ${polled.status}`);
    const fellowToken = polled.token;
    const binding = await enrollmentService.credentialBinding(fellowToken);
    if (!binding) throw new Error("missing fellow credential binding");
    const fellowId = binding.fellowId;

    // Seed an unrelated sponsor so we can prove 403 refusal.
    const OTHER_SPONSOR = "usr_unrelated_sponsor_nkz2";
    await enrollmentService.bootstrapSponsor({ type: "sponsor", sponsorId: OTHER_SPONSOR });

    // Build real createApp() with signed service envelope keyring!
    const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as CryptoKeyPair;
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
    const pubHex = toHex(rawPub);
    const env = {
      DB: f.db,
      STOA_ORIGIN: "https://a.asimposium.org",
      AGORA_ORIGIN: "https://asimposium.org",
      SERVICE_ENVELOPE_KEYS: JSON.stringify([
        { kid: "k-nkz2", publicKeyHex: pubHex, notBefore: 0 },
      ]),
      OPERATOR_PRINCIPAL_IDS: "usr_op_nkz2",
      ENROLLMENT_REPLAY_KEY: replayKeyB64Url,
    } as unknown as Env;

    let screeningCalls = 0;
    const app = createApp({
      screenPromotion: async (input) => {
        screeningCalls++;
        return syntheticScreeningObservation(input, {
          decision: "pass",
          coarse_category: "benign-context",
          provider_status: "ok",
        });
      },
    });
    const openRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fellowToken}`,
          "content-type": "application/json",
          "idempotency-key": "nkz2-open-session",
        },
        body: JSON.stringify({ problem_id: PROBLEM }),
      }),
      env,
    );
    expect(openRes.status).toBe(201);
    const opened = (await openRes.json()) as { session_id: string };

    const through = (
      f.sql.query("SELECT public_seq FROM problems WHERE id = ?").get(PROBLEM) as {
        public_seq: number;
      }
    ).public_seq;

    const draftBody = {
      covers_through: through,
      body_md: "## Draft Synthesis\n\nPrivate automated draft before steward review.",
      anchors: [{ target_kind: "claim", target_id: CLAIM, target_version: 1 }],
      omitted: ["Minor scratch notes"],
      selection_policy: "Include all corroborated claims.",
      draft: true,
    };

    const draftRes = await app.fetch(
      new Request(`https://a.asimposium.org/v1/sessions/${opened.session_id}/synthesize`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${fellowToken}`,
          "content-type": "application/json",
          "idempotency-key": "nkz2-draft-synth-1",
        },
        body: JSON.stringify(draftBody),
      }),
      env,
    );
    expect(draftRes.status).toBe(201);
    const draftJson = SynthesisDraftResponseSchema.parse(await draftRes.json());
    expect(draftJson.state).toBe("draft");
    expect(draftJson.anchors_count).toBe(1);

    // Idempotent replay of the exact draft request returns 200 with identical synthesis_id.
    const replayRes = await app.fetch(
      new Request(`https://a.asimposium.org/v1/sessions/${opened.session_id}/synthesize`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${fellowToken}`,
          "content-type": "application/json",
          "idempotency-key": "nkz2-draft-synth-1",
        },
        body: JSON.stringify(draftBody),
      }),
      env,
    );
    expect(replayRes.status).toBe(200);
    expect(SynthesisDraftResponseSchema.parse(await replayRes.json())).toEqual(draftJson);

    // Draft MUST NOT appear in public `events` or anonymous `/p/:id/syntheses.json`!
    const eventRow = f.sql
      .query("SELECT id FROM events WHERE object_id = ?")
      .get(draftJson.synthesis_id);
    expect(eventRow).toBeNull();
    const anonBefore = await app.fetch(
      new Request(`https://a.asimposium.org/p/${PROBLEM}/syntheses.json`),
      env,
    );
    expect(anonBefore.status).toBe(200);
    const anonBeforeJson = (await anonBefore.json()) as {
      syntheses: Array<{ synthesis_id: string }>;
    };
    expect(anonBeforeJson.syntheses.some((s) => s.synthesis_id === draftJson.synthesis_id)).toBe(
      false,
    );

    const signedSponsorReq = async (
      method: "GET" | "POST",
      path: string,
      action: string,
      sponsorId: string,
      body = "",
    ) => {
      const envelope = await mintServiceEnvelope({
        kid: "k-nkz2",
        privateKey: keyPair.privateKey,
        issuer: "agora",
        audience: "stoa",
        principalType: "sponsor",
        principalId: sponsorId,
        method,
        route: path,
        action,
        body,
        now: Math.floor(Date.now() / 1_000),
      });
      return app.fetch(
        new Request(`https://a.asimposium.org${path}`, {
          method,
          headers: {
            ...serviceEnvelopeHeaders(envelope),
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body } : {}),
        }),
        env,
      );
    };

    // Unrelated sponsor sees 0 drafts and gets 403 GOVERNANCE_NOT_AUTHORIZED on publish!
    const otherList = await signedSponsorReq(
      "GET",
      `/v1/sponsors/problems/${PROBLEM}/syntheses/drafts`,
      "sponsor.syntheses.drafts.list",
      OTHER_SPONSOR,
    );
    expect(otherList.status).toBe(200);
    expect(SynthesisDraftListResponseSchema.parse(await otherList.json()).drafts).toHaveLength(0);

    const otherPub = await signedSponsorReq(
      "POST",
      `/v1/sponsors/problems/${PROBLEM}/syntheses/${draftJson.synthesis_id}/publish`,
      "sponsor.syntheses.drafts.publish",
      OTHER_SPONSOR,
    );
    expect(otherPub.status).toBe(403);
    const otherErr = ProblemDocumentSchema.parse(await otherPub.json());
    expect(otherErr.code).toBe("WRITE_REFUSED");

    // Steward / authoring sponsor lists the draft and publishes it!
    const stewardList = await signedSponsorReq(
      "GET",
      `/v1/sponsors/problems/${PROBLEM}/syntheses/drafts`,
      "sponsor.syntheses.drafts.list",
      SPONSOR,
    );
    expect(stewardList.status).toBe(200);
    const parsedList = SynthesisDraftListResponseSchema.parse(await stewardList.json());
    expect(parsedList.drafts).toHaveLength(1);
    expect(parsedList.drafts[0]?.synthesis_id).toBe(draftJson.synthesis_id);
    expect(parsedList.drafts[0]?.state).toBe("draft");

    // Multiple pages, including identical timestamps and an admitted draft
    // larger than the old 256 KiB transport ceiling. No row may be clipped.
    const path = `/v1/sponsors/problems/${PROBLEM}/syntheses/drafts`;
    const draftPage = (body: unknown, principal = SPONSOR) =>
      signedSponsorReq(
        "POST",
        path,
        "sponsor.syntheses.drafts.list",
        principal,
        JSON.stringify(body),
      );
    const copy = f.sql.query(`INSERT INTO synthesis_drafts
      (synthesis_id, problem_id, covers_through, body_md, anchors_json, omitted_json, selection_policy,
       closing_resolution_json, dropped_single_author_count, author_fellow_id, author_sponsor_id,
       session_id, declared_model, harness, state, created_at)
      SELECT ?, problem_id, covers_through, ?, anchors_json, ?, selection_policy,
       closing_resolution_json, dropped_single_author_count, author_fellow_id, author_sponsor_id,
       session_id, declared_model, harness, state, created_at FROM synthesis_drafts WHERE synthesis_id = ?`);
    const expected = new Set([draftJson.synthesis_id]);
    for (let n = 1; n <= 51; n++) {
      const id = `SYNTH-${String(n).padStart(26, "0")}`;
      expected.add(id);
      copy.run(
        id,
        n === 51 ? "∑".repeat(60_000) : "Bounded result.",
        n === 51 ? JSON.stringify(Array(20).fill("∑".repeat(1900))) : "[]",
        draftJson.synthesis_id,
      );
    }
    let after: { created_at: string; synthesis_id: string } | undefined;
    const seen: string[] = [];
    do {
      const res = await draftPage(after ? { after } : {});
      expect(res.status).toBe(200);
      const bytes = await res.arrayBuffer();
      expect(bytes.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
      const current = SynthesisDraftListResponseSchema.parse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      if (bytes.byteLength > 256 * 1024) expect(current.drafts).toHaveLength(1);
      for (const row of current.drafts) {
        if (row.synthesis_id === `SYNTH-${"51".padStart(26, "0")}`)
          expect(row.body_md.length).toBe(60_000);
        seen.push(row.synthesis_id);
      }
      if (current.next_after) {
        const last = current.drafts.at(-1);
        if (last === undefined) throw new Error("A draft continuation requires a final row.");
        expect(current.next_after).toEqual({
          created_at: last.created_at,
          synthesis_id: last.synthesis_id,
        });
      }
      after = current.next_after;
      expect(seen.length).toBeLessThanOrEqual(expected.size);
    } while (after);
    expect(seen).toEqual([...expected].sort().reverse());
    const unrelated = await draftPage(
      {
        after: {
          created_at: parsedList.drafts[0]?.created_at,
          synthesis_id: draftJson.synthesis_id,
        },
      },
      OTHER_SPONSOR,
    );
    expect(SynthesisDraftListResponseSchema.parse(await unrelated.json()).drafts).toEqual([]);
    expect((await draftPage({ after: { synthesis_id: draftJson.synthesis_id } })).status).toBe(422);

    const cursorBeforePub = (
      f.sql.query("SELECT cursor FROM public_cursor WHERE singleton = 1").get() as {
        cursor: number;
      }
    ).cursor;

    const screeningsBeforePublication = screeningCalls;
    const pubRes = await signedSponsorReq(
      "POST",
      `/v1/sponsors/problems/${PROBLEM}/syntheses/${draftJson.synthesis_id}/publish`,
      "sponsor.syntheses.drafts.publish",
      SPONSOR,
    );
    expect(pubRes.status).toBe(201);
    expect(screeningCalls).toBe(screeningsBeforePublication + 1);
    const published = SynthesisDraftPublishResponseSchema.parse(await pubRes.json());
    expect(published.synthesis_id).toBe(draftJson.synthesis_id);
    expect(published.author_fellow_id).toBe(fellowId);
    expect(published.published_by_principal_id).toBe(SPONSOR);

    // Wave 12 regression: publishing a draft synthesis MUST increment public_cursor exactly once.
    const cursorAfterPub = (
      f.sql.query("SELECT cursor FROM public_cursor WHERE singleton = 1").get() as {
        cursor: number;
      }
    ).cursor;
    expect(cursorAfterPub).toBe(cursorBeforePub + 1);

    // Second publish call is idempotent (returns 200, no duplicate ledger event or cursor bump).
    const pubAgain = await signedSponsorReq(
      "POST",
      `/v1/sponsors/problems/${PROBLEM}/syntheses/${draftJson.synthesis_id}/publish`,
      "sponsor.syntheses.drafts.publish",
      SPONSOR,
    );
    expect(pubAgain.status).toBe(200);
    expect(screeningCalls).toBe(screeningsBeforePublication + 1);
    expect(SynthesisDraftPublishResponseSchema.parse(await pubAgain.json())).toEqual(published);
    const cursorAfterReplay = (
      f.sql.query("SELECT cursor FROM public_cursor WHERE singleton = 1").get() as {
        cursor: number;
      }
    ).cursor;
    expect(cursorAfterReplay).toBe(cursorAfterPub);

    // Public reader now serves BOTH the prior closing synthesis AND the newly published synthesis
    // with Fellow scientific authorship + published_by_principal_id preserved!
    const page = await readSynthesisPage(f.db, PROBLEM, {}, (v) => SynthesisItemSchema.parse(v));
    expect(page.found).toBe(true);
    const ids = page.items.map((item) => item.synthesis.synthesis_id);
    expect(ids).toContain("SYNTH-CLOSING");
    expect(ids).toContain(draftJson.synthesis_id);
    const pubItem = page.items.find((i) => i.synthesis.synthesis_id === draftJson.synthesis_id);
    expect(pubItem?.synthesis.authoring_principal).toBe(fellowId);
    expect(pubItem?.synthesis.published_by_principal_id).toBe(SPONSOR);
    expect(claim.seq).toBeGreaterThan(0);
  } finally {
    f.sql.close();
  }
});

test("Fable §6.2 & 2026-11-02: famous-problem resolve requires verified operator ExternalExpertReviewRecord and refuses bare prose/withheld/mismatched/revoked", async () => {
  const { f, apply, problemRow } = await seedResolvedFixture({ famous: true });
  try {
    const baseResolve: Extract<ProblemLifecycleActionRequest, { action: "resolve" }> = {
      action: "resolve",
      direction: "affirmed",
      closing_synthesis: {
        synthesis_id: "SYNTH-CLOSING",
        summary: SUMMARY,
        no_claim_boundary: BOUNDARY,
      },
    };

    // 1. Missing external_expert_review_proof -> 422 PREMATURE_RESOLUTION
    const missingProof = await apply(baseResolve, "famous-missing-proof");
    expect(missingProof.status).toBe(422);
    expect(((await missingProof.json()) as { code: string }).code).toBe("PREMATURE_RESOLUTION");

    // 2. Bare caller-supplied prose -> 422 PREMATURE_RESOLUTION (still refused!)
    const bareProse = await apply(
      { ...baseResolve, external_expert_review_proof: "Reviewed and approved by Prof. X in email" },
      "famous-bare-prose",
    );
    expect(bareProse.status).toBe(422);
    expect(((await bareProse.json()) as { code: string }).code).toBe("PREMATURE_RESOLUTION");

    // Mount operator HTTP router to record ExternalExpertReviewRecords.
    const router = createSynthesisDraftsAndExternalReviewsApp({
      db: f.db,
      verifiedSponsor: async (req) => ({
        principal: { type: "sponsor", sponsorId: SPONSOR },
        rawBody: new Uint8Array(await req.arrayBuffer()),
      }),
      verifiedOperator: async (req) => ({
        principal: { type: "operator", operatorId: "usr_op_famous", serviceEnvelopeKid: "k1" },
        rawBody: new Uint8Array(await req.arrayBuffer()),
      }),
    });

    const postReview = async (payload: Record<string, unknown>) => {
      const res = await router.request(
        `https://a.asimposium.org/v1/operators/problems/${PROBLEM}/external-expert-reviews`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      expect(res.status).toBe(201);
      return ExternalExpertReviewRecordSchema.parse(await res.json());
    };

    // 3. Operator records verdict='withheld' -> 422 PREMATURE_RESOLUTION
    const withheld = await postReview({
      claim_id: CLAIM,
      claim_version: 1,
      reviewer: {
        name: "Dr. Ada Referee",
        affiliation: "Institute for Formal Foundations",
        identifier: "https://orcid.org/0000-0002-1825-0097",
      },
      attestation_locator: "https://doi.org/10.1000/withheld-referee-report",
      attestation_sha256: "a".repeat(64),
      verdict: "withheld",
      reviewed_at: "2026-11-21T12:00:00.000Z",
      no_claim_boundary: BOUNDARY,
    });
    const withheldRes = await apply(
      { ...baseResolve, external_expert_review_proof: withheld.review_record_id },
      "famous-withheld",
    );
    expect(withheldRes.status).toBe(422);
    expect(((await withheldRes.json()) as { code: string }).code).toBe("PREMATURE_RESOLUTION");

    // 4. Operator records supports-resolution with mismatched no_claim_boundary -> 422 PREMATURE_RESOLUTION
    const wrongBoundary = await postReview({
      claim_id: CLAIM,
      claim_version: 1,
      reviewer: {
        name: "Dr. Ada Referee",
        affiliation: "Institute for Formal Foundations",
        identifier: "https://orcid.org/0000-0002-1825-0097",
      },
      attestation_locator: "https://doi.org/10.1000/wrong-boundary-report",
      attestation_sha256: "b".repeat(64),
      verdict: "supports-resolution",
      reviewed_at: "2026-11-21T12:05:00.000Z",
      no_claim_boundary: {
        ...BOUNDARY,
        remaining_external_validation: ["Different scope claim!"],
      },
    });
    const wrongBoundaryRes = await apply(
      { ...baseResolve, external_expert_review_proof: wrongBoundary.review_record_id },
      "famous-wrong-boundary",
    );
    expect(wrongBoundaryRes.status).toBe(422);

    // 5. Operator records matching supports-resolution, then revokes it -> 422 PREMATURE_RESOLUTION
    const revokedRec = await postReview({
      claim_id: CLAIM,
      claim_version: 1,
      reviewer: {
        name: "Dr. Ada Referee",
        affiliation: "Institute for Formal Foundations",
        identifier: "https://orcid.org/0000-0002-1825-0097",
      },
      attestation_locator: "https://doi.org/10.1000/revoked-report",
      attestation_sha256: "c".repeat(64),
      verdict: "supports-resolution",
      reviewed_at: "2026-11-21T12:10:00.000Z",
      no_claim_boundary: BOUNDARY,
    });
    f.sql
      .query("UPDATE external_expert_reviews SET revoked_at = ? WHERE review_record_id = ?")
      .run("2026-11-21T12:12:00.000Z", revokedRec.review_record_id);
    const revokedRes = await apply(
      { ...baseResolve, external_expert_review_proof: revokedRec.review_record_id },
      "famous-revoked",
    );
    expect(revokedRes.status).toBe(422);

    // 6. Operator records matching unrevoked supports-resolution -> GET lists it, resolve succeeds (200)!
    const validRec = await postReview({
      claim_id: CLAIM,
      claim_version: 1,
      reviewer: {
        name: "Dr. Ada Referee",
        affiliation: "Institute for Formal Foundations",
        identifier: "https://orcid.org/0000-0002-1825-0097",
      },
      attestation_locator: "https://doi.org/10.1000/verified-referee-report",
      attestation_sha256: "d".repeat(64),
      verdict: "supports-resolution",
      reviewed_at: "2026-11-21T12:15:00.000Z",
      no_claim_boundary: BOUNDARY,
    });
    const listRes = await router.request(
      `https://a.asimposium.org/v1/operators/problems/${PROBLEM}/external-expert-reviews`,
      { method: "GET" },
    );
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { reviews: Array<{ review_record_id: string }> };
    expect(listed.reviews.some((r) => r.review_record_id === validRec.review_record_id)).toBe(true);

    const okRes = await apply(
      { ...baseResolve, external_expert_review_proof: validRec.review_record_id },
      "famous-admitted",
    );
    expect(okRes.status).toBe(200);
    expect(problemRow().status).toBe("resolved");
  } finally {
    f.sql.close();
  }
});

test("non-famous problem still refuses unexpected external_expert_review_proof", async () => {
  const { f, apply } = await seedResolvedFixture({ famous: false });
  try {
    const res = await apply(
      {
        action: "resolve",
        direction: "affirmed",
        closing_synthesis: {
          synthesis_id: "SYNTH-CLOSING",
          summary: SUMMARY,
          no_claim_boundary: BOUNDARY,
        },
        external_expert_review_proof: `EER-${"0".repeat(26)}`,
      },
      "non-famous-extra-proof",
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("PREMATURE_RESOLUTION");
  } finally {
    f.sql.close();
  }
});

test("suspended stewards are refused and concurrent draft publishers share one paid attempt and receipt", async () => {
  const { f, problemRow } = await seedResolvedFixture({ famous: false });
  try {
    const publish = async (
      db: Env["DB"],
      problemId: string,
      synthesisId: string,
      sponsorId: string,
    ) =>
      expectPublishResult(
        await publishSynthesisDraftForSponsor(
          db,
          problemId,
          synthesisId,
          sponsorId,
          draftScreening(db, sponsorId),
        ),
      );
    // Add a second active steward and a suspended steward (using exact sponsors + sponsor_suspension_events schema).
    const nowMs = Date.now() + 5_000;
    const stepUpSec = Math.floor(nowMs / 1000);
    f.sql
      .query(
        `INSERT INTO sponsors (sponsor_id, created_at, last_seen_at)
         VALUES ('usr_costeward', ?, ?), ('usr_suspended', ?, ?)`,
      )
      .run(nowMs, nowMs, nowMs, nowMs);
    f.sql
      .query(
        `INSERT INTO problem_stewards (problem_id, sponsor_id, is_founding, created_at)
         VALUES (?, 'usr_costeward', 0, '2026-09-01T00:00:00.000Z'),
                (?, 'usr_suspended', 0, '2026-09-01T00:00:00.000Z')`,
      )
      .run(PROBLEM, PROBLEM);
    const { recordRejectedScreeningCase } = await import("../../src/moderation/store.ts");
    const recordedCase = await recordRejectedScreeningCase(f.db, {
      problemId: PROBLEM,
      fellowId: FELLOW,
      sponsorId: "usr_suspended",
      route: "/v1/sessions/S/promote",
      inputDigest: "a".repeat(64),
      contextDigest: "b".repeat(64),
      candidate: { kind: "conjecture", statement: "test", falsifier: "test" },
      coarseCategory: "abuse",
      outcome: "quarantine",
      decisionPath: "deterministic",
      providerStatus: "ok",
      modelVersion: "v1",
      policyVersion: "v1",
      configurationDigest: "c".repeat(64),
    });
    f.sql
      .query(
        `INSERT INTO sponsor_suspension_events
           (event_id, sponsor_id, operator_id, reviewed_case_id, basis, reason, created_at,
            step_up_authenticated_at, idempotency_key_hash, request_digest,
            paused_fellows, revoked_credentials, cancelled_enrollments, cancelled_transfers)
         VALUES ('SS-00000000000000000000000001', 'usr_suspended', 'op_test',
                 ?, 'egregious-reviewed-case',
                 'Reviewed safety suspension for test.', ?, ?, ?, ?, 0, 0, 0, 0)`,
      )
      .run(recordedCase.caseId, nowMs, stepUpSec, "e".repeat(64), "f".repeat(64));

    const synthId = `SYNTH-${"A".repeat(26)}`;
    f.sql
      .query(
        `INSERT INTO synthesis_drafts
           (synthesis_id, problem_id, covers_through, body_md, anchors_json, omitted_json,
            selection_policy, closing_resolution_json, dropped_single_author_count,
            author_fellow_id, author_sponsor_id, session_id, declared_model, harness,
            state, created_at)
         VALUES (?, ?, ?, 'Draft body for concurrency test', ?, '[]', 'all-surviving', NULL, 0,
                 ?, ?, ?, 'test-model', 'codex', 'draft', '2026-09-02T00:00:00.000Z')`,
      )
      .run(
        synthId,
        PROBLEM,
        problemRow().public_seq,
        JSON.stringify([{ target_kind: "claim", target_id: CLAIM, target_version: 1 }]),
        FELLOW,
        SPONSOR,
        "S-CONCUR-1",
      );

    // 1. Suspended steward must be refused 403 WRITE_REFUSED.
    const suspendedRes = await publish(f.db, PROBLEM, synthId, "usr_suspended");
    expect(suspendedRes.ok).toBe(false);
    if (!suspendedRes.ok) {
      expect(suspendedRes.status).toBe(403);
      expect(suspendedRes.code).toBe("WRITE_REFUSED");
    }

    // 2. Hold the first provider call open. A second publisher must wait for
    // that single paid attempt, then replay its exact committed receipt.
    let markScreenStarted: (() => void) | undefined;
    const screenStarted = new Promise<void>((resolve) => {
      markScreenStarted = resolve;
    });
    let finishScreen: (() => void) | undefined;
    const screenBarrier = new Promise<void>((resolve) => {
      finishScreen = resolve;
    });
    let concurrentScreeningCalls = 0;
    const first = publishSynthesisDraftForSponsor(
      f.db,
      PROBLEM,
      synthId,
      SPONSOR,
      draftScreening(f.db, SPONSOR, async (input) => {
        concurrentScreeningCalls++;
        markScreenStarted?.();
        await screenBarrier;
        return syntheticScreeningObservation(input, {
          decision: "pass",
          coarse_category: "benign-context",
          provider_status: "ok",
        });
      }),
    );
    await Promise.race([
      screenStarted,
      first.then(() => {
        throw new Error("The first publisher did not reach screening.");
      }),
    ]);
    try {
      const pending = await publishSynthesisDraftForSponsor(
        f.db,
        PROBLEM,
        synthId,
        "usr_costeward",
        draftScreening(f.db, "usr_costeward", async () => {
          concurrentScreeningCalls++;
          throw new Error("An in-flight retry must not buy another screen.");
        }),
      );
      expect(pending).toBeInstanceOf(Response);
      if (!(pending instanceof Response)) throw new Error("Expected in-flight refusal.");
      expect(pending.status).toBe(429);
      expect(pending.headers.get("retry-after")).toBe("1");
    } finally {
      finishScreen?.();
      await first;
    }
    const r1 = expectPublishResult(await first);
    const r2 = await publish(f.db, PROBLEM, synthId, "usr_costeward");
    expect(concurrentScreeningCalls).toBe(1);
    expect(
      f.sql
        .query(
          "SELECT COUNT(*) AS n FROM public_write_attempt_reservations WHERE route = 'synthesis-draft-publish'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect([r1.status, r2.status].sort()).toEqual([200, 201]);
      expect(r1.body.event_id).toBe(r2.body.event_id);
      expect(r1.body.sequence).toBe(r2.body.sequence);
      expect(r1.body.published_by_principal_id).toBe(r2.body.published_by_principal_id);
      expect(r1.body.author_fellow_id).toBe(FELLOW);
    }

    // 3. Wave 12 P7 regression: credential-shaped draft text is refused 422 SECRET_SHAPED_CONTENT
    //    and writes zero ledger events.
    const secretSynthId = `SYNTH-${"S".repeat(26)}`;
    f.sql
      .query(
        `INSERT INTO synthesis_drafts
           (synthesis_id, problem_id, covers_through, body_md, anchors_json, omitted_json,
            selection_policy, closing_resolution_json, dropped_single_author_count,
            author_fellow_id, author_sponsor_id, session_id, declared_model, harness,
            state, created_at)
         VALUES (?, ?, ?, 'Leaked token asimp_ag_SecretToken1234567890abcdef inside draft', ?, '[]', 'all-surviving', NULL, 0,
                 ?, ?, ?, 'test-model', 'codex', 'draft', '2026-09-02T00:00:01.000Z')`,
      )
      .run(
        secretSynthId,
        PROBLEM,
        problemRow().public_seq,
        JSON.stringify([{ target_kind: "claim", target_id: CLAIM, target_version: 1 }]),
        FELLOW,
        SPONSOR,
        "S-CONCUR-2",
      );
    const secretRes = await publish(f.db, PROBLEM, secretSynthId, SPONSOR);
    expect(secretRes.ok).toBe(false);
    if (!secretRes.ok) {
      expect(secretRes.status).toBe(422);
      expect(secretRes.code).toBe("SECRET_SHAPED_CONTENT");
    }
    expect(f.sql.query("SELECT id FROM events WHERE object_id = ?").get(secretSynthId)).toBeNull();

    // 4. Wave 13 fresh-eyes regressions:
    //    (a) Tombstoned sponsor attempting publish gets 403 WRITE_REFUSED (never 500 crash).
    f.sql
      .query(
        `INSERT INTO sponsors (sponsor_id, created_at, last_seen_at, tombstoned_at)
         VALUES ('usr_tombstoned', 1700000000000, 1700000000000, 1700000001000)`,
      )
      .run();
    const tombRes = await publish(f.db, PROBLEM, secretSynthId, "usr_tombstoned");
    expect(tombRes.ok).toBe(false);
    if (!tombRes.ok) {
      expect(tombRes.status).toBe(403);
      expect(tombRes.code).toBe("WRITE_REFUSED");
    }

    //    (b) Credential embedded inside closing_resolution.no_claim_boundary is caught by P7.
    const closingSecretId = `SYNTH-${"C".repeat(26)}`;
    f.sql
      .query(
        `INSERT INTO synthesis_drafts
           (synthesis_id, problem_id, covers_through, body_md, anchors_json, omitted_json,
            selection_policy, closing_resolution_json, dropped_single_author_count,
            author_fellow_id, author_sponsor_id, session_id, declared_model, harness,
            state, created_at)
         VALUES (?, ?, ?, 'Clean body text with no credentials.', ?, '[]', 'all-surviving', ?, 0,
                 ?, ?, ?, 'test-model', 'codex', 'draft', '2026-09-02T00:00:02.000Z')`,
      )
      .run(
        closingSecretId,
        PROBLEM,
        problemRow().public_seq,
        JSON.stringify([{ target_kind: "claim", target_id: CLAIM, target_version: 1 }]),
        JSON.stringify({
          result_claim: { claim_id: CLAIM, version: 1 },
          direction: "affirmed",
          no_claim_boundary: {
            verified: ["Contains leaked token asimp_ag_BoundarySecret1234567890abcd"],
            mechanisms: ["finite check"],
            independence_tiers: ["T2"],
            remaining_external_validation: ["none"],
          },
        }),
        FELLOW,
        SPONSOR,
        "S-CONCUR-3",
      );
    const closingSecretRes = await publish(f.db, PROBLEM, closingSecretId, SPONSOR);
    expect(closingSecretRes.ok).toBe(false);
    if (!closingSecretRes.ok) {
      expect(closingSecretRes.status).toBe(422);
      expect(closingSecretRes.code).toBe("SECRET_SHAPED_CONTENT");
    }
    expect(
      f.sql.query("SELECT id FROM events WHERE object_id = ?").get(closingSecretId),
    ).toBeNull();

    //    (c) External expert review hardening: refuses P7 credentials, refuses private-draft,
    //        and atomically records an immutable operator_audit entry on valid creation.
    const { recordExternalExpertReview } = await import(
      "../../src/problems/external-expert-reviews.ts"
    );
    const baseReviewPayload = {
      claim_id: CLAIM,
      claim_version: 1,
      reviewer: {
        name: "Prof. Ada Lovelace",
        affiliation: "Institute for Formal Foundations",
        identifier: "https://orcid.org/0000-0002-1825-0097",
      },
      attestation_locator: "https://doi.org/10.1000/external-review-audit-01",
      attestation_sha256: "d".repeat(64),
      verdict: "supports-resolution" as const,
      reviewed_at: "2026-09-03T00:00:00.000Z",
      no_claim_boundary: BOUNDARY,
    };

    const secretReview = await recordExternalExpertReview(f.db, PROBLEM, "op_audit_1", {
      ...baseReviewPayload,
      reviewer: {
        ...baseReviewPayload.reviewer,
        affiliation: "Lab with leaked key asimp_ag_ReviewSecret1234567890abcdef",
      },
    });
    expect(secretReview.ok).toBe(false);
    if (!secretReview.ok) {
      expect(secretReview.status).toBe(422);
      expect(secretReview.code).toBe("SECRET_SHAPED_CONTENT");
    }

    const validReview = await recordExternalExpertReview(
      f.db,
      PROBLEM,
      "op_audit_1",
      baseReviewPayload,
    );
    expect(validReview.ok).toBe(true);
    if (validReview.ok) {
      const auditRow = f.sql
        .query(
          "SELECT event_id, operator_id, action, target_id, after_state_digest FROM operator_audit WHERE event_id = ?",
        )
        .get(`OA-${validReview.record.review_record_id.slice(4)}`) as {
        event_id: string;
        operator_id: string;
        action: string;
        target_id: string;
        after_state_digest: string;
      } | null;
      expect(auditRow).not.toBeNull();
      expect(auditRow?.operator_id).toBe("op_audit_1");
      expect(auditRow?.action).toBe("external-expert-review-recorded");
      expect(auditRow?.target_id).toBe(`${PROBLEM}/${CLAIM}@1`);
      expect(auditRow?.after_state_digest).toMatch(/^[0-9a-f]{64}$/);
    }

    //    (d) Wave 15 regression: concurrent problem lock right before D1 batch commit
    //        MUST NOT corrupt synthesis_drafts.state='published' or return phantom 200 OK!
    const raceDraftId = `SYNTH-${"D".repeat(26)}`;
    f.sql
      .query(
        `INSERT INTO synthesis_drafts
           (synthesis_id, problem_id, covers_through, body_md, anchors_json, omitted_json,
            selection_policy, closing_resolution_json, dropped_single_author_count,
            author_fellow_id, author_sponsor_id, session_id, declared_model, harness,
            state, created_at)
         VALUES (?, ?, ?, 'Draft racing against concurrent problem lock.', ?, '[]', 'all-surviving', NULL, 0,
                 ?, ?, ?, 'test-model', 'codex', 'draft', '2026-09-02T00:00:03.000Z')`,
      )
      .run(
        raceDraftId,
        PROBLEM,
        problemRow().public_seq,
        JSON.stringify([{ target_kind: "claim", target_id: CLAIM, target_version: 1 }]),
        FELLOW,
        SPONSOR,
        "S-CONCUR-4",
      );
    let injectedLock = false;
    const racingDb = new Proxy(f.db, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (stmts: Parameters<typeof target.batch>[0]) => {
            const writesEvent = stmts.some((statement) => {
              const text = (statement as unknown as { text: string }).text;
              return /INSERT(?: OR IGNORE)? INTO events\b/.test(text);
            });
            if (!injectedLock && writesEvent) {
              injectedLock = true;
              f.sql.query("UPDATE problems SET status = 'retired' WHERE id = ?").run(PROBLEM);
            }
            return target.batch(stmts);
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      },
    });
    const racedPublish = await publish(racingDb, PROBLEM, raceDraftId, SPONSOR);
    expect(injectedLock).toBe(true);
    expect(racedPublish.ok).toBe(false);
    if (!racedPublish.ok) {
      expect(racedPublish.status).toBe(422);
      expect(racedPublish.code).toBe("CLAIMS_BOARD_LOCKED");
    }
    const postRaceDraft = f.sql
      .query(
        "SELECT state, published_event_id FROM synthesis_drafts WHERE problem_id = ? AND synthesis_id = ?",
      )
      .get(PROBLEM, raceDraftId) as { state: string; published_event_id: string | null } | null;
    expect(postRaceDraft).toEqual({ state: "draft", published_event_id: null });
    expect(f.sql.query("SELECT id FROM events WHERE object_id = ?").get(raceDraftId)).toBeNull();
    expect(
      f.sql.query("SELECT synthesis_id FROM syntheses WHERE synthesis_id = ?").get(raceDraftId),
    ).toBeNull();
    // Restore problem status to active so subtest (e) exercises external-expert-review race cleanly.
    f.sql.query("UPDATE problems SET status = 'active' WHERE id = ?").run(PROBLEM);

    //    (e) Wave 15 regression: concurrent claim retraction right before external-expert-review
    //        batch commit writes ZERO external_expert_reviews and ZERO operator_audit rows!
    const beforeAuditCount = (
      f.sql.query("SELECT COUNT(*) AS n FROM operator_audit").get() as { n: number }
    ).n;
    let injectedRetraction = false;
    const retractRacingDb = new Proxy(f.db, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (stmts: Parameters<typeof target.batch>[0]) => {
            if (!injectedRetraction) {
              injectedRetraction = true;
              f.sql
                .query(
                  `INSERT INTO retractions
                     (retraction_id, problem_id, target_object, reason, author_fellow_id, created_at)
                   VALUES ('RET-RACE-W15', ?, ?, 'concurrent retraction test', ?, '2026-09-03T01:05:00.000Z')`,
                )
                .run(PROBLEM, `${CLAIM}@1`, FELLOW);
            }
            return target.batch(stmts);
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      },
    });
    const racedReview = await recordExternalExpertReview(
      retractRacingDb,
      PROBLEM,
      "op_audit_race",
      baseReviewPayload,
    );
    expect(injectedRetraction).toBe(true);
    expect(racedReview.ok).toBe(false);
    if (!racedReview.ok) {
      expect(racedReview.status).toBe(404);
      expect(racedReview.code).toBe("CLAIM_NOT_FOUND");
    }
    const afterAuditCount = (
      f.sql.query("SELECT COUNT(*) AS n FROM operator_audit").get() as { n: number }
    ).n;
    expect(afterAuditCount).toBe(beforeAuditCount);

    //    (f) Wave 16 regression: an already-recorded unrevoked ExternalExpertReviewRecord
    //        MUST fail verification once its anchored claim_version is retracted!
    if (validReview.ok) {
      const { findVerifiedExternalExpertReview } = await import(
        "../../src/problems/external-expert-reviews.ts"
      );
      const afterRetractVerify = await findVerifiedExternalExpertReview(f.db, {
        reviewRecordId: validReview.record.review_record_id,
        problemId: PROBLEM,
        claimId: CLAIM,
        claimVersion: 1,
        claimContentDigest: validReview.record.claim_content_digest,
        noClaimBoundary: BOUNDARY,
      });
      expect(afterRetractVerify).toBeNull();
    }
  } finally {
    f.sql.close();
  }
});
