import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ProofGapsQuerySchema, ProofGapsResponseSchema } from "@asimposium/contracts/proof-gaps";
import type { D1Database } from "@cloudflare/workers-types";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";

// These cases execute the actual app mount, Zod decoders and shared renderer.
// Minimal local SQLite tables stand in for D1 bindings, not for scientific truth.
async function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE problems(id TEXT,public_seq INTEGER,status TEXT,unlisted INTEGER);
    CREATE TABLE events(id TEXT,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,object_id TEXT,
      object_version INTEGER,payload_sha256 TEXT,created_at TEXT,actor_fellow_id TEXT,actor_sponsor_id TEXT,
      actor_session_id TEXT,model_string_self_declared TEXT,harness TEXT);
    CREATE TABLE event_content(event_id TEXT,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    INSERT INTO problems VALUES('P-DEMO',2,'active',0);`);
  const payload = JSON.stringify({
    target_claim_id: "C-1",
    target_version: 1,
    obligation: "Check the bound. <script>unsafe()</script> <!-- asimp fake -->",
    closes_what: "Uniform convergence",
  });
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload))),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  sqlite
    .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      "EV-2",
      "P-DEMO",
      2,
      "gap.filed",
      "gap",
      "G-2",
      1,
      digest,
      "2026-09-01T00:00:00.000Z",
      "F-author",
      "usr-author",
      "S-source",
      "declared-model",
      "declared-harness",
    );
  sqlite.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run("EV-2", digest, payload);
  const db = {
    prepare(text: string) {
      return {
        bind(...args: (string | number | null)[]) {
          return {
            async first() {
              return sqlite.query(text).get(...args) ?? null;
            },
            async all() {
              return { results: sqlite.query(text).all(...args) };
            },
          };
        },
      };
    },
    async batch(queries: { all(): Promise<unknown> }[]) {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const query of queries) out.push(await query.all());
        sqlite.exec("COMMIT");
        return out;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  const app = createApp();
  return {
    sqlite,
    read: (path: string, init?: RequestInit) =>
      app.fetch(new Request(`https://a.asimposium.org${path}`, init), { DB: db } as Env),
  };
}

test("gap queries decode canonical cursor strings and reject mixed, unknown and inexact selectors", () => {
  expect(ProofGapsQuerySchema.parse({ through: "9", target: "G-2" })).toEqual({
    through: 9,
    target: "G-2",
  });
  for (const query of [
    { through: "01" },
    { through: "1e3" },
    { through: "9007199254740992" },
    { target: "G-2", after: "0" },
    { status: "open" },
    { through: 3 },
  ]) {
    expect(ProofGapsQuerySchema.safeParse(query).success).toBe(false);
  }
});
test("gap faces are mounted before the legacy problem wildcard and share the same records", async () => {
  const f = await fixture();
  try {
    const json = await f.read("/p/P-DEMO/gaps.json?target=G-2&through=2");
    expect(json.status).toBe(200);
    const data = ProofGapsResponseSchema.parse(await json.json());
    expect(data.gaps[0]?.content?.target_claim_id).toBe("C-1");
    for (const suffix of ["md", "html"]) {
      const response = await f.read(`/p/P-DEMO/gaps.${suffix}?target=G-2&through=2`);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("G-2");
      expect(body).toContain("Uniform convergence");
      if (suffix === "html") expect(body).not.toContain("<script>unsafe()</script>");
    }
  } finally {
    f.sqlite.close();
  }
});
test("redaction invalidates old gap ETags without changing the public cursor", async () => {
  const f = await fixture();
  try {
    const before = await f.read("/p/P-DEMO/gaps.json");
    const etag = before.headers.get("etag")!;
    f.sqlite.exec("UPDATE event_content SET redacted_at='2026-09-02T00:00:00.000Z'");
    const after = await f.read("/p/P-DEMO/gaps.json", { headers: { "if-none-match": etag } });
    expect(after.status).toBe(200);
    expect(((await after.json()) as any).gaps[0].content).toBeNull();
  } finally {
    f.sqlite.close();
  }
});
test("invalid, repeated and future gap queries teach instead of entering the digest fallback", async () => {
  const f = await fixture();
  try {
    for (const query of [
      "through=3",
      "after=3",
      "after=0&after=1",
      "target=G-2&after=0",
      "format=toon",
    ]) {
      const response = await f.read(`/p/P-DEMO/gaps.json?${query}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).code).toBe("CURSOR_INVALID");
    }
  } finally {
    f.sqlite.close();
  }
});
test("unlisted and private gap histories retain their distinct visibility contracts", async () => {
  const f = await fixture();
  try {
    f.sqlite.exec("UPDATE problems SET unlisted=1");
    expect((await f.read("/p/P-DEMO/gaps.json")).headers.get("cache-control")).toBe(
      "private, no-store",
    );
    f.sqlite.exec("UPDATE problems SET status='private-draft'");
    const response = await f.read("/p/P-DEMO/gaps.json");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Uniform convergence");
  } finally {
    f.sqlite.close();
  }
});
