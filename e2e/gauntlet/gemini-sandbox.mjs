import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const ENTRY = "bundle/gemini.js";
const SCOPE = "/usr/bin/systemd-run";
const BWRAP = "/usr/bin/bwrap";
const NODE = "/usr/bin/node";

export const GEMINI_SANDBOX_ENTERED = "ASIMPOSIUM_GEMINI_SANDBOX_ENTERED";

// Check the current process's effective cgroup before allowing even the CLI
// initialization to run. A tmpfs on a host with swap can otherwise hit disk.
const CHECK_SCOPE = `
  IFS=: read -r hierarchy controllers scope </proc/self/cgroup
  [ "$hierarchy" = 0 ]
  [ -n "$scope" ]
  IFS= read -r swap <"/sys/fs/cgroup$scope/memory.swap.max"
  [ "$swap" = 0 ]
  exec "$@"
`;

const START_GEMINI = `
  umask 077
  ulimit -c 0
  printf '%s\\n' '${GEMINI_SANDBOX_ENTERED}' >&2
  exec "$@"
`;

function resolveBundle(configured) {
  const candidates = configured
    ? [configured]
    : [
        join(homedir(), ".bun/install/global/node_modules/@google/gemini-cli"),
        "/usr/local/lib/node_modules/@google/gemini-cli",
        "/usr/lib/node_modules/@google/gemini-cli",
      ];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const root = realpathSync(candidate);
      const manifest = join(root, "package.json");
      const bundle = join(root, "bundle");
      const entry = join(root, ENTRY);
      if (
        realpathSync(manifest) !== manifest ||
        realpathSync(bundle) !== bundle ||
        realpathSync(entry) !== entry ||
        !statSync(manifest).isFile() ||
        !statSync(entry).isFile()
      ) {
        continue;
      }
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name === "@google/gemini-cli" && pkg.bin?.gemini === ENTRY) {
        return { bundle, manifest };
      }
    } catch {
      // An absent or corrupt install is a prerequisite, never a host launch.
    }
  }
  return null;
}

export function geminiSandboxLaunch(argv, source = process.env) {
  if (!source.GEMINI_API_KEY?.trim()) return { unavailable: "auth" };
  const uid = process.getuid?.();
  if (process.platform !== "linux" || uid === undefined || uid === 0) {
    return { unavailable: "privacy-prerequisite" };
  }
  try {
    accessSync(SCOPE, constants.X_OK);
    accessSync(BWRAP, constants.X_OK);
  } catch {
    return { unavailable: "privacy-prerequisite" };
  }
  const installation = resolveBundle(source.ASIMPOSIUM_GAUNTLET_GEMINI_PACKAGE);
  try {
    accessSync(NODE, constants.X_OK);
  } catch {
    return { unavailable: "binary-unavailable" };
  }
  if (!installation) return { unavailable: "binary-unavailable" };

  const scratch = "/scratch";
  const environment = {
    PATH: "/usr/bin:/bin",
    HOME: `${scratch}/home`,
    GEMINI_CLI_HOME: `${scratch}/home`,
    XDG_CONFIG_HOME: `${scratch}/config`,
    XDG_STATE_HOME: `${scratch}/state`,
    XDG_CACHE_HOME: `${scratch}/cache`,
    XDG_DATA_HOME: `${scratch}/data`,
    XDG_RUNTIME_DIR: `${scratch}/run`,
    TMPDIR: `${scratch}/tmp`,
    GEMINI_TELEMETRY_ENABLED: "false",
    LANG: "C.UTF-8",
  };
  const directories = ["home", "config", "state", "cache", "data", "run", "tmp", "work"].flatMap(
    (name) => ["--perms", "0700", "--dir", `${scratch}/${name}`],
  );
  const mounts = [
    ["--ro-bind", "/usr", "/usr"],
    ["--symlink", "usr/bin", "/bin"],
    ["--symlink", "usr/lib", "/lib"],
    ["--symlink", "usr/lib64", "/lib64"],
    ["--proc", "/proc"],
    ["--remount-ro", "/proc"],
    ["--dev", "/dev"],
    ["--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs"],
    ["--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf"],
    ["--ro-bind", "/etc/hosts", "/etc/hosts"],
    ["--ro-bind", installation.bundle, "/opt/gemini/bundle"],
    ["--ro-bind", installation.manifest, "/opt/gemini/package.json"],
    ["--perms", "0700", "--size", String(256 * 1024 * 1024), "--tmpfs", scratch],
    directories,
    ["--symlink", `${scratch}/tmp`, "/tmp"],
    ["--remount-ro", "/"],
  ].flat();

  return {
    binary: SCOPE,
    argv: [
      "--user",
      "--scope",
      "--quiet",
      "--property=MemorySwapMax=0",
      "--",
      "/bin/sh",
      "-eu",
      "-c",
      CHECK_SCOPE,
      "asimposium-gemini-scope",
      BWRAP,
      "--unshare-all",
      "--share-net",
      "--new-session",
      "--die-with-parent",
      "--cap-drop",
      "ALL",
      ...mounts,
      "--chdir",
      `${scratch}/work`,
      "--unsetenv",
      "DBUS_SESSION_BUS_ADDRESS",
      ...Object.entries(environment).flatMap(([name, value]) => ["--setenv", name, value]),
      "--",
      "/bin/sh",
      "-eu",
      "-c",
      START_GEMINI,
      "asimposium-gemini",
      NODE,
      `/opt/gemini/${ENTRY}`,
      ...argv,
    ],
    // systemd-run needs only its user bus before entering Bubblewrap. The
    // provider key is inherited through the environment, never argv or files.
    env: {
      PATH: environment.PATH,
      XDG_RUNTIME_DIR: `/run/user/${uid}`,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
      GEMINI_API_KEY: source.GEMINI_API_KEY,
    },
  };
}
