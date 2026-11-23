#!/usr/bin/env bun
/**
 * `ops:event-verify` — recompute canonical v2 Krater event chain digests and
 * verify signed checkpoints against a local D1 SQLite database (OPS.5, Fable §10 & §13.3).
 *
 * Strictly read-only (`--dry-run` always). Consumes zero secrets.
 * Usage:
 *   bun scripts/ops-event-verify.ts --sqlite <path> [--problem <id>] \
 *     [--verify-keys <json>] [--audit-log <path>]
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
  checkpointVerifyKeys,
  verifyCheckpointSignature,
} from "../apps/wire/src/krater/checkpoint-signing.ts";
import {
  checkpointDigest,
  eventChainMatches,
  KRATER_CHAIN_VERSION,
  type KraterEvent,
} from "../apps/wire/src/krater/krater.ts";
import { appendOpsAuditRecord } from "./lib/ops-audit.ts";

export interface ProblemEventVerifyResult {
  readonly problem_id: string;
  readonly event_count: number;
  readonly final_seq: number;
  readonly chain_valid: boolean;
  readonly checkpoints_checked: number;
  readonly checkpoints_valid: boolean;
  readonly signatures_checked: number;
  readonly signatures_valid: boolean;
  readonly failures: readonly string[];
}

export interface EventVerifyReport {
  readonly command: "ops:event-verify";
  readonly mode: "dry-run";
  readonly checked_at: string;
  readonly sqlite_path: string;
  readonly problems_checked: number;
  readonly overall_sound: boolean;
  readonly results: readonly ProblemEventVerifyResult[];
}

interface RawEventRow {
  id: string;
  problem_id: string;
  seq: number;
  type: string;
  object_kind: string;
  object_id: string;
  object_version: number;
  payload_sha256: string;
  row_digest: string | null;
  chain_digest: string | null;
  chain_version: number | null;
  created_at: string;
  actor_fellow_id: string | null;
  actor_sponsor_id: string | null;
  actor_session_id: string | null;
  model_string_self_declared: string | null;
  harness: string | null;
  writer_credential_id: string | null;
}

interface RawCheckpointRow {
  problem_id: string;
  checkpoint_seq: number;
  root_chain_digest: string;
  checkpoint_digest: string;
}

interface RawSigRow {
  checkpoint_seq: number;
  root_chain_digest: string | null;
  checkpoint_digest: string | null;
  key_id: string;
  signature: string;
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { ok: number } | null;
  return row?.ok === 1;
}

export async function runEventVerify(opts: {
  readonly sqlitePath: string;
  readonly problemId?: string | null;
  readonly verifyKeysJson?: string | null;
  readonly auditLogPath?: string | null;
}): Promise<EventVerifyReport> {
  if (!existsSync(opts.sqlitePath)) {
    throw new Error(`SQLITE_PATH_NOT_FOUND: ${opts.sqlitePath}`);
  }
  const verifyKeys = checkpointVerifyKeys(opts.verifyKeysJson ?? undefined);
  const keyMap = new Map(verifyKeys.map((k) => [k.kid, k.publicKeyHex]));
  const db = new Database(opts.sqlitePath, { readonly: true });

  try {
    const problemRows = opts.problemId
      ? [{ id: opts.problemId }]
      : (db
          .prepare("SELECT DISTINCT problem_id AS id FROM events ORDER BY problem_id ASC")
          .all() as { id: string }[]);

    const hasChainV2 = tableExists(db, "event_chain_v2");
    const hasCheckpoints = tableExists(db, "integrity_checkpoints");
    const hasSignatures = tableExists(db, "checkpoint_signatures");

    const results: ProblemEventVerifyResult[] = [];
    for (const { id: problemId } of problemRows) {
      const failures: string[] = [];
      const rows = (
        hasChainV2
          ? db
              .prepare(
                `SELECT e.id, e.problem_id, e.seq, e.type, e.object_kind, e.object_id,
                        e.object_version, e.payload_sha256,
                        ch.row_digest, ch.chain_digest, ch.chain_version,
                        e.created_at, e.actor_fellow_id, e.actor_sponsor_id,
                        e.actor_session_id, e.model_string_self_declared,
                        e.harness, e.writer_credential_id
                 FROM events e
                 LEFT JOIN event_chain_v2 ch
                   ON ch.event_id = e.id AND ch.problem_id = e.problem_id AND ch.seq = e.seq
                 WHERE e.problem_id = ?
                 ORDER BY e.seq ASC`,
              )
              .all(problemId)
          : db
              .prepare(
                `SELECT id, problem_id, seq, type, object_kind, object_id,
                        object_version, payload_sha256,
                        row_digest, chain_digest, 2 AS chain_version,
                        created_at, actor_fellow_id, actor_sponsor_id,
                        actor_session_id, model_string_self_declared,
                        harness, writer_credential_id
                 FROM events
                 WHERE problem_id = ?
                 ORDER BY seq ASC`,
              )
              .all(problemId)
      ) as RawEventRow[];

      const missingChainV2 = rows.filter((r) => !r.row_digest || !r.chain_digest);
      for (const missing of missingChainV2) {
        failures.push(
          `EVENT_CHAIN_V2_ROW_MISSING: event ${missing.id} (seq=${missing.seq}) lacks event_chain_v2 digests`,
        );
      }

      const events: KraterEvent[] = rows.map((r) => ({
        eventId: r.id,
        problemId: r.problem_id,
        seq: r.seq,
        type: r.type,
        objectKind: r.object_kind,
        objectId: r.object_id,
        objectVersion: r.object_version,
        payloadSha256: r.payload_sha256,
        rowDigest: r.row_digest ?? "",
        chainDigest: r.chain_digest ?? "",
        chainVersion: KRATER_CHAIN_VERSION,
        createdAt: r.created_at,
        actorFellowId: r.actor_fellow_id,
        actorSponsorId: r.actor_sponsor_id,
        actorSessionId: r.actor_session_id,
        modelStringSelfDeclared: r.model_string_self_declared,
        harness: r.harness,
        writerCredentialId: r.writer_credential_id,
      }));

      const chainValid = missingChainV2.length === 0 && (await eventChainMatches(events));
      if (!chainValid) {
        failures.push(
          `EVENT_CHAIN_MISMATCH: canonical v2 chain verification failed for ${problemId}`,
        );
      }

      const seqToDigest = new Map(events.map((e) => [e.seq, e.chainDigest]));
      let checkpointsChecked = 0;
      let checkpointsValid = true;
      if (hasCheckpoints) {
        const cps = db
          .prepare(
            `SELECT problem_id, checkpoint_seq, root_chain_digest, checkpoint_digest
             FROM integrity_checkpoints
             WHERE problem_id = ?
             ORDER BY checkpoint_seq ASC`,
          )
          .all(problemId) as RawCheckpointRow[];
        for (const cp of cps) {
          checkpointsChecked += 1;
          const eventDigest = seqToDigest.get(cp.checkpoint_seq);
          const expectedCpDigest = await checkpointDigest(
            problemId,
            cp.checkpoint_seq,
            cp.root_chain_digest,
          );
          if (eventDigest !== cp.root_chain_digest) {
            checkpointsValid = false;
            failures.push(
              `CHECKPOINT_ROOT_MISMATCH: seq ${cp.checkpoint_seq} root does not match event chain`,
            );
          }
          if (expectedCpDigest !== cp.checkpoint_digest) {
            checkpointsValid = false;
            failures.push(
              `CHECKPOINT_DIGEST_MISMATCH: seq ${cp.checkpoint_seq} checkpoint_digest failed recomputation`,
            );
          }
        }
      }

      let signaturesChecked = 0;
      let signaturesValid = true;
      if (hasSignatures) {
        const sigs = db
          .prepare(
            `SELECT cs.checkpoint_seq, ic.root_chain_digest, ic.checkpoint_digest,
                    cs.key_id, cs.signature
             FROM checkpoint_signatures cs
             LEFT JOIN integrity_checkpoints ic
               ON ic.problem_id = cs.problem_id AND ic.checkpoint_seq = cs.checkpoint_seq
             WHERE cs.problem_id = ?
             ORDER BY cs.checkpoint_seq ASC`,
          )
          .all(problemId) as RawSigRow[];
        for (const sig of sigs) {
          if (!sig.root_chain_digest || !sig.checkpoint_digest) {
            signaturesValid = false;
            failures.push(
              `CHECKPOINT_SIGNATURE_MISSING_CHECKPOINT: seq=${sig.checkpoint_seq} kid=${sig.key_id} has no matching integrity_checkpoints row`,
            );
          }
        }
        if (sigs.length > 0 && keyMap.size === 0) {
          signaturesValid = false;
          failures.push(
            `CHECKPOINT_SIGNATURES_UNVERIFIED_NO_KEYS: ${sigs.length} signature row(s) present for ${problemId} but --verify-keys was omitted`,
          );
        } else {
          for (const sig of sigs) {
            if (!sig.root_chain_digest || !sig.checkpoint_digest) {
              continue;
            }
            signaturesChecked += 1;
            const pubHex = keyMap.get(sig.key_id);
            if (!pubHex) {
              signaturesValid = false;
              failures.push(
                `CHECKPOINT_SIGNATURE_UNKNOWN_KID: kid=${sig.key_id} seq=${sig.checkpoint_seq}`,
              );
              continue;
            }
            const ok = await verifyCheckpointSignature(
              problemId,
              {
                checkpoint_seq: sig.checkpoint_seq,
                root_chain_digest: sig.root_chain_digest,
                checkpoint_digest: sig.checkpoint_digest,
                signature: sig.signature,
              },
              pubHex,
            );
            if (!ok) {
              signaturesValid = false;
              failures.push(
                `CHECKPOINT_SIGNATURE_INVALID: kid=${sig.key_id} seq=${sig.checkpoint_seq}`,
              );
            }
          }
        }
      }

      results.push({
        problem_id: problemId,
        event_count: events.length,
        final_seq: events.at(-1)?.seq ?? 0,
        chain_valid: chainValid,
        checkpoints_checked: checkpointsChecked,
        checkpoints_valid: checkpointsValid,
        signatures_checked: signaturesChecked,
        signatures_valid: signaturesValid,
        failures,
      });
    }

    const overallSound = results.every(
      (r) => r.chain_valid && r.checkpoints_valid && r.signatures_valid && r.failures.length === 0,
    );
    const report: EventVerifyReport = {
      command: "ops:event-verify",
      mode: "dry-run",
      checked_at: new Date().toISOString(),
      sqlite_path: opts.sqlitePath,
      problems_checked: results.length,
      overall_sound: overallSound,
      results,
    };

    if (opts.auditLogPath) {
      appendOpsAuditRecord(opts.auditLogPath, {
        command: "ops:event-verify",
        mode: "dry-run",
        status: overallSound ? "pass" : "fail",
        summary: {
          problems_checked: report.problems_checked,
          overall_sound: report.overall_sound,
          failure_count: results.reduce((sum, r) => sum + r.failures.length, 0),
        },
      });
    }

    return report;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let sqlitePath = "";
  let problemId: string | null = null;
  let verifyKeysJson: string | null = null;
  let auditLogPath: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sqlite") sqlitePath = argv[++i] ?? "";
    else if (arg === "--problem") problemId = argv[++i] ?? null;
    else if (arg === "--verify-keys") verifyKeysJson = argv[++i] ?? null;
    else if (arg === "--audit-log") auditLogPath = argv[++i] ?? null;
    else if (arg === "--dry-run" || arg === "--json") continue;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        JSON.stringify({
          usage:
            "bun scripts/ops-event-verify.ts --sqlite <path> [--problem <id>] [--verify-keys <json>] [--audit-log <path>]",
          mode: "read-only dry-run",
        }),
      );
      process.exit(0);
    } else {
      console.error(`ERROR: unknown argument '${arg}'`);
      process.exit(2);
    }
  }

  if (!sqlitePath) {
    console.error("ERROR: --sqlite <path> is required.");
    process.exit(2);
  }

  runEventVerify({ sqlitePath, problemId, verifyKeysJson, auditLogPath })
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.overall_sound ? 0 : 1);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    });
}
