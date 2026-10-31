import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { canonicalJson, PROJECTION_DOCTOR_TABLES } from "@asimposium/contracts";
import { claimContentDigest } from "../../src/krater/claim-version.ts";
import { sha256Hex } from "../../src/krater/krater.ts";
import { type LogEvent, REPLAYED_TABLES, replayProjections } from "../../src/krater/projection-replay.ts";
import { foldScientificRows, type ScientificRow } from "../../src/ledger/scientific-disposition.ts";

const problem = "P-RESTORE";
async function event(seq: number, type: string, objectId: string, objectVersion: number,
  payload: Record<string, unknown>, actorFellowId = "F-author"): Promise<LogEvent> {
  return { id: "EV-" + seq, seq, type, objectId, objectVersion,
    payloadSha256: await sha256Hex(canonicalJson(payload)), rowDigest: "a".repeat(64),
    createdAt: `2026-10-30T00:00:0${seq}.000Z`, actorFellowId, actorSponsorId: "usr_source",
    actorSessionId: "S-source", actorModel: "model/self-declared", actorHarness: "curl", payload };
}
async function fixture() {
  const claim = await event(1, "claim.created", "C-1", 1, { claim_id: "C-1", kind: "conjecture",
    statement: "Every integer is even.", falsifier: "An odd integer." });
  const evidence = await event(2, "evidence.created", "E-COUNTER", 1, {
    evidence_id: "E-COUNTER", bears_on_kind: "claim", bears_on_id: "C-1", bears_on_version: 1,
    direction: "refutes", kind: "computation", mode: "confirmatory", computed_class: "computation",
    selected_hypothesis_id: null, body_md: "Integer 1 has remainder 1 modulo 2.", source: { kind: "locator" },
  }, "F-counterexample");
  const targetDigest = await claimContentDigest({ kind: "conjecture", statement: "Every integer is even.",
    falsifier: "An odd integer." }, sha256Hex);
  const source = (row: LogEvent) => ({ event_id: row.id, digest: "sha256:" + row.payloadSha256,
    fellow_id: row.actorFellowId, sponsor_id: row.actorSponsorId });
  const concession = await event(3, "object.retracted", "R-1", 1, {
    retraction_id: "R-1", target_object: "C-1@1", retraction_kind: "self-corrected",
    reason: "The counterexample is valid; I concede this exact statement.",
    concession: { target_version: 1, target_digest: targetDigest,
      evidence: { evidence_id: "E-COUNTER", digest: "sha256:" + evidence.payloadSha256 },
      claim_source: source(claim), evidence_source: source(evidence) },
  });
  const revision = await event(4, "claim.revised", "C-1", 2, { claim_id: "C-1", base_version: 1,
    kind: "conjecture", statement: "Every even integer is divisible by two.", falsifier: "A nonzero remainder." });
  const withdrawal = await event(5, "object.retracted", "R-2", 1, {
    retraction_id: "R-2", target_object: "C-1", retraction_kind: "self-corrected", reason: "Withdraw the revised scope pending further work.",
  });
  return { claim, evidence, concession, revision, withdrawal, events: [claim, evidence, concession], targetDigest };
}

async function rowsFor(events: LogEvent[], marker: boolean): Promise<ScientificRow[]> {
  const replay = await replayProjections(problem, events);
  return events.map(row => {
    const version = row.type.startsWith("claim.") ? row.objectVersion! : 1;
    const claim = replay.rows.claim_versions.get("C-1@" + version);
    return { claim_id: "C-1", event_id: row.id, seq: row.seq, type: row.type,
      object_id: row.objectId!, object_version: row.objectVersion!, target_version: version,
      payload_sha256: row.payloadSha256!, payload_json: row.payload ? canonicalJson(row.payload) : null,
      fellow_id: row.actorFellowId!, sponsor_id: row.actorSponsorId!, created_at: row.createdAt,
      content_digest: row.type.startsWith("claim.") ? String(claim?.content_digest) : null,
      statement: row.type.startsWith("claim.") ? String(claim?.statement) : null,
      direction: typeof row.payload?.direction === "string" ? row.payload.direction : null,
      concession_event_id: marker && replay.rows.claim_concessions.has(row.id) ? row.id : null,
    };
  });
}

test("replay restores the canonical concession marker and its refuted scientific meaning", async () => {
  const f = await fixture();
  const replay = await replayProjections(problem, f.events);
  expect(replay.unreplayable).toEqual([]);
  expect(replay.rows.claim_concessions.get(f.concession.id)).toEqual({
    event_id: f.concession.id, event_sha256: f.concession.payloadSha256, problem_id: problem,
    claim_id: "C-1", claim_version: 1, claim_event_id: f.claim.id, evidence_event_id: f.evidence.id,
  });
  expect((await foldScientificRows(await rowsFor(f.events, false))).disposition).toBe("disputed");
  expect((await foldScientificRows(await rowsFor(f.events, true))).disposition).toBe("refuted");
  expect(Object.keys(REPLAYED_TABLES)).toEqual([...PROJECTION_DOCTOR_TABLES]);
  expect(Object.keys(REPLAYED_TABLES).indexOf("claim_concessions"))
    .toBe(Object.keys(REPLAYED_TABLES).indexOf("retractions") + 1);
});

test("historical concession reconstruction satisfies the real trigger after later revisions and withdrawals", async () => {
  const f = await fixture();
  const events = [...f.events, f.revision, f.withdrawal];
  const replay = await replayProjections(problem, events);
  expect(replay.unreplayable).toEqual([]);
  expect(replay.rows.claim_concessions.size).toBe(1);
  const db = new Database(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE problems(id TEXT PRIMARY KEY);
      CREATE TABLE events(id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
        object_kind TEXT, object_id TEXT, object_version INTEGER, payload_sha256 TEXT,
        actor_fellow_id TEXT, actor_sponsor_id TEXT);
      CREATE TABLE event_content(event_id TEXT, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
      CREATE TABLE claim_versions(problem_id TEXT,claim_id TEXT,version INTEGER,kind TEXT,statement TEXT,
        falsifier TEXT,content_digest TEXT,editor_fellow_id TEXT,created_at TEXT);
      CREATE TABLE retractions(retraction_id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,target_object TEXT,
        retraction_kind TEXT,reason TEXT,author_fellow_id TEXT,created_at TEXT);`);
    db.query("INSERT INTO problems VALUES (?)").run(problem);
    for (const row of events) {
      const kind = row.type.startsWith("claim.") ? "claim" : row.type.startsWith("evidence.") ? "evidence" : "retraction";
      db.query("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)").run(row.id, problem, row.seq, row.type,
        kind, row.objectId, row.objectVersion, row.payloadSha256, row.actorFellowId, row.actorSponsorId);
      db.query("INSERT INTO event_content VALUES (?,?,?,NULL)").run(row.id, row.payloadSha256, canonicalJson(row.payload));
    }
    db.exec(readFileSync(new URL("../../../../db/migrations/0129_author_concessions.sql", import.meta.url), "utf8"));
    for (const table of ["claim_versions", "retractions", "claim_concessions"] as const) {
      for (const row of replay.rows[table].values()) {
        const keys = Object.keys(row);
        db.query(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
          .run(...Object.values(row) as (string | number | null)[]);
      }
    }
    expect(db.query("SELECT * FROM claim_concessions").all()).toEqual([...replay.rows.claim_concessions.values()]);
  } finally { db.close(); }
});

test("ordinary withdrawal remains distinct from concession", async () => {
  const f = await fixture();
  const replay = await replayProjections(problem, [f.claim, f.evidence, f.withdrawal]);
  expect(replay.rows.claim_concessions.size).toBe(0);
  expect(replay.rows.retractions.get("R-2")?.target_object).toBe("C-1");
  expect(replay.unreplayable).toEqual([]);
});

test("redacted or malformed concessions cannot replay as ordinary withdrawals", async () => {
  const f = await fixture();
  for (const payload of [null, { ...f.concession.payload, concession: { target_version: 1 } }]) {
    const bad = { ...f.concession, payload };
    const replay = await replayProjections(problem, [f.claim, f.evidence, bad]);
    expect(replay.unreplayable).toContain(f.concession.id);
    expect(replay.rows.claim_concessions.size).toBe(0);
    expect(replay.rows.retractions.size).toBe(0);
  }
});

test("mismatched source authorship, evidence pins and payload bytes cannot mint a restored concession", async () => {
  const f = await fixture();
  const pin = f.concession.payload!.concession as Record<string, unknown>;
  const source = pin.evidence_source as Record<string, unknown>;
  const variants = [
    { ...pin, target_digest: "sha256:" + "0".repeat(64) },
    { ...pin, evidence_source: { ...source, fellow_id: "F-forged" } },
    { ...pin, evidence_source: { ...source, event_id: "EV-missing" } },
  ];
  for (const concession of variants) {
    const bad = await event(3, "object.retracted", "R-1", 1, { ...f.concession.payload, concession });
    const replay = await replayProjections(problem, [f.claim, f.evidence, bad]);
    expect(replay.unreplayable).toContain(bad.id);
    expect(replay.rows.claim_concessions.size).toBe(0);
  }
  const corrupted = { ...f.evidence, payload: { ...f.evidence.payload, body_md: "Altered source bytes." } };
  expect((await replayProjections(problem, [f.claim, corrupted, f.concession])).unreplayable).toContain(f.concession.id);
});

test("a concession must pin the head and counterevidence order at its own event cut", async () => {
  const f = await fixture();
  const stale = await event(5, "object.retracted", "R-1", 1, f.concession.payload!);
  const replay = await replayProjections(problem, [f.claim, f.evidence, f.revision, stale]);
  expect(replay.unreplayable).toContain(stale.id);
  expect(replay.rows.claim_concessions.size).toBe(0);
  const beforeClaim = { ...f.evidence, seq: 0 };
  expect((await replayProjections(problem, [f.claim, beforeClaim, f.concession])).unreplayable).toContain(f.concession.id);
});

test("legitimate noncanonical source bytes retain their exact digest across reconstruction", async () => {
  const f = await fixture();
  const claimBytes = " \n" + JSON.stringify(f.claim.payload, null, 2) + "\n";
  const evidenceBytes = JSON.stringify(f.evidence.payload, null, 3);
  const claim = { ...f.claim, payloadJson: claimBytes, payloadSha256: await sha256Hex(claimBytes) };
  const evidence = { ...f.evidence, payloadJson: evidenceBytes, payloadSha256: await sha256Hex(evidenceBytes) };
  const original = f.concession.payload!.concession as Record<string, unknown>;
  const payload = { ...f.concession.payload, concession: { ...original,
    claim_source: { ...(original.claim_source as object), digest: "sha256:" + claim.payloadSha256 },
    evidence_source: { ...(original.evidence_source as object), digest: "sha256:" + evidence.payloadSha256 },
    evidence: { evidence_id: evidence.objectId, digest: "sha256:" + evidence.payloadSha256 },
  } };
  const bytes = JSON.stringify(payload, null, 2);
  const concession = { ...f.concession, payload, payloadJson: bytes, payloadSha256: await sha256Hex(bytes) };
  expect(claim.payloadSha256).not.toBe(await sha256Hex(canonicalJson(claim.payload)));
  expect(evidence.payloadSha256).not.toBe(await sha256Hex(canonicalJson(evidence.payload)));
  const replay = await replayProjections(problem, [claim, evidence, concession]);
  expect(replay.unreplayable).toEqual([]);
  expect(replay.rows.claim_concessions.get(concession.id)?.event_sha256).toBe(concession.payloadSha256);
  const mismatched = { ...claim, payloadJson: claimBytes, payload: { ...claim.payload, statement: "Different statement." } };
  expect((await replayProjections(problem, [mismatched, evidence, concession])).unreplayable).toContain(concession.id);
});
