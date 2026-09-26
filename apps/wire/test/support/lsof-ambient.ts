import { existsSync, readFileSync } from "node:fs";

const WARNING = /^lsof: WARNING: can't stat\(\) [a-z0-9_.-]+ file system (\/\S+)$/;
const TAIL = "      Output information may be incomplete.";

/** Linux lsof prints a paired "can't stat()" diagnostic for every mount it
 * cannot stat while scanning unrelated processes: kernel tracing and, on
 * container hosts, Docker overlay2 and netns mounts (asimposiumorg-wocj,
 * the ot5y class). Remove only exact two-line pairs for real mount points in
 * /proc/self/mountinfo that are neither "/" nor an ancestor of `protectedPath`.
 * Every other byte is returned, so any other diagnostic still fails a scan. */
export function stripAmbientLsofWarnings(stderr: string, protectedPath: string): string {
  if (!existsSync("/proc/self/mountinfo")) return stderr;
  const mounts = new Set(
    readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .map((line) => line.split(" ")[4])
      .filter((mount): mount is string => mount !== undefined),
  );
  const lines = stderr.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const mount = WARNING.exec(lines[i] ?? "")?.[1];
    if (
      mount !== undefined &&
      lines[i + 1] === TAIL &&
      mount !== "/" &&
      mounts.has(mount) &&
      !`${protectedPath}/`.startsWith(`${mount}/`)
    ) {
      i++;
      continue;
    }
    kept.push(lines[i] ?? "");
  }
  return kept.join("\n");
}
