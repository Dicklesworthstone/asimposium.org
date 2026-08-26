import { defineConfig } from "@playwright/test";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";

if (process.env.ASIMPOSIUM_PLAYWRIGHT_ENTRY !== "1") {
  throw new Error(
    "Use e2e/run-playwright.sh so the Playwright staging preflight cannot be bypassed.",
  );
}

const claimedRepositoryRoot = process.env.ASIMPOSIUM_PLAYWRIGHT_REPOSITORY_ROOT;
const runId = process.env.ASIMPOSIUM_PLAYWRIGHT_RUN_ID;
const artifactRootIdentity = process.env.ASIMPOSIUM_PLAYWRIGHT_ARTIFACT_ROOT_IDENTITY;
const runIdentity = process.env.ASIMPOSIUM_PLAYWRIGHT_RUN_IDENTITY;
const leaseDirectory = process.env.ASIMPOSIUM_PLAYWRIGHT_LEASE_DIRECTORY;
const leaseIdentity = process.env.ASIMPOSIUM_PLAYWRIGHT_LEASE_IDENTITY;

const directDirectoryIdentity = (path: string): string | undefined => {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(path) !== path
    ) {
      return undefined;
    }
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return undefined;
  }
};

const anyNodeExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("The Playwright artifact capability could not be verified.");
  }
};

const physicalDirectory = (path: string | undefined): string | undefined => {
  if (path === undefined) return undefined;
  try {
    const canonical = realpathSync(resolve(path));
    const stat = statSync(canonical);
    if (!stat.isDirectory()) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
};

const expectedRepositoryRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
if (physicalDirectory(claimedRepositoryRoot) !== expectedRepositoryRoot) {
  throw new Error("The Playwright entry point must bind this exact repository root.");
}
if (runId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) {
  throw new Error(
    "The Playwright entry point must provide one freshly claimed run id.",
  );
}

const artifactRoot = join(expectedRepositoryRoot, "e2e", "artifacts");
const runDirectory = join(artifactRoot, runId);
if (
  artifactRootIdentity === undefined ||
  runIdentity === undefined ||
  directDirectoryIdentity(artifactRoot) !== artifactRootIdentity ||
  directDirectoryIdentity(runDirectory) !== runIdentity ||
  anyNodeExists(join(expectedRepositoryRoot, "e2e", ".artifact-maintenance"))
) {
  throw new Error("The Playwright artifact root or run claim is not current.");
}

const epochMatch = /^(\d+):(\d+)$/.exec(artifactRootIdentity);
const expectedLeaseParent =
  epochMatch === null
    ? ""
    : join(
        expectedRepositoryRoot,
        "e2e",
        ".artifact-writer-leases",
        `dev-${epochMatch[1]}-ino-${epochMatch[2]}`,
      );
if (
  leaseDirectory === undefined ||
  leaseIdentity === undefined ||
  dirname(leaseDirectory) !== expectedLeaseParent ||
  !/^lease-[0-9]+-[0-9]+-[0-9]+-[0-9]+$/.test(basename(leaseDirectory)) ||
  directDirectoryIdentity(leaseDirectory) !== leaseIdentity ||
  anyNodeExists(join(leaseDirectory, "closed"))
) {
  throw new Error("The Playwright artifact writer lease is not open.");
}

const artifactDirectory = join(runDirectory, "playwright");
if (anyNodeExists(artifactDirectory)) {
  throw new Error("The Playwright output child already exists; a fresh claim is required.");
}

export default defineConfig({
  testDir: "./playwright",
  timeout: 20_000,
  forbidOnly: true,
  retries: 0,
  reporter: [["line"]],
  outputDir: artifactDirectory,
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
