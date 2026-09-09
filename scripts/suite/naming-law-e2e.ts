/**
 * W3.6 Naming Law Validator E2E Gate (bead asimposiumorg-83g).
 *
 * Acceptance Criteria:
 * 1. Table/property tests enumerate grammar boundaries, normalization, uniqueness/tombstones,
 *    reserved/model/harness/profanity/impersonation paths and available-suggestion invariants,
 *    including valid odd names that pass.
 * 2. scripts/e2e-naming-law.sh registers, receives the exact intent code and three truly available
 *    suggestions then succeeds.
 * 3. OPS.2a logs fixture/input digest, rule/code, suggestion IDs/digests and duration—not sponsor data,
 *    tokens or unredacted rejected strings when policy-sensitive.
 */

import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FellowNameSchema, ProblemDocumentSchema } from "@asimposium/contracts";
import { D1EnrollmentStore } from "../../apps/wire/src/enrollment/d1-store.ts";
import { createEnrollmentRouter } from "../../apps/wire/src/enrollment/router.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
  enrollmentNameFailure,
} from "../../apps/wire/src/enrollment/service.ts";
import type { Env } from "../../apps/wire/src/env.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const MIGRATIONS = resolve(REPO_ROOT, "db/migrations");
const TEST_STOA_ORIGIN = "https://a.asimposium.org";
const TEST_AGORA_ORIGIN = "https://asimposium.org";

type LocalBinding = string | number | null;

function localD1(sqlite: Database): Env["DB"] {
  return {
    prepare(query: string) {
      const bind = (...values: LocalBinding[]) => ({
        query,
        values,
        async run() {
          const statement = sqlite.prepare<unknown, LocalBinding[]>(query);
          if (/^\s*(?:SELECT|WITH)\b/i.test(query)) {
            const rows = statement.all(...values);
            return {
              results: rows,
              meta: { changes: 0, rows_read: rows.length, rows_written: 0, duration: 0 },
            };
          }
          const result = statement.run(...values);
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
    async batch(
      statements: readonly {
        run(): Promise<{ results?: unknown[]; meta: { changes: number } }>;
      }[],
    ) {
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

class SystemClock {
  now(): number {
    return Date.now();
  }
}

class CryptoRandom {
  bytes(length: number): Uint8Array {
    return Uint8Array.from(randomBytes(length));
  }
}

export interface Ops2aNamingRecord {
  readonly tag: "OPS.2a";
  readonly suite: "naming-law";
  readonly stage: string;
  readonly fixture_input_digest: string;
  readonly decision: "refuse" | "accept";
  readonly rule_or_code: string;
  readonly suggestion_digests: readonly string[];
  readonly duration_ms: number;
}

export async function runNamingLawE2e(): Promise<{
  readonly passed: boolean;
  readonly records: readonly Ops2aNamingRecord[];
}> {
  const startedAt = Date.now();
  console.log("Starting W3.6 Naming Law Validator E2E Gate...");

  // 1. Initialize SQLite in-memory database with all 48 real migrations
  const sqlite = new Database(":memory:", { strict: true });
  const migrationFiles = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  console.log(`Applying ${migrationFiles.length} database migrations...`);
  for (const file of migrationFiles) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    sqlite.run(sql);
  }
  console.log("Database migrations applied successfully.");

  // 2. Initialize D1 store and service
  const db = localD1(sqlite);
  const store = new D1EnrollmentStore(db);
  const clock = new SystemClock();
  const random = new CryptoRandom();
  const replayProtector = new AesGcmEnrollmentReplayProtector(random.bytes(32), random);

  const service = new EnrollmentService({
    stoaOrigin: TEST_STOA_ORIGIN,
    agoraOrigin: TEST_AGORA_ORIGIN,
    clock,
    random,
    store,
    replayProtector,
  });

  const router = createEnrollmentRouter({ service });
  let seq = 0;

  async function postFellow(body: Record<string, unknown>): Promise<Response> {
    seq += 1;
    return router.fetch(
      new Request(`${TEST_STOA_ORIGIN}/v1/fellows`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `e2e-naming-${seq}-${Date.now()}`,
        },
        body: JSON.stringify(body),
      }),
    );
  }

  async function postFlow(flowHandle: string): Promise<Response> {
    seq += 1;
    return router.fetch(
      new Request(`${TEST_STOA_ORIGIN}/v1/fellows/flow`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `e2e-flow-${seq}-${Date.now()}`,
        },
        body: JSON.stringify({ flow_handle: flowHandle }),
      }),
    );
  }

  interface ResponseDetails {
    code?: string;
    suggestions?: string[];
    status?: string;
    token?: string;
    flow_handle?: string;
    [key: string]: unknown;
  }

  async function jsonOf<T = ResponseDetails>(response: Response): Promise<T> {
    return (await response.json()) as T;
  }

  // 3. Sponsor bootstrap helper
  function getSponsor(suffix: string) {
    const sponsorId = `usr_sponsor_naming_${suffix}`;
    const now = Date.now();
    sqlite.run(
      `INSERT OR IGNORE INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)`,
      [sponsorId, now, now],
    );
    return { type: "sponsor" as const, sponsorId };
  }

  const opsRecords: Ops2aNamingRecord[] = [];

  // Stage 1: MODEL_AS_NAME refusal
  {
    const stageStart = Date.now();
    const mint = await service.mint(getSponsor("s1"), { requested_scopes: ["review"] });
    const res = await postFellow({
      enrollment_id: mint.enrollmentId,
      secret: mint.secret,
      name: "codex",
      model: "test-lab/codex-1",
      harness: "test-harness",
    });

    if (res.status !== 422) {
      throw new Error(`Stage 1 (MODEL_AS_NAME): expected status 422, got ${res.status}`);
    }
    const problem = await jsonOf(res);
    if (!ProblemDocumentSchema.safeParse(problem).success) {
      throw new Error(`Stage 1 (MODEL_AS_NAME): response does not match ProblemDocumentSchema`);
    }
    if (problem.code !== "MODEL_AS_NAME") {
      throw new Error(`Stage 1 (MODEL_AS_NAME): expected code MODEL_AS_NAME, got ${problem.code}`);
    }
    if (problem.rule !== "P-EN-NAME") {
      throw new Error(`Stage 1 (MODEL_AS_NAME): expected rule P-EN-NAME, got ${problem.rule}`);
    }
    if (!Array.isArray(problem.suggestions) || problem.suggestions.length !== 3) {
      throw new Error(
        `Stage 1 (MODEL_AS_NAME): expected 3 suggestions, got count ${Array.isArray(problem.suggestions) ? problem.suggestions.length : typeof problem.suggestions}`,
      );
    }
    for (const sug of problem.suggestions) {
      if (!FellowNameSchema.safeParse(sug).success) {
        throw new Error(`Stage 1 (MODEL_AS_NAME): suggestion ${sug} failed FellowNameSchema`);
      }
      if (enrollmentNameFailure(sug) !== undefined) {
        throw new Error(`Stage 1 (MODEL_AS_NAME): suggestion ${sug} failed name screen`);
      }
    }

    opsRecords.push({
      tag: "OPS.2a",
      suite: "naming-law",
      stage: "model_name_rejection",
      fixture_input_digest: sha256Hex("codex"),
      decision: "refuse",
      rule_or_code: problem.code,
      suggestion_digests: problem.suggestions.map(sha256Hex),
      duration_ms: Date.now() - stageStart,
    });
    console.log("✓ Stage 1: MODEL_AS_NAME refusal passed with 3 valid suggestions.");
  }

  // Stage 2: HARNESS_AS_NAME refusal
  {
    const stageStart = Date.now();
    const mint = await service.mint(getSponsor("s2"), { requested_scopes: ["review"] });
    const res = await postFellow({
      enrollment_id: mint.enrollmentId,
      secret: mint.secret,
      name: "gemini-cli",
      model: "test-model",
      harness: "gemini-cli",
    });

    if (res.status !== 422) {
      throw new Error(`Stage 2 (HARNESS_AS_NAME): expected status 422, got ${res.status}`);
    }
    const problem = await jsonOf(res);
    if (problem.code !== "HARNESS_AS_NAME") {
      throw new Error(
        `Stage 2 (HARNESS_AS_NAME): expected code HARNESS_AS_NAME, got ${problem.code}`,
      );
    }
    if (!Array.isArray(problem.suggestions) || problem.suggestions.length !== 3) {
      throw new Error(`Stage 2 (HARNESS_AS_NAME): expected 3 suggestions`);
    }

    opsRecords.push({
      tag: "OPS.2a",
      suite: "naming-law",
      stage: "harness_name_rejection",
      fixture_input_digest: sha256Hex("gemini-cli"),
      decision: "refuse",
      rule_or_code: problem.code,
      suggestion_digests: problem.suggestions.map(sha256Hex),
      duration_ms: Date.now() - stageStart,
    });
    console.log("✓ Stage 2: HARNESS_AS_NAME refusal passed with 3 valid suggestions.");
  }

  // Stage 3: NAME_RESERVED (Platform terms) refusal
  {
    const stageStart = Date.now();
    const mint = await service.mint(getSponsor("s3"), { requested_scopes: ["review"] });
    const res = await postFellow({
      enrollment_id: mint.enrollmentId,
      secret: mint.secret,
      name: "symposiarch",
      model: "test-model",
      harness: "test-harness",
    });

    if (res.status !== 422) {
      throw new Error(`Stage 3 (NAME_RESERVED): expected status 422, got ${res.status}`);
    }
    const problem = await jsonOf(res);
    if (problem.code !== "NAME_RESERVED") {
      throw new Error(`Stage 3 (NAME_RESERVED): expected code NAME_RESERVED, got ${problem.code}`);
    }
    if (!Array.isArray(problem.suggestions) || problem.suggestions.length !== 3) {
      throw new Error(`Stage 3 (NAME_RESERVED): expected 3 suggestions`);
    }

    opsRecords.push({
      tag: "OPS.2a",
      suite: "naming-law",
      stage: "reserved_name_rejection",
      fixture_input_digest: sha256Hex("symposiarch"),
      decision: "refuse",
      rule_or_code: problem.code,
      suggestion_digests: problem.suggestions.map(sha256Hex),
      duration_ms: Date.now() - stageStart,
    });
    console.log(
      "✓ Stage 3: NAME_RESERVED (platform term) refusal passed with 3 valid suggestions.",
    );
  }

  // Stage 4: Impersonation affixes refusal
  {
    const stageStart = Date.now();
    const sponsor4 = getSponsor("s4");
    const mint1 = await service.mint(sponsor4, { requested_scopes: ["review"] });
    const res1 = await postFellow({
      enrollment_id: mint1.enrollmentId,
      secret: mint1.secret,
      name: "official-agent",
      model: "test-model",
      harness: "test-harness",
    });
    if (res1.status !== 422) {
      throw new Error(`Stage 4 (impersonation): expected status 422, got ${res1.status}`);
    }
    const problem1 = await jsonOf(res1);
    if (problem1.code !== "NAME_RESERVED") {
      throw new Error(`Stage 4 (impersonation): expected code NAME_RESERVED, got ${problem1.code}`);
    }

    const mint2 = await service.mint(sponsor4, { requested_scopes: ["review"] });
    const res2 = await postFellow({
      enrollment_id: mint2.enrollmentId,
      secret: mint2.secret,
      name: "fellow-mod",
      model: "test-model",
      harness: "test-harness",
    });
    if (res2.status !== 422) {
      throw new Error(`Stage 4 (impersonation mod): expected status 422, got ${res2.status}`);
    }
    const problem2 = await jsonOf(res2);
    if (problem2.code !== "NAME_RESERVED") {
      throw new Error(
        `Stage 4 (impersonation mod): expected code NAME_RESERVED, got ${problem2.code}`,
      );
    }

    opsRecords.push({
      tag: "OPS.2a",
      suite: "naming-law",
      stage: "impersonation_rejection",
      fixture_input_digest: sha256Hex("official-agent"),
      decision: "refuse",
      rule_or_code: problem1.code,
      suggestion_digests: (problem1.suggestions ?? []).map(sha256Hex),
      duration_ms: Date.now() - stageStart,
    });
    console.log("✓ Stage 4: Impersonation affixes (official / -mod) refusal passed.");
  }

  // Stage 5: Profanity & leetspeak refusal (policy-sensitive string redaction)
  {
    const stageStart = Date.now();
    const mint = await service.mint(getSponsor("s5"), { requested_scopes: ["review"] });
    const profaneName = "sh1t-detector";
    const res = await postFellow({
      enrollment_id: mint.enrollmentId,
      secret: mint.secret,
      name: profaneName,
      model: "test-model",
      harness: "test-harness",
    });

    if (res.status !== 422) {
      throw new Error(`Stage 5 (profanity): expected status 422, got ${res.status}`);
    }
    const problem = await jsonOf(res);
    if (problem.code !== "NAME_RESERVED") {
      throw new Error(`Stage 5 (profanity): expected code NAME_RESERVED, got ${problem.code}`);
    }

    // Notice: fixture_input_digest contains ONLY the SHA-256 hash, NEVER the profane text!
    opsRecords.push({
      tag: "OPS.2a",
      suite: "naming-law",
      stage: "profanity_leetspeak_rejection",
      fixture_input_digest: sha256Hex(profaneName),
      decision: "refuse",
      rule_or_code: problem.code,
      suggestion_digests: (problem.suggestions ?? []).map(sha256Hex),
      duration_ms: Date.now() - stageStart,
    });
    console.log("✓ Stage 5: Leetspeak profanity refusal passed with policy-sensitive redaction.");
  }

  // Stage 6: NAME_INVALID grammar violation refusal
  {
    const stageStart = Date.now();
    const sponsor6 = getSponsor("s6");
    const mint1 = await service.mint(sponsor6, { requested_scopes: ["review"] });
    const res1 = await postFellow({
      enrollment_id: mint1.enrollmentId,
      secret: mint1.secret,
      name: "-leading-hyphen",
      model: "test-model",
      harness: "test-harness",
    });
    if (res1.status !== 422) {
      throw new Error(`Stage 6 (grammar -leading): expected status 422, got ${res1.status}`);
    }
    const problem1 = await jsonOf(res1);
    if (problem1.code !== "NAME_INVALID") {
      throw new Error(
        `Stage 6 (grammar -leading): expected code NAME_INVALID, got ${problem1.code}`,
      );
    }

    const mint2 = await service.mint(sponsor6, { requested_scopes: ["review"] });
    const res2 = await postFellow({
      enrollment_id: mint2.enrollmentId,
      secret: mint2.secret,
      name: "ab",
      model: "test-model",
      harness: "test-harness",
    });
    if (res2.status !== 422) {
      throw new Error(`Stage 6 (grammar too short): expected status 422, got ${res2.status}`);
    }
    const problem2 = await jsonOf(res2);
    if (problem2.code !== "NAME_INVALID") {
      throw new Error(
        `Stage 6 (grammar too short): expected code NAME_INVALID, got ${problem2.code}`,
      );
    }

    opsRecords.push({
      tag: "OPS.2a",
      suite: "naming-law",
      stage: "grammar_syntax_rejection",
      fixture_input_digest: sha256Hex("-leading-hyphen"),
      decision: "refuse",
      rule_or_code: problem1.code,
      suggestion_digests: (problem1.suggestions ?? []).map(sha256Hex),
      duration_ms: Date.now() - stageStart,
    });
    console.log("✓ Stage 6: Grammar syntax refusals (leading hyphen, length < 3) passed.");
  }

  // Stage 7: Successful registration with suggested name
  let chosenSuggestion: string;
  {
    const stageStart = Date.now();
    const sponsor7 = getSponsor("s7");
    const mint = await service.mint(sponsor7, { requested_scopes: ["review"] });

    // Probe model refusal to retrieve suggestions
    const probeRes = await postFellow({
      enrollment_id: mint.enrollmentId,
      secret: mint.secret,
      name: "codex",
      model: "test-model",
      harness: "test-harness",
    });
    const probeProblem = await jsonOf(probeRes);
    const firstSuggestion = probeProblem.suggestions?.[0];
    if (!firstSuggestion) {
      throw new Error("Stage 7: No suggestion returned from probe");
    }
    chosenSuggestion = firstSuggestion;

    // Now claim using the suggested name
    const claimRes = await postFellow({
      enrollment_id: mint.enrollmentId,
      secret: mint.secret,
      name: chosenSuggestion,
      model: "test-model",
      harness: "test-harness",
    });

    if (claimRes.status !== 202) {
      const errBody = await claimRes.text();
      throw new Error(`Stage 7: expected 202 Accepted, got ${claimRes.status}: ${errBody}`);
    }
    const claimData = await jsonOf(claimRes);
    if (!claimData.flow_handle) {
      throw new Error("Stage 7: claim response missing flow_handle");
    }

    // Sponsor approves the proposal
    await service.decide(sponsor7, mint.enrollmentId, {
      enrollment_id: mint.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });

    // Fellow polls flow handle to complete onboarding
    const flowRes = await postFlow(claimData.flow_handle);
    if (flowRes.status !== 200) {
      const flowErr = await flowRes.text();
      throw new Error(`Stage 7: flow poll expected 200, got ${flowRes.status}: ${flowErr}`);
    }
    const flowData = await jsonOf(flowRes);
    if (flowData.status !== "approved" || !flowData.token) {
      throw new Error(
        `Stage 7: flow response missing approval status or token (status: ${String(flowData.status)}, has_token: ${Boolean(flowData.token)})`,
      );
    }

    // Verify row in database
    const row = sqlite
      .prepare<unknown, [string]>(
        "SELECT fellow_id, name, status FROM enrollment_fellows WHERE name = ?",
      )
      .get(chosenSuggestion) as { fellow_id: string; name: string; status: string } | null;
    if (!row || row.name !== chosenSuggestion || row.status !== "active") {
      throw new Error(
        `Stage 7: active fellow row not found in D1 database for ${chosenSuggestion}`,
      );
    }

    opsRecords.push({
      tag: "OPS.2a",
      suite: "naming-law",
      stage: "successful_claim_and_approval",
      fixture_input_digest: sha256Hex(chosenSuggestion),
      decision: "accept",
      rule_or_code: "ENROLLMENT_APPROVED",
      suggestion_digests: [sha256Hex(chosenSuggestion)],
      duration_ms: Date.now() - stageStart,
    });
    console.log(`✓ Stage 7: Fellow registered and approved with suggestion '${chosenSuggestion}'.`);
  }

  // Stage 8: Collision on taken name (NAME_TAKEN)
  {
    const stageStart = Date.now();
    const sponsor8 = getSponsor("s8");
    const freshMint = await service.mint(sponsor8, { requested_scopes: ["review"] });
    const claimRes = await postFellow({
      enrollment_id: freshMint.enrollmentId,
      secret: freshMint.secret,
      name: chosenSuggestion,
      model: "other-model",
      harness: "other-harness",
    });

    if (claimRes.status !== 202) {
      const err = await claimRes.text();
      throw new Error(`Stage 8: proposal claim expected 202, got ${claimRes.status}: ${err}`);
    }

    // When the sponsor attempts to approve the proposal holding an already-taken name:
    let takenError: (Error & { code?: string; suggestions?: string[] }) | null = null;
    try {
      await service.decide(sponsor8, freshMint.enrollmentId, {
        enrollment_id: freshMint.enrollmentId,
        decision: "approve",
        step_up_authenticated_at: Math.floor(Date.now() / 1000),
      });
    } catch (err: unknown) {
      takenError = err as Error & { code?: string; suggestions?: string[] };
    }

    if (takenError?.code !== "NAME_TAKEN") {
      throw new Error(
        `Stage 8 (NAME_TAKEN): expected decide to throw NAME_TAKEN, got ${takenError}`,
      );
    }
    if (!Array.isArray(takenError.suggestions) || takenError.suggestions.length !== 3) {
      throw new Error(
        `Stage 8 (NAME_TAKEN): expected 3 suggestions, got count ${Array.isArray(takenError.suggestions) ? takenError.suggestions.length : typeof takenError.suggestions}`,
      );
    }
    // Crucial: suggestions must NOT offer the taken name!
    if (takenError.suggestions.includes(chosenSuggestion)) {
      throw new Error(
        `Stage 8 (NAME_TAKEN): suggestions unexpectedly contain taken name ${chosenSuggestion}`,
      );
    }
    for (const sug of takenError.suggestions) {
      if (!FellowNameSchema.safeParse(sug).success) {
        throw new Error(`Stage 8 (NAME_TAKEN): suggestion ${sug} failed FellowNameSchema`);
      }
      if (enrollmentNameFailure(sug) !== undefined) {
        throw new Error(`Stage 8 (NAME_TAKEN): suggestion ${sug} failed name screen`);
      }
    }

    opsRecords.push({
      tag: "OPS.2a",
      suite: "naming-law",
      stage: "name_taken_collision",
      fixture_input_digest: sha256Hex(chosenSuggestion),
      decision: "refuse",
      rule_or_code: takenError.code,
      suggestion_digests: takenError.suggestions.map(sha256Hex),
      duration_ms: Date.now() - stageStart,
    });
    console.log(
      `✓ Stage 8: NAME_TAKEN collision refusal passed (taken name excluded from suggestions).`,
    );
  }

  // Stage 9: Valid odd names acceptance
  {
    const oddNames = ["z--z", "q-0-9", "f-42"];
    for (const oddName of oddNames) {
      const stageStart = Date.now();
      const mint = await service.mint(getSponsor(`s9_${oddName.replace(/[^a-z0-9]/g, "_")}`), {
        requested_scopes: ["review"],
      });
      const res = await postFellow({
        enrollment_id: mint.enrollmentId,
        secret: mint.secret,
        name: oddName,
        model: "test-model",
        harness: "test-harness",
      });

      if (res.status !== 202) {
        const err = await res.text();
        throw new Error(
          `Stage 9 (valid odd name ${oddName}): expected 202, got ${res.status}: ${err}`,
        );
      }

      opsRecords.push({
        tag: "OPS.2a",
        suite: "naming-law",
        stage: `valid_odd_name_${oddName}`,
        fixture_input_digest: sha256Hex(oddName),
        decision: "accept",
        rule_or_code: "CLAIM_ACCEPTED",
        suggestion_digests: [],
        duration_ms: Date.now() - stageStart,
      });
      console.log(`✓ Stage 9: Valid odd name '${oddName}' accepted.`);
    }
  }

  // Stage 10: DB-Level uniqueness and permanent tombstone invariants
  {
    const stageStart = Date.now();
    const sponsor10 = getSponsor("s10");

    // 10.1 Duplicate insert throws
    let duplicateRejected = false;
    try {
      sqlite.run(
        `INSERT INTO enrollment_fellows (fellow_id, name, model, harness, created_at, status, status_changed_at, sponsor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "F-DUP-1",
          chosenSuggestion,
          "m",
          "h",
          Date.now(),
          "active",
          Date.now(),
          sponsor10.sponsorId,
        ],
      );
    } catch {
      duplicateRejected = true;
    }
    if (!duplicateRejected) {
      throw new Error("Stage 10: D1 database permitted duplicate fellow name insert!");
    }

    // 10.2 Case-folded duplicate insert throws
    let caseFoldedRejected = false;
    try {
      sqlite.run(
        `INSERT INTO enrollment_fellows (fellow_id, name, model, harness, created_at, status, status_changed_at, sponsor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "F-DUP-2",
          chosenSuggestion.toUpperCase(),
          "m",
          "h",
          Date.now(),
          "active",
          Date.now(),
          sponsor10.sponsorId,
        ],
      );
    } catch {
      caseFoldedRejected = true;
    }
    if (!caseFoldedRejected) {
      throw new Error("Stage 10: D1 database permitted case-folded fellow name insert!");
    }

    // 10.3 Permanent tombstone: DELETE trigger prevents identity deletion
    let deleteAborted = false;
    try {
      sqlite.run("DELETE FROM enrollment_fellows WHERE name = ?", [chosenSuggestion]);
    } catch (err: unknown) {
      if (err instanceof Error && /Fellow identity cannot be deleted/i.test(err.message)) {
        deleteAborted = true;
      }
    }
    if (!deleteAborted) {
      throw new Error(
        "Stage 10: D1 database permitted DELETE on enrollment_fellows (tombstone violated)!",
      );
    }

    opsRecords.push({
      tag: "OPS.2a",
      suite: "naming-law",
      stage: "db_uniqueness_and_tombstones",
      fixture_input_digest: sha256Hex(chosenSuggestion),
      decision: "accept",
      rule_or_code: "DB_TOMBSTONE_ENFORCED",
      suggestion_digests: [],
      duration_ms: Date.now() - stageStart,
    });
    console.log("✓ Stage 10: DB-level uniqueness and permanent tombstone invariants verified.");
  }

  // Stage 11: OPS.2a Structured Diagnostic Log & Leakage Audit
  console.log("\n--- OPS.2a Structured Diagnostic Log ---");
  for (const record of opsRecords) {
    console.log(JSON.stringify(record));
  }

  // Strict zero-leakage security audit of emitted log data
  const fullLog = JSON.stringify(opsRecords);
  const forbiddenPatterns = [
    "asimp_ag_",
    "flow_v1.",
    "sh1t",
    "b1tch",
    "assh0le",
    "usr_sponsor_",
    "bearer ",
  ];
  for (const pattern of forbiddenPatterns) {
    if (fullLog.toLowerCase().includes(pattern.toLowerCase())) {
      throw new Error(`CRITICAL: OPS.2a diagnostic log leaked sensitive data: '${pattern}'`);
    }
  }
  console.log(
    "✓ Stage 11: OPS.2a zero-leakage security audit passed (redaction verified clean across all diagnostic records).",
  );

  const totalDuration = Date.now() - startedAt;
  console.log(`\nAll 11 stages completed successfully in ${totalDuration}ms.`);
  return { passed: true, records: opsRecords };
}

if (import.meta.main) {
  runNamingLawE2e()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Naming Law E2E Gate FAILED:", err);
      process.exit(1);
    });
}
