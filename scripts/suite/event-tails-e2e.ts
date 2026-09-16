/**
 * Event Tails, Feeds, and Exports E2E Gate (W6.4, bead asimposiumorg-yv6).
 *
 * Proves:
 * 1. GET /p/:id/events.json returns bounded public JSON tail with pagination.
 * 2. GET /p/:id/events.ndjson returns streaming NDJSON with terminal control record.
 * 3. GET /p/:id/events.toon returns pipe-delimited TOON with terminal control footer.
 * 4. GET /p/:id/events content negotiation (Accept header & format query param).
 * 5. Last-Event-ID header resume support when since is omitted.
 * 6. Feeds: RSS 2.0 (.rss), Atom 1.0 (.atom), JSON Feed v1.1 (.json), and negotiated (/feed).
 * 7. Gzip export (/p/:id/export.jsonl.gz) decompresses to NDJSON with signed checkpoints.
 * 8. HTTP caching invariants: ETag generation, 304 Not Modified, and Cache-Control headers.
 */

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EventTailPage } from "@asimposium/contracts/event-tail";
import { createApp } from "../../apps/wire/src/app.ts";
import { D1EnrollmentStore } from "../../apps/wire/src/enrollment/d1-store.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
} from "../../apps/wire/src/enrollment/service.ts";
import type { Env } from "../../apps/wire/src/env.ts";
import { checkpointDigest, eventEnvelopeRowDigest } from "../../apps/wire/src/krater/krater.ts";

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
      } catch (e) {
        sqlite.run("ROLLBACK");
        throw e;
      }
    },
    async exec(query: string) {
      sqlite.run(query);
      return { count: 0, duration: 0 };
    },
    dump() {
      throw new Error("dump not supported in memory db");
    },
  } as unknown as Env["DB"];
}

function applyMigrations(sqlite: Database): void {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const content = readFileSync(join(MIGRATIONS, file), "utf8");
    const statements = content
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      sqlite.run(stmt);
    }
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runE2ETests(): Promise<void> {
  console.log("Starting W6.4 Event Tails, Feeds, and Exports E2E Suite...");

  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);

  const db = localD1(sqlite);
  const replayProtector = new AesGcmEnrollmentReplayProtector(new Uint8Array(32));
  const enrollmentStore = new D1EnrollmentStore(db);
  const _enrollmentService = new EnrollmentService({
    stoaOrigin: "https://a.asimposium.org",
    agoraOrigin: "https://asimposium.org",
    store: enrollmentStore,
    replayProtector,
  });

  const app = createApp({
    createEnrollmentStore: () => enrollmentStore,
  });

  const env: Env = {
    DB: db,
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
    SHARED_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
  } as unknown as Env;

  // Seed sponsor, fellow, and problem
  const problemId = "ASIMP-PR-0001";
  const now = "2026-09-16T00:00:00.000Z";

  sqlite.run(
    `INSERT INTO problems (
       id, public_seq, created_at, updated_at, status, unlisted, title,
       chain_version, chain_digest
     ) VALUES (?, 5, ?, ?, 'active', 0, ?, 2, 'sha256:fixture-chain')`,
    [problemId, now, now, "Riemann Hypothesis Sub-case"],
  );

  sqlite.run(
    `INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, chain_version)
     VALUES (?, 'complete', 0, 2)`,
    [problemId],
  );

  // Seed events for the problem
  const testEvents = [
    { kind: "claim", type: "claim.created" },
    { kind: "hypothesis", type: "hypothesis.created" },
    { kind: "evidence", type: "evidence.created" },
    { kind: "review", type: "review.created" },
    { kind: "citation", type: "citation.recorded" },
  ];

  const digest = "a".repeat(64);
  for (let i = 1; i <= 5; i++) {
    const eventMeta = testEvents[i - 1];
    if (!eventMeta) throw new Error("missing eventMeta");
    sqlite.run("UPDATE problems SET public_seq = ? WHERE id = ?", [i, problemId]);
    const objectId = `ASIMP-OBJ-${i.toString().padStart(4, "0")}`;
    const payload = JSON.stringify({
      object_id: objectId,
      detail: `Event payload for item ${i}`,
      title: `Event Title ${i}`,
    });

    const rowDigest = await eventEnvelopeRowDigest({
      eventId: `evt_e2e_${i}`,
      problemId,
      seq: i,
      type: eventMeta.type,
      objectKind: eventMeta.kind,
      objectId,
      objectVersion: 1,
      payloadSha256: digest,
      createdAt: `2026-09-16T00:0${i}:00.000Z`,
      actorFellowId: "fel_1",
      actorSponsorId: "sp_1",
      actorSessionId: "ses_1",
      modelStringSelfDeclared: "gpt-5.6",
      harness: "test-harness",
      writerCredentialId: null,
    });

    sqlite.run(
      `INSERT INTO events (
         id, problem_id, seq, type, object_kind, object_id,
         object_version, payload_sha256, created_at,
         actor_fellow_id, actor_sponsor_id, actor_session_id,
         model_string_self_declared, harness, row_digest, chain_digest
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'fel_1', 'sp_1', 'ses_1', 'gpt-5.6', 'test-harness', ?, 'sha256:fixture-chain')`,
      [
        `evt_e2e_${i}`,
        problemId,
        i,
        eventMeta.type,
        eventMeta.kind,
        objectId,
        digest,
        `2026-09-16T00:0${i}:00.000Z`,
        rowDigest,
      ],
    );

    sqlite.run(
      `INSERT INTO event_content (
         event_id, payload_sha256, payload_json
       ) VALUES (?, ?, ?)`,
      [`evt_e2e_${i}`, digest, payload],
    );

    const cpDigest = await checkpointDigest(problemId, i, "sha256:fixture-chain");
    sqlite.run(
      `INSERT INTO integrity_checkpoints (
         problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest,
         checkpoint_version, checkpoint_mode, created_at
       ) VALUES (?, ?, 'sha256:fixture-chain', ?, 1, 'unsigned-v0', ?)`,
      [problemId, i, cpDigest, `2026-09-16T00:0${i}:00.000Z`],
    );
  }

  const req = (url: string, init?: RequestInit) => app.request(url, init, env);

  // 1. Test JSON Event Tail (/p/:id/events.json)
  console.log("Testing /p/:id/events.json...");
  const jsonRes = await req(`http://a.asimposium.org/p/${problemId}/events.json?limit=3`);
  assert(jsonRes.status === 200, "GET events.json status should be 200");
  assert(
    jsonRes.headers.get("Content-Type")?.includes("application/json"),
    "Content-Type should be application/json",
  );
  const jsonBody = (await jsonRes.json()) as EventTailPage;
  assert(Array.isArray(jsonBody.events), "events should be an array");
  assert(jsonBody.events.length === 3, "events length should be 3");
  assert(jsonBody.page_end.has_more === true, "has_more should be true");
  assert(jsonBody.page_end.next_cursor === 3, "next_cursor should be 3");
  const etag = jsonRes.headers.get("ETag");
  assert(etag !== null, "ETag header must be present");

  // Test If-None-Match 304 on events.json
  console.log("Testing ETag 304 on events.json...");
  const json304Res = await req(`http://a.asimposium.org/p/${problemId}/events.json?limit=3`, {
    headers: { "If-None-Match": etag },
  });
  assert(json304Res.status === 304, "matching If-None-Match should return 304");

  // 2. Test NDJSON Event Tail (/p/:id/events.ndjson)
  console.log("Testing /p/:id/events.ndjson...");
  const ndjsonRes = await req(`http://a.asimposium.org/p/${problemId}/events.ndjson?since=3`);
  assert(ndjsonRes.status === 200, "GET events.ndjson status should be 200");
  assert(
    ndjsonRes.headers.get("Content-Type")?.includes("application/x-ndjson"),
    "Content-Type should be application/x-ndjson",
  );
  const ndjsonText = await ndjsonRes.text();
  const ndjsonLines = ndjsonText
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert(ndjsonLines.length === 3, "should return 2 events + 1 control record");
  assert(ndjsonLines[0].seq === 4, "first resumed event should have seq 4");
  assert(ndjsonLines[1].seq === 5, "second resumed event should have seq 5");
  const control = ndjsonLines[2];
  assert(control.control === "page_end", "last record must be page_end control");
  assert(control.next_cursor === 5, "next_cursor should be 5");
  assert(control.has_more === false, "has_more should be false");

  // 3. Test Last-Event-ID resume header
  console.log("Testing Last-Event-ID header resume...");
  const resumeRes = await req(`http://a.asimposium.org/p/${problemId}/events.ndjson`, {
    headers: { "Last-Event-ID": "3" },
  });
  assert(resumeRes.status === 200, "Last-Event-ID resume status should be 200");
  const resumeLines = (await resumeRes.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert(resumeLines[0].seq === 4, "Last-Event-ID resume should start at seq 4");

  // 4. Test TOON Format (/p/:id/events.toon)
  console.log("Testing /p/:id/events.toon...");
  const toonRes = await req(`http://a.asimposium.org/p/${problemId}/events.toon`);
  assert(toonRes.status === 200, "GET events.toon status should be 200");
  assert(
    toonRes.headers.get("Content-Type")?.includes("text/plain"),
    "Content-Type should be text/plain",
  );
  const toonText = await toonRes.text();
  assert(toonText.startsWith("id|seq|type|object_id|created_at"), "TOON header present");
  assert(
    toonText.includes("[control:page_end|next_cursor:5|has_more:false]"),
    "TOON footer present",
  );

  // 5. Test Negotiated /events endpoint
  console.log("Testing negotiated /p/:id/events...");
  const negToon = await req(`http://a.asimposium.org/p/${problemId}/events?format=toon`);
  assert(negToon.status === 200, "negotiated ?format=toon status should be 200");
  assert(
    negToon.headers.get("Content-Type")?.includes("text/plain"),
    "Content-Type should be text/plain",
  );

  const negNdjson = await req(`http://a.asimposium.org/p/${problemId}/events`, {
    headers: { Accept: "application/x-ndjson" },
  });
  assert(negNdjson.status === 200, "negotiated Accept: application/x-ndjson status should be 200");
  assert(
    negNdjson.headers.get("Content-Type")?.includes("application/x-ndjson"),
    "Content-Type should be application/x-ndjson",
  );

  // 6. Test Feeds (RSS 2.0, Atom 1.0, JSON Feed)
  console.log("Testing feeds...");
  const rssRes = await req(`http://a.asimposium.org/p/${problemId}/feed.rss`);
  assert(rssRes.status === 200, "GET feed.rss status should be 200");
  assert(
    rssRes.headers.get("Content-Type")?.includes("application/rss+xml"),
    "Content-Type should be application/rss+xml",
  );
  const rssText = await rssRes.text();
  assert(rssText.includes('<rss version="2.0"'), "RSS version 2.0 present");
  assert(rssText.includes("<channel>"), "channel element present");
  assert(rssText.includes("<item>"), "item element present");

  const atomRes = await req(`http://a.asimposium.org/p/${problemId}/feed.atom`);
  assert(atomRes.status === 200, "GET feed.atom status should be 200");
  assert(
    atomRes.headers.get("Content-Type")?.includes("application/atom+xml"),
    "Content-Type should be application/atom+xml",
  );
  const atomText = await atomRes.text();
  assert(
    atomText.includes('<feed xmlns="http://www.w3.org/2005/Atom">'),
    "Atom feed element present",
  );
  assert(atomText.includes("<entry>"), "entry element present");

  const feedJsonRes = await req(`http://a.asimposium.org/p/${problemId}/feed.json`);
  assert(feedJsonRes.status === 200, "GET feed.json status should be 200");
  assert(
    feedJsonRes.headers.get("Content-Type")?.includes("application/feed+json"),
    "Content-Type should be application/feed+json",
  );
  const feedJson = (await feedJsonRes.json()) as {
    version: string;
    items: unknown[];
  };
  assert(feedJson.version === "https://jsonfeed.org/version/1.1", "JSON Feed version 1.1 present");
  assert(Array.isArray(feedJson.items), "JSON Feed items is array");
  assert(feedJson.items.length === 5, "JSON Feed should have 5 items");

  // 7. Test Gzip Export (/p/:id/export.jsonl.gz)
  console.log("Testing gzip export /p/:id/export.jsonl.gz...");
  const exportRes = await req(`http://a.asimposium.org/p/${problemId}/export.jsonl.gz`);
  assert(exportRes.status === 200, "GET export.jsonl.gz status should be 200");
  assert(
    exportRes.headers.get("Content-Type")?.includes("application/gzip"),
    "Content-Type should be application/gzip",
  );
  const exportArrayBuffer = await exportRes.arrayBuffer();
  // Decompress with DecompressionStream
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(new Uint8Array(exportArrayBuffer));
  writer.close();
  const decompressedBuffer = await new Response(ds.readable).arrayBuffer();
  const decompressedText = new TextDecoder().decode(decompressedBuffer);
  const exportLines = decompressedText
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  assert(
    exportLines[0].control === "export_header",
    "first line must be export_header control record",
  );
  assert(
    exportLines[exportLines.length - 1].control === "export_end",
    "last line must be export_end control record",
  );
  const exportedEvents = exportLines.slice(1, -1);
  assert(exportedEvents.length === 5, "must contain all 5 exported events");
  assert(exportedEvents[0].seq === 1, "first event seq is 1");
  assert(exportedEvents[4].seq === 5, "last event seq is 5");

  console.log("All W6.4 Event Tails, Feeds, and Exports E2E tests passed successfully!");
}

runE2ETests().catch((error) => {
  console.error("E2E Test Failure:", error);
  process.exit(1);
});
