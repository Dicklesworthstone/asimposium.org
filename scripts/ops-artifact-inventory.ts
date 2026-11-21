#!/usr/bin/env bun
/**
 * `ops:artifact-inventory` — reconcile D1 `artifacts` / `artifact_uploads` rows
 * against R2 object inventory (manifest JSON or local R2 directory mirror),
 * flagging missing objects, orphaned R2 objects, size mismatches, and SHA-256
 * mismatches (OPS.5, Fable §10.2 & §13.3).
 *
 * Strictly read-only (`--dry-run` always). Never logs presigned URLs or private bodies.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CAS_KEY_PREFIX } from "../apps/wire/src/krater/cas.ts";
import { appendOpsAuditRecord } from "./lib/ops-audit.ts";

export interface R2ObjectEntry {
  readonly key: string;
  readonly size_bytes: number;
  readonly sha256?: string;
}

export interface ArtifactInventoryReport {
  readonly command: "ops:artifact-inventory";
  readonly mode: "dry-run";
  readonly checked_at: string;
  readonly db_artifact_count: number;
  readonly r2_object_count: number;
  readonly matched_count: number;
  readonly missing_in_r2: readonly string[];
  readonly orphaned_in_r2: readonly string[];
  readonly size_mismatches: readonly {
    readonly key: string;
    readonly expected_bytes: number;
    readonly actual_bytes: number;
  }[];
  readonly sha256_mismatches: readonly {
    readonly key: string;
    readonly expected_sha256: string;
    readonly actual_sha256: string;
  }[];
  readonly sound: boolean;
}

interface DbArtifactRow {
  r2_key: string;
  sha256: string;
  size_bytes: number;
}

function walkR2Directory(rootDir: string): R2ObjectEntry[] {
  const results: R2ObjectEntry[] = [];
  function walk(dir: string): void {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        throw new Error(`R2_MIRROR_SYMLINK_REFUSED: refusing symlink in local R2 mirror: ${name}`);
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const key = relative(rootDir, full).replaceAll("\\", "/");
        const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
        results.push({ key, size_bytes: st.size, sha256 });
      }
    }
  }
  walk(rootDir);
  return results;
}

function loadDbArtifacts(db: Database): DbArtifactRow[] {
  const tables = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name),
  );
  if (tables.has("artifacts")) {
    return db
      .prepare(
        `SELECT r2_key, sha256, size_bytes
         FROM artifacts
         WHERE r2_key IS NOT NULL
         ORDER BY r2_key ASC`,
      )
      .all() as DbArtifactRow[];
  }
  if (tables.has("artifact_uploads")) {
    return db
      .prepare(
        `SELECT (? || sha256) AS r2_key, sha256, size_bytes
         FROM artifact_uploads
         WHERE state = 'verified'
         ORDER BY sha256 ASC`,
      )
      .all(CAS_KEY_PREFIX) as DbArtifactRow[];
  }
  throw new Error("ARTIFACT_TABLE_NOT_FOUND: neither artifacts nor artifact_uploads exists");
}

export function runArtifactInventory(opts: {
  readonly sqlitePath: string;
  readonly r2ManifestPath?: string | null;
  readonly r2DirPath?: string | null;
  readonly auditLogPath?: string | null;
}): ArtifactInventoryReport {
  if (!existsSync(opts.sqlitePath)) {
    throw new Error(`SQLITE_PATH_NOT_FOUND: ${opts.sqlitePath}`);
  }
  let r2Entries: R2ObjectEntry[];
  if (opts.r2ManifestPath) {
    if (!existsSync(opts.r2ManifestPath)) {
      throw new Error(`R2_MANIFEST_NOT_FOUND: ${opts.r2ManifestPath}`);
    }
    const parsed = JSON.parse(readFileSync(opts.r2ManifestPath, "utf8")) as {
      objects?: R2ObjectEntry[];
    };
    if (!Array.isArray(parsed.objects)) {
      throw new Error("R2_MANIFEST_INVALID: expected { objects: [...] }");
    }
    r2Entries = parsed.objects;
  } else if (opts.r2DirPath) {
    if (!existsSync(opts.r2DirPath)) {
      throw new Error(`R2_DIR_NOT_FOUND: ${opts.r2DirPath}`);
    }
    r2Entries = walkR2Directory(opts.r2DirPath);
  } else {
    throw new Error("R2_SOURCE_REQUIRED: pass --r2-manifest <json> or --r2-dir <dir>");
  }

  const db = new Database(opts.sqlitePath, { readonly: true });
  try {
    const dbRows = loadDbArtifacts(db);
    const r2ByKey = new Map(r2Entries.map((o) => [o.key, o]));
    const dbKeys = new Set(dbRows.map((r) => r.r2_key));

    const missingInR2: string[] = [];
    const sizeMismatches: { key: string; expected_bytes: number; actual_bytes: number }[] = [];
    const sha256Mismatches: { key: string; expected_sha256: string; actual_sha256: string }[] = [];
    let matchedCount = 0;

    for (const row of dbRows) {
      const obj = r2ByKey.get(row.r2_key);
      if (!obj) {
        missingInR2.push(row.r2_key);
        continue;
      }
      let ok = true;
      if (obj.size_bytes !== row.size_bytes) {
        sizeMismatches.push({
          key: row.r2_key,
          expected_bytes: row.size_bytes,
          actual_bytes: obj.size_bytes,
        });
        ok = false;
      }
      if (obj.sha256 !== undefined && obj.sha256.toLowerCase() !== row.sha256.toLowerCase()) {
        sha256Mismatches.push({
          key: row.r2_key,
          expected_sha256: row.sha256.toLowerCase(),
          actual_sha256: obj.sha256.toLowerCase(),
        });
        ok = false;
      }
      if (ok) matchedCount += 1;
    }

    const orphanedInR2 = r2Entries
      .map((o) => o.key)
      .filter((k) => !dbKeys.has(k))
      .sort();

    const sound =
      missingInR2.length === 0 &&
      orphanedInR2.length === 0 &&
      sizeMismatches.length === 0 &&
      sha256Mismatches.length === 0;

    const report: ArtifactInventoryReport = {
      command: "ops:artifact-inventory",
      mode: "dry-run",
      checked_at: new Date().toISOString(),
      db_artifact_count: dbRows.length,
      r2_object_count: r2Entries.length,
      matched_count: matchedCount,
      missing_in_r2: missingInR2.sort(),
      orphaned_in_r2: orphanedInR2,
      size_mismatches: sizeMismatches,
      sha256_mismatches: sha256Mismatches,
      sound,
    };

    if (opts.auditLogPath) {
      appendOpsAuditRecord(opts.auditLogPath, {
        command: "ops:artifact-inventory",
        mode: "dry-run",
        status: sound ? "pass" : "fail",
        summary: {
          db_artifact_count: report.db_artifact_count,
          r2_object_count: report.r2_object_count,
          matched_count: report.matched_count,
          missing_count: report.missing_in_r2.length,
          orphan_count: report.orphaned_in_r2.length,
          size_mismatch_count: report.size_mismatches.length,
          sha256_mismatch_count: report.sha256_mismatches.length,
          sound,
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
  let r2ManifestPath: string | null = null;
  let r2DirPath: string | null = null;
  let auditLogPath: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sqlite") sqlitePath = argv[++i] ?? "";
    else if (arg === "--r2-manifest") r2ManifestPath = argv[++i] ?? null;
    else if (arg === "--r2-dir") r2DirPath = argv[++i] ?? null;
    else if (arg === "--audit-log") auditLogPath = argv[++i] ?? null;
    else if (arg === "--dry-run" || arg === "--json") continue;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        JSON.stringify({
          usage:
            "bun scripts/ops-artifact-inventory.ts --sqlite <path> (--r2-manifest <json> | --r2-dir <dir>) [--audit-log <path>]",
          mode: "read-only dry-run",
        }),
      );
      process.exit(0);
    }
  }

  if (!sqlitePath) {
    console.error("ERROR: --sqlite <path> is required.");
    process.exit(2);
  }

  try {
    const report = runArtifactInventory({ sqlitePath, r2ManifestPath, r2DirPath, auditLogPath });
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.sound ? 0 : 1);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
