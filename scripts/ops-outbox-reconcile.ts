#!/usr/bin/env bun
/**
 * Operator reconciliation & observability inspection tool for Krater's
 * transactional outbox (Fable §10.2, §13.3; bead cn2n).
 *
 * Consumes ZERO secrets. Defaults to --dry-run (read-only).
 * Usage:
 *   bun scripts/ops-outbox-reconcile.ts --sqlite <path-to-d1-sqlite> [--dry-run] [--json]
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
  OUTBOX_OLDEST_PENDING_AGE_ALERT_THRESHOLD_MS,
  OUTBOX_PENDING_SNAPSHOT_SQL,
  oldestPendingAge,
  oldestPendingAgeAlert,
  type PendingOutboxSnapshot,
} from "../apps/wire/src/krater/outbox-do.ts";

export interface OutboxReconcileReport {
  readonly mode: "dry-run";
  readonly observed_at: string;
  readonly sqlite_path: string;
  readonly pending: number;
  readonly quarantined_count: number;
  readonly by_kind_pending: Readonly<Record<string, number>>;
  readonly by_kind_quarantined: Readonly<Record<string, number>>;
  readonly oldest_pending_age_ms: number | null;
  readonly oldest_pending_age_status: string;
  readonly oldest_pending_age_alert: string;
  readonly oldest_pending_age_alert_threshold_ms: number;
  readonly unindexed_public_claims: number;
}

export function inspectOutboxDb(
  db: Database,
  sqlitePath: string,
  nowMs = Date.now(),
): OutboxReconcileReport {
  const nowIso = new Date(nowMs).toISOString();
  const snapshot = db
    .prepare(OUTBOX_PENDING_SNAPSHOT_SQL)
    .get(nowIso) as PendingOutboxSnapshot | null;
  if (!snapshot) throw new Error("OUTBOX_SNAPSHOT_UNAVAILABLE");
  const age = oldestPendingAge(snapshot, nowMs);
  const alert = oldestPendingAgeAlert(age.ageMs, age.status);

  const pendingByKindRows = db
    .prepare(
      "SELECT kind, COUNT(*) AS n FROM outbox WHERE state = 'pending' AND quarantined_at IS NULL GROUP BY kind ORDER BY kind ASC",
    )
    .all() as { kind: string; n: number }[];
  const quarantinedByKindRows = db
    .prepare(
      "SELECT kind, COUNT(*) AS n FROM outbox WHERE quarantined_at IS NOT NULL GROUP BY kind ORDER BY kind ASC",
    )
    .all() as { kind: string; n: number }[];

  const byKindPending: Record<string, number> = {};
  for (const r of pendingByKindRows) byKindPending[r.kind] = r.n;
  const byKindQuarantined: Record<string, number> = {};
  let quarantinedTotal = 0;
  for (const r of quarantinedByKindRows) {
    byKindQuarantined[r.kind] = r.n;
    quarantinedTotal += r.n;
  }

  let unindexedPublicClaims = 0;
  try {
    const gap = db
      .prepare(
        `SELECT COUNT(*) AS n FROM claims c
         JOIN problems p ON p.id = c.problem_id AND p.status <> 'private-draft'
         JOIN events e ON e.problem_id = c.problem_id AND e.object_kind = 'claim'
           AND e.object_id = c.id AND e.seq = c.source_seq AND e.seq <= p.public_seq
         JOIN event_content ec ON ec.event_id = e.id AND ec.payload_sha256 = e.payload_sha256
           AND ec.redacted_at IS NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM content_controls cc
           WHERE cc.state = 'hidden'
             AND (
               (cc.target_kind = 'problem' AND cc.target_id = p.id)
               OR (cc.target_kind = 'event' AND cc.target_id = e.id)
               OR (cc.target_kind = 'claim' AND cc.target_id = c.id)
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM public_claim_fts f WHERE f.claim_id = c.id AND f.problem_id = c.problem_id
         )`,
      )
      .get() as { n: number } | null;
    unindexedPublicClaims = gap?.n ?? 0;
  } catch {
    unindexedPublicClaims = 0;
  }

  return {
    mode: "dry-run",
    observed_at: nowIso,
    sqlite_path: sqlitePath,
    pending: snapshot.count,
    quarantined_count: quarantinedTotal,
    by_kind_pending: byKindPending,
    by_kind_quarantined: byKindQuarantined,
    oldest_pending_age_ms: age.ageMs,
    oldest_pending_age_status: age.status,
    oldest_pending_age_alert: alert,
    oldest_pending_age_alert_threshold_ms: OUTBOX_OLDEST_PENDING_AGE_ALERT_THRESHOLD_MS,
    unindexed_public_claims: unindexedPublicClaims,
  };
}

export function inspectOutboxSqlite(sqlitePath: string, nowMs = Date.now()): OutboxReconcileReport {
  if (!existsSync(sqlitePath)) {
    throw new Error(`SQLITE_PATH_NOT_FOUND: ${sqlitePath}`);
  }
  const db = new Database(sqlitePath, { readonly: true });
  try {
    return inspectOutboxDb(db, sqlitePath, nowMs);
  } finally {
    db.close();
  }
}

function parseArgs(argv: readonly string[]): {
  sqlitePath: string | null;
  help: boolean;
  unknownArg: string | null;
} {
  let sqlitePath: string | null = null;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--sqlite") sqlitePath = argv[++i] ?? null;
    else if (arg === "--dry-run" || arg === "--json") continue;
    else return { sqlitePath: null, help: false, unknownArg: arg };
  }
  return { sqlitePath, help, unknownArg: null };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknownArg !== null) {
    console.error(JSON.stringify({ error: "UNKNOWN_ARGUMENT", argument: args.unknownArg }));
    process.exit(2);
  }
  if (args.help || !args.sqlitePath) {
    console.log(
      JSON.stringify({
        usage: "bun scripts/ops-outbox-reconcile.ts --sqlite <path-to-d1-sqlite> [--dry-run]",
        secrets_required: false,
      }),
    );
    process.exit(args.help ? 0 : 2);
  }
  const report = inspectOutboxSqlite(args.sqlitePath);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.oldest_pending_age_alert === "at-or-above-threshold" ? 1 : 0);
}
