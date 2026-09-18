import {
  publicWatchEtag, publicWatchPath, type PublicWatchTarget, validPublicWatchTargets,
} from "@asimposium/contracts/public-watch";

/** Take validators only from the response whose contract-checked bytes are
 * rendered. A body, URL parameter, follow-up HEAD or unrelated global cursor
 * cannot supply the acknowledgment for that representation. */
export function publicReadWatch(path: string, headers: Headers): { watch?: PublicWatchTarget } {
  const etag = publicWatchEtag(headers.get("etag"));
  return publicWatchPath(path) === "face" && etag !== undefined
    ? { watch: { path, etag } }
    : {};
}

/** All rendered dependencies must participate. Silently dropping a missing
 * validator would let a partial check claim that the entire view is current.
 * Duplicate identical reads may share one probe; conflicting validators may
 * not. An empty result disables polling while leaving server content readable. */
export function publicViewWatchTargets(
  ...sources: readonly (PublicWatchTarget | undefined)[]
): readonly PublicWatchTarget[] {
  if (sources.length === 0 || sources.some((source) => source === undefined)) return [];
  const byPath = new Map<string, PublicWatchTarget>();
  for (const source of sources) {
    if (source === undefined) return [];
    const prior = byPath.get(source.path);
    if (prior !== undefined && prior.etag !== source.etag) return [];
    byPath.set(source.path, { ...source });
  }
  const targets = [...byPath.values()];
  return validPublicWatchTargets(targets) ? targets : [];
}

/** Decode only the client island's own serialized props. Validate again so a
 * malformed manifest never broadens the watcher's public-read vocabulary. */
export function parsePublicWatchManifest(value: string): readonly PublicWatchTarget[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const targets: PublicWatchTarget[] = [];
  for (const item of parsed as unknown[]) {
    if (item === null || typeof item !== "object" || !("path" in item) ||
      !("etag" in item) || typeof item.path !== "string" || typeof item.etag !== "string") return [];
    targets.push({ path: item.path, etag: item.etag });
  }
  return validPublicWatchTargets(targets) ? targets : [];
}
