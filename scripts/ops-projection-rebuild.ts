#!/usr/bin/env bun
/**
 * `ops:projection-rebuild` — compare stored claim projections against a pure
 * replay of the authoritative event log (Rule A6: log wins on disagreement),
 * using `doctorProjections` from `apps/wire/src/krater/doctor.ts` (OPS.5, Fable §13.3).
 *
 * Defaults to `--dry-run` (read-only). Mutating `--apply` requires `--reason`
 * AND `--step-up-confirm "rebuild-projections:<problemId>"`.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { doctorProjections, type ProjectionDoctorReport } from "../apps/wire/src/krater/doctor.ts";
import {
  type ClaimProjection,
  KRATER_CHAIN_VERSION,
  type KraterEvent,
  replayClaimProjections,
} from "../apps/wire/src/krater/krater.ts";
import { appendOpsAuditRecord, assertMutationAuthorized } from "./lib/ops-audit.ts";

export interface ProjectionRebuildReport {
  readonly command: "ops:projection-rebuild";
  readonly mode: "dry-run" | "apply";
  readonly checked_at: string;
  readonly problem_id: string;
  readonly before: ProjectionDoctorReport;
  readonly applied_rebuilds: readonly string[];
  readonly after: ProjectionDoctorReport;
}

interface EventRow {
  id: string;
  problem_id: string;
  seq: number;
  type: string;
  object_kind: string;
  object_id: string;
  object_version: number;
  payload_sha256: string;
  row_digest: string;
  chain_digest: string;
  created_at: string;
  actor_fellow_id: string | null;
  actor_sponsor_id: string | null;
  actor_session_id: string | null;
  model_string_self_declared: string | null;
  harness: string | null;
  writer_credential_id: string | null;
}

interface StoredClaimRow {
  id: string;
  problem_id: string;
  source_seq: number;
  projection_version: number;
  build_digest: string;
  stale: number;
}

function loadProblemEventsAndClaims(
  db: Database,
  problemId: string,
): { readonly events: KraterEvent[]; readonly stored: ClaimProjection[] } {
  const hasV2 =
    (
      db
        .prepare(
          "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'event_chain_v2'",
        )
        .get() as { ok: number } | null
    )?.ok === 1;

  const eventRows = (
    hasV2
      ? db
          .prepare(
            `SELECT e.id, e.problem_id, e.seq, e.type, e.object_kind, e.object_id,
                    e.object_version, e.payload_sha256,
                    ch.row_digest, ch.chain_digest,
                    e.created_at, e.actor_fellow_id, e.actor_sponsor_id,
                    e.actor_session_id, e.model_string_self_declared,
                    e.harness, e.writer_credential_id
             FROM events e
             JOIN event_chain_v2 ch
               ON ch.event_id = e.id AND ch.problem_id = e.problem_id AND ch.seq = e.seq
             WHERE e.problem_id = ?
             ORDER BY e.seq ASC`,
          )
          .all(problemId)
      : db
          .prepare(
            `SELECT id, problem_id, seq, type, object_kind, object_id,
                    object_version, payload_sha256,
                    row_digest, chain_digest,
                    created_at, actor_fellow_id, actor_sponsor_id,
                    actor_session_id, model_string_self_declared,
                    harness, writer_credential_id
             FROM events
             WHERE problem_id = ?
             ORDER BY seq ASC`,
          )
          .all(problemId)
  ) as EventRow[];

  const claimRows = db
    .prepare(
      `SELECT id, problem_id, source_seq, projection_version, build_digest, stale
       FROM claims
       WHERE problem_id = ?
       ORDER BY id ASC`,
    )
    .all(problemId) as StoredClaimRow[];

  const events: KraterEvent[] = eventRows.map((r) => ({
    eventId: r.id,
    problemId: r.problem_id,
    seq: r.seq,
    type: r.type,
    objectKind: r.object_kind,
    objectId: r.object_id,
    objectVersion: r.object_version,
    payloadSha256: r.payload_sha256,
    rowDigest: r.row_digest,
    chainDigest: r.chain_digest,
    chainVersion: KRATER_CHAIN_VERSION,
    createdAt: r.created_at,
    actorFellowId: r.actor_fellow_id,
    actorSponsorId: r.actor_sponsor_id,
    actorSessionId: r.actor_session_id,
    modelStringSelfDeclared: r.model_string_self_declared,
    harness: r.harness,
    writerCredentialId: r.writer_credential_id,
  }));

  const stored: ClaimProjection[] = claimRows.map((c) => ({
    claimId: c.id,
    problemId: c.problem_id,
    sourceSeq: c.source_seq,
    projectionVersion: c.projection_version,
    buildDigest: c.build_digest,
    stale: c.stale !== 0,
  }));

  return { events, stored };
}

export function runProjectionRebuild(opts: {
  readonly sqlitePath: string;
  readonly problemId: string;
  readonly apply?: boolean;
  readonly reason?: string | null;
  readonly stepUpConfirm?: string | null;
  readonly auditLogPath?: string | null;
}): ProjectionRebuildReport {
  if (!existsSync(opts.sqlitePath)) {
    throw new Error(`SQLITE_PATH_NOT_FOUND: ${opts.sqlitePath}`);
  }
  const apply = opts.apply === true;
  assertMutationAuthorized({
    apply,
    reason: opts.reason ?? null,
    stepUpConfirm: opts.stepUpConfirm ?? null,
    expectedStepUp: `rebuild-projections:${opts.problemId}`,
    command: "ops:projection-rebuild",
  });

  const db = new Database(opts.sqlitePath, { readonly: !apply });
  try {
    const initial = loadProblemEventsAndClaims(db, opts.problemId);
    const before = doctorProjections(opts.problemId, initial.events, initial.stored);
    const appliedRebuilds: string[] = [];

    if (apply && !before.sound) {
      const replayed = replayClaimProjections(initial.events);
      const replayedById = new Map(replayed.map((p) => [p.claimId, p]));
      const updateStmt = db.prepare(
        `UPDATE claims
         SET source_seq = ?, projection_version = ?, build_digest = ?, stale = ?
         WHERE problem_id = ? AND id = ?`,
      );
      const insertStmt = db.prepare(
        `INSERT INTO claims (id, problem_id, source_seq, projection_version, build_digest, stale)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const deleteOrphanStmt = db.prepare("DELETE FROM claims WHERE problem_id = ? AND id = ?");
      const storedIds = new Set(initial.stored.map((c) => c.claimId));

      db.exec("BEGIN IMMEDIATE");
      try {
        for (const claimId of before.rebuildSet) {
          const expected = replayedById.get(claimId);
          if (expected) {
            if (storedIds.has(claimId)) {
              updateStmt.run(
                expected.sourceSeq,
                expected.projectionVersion,
                expected.buildDigest,
                expected.stale ? 1 : 0,
                opts.problemId,
                claimId,
              );
            } else {
              insertStmt.run(
                claimId,
                opts.problemId,
                expected.sourceSeq,
                expected.projectionVersion,
                expected.buildDigest,
                expected.stale ? 1 : 0,
              );
            }
          } else {
            deleteOrphanStmt.run(opts.problemId, claimId);
          }
          appliedRebuilds.push(claimId);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }

    const post = apply ? loadProblemEventsAndClaims(db, opts.problemId) : initial;
    const after = apply ? doctorProjections(opts.problemId, post.events, post.stored) : before;

    const report: ProjectionRebuildReport = {
      command: "ops:projection-rebuild",
      mode: apply ? "apply" : "dry-run",
      checked_at: new Date().toISOString(),
      problem_id: opts.problemId,
      before,
      applied_rebuilds: appliedRebuilds,
      after,
    };

    if (opts.auditLogPath) {
      appendOpsAuditRecord(opts.auditLogPath, {
        command: "ops:projection-rebuild",
        mode: report.mode,
        reason: opts.reason ?? null,
        status: after.sound ? "pass" : "fail",
        summary: {
          problem_id: opts.problemId,
          before_sound: before.sound,
          after_sound: after.sound,
          drift_count: before.drift.length,
          applied_count: appliedRebuilds.length,
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
  let problemId = "";
  let apply = false;
  let reason: string | null = null;
  let stepUpConfirm: string | null = null;
  let auditLogPath: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sqlite") sqlitePath = argv[++i] ?? "";
    else if (arg === "--problem") problemId = argv[++i] ?? "";
    else if (arg === "--apply") apply = true;
    else if (arg === "--dry-run" || arg === "--json") continue;
    else if (arg === "--reason") reason = argv[++i] ?? null;
    else if (arg === "--step-up-confirm") stepUpConfirm = argv[++i] ?? null;
    else if (arg === "--audit-log") auditLogPath = argv[++i] ?? null;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        JSON.stringify({
          usage:
            "bun scripts/ops-projection-rebuild.ts --sqlite <path> --problem <id> [--dry-run | --apply --reason '...' --step-up-confirm 'rebuild-projections:<id>'] [--audit-log <path>]",
        }),
      );
      process.exit(0);
    }
  }

  if (!sqlitePath || !problemId) {
    console.error("ERROR: --sqlite and --problem are required.");
    process.exit(2);
  }

  try {
    const report = runProjectionRebuild({
      sqlitePath,
      problemId,
      apply,
      reason,
      stepUpConfirm,
      auditLogPath,
    });
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.after.sound ? 0 : 1);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
