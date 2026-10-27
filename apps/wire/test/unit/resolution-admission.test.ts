import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ClaimDependencyPin, ProblemNoClaimBoundary } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { canonicalJson } from "../../src/krater/krater.ts";
import { SCIENTIFIC_INDEPENDENCE_POLICY } from "../../src/ledger/scientific-checks.ts";
import {
  prepareProblemResolution,
  type ProblemResolutionSnapshot,
  type ResolutionAction,
} from "../../src/problems/resolution-admission.ts";
import { installEmptyDirectiveDisclosureTables } from "../support/directive-disclosure-read.ts";

const PROBLEM = "P-RESOLUTION";
const AT = "2026-10-27T00:00:00.000Z";
const AUTHOR = "F-AUTHOR";
const SPONSOR = "usr_resolution";
const CANARY = "SOURCE-BODY-MUST-NOT-APPEAR-IN-REFUSALS";
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const boundary: ProblemNoClaimBoundary = {
  verified: ["The exact finite proposition."],
  mechanisms: ["An attempted refutation and independent verification."],
  independence_tiers: ["T2"],
  remaining_external_validation: ["No generalization beyond the stated domain was checked."],
};
const databases: Database[] = [];
afterEach(() => {
  for (const sql of databases.splice(0)) sql.close();
});

interface Source {
  eventId: string;
  seq: number;
  objectId: string;
  body: string;
  hash: string;
}

/** Real SQLite executes the production bounded selectors and atomic guard.
 * This is native unit coverage, not a Workerd or full authorization journey. */
function fixture(
  options: { artifact?: boolean; premise?: boolean; historicalWithdrawal?: boolean } = {},
) {
  const sql = new Database(":memory:");
  databases.push(sql);
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY,status TEXT,public_seq INTEGER,
      current_statement_version INTEGER,famous_guardrail TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,object_id TEXT,object_kind TEXT,
      object_version INTEGER,type TEXT,payload_sha256 TEXT,created_at TEXT,
      actor_fellow_id TEXT,actor_sponsor_id TEXT,actor_session_id TEXT,model_string_self_declared TEXT,harness TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT,target_ref TEXT,visibility TEXT,version INTEGER);
    CREATE TABLE claims(id TEXT,problem_id TEXT,source_seq INTEGER,payload_sha256 TEXT,
      statement_version INTEGER,statement_drift INTEGER,PRIMARY KEY(problem_id,id));
    CREATE TABLE claim_versions(problem_id TEXT,claim_id TEXT,version INTEGER,content_digest TEXT,
      kind TEXT,statement TEXT,falsifier TEXT,PRIMARY KEY(problem_id,claim_id,version));
    CREATE TABLE evidence(evidence_id TEXT,problem_id TEXT,source_event_id TEXT,source_seq INTEGER,
      bears_on_kind TEXT,bears_on_id TEXT,bears_on_version INTEGER,direction TEXT);
    CREATE TABLE reviews(review_id TEXT,problem_id TEXT,source_event_id TEXT,source_seq INTEGER,
      target_claim_id TEXT,target_version INTEGER,verdict TEXT,capable_of_failure TEXT);
    CREATE TABLE retractions(problem_id TEXT,retraction_id TEXT,target_object TEXT,seq INTEGER,author_fellow_id TEXT);
    CREATE TABLE scientific_withdrawals(event_id TEXT,event_sha256 TEXT,problem_id TEXT,retraction_id TEXT,
      target_object TEXT,fellow_id TEXT,seq INTEGER,source_event_id TEXT,claim_version INTEGER,
      claim_id TEXT,source_sha256 TEXT,target_kind TEXT);
    INSERT INTO problems VALUES('P-RESOLUTION','under-result-review',0,1,NULL);
  `);
  installEmptyDirectiveDisclosureTables(sql);
  let afterBatch: (() => void) | undefined;
  const statements = new WeakMap<object, () => unknown[]>();
  const db = {
    prepare(query: string) {
      let args: (string | number | null)[] = [];
      const statement = {
        bind(...values: (string | number | null)[]) {
          args = values;
          return statement;
        },
        async first() {
          return sql.query(query).get(...args) ?? null;
        },
        async all() {
          return { success: true, results: sql.query(query).all(...args) };
        },
      };
      statements.set(statement, () => sql.query(query).all(...args));
      return statement;
    },
    async batch(batch: D1PreparedStatement[]) {
      const results = sql.transaction(() =>
        batch.map((statement) => {
          const read = statements.get(statement);
          if (!read) throw new Error("Unknown statement");
          return { success: true, results: read() };
        }),
      )();
      const race = afterBatch;
      afterBatch = undefined;
      race?.();
      return results;
    },
  } as unknown as D1Database;
  let seq = 0;
  const problem = {
    id: PROBLEM,
    status: "under-result-review",
    current_statement_version: 1,
    famous_guardrail: null,
  };
  const formulation = {
    id: PROBLEM,
    title: "A finite equality question",
    current_statement_version: 1,
    statement: "Does two equal two?",
    falsifier: "An unequal result.",
    motivation: "Settle the exact finite proposition.",
    updated_at: AT,
  };
  function append(
    type: string,
    kind: string,
    objectId: string | null,
    payload: unknown,
    version = 1,
    fellow: string | null = AUTHOR,
    sponsor = SPONSOR,
  ): Source {
    const eventId = `EV-${++seq}`;
    const id = objectId ?? eventId;
    const body = canonicalJson(payload),
      hash = digest(body);
    sql
      .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        eventId,
        PROBLEM,
        seq,
        id,
        kind,
        version,
        type,
        hash,
        new Date(Date.parse(AT) + seq * 1000).toISOString(),
        fellow,
        sponsor,
        fellow === null ? null : "S-PUBLIC",
        fellow === null ? null : "declared-model",
        fellow === null ? null : "declared-harness",
      );
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(eventId, hash, body);
    sql.query("UPDATE problems SET public_seq = ? WHERE id = ?").run(seq, PROBLEM);
    return { eventId, seq, objectId: id, body, hash };
  }
  const formulationSource = append(
    "problem.admitted",
    "problem",
    PROBLEM,
    {
      action: "publish",
      acting_principal: { type: "sponsor", id: SPONSOR },
      source_fellow_id: AUTHOR,
      previous_statement_version: 1,
      previous_status: "private-draft",
      problem: { ...formulation, status: "sharpening" },
    },
    1,
    null,
  );
  const claimSources = new Map<string, Source>();
  function claim(id: string, pins: ClaimDependencyPin[] = [], version = 1): ClaimDependencyPin {
    const statement = "Two equals two.";
    const content = { falsifier: "An unequal result.", kind: "lemma", statement };
    const contentDigest = `sha256:${digest(JSON.stringify(content))}`;
    const source = append(
      version === 1 ? "claim.created" : "claim.revised",
      "claim",
      id,
      {
        claim_id: id,
        ...content,
        dependency_pins: pins,
        scientific_provenance: { model_family_self_declared: "gpt" },
        ...(version > 1 ? { base_version: version - 1 } : {}),
      },
      version,
    );
    sql
      .query("INSERT INTO claim_versions VALUES(?,?,?,?,?,?,?)")
      .run(PROBLEM, id, version, contentDigest, content.kind, statement, content.falsifier);
    sql
      .query("INSERT OR REPLACE INTO claims VALUES(?,?,?,?,1,0)")
      .run(id, PROBLEM, source.seq, source.hash);
    claimSources.set(`${id}@${version}`, source);
    return {
      claim_id: id,
      version,
      content_digest: contentDigest,
      event_id: source.eventId,
      payload_digest: source.hash,
    };
  }
  function evidence(pin: ClaimDependencyPin, id: string, fields: Record<string, unknown>): Source {
    const body = {
      bears_on_kind: "claim",
      bears_on_id: pin.claim_id,
      bears_on_version: pin.version,
      mode: "confirmatory",
      computed_class: "citation",
      body_md: CANARY,
      kind: "argument",
      direction: "informs",
      ...fields,
    };
    const source = append("evidence.created", "evidence", id, body);
    sql
      .query("INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?)")
      .run(
        id,
        PROBLEM,
        source.eventId,
        source.seq,
        "claim",
        pin.claim_id,
        pin.version,
        String(body.direction),
      );
    return source;
  }
  function review(
    pin: ClaimDependencyPin,
    id: string,
    fields: Record<string, unknown>,
    reviewer = "F-REVIEWER",
  ): Source {
    const body = {
      target_claim_id: pin.claim_id,
      target_version: pin.version,
      verdict: "confirm",
      capable_of_failure: "The exact equality could fail.",
      tier: "T2",
      independence_policy: SCIENTIFIC_INDEPENDENCE_POLICY,
      scientific_provenance: { model_family_self_declared: reviewer },
      ...fields,
    };
    const source = append("review.created", "review", id, body, 1, reviewer, `usr_${reviewer}`);
    sql
      .query("INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?)")
      .run(
        id,
        PROBLEM,
        source.eventId,
        source.seq,
        pin.claim_id,
        pin.version,
        String(body.verdict),
        String(body.capable_of_failure),
      );
    return source;
  }
  function withdraw(pin: ClaimDependencyPin, original: Source): Source {
    const id = `R-WITHDRAW-${seq}`;
    const source = append("object.retracted", "retraction", id, {
      retraction_id: id,
      target_object: original.objectId,
      target_kind: "evidence",
      target_event_id: original.eventId,
      target_digest: `sha256:${original.hash}`,
      claim_id: pin.claim_id,
      claim_version: pin.version,
      retraction_kind: "self-corrected",
      reason: "The earlier evidence omitted a boundary condition.",
    });
    sql
      .query("INSERT INTO retractions VALUES(?,?,?,?,?)")
      .run(PROBLEM, id, original.objectId, source.seq, AUTHOR);
    sql
      .query("INSERT INTO scientific_withdrawals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        source.eventId,
        source.hash,
        PROBLEM,
        id,
        original.objectId,
        AUTHOR,
        source.seq,
        original.eventId,
        pin.version,
        pin.claim_id,
        original.hash,
        "evidence",
      );
    return source;
  }
  const premise = options.premise ? claim("C-2") : undefined;
  let oldEvidence: Source | undefined;
  if (options.historicalWithdrawal) {
    const old = claim("C-1");
    oldEvidence = evidence(old, "E-OLD", { direction: "supports" });
    withdraw(old, oldEvidence);
  }
  const resultClaim = claim("C-1", premise ? [premise] : [], options.historicalWithdrawal ? 2 : 1);
  const artifact = {
    language: "lean",
    declaration: "two_eq_two",
    source: "theorem two_eq_two : 2 = 2 := rfl",
    toolchain: "leanprover/lean4:v4.19.0",
    axiom_report: "two_eq_two depends on no axioms",
  };
  const proof = evidence(resultClaim, "E-PROOF", {
    direction: "supports",
    ...(options.artifact
      ? {
          kind: "certificate",
          computed_class: "computation",
          formal_artifact: artifact,
        }
      : {}),
  });
  const reference = { evidence_id: proof.objectId, digest: `sha256:${proof.hash}` };
  const check = evidence(resultClaim, "E-CHECK", {
    direction: "informs",
    falsification_check: {
      target_digest: resultClaim.content_digest,
      attempted_falsifier: "Compare the two values.",
      capable_of_failure: "The values could differ.",
      result: "survived",
      evidence: [reference],
    },
  });
  const verification = options.artifact
    ? {
        kind: "formal-artifact",
        target_digest: resultClaim.content_digest,
        evidence: reference,
        artifact_digest: `sha256:${digest(artifact.source)}`,
        compilation: {
          command: "lean proof.lean",
          toolchain: artifact.toolchain,
          result: "success",
          output: "Compiled successfully.",
        },
        statement_comparison: {
          declaration: artifact.declaration,
          statement: "Two equals two.",
          result: "equivalent",
          explanation: "The exact equality is the theorem statement.",
        },
      }
    : {
        kind: "full-write-up",
        target_digest: resultClaim.content_digest,
        evidence: reference,
        coverage: ["The complete equality argument."],
        result: "verified",
      };
  const reviewOne = review(resultClaim, "R-ONE", { verification }, "F-ONE");
  if (!options.artifact) review(resultClaim, "R-TWO", { verification }, "F-TWO");
  const lineage = digest("resolved result accountability lineage");
  const scopeId = digest("scope"),
    coverage = digest("coverage");
  const disclosure = append(
    "directive.disclosure-recorded",
    "directive-disclosure",
    null,
    {
      kind: "directive-disclosure",
      target: { claim_id: resultClaim.claim_id, version: resultClaim.version },
      decision: "no-undisclosed",
    },
    1,
    null,
  );
  sql
    .query(`INSERT INTO directive_disclosure_records
    (event_id,problem_id,claim_id,claim_version,content_digest,source_event_id,sponsor_id,fellow_id,
      scope_id,coverage_digest,lineage_digest,revision,decision,seq,idempotency_key_digest,request_digest,
      public_payload_sha256,public_payload_json,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,'no-undisclosed',?,?,?,?,?,?)`)
    .run(
      disclosure.eventId,
      PROBLEM,
      resultClaim.claim_id,
      resultClaim.version,
      resultClaim.content_digest,
      resultClaim.event_id,
      SPONSOR,
      AUTHOR,
      scopeId,
      coverage,
      lineage,
      disclosure.seq,
      digest("idempotency"),
      digest("request"),
      disclosure.hash,
      disclosure.body,
      AT,
    );
  const lineagePins = [resultClaim, ...(premise ? [premise] : [])].map((pin) => ({
    ...pin,
    payload_json: claimSources.get(`${pin.claim_id}@${pin.version}`)!.body,
  }));
  sql
    .query(`INSERT INTO directive_disclosure_targets
    VALUES(?,?,?,?,?,?,?,?,0,?,?)`)
    .run(
      PROBLEM,
      resultClaim.claim_id,
      resultClaim.version,
      resultClaim.content_digest,
      resultClaim.event_id,
      lineage,
      JSON.stringify({ pins: lineagePins }),
      JSON.stringify([{ scope_id: scopeId, coverage_digest: coverage }]),
      disclosure.eventId,
      disclosure.seq,
    );
  const reviewPayload = {
    action: "enter-result-review",
    acting_principal: { type: "sponsor", id: SPONSOR },
    source_fellow_id: AUTHOR,
    previous_statement_version: 1,
    previous_status: "active",
    problem: { ...formulation, status: "under-result-review", result_claim: resultClaim },
  };
  const resultReview = append(
    "problem.result-review-started",
    "problem",
    PROBLEM,
    reviewPayload,
    1,
    null,
  );
  const summary = "Two equals two within the exact declared scope.";
  const synthesisPayload = {
    covers_through: seq,
    body_md: summary,
    anchors: [
      {
        target_kind: "claim",
        target_id: resultClaim.claim_id,
        target_version: resultClaim.version,
        target_seq: claimSources.get(`${resultClaim.claim_id}@${resultClaim.version}`)!.seq,
      },
    ],
    omitted: [],
    selection_policy: "Include the complete result basis.",
    dropped_single_author_count: 0,
    closing_resolution: {
      result_claim: { claim_id: resultClaim.claim_id, version: resultClaim.version },
      direction: "affirmed",
      no_claim_boundary: boundary,
    },
  };
  const synthesis = append("synthesis.created", "synthesis", "SYNTH-CLOSING", synthesisPayload);
  const action: ResolutionAction = {
    action: "resolve",
    direction: "affirmed",
    closing_synthesis: { synthesis_id: synthesis.objectId, summary, no_claim_boundary: boundary },
  };
  function control(target: string, visibility = "hidden") {
    sql
      .query(`INSERT INTO content_controls SELECT ?,?,?,COALESCE(MAX(version),0)+1
      FROM content_controls WHERE problem_id = ? AND target_ref = ?`)
      .run(PROBLEM, target, visibility, PROBLEM, target);
  }
  function replace(source: Source, payload: unknown) {
    const body = canonicalJson(payload),
      hash = digest(body);
    sql.query("UPDATE events SET payload_sha256 = ? WHERE id = ?").run(hash, source.eventId);
    sql
      .query("UPDATE event_content SET payload_sha256 = ?,payload_json = ? WHERE event_id = ?")
      .run(hash, body, source.eventId);
  }
  function stable(snapshot: ProblemResolutionSnapshot): boolean {
    return (
      sql.query(`SELECT 1 WHERE 1 ${snapshot.guard.sql}`).get(...snapshot.guard.bindings) !== null
    );
  }
  return {
    db,
    sql,
    problem,
    action,
    resultClaim,
    premise,
    proof,
    check,
    reviewOne,
    disclosure,
    resultReview,
    formulationSource,
    synthesis,
    synthesisPayload,
    reviewPayload,
    oldEvidence,
    append,
    claim,
    evidence,
    review,
    withdraw,
    control,
    replace,
    stable,
    race: (run: () => void) => {
      afterBatch = run;
    },
    read: () => prepareProblemResolution(db, problem, action),
  };
}

async function admitted(f: ReturnType<typeof fixture>): Promise<ProblemResolutionSnapshot> {
  const result = await f.read();
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(`Expected eligibility, received ${result.reason}`);
  return result.snapshot;
}

for (const artifact of [false, true]) {
  test(`${artifact ? "independently compiled artifact" : "two independent full write-ups"} earns ordinary resolution`, async () => {
    const f = fixture({ artifact });
    const snapshot = await admitted(f);
    expect(snapshot.resultClaim).toEqual(f.resultClaim);
    expect(snapshot.formulation.statement).toBe("Does two equal two?");
    expect(snapshot.closingSynthesis.synthesis.synthesis_id).toBe("SYNTH-CLOSING");
    expect(snapshot.through).toBe(f.synthesis.seq);
    expect(f.stable(snapshot)).toBe(true);
    // No storage or scientific mutation occurs during admission.
    expect(f.sql.query("SELECT status,public_seq FROM problems").get()).toEqual({
      status: "under-result-review",
      public_seq: snapshot.through,
    });
  });
}

test("the same guard admits both Krater sequence-election and event-insertion phases", async () => {
  const f = fixture();
  const snapshot = await admitted(f);
  f.sql.transaction(() => {
    const elected = f.sql
      .query(`UPDATE problems SET public_seq = public_seq + 1 WHERE id = ? ${snapshot.guard.sql}`)
      .run(PROBLEM, ...snapshot.guard.bindings);
    expect(elected.changes).toBe(1);
    expect(f.stable(snapshot)).toBe(true);
    // An intervening committed event, unlike the election alone, closes admission.
    f.append(
      "problem.resolved",
      "problem",
      PROBLEM,
      { selected_result: f.resultClaim.claim_id },
      1,
      null,
    );
    expect(f.stable(snapshot)).toBe(false);
  })();
});

test("missing synthesis, external-review assertions, famous problems and wrong status never earn admission", async () => {
  const f = fixture();
  for (const [problem, action, reason] of [
    [{ ...f.problem, status: "active" }, f.action, "not-under-result-review"],
    [{ ...f.problem, famous_guardrail: "{}" }, f.action, "famous-problem"],
    [
      f.problem,
      { ...f.action, external_expert_review_proof: "Trust this URL" },
      "external-review-unsupported",
    ],
    [
      f.problem,
      {
        ...f.action,
        closing_synthesis: { ...f.action.closing_synthesis, synthesis_id: undefined },
      },
      "closing-synthesis-unavailable",
    ],
  ] as const)
    expect(await prepareProblemResolution(f.db, problem, action)).toEqual({ ok: false, reason });
});

test("an invalid or hidden latest result-review initiation never falls back to the earlier valid one", async () => {
  for (const hidden of [false, true]) {
    const f = fixture();
    const latest = f.append(
      "problem.result-review-started",
      "problem",
      PROBLEM,
      hidden
        ? f.reviewPayload
        : { ...f.reviewPayload, problem: { ...f.reviewPayload.problem, result_claim: null } },
      1,
      null,
    );
    if (hidden) f.control(`#${latest.seq}`);
    expect(await f.read()).toEqual({ ok: false, reason: "result-review-unavailable" });
  }
});

test("resolution requires the exact review pin and current problem formulation", async () => {
  const f = fixture();
  f.replace(f.resultReview, {
    ...f.reviewPayload,
    problem: {
      ...f.reviewPayload.problem,
      result_claim: { ...f.resultClaim, payload_digest: "b".repeat(64) },
    },
  });
  expect(await f.read()).toEqual({ ok: false, reason: "result-review-unavailable" });
  const old = fixture();
  old.problem.current_statement_version = 2;
  old.sql.query("UPDATE problems SET current_statement_version = 2").run();
  expect(await old.read()).toEqual({ ok: false, reason: "result-review-unavailable" });
});

test("root and dependency statement drift or a newer premise version cannot resolve", async () => {
  for (const target of ["C-1", "C-2"]) {
    const f = fixture({ premise: true });
    await admitted(f);
    f.sql.query("UPDATE claims SET statement_drift = 1 WHERE id = ?").run(target);
    expect(await f.read()).toEqual({ ok: false, reason: "result-not-current" });
  }
  const newer = fixture({ premise: true });
  newer.claim("C-2", [], 2);
  expect(await newer.read()).toEqual({ ok: false, reason: "result-not-current" });
});

test("a reanchored current claim keeps its immutable publication identity", async () => {
  const f = fixture();
  f.sql.query("UPDATE claims SET statement_drift = 1 WHERE id = 'C-1'").run();
  f.append("claim.reanchored", "claim", "C-1", {
    claim_id: "C-1",
    base_version: 1,
    statement_version: 1,
  });
  f.sql.query("UPDATE claims SET statement_version = 1,statement_drift = 0 WHERE id = 'C-1'").run();
  expect((await admitted(f)).resultClaim.event_id).toBe(f.resultClaim.event_id);
});

test("strong local evidence cannot hide a contested premise", async () => {
  const f = fixture({ premise: true });
  f.evidence(f.premise!, "E-COUNTER", { direction: "refutes", computed_class: "computation" });
  expect(await f.read()).toEqual({ ok: false, reason: "scientific-support-incomplete" });
});

test("labels, missing refutation attempts and withdrawn current evidence cannot replace earned support", async () => {
  const labels = fixture();
  labels.replace(labels.reviewOne, {
    ...JSON.parse(labels.reviewOne.body),
    verification: null,
    full_write_up: true,
    artifact_compilation: true,
    statement_equivalence: true,
  });
  expect(await labels.read()).toEqual({ ok: false, reason: "scientific-support-incomplete" });
  const unchallenged = fixture();
  unchallenged.replace(unchallenged.check, {
    ...JSON.parse(unchallenged.check.body),
    falsification_check: null,
  });
  expect(await unchallenged.read()).toEqual({ ok: false, reason: "scientific-support-incomplete" });
  const withdrawn = fixture();
  withdrawn.withdraw(withdrawn.resultClaim, withdrawn.proof);
  expect(await withdrawn.read()).toEqual({ ok: false, reason: "scientific-support-incomplete" });
});

test("handled withdrawals from an older version do not ban a newly earned result", async () => {
  const f = fixture({ historicalWithdrawal: true });
  const snapshot = await admitted(f);
  expect(snapshot.resultClaim.version).toBe(2);
  expect(f.stable(snapshot)).toBe(true);
  // Even handled history remains an exact input; current withholding invalidates the snapshot.
  f.control(`#${f.oldEvidence!.seq}`);
  expect(f.stable(snapshot)).toBe(false);
});

test("current controls and source availability defeat captured historical cuts", async () => {
  const f = fixture();
  const snapshot = await admitted(f);
  for (const target of [
    "C-1@1",
    "E-PROOF@1",
    "R-ONE@1",
    `#${f.proof.seq}`,
    `#${f.reviewOne.seq}`,
    `#${f.resultReview.seq}`,
    `#${f.synthesis.seq}`,
    `#${f.disclosure.seq}`,
    `#${f.formulationSource.seq}`,
  ]) {
    f.control(target);
    expect(f.stable(snapshot)).toBe(false);
    const refused = await f.read();
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toContain(CANARY);
    f.control(target, "visible");
    expect(f.stable(snapshot)).toBe(true);
  }
  f.sql
    .query("UPDATE event_content SET payload_json = ? WHERE event_id = ?")
    .run("tampered bytes", f.proof.eventId);
  expect(f.stable(snapshot)).toBe(false);
  expect((await f.read()).ok).toBe(false);
});

test("independent exact controls require independent restoration", async () => {
  const f = fixture();
  const snapshot = await admitted(f);
  f.control("E-PROOF");
  f.control("E-PROOF@1");
  f.control(`#${f.proof.seq}`);
  f.control("E-PROOF", "visible");
  expect(f.stable(snapshot)).toBe(false);
  f.control("E-PROOF@1", "visible");
  expect(f.stable(snapshot)).toBe(false);
  f.control(`#${f.proof.seq}`, "visible");
  expect(f.stable(snapshot)).toBe(true);
});

test("disclosure invalidation, changed lineage, and claim drift are guarded without a new ledger event", async () => {
  for (const mutation of [
    "UPDATE directive_disclosure_targets SET invalidated = 1",
    "UPDATE directive_disclosure_targets SET lineage_digest = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
    "UPDATE claims SET statement_drift = 1 WHERE id = 'C-1'",
    "UPDATE problems SET famous_guardrail = '{}'",
  ]) {
    const f = fixture();
    const snapshot = await admitted(f);
    f.sql.exec(mutation);
    expect(f.stable(snapshot)).toBe(false);
  }
  const missing = fixture();
  missing.sql.exec("UPDATE directive_disclosure_targets SET invalidated = 1");
  expect(await missing.read()).toEqual({ ok: false, reason: "disclosure-incomplete" });
});

test("a read/commit race refuses without leaking captured sources", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.control("E-PROOF@1"),
    (f: ReturnType<typeof fixture>) =>
      f.sql.exec("UPDATE directive_disclosure_targets SET invalidated = 1"),
    (f: ReturnType<typeof fixture>) =>
      f.append("question.asked", "question", "Q-LATER", { body_md: "New activity" }),
    (f: ReturnType<typeof fixture>) => f.control(`#${f.formulationSource.seq}`),
  ]) {
    const f = fixture();
    f.race(() => mutate(f));
    const result = await f.read();
    expect(result).toEqual({ ok: false, reason: "snapshot-changed" });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  }
});

test("closing prose and boundary must match the Fellow publication exactly", async () => {
  const f = fixture();
  for (const action of [
    { ...f.action, direction: "refuted-as-stated" as const },
    {
      ...f.action,
      closing_synthesis: { ...f.action.closing_synthesis, summary: "Sponsor-written replacement." },
    },
    {
      ...f.action,
      closing_synthesis: {
        ...f.action.closing_synthesis,
        no_claim_boundary: { ...boundary, verified: ["An unverified generalization."] },
      },
    },
  ])
    expect(await prepareProblemResolution(f.db, f.problem, action)).toEqual({
      ok: false,
      reason: "closing-synthesis-mismatch",
    });
  f.replace(f.synthesis, {
    ...f.synthesisPayload,
    closing_resolution: {
      ...f.synthesisPayload.closing_resolution,
      result_claim: { claim_id: "C-9", version: 1 },
    },
  });
  expect(await f.read()).toEqual({ ok: false, reason: "closing-synthesis-mismatch" });
  f.replace(f.synthesis, {
    ...f.synthesisPayload,
    anchors: [
      {
        target_kind: "claim",
        target_id: f.resultClaim.claim_id,
        target_version: f.resultClaim.version,
      },
    ],
  });
  expect(await f.read()).toEqual({ ok: false, reason: "closing-synthesis-mismatch" });
});

test("closing synthesis must cover result review and the complete scientific input timeline", async () => {
  const beforeReview = fixture();
  beforeReview.replace(beforeReview.synthesis, {
    ...beforeReview.synthesisPayload,
    covers_through: beforeReview.resultReview.seq - 1,
  });
  expect(await beforeReview.read()).toEqual({ ok: false, reason: "closing-synthesis-mismatch" });
  const laterScience = fixture();
  laterScience.evidence(laterScience.resultClaim, "E-LATER", { direction: "informs" });
  expect(await laterScience.read()).toEqual({ ok: false, reason: "closing-synthesis-mismatch" });
  const unrelated = fixture();
  unrelated.append("question.asked", "question", "Q-UNRELATED", {
    body_md: "A separate question.",
  });
  await admitted(unrelated);
});

test("oversized closing source fails closed before producing an atomic witness", async () => {
  const f = fixture();
  f.replace(f.synthesis, {
    ...f.synthesisPayload,
    omitted: Array.from({ length: 70 }, () => "x".repeat(1000)),
  });
  expect(await f.read()).toEqual({ ok: false, reason: "source-limit" });
});
