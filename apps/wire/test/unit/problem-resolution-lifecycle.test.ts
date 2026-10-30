import { expect, test } from "bun:test";
import {
  type ClaimDependencyPin,
  ProblemGovernanceEventSchema,
  type ProblemLifecycleActionRequest,
} from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  canonicalJson,
  type KraterLedgerProjectionPlan,
  sha256Hex,
  writeLedgerEvent,
} from "../../src/krater/krater.ts";
import { readPublishedProblemResolution } from "../../src/ledger/problem-resolution-read.ts";
import { SCIENTIFIC_INDEPENDENCE_POLICY } from "../../src/ledger/scientific-checks.ts";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger.ts";
import {
  FELLOW,
  NOW,
  PROBLEM,
  publicationContextFixture,
  SPONSOR,
} from "../support/publication-context.ts";

type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
type Problem = Parameters<typeof applyPublicProblemGovernance>[1];
type Source = { eventId: string; seq: number; hash: string; body: string };
const CLAIM = "C-1";
const SUMMARY = "Two equals two within the exact declared finite scope.";
const BOUNDARY = {
  verified: ["The exact equality two equals two."],
  mechanisms: ["An attempted falsifier and two independent full write-up verifications."],
  independence_tiers: ["T2"],
  remaining_external_validation: ["No claim beyond the finite proposition was checked."],
};
const TITLE = "A finite equality question";
const snapshot = (f: Fixture) =>
  f.sql.query("SELECT * FROM problems WHERE id = ?").get(PROBLEM) as Problem;
const request = (key: string) =>
  new Request(`https://a.asimposium.org/v1/sponsors/problems/${PROBLEM}/lifecycle`, {
    method: "POST",
    headers: { "idempotency-key": key },
  });

/** The complete production migrations and actual Krater/lifecycle writer run
 * in native SQLite. This does not claim Workerd, HTTP authentication, or real
 * external binding coverage. Scientific fixture publications are deliberately
 * seeded below the route layer, with real retained bytes and chain digests. */
async function fixture() {
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
  ): Promise<Source> => {
    const eventId = `EV-RESOLUTION-${++serial}`;
    const body = canonicalJson(payload);
    const result = await writeLedgerEvent(
      f.db,
      {
        problemId: PROBLEM,
        eventId,
        idempotencyKey: `seed-${eventId}`,
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
    .query("UPDATE problems SET title = ?, created_by_fellow_id = ? WHERE id = ?")
    .run(TITLE, FELLOW, PROBLEM);
  const formulation = {
    id: PROBLEM,
    title: TITLE,
    current_statement_version: 1,
    statement: "Exact public problem statement.",
    falsifier: "Exact public falsifier.",
    motivation: "Exact public motivation.",
    updated_at: NOW(),
  };
  const admitted = await source(
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
        .prepare(`INSERT INTO claims
      (id,problem_id,statement,payload_sha256,source_seq,created_at) VALUES(?,?,?,?,?,?)`)
        .bind(CLAIM, PROBLEM, claimBody.statement, payloadSha256, sequence, createdAt),
      f.db
        .prepare(`INSERT INTO claim_versions
      (claim_id,problem_id,version,kind,statement,falsifier,content_digest,editor_fellow_id,created_at)
      VALUES(?,?,1,?,?,?,?,?,?)`)
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
          .prepare(`INSERT INTO evidence
        (evidence_id,problem_id,bears_on_kind,bears_on_id,bears_on_version,direction,kind,source_kind,
         mode,computed_class,author_fellow_id,body_md,created_at,source_event_id,source_seq)
        VALUES(?,?,'claim',?,1,?,'argument','locator','confirmatory','citation',?,?,?,?,?)`)
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
        capable_of_failure: "The equality could fail.",
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
          .prepare(`INSERT INTO reviews
        (review_id,problem_id,target_claim_id,target_version,reviewer_fellow_id,tier,verdict,basis,
         capable_of_failure,body_md,created_at,source_event_id,source_seq)
        VALUES(?,?,?,1,?,'T2','confirm','full-write-up',?,?,?,?,?)`)
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
        .prepare(`INSERT INTO directive_disclosure_records
        (event_id,problem_id,claim_id,claim_version,content_digest,source_event_id,sponsor_id,fellow_id,
         scope_id,coverage_digest,lineage_digest,revision,decision,seq,idempotency_key_digest,request_digest,
         public_payload_sha256,public_payload_json,recorded_at)
        VALUES(?,?,?,1,?,?,?,?,?,?,?,1,'no-undisclosed',?,?,?,?,?,?)`)
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
        .prepare(`INSERT INTO directive_disclosure_targets
        (problem_id,claim_id,claim_version,content_digest,source_event_id,lineage_digest,lineage_json,
         scope_requirements_json,invalidated,last_event_id,last_event_seq)
        VALUES(?,?,1,?,?,?,?,?,0,?,?)`)
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
  const enter: Extract<ProblemLifecycleActionRequest, { action: "enter-result-review" }> = {
    action: "enter-result-review",
    result_claim: { claim_id: CLAIM, version: 1 },
  };
  const apply = (
    action: Parameters<typeof applyPublicProblemGovernance>[3],
    key: string,
    db = f.db,
  ) => applyPublicProblemGovernance(db, snapshot(f), SPONSOR, action, request(key));
  const publishClosing = async () => {
    const through = (
      f.sql.query("SELECT public_seq FROM problems WHERE id = ?").get(PROBLEM) as {
        public_seq: number;
      }
    ).public_seq;
    const closing = await source("synthesis.created", "synthesis", "SYNTH-CLOSING", {
      covers_through: through,
      body_md: SUMMARY,
      anchors: [
        { target_kind: "claim", target_id: CLAIM, target_version: 1, target_seq: claim.seq },
      ],
      omitted: [],
      selection_policy: "Include the complete earned result basis.",
      dropped_single_author_count: 0,
      closing_resolution: {
        result_claim: { claim_id: CLAIM, version: 1 },
        direction: "affirmed",
        no_claim_boundary: BOUNDARY,
      },
    });
    return closing;
  };
  const resolve: Extract<ProblemLifecycleActionRequest, { action: "resolve" }> = {
    action: "resolve",
    direction: "affirmed",
    closing_synthesis: {
      synthesis_id: "SYNTH-CLOSING",
      summary: SUMMARY,
      no_claim_boundary: BOUNDARY,
    },
  };
  const hide = (target: string) =>
    f.sql
      .query(`INSERT INTO content_controls
    (control_id,problem_id,target_kind,target_ref,visibility,source,reason_category,actor,reason,version,created_at)
    VALUES(?,?,'evidence',?,'hidden','operator','privacy','operator-fixture','Current exact visibility control.',1,?)`)
      .run(`CC-${++serial}`, PROBLEM, target, NOW());
  return {
    ...f,
    source,
    apply,
    enter,
    resolve,
    publishClosing,
    hide,
    proof,
    claim,
    admitted,
    resultClaim,
  };
}
type ResolutionFixture = Awaited<ReturnType<typeof fixture>>;
async function using(run: (f: ResolutionFixture) => Promise<void>) {
  const f = await fixture();
  try {
    await run(f);
  } finally {
    f.sql.close();
  }
}
async function ready(f: ResolutionFixture) {
  const response = await f.apply(f.enter, "enter-review");
  expect(response.status, await response.clone().text()).toBe(200);
  return f.publishClosing();
}
function ledgerState(f: Fixture) {
  return {
    problem: f.sql
      .query(`SELECT public_seq,chain_digest,status,current_statement_version,
      resolution_summary,resolution_direction,resolution_no_claim_boundary,updated_at
      FROM problems WHERE id = ?`)
      .get(PROBLEM),
    global: f.sql.query("SELECT cursor FROM public_cursor WHERE singleton = 1").get(),
    events: f.sql.query("SELECT id,seq,payload_sha256 FROM events ORDER BY seq").all(),
    content: f.sql
      .query("SELECT event_id,payload_sha256 FROM event_content ORDER BY event_id")
      .all(),
    checkpoints: f.sql
      .query(
        "SELECT checkpoint_seq,checkpoint_digest FROM integrity_checkpoints ORDER BY checkpoint_seq",
      )
      .all(),
    idempotency: f.sql.query("SELECT * FROM idempotency ORDER BY idempotency_key").all(),
    outbox: f.sql.query("SELECT * FROM outbox ORDER BY id").all(),
  };
}
function beforeLedgerBatch(f: Fixture, mutate: () => void | Promise<void>) {
  let happened = false;
  const db = {
    prepare: f.db.prepare.bind(f.db),
    async batch(statements: readonly D1PreparedStatement[]) {
      if (
        !happened &&
        statements.some((s) =>
          /INSERT INTO idempotency/.test((s as unknown as { text: string }).text),
        )
      ) {
        happened = true;
        await mutate();
      }
      return f.db.batch([...statements]);
    },
  } as unknown as D1Database;
  return { db, happened: () => happened };
}

test("ordinary result resolution commits through the actual lifecycle transaction and replays exactly", () =>
  using(async (f) => {
    const closing = await ready(f);
    f.sql.query("UPDATE problems SET title = 'Forged mutable title' WHERE id = ?").run(PROBLEM);
    const before = ledgerState(f);
    const response = await f.apply(f.resolve, "resolve-result");
    expect(response.status, await response.clone().text()).toBe(200);
    const receipt = await response.json();
    const after = ledgerState(f);
    expect(after.events.length).toBe(before.events.length + 1);
    expect(after.checkpoints.length).toBe(before.checkpoints.length + 1);
    expect(after.problem).toMatchObject({
      status: "resolved",
      resolution_summary: SUMMARY,
      resolution_direction: "affirmed",
      resolution_no_claim_boundary: JSON.stringify(BOUNDARY),
    });
    const row = f.sql
      .query(`SELECT e.actor_fellow_id,e.actor_sponsor_id,e.actor_session_id,c.payload_json
    FROM events e JOIN event_content c ON c.event_id=e.id WHERE e.type='problem.resolved'`)
      .get() as {
      actor_fellow_id: string | null;
      actor_sponsor_id: string;
      actor_session_id: string | null;
      payload_json: string;
    };
    expect(row).toMatchObject({
      actor_fellow_id: null,
      actor_sponsor_id: SPONSOR,
      actor_session_id: null,
    });
    const event = ProblemGovernanceEventSchema.parse(JSON.parse(row.payload_json));
    expect(event.action).toBe("resolve");
    expect(event.problem).toMatchObject({
      title: TITLE,
      result_claim: f.resultClaim,
      closing_synthesis: {
        synthesis_id: "SYNTH-CLOSING",
        event_id: closing.eventId,
        seq: closing.seq,
        payload_digest: closing.hash,
        covers_through: closing.seq - 1,
      },
    });
    expect(event.source_fellow_id).toBe(FELLOW);
    expect(row.payload_json).not.toContain("Forged mutable title");
    expect(row.payload_json).not.toContain("resolution-lineage");
    expect(row.payload_json).not.toContain("The complete finite argument.");
    expect(await readPublishedProblemResolution(f.db, PROBLEM, closing.seq + 1)).toMatchObject({
      direction: "affirmed",
      summary: SUMMARY,
      no_claim_boundary: BOUNDARY,
      result_claim: f.resultClaim,
    });
    f.hide("E-PROOF@1");
    const replay = await f.apply(f.resolve, "resolve-result");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    expect(ledgerState(f)).toEqual(after);
    const different = await f.apply(
      { ...f.resolve, direction: "refuted-as-stated" },
      "resolve-result",
    );
    expect(different.status).toBe(409);
    expect(ledgerState(f)).toEqual(after);
  }));

for (const [name, mutate] of [
  ["exact scientific hide", (f: ResolutionFixture) => f.hide("E-PROOF@1")],
  ["closing synthesis hide", (f: ResolutionFixture) => f.hide("SYNTH-CLOSING@1")],
  ["formulation sequence hide", (f: ResolutionFixture) => f.hide(`#${f.admitted.seq}`)],
  [
    "lawful scientific redaction",
    (f: ResolutionFixture) =>
      f.sql
        .query(`UPDATE event_content SET payload_json = '{}', redacted_at = ?,
          redaction_reason = 'Current lawful redaction.' WHERE event_id = ?`)
        .run(NOW(), f.proof.eventId),
  ],
  [
    "disclosure invalidation",
    (f: ResolutionFixture) => f.sql.exec("UPDATE directive_disclosure_targets SET invalidated = 1"),
  ],
  [
    "claim statement drift",
    (f: ResolutionFixture) => f.sql.exec("UPDATE claims SET statement_drift = 1"),
  ],
  [
    "sponsor tombstone",
    (f: ResolutionFixture) =>
      f.sql
        .query("UPDATE sponsors SET tombstoned_at = ? WHERE sponsor_id = ?")
        .run(Date.now(), SPONSOR),
  ],
  [
    "new ledger event",
    async (f: ResolutionFixture) => {
      await f.source("question.asked", "question", "Q-LATER", {
        body_md: "A concurrent question.",
      });
    },
  ],
] as const) {
  test(`resolution refuses ${name} immediately before commit without partial ledger effects`, () =>
    using(async (f) => {
      await ready(f);
      let expected: ReturnType<typeof ledgerState> | undefined;
      const race = beforeLedgerBatch(f, async () => {
        await mutate(f);
        expected = ledgerState(f);
      });
      const response = await f.apply(f.resolve, "racing-resolution", race.db);
      expect(race.happened()).toBe(true);
      expect(response.status, await response.clone().text()).toBe(409);
      if (expected === undefined) throw new Error("Resolution race did not capture its state");
      expect(ledgerState(f)).toEqual(expected);
      expect(snapshot(f).status).toBe("under-result-review");
    }));
}

test("a downstream projection failure rolls back the resolution envelope and all ledger settlement", () =>
  using(async (f) => {
    await ready(f);
    f.sql.exec(`CREATE TRIGGER planted_resolution_failure BEFORE UPDATE OF status ON problems
    WHEN NEW.status = 'resolved' BEGIN SELECT RAISE(ABORT, 'planted resolution projection failure'); END;`);
    const before = ledgerState(f);
    await expect(f.apply(f.resolve, "rollback-resolution")).rejects.toThrow(
      "planted resolution projection failure",
    );
    expect(ledgerState(f)).toEqual(before);
  }));

test("entering result review rechecks sponsor authority in the ledger transaction", () =>
  using(async (f) => {
    const before = ledgerState(f);
    const race = beforeLedgerBatch(f, () => {
      f.sql
        .query("UPDATE sponsors SET tombstoned_at = ? WHERE sponsor_id = ?")
        .run(Date.now(), SPONSOR);
    });
    const response = await f.apply(f.enter, "racing-review", race.db);
    expect(race.happened()).toBe(true);
    expect(response.status, await response.clone().text()).toBe(409);
    expect(ledgerState(f)).toEqual(before);
    expect(snapshot(f).status).toBe("active");
  }));
