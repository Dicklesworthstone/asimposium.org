import { Database } from "bun:sqlite";
import { describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertNoStatsAntiMetrics,
  PlatformStatsFaceSchema,
  StatsAntiMetricViolationError,
  UNAVAILABLE_UNTIL_DEPLOYED,
} from "../../../../packages/contracts/src/stats.ts";
import { renderPlatformStatsMarkdown } from "../../../../packages/render/src/stats.ts";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";

type D1Database = NonNullable<Env["DB"]>;

import { scanFieldForCredentials } from "../../src/screening/credential-scan.ts";
import { loadPlatformStats } from "../../src/stats/service.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

/** Minimal real SQLite-backed D1 adapter for testing real SQL queries without mocks. */
function sqliteAsD1(sql: Database): D1Database {
  const wrapStmt = (query: string, params: unknown[] = []) => ({
    bind: (...bound: unknown[]) => wrapStmt(query, bound),
    first: async <T = Record<string, unknown>>() => {
      const row = sql.query(query).get(...(params as [])) as T | null;
      return row ?? null;
    },
    all: async <T = Record<string, unknown>>() => {
      const results = sql.query(query).all(...(params as [])) as T[];
      return { results, success: true, meta: {} };
    },
    run: async () => {
      sql.query(query).run(...(params as []));
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (query: string) => wrapStmt(query),
    batch: async () => [],
    exec: async (query: string) => {
      sql.exec(query);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}

function seedStatsDb(): Database {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems (
      id TEXT PRIMARY KEY,
      public_seq INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      unlisted INTEGER NOT NULL DEFAULT 0,
      sponsor_id TEXT
    );
    CREATE TABLE enrollment_fellows (
      fellow_id TEXT PRIMARY KEY,
      sponsor_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      fellow_id TEXT NOT NULL,
      problem_id TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      handback TEXT
    );
    CREATE TABLE claims (
      problem_id TEXT NOT NULL,
      id TEXT NOT NULL,
      statement TEXT NOT NULL,
      PRIMARY KEY (problem_id, id)
    );
    CREATE TABLE reviews (
      problem_id TEXT NOT NULL,
      review_id TEXT NOT NULL,
      target_claim_id TEXT NOT NULL,
      tier TEXT NOT NULL,
      verdict TEXT NOT NULL,
      PRIMARY KEY (problem_id, review_id)
    );
    CREATE TABLE evidence (
      problem_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      PRIMARY KEY (problem_id, evidence_id)
    );
    CREATE TABLE dead_ends (
      problem_id TEXT NOT NULL,
      dead_end_id TEXT NOT NULL,
      retry_predicate TEXT NOT NULL,
      PRIMARY KEY (problem_id, dead_end_id)
    );
    CREATE TABLE idempotency (
      problem_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      PRIMARY KEY (problem_id, idempotency_key)
    );
    CREATE TABLE reports (
      report_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL
    );
    CREATE TABLE screening_cases (
      case_id TEXT PRIMARY KEY,
      state TEXT NOT NULL
    );
    CREATE TABLE screening_case_appeals (
      appeal_id TEXT PRIMARY KEY,
      state TEXT NOT NULL
    );

    INSERT INTO problems VALUES
      ('P-1', 2, '2026-11-20T00:00:00.000Z', '2026-11-20T02:00:00.000Z', 'active', 0, 'usr_alpha_0001'),
      ('P-2', 1, '2026-11-20T00:00:00.000Z', '2026-11-20T01:00:00.000Z', 'active', 0, 'usr_alpha_0001'),
      ('P-PRIV', 0, '2026-11-20T00:00:00.000Z', '2026-11-20T01:00:00.000Z', 'private-draft', 1, 'usr_alpha_0001');

    INSERT INTO enrollment_fellows VALUES
      ('F-01AAAAAAAAAAAAAAAAAAAAAAAA', 'usr_alpha_0001', 'active'),
      ('F-01BBBBBBBBBBBBBBBBBBBBBBBB', 'usr_beta_0002', 'active'),
      ('F-01CCCCCCCCCCCCCCCCCCCCCCCC', 'usr_gamma_0003', 'active');

    INSERT INTO sessions VALUES
      ('S-1', 'F-01AAAAAAAAAAAAAAAAAAAAAAAA', 'P-1', '2026-11-20T00:10:00.000Z', '2026-11-20T00:40:00.000Z', 'Verified lemma 1.'),
      ('S-2', 'F-01BBBBBBBBBBBBBBBBBBBBBBBB', 'P-1', '2026-11-20T02:00:00.000Z', '2026-11-20T02:30:00.000Z', NULL),
      ('S-3', 'F-01AAAAAAAAAAAAAAAAAAAAAAAA', 'P-2', '2026-11-20T00:20:00.000Z', NULL, NULL);

    INSERT INTO claims VALUES
      ('P-1', 'C-1', 'Claim 1'),
      ('P-1', 'C-2', 'Claim 2'),
      ('P-2', 'C-1', 'Claim 3');

    INSERT INTO reviews VALUES
      ('P-1', 'R-1', 'C-1', 'T2', 'confirm'),
      ('P-1', 'R-2', 'C-1', 'T3', 'confirm'),
      ('P-1', 'R-3', 'C-2', 'T1', 'confirm');

    INSERT INTO evidence VALUES
      ('P-1', 'E-1', 'reproduces'),
      ('P-1', 'E-2', 'reproduces'),
      ('P-1', 'E-3', 'fails-to-reproduce');

    INSERT INTO dead_ends VALUES
      ('P-1', 'DE-1', 'Retry if spectral bound tightens');

    INSERT INTO idempotency VALUES ('P-1', 'k1'), ('P-1', 'k2');
    INSERT INTO reports VALUES ('RP-1', 'false-solved'), ('RP-2', 'spam');
    INSERT INTO screening_cases VALUES ('QC-1', 'pending'), ('QC-2', 'released');
    INSERT INTO screening_case_appeals VALUES ('AP-1', 'released'), ('AP-2', 'upheld');
  `);
  return sql;
}

describe("Measured /stats.{json,md} face (asimposiumorg-rc-stats-runbooks-cost-model-w4tz)", () => {
  test("POSITIVE 1: computes real balanced 5-family metrics from D1 with zero actor names or rankings", async () => {
    const sql = seedStatsDb();
    try {
      const db = sqliteAsD1(sql);
      const app = createApp();
      const env = { DB: db } as unknown as Env;

      const jsonRes = await app.fetch(new Request("https://a.asimposium.org/stats.json"), env);
      expect(jsonRes.status).toBe(200);
      expect(jsonRes.headers.get("etag")).toBeTruthy();
      const bodyText = await jsonRes.text();
      // Never leak actor IDs or sponsor IDs into /stats.json!
      expect(bodyText).not.toContain("usr_alpha");
      expect(bodyText).not.toContain("usr_beta");
      expect(bodyText).not.toContain("F-01AAAA");

      const parsed = PlatformStatsFaceSchema.parse(JSON.parse(bodyText));
      assertNoStatsAntiMetrics(parsed);
      expect(parsed.state).toBe("measured");
      expect(parsed.collaboration.public_problems).toBe(2);
      expect(parsed.collaboration.active_problems).toBe(2);
      expect(parsed.collaboration.active_problems_with_multiple_sponsors).toBe(1);
      expect(parsed.collaboration.median_hours_to_first_external_sponsor).toBe(2);
      expect(parsed.collaboration.handback_completion_rate).toEqual({
        numerator: 1,
        denominator: 2,
        rate: 0.5,
      });
      expect(parsed.quality.claims_total).toBe(3);
      expect(parsed.quality.claims_by_disposition).toEqual({
        "strongly-supported": 1,
        corroborated: 1,
        open: 1,
      });
      expect(parsed.quality.corroborated_awaiting_independence_count).toBe(1);
      expect(parsed.quality.review_supply_depth).toEqual({
        problems_measured: 2,
        median_eligible_independent_fellows: 2,
        min_eligible_independent_fellows: 2,
      });
      expect(parsed.quality.reproduction_pass_rate).toEqual({
        numerator: 2,
        denominator: 3,
        rate: 0.666667,
      });
      expect(parsed.quality.dead_ends_recorded).toBe(1);
      expect(parsed.ergonomics.sessions_opened).toBe(3);
      expect(parsed.ergonomics.sessions_closed).toBe(2);
      expect(parsed.ergonomics.idempotent_writes_recorded).toBe(2);
      expect(parsed.ergonomics.onboarding_completion_by_harness).toBe(UNAVAILABLE_UNTIL_DEPLOYED);
      expect(parsed.comprehension.false_solved_reports_recorded).toBe(1);
      expect(parsed.safety.quarantine_cases_open).toBe(1);
      expect(parsed.safety.quarantine_cases_resolved).toBe(1);
      expect(parsed.safety.screening_appeal_reversal_rate).toEqual({
        numerator: 1,
        denominator: 2,
        rate: 0.5,
      });

      const mdRes = await app.fetch(new Request("https://a.asimposium.org/stats.md"), env);
      expect(mdRes.status).toBe(200);
      const md = await mdRes.text();
      expect(md).toContain("state: measured");
      expect(md).toContain("## Collaboration");
      expect(md).toContain("## Quality & Review-Supply Depth");
      expect(md).toContain("## Ergonomics");
      expect(md).toContain("## Comprehension");
      expect(md).toContain("## Safety");
      expect(md).toContain("unavailable_until_deployed");
      expect(md).not.toContain("usr_alpha");
      expect(renderPlatformStatsMarkdown(parsed)).toContain("# Platform statistics");
    } finally {
      sql.close();
    }
  });

  test("both faces revalidate unchanged metrics across measurement times and refresh changed data", async () => {
    const sql = seedStatsDb();
    try {
      const app = createApp();
      const env = { DB: sqliteAsD1(sql) } as unknown as Env;
      const requestFace = (format: string, init?: RequestInit) =>
        app.fetch(new Request(`https://a.asimposium.org/stats.${format}`, init), env);
      const etags = new Map<string, string>();
      setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
      for (const format of ["json", "md"]) {
        const response = await requestFace(format);
        const etag = response.headers.get("etag") ?? "";
        expect(etag).toMatch(/^W\/"[a-f0-9]{64}"$/);
        etags.set(format, etag);
        expect(await response.text()).toContain("2026-11-21T12:00:00.000Z");
      }
      expect(etags.get("json")).not.toBe(etags.get("md"));

      setSystemTime(new Date("2026-11-21T12:02:00.000Z"));
      for (const [format, etag] of etags) {
        const head = await requestFace(format, { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(head.headers.get("etag")).toBe(etag);
        expect(await head.text()).toBe("");
        const fresh = await requestFace(format);
        expect(await fresh.text()).toContain("2026-11-21T12:02:00.000Z");
        const cached = await requestFace(format, { headers: { "if-none-match": etag } });
        expect(cached.status).toBe(304);
        expect(await cached.text()).toBe("");
      }

      sql.exec("UPDATE screening_cases SET state = 'released' WHERE case_id = 'QC-1'");
      for (const [format, etag] of etags) {
        const updated = await requestFace(format, { headers: { "if-none-match": etag } });
        expect(updated.status).toBe(200);
        expect(updated.headers.get("etag")).not.toBe(etag);
      }
    } finally {
      setSystemTime();
      sql.close();
    }
  });

  test("degrades honestly to not_produced when DB is absent (zero placeholder numbers)", async () => {
    const app = createApp();
    const res = await app.fetch(new Request("https://a.asimposium.org/stats.json"), {} as Env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { state: string; kind: string };
    expect(json.kind).toBe("stats");
    expect(json.state).toBe("not_produced");
  });

  test("SHOULD-FAIL CONTROL: injecting actor name or model-family ranking key into /stats payload fails Rule A10", async () => {
    const sql = seedStatsDb();
    try {
      const stats = await loadPlatformStats(sqliteAsD1(sql));
      const poisoned = { ...stats, model_family: "claude-vs-gpt" };
      expect(() => assertNoStatsAntiMetrics(poisoned)).toThrow(StatsAntiMetricViolationError);
    } finally {
      sql.close();
    }
  });

  test("REGRESSION (Rule A2 + P5 + canonical reports): excludes private-draft/unlisted rows, ignores assertion-only reviews, classifies retracted claims, and counts integrity false-solved reports", async () => {
    const sql = new Database(":memory:");
    try {
      sql.exec(`
        CREATE TABLE problems (
          id TEXT PRIMARY KEY,
          public_seq INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          unlisted INTEGER NOT NULL DEFAULT 0,
          sponsor_id TEXT
        );
        CREATE TABLE enrollment_fellows (
          fellow_id TEXT PRIMARY KEY,
          sponsor_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
        );
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          fellow_id TEXT NOT NULL,
          problem_id TEXT NOT NULL,
          opened_at TEXT NOT NULL,
          closed_at TEXT,
          handback TEXT
        );
        CREATE TABLE claims (
          problem_id TEXT NOT NULL,
          id TEXT NOT NULL,
          statement TEXT NOT NULL,
          PRIMARY KEY (problem_id, id)
        );
        CREATE TABLE reviews (
          problem_id TEXT NOT NULL,
          review_id TEXT NOT NULL,
          target_claim_id TEXT NOT NULL,
          tier TEXT NOT NULL,
          verdict TEXT NOT NULL,
          capable_of_failure TEXT,
          PRIMARY KEY (problem_id, review_id)
        );
        CREATE TABLE retractions (
          retraction_id TEXT PRIMARY KEY,
          problem_id TEXT NOT NULL,
          target_object TEXT NOT NULL
        );
        CREATE TABLE evidence (
          problem_id TEXT NOT NULL,
          evidence_id TEXT NOT NULL,
          direction TEXT NOT NULL,
          PRIMARY KEY (problem_id, evidence_id)
        );
        CREATE TABLE dead_ends (
          problem_id TEXT NOT NULL,
          dead_end_id TEXT NOT NULL,
          retry_predicate TEXT NOT NULL,
          PRIMARY KEY (problem_id, dead_end_id)
        );
        CREATE TABLE idempotency (
          problem_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          PRIMARY KEY (problem_id, idempotency_key)
        );
        CREATE TABLE reports (
          report_id TEXT PRIMARY KEY,
          problem_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          note TEXT
        );

        INSERT INTO problems VALUES
          ('P-PUB', 2, '2026-11-20T00:00:00.000Z', '2026-11-20T02:00:00.000Z', 'active', 0, 'usr_alpha_0001'),
          ('P-DRAFT', 0, '2026-11-20T00:00:00.000Z', '2026-11-20T01:00:00.000Z', 'private-draft', 0, 'usr_alpha_0001'),
          ('P-UNLIST', 1, '2026-11-20T00:00:00.000Z', '2026-11-20T01:00:00.000Z', 'active', 1, 'usr_alpha_0001');

        INSERT INTO enrollment_fellows VALUES
          ('F-01AAAAAAAAAAAAAAAAAAAAAAAA', 'usr_alpha_0001', 'active'),
          ('F-01BBBBBBBBBBBBBBBBBBBBBBBB', 'usr_beta_0002', 'active');

        -- Only P-PUB sessions should count; P-DRAFT and P-UNLIST must be excluded by Rule A2!
        INSERT INTO sessions VALUES
          ('S-PUB-1', 'F-01AAAAAAAAAAAAAAAAAAAAAAAA', 'P-PUB', '2026-11-20T00:10:00.000Z', '2026-11-20T00:40:00.000Z', 'Public handback'),
          ('S-DRAFT-1', 'F-01AAAAAAAAAAAAAAAAAAAAAAAA', 'P-DRAFT', '2026-11-20T00:15:00.000Z', '2026-11-20T00:45:00.000Z', 'Private handback'),
          ('S-UNLIST-1', 'F-01BBBBBBBBBBBBBBBBBBBBBBBB', 'P-UNLIST', '2026-11-20T00:20:00.000Z', '2026-11-20T00:50:00.000Z', 'Unlisted handback');

        INSERT INTO claims VALUES
          ('P-PUB', 'C-1', 'Public claim with only assertion-only review'),
          ('P-PUB', 'C-2', 'Public retracted claim'),
          ('P-DRAFT', 'C-1', 'Private draft claim never counted'),
          ('P-UNLIST', 'C-1', 'Unlisted claim never counted');

        -- R-ASSERT has NULL capable_of_failure (assertion-only per P5) -> must NOT elevate C-1 out of open!
        -- R-DRAFT belongs to private-draft -> must NOT count anywhere!
        INSERT INTO reviews VALUES
          ('P-PUB', 'R-ASSERT', 'C-1', 'T2', 'confirm', NULL),
          ('P-PUB', 'R-RET', 'C-2', 'T2', 'confirm', 'Would fail if n=2 counterexample existed'),
          ('P-DRAFT', 'R-DRAFT', 'C-1', 'T2', 'reproduces', 'Counterexample check');

        INSERT INTO retractions VALUES ('RET-1', 'P-PUB', 'C-2');

        INSERT INTO evidence VALUES
          ('P-PUB', 'E-1', 'reproduces'),
          ('P-DRAFT', 'E-2', 'fails-to-reproduce'),
          ('P-UNLIST', 'E-3', 'fails-to-reproduce');

        INSERT INTO dead_ends VALUES
          ('P-PUB', 'DE-1', 'Retry when lemma 2 lands'),
          ('P-DRAFT', 'DE-2', 'Private dead end never counted');

        INSERT INTO idempotency VALUES
          ('P-PUB', 'k-pub'),
          ('P-DRAFT', 'k-draft'),
          ('P-UNLIST', 'k-unlist');

        -- Canonical POST /v1/reports uses reason='integrity' with a note mentioning false-solved.
        INSERT INTO reports VALUES
          ('RP-1', 'P-PUB', 'integrity', 'Claim banner reads like a false solved announcement.'),
          ('RP-2', 'P-PUB', 'integrity', 'Citation locator broken, not a solved issue.'),
          ('RP-3', 'P-DRAFT', 'integrity', 'False-solved note on private draft never counted.');
      `);

      const stats = await loadPlatformStats(sqliteAsD1(sql));
      expect(stats.collaboration.public_problems).toBe(1);
      expect(stats.ergonomics.sessions_opened).toBe(1);
      expect(stats.ergonomics.sessions_closed).toBe(1);
      expect(stats.collaboration.handback_completion_rate).toEqual({
        numerator: 1,
        denominator: 1,
        rate: 1,
      });
      expect(stats.quality.claims_total).toBe(2);
      expect(stats.quality.claims_by_disposition).toEqual({
        open: 1,
        retracted: 1,
      });
      expect(stats.quality.reproduction_pass_rate).toEqual({
        numerator: 1,
        denominator: 1,
        rate: 1,
      });
      expect(stats.quality.dead_ends_recorded).toBe(1);
      expect(stats.ergonomics.idempotent_writes_recorded).toBe(1);
      expect(stats.comprehension.false_solved_reports_recorded).toBe(1);
    } finally {
      sql.close();
    }
  });
});

describe("Fable §13.3 12 Named Operational Incident Runbooks (asimposiumorg-rc-stats-runbooks-cost-model-w4tz)", () => {
  const REQUIRED_RUNBOOKS = [
    "credential-compromise.md",
    "sponsor-account-takeover.md",
    "leaked-join-url.md",
    "doxxing-credible-threat.md",
    "malicious-artifact.md",
    "viral-false-famous-problem-solution.md",
    "outbox-backlog.md",
    "projection-corruption.md",
    "private-content-cache-leak.md",
    "restore-from-backup.md",
    "signing-key-compromise.md",
    "screening-provider-outage.md",
  ] as const;

  test("POSITIVE 3: all 12 named Fable §13.3 runbooks exist, are indexed in docs/runbooks/INDEX.md, and pass secret-leak scans", () => {
    const indexPath = resolve(REPO_ROOT, "docs/runbooks/INDEX.md");
    expect(existsSync(indexPath)).toBe(true);
    const indexText = readFileSync(indexPath, "utf8");
    expect(indexText).toContain("ops:event-verify");
    expect(indexText).toContain("ops:projection-rebuild");
    expect(indexText).toContain("ops:outbox-reconcile");
    expect(indexText).toContain("ops:artifact-inventory");
    expect(indexText).toContain("ops:cache-privacy-test");
    expect(indexText).toContain("ops:backup-restore-smoke");

    for (const filename of REQUIRED_RUNBOOKS) {
      const fullPath = resolve(REPO_ROOT, "docs/runbooks", filename);
      expect(existsSync(fullPath)).toBe(true);
      expect(indexText).toContain(filename);
      const body = readFileSync(fullPath, "utf8");
      expect(body.length).toBeGreaterThan(400);
      // Confirm no accidental secrets in any runbook (P7 credential scan).
      const scan = scanFieldForCredentials("runbook", body);
      expect(scan).toEqual([]);
      // Every new runbook documents never-log hygiene and local rehearsal steps.
      if (filename !== "projection-corruption.md") {
        expect(body).toContain("Never-Log");
        expect(body).toContain("Local Workerd/D1 Rehearsal Checklist");
      }
    }
  });
});
