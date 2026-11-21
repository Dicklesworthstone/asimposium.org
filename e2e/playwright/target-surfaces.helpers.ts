/**
 * Shared validation, security-header, PNG-dimension, Rule A4 honesty, and
 * secret-safe NDJSON telemetry helpers for the staging Playwright suite
 * (`e2e/playwright/target-surfaces.spec.ts`, bead `asimposiumorg-rc-staging-smoke-playwright-real-4wnk`).
 */

export const PRODUCTION_HOSTNAMES = new Set([
  "a.asimposium.org",
  "artifacts.asimposium.org",
  "asimposium.org",
  "www.asimposium.org",
]);

export const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

export const ANONYMOUS_AGORA_PATHS = [
  "/",
  "/explore",
  "/problems",
  "/now",
  "/results",
  "/reviews",
  "/search",
  "/protocol",
  "/policy",
] as const;

export const CANONICAL_PROBLEM_ID_RE = /^(?!.*--)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface StagingOriginOptions {
  readonly allowLoopbackRehearsal?: boolean;
}

/**
 * Tamper-evidence & fail-closed production refusal rule:
 * - Production hostnames (`asimposium.org`, `www.`, `a.`, `artifacts.`, any case,
 *   trailing dot, or explicit port) are ALWAYS refused.
 * - Normal staging mode requires `https://` on an operator-owned `*.asimposium.org`
 *   subdomain other than the production family.
 * - Explicit `--local-rehearsal` mode additionally permits `http://127.0.0.1:<port>`
 *   and `http://localhost:<port>` while keeping production and arbitrary hosts blocked.
 */
export function validateStagingOrigin(
  variableName: string,
  supplied: string | undefined,
  options: StagingOriginOptions = {},
): string {
  if (!supplied) {
    throw new Error(`${variableName} is required; refusing to infer a staging target.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(supplied);
  } catch {
    throw new Error(
      `${variableName} must be an HTTPS origin without credentials, a path, query, or fragment, on an operator-owned *.asimposium.org subdomain.`,
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    PRODUCTION_HOSTNAMES.has(hostname)
  ) {
    throw new Error(
      `${variableName} must not target canonical production or carry credentials, paths, queries, or fragments.`,
    );
  }

  const isStagingHttps = parsed.protocol === "https:" && hostname.endsWith(".asimposium.org");
  const isAllowedLoopback =
    options.allowLoopbackRehearsal === true &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    LOOPBACK_HOSTNAMES.has(hostname) &&
    parsed.port.length > 0;

  if (!isStagingHttps && !isAllowedLoopback) {
    throw new Error(
      `${variableName} must be an HTTPS origin on an operator-owned *.asimposium.org subdomain other than the production family.`,
    );
  }

  return parsed.origin;
}

export function validateProblemId(candidate: string): boolean {
  return CANONICAL_PROBLEM_ID_RE.test(candidate);
}

export interface CspCheckResult {
  readonly ok: boolean;
  readonly hasDefaultSrc: boolean;
  readonly hasNonce: boolean;
  readonly hasUnsafeInline: boolean;
  readonly hasNosniff: boolean;
}

/**
 * Fable §14 strict CSP verification:
 * - `content-security-policy` must declare `default-src`.
 * - `script-src` must declare a cryptographic `'nonce-...'` (>= 16 chars) and
 *   must NEVER permit `'unsafe-inline'`.
 * - `x-content-type-options` must be `nosniff`.
 */
export function checkStrictCspHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): CspCheckResult {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
    }
  }
  const csp = normalized["content-security-policy"] ?? "";
  const hasDefaultSrc = /(?:^|;)\s*default-src\b/i.test(csp);
  const scriptMatch = /(?:^|;)\s*script-src\s+([^;]+)/i.exec(csp);
  const scriptSrc = scriptMatch?.[1] ?? "";
  const hasNonce = /'nonce-[A-Za-z0-9+/_-]{16,}=*'/.test(scriptSrc);
  const hasUnsafeInline = scriptSrc.toLowerCase().includes("'unsafe-inline'");
  const hasNosniff = (normalized["x-content-type-options"] ?? "").toLowerCase() === "nosniff";
  return {
    ok: hasDefaultSrc && hasNonce && !hasUnsafeInline && hasNosniff,
    hasDefaultSrc,
    hasNonce,
    hasUnsafeInline,
    hasNosniff,
  };
}

/**
 * Private sponsor/workshop/admin responses must never be publicly cacheable.
 */
export function isPrivateCacheControl(cacheControl: string | undefined): boolean {
  const lower = (cacheControl ?? "").toLowerCase();
  return /\b(private|no-store)\b/.test(lower) && !/\b(public|s-maxage)\b/.test(lower);
}

/**
 * Rule A4 honesty check: ASImposium never displays a `PROVED` status badge or
 * banner. Evaluates explicit badge/status texts and standalone banner lines so
 * normal explanatory prose (e.g. "never displays a PROVED banner") does not
 * false-positive while an actual PROVED status badge or heading fails hard.
 */
export function findDishonestProvedBanner(
  badgeTexts: readonly string[],
  headingTexts: readonly string[],
): string | null {
  for (const raw of badgeTexts) {
    const trimmed = raw.trim();
    if (/^(?:status\s*:\s*)?proved$/i.test(trimmed) || /\[proved\]/i.test(trimmed)) {
      return `forbidden PROVED status badge detected`;
    }
  }
  for (const raw of headingTexts) {
    const trimmed = raw.trim();
    if (/^(?:status\s*:\s*)?proved\b/i.test(trimmed) || /\bclaim\s+proved\b/i.test(trimmed)) {
      return `forbidden PROVED banner heading detected`;
    }
  }
  return null;
}

const PNG_MAGIC_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Parses binary PNG header (8-byte magic + IHDR chunk) to extract exact pixel
 * width and height without trusting response metadata alone.
 */
export function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  for (let i = 0; i < PNG_MAGIC_BYTES.length; i += 1) {
    if (bytes[i] !== PNG_MAGIC_BYTES[i]) return null;
  }
  // Bytes 12..15 must be ASCII "IHDR"
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

export interface PlaywrightTelemetryEntry {
  readonly url_path: string;
  readonly status: number;
  readonly js_mode: "on" | "off";
  readonly csp_nonce_present: boolean;
  readonly console_errors: number;
  readonly page_errors: number;
  readonly katex_nodes?: number;
  readonly katex_errors?: number;
  readonly principal?: "anonymous" | "sponsor";
  readonly duration_ms: number;
}

/**
 * Emits a secret-safe NDJSON telemetry line. Strips any scheme, hostname,
 * query string, or fragment from `url_path` so staging origins, tokens, and
 * private workshop IDs/canaries never leak to stdout or logs.
 */
export function formatPlaywrightTelemetry(entry: PlaywrightTelemetryEntry): string {
  let sanitizedPath = entry.url_path;
  if (/^https?:\/\//i.test(sanitizedPath)) {
    try {
      sanitizedPath = new URL(sanitizedPath).pathname;
    } catch {
      sanitizedPath = "/";
    }
  }
  sanitizedPath = sanitizedPath.split("?")[0]?.split("#")[0] ?? "/";
  if (!sanitizedPath.startsWith("/")) {
    sanitizedPath = `/${sanitizedPath}`;
  }
  // Redact dynamic workshop/fellow/enrollment segments in telemetry paths.
  sanitizedPath = sanitizedPath
    .replace(/\/console\/workshop\/[^/]+\/[^/]+/g, "/console/workshop/[redacted]/[redacted]")
    .replace(/\/join\/ASIMP-EN-[A-Za-z0-9_-]+/g, "/join/[redacted]");

  return JSON.stringify({
    facility: "E2E.playwright",
    url: sanitizedPath,
    status: entry.status,
    js_mode: entry.js_mode,
    csp_nonce_present: entry.csp_nonce_present,
    console_errors: entry.console_errors,
    page_errors: entry.page_errors,
    ...(entry.katex_nodes === undefined ? {} : { katex_nodes: entry.katex_nodes }),
    ...(entry.katex_errors === undefined ? {} : { katex_errors: entry.katex_errors }),
    ...(entry.principal === undefined ? {} : { principal: entry.principal }),
    duration_ms: Math.max(0, Math.round(entry.duration_ms)),
  });
}
