import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runArtifactArchival } from "./archive-e2e-artifacts";

function setupTempArtifactRoot() {
  const base = mkdtempSync(join(tmpdir(), "asimp-archive-test-"));
  const e2eDir = join(base, "e2e");
  const artifactsDir = join(e2eDir, "artifacts");
  const leasesRoot = join(e2eDir, ".artifact-writer-leases");
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(leasesRoot, { recursive: true });

  const artStat = statSync(artifactsDir, { bigint: true });
  const epochName = `dev-${artStat.dev}-ino-${artStat.ino}`;
  const epochDir = join(leasesRoot, epochName);
  mkdirSync(epochDir, { recursive: true });

  return { base, e2eDir, artifactsDir, epochDir, epochName };
}

describe("race-safe POSIX openat/O_NOFOLLOW artifact archival (asimposiumorg-rc-artifact-archival-e2e-shims-luqx)", () => {
  test("self-test compiles Python helper cleanly", () => {
    const res = runArtifactArchival({
      root: "/tmp",
      olderThanDays: 7,
      dryRun: true,
      includeProtected: false,
      selfTest: true,
    });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      status: "pass",
      code: "ARCHIVAL_SELF_TEST_OK",
      deleted_files: 0,
    });
  });

  test("POSITIVE 1: acquires maintenance fence, verifies closed leases, creates SHA-256-verified archive, skips .sbh-protect, releases fence, and deletes ZERO files (Rule 1)", () => {
    const { base, e2eDir, artifactsDir, epochDir } = setupTempArtifactRoot();

    // Closed writer lease is valid.
    mkdirSync(join(epochDir, "lease-1-1-1-1", "closed"), { recursive: true });

    // Old closed run (15 days old).
    const oldRun = join(artifactsDir, "old-run-20261101");
    mkdirSync(join(oldRun, "logs"), { recursive: true });
    writeFileSync(join(oldRun, "logs", "diag.jsonl"), '{"status":"pass"}\n');
    const fifteenDaysAgo = new Date(Date.now() - 15 * 86_400_000);
    utimesSync(oldRun, fifteenDaysAgo, fifteenDaysAgo);

    // Protected run (.sbh-protect, e.g. retained Chromium 1254 cache) — must be skipped by default!
    const protectedRun = join(artifactsDir, "retained-chromium-1254");
    mkdirSync(protectedRun, { recursive: true });
    writeFileSync(join(protectedRun, ".sbh-protect"), "do not archive\n");
    writeFileSync(join(protectedRun, "bin"), "chrome");
    utimesSync(protectedRun, fifteenDaysAgo, fifteenDaysAgo);

    // Recent run (now) — skipped under --older-than-days 7.
    const recentRun = join(artifactsDir, "recent-run-today");
    mkdirSync(recentRun, { recursive: true });
    writeFileSync(join(recentRun, "fresh.json"), "{}");

    const archiveDest = join(base, "out", "e2e-archive.tar.gz");
    const res = runArtifactArchival({
      root: base,
      dest: archiveDest,
      olderThanDays: 7,
      dryRun: false,
      includeProtected: false,
      selfTest: false,
    });

    expect(res.status, `stderr=${res.stderr}\nstdout=${res.stdout}`).toBe(0);
    const record = JSON.parse(res.stdout);
    expect(record).toMatchObject({
      status: "pass",
      code: "ARTIFACT_ARCHIVAL_VERIFIED_NO_DELETE",
      selected_run_count: 1,
      skipped_protected_count: 1,
      skipped_recent_count: 1,
      file_count: 1,
      deleted_files: 0,
    });
    expect(record.archive_sha256).toMatch(/^[a-f0-9]{64}$/);

    // Maintenance fence released cleanly on exit.
    expect(existsSync(join(e2eDir, ".artifact-maintenance"))).toBe(false);

    // Manifest written and verified.
    const manifest = JSON.parse(readFileSync(`${archiveDest}.sha256.json`, "utf8"));
    expect(manifest.selected_runs).toEqual(["old-run-20261101"]);
    expect(manifest.deleted_files).toBe(0);
    expect(manifest.files_sha256["old-run-20261101/logs/diag.jsonl"]).toMatch(/^[a-f0-9]{64}$/);

    // Rule 1: ALL original source files remain untouched!
    expect(existsSync(join(oldRun, "logs", "diag.jsonl"))).toBe(true);
    expect(existsSync(join(protectedRun, "bin"))).toBe(true);
    expect(existsSync(join(recentRun, "fresh.json"))).toBe(true);
  });

  test("SHOULD-FAIL CONTROL 1: planted open current-epoch writer lease fails closed with exit 78 OPEN_WRITER_LEASE_PRESENT", () => {
    const { base, e2eDir, artifactsDir, epochDir } = setupTempArtifactRoot();
    // Open lease (no `closed/` child!).
    mkdirSync(join(epochDir, "lease-999-1-1-1"), { recursive: true });
    const oldRun = join(artifactsDir, "old-run");
    mkdirSync(oldRun, { recursive: true });
    writeFileSync(join(oldRun, "a.txt"), "hello");

    const archiveDest = join(base, "out", "blocked.tar.gz");
    const res = runArtifactArchival({
      root: base,
      dest: archiveDest,
      olderThanDays: 0,
      dryRun: false,
      includeProtected: false,
      selfTest: false,
    });

    expect(res.status).toBe(78);
    expect(JSON.parse(res.stdout)).toMatchObject({
      status: "blocked",
      code: "OPEN_WRITER_LEASE_PRESENT",
      deleted_files: 0,
    });
    expect(existsSync(archiveDest)).toBe(false);
    expect(existsSync(join(e2eDir, ".artifact-maintenance"))).toBe(false);
  });

  test("SHOULD-FAIL CONTROL 2: planted symlink inside artifact dir fails closed with SYMLINK_TRAVERSAL_REFUSED", () => {
    const { base, e2eDir, artifactsDir } = setupTempArtifactRoot();
    const evilRun = join(artifactsDir, "run-with-symlink");
    mkdirSync(evilRun, { recursive: true });
    symlinkSync("/etc/hostname", join(evilRun, "escape-link"));

    const res = runArtifactArchival({
      root: base,
      olderThanDays: 0,
      dryRun: true,
      includeProtected: false,
      selfTest: false,
    });

    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout)).toMatchObject({
      status: "fail",
      code: "SYMLINK_TRAVERSAL_REFUSED",
      deleted_files: 0,
    });
    expect(existsSync(join(e2eDir, ".artifact-maintenance"))).toBe(false);
  });

  test("SHOULD-FAIL CONTROL 3: refuses existing maintenance fence or destination inside e2e/artifacts", () => {
    const { base, e2eDir, artifactsDir } = setupTempArtifactRoot();

    // Destination inside e2e/artifacts refused before touching fence.
    const insideDest = runArtifactArchival({
      root: base,
      dest: join(artifactsDir, "bad.tar.gz"),
      olderThanDays: 0,
      dryRun: false,
      includeProtected: false,
      selfTest: false,
    });
    expect(insideDest.status).toBe(64);
    expect(JSON.parse(insideDest.stdout).code).toBe("ARCHIVE_DEST_INSIDE_ARTIFACTS");

    // Pre-existing maintenance fence refused without removing it!
    mkdirSync(join(e2eDir, ".artifact-maintenance"), { mode: 0o700 });
    const fenced = runArtifactArchival({
      root: base,
      olderThanDays: 0,
      dryRun: true,
      includeProtected: false,
      selfTest: false,
    });
    expect(fenced.status).toBe(78);
    expect(JSON.parse(fenced.stdout).code).toBe("MAINTENANCE_FENCE_ALREADY_PRESENT");
    expect(existsSync(join(e2eDir, ".artifact-maintenance"))).toBe(true);
  });
});
