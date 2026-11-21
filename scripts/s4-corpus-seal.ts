#!/usr/bin/env bun
/**
 * Operator helper for sealing the 20 Tier-B S-4 hard-reject corpus entries
 * (`dual-use-boundary` hard-021..hard-030 and `operational-harm`
 * hard-031..hard-040) without ever committing violating bodies into git.
 *
 * Usage:
 *   bun scripts/s4-corpus-seal.ts --hash-only /path/outside/repo/s4-tier-b.jsonl
 *   bun scripts/s4-corpus-seal.ts --template-out /path/outside/repo/s4-tier-b.jsonl
 *
 * Security guarantees:
 *   - Refuses paths inside the repository root (SEALED_CORPUS_INSIDE_REPO).
 *   - Enforces POSIX permissions <= 0600 before reading (SEALED_CORPUS_INSECURE_PERMISSIONS).
 *   - `--hash-only` outputs ONLY SHA-256 digests and corpus metadata — ZERO body text.
 */
import { closeSync, existsSync, openSync, realpathSync, writeSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { S4_CORPUS_REVISION, TIER_B_HARD_REJECT_RESERVATIONS } from "../e2e/screening/s4-corpus";
import { hashSealedCorpusFile, SealedCorpusError } from "../e2e/screening/s4-sealed-loader";

const REPO_ROOT = resolve(import.meta.dir, "..");

function isInsideDir(candidate: string, dir: string): boolean {
  const rel = relative(dir, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function writePrivateTemplate(targetPath: string): void {
  const resolved = resolve(targetPath);
  const realRepo = realpathSync(REPO_ROOT);
  const parent = dirname(resolved);
  if (!existsSync(parent)) {
    throw new SealedCorpusError("SEALED_CORPUS_UNREADABLE");
  }
  const realParent = realpathSync(parent);
  if (isInsideDir(realParent, realRepo)) {
    throw new SealedCorpusError("SEALED_CORPUS_INSIDE_REPO");
  }
  if (existsSync(resolved)) {
    throw new Error("TEMPLATE_TARGET_ALREADY_EXISTS");
  }
  const lines = TIER_B_HARD_REJECT_RESERVATIONS.map(([policy_category, id, rationale]) =>
    JSON.stringify({
      id,
      policy_category,
      rationale,
      provenance: "operator-sealed-tier-b-corpus",
      body: "",
    }),
  );
  const fd = openSync(resolved, "wx", 0o600);
  try {
    writeSync(fd, `${lines.join("\n")}\n`, null, "utf8");
  } finally {
    closeSync(fd);
  }
  process.stdout.write(
    `${JSON.stringify({
      record_type: "s4-sealed-template-created",
      corpus_revision: S4_CORPUS_REVISION,
      entry_count: TIER_B_HARD_REJECT_RESERVATIONS.length,
      mode: "0600",
      next_step:
        "Populate each non-empty body privately outside git, keep chmod 0600, then run: bun scripts/s4-corpus-seal.ts --hash-only <path>",
    })}\n`,
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const flag = argv[0];
  const filePath = argv[1];
  try {
    if (flag === "--hash-only" && filePath && argv.length === 2) {
      const summary = await hashSealedCorpusFile(filePath, { repo_root: REPO_ROOT });
      process.stdout.write(
        `${JSON.stringify({
          record_type: "s4-sealed-corpus-hashes",
          ...summary,
        })}\n`,
      );
      return 0;
    }
    if (flag === "--template-out" && filePath && argv.length === 2) {
      writePrivateTemplate(filePath);
      return 0;
    }
    process.stderr.write(
      `${JSON.stringify({
        record_type: "s4-corpus-seal-error",
        code: "USAGE_ERROR",
        usage:
          "bun scripts/s4-corpus-seal.ts --hash-only <out-of-repo-0600-jsonl> | --template-out <out-of-repo-path>",
      })}\n`,
    );
    return 64;
  } catch (error) {
    const code =
      error instanceof SealedCorpusError
        ? error.code
        : error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "SEAL_HELPER_FAILED";
    const exampleId = error instanceof SealedCorpusError ? error.example_id : undefined;
    process.stderr.write(
      `${JSON.stringify({
        record_type: "s4-corpus-seal-error",
        code,
        ...(exampleId ? { example_id: exampleId } : {}),
      })}\n`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
