import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runStartupBenchmark, verifyReleaseBinaryCandidate } from "./asimp-bench-startup.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const INSTALLER_PATH = join(REPO_ROOT, "apps/web/public/install.sh");
const PACKAGER_PATH = join(REPO_ROOT, "scripts/asimp-release-package.sh");

function hostTargetTriple(): string {
  const os = platform();
  const cpu = arch();
  if (os === "linux" && cpu === "x64") return "x86_64-unknown-linux-musl";
  if (os === "linux" && cpu === "arm64") return "aarch64-unknown-linux-musl";
  if (os === "darwin" && cpu === "x64") return "x86_64-apple-darwin";
  if (os === "darwin" && cpu === "arm64") return "aarch64-apple-darwin";
  throw new Error(`Unsupported test host: ${os}/${cpu}`);
}

describe("asimp W11.5 release packager, installer E2E, doc parity, and startup bench gate (asimposiumorg-85s)", () => {
  let workDir = "";
  let distDir = "";
  let distDirRepeat = "";
  let mockBin = "";
  let server: ReturnType<typeof Bun.serve> | null = null;
  const target = hostTargetTriple();
  const version = "0.1.0";
  const tarballName = `asimp-v${version}-${target}.tar.gz`;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "asimp-85s-e2e-"));
    distDir = join(workDir, "dist-1");
    distDirRepeat = join(workDir, "dist-2");

    // Prefer the real release binary if present; otherwise create a deterministic test executable.
    const realReleaseBin = join(REPO_ROOT, "cli/target/release/asimp");
    if (existsSync(realReleaseBin)) {
      mockBin = realReleaseBin;
    } else {
      mockBin = join(workDir, "fake-release", "asimp");
      mkdirSync(join(workDir, "fake-release"), { recursive: true });
      writeFileSync(
        mockBin,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "asimp ${version}"; exit 0; fi\nif [ "$1" = "--help" ]; then echo "Usage: asimp [OPTIONS] <COMMAND>"; exit 0; fi\necho "asimp test fixture"\n`,
        "utf8",
      );
      chmodSync(mockBin, 0o755);
    }

    // Run deterministic packager twice with identical SOURCE_DATE_EPOCH to prove reproducibility.
    for (const outDir of [distDir, distDirRepeat]) {
      const proc = Bun.spawnSync(
        [
          "bash",
          PACKAGER_PATH,
          "--binary",
          mockBin,
          "--target",
          target,
          "--version",
          version,
          "--out-dir",
          outDir,
        ],
        {
          env: {
            ...process.env,
            SOURCE_DATE_EPOCH: "1735689600",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      if (proc.exitCode !== 0) {
        throw new Error(
          `Packager failed (exit ${proc.exitCode}): ${new TextDecoder().decode(proc.stderr)}`,
        );
      }
    }

    writeFileSync(join(distDir, "latest-version.txt"), `v${version}\n`, "utf8");

    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/latest-version.txt") {
          return new Response(readFileSync(join(distDir, "latest-version.txt")));
        }
        const prefix = `/download/asimp-v${version}/`;
        if (pathname.startsWith(prefix)) {
          const name = pathname.slice(prefix.length);
          if (!name || name.includes("/") || name.includes("..")) {
            return new Response("forbidden", { status: 403 });
          }
          const full = join(distDir, name);
          if (existsSync(full)) {
            return new Response(readFileSync(full));
          }
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
    if (workDir) {
      // Restore permissions on any intentionally chmod-0555 test directories before cleanup.
      const roDir = join(workDir, "readonly-dest");
      if (existsSync(roDir)) {
        chmodSync(roDir, 0o755);
      }
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("packager produces byte-reproducible tarball, valid SHA256SUMS, CycloneDX 1.5 SBOM, and version-pinned installer", () => {
    const t1 = readFileSync(join(distDir, tarballName));
    const t2 = readFileSync(join(distDirRepeat, tarballName));
    const h1 = createHash("sha256").update(t1).digest("hex");
    const h2 = createHash("sha256").update(t2).digest("hex");
    expect(h1).toBe(h2);

    const sums = readFileSync(join(distDir, "SHA256SUMS"), "utf8");
    expect(sums).toContain(`${h1}  ${tarballName}`);
    expect(sums).toContain(`install-v${version}.sh`);

    const sbomPath = join(distDir, `asimp-v${version}-${target}.cdx.json`);
    const sbom = JSON.parse(readFileSync(sbomPath, "utf8")) as {
      bomFormat: string;
      specVersion: string;
      metadata: { component: { name: string; version: string; hashes: { content: string }[] } };
      components: { name: string; purl: string }[];
    };
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.specVersion).toBe("1.5");
    expect(sbom.metadata.component.name).toBe("asimp");
    expect(sbom.metadata.component.version).toBe(version);
    expect(sbom.metadata.component.hashes[0]?.content).toBe(h1);
    expect(sbom.components.length).toBeGreaterThan(20);
    expect(sbom.components.some((c) => c.name === "clap")).toBe(true);
    expect(sbom.components.some((c) => c.name === "ring")).toBe(true);

    const pinnedText = readFileSync(join(distDir, `install-v${version}.sh`), "utf8");
    expect(pinnedText).toContain(`PINNED_VERSION="v${version}"`);
  });

  test("POSITIVE 1: clean isolated install from loopback HTTP release mirror verifies SHA-256 and installs executable asimp", async () => {
    const homeDir = join(workDir, "home-http");
    const destDir = join(homeDir, ".local/bin");
    mkdirSync(homeDir, { recursive: true });
    const baseUrl = `http://127.0.0.1:${server?.port}`;

    const proc = Bun.spawn(
      [
        "bash",
        INSTALLER_PATH,
        "--release-base-url",
        baseUrl,
        "--dest",
        destDir,
        "--no-gum",
        "--verify",
      ],
      {
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: homeDir,
          TMPDIR: join(workDir, "tmp-http"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    mkdirSync(join(workDir, "tmp-http"), { recursive: true });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode, `stderr: ${stderr}\nstdout: ${stdout}`).toBe(0);
    expect(stdout).toContain("SHA-256 checksum verified");
    expect(stdout).toContain(`Installed asimp to ${destDir}/asimp`);

    const verProc = Bun.spawnSync([join(destDir, "asimp"), "--version"], { stdout: "pipe" });
    expect(verProc.exitCode).toBe(0);
    expect(new TextDecoder().decode(verProc.stdout).trim()).toBe(`asimp ${version}`);

    // Re-running without --force short-circuits cleanly when version matches.
    const quietProc = Bun.spawn(
      ["bash", INSTALLER_PATH, "--release-base-url", baseUrl, "--dest", destDir, "--quiet"],
      {
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: homeDir,
          TMPDIR: join(workDir, "tmp-http"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [qOut, qErr, qCode] = await Promise.all([
      new Response(quietProc.stdout).text(),
      new Response(quietProc.stderr).text(),
      quietProc.exited,
    ]);
    expect(qCode, `stderr: ${qErr}`).toBe(0);
    expect(qOut).toBe("");
  });

  test("POSITIVE 2: version-pinned installer installs airgapped via --offline + --checksum-file", async () => {
    const homeDir = join(workDir, "home-offline");
    const destDir = join(homeDir, "bin");
    mkdirSync(homeDir, { recursive: true });
    const pinnedInstaller = join(distDir, `install-v${version}.sh`);

    const proc = Bun.spawn(
      [
        "bash",
        pinnedInstaller,
        "--offline",
        join(distDir, tarballName),
        "--checksum-file",
        join(distDir, "SHA256SUMS"),
        "--dest",
        destDir,
        "--no-gum",
      ],
      {
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: homeDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain("SHA-256 checksum verified");
    expect(existsSync(join(destDir, "asimp"))).toBe(true);
  });

  test("SHOULD-FAIL CONTROL 1: tampered tarball fails closed on SHA-256 mismatch without replacing existing binary", async () => {
    const homeDir = join(workDir, "home-tamper");
    const destDir = join(homeDir, "bin");
    mkdirSync(destDir, { recursive: true });
    const sentinel = join(destDir, "asimp");
    writeFileSync(sentinel, "#!/bin/sh\necho 'sentinel-original'\n", "utf8");
    chmodSync(sentinel, 0o755);

    const tampered = join(workDir, tarballName);
    copyFileSync(join(distDir, tarballName), tampered);
    writeFileSync(tampered, Buffer.concat([readFileSync(tampered), Buffer.from("tampered")]));

    const proc = Bun.spawn(
      [
        "bash",
        INSTALLER_PATH,
        "--offline",
        tampered,
        "--checksum-file",
        join(distDir, "SHA256SUMS"),
        "--dest",
        destDir,
        "--force",
        "--no-gum",
      ],
      {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: homeDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("SHA-256 checksum mismatch");
    // Original binary must remain completely untouched.
    expect(readFileSync(sentinel, "utf8")).toContain("sentinel-original");
  });

  test("SHOULD-FAIL CONTROL 2: unwritable destination refuses cleanly without invoking silent sudo", async () => {
    const roDir = join(workDir, "readonly-dest");
    mkdirSync(roDir, { recursive: true });
    chmodSync(roDir, 0o555);

    const proc = Bun.spawn(
      [
        "bash",
        INSTALLER_PATH,
        "--offline",
        join(distDir, tarballName),
        "--checksum-file",
        join(distDir, "SHA256SUMS"),
        "--dest",
        roDir,
        "--no-gum",
      ],
      {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: workDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("never runs sudo silently");
  });

  test("SHOULD-FAIL CONTROL 3: unsupported platform and insecure non-loopback HTTP release URL are refused fail-closed", async () => {
    const badArch = Bun.spawn(
      ["bash", INSTALLER_PATH, "--dest", join(workDir, "noop"), "--no-gum"],
      {
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: workDir,
          ASIMP_INSTALL_OS: "Plan9",
          ASIMP_INSTALL_ARCH: "mips64",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [, badArchErr, badArchCode] = await Promise.all([
      new Response(badArch.stdout).text(),
      new Response(badArch.stderr).text(),
      badArch.exited,
    ]);
    expect(badArchCode).toBe(2);
    expect(badArchErr).toContain("Unsupported or ambiguous platform");

    const badUrl = Bun.spawn(
      [
        "bash",
        INSTALLER_PATH,
        "--release-base-url",
        "http://untrusted.example.com/releases",
        "--dest",
        join(workDir, "noop"),
        "--no-gum",
      ],
      {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: workDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [, badUrlErr, badUrlCode] = await Promise.all([
      new Response(badUrl.stdout).text(),
      new Response(badUrl.stderr).text(),
      badUrl.exited,
    ]);
    expect(badUrlCode).toBe(2);
    expect(badUrlErr).toContain("Refusing insecure --release-base-url");
  });

  test("README.md and cli/README.md byte-agree on canonical apex installer URL; onboarding capsule stays curl-first", () => {
    const canonicalCmd = "curl -fsSL https://asimposium.org/install.sh | bash";
    const rootReadme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    const cliReadme = readFileSync(join(REPO_ROOT, "cli/README.md"), "utf8");
    expect(rootReadme).toContain(canonicalCmd);
    expect(cliReadme).toContain(canonicalCmd);

    // W11.5 hard invariant: installer URL and CLI command must NEVER appear in the onboarding capsule.
    for (const rel of ["packages/protocol/assets/capsule.md", "apps/web/public/capsule.md"]) {
      const capsule = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(capsule).not.toContain("install.sh");
      expect(capsule).not.toMatch(/\basimp\b/);
    }
  });

  test("startup benchmark harness refuses debug builds and measures executable warm startup honestly", () => {
    const fakeDebug = join(workDir, "target/debug/asimp");
    mkdirSync(join(workDir, "target/debug"), { recursive: true });
    copyFileSync(mockBin, fakeDebug);
    chmodSync(fakeDebug, 0o755);
    expect(() => verifyReleaseBinaryCandidate(fakeDebug)).toThrow(
      "BENCH_NON_RELEASE_BINARY_REFUSED",
    );

    const receipt = runStartupBenchmark({
      binary: mockBin,
      samples: 10,
      warmup: 2,
      budgetMs: 100,
    });
    expect(receipt.schema).toBe("asimposium.cli-startup-benchmark.v1");
    expect(receipt.release_build_checked).toBe(true);
    expect(receipt.benchmarks.version.samples).toBe(10);
    expect(receipt.benchmarks.help.samples).toBe(10);
    expect(receipt.benchmarks.version.p95_ms).toBeGreaterThan(0);
    expect(receipt.overall_pass).toBe(true);
  });
});
