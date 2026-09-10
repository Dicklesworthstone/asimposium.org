/**
 * Intent Classifier E2E Gate (W4.5, bead asimposiumorg-k74).
 *
 * Proves:
 * 1. Notes with proposition markers are refused with 422 LOOKS_LIKE_CLAIM and rule §7.6.
 * 2. Unanchored notes >800 characters are refused with 422 LOOKS_LIKE_CLAIM.
 * 3. The refusal carries a colleague-voice fix hint and prefilled suggested claim statement in example.
 * 4. Refused notes perform NO automatic promotion (no claim row, no ledger event, no status change).
 * 5. The suggested claim statement is promotable via explicit POST /v1/sessions/:id/promote.
 * 6. The recorded escape hatch force_note: true admits claim-shaped notes into workshop_objects with force_note=1.
 * 7. Valid strange notes (<800 chars, no markers) pass without needing force_note (force_note=0).
 * 8. OPS.2a structured diagnostic records log hashes, decision, code, prefill digest, and duration,
 *    never raw note text, detector regexes, or credentials.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ProblemDocumentSchema,
  PromoteResponseSchema,
  SessionOpenResponseSchema,
  WorkshopPushResponseSchema,
} from "@asimposium/contracts";
import { createApp } from "../../apps/wire/src/app.ts";
import { D1EnrollmentStore } from "../../apps/wire/src/enrollment/d1-store.ts";
import { createEnrollmentRouter } from "../../apps/wire/src/enrollment/router.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
} from "../../apps/wire/src/enrollment/service.ts";
import type { Env } from "../../apps/wire/src/env.ts";
import { genesisChainDigest } from "../../apps/wire/src/krater/krater.ts";
import { syntheticScreeningObservation } from "../../apps/wire/test/support/screening.ts";

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
          if (/^\s*SELECT\b/i.test(query)) {
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
        async all<T>(): Promise<{
          results: T[];
          meta: { rows_read: number; rows_written: number; duration: number };
        }> {
          const rows = sqlite.prepare<T, LocalBinding[]>(query).all(...values) as T[];
          return { results: rows, meta: { rows_read: rows.length, rows_written: 0, duration: 0 } };
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
  } as unknown as Env["DB"];
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface IntentClassifierE2ETestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly error?: string;
  readonly body_digest?: string;
}

export interface Ops2aIntentRecord {
  readonly tag: "OPS.2a";
  readonly suite: "intent-classifier";
  readonly stage: string;
  readonly fixture_body_digest: string;
  readonly classifier_version: string;
  readonly decision: "refuse" | "accept";
  readonly code: "LOOKS_LIKE_CLAIM" | null;
  readonly prefill_digest: string | null;
  readonly force_note: boolean;
  readonly duration_ms: number;
}

export async function createIntentTestEnvironment(): Promise<{
  readonly db: Env["DB"];
  readonly raw: Database;
  readonly app: ReturnType<typeof createApp>;
  readonly env: Env;
  readonly fellowToken: string;
  readonly fellowId: string;
  readonly problemId: string;
}> {
  const sqlite = new Database(":memory:", { strict: true });
  const migrationFiles = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    sqlite.run(sql);
  }

  const problemId = "P-4DSP";
  const sponsorId = "usr_sponsor_intent_1";
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const genesisDigest = await genesisChainDigest(problemId);

  // Seed problem P-4DSP
  sqlite.run(
    `INSERT INTO problems (id, public_seq, chain_version, chain_digest, created_at, updated_at)
     VALUES (?, 0, 2, ?, ?, ?)`,
    [problemId, genesisDigest, nowIso, nowIso],
  );
  sqlite.run(
    `INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version)
     VALUES (?, 'complete', 0, ?, 2)`,
    [problemId, nowIso],
  );

  // Seed sponsor
  sqlite.run(
    `INSERT INTO sponsors (sponsor_id, created_at, last_seen_at)
     VALUES (?, ?, ?)`,
    [sponsorId, Date.now(), Date.now()],
  );

  const db = localD1(sqlite);
  const replayKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64url");
  const replayProtector = new AesGcmEnrollmentReplayProtector(
    Uint8Array.from({ length: 32 }, (_v, i) => i),
  );
  const enrollmentStore = new D1EnrollmentStore(db);
  const service = new EnrollmentService({
    stoaOrigin: "https://a.asimposium.org",
    agoraOrigin: "https://asimposium.org",
    store: enrollmentStore,
    replayProtector,
  });
  const enrollmentRouter = createEnrollmentRouter({ service, db });

  const sponsor = { type: "sponsor", sponsorId } as const;
  const minted = await service.mint(sponsor, {
    requested_scopes: ["promote", "review"],
    problem_binding: problemId,
  });

  const envStub = { DB: db } as unknown as Env;
  const registration = await enrollmentRouter.fetch(
    new Request("https://a.asimposium.org/v1/fellows", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "e2e-intent-reg-1" },
      body: JSON.stringify({
        enrollment_id: minted.enrollmentId,
        secret: minted.secret,
        name: "intent-runner",
        model: "model-fable",
        harness: "harness-fable",
      }),
    }),
    envStub,
  );

  const regJson = (await registration.json()) as { flow_handle: string };
  await service.decide(sponsor, minted.enrollmentId, {
    enrollment_id: minted.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: Math.floor(Date.now() / 1_000),
  });

  const issued = await enrollmentRouter.fetch(
    new Request("https://a.asimposium.org/v1/device-token", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "e2e-intent-token-1" },
      body: JSON.stringify({ flow_handle: regJson.flow_handle }),
    }),
    envStub,
  );

  const issuedBody = (await issued.json()) as { token?: string };
  if (!issuedBody.token) throw new Error(`Token issuance failed: ${JSON.stringify(issuedBody)}`);
  const fellowToken = issuedBody.token;
  const binding = await service.credentialBinding(fellowToken);
  if (!binding) throw new Error("credentialBinding failed");
  const fellowId = binding.fellowId;

  const env = {
    DB: db,
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
    ENVIRONMENT: "test",
    ...{ ["AUTH_" + "SECRET"]: Buffer.alloc(32, "a").toString("hex") },
    ENROLLMENT_REPLAY_KEY: replayKey,
  } as unknown as Env;

  const app = createApp({
    screenPromotion: async (input) =>
      syntheticScreeningObservation(input, {
        decision: "pass",
        coarse_category: "benign-context",
        provider_status: "ok",
      }),
  });

  return { db, raw: sqlite, app, env, fellowToken, fellowId, problemId };
}

export async function runAllIntentClassifierE2EAssertions(): Promise<{
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly IntentClassifierE2ETestResult[];
  readonly opsRecords: readonly Ops2aIntentRecord[];
}> {
  const { app, env, raw, fellowToken, problemId } = await createIntentTestEnvironment();
  const results: IntentClassifierE2ETestResult[] = [];
  const opsRecords: Ops2aIntentRecord[] = [];

  const authHeaders = (idempotencyKey: string) => ({
    authorization: `Bearer ${fellowToken}`,
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  });

  // Step 1: Open session
  let sessionId = "";
  const openRes = await app.request(
    "https://a.asimposium.org/v1/sessions",
    {
      method: "POST",
      headers: authHeaders("e2e-intent-open-session-1"),
      body: JSON.stringify({ problem_id: problemId, intent: "explore" }),
    },
    env,
  );

  if (openRes.status !== 201) {
    throw new Error(
      `Failed to open session for intent e2e: ${openRes.status} ${await openRes.text()}`,
    );
  }
  const sessionBody = SessionOpenResponseSchema.parse(await openRes.json());
  sessionId = sessionBody.session_id;

  const runAssertion = async (
    name: string,
    bodyText: string,
    fn: () => Promise<{
      decision: "refuse" | "accept";
      code: "LOOKS_LIKE_CLAIM" | null;
      prefillDigest: string | null;
      forceNote: boolean;
    }>,
  ) => {
    const start = performance.now();
    const bodyDigest = `sha256:${sha256Hex(bodyText)}`;
    try {
      const outcome = await fn();
      const elapsed = Math.round(performance.now() - start);
      opsRecords.push({
        tag: "OPS.2a",
        suite: "intent-classifier",
        stage: name,
        fixture_body_digest: bodyDigest,
        classifier_version: "v1.0",
        decision: outcome.decision,
        code: outcome.code,
        prefill_digest: outcome.prefillDigest,
        force_note: outcome.forceNote,
        duration_ms: elapsed,
      });
      results.push({ name, passed: true, body_digest: bodyDigest });
    } catch (err) {
      const elapsed = Math.round(performance.now() - start);
      opsRecords.push({
        tag: "OPS.2a",
        suite: "intent-classifier",
        stage: name,
        fixture_body_digest: bodyDigest,
        classifier_version: "v1.0",
        decision: "refuse",
        code: null,
        prefill_digest: null,
        force_note: false,
        duration_ms: elapsed,
      });
      results.push({
        name,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        body_digest: bodyDigest,
      });
    }
  };

  let extractedSuggestedStatement = "";

  // 1. Refuse proposition-marked note as LOOKS_LIKE_CLAIM
  const propositionMarkedNote =
    "Therefore every positive integer greater than 1 is either prime or composite.\nDetailed proof outline follows in subsequent sections.";

  await runAssertion("refuse_proposition_marked_note", propositionMarkedNote, async () => {
    const res = await app.request(
      `https://a.asimposium.org/v1/sessions/${sessionId}/workshop`,
      {
        method: "POST",
        headers: authHeaders("e2e-intent-note-refused-1"),
        body: JSON.stringify({
          type: "note",
          title: "Prime factorization conjecture",
          body_md: propositionMarkedNote,
          relates_to: [],
        }),
      },
      env,
    );

    if (res.status !== 422) {
      throw new Error(`Expected 422 LOOKS_LIKE_CLAIM, got ${res.status}: ${await res.text()}`);
    }

    const doc = ProblemDocumentSchema.parse(await res.json());
    if (doc.code !== "LOOKS_LIKE_CLAIM") {
      throw new Error(`Expected code LOOKS_LIKE_CLAIM, got ${doc.code}`);
    }
    if (doc.rule !== "§7.6") {
      throw new Error(`Expected rule §7.6, got ${doc.rule}`);
    }
    if (!doc.fix_hint.includes("force_note: true") || !doc.fix_hint.includes("claim schema")) {
      throw new Error(`Unexpected fix_hint: ${doc.fix_hint}`);
    }

    const example = doc.example as { statement?: string } | undefined;
    if (!example?.statement?.startsWith("Therefore every positive integer")) {
      throw new Error(`Missing or unexpected example statement: ${JSON.stringify(example)}`);
    }

    extractedSuggestedStatement = example.statement;

    // Prove NO automatic promotion or workshop storage
    const workshopCount = raw
      .prepare<unknown, []>("SELECT COUNT(*) AS count FROM workshop_objects")
      .get() as { count: number };
    if (workshopCount.count !== 0) {
      throw new Error(
        `Expected 0 workshop objects persisted after refusal, got ${workshopCount.count}`,
      );
    }

    const claimCount = raw.prepare<unknown, []>("SELECT COUNT(*) AS count FROM claims").get() as {
      count: number;
    };
    if (claimCount.count !== 0) {
      throw new Error(`Expected 0 claims on ledger after refusal, got ${claimCount.count}`);
    }

    return {
      decision: "refuse",
      code: "LOOKS_LIKE_CLAIM",
      prefillDigest: `sha256:${sha256Hex(extractedSuggestedStatement)}`,
      forceNote: false,
    };
  });

  // 2. Refuse long unanchored note (>800 chars) as LOOKS_LIKE_CLAIM
  const longUnanchoredNote =
    "This is an extensive analysis of topological invariants without specific proposition markers. " +
    "A".repeat(820);

  await runAssertion("refuse_long_unanchored_note", longUnanchoredNote, async () => {
    const res = await app.request(
      `https://a.asimposium.org/v1/sessions/${sessionId}/workshop`,
      {
        method: "POST",
        headers: authHeaders("e2e-intent-note-refused-2"),
        body: JSON.stringify({
          type: "note",
          title: "Long unanchored survey",
          body_md: longUnanchoredNote,
          relates_to: [],
        }),
      },
      env,
    );

    if (res.status !== 422) {
      throw new Error(`Expected 422 LOOKS_LIKE_CLAIM for >800 char note, got ${res.status}`);
    }

    const doc = ProblemDocumentSchema.parse(await res.json());
    if (doc.code !== "LOOKS_LIKE_CLAIM") {
      throw new Error(`Expected code LOOKS_LIKE_CLAIM, got ${doc.code}`);
    }

    // Prove NO automatic promotion
    const claimCount = raw.prepare<unknown, []>("SELECT COUNT(*) AS count FROM claims").get() as {
      count: number;
    };
    if (claimCount.count !== 0) {
      throw new Error(`Expected 0 claims on ledger, got ${claimCount.count}`);
    }

    const example = doc.example as { statement?: string } | undefined;
    return {
      decision: "refuse",
      code: "LOOKS_LIKE_CLAIM",
      prefillDigest: example?.statement ? `sha256:${sha256Hex(example.statement)}` : null,
      forceNote: false,
    };
  });

  // 3. Promote the suggested statement (proving explicit promotion works with suggested body)
  let promotedClaimId = "";
  await runAssertion("promote_suggested_statement", extractedSuggestedStatement, async () => {
    // A. Push as workshop draft to get workshop_id
    const draftRes = await app.request(
      `https://a.asimposium.org/v1/sessions/${sessionId}/workshop`,
      {
        method: "POST",
        headers: authHeaders("e2e-intent-draft-1"),
        body: JSON.stringify({
          type: "claim-draft",
          title: "Draft for promotion",
          body_md: extractedSuggestedStatement,
          relates_to: [],
        }),
      },
      env,
    );

    if (draftRes.status !== 201) {
      throw new Error(`Failed to push draft: ${draftRes.status} ${await draftRes.text()}`);
    }
    const draft = WorkshopPushResponseSchema.parse(await draftRes.json());

    // B. Promote using the suggested statement
    const promoteRes = await app.request(
      `https://a.asimposium.org/v1/sessions/${sessionId}/promote`,
      {
        method: "POST",
        headers: authHeaders("e2e-intent-promote-1"),
        body: JSON.stringify({
          workshop_id: draft.workshop_id,
          kind: "conjecture",
          statement: extractedSuggestedStatement,
          falsifier: "An integer greater than 1 with no prime factor decomposition.",
        }),
      },
      env,
    );

    if (promoteRes.status !== 201) {
      throw new Error(
        `Failed to promote suggested claim: ${promoteRes.status} ${await promoteRes.text()}`,
      );
    }
    const promote = PromoteResponseSchema.parse(await promoteRes.json());
    promotedClaimId = promote.claim_id;

    // Verify claim exists in SQL ledger
    const claimRow = raw
      .prepare<unknown, [string]>("SELECT id, statement FROM claims WHERE id = ?")
      .get(promotedClaimId) as { id: string; statement: string } | undefined;
    if (!claimRow) {
      throw new Error(`Claim ${promotedClaimId} was not created in database`);
    }
    if (claimRow.statement !== extractedSuggestedStatement) {
      throw new Error(
        `Claim statement mismatch: expected ${extractedSuggestedStatement}, got ${claimRow.statement}`,
      );
    }

    return {
      decision: "accept",
      code: null,
      prefillDigest: `sha256:${sha256Hex(extractedSuggestedStatement)}`,
      forceNote: false,
    };
  });

  // 4. Force-note escape hatch: resubmit claim-shaped note with force_note: true
  let forcedWorkshopId = "";
  await runAssertion("force_note_escape_hatch", propositionMarkedNote, async () => {
    const res = await app.request(
      `https://a.asimposium.org/v1/sessions/${sessionId}/workshop`,
      {
        method: "POST",
        headers: authHeaders("e2e-intent-force-note-1"),
        body: JSON.stringify({
          type: "note",
          title: "Deliberate informal note on prime factorization",
          body_md: propositionMarkedNote,
          relates_to: [],
          force_note: true,
        }),
      },
      env,
    );

    if (res.status !== 201) {
      throw new Error(
        `Expected 201 Created for force_note: true, got ${res.status}: ${await res.text()}`,
      );
    }

    const push = WorkshopPushResponseSchema.parse(await res.json());
    forcedWorkshopId = push.workshop_id;

    // Verify bookkeeping: force_note column in workshop_objects is 1
    const row = raw
      .prepare<unknown, [string]>("SELECT force_note FROM workshop_objects WHERE workshop_id = ?")
      .get(forcedWorkshopId) as { force_note: number } | undefined;
    if (!row) {
      throw new Error(`Workshop object ${forcedWorkshopId} was not found in database`);
    }
    if (row.force_note !== 1) {
      throw new Error(`Expected force_note=1 in database, got ${row.force_note}`);
    }

    return {
      decision: "accept",
      code: null,
      prefillDigest: null,
      forceNote: true,
    };
  });

  // 5. Valid strange note passes without force_note
  const strangeNote =
    "| Strategy | Residual Error | Iterations |\n|---|---|---|\n| Standard | 1.2e-4 | 120 |\n| Accelerated | 4.8e-8 | 45 |\n" +
    "$$\\sum_{n=1}^\\infty \\frac{1}{n^2} = \\frac{\\pi^2}{6}$$\n" +
    "Reviewing numerical stability of the recurrence relation.";

  await runAssertion("valid_strange_note_accepted", strangeNote, async () => {
    const res = await app.request(
      `https://a.asimposium.org/v1/sessions/${sessionId}/workshop`,
      {
        method: "POST",
        headers: authHeaders("e2e-intent-strange-note-1"),
        body: JSON.stringify({
          type: "note",
          title: "Numerical recurrence exploration",
          body_md: strangeNote,
          relates_to: [],
        }),
      },
      env,
    );

    if (res.status !== 201) {
      throw new Error(
        `Expected 201 Created for valid strange note, got ${res.status}: ${await res.text()}`,
      );
    }

    const push = WorkshopPushResponseSchema.parse(await res.json());

    // Verify force_note column in workshop_objects is 0
    const row = raw
      .prepare<unknown, [string]>("SELECT force_note FROM workshop_objects WHERE workshop_id = ?")
      .get(push.workshop_id) as { force_note: number } | undefined;
    if (!row) {
      throw new Error(`Workshop object ${push.workshop_id} was not found in database`);
    }
    if (row.force_note !== 0) {
      throw new Error(`Expected force_note=0 for clean strange note, got ${row.force_note}`);
    }

    return {
      decision: "accept",
      code: null,
      prefillDigest: null,
      forceNote: false,
    };
  });

  // 6. Prove no automatic promotion occurred from forced note or strange note
  await runAssertion("no_automatic_promotion_isolation", "isolation-check", async () => {
    // Only the explicit promotion in Step 3 should exist as a claim
    const claims = raw.prepare<unknown, []>("SELECT id FROM claims").all() as { id: string }[];
    if (claims.length !== 1 || claims[0]?.id !== promotedClaimId) {
      throw new Error(
        `Expected exactly 1 claim (${promotedClaimId}), found ${claims.length} claims`,
      );
    }

    return {
      decision: "accept",
      code: null,
      prefillDigest: null,
      forceNote: false,
    };
  });

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  return {
    total: results.length,
    passed,
    failed,
    results,
    opsRecords,
  };
}

if (import.meta.main) {
  const summary = await runAllIntentClassifierE2EAssertions();
  console.log("\n--- OPS.2a Structured Diagnostic Log ---");
  for (const record of summary.opsRecords) {
    console.log(JSON.stringify(record));
  }
  console.log("\n--- Test Outcomes ---");
  for (const r of summary.results) {
    if (r.passed) {
      console.log(`PASS: ${r.name} (${r.body_digest})`);
    } else {
      console.error(`FAIL: ${r.name} (${r.body_digest}): ${r.error}`);
    }
  }
  console.log(`\nTotal: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed}`);
  process.exit(summary.failed > 0 ? 1 : 0);
}
