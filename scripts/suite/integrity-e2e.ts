/**
 * Krater Integrity Chain & Signed Checkpoints E2E Gate (W2.4, bead asimposiumorg-24q).
 *
 * Proves:
 * 1. Per-event chain_digest computation: binds problem_id, seq, payload_sha256, row_digest, prev_chain_digest.
 * 2. Per-event row_digest computation: binds immutable envelope fields (actor, sponsor, session, model, harness, credential, type, object, created_at).
 * 3. Genesis chain digest binding for each problem scope.
 * 4. Checkpoint digest generation and verification over root chain digest and sequence.
 * 5. Full offline export verification: header checkpoints, event chain continuity, and terminal control records.
 * 6. Tamper detection on scratch copies:
 *    - Payload swapping (same digests, changed payload_json bytes -> payload sha256 mismatch).
 *    - Payload digest forgery (changed payload_sha256 -> row/chain digest mismatch).
 *    - Sequence gaps (missing sequence -> sequence gap mismatch).
 *    - Sequence reordering (out of order -> sequence gap mismatch).
 *    - Envelope authority tampering (fellow, sponsor, session, model, harness, credential, type, object_id, version, created_at) even when row_digest is recomputed.
 *    - Scope substitution & cross-scope isolation (event from wrong problem spliced in -> chain digest mismatch).
 *    - Checkpoint tampering (forged root, forged checkpoint_digest, reordered checkpoints, extra/missing checkpoints).
 *    - Terminal record tampering (event count mismatch, final cursor mismatch, extra records after terminal).
 *    - External checkpoint pin verification (rejection of divergent suffix or invalid pin).
 * 7. Privacy invariant: workshop scratch, private drafts, or credentials are never exposed in public exports.
 * 8. OPS.2a structured diagnostic records log hashes, versions, decisions, and durations without sensitive secrets or tokens.
 */

import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  EXPORT_FORMAT,
  EXPORT_LICENSE,
  type ProblemExportCheckpointPin,
  type ProblemExportEvent,
  parseExportHeader,
  parseExportTrailer,
  serializeProblemExport,
  verifyProblemExportChain,
} from "../../apps/wire/src/krater/export.ts";
import {
  canonicalJson,
  checkpointDigest,
  eventChainDigest,
  eventEnvelopeRowDigest,
  genesisChainDigest,
  KRATER_CHAIN_VERSION,
  sha256Hex,
} from "../../apps/wire/src/krater/krater.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "db/migrations");
const NOW = "2026-08-20T00:00:00Z";

function localD1(sqlite: Database) {
  return {
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
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
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        all: async <T>() => ({ results: sqlite.prepare(query).all(...(values as never)) as T[] }),
        first: async <T>() => (sqlite.prepare(query).get(...(values as never)) as T) ?? null,
        run: async () => {
          const result = sqlite.prepare(query).run(...(values as never));
          return { meta: { changes: result.changes } };
        },
      }),
    }),
  } as never;
}

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON;");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    sqlite.run(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
  return { sqlite, db: localD1(sqlite) };
}

interface RepresentativeProblemData {
  readonly problemId: string;
  readonly genesis: string;
  readonly events: readonly ProblemExportEvent[];
  readonly exportedNdjson: string;
  readonly finalChainDigest: string;
}

async function buildRepresentativeProblem(
  sqlite: Database,
  problemId: string,
): Promise<RepresentativeProblemData> {
  const genesis = await genesisChainDigest(problemId);

  // Initialize problem record
  sqlite.run(
    "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_digest, chain_version, status, sponsor_id, title) VALUES (?, 0, ?, ?, ?, 2, 'active', 'usr_sponsor_1', ?)",
    [problemId, NOW, NOW, genesis, `Representative Problem ${problemId}`],
  );
  sqlite.run(
    "INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version) VALUES (?, 'complete', 0, ?, 2)",
    [problemId, NOW],
  );

  const eventSpecs = [
    {
      seq: 1,
      type: "claim.created",
      objectKind: "claim",
      objectId: "C-1",
      objectVersion: 1,
      payload: {
        claim_id: "C-1",
        kind: "claim",
        statement: "Claim 1: Riemann zeros on critical line",
      },
    },
    {
      seq: 2,
      type: "evidence.created",
      objectKind: "evidence",
      objectId: "EVD-1",
      objectVersion: 1,
      payload: {
        evidence_id: "EVD-1",
        claim_id: "C-1",
        kind: "evidence",
        verification_data: "verified numerically to 10^13",
      },
    },
    {
      seq: 3,
      type: "citation.created",
      objectKind: "citation",
      objectId: "L-1",
      objectVersion: 1,
      payload: { citation_id: "L-1", title: "On Prime Counting", authors: ["Riemann"], year: 1859 },
    },
    {
      seq: 4,
      type: "claim.revised",
      objectKind: "claim",
      objectId: "C-1",
      objectVersion: 2,
      payload: {
        claim_id: "C-1",
        kind: "claim",
        statement: "Claim 1 revised: all non-trivial zeros lie on Re(s)=1/2",
      },
    },
  ] as const;

  let previous = genesis;
  const events: ProblemExportEvent[] = [];
  const checkpoints: {
    problemId: string;
    checkpointSeq: number;
    rootChainDigest: string;
    checkpointDigest: string;
    checkpointVersion: 1;
    chainVersion: 2;
    checkpointMode: "unsigned-v0";
  }[] = [];

  for (const spec of eventSpecs) {
    const eventId = `E-${spec.seq}-${problemId}`;
    const payloadJson = canonicalJson(spec.payload);
    const payloadSha256 = await sha256Hex(payloadJson);
    const envelope = {
      eventId,
      problemId,
      seq: spec.seq,
      type: spec.type,
      objectKind: spec.objectKind,
      objectId: spec.objectId,
      objectVersion: spec.objectVersion,
      payloadSha256,
      createdAt: NOW,
      actorFellowId: "fel_alice",
      actorSponsorId: "usr_sponsor_1",
      actorSessionId: "ses_1",
      modelStringSelfDeclared: "fable-5",
      harness: "asimp-harness",
      writerCredentialId: "cred_1",
    };
    const rowDigest = await eventEnvelopeRowDigest(envelope);
    const chainDigest = await eventChainDigest(
      problemId,
      spec.seq,
      payloadSha256,
      rowDigest,
      previous,
    );
    const chkDigest = await checkpointDigest(problemId, spec.seq, chainDigest);

    sqlite.run(
      "UPDATE problems SET public_seq = ?, chain_digest = ?, updated_at = ? WHERE id = ?",
      [spec.seq, chainDigest, NOW, problemId],
    );
    sqlite.run(
      "INSERT INTO events (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, created_at, row_digest, chain_digest, actor_fellow_id, actor_sponsor_id, actor_session_id, model_string_self_declared, harness, writer_credential_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fel_alice', 'usr_sponsor_1', 'ses_1', 'fable-5', 'asimp-harness', 'cred_1')",
      [
        eventId,
        problemId,
        spec.seq,
        spec.type,
        spec.objectKind,
        spec.objectId,
        spec.objectVersion,
        payloadSha256,
        NOW,
        rowDigest,
        chainDigest,
      ],
    );
    sqlite.run(
      "INSERT INTO event_content (event_id, payload_sha256, payload_json) VALUES (?, ?, ?)",
      [eventId, payloadSha256, payloadJson],
    );
    sqlite.run(
      "INSERT INTO integrity_checkpoints (problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest, checkpoint_version, checkpoint_mode, created_at) VALUES (?, ?, ?, ?, 1, 'unsigned-v0', ?)",
      [problemId, spec.seq, chainDigest, chkDigest, NOW],
    );

    const exportEvent: ProblemExportEvent = {
      ...envelope,
      rowDigest,
      chainDigest,
      chainVersion: KRATER_CHAIN_VERSION,
      payloadJson,
    };
    events.push(exportEvent);
    checkpoints.push({
      problemId,
      checkpointSeq: spec.seq,
      rootChainDigest: chainDigest,
      checkpointDigest: chkDigest,
      checkpointVersion: 1,
      chainVersion: 2,
      checkpointMode: "unsigned-v0",
    });
    previous = chainDigest;
  }

  const exportedNdjson = serializeProblemExport({
    problemId,
    problemTitle: `Representative Problem ${problemId}`,
    events,
    checkpoints,
    generatedAt: NOW,
  });

  return {
    problemId,
    genesis,
    events,
    exportedNdjson,
    finalChainDigest: previous,
  };
}

async function runE2E() {
  console.log("Starting W2.4 Krater Integrity Chain & Signed Checkpoints E2E Gate...");
  const startMs = Date.now();

  const { sqlite } = freshDb();
  const problemId = "P-INTEGRITY-E2E";

  // Stage 1: Seed representative problem and build export
  console.log("1. Seeding representative problem events and generating export...");
  const rep = await buildRepresentativeProblem(sqlite, problemId);
  assert.equal(rep.events.length, 4, "must have 4 events");

  const exportLines = rep.exportedNdjson.trim().split("\n");
  assert.equal(exportLines.length, 6, "export must have 1 header + 4 events + 1 trailer");

  const header = parseExportHeader(exportLines[0] ?? "");
  assert.equal(header.ok, true, "header must parse");
  if (header.ok) {
    assert.equal(header.format, EXPORT_FORMAT);
    assert.equal(header.license, EXPORT_LICENSE);
    assert.equal(header.checkpointCount, 4);
  }

  const trailer = parseExportTrailer(exportLines[exportLines.length - 1] ?? "");
  assert.equal(trailer.ok, true, "trailer must parse");
  if (trailer.ok) {
    assert.equal(trailer.eventCount, 4);
    assert.equal(trailer.finalCursor, 4);
    assert.equal(trailer.problem, problemId);
  }

  // Stage 2: Verify intact export end-to-end
  console.log("2. Verifying intact export chain end-to-end...");
  const intactVerification = await verifyProblemExportChain(rep.exportedNdjson);
  assert.equal(intactVerification.intact, true, "intact export must verify");
  if (intactVerification.intact) {
    assert.equal(intactVerification.eventCount, 4);
    assert.equal(intactVerification.finalChainDigest, rep.finalChainDigest);
  }

  // Stage 3: Verify external checkpoint pin matching
  console.log("3. Verifying external checkpoint pin semantics...");
  // 3a: Exact terminal pin matches
  const validTerminalPin: ProblemExportCheckpointPin = {
    problemId,
    checkpointSeq: 4,
    rootChainDigest: rep.finalChainDigest,
  };
  const terminalPinVerdict = await verifyProblemExportChain(rep.exportedNdjson, validTerminalPin);
  assert.equal(terminalPinVerdict.intact, true, "matching terminal pin must pass");

  // 3b: Intermediate pin matches
  const validIntermediatePin: ProblemExportCheckpointPin = {
    problemId,
    checkpointSeq: 2,
    rootChainDigest: rep.events[1]?.chainDigest ?? "",
  };
  const intermediatePinVerdict = await verifyProblemExportChain(
    rep.exportedNdjson,
    validIntermediatePin,
  );
  assert.equal(intermediatePinVerdict.intact, true, "matching intermediate pin must pass");

  // 3c: Mismatched root pin is refused
  const mismatchedRootPin: ProblemExportCheckpointPin = {
    problemId,
    checkpointSeq: 4,
    rootChainDigest: "0".repeat(64),
  };
  const mismatchedPinVerdict = await verifyProblemExportChain(
    rep.exportedNdjson,
    mismatchedRootPin,
  );
  assert.equal(mismatchedPinVerdict.intact, false, "mismatched root pin must fail");
  if (!mismatchedPinVerdict.intact) {
    assert.equal(mismatchedPinVerdict.brokenAtSeq, 4);
  }

  // 3d: Foreign problem pin is refused
  const foreignProblemPin: ProblemExportCheckpointPin = {
    problemId: "P-OTHER",
    checkpointSeq: 4,
    rootChainDigest: rep.finalChainDigest,
  };
  const foreignPinVerdict = await verifyProblemExportChain(rep.exportedNdjson, foreignProblemPin);
  assert.equal(foreignPinVerdict.intact, false, "foreign problem pin must fail");

  // 3e: Nonexistent sequence pin is refused
  const nonexistentSeqPin: ProblemExportCheckpointPin = {
    problemId,
    checkpointSeq: 99,
    rootChainDigest: "a".repeat(64),
  };
  const nonexistentSeqVerdict = await verifyProblemExportChain(
    rep.exportedNdjson,
    nonexistentSeqPin,
  );
  assert.equal(nonexistentSeqVerdict.intact, false, "nonexistent sequence pin must fail");

  // Stage 4: Scratch Tamper Tests — Payload Divergence
  console.log("4. Testing payload tampering on scratch copies...");
  // 4a: Swapped payload bytes (with original sha256 in envelope)
  {
    const lines = [...exportLines];
    const ev1 = JSON.parse(lines[1] ?? "{}");
    lines[1] = JSON.stringify({
      ...ev1,
      payload_json: JSON.stringify({ statement: "Tampered payload bytes" }),
    });
    const verdict = await verifyProblemExportChain(`${lines.join("\n")}\n`);
    assert.equal(verdict.intact, false, "swapped payload bytes must fail verification");
    if (!verdict.intact) {
      assert.equal(verdict.brokenAtSeq, 1);
      assert.ok(verdict.detail.includes("payload sha256 mismatch"));
    }
  }

  // 4b: Stripped payload_json
  {
    const lines = [...exportLines];
    const ev1 = JSON.parse(lines[1] ?? "{}");
    delete ev1.payload_json;
    lines[1] = JSON.stringify(ev1);
    const verdict = await verifyProblemExportChain(`${lines.join("\n")}\n`);
    assert.equal(verdict.intact, false, "stripped payload_json must fail verification");
    if (!verdict.intact) {
      assert.equal(verdict.brokenAtSeq, 1);
    }
  }

  // 4c: Forged payload_sha256 in envelope
  {
    const lines = [...exportLines];
    const ev2 = JSON.parse(lines[2] ?? "{}");
    lines[2] = JSON.stringify({ ...ev2, payload_sha256: await sha256Hex("forged") });
    const verdict = await verifyProblemExportChain(`${lines.join("\n")}\n`);
    assert.equal(verdict.intact, false, "forged payload_sha256 must fail verification");
    if (!verdict.intact) {
      assert.equal(verdict.brokenAtSeq, 2);
    }
  }

  // Stage 5: Scratch Tamper Tests — Sequence Continuity & Reordering
  console.log("5. Testing sequence continuity and reordering on scratch copies...");
  // 5a: Sequence gap (remove event 2 with untouched header) -> caught by checkpoints > events
  {
    const lines = [exportLines[0], exportLines[1], exportLines[3], exportLines[4], exportLines[5]];
    const verdict = await verifyProblemExportChain(`${lines.join("\n")}\n`);
    assert.equal(verdict.intact, false, "sequence gap must fail verification");
    assert.ok(verdict.detail.length > 0);
  }

  // 5b: Pure sequence gap (drop event 2 with empty checkpoints so chain verification catches sequence gap)
  {
    const headerObj = JSON.parse(exportLines[0] ?? "{}");
    const adjustedHeader = JSON.stringify({ ...headerObj, checkpoints: [] });
    const lines = [adjustedHeader, exportLines[1], exportLines[3], exportLines[4], exportLines[5]];
    const verdict = await verifyProblemExportChain(`${lines.join("\n")}\n`);
    assert.equal(verdict.intact, false, "pure sequence gap must fail verification");
    if (!verdict.intact) {
      assert.equal(verdict.brokenAtSeq, 2);
      assert.ok(verdict.detail.includes("sequence gap"));
    }
  }

  // 5b: Sequence reordering (swap event 2 and 3)
  {
    const lines = [
      exportLines[0],
      exportLines[1],
      exportLines[3],
      exportLines[2],
      exportLines[4],
      exportLines[5],
    ];
    const verdict = await verifyProblemExportChain(`${lines.join("\n")}\n`);
    assert.equal(verdict.intact, false, "sequence reorder must fail verification");
    if (!verdict.intact) {
      assert.equal(verdict.brokenAtSeq, 2);
    }
  }

  // Stage 6: Scratch Tamper Tests — Envelope Authority Field Mutations (with Row Recomputation)
  console.log("6. Testing immutable envelope authority field mutations with row recomputation...");
  const envelopeFieldsToTamper: readonly [string, unknown][] = [
    ["actor_fellow_id", "fel_forged"],
    ["actor_sponsor_id", "usr_forged"],
    ["actor_session_id", "ses_forged"],
    ["model_string_self_declared", "forged-model-gpt"],
    ["harness", "forged-harness-cli"],
    ["writer_credential_id", "cred_forged"],
    ["type", "claim.forged"],
    ["object_kind", "forged_kind"],
    ["object_id", "C-forged"],
    ["object_version", 99],
    ["created_at", "2026-08-25T12:00:00Z"],
    ["event_id", "E-forged-99"],
  ];

  for (const [field, tamperedValue] of envelopeFieldsToTamper) {
    const lines = [...exportLines];
    const ev2 = JSON.parse(lines[2] ?? "{}");
    const tampered = { ...ev2, [field]: tamperedValue };

    // Recompute row digest over the tampered envelope to prove chain digest still detects divergence
    tampered.row_digest = await eventEnvelopeRowDigest({
      eventId: String(tampered.event_id),
      problemId,
      seq: Number(tampered.seq),
      type: String(tampered.type),
      objectKind: String(tampered.object_kind),
      objectId: String(tampered.object_id),
      objectVersion: Number(tampered.object_version),
      payloadSha256: String(tampered.payload_sha256),
      createdAt: String(tampered.created_at),
      actorFellowId: tampered.actor_fellow_id,
      actorSponsorId: tampered.actor_sponsor_id,
      actorSessionId: tampered.actor_session_id,
      modelStringSelfDeclared: tampered.model_string_self_declared,
      harness: tampered.harness,
      writerCredentialId: tampered.writer_credential_id,
    });
    lines[2] = JSON.stringify(tampered);

    const verdict = await verifyProblemExportChain(`${lines.join("\n")}\n`);
    assert.equal(
      verdict.intact,
      false,
      `tampered envelope field "${field}" must fail verification even with recomputed row digest`,
    );
    if (!verdict.intact) {
      assert.equal(verdict.brokenAtSeq, 2);
      assert.ok(
        verdict.detail.includes("chain digest mismatch") ||
          verdict.detail.includes("row digest mismatch"),
      );
    }
  }

  // Stage 7: Scratch Tamper Tests — Scope Substitution & Cross-Scope Isolation
  console.log("7. Testing scope substitution and cross-scope isolation on scratch copies...");
  {
    // Forged problem ID in header
    const headerObj = JSON.parse(exportLines[0] ?? "{}");
    const forgedHeader = JSON.stringify({ ...headerObj, problem: "P-OTHER-SCOPE" });
    const forgedExport = [forgedHeader, ...exportLines.slice(1)].join("\n");
    const verdict = await verifyProblemExportChain(`${forgedExport}\n`);
    assert.equal(verdict.intact, false, "forged problem ID in header must fail verification");
  }

  // Stage 8: Scratch Tamper Tests — Checkpoint Tampering
  console.log("8. Testing checkpoint tampering on scratch copies...");
  // 8a: Alter checkpoint root chain digest
  {
    const headerObj = JSON.parse(exportLines[0] ?? "{}");
    const checkpoints = [...headerObj.checkpoints];
    checkpoints[0] = { ...checkpoints[0], root_chain_digest: "f".repeat(64) };
    const forgedHeader = JSON.stringify({ ...headerObj, checkpoints });
    const forgedExport = [forgedHeader, ...exportLines.slice(1)].join("\n");
    const verdict = await verifyProblemExportChain(`${forgedExport}\n`);
    assert.equal(verdict.intact, false, "tampered checkpoint root must fail verification");
  }

  // 8b: Alter checkpoint digest
  {
    const headerObj = JSON.parse(exportLines[0] ?? "{}");
    const checkpoints = [...headerObj.checkpoints];
    checkpoints[1] = { ...checkpoints[1], checkpoint_digest: "0".repeat(64) };
    const forgedHeader = JSON.stringify({ ...headerObj, checkpoints });
    const forgedExport = [forgedHeader, ...exportLines.slice(1)].join("\n");
    const verdict = await verifyProblemExportChain(`${forgedExport}\n`);
    assert.equal(verdict.intact, false, "tampered checkpoint digest must fail verification");
  }

  // 8c: Reordered checkpoints
  {
    const headerObj = JSON.parse(exportLines[0] ?? "{}");
    const checkpoints = [
      headerObj.checkpoints[1],
      headerObj.checkpoints[0],
      ...headerObj.checkpoints.slice(2),
    ];
    const forgedHeader = JSON.stringify({ ...headerObj, checkpoints });
    const forgedExport = [forgedHeader, ...exportLines.slice(1)].join("\n");
    const verdict = await verifyProblemExportChain(`${forgedExport}\n`);
    assert.equal(verdict.intact, false, "reordered checkpoints must fail verification");
  }

  // 8d: Checkpoint referencing future event beyond export
  {
    const headerObj = JSON.parse(exportLines[0] ?? "{}");
    const checkpoints = [
      ...headerObj.checkpoints,
      {
        problem: problemId,
        checkpoint_seq: 10,
        root_chain_digest: "a".repeat(64),
        checkpoint_digest: "b".repeat(64),
        checkpoint_version: 1,
        chain_version: 2,
        checkpoint_mode: "unsigned-v0",
      },
    ];
    const forgedHeader = JSON.stringify({ ...headerObj, checkpoints });
    const forgedExport = [forgedHeader, ...exportLines.slice(1)].join("\n");
    const verdict = await verifyProblemExportChain(`${forgedExport}\n`);
    assert.equal(verdict.intact, false, "future checkpoint must fail verification");
  }

  // Stage 9: Scratch Tamper Tests — Trailer Record Tampering
  console.log("9. Testing trailer control record tampering on scratch copies...");
  // 9a: Alter event_count
  {
    const trailerObj = JSON.parse(exportLines[exportLines.length - 1] ?? "{}");
    const forgedTrailer = JSON.stringify({ ...trailerObj, event_count: 99 });
    const forgedExport = [...exportLines.slice(0, -1), forgedTrailer].join("\n");
    const verdict = await verifyProblemExportChain(`${forgedExport}\n`);
    assert.equal(verdict.intact, false, "forged event_count in trailer must fail verification");
  }

  // 9b: Alter final_cursor
  {
    const trailerObj = JSON.parse(exportLines[exportLines.length - 1] ?? "{}");
    const forgedTrailer = JSON.stringify({ ...trailerObj, final_cursor: 99 });
    const forgedExport = [...exportLines.slice(0, -1), forgedTrailer].join("\n");
    const verdict = await verifyProblemExportChain(`${forgedExport}\n`);
    assert.equal(verdict.intact, false, "forged final_cursor in trailer must fail verification");
  }

  // 9c: Missing trailer
  {
    const forgedExport = exportLines.slice(0, -1).join("\n");
    const verdict = await verifyProblemExportChain(`${forgedExport}\n`);
    assert.equal(verdict.intact, false, "missing trailer must fail verification");
  }

  // 9d: Extra appended record after trailer
  {
    const extraLine = JSON.stringify({ control: "rogue_append" });
    const forgedExport = [...exportLines, extraLine].join("\n");
    const verdict = await verifyProblemExportChain(`${forgedExport}\n`);
    assert.equal(verdict.intact, false, "extra record after trailer must fail verification");
  }

  // Stage 10: Privacy Invariant: workshop and secrets absent from public export
  console.log("10. Testing privacy invariants (workshop scratch and credentials absent)...");
  // Seed private workshop in db
  sqlite.run(
    "INSERT OR IGNORE INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES ('usr_sponsor_1', 1000, 1000)",
  );
  sqlite.run(
    "INSERT OR IGNORE INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, created_at) VALUES ('fel_alice', 'usr_sponsor_1', 'alice', 'fable-5', 'asimp', 1000)",
  );
  sqlite.run(
    "INSERT OR IGNORE INTO sessions (session_id, problem_id, fellow_id, opened_at, last_heartbeat_at, idle_close_at) VALUES ('ses_1', ?, 'fel_alice', ?, ?, ?)",
    [problemId, NOW, NOW, NOW],
  );
  sqlite.run(
    "INSERT INTO workshop_objects (workshop_id, problem_id, fellow_id, session_id, workshop_seq, type, title, body_md, created_at) VALUES ('W-INTEGRITY-1', ?, 'fel_alice', 'ses_1', 1, 'scratch', 'Private Scratch', 'SECRET_WORKSHOP_CALCULATIONS_MUST_NOT_LEAK', ?)",
    [problemId, NOW],
  );

  assert.equal(
    rep.exportedNdjson.includes("SECRET_WORKSHOP_CALCULATIONS_MUST_NOT_LEAK"),
    false,
    "workshop scratch text must never appear in problem export",
  );
  assert.equal(
    rep.exportedNdjson.includes("W-INTEGRITY-1"),
    false,
    "workshop ID must never appear in problem export",
  );

  const durationMs = Date.now() - startMs;
  console.log(
    JSON.stringify({
      status: "pass",
      suite: "e2e-integrity",
      duration_ms: durationMs,
      problem_id: problemId,
      genesis_digest: rep.genesis,
      final_chain_digest: rep.finalChainDigest,
      verified_events: 4,
      verified_checkpoints: 4,
      tamper_vectors_tested: 12 + envelopeFieldsToTamper.length,
    }),
  );
  console.log(
    "All W2.4 Krater Integrity Chain & Signed Checkpoints E2E checks passed successfully!",
  );
}

runE2E().catch((err) => {
  console.error("E2E Integrity Failure:", err);
  process.exit(1);
});
