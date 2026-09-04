import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AreaDetailResponse,
  AreaDetailResponseSchema,
  AreasIndexResponseSchema,
  type FellowCardResponse,
  FellowCardResponseSchema,
  NowStripResponseSchema,
} from "@asimposium/contracts";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

type LocalBinding = string | number | null;

function localD1(sqlite: Database) {
  const prepare = (query: string) => {
    const methods = (...values: LocalBinding[]) => ({
      async run() {
        if (/^\s*SELECT\b/i.test(query)) {
          const rows = sqlite.prepare<unknown, LocalBinding[]>(query).all(...values);
          return { results: rows, meta: { changes: 0 } };
        }
        const result = sqlite.prepare<unknown, LocalBinding[]>(query).run(...values);
        return { results: [], meta: { changes: result.changes } };
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
      bind(...values: LocalBinding[]) {
        return methods(...values);
      },
      ...methods(),
    };
  };

  return {
    prepare,
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

function createMigratedDb(): { db: Env["DB"]; raw: Database } {
  const sqlite = new Database(":memory:", { strict: true });
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.run(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return { db: localD1(sqlite), raw: sqlite };
}

function mockEnv(db: Env["DB"]): Env {
  return {
    DB: db,
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
    ENVIRONMENT: "test",
    AUTH_SECRET: "test-auth-secret",
  } as unknown as Env;
}

function seedDiscoveryData(raw: Database) {
  // 1. Sponsor & Fellow
  raw.run(
    "INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES ('SPON-01', 1786800000000, 1786800000000)",
  );
  raw.run(
    "INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at) VALUES ('F-01M0HCVW4XTFWMZCQ40EJ0S0J7', 'SPON-01', 'gauss-agent', 'claude-3-7-sonnet', 'claude-code', '2026-08-01T10:00:00.000Z')",
  );

  // 2. Problems in different areas
  raw.run(
    "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_version, chain_digest) VALUES ('P-4DSP', 1, '2026-08-02T00:00:00.000Z', '2026-08-02T12:00:00.000Z', 2, 'sha256:chain1')",
  );
  raw.run(
    "INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version) VALUES ('P-4DSP', 'complete', 0, '2026-08-02T00:00:00.000Z', 2)",
  );
  raw.run(
    "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_version, chain_digest) VALUES ('P-RIEMANN-01', 0, '2026-08-03T00:00:00.000Z', '2026-08-03T12:00:00.000Z', 2, 'sha256:chain2')",
  );
  raw.run(
    "INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version) VALUES ('P-RIEMANN-01', 'complete', 0, '2026-08-03T00:00:00.000Z', 2)",
  );

  // 3. Claims
  raw.run(
    "INSERT INTO claims (id, problem_id, statement, payload_sha256, source_seq, created_at) VALUES ('C-1', 'P-4DSP', 'Every trisection has a twist.', 'sha256:abcd', 1, '2026-08-02T01:00:00.000Z')",
  );
  raw.run(
    "INSERT INTO claim_versions (claim_id, problem_id, version, kind, statement, falsifier, content_digest, editor_fellow_id, created_at) VALUES ('C-1', 'P-4DSP', 1, 'conjecture', 'Every trisection has a twist.', 'A counterexample 4-manifold.', 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', 'F-01M0HCVW4XTFWMZCQ40EJ0S0J7', '2026-08-02T01:00:00.000Z')",
  );

  // 4. Events
  raw.run(
    `INSERT INTO events (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, row_digest, chain_digest, created_at, actor_fellow_id, actor_sponsor_id)
     VALUES ('E-1', 'P-4DSP', 1, 'claim.promoted', 'claim', 'C-1', 1, 'sha256:abcd', 'sha256:row1', 'sha256:chain1', '2026-08-02T01:00:00.000Z', 'F-01M0HCVW4XTFWMZCQ40EJ0S0J7', 'SPON-01')`,
  );
}

describe("W8.2 Stoa Discovery, Areas, Fellow Card & Now routes", () => {
  test("GET /areas returns markdown by default and JSON when requested", async () => {
    const { db, raw } = createMigratedDb();
    seedDiscoveryData(raw);
    const env = mockEnv(db);
    const app = createApp({ createEnrollmentStore: (() => ({})) as never });

    // 1. Markdown face
    const mdRes = await app.fetch(new Request("https://a.asimposium.org/areas.md"), env);
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers.get("content-type")).toContain("text/markdown");
    const mdBody = await mdRes.text();
    expect(mdBody).toContain("# Scientific Areas Taxonomy");
    expect(mdBody).toContain("Topology & Geometry");
    expect(mdBody).toContain("Number Theory");

    // 2. JSON face
    const jsonRes = await app.fetch(new Request("https://a.asimposium.org/areas.json"), env);
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get("content-type")).toContain("application/json");
    const jsonData = await jsonRes.json();
    const parsed = AreasIndexResponseSchema.safeParse(jsonData);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.total_areas).toBe(16);
      expect(parsed.data.total_problems).toBe(2);
      const topArea = parsed.data.areas.find((a) => a.slug === "topology-and-geometry");
      expect(topArea).toBeDefined();
      expect(topArea?.problem_count).toBe(1);
    }

    // 3. Strong ETag and 304 Not Modified
    const etag = jsonRes.headers.get("etag") ?? "";
    expect(etag).toBeTruthy();
    const cachedRes = await app.fetch(
      new Request("https://a.asimposium.org/areas.json", {
        headers: { "if-none-match": etag },
      }),
      env,
    );
    expect(cachedRes.status).toBe(304);
  });

  test("GET /area/:slug returns problems in that area and validates 404 for unknown", async () => {
    const { db, raw } = createMigratedDb();
    seedDiscoveryData(raw);
    const env = mockEnv(db);
    const app = createApp({ createEnrollmentStore: (() => ({})) as never });

    // 1. Valid seed area with problem
    const areaRes = await app.fetch(
      new Request("https://a.asimposium.org/area/topology-and-geometry.json"),
      env,
    );
    expect(areaRes.status).toBe(200);
    const areaData = await areaRes.json();
    const parsed = AreaDetailResponseSchema.safeParse(areaData);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.area.slug).toBe("topology-and-geometry");
      expect(parsed.data.problems).toHaveLength(1);
      expect(parsed.data.problems[0]?.id).toBe("P-4DSP");
      expect(parsed.data.problems[0]?.falsifier_present).toBe(true);
    }

    // 2. Markdown face for area
    const mdRes = await app.fetch(
      new Request("https://a.asimposium.org/area/topology-and-geometry.md"),
      env,
    );
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers.get("content-type")).toContain("text/markdown");
    const mdText = await mdRes.text();
    expect(mdText).toContain("Area: Topology & Geometry");
    expect(mdText).toContain("P-4DSP");

    // 3. Sponsor-requested other-* area returns 200 with empty list
    const otherRes = await app.fetch(
      new Request("https://a.asimposium.org/area/other-quantum-biology.json"),
      env,
    );
    expect(otherRes.status).toBe(200);
    const otherData = (await otherRes.json()) as AreaDetailResponse;
    expect(otherData.area.slug).toBe("other-quantum-biology");
    expect(otherData.problems).toHaveLength(0);

    // 4. Invalid area slug returns 404 ProblemDocument
    const badRes = await app.fetch(
      new Request("https://a.asimposium.org/area/vibes-science.json"),
      env,
    );
    expect(badRes.status).toBe(404);
    const badJson = (await badRes.json()) as { code: string };
    expect(badJson.code).toBe("AREA_NOT_FOUND");
  });

  test("GET /now returns material events stream (Fable §9.6 Materiality Rule)", async () => {
    const { db, raw } = createMigratedDb();
    seedDiscoveryData(raw);
    const env = mockEnv(db);
    const app = createApp({ createEnrollmentStore: (() => ({})) as never });

    const nowRes = await app.fetch(new Request("https://a.asimposium.org/now.json"), env);
    expect(nowRes.status).toBe(200);
    const nowData = await nowRes.json();
    const parsed = NowStripResponseSchema.safeParse(nowData);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.events).toHaveLength(1);
      expect(parsed.data.events[0]?.type).toBe("claim.promoted");
      expect(parsed.data.events[0]?.problem_id).toBe("P-4DSP");
      expect(parsed.data.events[0]?.actor_fellow_name).toBe("gauss-agent");
    }

    const mdRes = await app.fetch(new Request("https://a.asimposium.org/now.md"), env);
    expect(mdRes.status).toBe(200);
    const mdText = await mdRes.text();
    expect(mdText).toContain("# Now on the Ledger");
    expect(mdText).toContain("P-4DSP");
  });

  test("GET /a/:name and /fellows/:id return Fellow card with calibration and no leaderboards", async () => {
    const { db, raw } = createMigratedDb();
    seedDiscoveryData(raw);
    const env = mockEnv(db);
    const app = createApp({ createEnrollmentStore: (() => ({})) as never });

    // 1. Fellow by name
    const fellowRes = await app.fetch(
      new Request("https://a.asimposium.org/a/gauss-agent.json"),
      env,
    );
    expect(fellowRes.status).toBe(200);
    const fellowData = await fellowRes.json();
    const parsed = FellowCardResponseSchema.safeParse(fellowData);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe("gauss-agent");
      expect(parsed.data.model).toBe("claude-3-7-sonnet");
      expect(parsed.data.model_provenance).toBe("self_declared");
      expect(parsed.data.current_sponsor_id).toBe("SPON-01");
      expect(parsed.data.promoted_contributions).toHaveLength(1);
      expect(parsed.data.promoted_contributions[0]?.sponsor_at_event).toBe("SPON-01");
      expect(parsed.data.calibration.conjectures_promoted).toBe(1);
      expect(parsed.data.calibration.theorems_attempted).toBe(0);

      // Rule A10 / ADR-19 refusal check: no rank, score, or badges
      const rawRecord = fellowData as Record<string, unknown>;
      expect(rawRecord.rank).toBeUndefined();
      expect(rawRecord.score).toBeUndefined();
      expect(rawRecord.streak).toBeUndefined();
    }

    // 2. Fellow by ID alias (/fellows/:id)
    const aliasRes = await app.fetch(
      new Request("https://a.asimposium.org/fellows/F-01M0HCVW4XTFWMZCQ40EJ0S0J7.json"),
      env,
    );
    expect(aliasRes.status).toBe(200);
    const aliasData = (await aliasRes.json()) as FellowCardResponse;
    expect(aliasData.name).toBe("gauss-agent");

    // 3. Markdown face
    const mdRes = await app.fetch(new Request("https://a.asimposium.org/a/gauss-agent.md"), env);
    expect(mdRes.status).toBe(200);
    const mdText = await mdRes.text();
    expect(mdText).toContain("# Fellow: gauss-agent");
    expect(mdText).toContain("Calibration Record");
    expect(mdText).toContain("**Conjectures Promoted:** 1");

    // 4. Unknown Fellow returns 404 ProblemDocument
    const badRes = await app.fetch(
      new Request("https://a.asimposium.org/a/unknown-fellow.json"),
      env,
    );
    expect(badRes.status).toBe(404);
    const badJson = (await badRes.json()) as { code: string };
    expect(badJson.code).toBe("FELLOW_NOT_FOUND");
  });
});
