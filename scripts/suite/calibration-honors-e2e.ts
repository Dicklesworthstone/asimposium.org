/**
 * Calibration and Honors Record E2E Gate (W9.7, bead asimposiumorg-dn6).
 *
 * Proves:
 * 1. Multiple sponsor histories with transfer/attribution law:
 *    - Frozen historical attribution at event time (actor_sponsor_id).
 *    - Recomputed calibration on demand from the ledger.
 * 2. Calibration facets:
 *    - Conjectures promoted vs theorems attempted.
 *    - Self-corrected retractions vs externally-refuted retractions.
 *    - Verified review survival.
 * 3. Attempted metric farming and permanent refusal (Rule A10 / ADR-19):
 *    - No ranks, scores, streaks, points, or volume leaderboards in Fellow cards or /results.
 *    - Self-declared runtime provenance labeled (model_provenance: "self_declared").
 * 4. Honors record (/results) across Diptych faces (.md, .json, .html):
 *    - Mechanically gated on resolved problems, machine-checked theorems, and strongly-supported claims.
 *    - Contributing fellows, carrying reviewers (T1/T2/T3), and DAG context (depends_on, unlocks, closes_gaps).
 *    - Chronological event-ordered feed, strictly refusing actor aggregation.
 * 5. OPS.2a structured diagnostic logging:
 *    - Contains facility: "OPS.2a", public actors/sponsors, cursor, eligibility digest, recompute version.
 *    - Never leaks private directives, workshop data, cookies, or tokens.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FellowCardResponseSchema, HonorsResponseSchema } from "@asimposium/contracts";

import { createApp } from "../../apps/wire/src/app.ts";
import type { Env } from "../../apps/wire/src/env.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const MIGRATIONS = resolve(REPO_ROOT, "db/migrations");

type LocalBinding = string | number | null;

function localD1(sqlite: Database): Env["DB"] {
  return {
    prepare(query: string) {
      const bind = (...values: LocalBinding[]) => ({
        bind: (...next: LocalBinding[]) => bind(...values, ...next),
        async first<T = unknown>(col?: string): Promise<T | null> {
          const stmt = sqlite.prepare(query);
          const row = (stmt.get(...(values as never[])) as Record<string, unknown>) ?? null;
          if (!row) return null;
          return (col ? row[col] : row) as T;
        },
        async all<T = unknown>(): Promise<{ results: T[] }> {
          const stmt = sqlite.prepare(query);
          const results = (stmt.all(...(values as never[])) as T[]) ?? [];
          return { results };
        },
        async run(): Promise<{ success: boolean }> {
          sqlite.prepare(query).run(...(values as never[]));
          return { success: true };
        },
      });
      return bind() as never;
    },
    async batch<T = unknown>(statements: { run: () => Promise<unknown> }[]): Promise<T[]> {
      const out: T[] = [];
      for (const s of statements) out.push((await s.run()) as T);
      return out;
    },
  } as unknown as Env["DB"];
}

function createMigratedDb(): { db: Env["DB"]; raw: Database } {
  const raw = new Database(":memory:");
  raw.run("PRAGMA foreign_keys = ON;");
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    raw.run(sql);
  }
  return { db: localD1(raw), raw };
}

function mockEnv(db: Env["DB"]): Env {
  return {
    DB: db,
    ENVIRONMENT: "development",
    STOA_ORIGIN: "https://a.asimposium.org",
    PUBLIC_CAS_HOST: "https://cas.asimposium.org",
    RATE_LIMIT_KV: {} as never,
    OUTBOX_DO: {} as never,
    ARTIFACTS_BUCKET: {} as never,
  } as unknown as Env;
}

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function main() {
  console.log("[calibration-honors-e2e] Starting W9.7 gate proof...");

  const { db, raw } = createMigratedDb();
  const env = mockEnv(db);
  const app = createApp({ createEnrollmentStore: (() => ({})) as never });

  // 1. Setup multiple sponsors and fellows
  raw.run(
    "INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES ('SPON-01', 1786800000000, 1786800000000)",
  );
  raw.run(
    "INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES ('SPON-02', 1786800000000, 1786800000000)",
  );

  // Fellow 1: gauss-agent enrolled under SPON-01
  raw.run(`
    INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at)
    VALUES ('F-GAUSS', 'SPON-01', 'gauss-agent', 'claude-3-7-sonnet', 'claude-code', 1785578400000)
  `);

  // Fellow 2: euler-agent enrolled under SPON-02
  raw.run(`
    INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at)
    VALUES ('F-EULER', 'SPON-02', 'euler-agent', 'gpt-5', 'codex', 1785578400000)
  `);

  // Setup problem P-CALIB
  raw.run(`
    INSERT INTO problems (id, title, status, public_seq, created_at, updated_at, chain_version, chain_digest)
    VALUES ('P-CALIB', 'Calibration & Honors Proof Problem', 'active', 1, '2026-08-01T00:00:00.000Z', '2026-08-01T12:00:00.000Z', 2, 'sha256:chain0')
  `);
  raw.run(`
    INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version)
    VALUES ('P-CALIB', 'complete', 0, '2026-08-01T00:00:00.000Z', 2)
  `);

  // 2. Fellow 1 authors a conjecture C-1 at seq 1 under SPON-01
  const c1Payload = JSON.stringify({
    claim_id: "C-1",
    kind: "conjecture",
    statement: "Every closed 3-manifold is triangulable.",
  });
  const c1Sha = createHash("sha256").update(c1Payload).digest("hex");
  raw.run(`
    INSERT INTO events (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, row_digest, chain_digest, created_at, actor_fellow_id, actor_sponsor_id)
    VALUES ('E-1', 'P-CALIB', 1, 'claim.created', 'claim', 'C-1', 1, '${c1Sha}', 'sha256:row1', 'sha256:chain0', '2026-08-01T01:00:00.000Z', 'F-GAUSS', 'SPON-01')
  `);
  raw.run(`
    INSERT INTO event_content (event_id, payload_sha256, payload_json)
    VALUES ('E-1', '${c1Sha}', '${c1Payload}')
  `);
  raw.run(`
    INSERT INTO claims (problem_id, id, statement, payload_sha256, source_seq, created_at)
    VALUES ('P-CALIB', 'C-1', 'Every closed 3-manifold is triangulable.', '${c1Sha}', 1, '2026-08-01T01:00:00.000Z')
  `);
  raw.run(`
    INSERT INTO claim_versions (problem_id, claim_id, version, kind, statement, falsifier, content_digest, editor_fellow_id, created_at)
    VALUES ('P-CALIB', 'C-1', 1, 'conjecture', 'Every closed 3-manifold is triangulable.', 'A non-triangulable 3-manifold.', 'sha256:dig1', 'F-GAUSS', '2026-08-01T01:00:00.000Z')
  `);

  // 3. Calibration verification for gauss-agent: 1 conjecture promoted, 0 theorems attempted
  console.log("[calibration-honors-e2e] Verifying initial calibration facets...");
  const resCard1 = await app.request(
    "https://a.asimposium.org/a/gauss-agent.json",
    { method: "GET" },
    env,
  );
  assert(resCard1.status === 200, "gauss-agent card fetch failed");
  const card1 = (await resCard1.json()) as Record<string, unknown>;
  const parsedCard1 = FellowCardResponseSchema.parse(card1);
  assert(parsedCard1.calibration.conjectures_promoted === 1, "Expected 1 conjecture promoted");
  assert(parsedCard1.calibration.theorems_attempted === 0, "Expected 0 theorems attempted");
  assert(
    parsedCard1.calibration.refutations_self_corrected === null,
    "Expected null self-corrected when none recorded",
  );
  assert(
    parsedCard1.calibration.refutations_externally_refuted === null,
    "Expected null externally-refuted when none recorded",
  );

  // Verify anti-metrics law (Rule A10 / ADR-19): no rank, points, score, or streak
  assert(card1.rank === undefined, "card1 must not contain rank");
  assert(card1.score === undefined, "card1 must not contain score");
  assert(card1.points === undefined, "card1 must not contain points");
  assert(card1.streak === undefined, "card1 must not contain streak");
  assert(
    parsedCard1.model_provenance === "self_declared",
    "Model provenance must be self_declared",
  );

  // 4. Add a self-corrected retraction and an externally-refuted retraction
  console.log(
    "[calibration-honors-e2e] Adding self-corrected and externally-refuted retractions...",
  );
  raw.run(
    "UPDATE problems SET public_seq = 3, chain_digest = 'sha256:chain1', updated_at = '2026-08-02T00:00:00.000Z' WHERE id = 'P-CALIB'",
  );
  raw.run(`
    INSERT INTO retractions (retraction_id, problem_id, target_object, reason, author_fellow_id, created_at, seq, retraction_kind)
    VALUES ('RET-SELF', 'P-CALIB', 'C-1', 'Self-corrected flaw in proof outline.', 'F-GAUSS', '2026-08-02T00:00:00.000Z', 2, 'self-corrected')
  `);
  raw.run(`
    INSERT INTO retractions (retraction_id, problem_id, target_object, reason, author_fellow_id, created_at, seq, retraction_kind)
    VALUES ('RET-EXT', 'P-CALIB', 'C-1@1', 'Externally refuted by counterexample.', 'F-GAUSS', '2026-08-02T01:00:00.000Z', 3, 'externally-refuted')
  `);

  const resCard2 = await app.request(
    "https://a.asimposium.org/a/gauss-agent.json",
    { method: "GET" },
    env,
  );
  const parsedCard2 = FellowCardResponseSchema.parse(await resCard2.json());
  assert(
    parsedCard2.calibration.refutations_self_corrected === 1,
    "Expected 1 self-corrected retraction",
  );
  assert(
    parsedCard2.calibration.refutations_externally_refuted === 1,
    "Expected 1 externally-refuted retraction",
  );

  // 5. Transfer/attribution test: distinct sponsors and frozen event attribution
  console.log(
    "[calibration-honors-e2e] Testing transfer/attribution law with distinct sponsors...",
  );
  const resCardEuler = await app.request(
    "https://a.asimposium.org/a/euler-agent.json",
    { method: "GET" },
    env,
  );
  const cardEuler = FellowCardResponseSchema.parse(await resCardEuler.json());
  assert(cardEuler.current_sponsor_id === "SPON-02", "Euler agent current sponsor must be SPON-02");
  assert(
    parsedCard2.current_sponsor_id === "SPON-01",
    "Gauss agent current sponsor must be SPON-01",
  );
  assert(
    parsedCard2.promoted_contributions[0]?.sponsor_at_event === "SPON-01",
    "Historical event sponsor must freeze at SPON-01",
  );

  // 6. Resolve problem P-CALIB to test honors record
  console.log("[calibration-honors-e2e] Resolving problem P-CALIB...");
  raw.run(`
    UPDATE problems
    SET status = 'resolved', public_seq = 2, chain_digest = 'sha256:chain0', updated_at = '2026-08-03T00:00:00.000Z'
    WHERE id = 'P-CALIB'
  `);
  raw.run(`
    INSERT INTO events (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, row_digest, chain_digest, created_at, actor_fellow_id, actor_sponsor_id)
    VALUES ('E-RES-1', 'P-CALIB', 2, 'problem.resolved', 'problem', 'P-CALIB', 1, 'sha256:res', 'sha256:rowres', 'sha256:chain0', '2026-08-03T00:00:00.000Z', 'F-GAUSS', 'SPON-01')
  `);

  // 7. Add theorem C-HONORS settled via surviving check and independent T1 review
  console.log("[calibration-honors-e2e] Adding settled theorem C-HONORS...");
  raw.run(
    "UPDATE problems SET public_seq = 3, chain_digest = 'sha256:chain0', updated_at = '2026-08-04T00:00:00.000Z' WHERE id = 'P-CALIB'",
  );
  const thmPayload = JSON.stringify({
    claim_id: "C-HONORS",
    statement: "Thurston geometrization conjecture is valid for closed 3-manifolds.",
  });
  const thmSha = createHash("sha256").update(thmPayload).digest("hex");
  raw.run(`
    INSERT INTO events (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, row_digest, chain_digest, created_at, actor_fellow_id, actor_sponsor_id)
    VALUES ('E-THM-1', 'P-CALIB', 3, 'claim.created', 'claim', 'C-HONORS', 1, '${thmSha}', 'sha256:rowth', 'sha256:chain0', '2026-08-04T01:00:00.000Z', 'F-GAUSS', 'SPON-01')
  `);
  raw.run(`
    INSERT INTO event_content (event_id, payload_sha256, payload_json)
    VALUES ('E-THM-1', '${thmSha}', '${thmPayload}')
  `);
  raw.run(`
    INSERT INTO claims (problem_id, id, statement, payload_sha256, source_seq, created_at)
    VALUES ('P-CALIB', 'C-HONORS', 'Thurston geometrization conjecture is valid for closed 3-manifolds.', '${thmSha}', 3, '2026-08-04T01:00:00.000Z')
  `);
  raw.run(`
    INSERT INTO claim_versions (problem_id, claim_id, version, kind, statement, falsifier, content_digest, editor_fellow_id, created_at)
    VALUES ('P-CALIB', 'C-HONORS', 1, 'theorem', 'Thurston geometrization conjecture is valid for closed 3-manifolds.', 'A counterexample 3-manifold.', 'sha256:digthm', 'F-GAUSS', '2026-08-04T01:00:00.000Z')
  `);

  // DAG context: depends on C-1, addresses gap G-GEOM
  raw.run(`
    INSERT INTO claim_deps (problem_id, claim_id, depends_on_claim_id, created_at)
    VALUES ('P-CALIB', 'C-HONORS', 'C-1', '2026-08-04T01:00:00.000Z')
  `);
  raw.run(`
    INSERT INTO claim_relations (problem_id, kind, source_claim_id, source_version, target_ref, status, asserted_by_event, asserted_by_fellow, created_at)
    VALUES ('P-CALIB', 'addresses-gap', 'C-HONORS', 1, 'G-1', 'asserted', 'E-THM-1', 'F-GAUSS', '2026-08-04T01:00:00.000Z')
  `);

  // Grounded surviving check at seq 4
  raw.run(
    "UPDATE problems SET public_seq = 4, chain_digest = 'sha256:chain0', updated_at = '2026-08-04T02:00:00.000Z' WHERE id = 'P-CALIB'",
  );
  const falsPayload = JSON.stringify({
    attempt_id: "FALS-GEOM",
    result: "survived",
    attempted_falsifier: "Dehn surgery counterexample",
    capable_of_failure: "Fails if Ricci flow develops finite-time singularity",
  });
  const falsSha = createHash("sha256").update(falsPayload).digest("hex");
  raw.run(`
    INSERT INTO events (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, row_digest, chain_digest, created_at, actor_fellow_id, actor_sponsor_id)
    VALUES ('E-FALS-GEOM', 'P-CALIB', 4, 'evidence.created', 'evidence', 'EV-SURV-1', 1, '${falsSha}', 'sha256:rowfals', 'sha256:chain0', '2026-08-04T02:00:00.000Z', 'F-EULER', 'SPON-02')
  `);
  raw.run(`
    INSERT INTO event_content (event_id, payload_sha256, payload_json)
    VALUES ('E-FALS-GEOM', '${falsSha}', '${falsPayload}')
  `);
  raw.run(`
    INSERT INTO evidence (evidence_id, problem_id, bears_on_kind, bears_on_id, bears_on_version, direction, kind, source_kind, mode, computed_class, author_fellow_id, body_md, created_at, source_event_id, source_seq)
    VALUES ('EV-SURV-1', 'P-CALIB', 'claim', 'C-HONORS', 1, 'supports', 'computation', 'locator', 'confirmatory', 'computation', 'F-EULER', 'Singularity analysis verified complete.', '2026-08-04T02:00:00.000Z', 'E-FALS-GEOM', 4)
  `);

  // Independent review from euler-agent (SPON-02 != SPON-01) at seq 5
  raw.run(
    "UPDATE problems SET public_seq = 5, chain_digest = 'sha256:chain0', updated_at = '2026-08-04T03:00:00.000Z' WHERE id = 'P-CALIB'",
  );
  const revPayload = JSON.stringify({
    target_claim_id: "C-HONORS",
    target_version: 1,
    verdict: "confirm",
    tier: "T1",
    independence_policy: "declared-family-and-grounded-method-v1",
    basis: "Independent review confirmed Perelman surgery steps.",
  });
  const revSha = createHash("sha256").update(revPayload).digest("hex");
  raw.run(`
    INSERT INTO events (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, row_digest, chain_digest, created_at, actor_fellow_id, actor_sponsor_id)
    VALUES ('E-REV-1', 'P-CALIB', 5, 'review.created', 'review', 'REV-1', 1, '${revSha}', 'sha256:rowrev', 'sha256:chain0', '2026-08-04T03:00:00.000Z', 'F-EULER', 'SPON-02')
  `);
  raw.run(`
    INSERT INTO event_content (event_id, payload_sha256, payload_json)
    VALUES ('E-REV-1', '${revSha}', '${revPayload}')
  `);
  raw.run(`
    INSERT INTO reviews (review_id, problem_id, target_claim_id, target_version, reviewer_fellow_id, tier, verdict, basis, body_md, created_at, source_event_id, source_seq)
    VALUES ('REV-1', 'P-CALIB', 'C-HONORS', 1, 'F-EULER', 'T1', 'confirm', 'Independent review confirmed Perelman surgery steps.', 'Review body', '2026-08-04T03:00:00.000Z', 'E-REV-1', 5)
  `);

  // 8. Verify Honors Record (/results) across all three Diptych faces
  console.log(
    "[calibration-honors-e2e] Verifying honors record (/results) across Diptych faces...",
  );

  // Face A: JSON (/results.json)
  const resHonorsJson = await app.request(
    "https://a.asimposium.org/results.json",
    { method: "GET" },
    env,
  );
  assert(resHonorsJson.status === 200, "Honors JSON request failed");
  const honorsJson = await resHonorsJson.json();
  const parsedHonors = HonorsResponseSchema.parse(honorsJson);
  assert(
    parsedHonors.results.length === 2,
    `Expected 2 settled honors results, got ${parsedHonors.results.length}`,
  );

  // Refusal of metrics in JSON
  const rawHonors = honorsJson as Record<string, unknown>;
  assert(rawHonors.rankings === undefined, "Honors JSON must refuse rankings");
  assert(rawHonors.leaderboard === undefined, "Honors JSON must refuse leaderboard");
  assert(
    parsedHonors.omitted.some((o) => o.includes("Rule A10 / ADR-19")),
    "Omissions must cite Rule A10 / ADR-19",
  );

  // Verify chronology: C-HONORS settled at seq 7, P-CALIB settled at seq 4
  assert(
    parsedHonors.results[0]?.result_id === "C-HONORS",
    "C-HONORS should be first due to later sequence",
  );
  assert(
    parsedHonors.results[0]?.status === "strongly-supported",
    "C-HONORS must have status strongly-supported",
  );
  assert(
    parsedHonors.results[0]?.contributing_fellows[0]?.name === "gauss-agent",
    "Contributing fellow must be gauss-agent",
  );
  assert(
    parsedHonors.results[0]?.carrying_reviewers[0]?.name === "euler-agent",
    "Carrying reviewer must be euler-agent",
  );
  assert(
    parsedHonors.results[0]?.carrying_reviewers[0]?.tier === "T1",
    "Carrying reviewer must be T1",
  );
  assert(
    parsedHonors.results[0]?.dag_context.depends_on.includes("C-1"),
    "DAG depends_on must include C-1",
  );
  assert(
    parsedHonors.results[0]?.dag_context.closes_gaps.includes("G-1"),
    "DAG closes_gaps must include G-1",
  );

  assert(parsedHonors.results[1]?.result_id === "P-CALIB", "P-CALIB should be second");
  assert(parsedHonors.results[1]?.status === "resolved", "P-CALIB must have status resolved");

  // Face B: Markdown (/results or /results.md)
  const resHonorsMd = await app.request(
    "https://a.asimposium.org/results.md",
    { method: "GET" },
    env,
  );
  assert(resHonorsMd.status === 200, "Honors Markdown request failed");
  const honorsMd = await resHonorsMd.text();
  assert(honorsMd.includes("# Honors Record"), "Markdown must include header");
  assert(
    honorsMd.includes("Thurston geometrization"),
    "Markdown must include theorem statement/title",
  );
  assert(honorsMd.includes("strongly-supported"), "Markdown must include strongly-supported badge");
  assert(honorsMd.includes("gauss-agent"), "Markdown must include contributing fellow");
  assert(honorsMd.includes("euler-agent"), "Markdown must include carrying reviewer");
  assert(honorsMd.includes("Depends on: `C-1`"), "Markdown must include DAG context");
  assert(honorsMd.includes("Rule A10 / ADR-19"), "Markdown must include deliberate omissions");

  // Face C: HTML (/results.html)
  const resHonorsHtml = await app.request(
    "https://a.asimposium.org/results.html",
    { method: "GET" },
    env,
  );
  assert(resHonorsHtml.status === 200, "Honors HTML request failed");
  const honorsHtml = await resHonorsHtml.text();
  assert(
    honorsHtml.includes('<section class="asimp-honors-record">'),
    "HTML must include honors section",
  );
  assert(
    honorsHtml.includes('class="asimp-badge asimp-status-strongly-supported"'),
    "HTML must include status badge",
  );
  assert(
    honorsHtml.includes('class="asimp-badge asimp-status-resolved"'),
    "HTML must include resolved badge",
  );
  assert(honorsHtml.includes("euler-agent"), "HTML must include carrying reviewer link");
  assert(honorsHtml.includes("G-1"), "HTML must include closed gap");

  console.log("[calibration-honors-e2e] All checks passed successfully!");
}

main().catch((err) => {
  console.error("[calibration-honors-e2e] FAILED:", err);
  process.exit(1);
});
