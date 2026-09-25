import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// codz / z8y: the contract fixture moves provider ships in
// src/mega-commands/provider.ts for contract tests. It must be unreachable in
// the deployable Worker bundle, so no request can ever be served fixture
// moves. This builds the real bundle (wrangler dry-run, the same esbuild pass
// as deploy) and inspects the bytes. Positive markers guard against a
// vacuous pass on an empty or wrong bundle.

const REPO = resolve(import.meta.dir, "../../../..");

test("the deployable Worker bundle excludes the contract fixture moves provider", () => {
  // The test's own temporary build output; removed after the assertions.
  const outdir = mkdtempSync(join(tmpdir(), "asimp-bundle-"));
  try {
    const build = Bun.spawnSync({
      cmd: [
        "bunx",
        "--no-install",
        "wrangler",
        "deploy",
        "--dry-run",
        "--outdir",
        outdir,
        "-c",
        "infra/wrangler.toml",
      ],
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(build.exitCode, new TextDecoder().decode(build.stderr).slice(-2000)).toBe(0);
    const bundle = readFileSync(join(outdir, "index.js"), "utf8");

    // Positive markers: this is the real production Worker.
    expect(bundle.length).toBeGreaterThan(1_000_000);
    // Booleans, not toContain: a failure must not print a 3 MB bundle.
    expect(bundle.includes("TruthfulProductionMovesProvider")).toBe(true);
    expect(bundle.includes("ledger-needs-v5")).toBe(true);

    // The fixture provider and its selection boundary are absent.
    expect(bundle.includes("ContractFixtureMovesProvider")).toBe(false);
    expect(bundle.includes("contract-fixture-provider")).toBe(false);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}, 300_000);
