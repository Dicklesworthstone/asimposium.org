#!/usr/bin/env bun
/**
 * W10.9 Ceremony Regression Metric (`asimposiumorg-m5s`, Fable R-22 / §16.1).
 *
 * Tracks `tokens_to_first_valid_post` across Cold-Agent Gauntlet summary JSON
 * files against the 25,000-token median budget and reports trend deltas cleanly
 * for CI output. Never fabricates green when no receipts exist.
 *
 * Usage:
 *   bun scripts/ceremony-trend-check.ts --receipts <file1.json> [<file2.json> ...] \
 *     [--budget-tokens 25000] [--max-regression-pct 15]
 */

import { existsSync, readFileSync } from "node:fs";

export interface GauntletCeremonyPoint {
  readonly run_id: string;
  readonly recorded_at: string;
  readonly tokens_to_first_valid_post: number;
  readonly completed_sessions?: number;
  readonly total_sessions?: number;
}

export interface CeremonyTrendReport {
  readonly schema: "asimposium.ceremony-trend.v1";
  readonly budget_tokens: number;
  readonly max_regression_pct: number;
  readonly run_count: number;
  readonly status: "within-budget" | "over-budget" | "regression-detected" | "no-receipts";
  readonly latest_tokens: number | null;
  readonly previous_tokens: number | null;
  readonly delta_tokens: number | null;
  readonly delta_pct: number | null;
  readonly median_tokens: number | null;
  readonly min_tokens: number | null;
  readonly max_tokens: number | null;
  readonly points: readonly GauntletCeremonyPoint[];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

export function extractCeremonyPoint(
  raw: unknown,
  fallbackId: string,
): GauntletCeremonyPoint | null {
  if (raw === null || typeof raw !== "object") return null;
  const doc = raw as Record<string, unknown>;
  const tokenVal =
    typeof doc.median_tokens_to_first_valid_post === "number"
      ? doc.median_tokens_to_first_valid_post
      : typeof doc.tokens_to_first_valid_post === "number"
        ? doc.tokens_to_first_valid_post
        : typeof doc.median_tokens === "number"
          ? doc.median_tokens
          : null;
  if (tokenVal === null || !Number.isFinite(tokenVal) || tokenVal <= 0) {
    return null;
  }
  return {
    run_id: typeof doc.run_id === "string" ? doc.run_id : fallbackId,
    recorded_at:
      typeof doc.recorded_at === "string"
        ? doc.recorded_at
        : typeof doc.generated_at === "string"
          ? doc.generated_at
          : "unknown",
    tokens_to_first_valid_post: Math.round(tokenVal),
    ...(typeof doc.completed_sessions === "number"
      ? { completed_sessions: doc.completed_sessions }
      : {}),
    ...(typeof doc.total_sessions === "number" ? { total_sessions: doc.total_sessions } : {}),
  };
}

export function evaluateCeremonyTrend(
  points: readonly GauntletCeremonyPoint[],
  opts?: { readonly budgetTokens?: number; readonly maxRegressionPct?: number },
): CeremonyTrendReport {
  const budgetTokens = opts?.budgetTokens ?? 25_000;
  const maxRegressionPct = opts?.maxRegressionPct ?? 15;

  if (points.length === 0) {
    return {
      schema: "asimposium.ceremony-trend.v1",
      budget_tokens: budgetTokens,
      max_regression_pct: maxRegressionPct,
      run_count: 0,
      status: "no-receipts",
      latest_tokens: null,
      previous_tokens: null,
      delta_tokens: null,
      delta_pct: null,
      median_tokens: null,
      min_tokens: null,
      max_tokens: null,
      points: [],
    };
  }

  const ordered = [...points].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const values = ordered.map((p) => p.tokens_to_first_valid_post);
  const latestPoint = ordered[ordered.length - 1];
  const prevPoint = ordered.length >= 2 ? ordered[ordered.length - 2] : undefined;
  const latest = latestPoint ? latestPoint.tokens_to_first_valid_post : 0;
  const previous = prevPoint ? prevPoint.tokens_to_first_valid_post : null;
  const deltaTokens = previous !== null ? latest - previous : null;
  const deltaPct =
    previous !== null && previous > 0
      ? Number((((latest - previous) / previous) * 100).toFixed(2))
      : null;

  let status: CeremonyTrendReport["status"] = "within-budget";
  if (latest > budgetTokens) {
    status = "over-budget";
  } else if (deltaPct !== null && deltaPct > maxRegressionPct) {
    status = "regression-detected";
  }

  return {
    schema: "asimposium.ceremony-trend.v1",
    budget_tokens: budgetTokens,
    max_regression_pct: maxRegressionPct,
    run_count: ordered.length,
    status,
    latest_tokens: latest,
    previous_tokens: previous,
    delta_tokens: deltaTokens,
    delta_pct: deltaPct,
    median_tokens: median(values),
    min_tokens: Math.min(...values),
    max_tokens: Math.max(...values),
    points: ordered,
  };
}

export function loadCeremonyPointsFromFiles(paths: readonly string[]): GauntletCeremonyPoint[] {
  const points: GauntletCeremonyPoint[] = [];
  for (const filePath of paths) {
    if (!existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      const point = extractCeremonyPoint(parsed, filePath);
      if (point) points.push(point);
    } catch {
      // Skip malformed non-receipt files; caller inspects run_count honestly.
    }
  }
  return points;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const files: string[] = [];
  let budgetTokens = 25_000;
  let maxRegressionPct = 15;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--budget-tokens") {
      budgetTokens = Number(argv[++i] ?? "");
      if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
        console.error("ERROR: --budget-tokens must be a positive finite number.");
        process.exit(2);
      }
    } else if (arg === "--max-regression-pct") {
      maxRegressionPct = Number(argv[++i] ?? "");
      if (!Number.isFinite(maxRegressionPct) || maxRegressionPct < 0) {
        console.error("ERROR: --max-regression-pct must be a non-negative finite number.");
        process.exit(2);
      }
    } else if (arg === "--receipts") {
      while (i + 1 < argv.length) {
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) break;
        files.push(next);
        i += 1;
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun scripts/ceremony-trend-check.ts --receipts <file1.json> [...] [--budget-tokens 25000] [--max-regression-pct 15]",
      );
      process.exit(0);
    } else if (arg && !arg.startsWith("--")) {
      files.push(arg);
    }
  }

  const points = loadCeremonyPointsFromFiles(files);
  const report = evaluateCeremonyTrend(points, { budgetTokens, maxRegressionPct });
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "no-receipts") process.exit(78);
  process.exit(report.status === "within-budget" ? 0 : 1);
}
