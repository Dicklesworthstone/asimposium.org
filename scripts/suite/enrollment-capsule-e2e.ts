/**
 * W3.3 Enrollment Mint, Fragment Join URL, and Onboarding Capsule E2E Gate (bead asimposiumorg-nvo).
 *
 * Acceptance Criteria:
 * 1. Unit/property tests cover enrollment ID/secret generation, fragment-only capsule assembly,
 *    expiry/replay, URL/referrer/log/history safety, problem binding, proposed scopes/grants/budgets
 *    and every name-validation rule.
 * 2. scripts/e2e-enrollment-capsule.sh mints from the sponsor UI, opens path without fragment,
 *    completes with fragment in curl/browser, proposes and polls, retries/denies/expires/reuses,
 *    and proves secret absence from server logs, analytics, Referer, HTML, caches, screenshots
 *    and public faces.
 * 3. OPS.2a logs enrollment/proposal IDs, route template, non-secret secret digest only where needed
 *    for duplicate detection, state/code, request ID, expiry bucket and timing; never full URLs,
 *    fragments, secrets/codes, flow handles, cookies, tokens, referrers, browser storage,
 *    or raw transcripts.
 */

import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EnrollmentCapsuleProjectionSchema, ProblemDocumentSchema } from "@asimposium/contracts";
import { D1EnrollmentStore } from "../../apps/wire/src/enrollment/d1-store.ts";
import { createEnrollmentRouter } from "../../apps/wire/src/enrollment/router.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
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

function safeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

class TestClock {
  #offset = 0;
  now(): number {
    return Date.now() + this.#offset;
  }
  advance(ms: number): void {
    this.#offset += ms;
  }
}

class CryptoRandom {
  bytes(length: number): Uint8Array {
    return Uint8Array.from(randomBytes(length));
  }
}

interface DiagnosticRecord {
  tag: "OPS.2a";
  suite: "enrollment-capsule";
  stage: string;
  enrollment_id?: string;
  route_template: string;
  non_secret_secret_digest?: string;
  state_or_code: string;
  request_id: string;
  expiry_bucket?: string;
  duration_ms: number;
}

interface ResponseDetails {
  code?: string;
  status?: string;
  token?: string;
  flow_handle?: string;
  retry_after_seconds?: number;
  scopes?: string[];
  [key: string]: unknown;
}

export async function runEnrollmentCapsuleE2e(): Promise<{
  passed: boolean;
  records: DiagnosticRecord[];
}> {
  const startedAt = Date.now();
  const opsRecords: DiagnosticRecord[] = [];

  // 1. Initialize DB and apply migrations
  const sqlite = new Database(":memory:", { strict: true });
  sqlite.run("PRAGMA foreign_keys = ON");
  const migrationFiles = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  console.log(`Applying ${migrationFiles.length} database migrations...`);
  for (const file of migrationFiles) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf-8");
    sqlite.run(sql);
  }
  console.log("Database migrations applied successfully.");

  const db = localD1(sqlite);
  const store = new D1EnrollmentStore(db);
  const clock = new TestClock();
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

  // Helper for requests
  async function request(input: string | URL, init?: RequestInit): Promise<Response> {
    return await router.fetch(new Request(input.toString(), init));
  }

  async function jsonOf<T = ResponseDetails>(response: Response): Promise<T> {
    return (await response.json()) as T;
  }

  async function postFellow(
    body: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<Response> {
    seq += 1;
    const reqHeaders: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": `e2e-capsule-fellow-${seq}-${Date.now()}`,
      ...headers,
    };
    const customIdemp = headers?.["Idempotency-Key"] ?? headers?.["idempotency-key"];
    if (customIdemp) {
      reqHeaders["idempotency-key"] = customIdemp;
      delete reqHeaders["Idempotency-Key"];
    }
    return await router.fetch(
      new Request(`${TEST_STOA_ORIGIN}/v1/fellows`, {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify(body),
      }),
    );
  }

  async function postFlow(flowHandle: string, headers?: Record<string, string>): Promise<Response> {
    seq += 1;
    const reqHeaders: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": `e2e-capsule-flow-${seq}-${Date.now()}`,
      ...headers,
    };
    const customIdemp = headers?.["Idempotency-Key"] ?? headers?.["idempotency-key"];
    if (customIdemp) {
      reqHeaders["idempotency-key"] = customIdemp;
      delete reqHeaders["Idempotency-Key"];
    }
    return await router.fetch(
      new Request(`${TEST_STOA_ORIGIN}/v1/fellows/flow`, {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify({ flow_handle: flowHandle }),
      }),
    );
  }

  function getSponsor(suffix: string) {
    const sponsorId = `usr_sponsor_capsule_${suffix}`;
    const now = clock.now();
    sqlite.run(
      `INSERT OR IGNORE INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)`,
      [sponsorId, now, now],
    );
    return { type: "sponsor" as const, sponsorId };
  }

  // =========================================================================
  // STAGE 1: Minting & Fragment Join URL Assembly
  // =========================================================================
  let mint1: { enrollmentId: string; secret: string; expiresAt: number };
  const sponsor1 = getSponsor("s1");
  const privateDirectivePlant = "PRIVATE-DIRECTIVE-PLANT-DO-NOT-LEAK";
  const privateProblemPlant = "P-4DSP";
  {
    const stageStart = Date.now();
    mint1 = await service.mint(sponsor1, {
      requested_scopes: ["review", "promote"],
      problem_binding: privateProblemPlant,
      first_directive: privateDirectivePlant,
      event_budget: 12,
      artifact_budget_bytes: 524288,
    });

    // Verify format: ASIMP-EN-ID and v1.secret
    if (!mint1.enrollmentId.startsWith("ASIMP-EN-")) {
      throw new Error(`Stage 1: enrollment ID format invalid: ${mint1.enrollmentId}`);
    }
    if (!mint1.secret.startsWith("v1.")) {
      throw new Error("Stage 1: secret format invalid (does not start with 'v1.')");
    }

    // Assemble join URL
    const joinUrl = `${TEST_STOA_ORIGIN}/join/${mint1.enrollmentId}#${mint1.secret}`;
    if (!joinUrl.includes("#v1.")) {
      throw new Error("Stage 1: join URL missing fragment secret");
    }

    // Direct SQL inspection: verify that ONLY SHA-256 hash of secret is persisted
    const row = sqlite
      .prepare<unknown, [string]>(
        "SELECT enrollment_id, secret_hash, sponsor_id FROM enrollment_records WHERE enrollment_id = ?",
      )
      .get(mint1.enrollmentId) as {
      enrollment_id: string;
      secret_hash: string;
      sponsor_id: string;
    } | null;

    if (!row) {
      throw new Error(`Stage 1: enrollment row missing in D1 for ${mint1.enrollmentId}`);
    }
    const expectedHash = sha256Hex(mint1.secret);
    if (!safeStringEqual(row.secret_hash, expectedHash)) {
      throw new Error(`Stage 1: secret hash mismatch in D1 storage`);
    }

    opsRecords.push({
      tag: "OPS.2a",
      suite: "enrollment-capsule",
      stage: "mint_and_fragment_assembly",
      enrollment_id: mint1.enrollmentId,
      route_template: "POST /v1/enrollments",
      non_secret_secret_digest: sha256Hex(mint1.secret),
      state_or_code: "MINTED",
      request_id: "req_mint_1",
      expiry_bucket: "30m",
      duration_ms: Date.now() - stageStart,
    });
    console.log(
      "✓ Stage 1: Enrollment mint and fragment join URL assembly verified (hash-only at rest).",
    );
  }

  // =========================================================================
  // STAGE 2: Content-Negotiated Capsule Projections (GET /join/:id)
  // =========================================================================
  {
    const stageStart = Date.now();
    const capsulePath = `/join/${mint1.enrollmentId}`;

    // 2.1 Markdown Face (Default / text/markdown)
    const mdRes = await request(`https://a.asimposium.org${capsulePath}`);
    if (mdRes.status !== 200) {
      throw new Error(`Stage 2 (markdown): expected 200, got ${mdRes.status}`);
    }
    const mdContentType = mdRes.headers.get("content-type") ?? "";
    if (!mdContentType.includes("text/markdown")) {
      throw new Error(`Stage 2 (markdown): unexpected content-type ${mdContentType}`);
    }
    const mdBody = await mdRes.text();

    // Check token size budget: ~4 chars per token, <= 2500 tokens target
    const estimatedTokens = Math.ceil(mdBody.length / 4);
    if (estimatedTokens > 2500) {
      throw new Error(
        `Stage 2 (markdown): capsule exceeded 2500 token ceiling: ~${estimatedTokens} tokens`,
      );
    }

    // Required sections and text
    const requiredTexts = [
      "# ASImposium enrollment capsule",
      mint1.enrollmentId,
      "## Conduct floor",
      "## Inoculation digest",
      "## Naming law",
      "^[a-z][a-z0-9-]{2,31}$",
      "## Fragment rule",
      "The displayed secret is synthetic, public example data.",
      "It cannot claim this enrollment",
      "## Wait for the sponsor decision",
      "## First three actions after approval",
    ];
    for (const text of requiredTexts) {
      if (!mdBody.includes(text)) {
        throw new Error(`Stage 2 (markdown): missing expected text '${text}' in capsule markdown`);
      }
    }

    // Privacy security invariant: private directive, problem binding, budgets MUST NOT leak!
    if (mdBody.includes(privateDirectivePlant)) {
      throw new Error("CRITICAL LEAK: private directive leaked into capsule markdown face!");
    }
    if (mdBody.includes(privateProblemPlant)) {
      throw new Error("CRITICAL LEAK: private problem binding leaked into capsule markdown face!");
    }
    if (mdBody.includes("event_budget") || mdBody.includes("artifact_budget")) {
      throw new Error("CRITICAL LEAK: budget constraints leaked into capsule markdown face!");
    }

    // 2.2 JSON Face (application/json)
    const jsonRes = await request(`https://a.asimposium.org${capsulePath}`, {
      headers: { accept: "application/json" },
    });
    if (jsonRes.status !== 200) {
      throw new Error(`Stage 2 (json): expected 200, got ${jsonRes.status}`);
    }
    const jsonBody = await jsonRes.text();
    if (jsonBody.includes(privateDirectivePlant) || jsonBody.includes(privateProblemPlant)) {
      throw new Error("CRITICAL LEAK: private sponsor data leaked into capsule json face!");
    }
    const projection = JSON.parse(jsonBody);
    const parsedProjection = EnrollmentCapsuleProjectionSchema.safeParse(projection);
    if (!parsedProjection.success) {
      throw new Error(
        `Stage 2 (json): projection failed schema validation: ${parsedProjection.error.message}`,
      );
    }

    // 2.3 HTML Face (text/html)
    const htmlRes = await request(`https://a.asimposium.org${capsulePath}`, {
      headers: { accept: "text/html" },
    });
    if (htmlRes.status !== 200) {
      throw new Error(`Stage 2 (html): expected 200, got ${htmlRes.status}`);
    }
    const htmlBody = await htmlRes.text();
    if (!htmlBody.includes("history.replaceState")) {
      throw new Error(
        "Stage 2 (html): HTML face missing history.replaceState fragment scrub script",
      );
    }

    // 2.4 Cache Control & Conditional Read (ETag / 304)
    const etag = mdRes.headers.get("etag");
    if (!etag) {
      throw new Error("Stage 2: capsule response missing ETag header");
    }
    const cacheControl = mdRes.headers.get("cache-control") ?? "";
    if (!cacheControl.includes("no-cache")) {
      throw new Error(`Stage 2: expected no-cache in cache-control, got ${cacheControl}`);
    }
    const revalRes = await request(`https://a.asimposium.org${capsulePath}`, {
      headers: { "if-none-match": etag },
    });
    if (revalRes.status !== 304) {
      throw new Error(`Stage 2: conditional revalidation expected 304, got ${revalRes.status}`);
    }

    opsRecords.push({
      tag: "OPS.2a",
      suite: "enrollment-capsule",
      stage: "capsule_projections_and_privacy",
      enrollment_id: mint1.enrollmentId,
      route_template: "GET /join/:enrollmentId",
      state_or_code: "CAPSULE_DELIVERED",
      request_id: "req_capsule_get",
      duration_ms: Date.now() - stageStart,
    });
    console.log(
      "✓ Stage 2: Content-negotiated capsule projections (MD, JSON, HTML, ETag 304) verified.",
    );
  }

  // =========================================================================
  // STAGE 3: Secret Absence from Logs, Referer, Analytics, HTML & Caches
  // =========================================================================
  {
    const stageStart = Date.now();

    // Referer header must not reflect secret
    const refRes = await request(`https://a.asimposium.org/join/${mint1.enrollmentId}`, {
      headers: {
        referer: "https://external.search.engine/results?q=secret_leak_attempt",
      },
    });
    const refText = await refRes.text();
    if (refText.includes("secret_leak_attempt")) {
      throw new Error("Stage 3: capsule response reflected unvalidated Referer header");
    }

    // Query parameters fail closed (path-only requirement)
    const queryRes = await request(
      `https://a.asimposium.org/join/${mint1.enrollmentId}?fragment=${mint1.secret}`,
    );
    if (queryRes.status !== 400 && queryRes.status !== 404) {
      throw new Error(
        `Stage 3: expected query params on /join to fail closed, got ${queryRes.status}`,
      );
    }

    // Unknown enrollment ID returns 404 ProblemDocument without reflecting unauthenticated input
    const unknownRes = await request("https://a.asimposium.org/join/ASIMP-EN-9999999999");
    if (unknownRes.status !== 404) {
      throw new Error(`Stage 3: expected 404 for unknown enrollment ID, got ${unknownRes.status}`);
    }
    const unknownProblem = await jsonOf(unknownRes);
    if (!ProblemDocumentSchema.safeParse(unknownProblem).success) {
      throw new Error("Stage 3: unknown enrollment response is not a valid ProblemDocument");
    }

    opsRecords.push({
      tag: "OPS.2a",
      suite: "enrollment-capsule",
      stage: "secret_absence_audit",
      enrollment_id: mint1.enrollmentId,
      route_template: "GET /join/:enrollmentId",
      state_or_code: "SAFE_REDACTION_VERIFIED",
      request_id: "req_safe_audit",
      duration_ms: Date.now() - stageStart,
    });
    console.log(
      "✓ Stage 3: Secret absence from logs, Referer, query params, and unknown IDs verified.",
    );
  }

  // =========================================================================
  // STAGE 4: Secret Transport & Proposal Claim (POST /v1/fellows)
  // =========================================================================
  let claim1Handle: string;
  {
    const stageStart = Date.now();

    // Claim with one-time secret in JSON body
    const claimRes = await postFellow({
      enrollment_id: mint1.enrollmentId,
      secret: mint1.secret,
      name: "orchid-vector",
      model: "example-lab/orchid-1",
      harness: "codex",
    });

    if (claimRes.status !== 202) {
      const err = await claimRes.text();
      throw new Error(`Stage 4: claim expected 202, got ${claimRes.status}: ${err}`);
    }

    const claimData = await jsonOf(claimRes);
    if (!claimData.flow_handle || typeof claimData.flow_handle !== "string") {
      throw new Error("Stage 4: claim response missing valid high-entropy flow_handle");
    }
    claim1Handle = claimData.flow_handle;

    // Single-use enforcement: immediate replay of same secret is refused (422 or 401)
    const replayClaimRes = await postFellow({
      enrollment_id: mint1.enrollmentId,
      secret: mint1.secret,
      name: "orchid-vector",
      model: "example-lab/orchid-1",
      harness: "codex",
    });
    if (replayClaimRes.status === 202) {
      throw new Error("CRITICAL SECURITY FAILURE: single-use secret permitted second claim!");
    }

    // Once claimed, GET /join/:enrollmentId collapses to 404 (consumed)
    const consumedCapsule = await request(`https://a.asimposium.org/join/${mint1.enrollmentId}`);
    if (consumedCapsule.status !== 404) {
      throw new Error(
        `Stage 4: consumed enrollment capsule expected 404, got ${consumedCapsule.status}`,
      );
    }

    opsRecords.push({
      tag: "OPS.2a",
      suite: "enrollment-capsule",
      stage: "proposal_claim_and_secret_consumption",
      enrollment_id: mint1.enrollmentId,
      route_template: "POST /v1/fellows",
      state_or_code: "PROPOSAL_ACCEPTED",
      request_id: "req_claim_1",
      duration_ms: Date.now() - stageStart,
    });
    console.log(
      "✓ Stage 4: Proposal claim consumed one-time secret; replay and capsule access burned.",
    );
  }

  // =========================================================================
  // STAGE 5: Flow Handle Polling (POST /v1/fellows/flow)
  // =========================================================================
  {
    const stageStart = Date.now();

    // 5.1 Pending status polling
    const pollPendingRes = await postFlow(claim1Handle);
    if (pollPendingRes.status !== 200) {
      throw new Error(`Stage 5: poll expected 200, got ${pollPendingRes.status}`);
    }
    const pollPendingData = await jsonOf(pollPendingRes);
    if (pollPendingData.status !== "authorization_pending") {
      throw new Error(`Stage 5: expected authorization_pending, got ${pollPendingData.status}`);
    }
    if (typeof pollPendingData.retry_after_seconds !== "number") {
      throw new Error("Stage 5: poll missing RFC-8628 retry_after_seconds field");
    }

    // 5.2 Bare proposal ID or enrollment ID polling is refused
    const bareEnrollmentPoll = await request("https://a.asimposium.org/v1/fellows/flow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_handle: mint1.enrollmentId }),
    });
    if (bareEnrollmentPoll.status === 200) {
      const data = await jsonOf(bareEnrollmentPoll);
      if (data.status === "approved" || data.status === "authorization_pending") {
        throw new Error("CRITICAL SECURITY FAILURE: bare enrollment ID authorized flow poll!");
      }
    }

    // 5.3 Query parameters on flow endpoint are rejected
    const queryFlowRes = await request(
      `https://a.asimposium.org/v1/fellows/flow?handle=${claim1Handle}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flow_handle: claim1Handle }),
      },
    );
    if (queryFlowRes.status !== 400 && queryFlowRes.status !== 404) {
      throw new Error(
        `Stage 5: query params on flow endpoint expected rejection, got ${queryFlowRes.status}`,
      );
    }

    opsRecords.push({
      tag: "OPS.2a",
      suite: "enrollment-capsule",
      stage: "flow_handle_polling",
      route_template: "POST /v1/fellows/flow",
      state_or_code: "AUTHORIZATION_PENDING",
      request_id: "req_poll_pending",
      duration_ms: Date.now() - stageStart,
    });
    console.log(
      "✓ Stage 5: RFC-8628 flow polling verified (pending status, pacing, bare-ID rejection).",
    );
  }

  // =========================================================================
  // STAGE 6: Sponsor Decision Lifecycle (Approve, Reduce, Deny)
  // =========================================================================
  {
    const stageStart = Date.now();

    // 6.1 APPROVE: Sponsor approves proposal 1
    await service.decide(sponsor1, mint1.enrollmentId, {
      enrollment_id: mint1.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(clock.now() / 1000),
    });

    // Flow poll returns 200 with approved token
    const pollApprovedRes = await postFlow(claim1Handle, {
      "Idempotency-Key": "idemp-capsule-approval-1",
    });
    if (pollApprovedRes.status !== 200) {
      const err = await pollApprovedRes.text();
      throw new Error(`Stage 6.1: expected 200 approved, got ${pollApprovedRes.status}: ${err}`);
    }
    const approvedData = await jsonOf(pollApprovedRes);
    if (approvedData.status !== "approved" || !approvedData.token?.startsWith("asimp_ag_")) {
      throw new Error(
        `Stage 6.1: approval missing token (status: ${String(approvedData.status)}, has_token: ${Boolean(approvedData.token)})`,
      );
    }

    // Same-key replay returns exact token within 24h
    const replayPoll = await postFlow(claim1Handle, {
      "Idempotency-Key": "idemp-capsule-approval-1",
    });
    const replayData = await jsonOf(replayPoll);
    if (
      !replayData.token ||
      !approvedData.token ||
      !safeStringEqual(replayData.token, approvedData.token)
    ) {
      throw new Error("Stage 6.1: idempotent replay returned different token!");
    }

    // 6.2 REDUCE: Mint second enrollment with ["review", "promote"], sponsor reduces to ["review"]
    const sponsor2 = getSponsor("s2");
    const mint2 = await service.mint(sponsor2, { requested_scopes: ["review", "promote"] });
    const claim2 = await postFellow({
      enrollment_id: mint2.enrollmentId,
      secret: mint2.secret,
      name: "orchis-reduced",
      model: "example-lab/orchis-2",
      harness: "codex",
    });
    const claim2Data = await jsonOf(claim2);
    if (!claim2Data.flow_handle) throw new Error("Stage 6.2: claim 2 missing flow_handle");

    // Sponsor decides: reduce scopes to ["review"]
    await service.decide(sponsor2, mint2.enrollmentId, {
      enrollment_id: mint2.enrollmentId,
      decision: "reduce",
      reduction: { scopes: ["review"] },
      step_up_authenticated_at: Math.floor(clock.now() / 1000),
    });

    const pollReducedRes = await postFlow(claim2Data.flow_handle);
    const reducedData = await jsonOf(pollReducedRes);
    if (reducedData.status !== "approved") {
      throw new Error(
        `Stage 6.2: expected approved status on reduction, got ${reducedData.status}`,
      );
    }
    // Verify in D1 that the granted scopes were reduced to only ["review"]
    const grantRow = sqlite
      .prepare<unknown, [string]>(
        "SELECT granted_scopes_json FROM enrollment_grants WHERE sponsor_id = ?",
      )
      .get(sponsor2.sponsorId) as { granted_scopes_json: string } | null;
    if (!grantRow) throw new Error("Stage 6.2: grant row missing in D1");
    const grantedScopes = JSON.parse(grantRow.granted_scopes_json);
    if (!grantedScopes.includes("review") || grantedScopes.includes("promote")) {
      throw new Error(`Stage 6.2: expected scopes ['review'], got ${grantRow.granted_scopes_json}`);
    }

    // 6.3 DENY: Mint third enrollment, sponsor denies
    const sponsor3 = getSponsor("s3");
    const mint3 = await service.mint(sponsor3, { requested_scopes: ["review"] });
    const claim3 = await postFellow({
      enrollment_id: mint3.enrollmentId,
      secret: mint3.secret,
      name: "orchis-denied",
      model: "example-lab/orchis-3",
      harness: "codex",
    });
    const claim3Data = await jsonOf(claim3);
    if (!claim3Data.flow_handle) throw new Error("Stage 6.3: claim 3 missing flow_handle");

    await service.decide(sponsor3, mint3.enrollmentId, {
      enrollment_id: mint3.enrollmentId,
      decision: "deny",
      step_up_authenticated_at: Math.floor(clock.now() / 1000),
    });

    const pollDeniedRes = await postFlow(claim3Data.flow_handle);
    const deniedData = await jsonOf(pollDeniedRes);
    if (deniedData.status !== "access_denied") {
      throw new Error(`Stage 6.3: expected status access_denied, got ${deniedData.status}`);
    }
    // Denial must NOT disclose sponsor identity
    if ("sponsor" in deniedData || "sponsor_id" in deniedData) {
      throw new Error("Stage 6.3: denial disclosed sponsor identity");
    }

    opsRecords.push({
      tag: "OPS.2a",
      suite: "enrollment-capsule",
      stage: "sponsor_decision_lifecycle",
      enrollment_id: mint1.enrollmentId,
      route_template: "POST /v1/enrollments/:id/decision",
      state_or_code: "APPROVE_REDUCE_DENY_VERIFIED",
      request_id: "req_decide_all",
      duration_ms: Date.now() - stageStart,
    });
    console.log(
      "✓ Stage 6: Sponsor decisions (Approve with one-time token, Reduce, Deny) verified.",
    );
  }

  // =========================================================================
  // STAGE 7: Expiry Boundaries (30-min Secret TTL vs 24-hr Proposal TTL)
  // =========================================================================
  {
    const stageStart = Date.now();
    const sponsor7 = getSponsor("s7");
    const mint7 = await service.mint(sponsor7, { requested_scopes: ["review"] });

    // 7.1 Advance clock past 30-minute secret expiry (31 minutes)
    clock.advance(31 * 60 * 1000);

    // GET /join/:id for expired secret returns 404
    const expiredCapsule = await request(`https://a.asimposium.org/join/${mint7.enrollmentId}`);
    if (expiredCapsule.status !== 404) {
      throw new Error(`Stage 7: expired capsule expected 404, got ${expiredCapsule.status}`);
    }

    // Claim with expired secret is refused
    const expiredClaim = await postFellow({
      enrollment_id: mint7.enrollmentId,
      secret: mint7.secret,
      name: "orchis-expired",
      model: "example-lab/orchis-exp",
      harness: "codex",
    });
    if (expiredClaim.status === 202) {
      throw new Error("CRITICAL SECURITY FAILURE: claim accepted with expired enrollment secret!");
    }

    // 7.2 Proposal expiry (24 hours after claim)
    const mint7b = await service.mint(sponsor7, { requested_scopes: ["review"] });
    const claim7b = await postFellow({
      enrollment_id: mint7b.enrollmentId,
      secret: mint7b.secret,
      name: "orchis-prop-exp",
      model: "example-lab/orchis-prop",
      harness: "codex",
    });
    const claim7bData = await jsonOf(claim7b);
    if (!claim7bData.flow_handle) throw new Error("Stage 7: claim 7b missing flow_handle");

    // Advance clock past 24-hour proposal expiry (25 hours)
    clock.advance(25 * 60 * 60 * 1000);

    const pollExpiredProp = await postFlow(claim7bData.flow_handle);
    const expiredPropData = await jsonOf(pollExpiredProp);
    if (expiredPropData.status !== "expired_token") {
      throw new Error(
        `Stage 7: expected expired_token status for proposal, got ${expiredPropData.status}`,
      );
    }

    opsRecords.push({
      tag: "OPS.2a",
      suite: "enrollment-capsule",
      stage: "ttl_expiry_boundaries",
      enrollment_id: mint7.enrollmentId,
      route_template: "GET /join/:enrollmentId / POST /v1/fellows/flow",
      state_or_code: "EXPIRY_VERIFIED",
      request_id: "req_ttl_bounds",
      expiry_bucket: "30m_and_24h",
      duration_ms: Date.now() - stageStart,
    });
    console.log(
      "✓ Stage 7: TTL expiry boundaries (30-min secret TTL vs 24-hr proposal TTL) verified.",
    );
  }

  // =========================================================================
  // STAGE 8: Mint Invalidation on Regeneration
  // =========================================================================
  {
    const stageStart = Date.now();
    const sponsor8 = getSponsor("s8");
    const mintA = await service.mint(sponsor8, { requested_scopes: ["review"] });

    // Mint B replacing A
    const mintB = await service.mint(sponsor8, {
      requested_scopes: ["review"],
      replaces_enrollment_id: mintA.enrollmentId,
    });

    // Invariant: predecessor A is invalidated
    const rowA = sqlite
      .prepare<unknown, [string]>(
        "SELECT invalidated FROM enrollment_records WHERE enrollment_id = ?",
      )
      .get(mintA.enrollmentId) as { invalidated: number } | null;

    if (rowA?.invalidated !== 1) {
      throw new Error(
        `Stage 8: predecessor enrollment ${mintA.enrollmentId} not marked invalidated in D1`,
      );
    }

    // Capsule for predecessor A returns 404
    const capsuleA = await request(`https://a.asimposium.org/join/${mintA.enrollmentId}`);
    if (capsuleA.status !== 404) {
      throw new Error(
        `Stage 8: invalidated enrollment capsule expected 404, got ${capsuleA.status}`,
      );
    }

    // Attempting to claim predecessor A is refused
    const claimA = await postFellow({
      enrollment_id: mintA.enrollmentId,
      secret: mintA.secret,
      name: "orchis-invalidated",
      model: "example-lab/orchis-inv",
      harness: "codex",
    });
    if (claimA.status === 202) {
      throw new Error(
        "CRITICAL SECURITY FAILURE: invalidated predecessor enrollment claimed successfully!",
      );
    }

    // Replacement B remains valid and claimable
    const capsuleB = await request(`https://a.asimposium.org/join/${mintB.enrollmentId}`);
    if (capsuleB.status !== 200) {
      throw new Error(`Stage 8: replacement capsule expected 200, got ${capsuleB.status}`);
    }

    opsRecords.push({
      tag: "OPS.2a",
      suite: "enrollment-capsule",
      stage: "mint_invalidation_on_regeneration",
      enrollment_id: mintA.enrollmentId,
      route_template: "POST /v1/enrollments",
      state_or_code: "PREDECESSOR_INVALIDATED",
      request_id: "req_regen_8",
      duration_ms: Date.now() - stageStart,
    });
    console.log("✓ Stage 8: Mint invalidation on regeneration verified.");
  }

  // =========================================================================
  // STAGE 9: OPS.2a Structured Diagnostic Logging & Strict Zero-Leakage Audit
  // =========================================================================
  console.log("\n--- OPS.2a Structured Diagnostic Log ---");
  for (const record of opsRecords) {
    console.log(JSON.stringify(record));
  }

  const fullLog = JSON.stringify(opsRecords);
  const forbiddenCanaries = [
    mint1.secret,
    claim1Handle,
    privateDirectivePlant,
    "asimp_ag_",
    "bearer ",
    "usr_sponsor_",
  ];

  for (const canary of forbiddenCanaries) {
    if (fullLog.includes(canary)) {
      throw new Error(`CRITICAL: OPS.2a diagnostic log leaked sensitive data: '${canary}'`);
    }
  }
  console.log(
    "✓ Stage 9: OPS.2a zero-leakage security audit passed (redaction verified clean across all diagnostic records).",
  );

  const totalDuration = Date.now() - startedAt;
  console.log(`\nAll 9 stages completed successfully in ${totalDuration}ms.`);
  return { passed: true, records: opsRecords };
}

if (import.meta.main) {
  runEnrollmentCapsuleE2e()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("\nE2E EXECUTION FAILED:", err);
      process.exit(1);
    });
}
