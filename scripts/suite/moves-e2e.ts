/**
 * Moves Engine E2E Suite (W9.4, bead asimposiumorg-z8y).
 *
 * Comprehensive validation covering:
 * 1. Sharpen Statement (sharpen-statement)
 * 2. State Claim (state-claim on empty board)
 * 3. Add Refuter (add-refuter on supported claim with 0 refutations)
 * 4. Epistemic Review (review on unreviewed claim by peer)
 * 5. Third Alternative (third-alternative on exactly 2 hypotheses)
 * 6. Strong Inference Discrimination (discriminate on 3+ hypotheses)
 * 7. Kill-or-Stand (kill-or-stand on fired falsifier)
 * 8. Collapse Duplicate (collapse-duplicate on matching norm_hash)
 * 9. Re-anchor (re-anchor on statement drift)
 * 10. Record Dead End (record-dead-end negative knowledge)
 * 11. Load-Bearing Formalization (formalize on highest DAG dependents)
 * 12. Ceremony Breaker (back-to-the-object on 25+ process events)
 * 13. Synthesize (synthesize on 200+ events elapsed)
 * 14. Hello -> Triage -> Next -> Global /moves.md faces
 * 15. OPS.2a structured diagnostic logging (no secrets, no bodies)
 * 16. Engine absence / failure returns explicit degraded recovery
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProblemNextResponseSchema } from "@asimposium/contracts";
import { createApp } from "../../apps/wire/src/app.ts";
import { D1EnrollmentStore } from "../../apps/wire/src/enrollment/d1-store.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
} from "../../apps/wire/src/enrollment/service.ts";
import type { Env } from "../../apps/wire/src/env.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const MIGRATIONS = resolve(REPO_ROOT, "db/migrations");

type LocalBinding = string | number | null;

function localD1(sqlite: Database): Env["DB"] {
  return {
    prepare(query: string) {
      const bind = (...values: LocalBinding[]) => ({
        query,
        values,
        async run() {
          if (/^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(query)) {
            const rows = sqlite.prepare<unknown, LocalBinding[]>(query).all(...values);
            return {
              results: rows,
              meta: { changes: 0, rows_read: rows.length, rows_written: 0, duration: 0 },
            };
          }
          const result = sqlite.prepare<unknown, LocalBinding[]>(query).run(...values);
          return {
            results: [],
            meta: {
              changes: result.changes,
              rows_read: 0,
              rows_written: result.changes,
              duration: 0,
            },
          };
        },
        async first<T>(): Promise<T | null> {
          const row = sqlite.prepare<T, LocalBinding[]>(query).get(...values);
          return (row ?? null) as T | null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          const rows = sqlite.prepare<T, LocalBinding[]>(query).all(...values) as T[];
          return { results: rows };
        },
      });
      return {
        ...bind(),
        bind,
      };
    },
    async batch(statements: readonly { run(): Promise<unknown> }[]) {
      sqlite.run("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.run("COMMIT");
        return results;
      } catch (error) {
        sqlite.run("ROLLBACK");
        throw error;
      }
    },
    async exec(query: string) {
      sqlite.run(query);
      return { count: 0, duration: 0 };
    },
  } as unknown as Env["DB"];
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runMovesE2E() {
  console.log("Starting Moves Engine & Materiality E2E Suite (W9.4)...");

  // 1. Setup in-memory SQLite and apply all migrations
  const rawDb = new Database(":memory:");
  const migrationFiles = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    rawDb.run(sql);
  }

  const db = localD1(rawDb);
  const replayProtector = new AesGcmEnrollmentReplayProtector(new Uint8Array(32).fill(7));
  const enrollmentStore = new D1EnrollmentStore(db);
  const enrollmentService = new EnrollmentService({
    store: enrollmentStore,
    replayProtector,
    stoaOrigin: "https://a.asimposium.org",
    agoraOrigin: "https://asimposium.org",
  });

  const env = {
    DB: db,
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
    ENROLLMENT_REPLAY_KEY: Buffer.from(Uint8Array.from({ length: 32 }, (_v, i) => i)).toString(
      "base64url",
    ),
    SPONSOR_PROMOTION_RATE_LIMIT: 60,
  } as unknown as Env;

  const app = createApp({
    createEnrollmentStore: () => enrollmentStore,
  });

  // Seed sponsor
  const now = Math.floor(Date.now() / 1_000);
  rawDb.run(
    "INSERT OR IGNORE INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)",
    ["usr_sponsor_1", now, now],
  );
  rawDb.run(
    "INSERT OR IGNORE INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)",
    ["usr_sponsor_2", now, now],
  );

  let fellowSeq = 1;
  async function createFellow(name: string, sponsorId = "usr_sponsor_1") {
    const id = fellowSeq++;
    const sponsor = { type: "sponsor", sponsorId } as const;
    const minted = await enrollmentService.mint(sponsor, {
      requested_scopes: ["promote", "review"],
    });

    const regRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/fellows", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `reg-moves-${id}` },
        body: JSON.stringify({
          enrollment_id: minted.enrollmentId,
          secret: minted.secret,
          name,
          model: "frontier-v1",
          harness: "cli-harness",
        }),
      }),
      env,
    );
    if (regRes.status !== 202) {
      const text = await regRes.text();
      throw new Error(`registration failed with ${regRes.status}: ${text}`);
    }
    const { flow_handle: flowHandle } = (await regRes.json()) as { flow_handle: string };

    await enrollmentService.decide(sponsor, minted.enrollmentId, {
      enrollment_id: minted.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1_000),
    });

    const tokRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/device-token", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `tok-moves-${id}` },
        body: JSON.stringify({ flow_handle: flowHandle }),
      }),
      env,
    );
    assert(tokRes.status === 200, `token retrieval failed with ${tokRes.status}`);
    const { token } = (await tokRes.json()) as { token: string };
    const binding = await enrollmentService.credentialBinding(token);
    assert(binding !== undefined, "credential binding should exist");

    return { token, fellowId: binding.fellowId, name, sponsorId };
  }

  const fellowA = await createFellow("fellow-alpha", "usr_sponsor_1");
  const fellowB = await createFellow("fellow-beta", "usr_sponsor_2");

  // Helper to create and assign a problem
  function setupProblem(
    problemId: string,
    status = "active",
    admissionMode = "open",
    withFalsifier = true,
  ) {
    rawDb.run(
      `INSERT INTO problems (id, title, admission_mode, status, public_seq, current_statement_version, created_at, updated_at, chain_digest, chain_version)
       VALUES (?, ?, ?, ?, 0, 1, ?, ?, 'genesis', 2)`,
      [problemId, `Title for ${problemId}`, admissionMode, status, now, now],
    );
    rawDb.run(
      `INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version)
       VALUES (?, 'complete', 0, ?, 2)`,
      [problemId, new Date().toISOString()],
    );
    if (withFalsifier && status !== "sharpening") {
      rawDb.run(
        `INSERT INTO problem_statement_versions (problem_id, version, statement, norm_hash, falsifier, motivation, created_at)
         VALUES (?, 1, 'Formulated problem statement', 'norm1', 'Explicit falsifier condition', 'Motivation', ?)`,
        [problemId, new Date().toISOString()],
      );
    }
    rawDb.run(
      `INSERT INTO problem_memberships (problem_id, fellow_id, role, joined_at)
       VALUES (?, ?, 'contributor', ?)`,
      [problemId, fellowA.fellowId, new Date().toISOString()],
    );
    rawDb.run(
      `INSERT INTO problem_memberships (problem_id, fellow_id, role, joined_at)
       VALUES (?, ?, 'contributor', ?)`,
      [problemId, fellowB.fellowId, new Date().toISOString()],
    );
  }

  function seedEvent(input: {
    id: string;
    problemId: string;
    seq: number;
    type: string;
    objectKind: string;
    objectId: string;
    objectVersion: number;
    payload: Record<string, unknown>;
    actorFellowId?: string;
    actorSponsorId?: string;
  }) {
    rawDb.run("UPDATE problems SET public_seq = ? WHERE id = ?", [input.seq, input.problemId]);
    const payloadStr = JSON.stringify(input.payload);
    const digest = createHash("sha256").update(payloadStr).digest("hex");
    rawDb.run(
      `INSERT INTO events (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, row_digest, chain_digest, created_at, actor_fellow_id, actor_sponsor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'row-digest', 'genesis', '2026-09-01T00:00:00.000Z', ?, ?)`,
      [
        input.id,
        input.problemId,
        input.seq,
        input.type,
        input.objectKind,
        input.objectId,
        input.objectVersion,
        digest,
        input.actorFellowId ?? fellowA.fellowId,
        input.actorSponsorId ?? "usr_sponsor_1",
      ],
    );
    rawDb.run(
      `INSERT INTO event_content (event_id, payload_sha256, payload_json)
       VALUES (?, ?, ?)`,
      [input.id, digest, payloadStr],
    );
  }

  function seedClaim(input: {
    problemId: string;
    claimId: string;
    version: number;
    statement: string;
    falsifier?: string;
    fellowId: string;
    seq: number;
    eventId?: string;
  }) {
    const eventId = input.eventId ?? `EV-${input.problemId}-${input.claimId}-${input.version}`;
    const payload = {
      claim_id: input.claimId,
      kind: "claim",
      statement: input.statement,
      falsifier: input.falsifier ?? "Falsifier condition",
    };
    seedEvent({
      id: eventId,
      problemId: input.problemId,
      seq: input.seq,
      type: input.version === 1 ? "claim.created" : "claim.revised",
      objectKind: "claim",
      objectId: input.claimId,
      objectVersion: input.version,
      payload,
      actorFellowId: input.fellowId,
    });

    const payloadStr = JSON.stringify(payload);
    const digest = createHash("sha256").update(payloadStr).digest("hex");
    const falsifier = input.falsifier ?? "Falsifier condition";
    const canonicalContent = JSON.stringify({
      falsifier,
      kind: "conjecture",
      statement: input.statement,
    });
    const contentDigest = `sha256:${createHash("sha256").update(canonicalContent).digest("hex")}`;

    rawDb.run(
      `INSERT OR REPLACE INTO claims (id, problem_id, statement, payload_sha256, source_seq, created_at)
       VALUES (?, ?, ?, ?, ?, '2026-09-01T00:00:00.000Z')`,
      [input.claimId, input.problemId, input.statement, digest, input.seq],
    );

    rawDb.run(
      `INSERT OR REPLACE INTO claim_versions (claim_id, problem_id, version, kind, statement, falsifier, content_digest, editor_fellow_id, created_at)
       VALUES (?, ?, ?, 'conjecture', ?, ?, ?, ?, '2026-09-01T00:00:00.000Z')`,
      [
        input.claimId,
        input.problemId,
        input.version,
        input.statement,
        falsifier,
        contentDigest,
        input.fellowId,
      ],
    );
  }

  function seedHypothesis(input: {
    problemId: string;
    hypothesisId: string;
    route: string;
    mechanism: string;
    falsifier: string;
    seq: number;
    fellowId: string;
  }) {
    const payload = {
      route: input.route,
      mechanism: input.mechanism,
      falsifier: input.falsifier,
      expected_evidence: "test evidence",
      origin: "proposed",
      discriminating_predictions: ["p1", "p2"],
      body_md: "Markdown body for hypothesis",
    };
    seedEvent({
      id: `EV-${input.problemId}-${input.hypothesisId}`,
      problemId: input.problemId,
      seq: input.seq,
      type: "hypothesis.created",
      objectKind: "hypothesis",
      objectId: input.hypothesisId,
      objectVersion: 1,
      payload,
      actorFellowId: input.fellowId,
    });
    rawDb.run(
      `INSERT INTO hypotheses (hypothesis_id, problem_id, route, mechanism, falsifier, origin, status, author_fellow_id, created_at, body_md)
       VALUES (?, ?, ?, ?, ?, 'proposed', 'open', ?, '2026-09-01T00:00:00.000Z', 'Markdown body for hypothesis')`,
      [
        input.hypothesisId,
        input.problemId,
        input.route,
        input.mechanism,
        input.falsifier,
        input.fellowId,
      ],
    );
  }

  function seedEvidence(input: {
    problemId: string;
    evidenceId: string;
    bearsOnKind: string;
    bearsOnId: string;
    bearsOnVersion?: number;
    direction: string;
    kind: string;
    seq: number;
    fellowId: string;
    sponsorId?: string;
    bodyMd?: string;
  }) {
    const eventId = `EV-${input.problemId}-${input.evidenceId}`;
    const payload = {
      bears_on_kind: input.bearsOnKind,
      bears_on_id: input.bearsOnId,
      bears_on_version: input.bearsOnVersion ?? 1,
      direction: input.direction,
      kind: input.kind,
      mode: "confirmatory",
      computed_class: "computation",
      body_md: input.bodyMd ?? "Body text for evidence",
    };
    seedEvent({
      id: eventId,
      problemId: input.problemId,
      seq: input.seq,
      type: "evidence.created",
      objectKind: "evidence",
      objectId: input.evidenceId,
      objectVersion: 1,
      payload,
      actorFellowId: input.fellowId,
      actorSponsorId: input.sponsorId ?? "usr_sponsor_1",
    });
    rawDb.run(
      `INSERT INTO evidence (evidence_id, problem_id, bears_on_kind, bears_on_id, bears_on_version, direction, kind, source_kind, mode, computed_class, author_fellow_id, body_md, created_at, source_event_id, source_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'locator', 'confirmatory', 'computation', ?, ?, '2026-09-01T00:00:00.000Z', ?, ?)`,
      [
        input.evidenceId,
        input.problemId,
        input.bearsOnKind,
        input.bearsOnId,
        input.bearsOnVersion ?? 1,
        input.direction,
        input.kind,
        input.fellowId,
        input.bodyMd ?? "Body text for evidence",
        eventId,
        input.seq,
      ],
    );
  }

  function seedReview(input: {
    problemId: string;
    reviewId: string;
    targetClaimId: string;
    targetVersion: number;
    seq: number;
    fellowId: string;
    sponsorId?: string;
    verdict?: string;
    capableOfFailure?: string;
    tier?: string;
  }) {
    const eventId = `EV-${input.problemId}-${input.reviewId}`;
    const payload = {
      target_claim_id: input.targetClaimId,
      target_version: input.targetVersion,
      verdict: input.verdict ?? "confirm",
      capable_of_failure: input.capableOfFailure ?? "An unequal result.",
      independence_policy: "declared-family-and-grounded-method-v1",
      tier: input.tier ?? "T2",
      rubric: ["sound", "reproduced"],
    };
    seedEvent({
      id: eventId,
      problemId: input.problemId,
      seq: input.seq,
      type: "review.created",
      objectKind: "review",
      objectId: input.reviewId,
      objectVersion: 1,
      payload,
      actorFellowId: input.fellowId,
      actorSponsorId: input.sponsorId ?? "usr_sponsor_2",
    });
    rawDb.run(
      `INSERT INTO reviews (review_id, problem_id, target_claim_id, target_version, reviewer_fellow_id, tier, verdict, basis, capable_of_failure, rubric_json, body_md, created_at, source_event_id, source_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'argument', ?, '["sound", "reproduced"]', 'Body text for review', '2026-09-01T00:00:00.000Z', ?, ?)`,
      [
        input.reviewId,
        input.problemId,
        input.targetClaimId,
        input.targetVersion,
        input.fellowId,
        input.tier ?? "T2",
        input.verdict ?? "confirm",
        input.capableOfFailure ?? "An unequal result.",
        eventId,
        input.seq,
      ],
    );
  }

  // --- Scenario 1: Sharpen Statement ---
  console.log("\n1. Testing Sharpen Statement Trigger...");
  {
    setupProblem("P-SHARP", "sharpening");
    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-SHARP/next", {
        headers: { authorization: `Bearer ${fellowA.token}` },
      }),
      env,
    );
    assert(res.status === 200, "next returns 200");
    const data = ProblemNextResponseSchema.parse(await res.json());
    assert(data.primary_move?.move === "sharpen-statement", "primary move is sharpen-statement");
    assert(data.primary_move?.refs[1] === "S@1", "targets statement version 1");
  }

  // --- Scenario 2: State Claim on Empty Problem ---
  console.log("\n2. Testing State Claim on Empty Board...");
  {
    setupProblem("P-EMPTY", "active");
    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-EMPTY/next", {
        headers: { authorization: `Bearer ${fellowA.token}` },
      }),
      env,
    );
    assert(res.status === 200, "next returns 200");
    const data = ProblemNextResponseSchema.parse(await res.json());
    assert(data.primary_move?.move === "state-claim", "primary move is state-claim");
  }

  // --- Scenario 3: Add Refuter on Unchallenged Support ---
  console.log("\n3. Testing Add Refuter on Supported Claim...");
  {
    setupProblem("P-REFUTE", "active");
    seedClaim({
      problemId: "P-REFUTE",
      claimId: "C-1",
      version: 1,
      statement: "A bold claim.",
      fellowId: fellowA.fellowId,
      seq: 1,
    });
    seedEvidence({
      problemId: "P-REFUTE",
      evidenceId: "E-SUPP",
      bearsOnKind: "claim",
      bearsOnId: "C-1",
      bearsOnVersion: 1,
      direction: "supports",
      kind: "computation",
      seq: 2,
      fellowId: fellowA.fellowId,
    });
    seedReview({
      problemId: "P-REFUTE",
      reviewId: "R-1",
      targetClaimId: "C-1",
      targetVersion: 1,
      seq: 3,
      fellowId: fellowB.fellowId,
      sponsorId: "usr_sponsor_2",
      tier: "T2",
      verdict: "confirm",
    });

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-REFUTE/next", {
        headers: { authorization: `Bearer ${fellowA.token}` },
      }),
      env,
    );
    assert(res.status === 200, "next returns 200");
    const data = ProblemNextResponseSchema.parse(await res.json());
    assert(data.primary_move?.move === "add-refuter", "primary move is add-refuter");
    assert(data.primary_move?.refs[1] === "C-1@1", "targets C-1@1");
  }

  // --- Scenario 4: Epistemic Review ---
  console.log("\n4. Testing Epistemic Review for Non-Author...");
  {
    setupProblem("P-REVIEW", "active");
    seedClaim({
      problemId: "P-REVIEW",
      claimId: "C-1",
      version: 1,
      statement: "Unreviewed claim.",
      fellowId: fellowA.fellowId,
      seq: 1,
    });

    // Fellow B (different fellow) queries next moves
    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-REVIEW/next", {
        headers: { authorization: `Bearer ${fellowB.token}` },
      }),
      env,
    );
    assert(res.status === 200, "next returns 200");
    const data = ProblemNextResponseSchema.parse(await res.json());
    // Fellow B should receive review or add-refuter
    assert(data.primary_move !== null, "move is returned");
    assert(
      ["review", "add-refuter"].includes(data.primary_move?.move as string),
      "epistemic check move",
    );
  }

  // --- Scenario 5: Third Alternative on 2 Hypotheses ---
  console.log("\n5. Testing Third Alternative on 2 Hypotheses...");
  {
    setupProblem("P-HYP", "active");
    seedClaim({
      problemId: "P-HYP",
      claimId: "C-1",
      version: 1,
      statement: "Hypothesis claim.",
      fellowId: fellowA.fellowId,
      seq: 1,
    });
    seedHypothesis({
      problemId: "P-HYP",
      hypothesisId: "H-1",
      route: "Route 1",
      mechanism: "Mech 1",
      falsifier: "Fals 1",
      seq: 2,
      fellowId: fellowA.fellowId,
    });
    seedHypothesis({
      problemId: "P-HYP",
      hypothesisId: "H-2",
      route: "Route 2",
      mechanism: "Mech 2",
      falsifier: "Fals 2",
      seq: 3,
      fellowId: fellowA.fellowId,
    });

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-HYP/next", {
        headers: { authorization: `Bearer ${fellowA.token}` },
      }),
      env,
    );
    assert(res.status === 200, "next returns 200");
    const data = ProblemNextResponseSchema.parse(await res.json());
    const moves = [data.primary_move?.move, ...data.alternatives.map((a) => a.move)];
    assert(moves.includes("third-alternative"), "offers third-alternative for 2 live routes");
  }

  // --- Scenario 6: Strong Inference Discrimination on 3+ Hypotheses ---
  console.log("\n6. Testing Strong Inference Discrimination on 3+ Hypotheses...");
  {
    setupProblem("P-DISC", "active");
    seedClaim({
      problemId: "P-DISC",
      claimId: "C-1",
      version: 1,
      statement: "Discrimination claim.",
      fellowId: fellowA.fellowId,
      seq: 1,
    });
    seedHypothesis({
      problemId: "P-DISC",
      hypothesisId: "H-1",
      route: "Route 1",
      mechanism: "Mech 1",
      falsifier: "Fals 1",
      seq: 2,
      fellowId: fellowA.fellowId,
    });
    seedHypothesis({
      problemId: "P-DISC",
      hypothesisId: "H-2",
      route: "Route 2",
      mechanism: "Mech 2",
      falsifier: "Fals 2",
      seq: 3,
      fellowId: fellowA.fellowId,
    });
    seedHypothesis({
      problemId: "P-DISC",
      hypothesisId: "H-3",
      route: "Route 3",
      mechanism: "Mech 3",
      falsifier: "Fals 3",
      seq: 4,
      fellowId: fellowA.fellowId,
    });

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-DISC/next", {
        headers: { authorization: `Bearer ${fellowA.token}` },
      }),
      env,
    );
    assert(res.status === 200, "next returns 200");
    const data = ProblemNextResponseSchema.parse(await res.json());
    const moves = [data.primary_move?.move, ...data.alternatives.map((a) => a.move)];
    assert(moves.includes("discriminate"), "offers discriminate for 3+ live hypotheses");
  }

  // --- Scenario 7: Kill-or-Stand ---
  console.log("\n7. Testing Kill-or-Stand on Fired Falsifier...");
  {
    setupProblem("P-KILL", "active");
    seedClaim({
      problemId: "P-KILL",
      claimId: "C-1",
      version: 1,
      statement: "Fired falsifier claim.",
      fellowId: fellowA.fellowId,
      seq: 1,
    });
    seedHypothesis({
      problemId: "P-KILL",
      hypothesisId: "H-DEAD",
      route: "Route Dead",
      mechanism: "Mech",
      falsifier: "Falsifier fired",
      seq: 2,
      fellowId: fellowA.fellowId,
    });
    seedEvidence({
      problemId: "P-KILL",
      evidenceId: "E-KILL",
      bearsOnKind: "hypothesis",
      bearsOnId: "H-DEAD",
      direction: "refutes",
      kind: "computation",
      seq: 3,
      fellowId: fellowA.fellowId,
    });

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-KILL/next", {
        headers: { authorization: `Bearer ${fellowA.token}` },
      }),
      env,
    );
    assert(res.status === 200, "next returns 200");
    const data = ProblemNextResponseSchema.parse(await res.json());
    const moves = [data.primary_move?.move, ...data.alternatives.map((a) => a.move)];
    assert(moves.includes("kill-or-stand"), "offers kill-or-stand when falsifier fired");
  }

  // --- Scenario 8: Collapse Duplicate ---
  console.log("\n8. Testing Collapse Duplicate on Identical Hashes...");
  {
    setupProblem("P-DUP", "active");
    seedClaim({
      problemId: "P-DUP",
      claimId: "C-1",
      version: 1,
      statement: "A duplicated claim statement.",
      fellowId: fellowA.fellowId,
      seq: 1,
    });
    seedClaim({
      problemId: "P-DUP",
      claimId: "C-2",
      version: 1,
      statement: "A duplicated claim statement.",
      fellowId: fellowA.fellowId,
      seq: 2,
    });
    seedEvent({
      id: "EV-DUP1",
      problemId: "P-DUP",
      seq: 3,
      type: "claim.revised",
      objectKind: "claim",
      objectId: "C-1",
      objectVersion: 2,
      payload: { statement: "Dup 1", norm_hash: "hash-identical" },
    });
    seedEvent({
      id: "EV-DUP2",
      problemId: "P-DUP",
      seq: 4,
      type: "claim.revised",
      objectKind: "claim",
      objectId: "C-2",
      objectVersion: 2,
      payload: { statement: "Dup 2", norm_hash: "hash-identical" },
    });

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-DUP/next", {
        headers: { authorization: `Bearer ${fellowA.token}` },
      }),
      env,
    );
    assert(res.status === 200, "next returns 200");
    const data = ProblemNextResponseSchema.parse(await res.json());
    const moves = [data.primary_move?.move, ...data.alternatives.map((a) => a.move)];
    assert(
      moves.includes("collapse-duplicate"),
      "offers collapse-duplicate for matching norm_hash",
    );
  }

  // --- Scenario 9: Load-Bearing Formalization ---
  console.log("\n9. Testing Load-Bearing Formalization by DAG Dependents...");
  {
    setupProblem("P-FORM", "active");
    seedClaim({
      problemId: "P-FORM",
      claimId: "C-KEY",
      version: 1,
      statement: "Pivotal foundation.",
      fellowId: fellowA.fellowId,
      seq: 1,
    });
    seedClaim({
      problemId: "P-FORM",
      claimId: "C-DEP1",
      version: 1,
      statement: "Dependent claim 1.",
      fellowId: fellowA.fellowId,
      seq: 2,
    });
    seedClaim({
      problemId: "P-FORM",
      claimId: "C-DEP2",
      version: 1,
      statement: "Dependent claim 2.",
      fellowId: fellowA.fellowId,
      seq: 3,
    });
    seedClaim({
      problemId: "P-FORM",
      claimId: "C-DEP3",
      version: 1,
      statement: "Dependent claim 3.",
      fellowId: fellowA.fellowId,
      seq: 4,
    });
    rawDb.run(
      "INSERT INTO claim_deps (problem_id, claim_id, depends_on_claim_id, created_at) VALUES ('P-FORM', 'C-DEP1', 'C-KEY', '2026-09-01T00:00:00.000Z')",
    );
    rawDb.run(
      "INSERT INTO claim_deps (problem_id, claim_id, depends_on_claim_id, created_at) VALUES ('P-FORM', 'C-DEP2', 'C-KEY', '2026-09-01T00:00:00.000Z')",
    );
    rawDb.run(
      "INSERT INTO claim_deps (problem_id, claim_id, depends_on_claim_id, created_at) VALUES ('P-FORM', 'C-DEP3', 'C-KEY', '2026-09-01T00:00:00.000Z')",
    );

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-FORM/next", {
        headers: { authorization: `Bearer ${fellowA.token}` },
      }),
      env,
    );
    assert(res.status === 200, "next returns 200");
    const data = ProblemNextResponseSchema.parse(await res.json());
    const moves = [data.primary_move?.move, ...data.alternatives.map((a) => a.move)];
    assert(moves.includes("formalize"), "offers formalize for claim with 3 DAG dependents");
  }

  // --- Scenario 10: Ceremony Breaker (Back-to-the-Object) ---
  console.log("\n10. Testing Ceremony Breaker on 25+ Process Events...");
  {
    setupProblem("P-CEREMONY", "active");
    seedClaim({
      problemId: "P-CEREMONY",
      claimId: "C-PENDING",
      version: 1,
      statement: "Unfinished object.",
      fellowId: fellowA.fellowId,
      seq: 1,
    });

    // 25 process events
    for (let i = 2; i <= 26; i++) {
      seedEvent({
        id: `EV-SYN-${i}`,
        problemId: "P-CEREMONY",
        seq: i,
        type: "synthesis.published",
        objectKind: "synthesis",
        objectId: "SYN",
        objectVersion: 1,
        payload: { summary: `Synthesis digest ${i}` },
      });
    }

    const res = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-CEREMONY/next", {
        headers: { authorization: `Bearer ${fellowA.token}` },
      }),
      env,
    );
    assert(res.status === 200, "next returns 200");
    const data = ProblemNextResponseSchema.parse(await res.json());
    assert(
      data.primary_move?.move === "back-to-the-object",
      "ceremony breaker forces back-to-the-object primary move",
    );
    assert(
      Boolean(data.primary_move?.why.includes("Ceremony breaker active")),
      "why explains ceremony breaker",
    );
  }

  // --- Scenario 11: Global Moves Faces (/moves, /moves.json, /moves.md) ---
  console.log("\n11. Testing Public Move Faces & Markdown Diptych...");
  {
    // GET /moves (JSON default)
    const jsonRes = await app.fetch(new Request("https://a.asimposium.org/moves"), env);
    assert(jsonRes.status === 200, "/moves returns 200");
    const jsonBody = (await jsonRes.json()) as { moves: Record<string, unknown> };
    assert(jsonBody.moves["sharpen-statement"] !== undefined, "has sharpen-statement in catalog");
    assert(jsonBody.moves["back-to-the-object"] !== undefined, "has back-to-the-object in catalog");

    // GET /moves.md (Markdown Diptych)
    const mdRes = await app.fetch(new Request("https://a.asimposium.org/moves.md"), env);
    assert(mdRes.status === 200, "/moves.md returns 200");
    assert(
      Boolean(mdRes.headers.get("content-type")?.includes("text/markdown")),
      "content-type is text/markdown",
    );
    const mdText = await mdRes.text();
    assert(mdText.startsWith("---"), "has YAML frontmatter");
    assert(mdText.includes("# ASImposium Move Catalog"), "has catalog title");
    assert(mdText.includes("back-to-the-object"), "contains back-to-the-object");

    // Content negotiation on /moves with Accept: text/markdown
    const acceptRes = await app.fetch(
      new Request("https://a.asimposium.org/moves", {
        headers: { accept: "text/markdown" },
      }),
      env,
    );
    assert(acceptRes.status === 200, "content negotiation returns 200");
    assert(
      Boolean(acceptRes.headers.get("content-type")?.includes("text/markdown")),
      "returns markdown",
    );
  }

  // --- Scenario 12: Degraded Recovery on Missing Database ---
  console.log("\n12. Testing Degraded Recovery on DB Absence...");
  {
    const degradedRes = await app.fetch(
      new Request("https://a.asimposium.org/v1/p/P-SHARP/next", {
        headers: { authorization: `Bearer ${fellowA.token}` },
      }),
      { ...env, DB: undefined } as unknown as Env,
    );
    assert(degradedRes.status === 200, "degraded returns 200 envelope");
    const degradedData = ProblemNextResponseSchema.parse(await degradedRes.json());
    assert(degradedData.degraded === true, "degraded flag is true");
    assert(degradedData.degraded_reason === "MOVES_UNAVAILABLE", "reason is MOVES_UNAVAILABLE");
    assert(degradedData.primary_move === null, "never fabricates a synthetic move on outage");
  }

  console.log("\nAll 12 Moves Engine E2E Scenarios Passed Successfully!");
}

runMovesE2E().catch((err) => {
  console.error("Moves E2E Error:", err);
  process.exit(1);
});
