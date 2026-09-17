/** Public-browser liveness uses existing read contracts, not a second ledger.
 * Keep this transport vocabulary dependency-free: the Worker and the small
 * client island share the exact same route/ETag/cursor grammar. */
export const PUBLIC_WATCH_MAX_TARGETS = 9;
export const PUBLIC_WATCH_INTERVAL_MS = 10_000;
export const PUBLIC_WATCH_MAX_BACKOFF_MS = 120_000;
export const PUBLIC_WATCH_REQUEST_TIMEOUT_MS = 3_000;
export const PUBLIC_WATCH_MAX_REFRESH_ATTEMPTS = 3;

export interface PublicWatchTarget {
  readonly path: string;
  /** The validator of the resource actually rendered, never a guessed cursor. */
  readonly etag: string;
}

const PROBLEM = /^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/;
const INTEGER = /^(?:0|[1-9][0-9]*)$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

export function parsePublicWatchCursor(value: string): number | undefined {
  if (value.length > 16 || !INTEGER.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

export function publicWatchEtag(value: string | null | undefined): string | undefined {
  // Current canonical faces issue strong digest tags. Refuse weak tags, lists,
  // control bytes and wildcard validators rather than manufacturing a match.
  return typeof value === "string" && /^"[A-Za-z0-9._:-]{1,160}"$/.test(value)
    ? value
    : undefined;
}

/** The transport is deliberately restricted to the two Stoa deployments and
 * explicit canonical IPv4 loopback. Arbitrary HTTPS hosts, credentials and
 * path-bearing "origins" are not browser polling destinations. */
export function publicWatchOrigin(value: string): boolean {
  if (value === "https://a.asimposium.org" || value === "https://a-staging.asimposium.org") {
    return true;
  }
  const local = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value);
  if (!local) return false;
  const port = Number(local[1]);
  if (port > 65_535 || port === 80) return false;
  try { return new URL(value).origin === value; } catch { return false; }
}

/** Closed read-only allowlist, also used for CORS. In particular no /v1,
 * enrollment, workshop, inbox, signed sponsor route or arbitrary URL qualifies.
 * Queries remain byte-for-byte intact: historical pins and opaque pagination
 * must not be silently converted into a live head by the watcher. */
export function publicWatchPath(path: string): "cursor" | "face" | undefined {
  if (path.length > 2_048 || !path.startsWith("/") || path.startsWith("//")) return undefined;
  let url: URL;
  let decoded: string;
  try {
    url = new URL(path, "https://public-watch.invalid");
    if (url.origin !== "https://public-watch.invalid" || url.hash ||
      `${url.pathname}${url.search}` !== path) return undefined;
    decoded = decodeURIComponent(url.pathname);
  } catch { return undefined; }
  const query = url.searchParams;
  const entries = [...query.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length ||
    entries.some(([, value]) => value.length === 0 || value.length > 1_024 || /[\x00-\x1f\x7f]/.test(value))) {
    return undefined;
  }
  if (decoded === "/cursor") return entries.length === 0 ? "cursor" : undefined;
  let permitted: readonly string[];
  const problem = /^\/p\/([^/]+)\.json$/.exec(decoded);
  const claim = /^\/p\/([^/]+)\/claims\/C-([1-9][0-9]*)(?:@([1-9][0-9]*))?\.json$/.exec(decoded);
  const deadEnds = /^\/p\/([^/]+)\/dead-ends\.json$/.exec(decoded);
  if (problem && PROBLEM.test(problem[1] ?? "")) {
    permitted = [];
  } else if (claim && PROBLEM.test(claim[1] ?? "") &&
    Number.isSafeInteger(Number(claim[2])) &&
    (claim[3] === undefined || Number.isSafeInteger(Number(claim[3])))) {
    permitted = ["through"];
    const through = query.get("through");
    if (through !== null && parsePublicWatchCursor(through) === undefined) return undefined;
  } else if (deadEnds && PROBLEM.test(deadEnds[1] ?? "")) {
    permitted = ["include_superseded"];
    const history = query.get("include_superseded");
    if (history !== null && !["true", "false", "0", "1"].includes(history)) return undefined;
  } else if (decoded === "/problems.json") {
    permitted = ["after"];
    const after = query.get("after");
    if (after !== null && !PROBLEM.test(after)) return undefined;
  } else if (decoded === "/now.json") {
    permitted = ["before"];
  } else if (decoded === "/reviews.json") {
    permitted = ["problem", "after"];
    const scope = query.get("problem");
    if (scope !== null && !PROBLEM.test(scope)) return undefined;
  } else {
    return undefined;
  }
  return entries.every(([key]) => permitted.includes(key)) ? "face" : undefined;
}

export function validPublicWatchTargets(targets: readonly PublicWatchTarget[]): boolean {
  return targets.length > 0 && targets.length <= PUBLIC_WATCH_MAX_TARGETS &&
    new Set(targets.map((target) => target.path)).size === targets.length &&
    targets.every((target) => publicWatchPath(target.path) === "face" &&
      publicWatchEtag(target.etag) !== undefined);
}

/** Retry-After delays are bounded; malformed hints never create a hot loop. */
export function publicWatchRetryAfter(value: string | null): number | undefined {
  if (value === null || !POSITIVE_INTEGER.test(value) || value.length > 6) return undefined;
  return Math.min(PUBLIC_WATCH_MAX_BACKOFF_MS,
    Math.max(PUBLIC_WATCH_INTERVAL_MS, Number(value) * 1_000));
}
