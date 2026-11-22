#!/usr/bin/env bun
/**
 * `ops:cache-privacy-test` — two-user unlisted-problem / private-workshop cache
 * privacy probe (OPS.5, Fable §13.3 & §14.3).
 *
 * Proves:
 * 1. Anonymous GET before owner read returns 401/403/404 and zero canary bytes.
 * 2. Owner GET (token read ONLY from env var, never argv) returns 200 with
 *    strict private/no-store Cache-Control (never `public` or `s-maxage`).
 * 3. Other-sponsor GET (optional second env var) returns 401/403/404 and zero canary bytes.
 * 4. Post-owner anonymous GET still returns 401/403/404 and zero canary bytes
 *    (proving no shared/edge cache leaked the owner's private response).
 *
 * Strictly read-only (`--dry-run` always). Never logs tokens, headers, or private bodies.
 */

import { appendOpsAuditRecord } from "./lib/ops-audit.ts";

export interface CachePrivacyProbeStep {
  readonly actor: "anon-before" | "owner" | "other-sponsor" | "anon-after";
  readonly status: number;
  readonly cache_control: string | null;
  readonly cache_header_private_ok: boolean;
  readonly canary_leaked: boolean;
  readonly pass: boolean;
  readonly reason: string;
}

export interface CachePrivacyReport {
  readonly command: "ops:cache-privacy-test";
  readonly mode: "dry-run";
  readonly checked_at: string;
  readonly origin: string;
  readonly target_path: string;
  readonly steps: readonly CachePrivacyProbeStep[];
  readonly pass: boolean;
}

function isCacheHeaderSafeForPrivate(cacheControl: string | null): boolean {
  if (!cacheControl) return false;
  const lower = cacheControl.toLowerCase();
  if (lower.includes("public") || lower.includes("s-maxage")) {
    return false;
  }
  return lower.includes("private") || lower.includes("no-store");
}

async function probeOnce(
  url: string,
  actor: CachePrivacyProbeStep["actor"],
  bearerToken: string | null,
  canary: string | null,
  expectAllowed: boolean,
): Promise<CachePrivacyProbeStep> {
  const headers: Record<string, string> = {
    accept: "application/json, text/markdown;q=0.9, text/html;q=0.8",
  };
  if (bearerToken) {
    headers.authorization = `Bearer ${bearerToken}`;
  }
  const resp = await fetch(url, {
    method: "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await resp.text();
  const cacheControl = resp.headers.get("cache-control");
  const canaryLeaked = canary !== null && canary.length > 0 && body.includes(canary);
  const cacheSafe = isCacheHeaderSafeForPrivate(cacheControl);

  if (expectAllowed) {
    const statusOk = resp.status === 200;
    const ownerHasCanary = canary === null || canary.length === 0 || body.includes(canary);
    const pass = statusOk && cacheSafe && ownerHasCanary;
    return {
      actor,
      status: resp.status,
      cache_control: cacheControl,
      cache_header_private_ok: cacheSafe,
      canary_leaked: false,
      pass,
      reason: pass
        ? "owner read authorized with private/no-store cache policy and expected private canary"
        : !statusOk
          ? `expected 200 for owner read, got ${resp.status}`
          : !cacheSafe
            ? `private response exposed unsafe Cache-Control: ${cacheControl ?? "<missing>"}`
            : "OWNER_CANARY_ABSENT: owner 200 response lacked expected private canary (refusing vacuous cache-privacy pass)",
    };
  }

  const deniedStatus = resp.status === 401 || resp.status === 403 || resp.status === 404;
  const pass = deniedStatus && !canaryLeaked;
  return {
    actor,
    status: resp.status,
    cache_control: cacheControl,
    cache_header_private_ok: cacheSafe,
    canary_leaked: canaryLeaked,
    pass,
    reason: pass
      ? "unauthorized caller refused with zero canary leakage"
      : canaryLeaked
        ? "CRITICAL_PRIVACY_LEAK: private canary bytes appeared in unauthorized response"
        : `expected 401/403/404 for unauthorized caller, got ${resp.status}`,
  };
}

export async function runCachePrivacyTest(opts: {
  readonly origin: string;
  readonly targetPath: string;
  readonly ownerToken?: string | null;
  readonly otherToken?: string | null;
  readonly canary?: string | null;
  readonly auditLogPath?: string | null;
}): Promise<CachePrivacyReport> {
  const url = new URL(opts.targetPath, opts.origin).toString();
  const steps: CachePrivacyProbeStep[] = [];
  const canary = opts.canary ?? null;

  steps.push(await probeOnce(url, "anon-before", null, canary, false));

  if (opts.ownerToken) {
    steps.push(await probeOnce(url, "owner", opts.ownerToken, canary, true));
  }
  if (opts.otherToken) {
    steps.push(await probeOnce(url, "other-sponsor", opts.otherToken, canary, false));
  }
  steps.push(await probeOnce(url, "anon-after", null, canary, false));

  const pass = steps.every((s) => s.pass);
  const report: CachePrivacyReport = {
    command: "ops:cache-privacy-test",
    mode: "dry-run",
    checked_at: new Date().toISOString(),
    origin: opts.origin,
    target_path: opts.targetPath,
    steps,
    pass,
  };

  if (opts.auditLogPath) {
    appendOpsAuditRecord(opts.auditLogPath, {
      command: "ops:cache-privacy-test",
      mode: "dry-run",
      status: pass ? "pass" : "fail",
      summary: {
        origin: opts.origin,
        target_path: opts.targetPath,
        pass,
        statuses: steps.map((s) => ({
          actor: s.actor,
          status: s.status,
          cache_header_private_ok: s.cache_header_private_ok,
          canary_leaked: s.canary_leaked,
          pass: s.pass,
        })),
      },
    });
  }

  return report;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let origin = "";
  let targetPath = "";
  let ownerTokenEnv = "";
  let otherTokenEnv = "";
  let canaryEnv = "";
  let auditLogPath: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--origin") origin = argv[++i] ?? "";
    else if (arg === "--path") targetPath = argv[++i] ?? "";
    else if (arg === "--owner-token-env") ownerTokenEnv = argv[++i] ?? "";
    else if (arg === "--other-token-env") otherTokenEnv = argv[++i] ?? "";
    else if (arg === "--canary-env") canaryEnv = argv[++i] ?? "";
    else if (arg === "--audit-log") auditLogPath = argv[++i] ?? null;
    else if (arg === "--dry-run" || arg === "--json") continue;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        JSON.stringify({
          usage:
            "bun scripts/ops-cache-privacy-test.ts --origin <url> --path <private-path> [--owner-token-env ENV_NAME] [--other-token-env ENV_NAME] [--canary-env ENV_NAME] [--audit-log <path>]",
          note: "Tokens and canaries are read ONLY from environment variables, never CLI arguments.",
        }),
      );
      process.exit(0);
    } else {
      console.error(`ERROR: unknown argument '${arg}'`);
      process.exit(2);
    }
  }

  if (!origin || !targetPath) {
    console.error("ERROR: --origin and --path are required.");
    process.exit(2);
  }

  const readRequiredEnv = (flag: string, envName: string): string | null => {
    if (!envName) return null;
    const val = process.env[envName];
    if (!val || val.trim().length === 0) {
      console.error(`ERROR: ENV_VAR_UNSET:${envName} (referenced by ${flag})`);
      process.exit(2);
    }
    return val;
  };

  runCachePrivacyTest({
    origin,
    targetPath,
    ownerToken: readRequiredEnv("--owner-token-env", ownerTokenEnv),
    otherToken: readRequiredEnv("--other-token-env", otherTokenEnv),
    canary: readRequiredEnv("--canary-env", canaryEnv),
    auditLogPath,
  })
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.pass ? 0 : 1);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    });
}
