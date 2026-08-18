/**
 * S-6 browser leg: the two claims a shell cannot make (bead asimposiumorg-vw3).
 *
 * 1. LIVE COOKIE SCOPING. A real Google sign-in against the real Agora preview,
 *    reading the `Set-Cookie` response header as the server actually sent it.
 *    A Playwright storage-state file is NOT accepted here: it is a *product* of
 *    a login that already happened, so it can show what a cookie jar holds but
 *    never what the origin asserted. Host-only is an assertion about the header
 *    (no `Domain=`), and only the header can prove it.
 *
 * 2. REAL SERVER-ACTION ORIGINATION. `mintJoinUrl` is gated on an HMAC-sealed
 *    payload minted by a prior action and is addressed by a per-build action id.
 *    The supported way to invoke it is the way a sponsor does: click the button.
 *    This runner never scrapes an action id and never posts a synthesised
 *    Server Action request.
 *
 * ## What this file must never emit
 *
 * The cookie VALUE, the Google password, the join-URL fragment secret, any
 * bearer, any screenshot, any trace. The join fragment is consumed transiently
 * in Playwright memory to make the real idempotent Fellow claim required for
 * attribution, but it is never retained, emitted, written to disk, placed in
 * argv/environment, or interpolated into a diagnostic. Cookie evidence is
 * reported as ATTRIBUTES, never bytes.
 *
 * Output is exactly one NDJSON record on stdout. Exit 0 pass, 1 fail, 78 blocked.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import {
  EnrollmentClaimResponseSchema,
  EnrollmentHelloResponseSchema,
  EnrollmentIdSchema,
  FellowNameSchema,
  FellowRegistrationRequestSchema,
  ProblemDocumentSchema,
  parseStoaJoinUrl,
  SponsorProposalListResponseSchema,
} from "@asimposium/contracts";
import { type APIResponse, type Browser, type BrowserContext, chromium } from "@playwright/test";

const SUITE = "s6-cross-plane-browser";
const BLOCKED_EXIT = 78;

/** Whole-runner bound. A browser that hangs must not hold a CI slot open. */
const TOTAL_BUDGET_MS = 180_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 20_000;
/** Last-resort bound on browser teardown once the total budget has expired. */
const CLOSE_GRACE_MS = 10_000;
/** The stdin configuration record is a single bounded line, never a stream. */
const MAX_CONFIG_RECORD_BYTES = 8192;
/** The shell accepts one canonical browser evidence record, never a transcript tail. */
export const MAX_BROWSER_EVIDENCE_BYTES = 4096;
/** One response body plus its three-digit curl status suffix. */
export const MAX_HTTP_RESPONSE_BYTES = 65_536;
/** One canonical retained schema-v4 evidence record. */
export const MAX_S6_EVIDENCE_BYTES = 16_384;

/**
 * The EXACT session cookie name configured in `apps/web/auth.ts`.
 *
 * This deployment overrides the Auth.js default, so matching on the framework's
 * `authjs.session-token` finds nothing and silently proves nothing. Exact
 * equality, not a suffix: a suffix match would also accept a cookie some future
 * middleware named `evil-asimp.session`.
 */
const SESSION_COOKIE_NAME = "asimp.session";
const CLAIM_MODEL = "test/no-inference";
const CLAIM_HARNESS = "playwright";

export interface CookieAttributes {
  readonly issuance_count: number;
  readonly host_only: boolean;
  readonly http_only: boolean;
  readonly secure: boolean;
  readonly same_site: string | null;
  readonly scoped_to_apex: boolean;
  readonly present_for_agent_host: boolean;
}

export interface CookieProbe {
  readonly attached: boolean;
  readonly status: number;
  readonly code: string | null;
}

interface Record_ {
  readonly tool: "playwright";
  readonly package: "e2e";
  readonly suite: typeof SUITE;
  readonly status: "pass" | "fail" | "blocked";
  readonly code: string;
  readonly duration_ms: number;
  readonly apex_host: string | null;
  readonly agent_host: string | null;
  readonly cookie: CookieAttributes | null;
  /** Natural browser behavior: the host-only session family is not eligible on Stoa. */
  readonly cookie_omission_probe: CookieProbe | null;
  /** Direction B: a fresh in-memory context explicitly presents the live family to Stoa. */
  readonly cookie_present_probe: CookieProbe | null;
  /**
   * Structured origination receipt. `enrollment_id` is the PUBLIC half of the
   * join URL only — never the URL, never its `#v1.<secret>` fragment.
   *
   * `absent_before_action` is what makes it a receipt rather than a reading:
   * the id is proven not present on the console before the click, so it cannot
   * be a pre-existing enrollment the runner merely noticed.
   */
  readonly receipt: {
    readonly enrollment_id: string;
    readonly absent_before_action: boolean;
    readonly dedicated_locator: boolean;
    readonly exact_worker_origin: boolean;
    readonly exact_join_path: boolean;
  } | null;
  /**
   * The serving edge's REQUEST identifier (`x-vercel-id`), or null.
   *
   * Request correlation only. It is not a build, a revision, or a deployment
   * pin, and nothing here claims otherwise: `x-vercel-id` identifies one request
   * through one edge. A deployment identity would need its own field validated
   * against a source the platform supports for that purpose.
   */
  readonly edge_request_id: string | null;
  readonly detail: string;
}

const startedAt = Date.now();

/** Lifecycle state selected only after the shared teardown owner settles. */
let teardownFailed = 0;
let deadlineExceeded = false;
let terminalPublished = false;

/** Return one shared promise no matter which lifecycle path requests teardown. */
export function oneShotAsync(work: () => Promise<void>): () => Promise<void> {
  let owned: Promise<void> | undefined;
  return () => {
    owned ??= work();
    return owned;
  };
}

/** Latch the deadline synchronously before the first teardown await. */
async function latchDeadlineAndTeardown(teardownOnce: () => Promise<void>): Promise<void> {
  deadlineExceeded = true;
  await teardownOnce();
}

export type SyncByteWriter = (
  fd: number,
  bytes: Uint8Array,
  offset: number,
  length: number,
) => number;

/** Complete one synchronous byte write, retrying only EINTR. */
export function writeAllSync(
  fd: number,
  bytes: Uint8Array,
  writer: SyncByteWriter = writeSync,
): void {
  let offset = 0;
  while (offset < bytes.length) {
    try {
      const written = writer(fd, bytes, offset, bytes.length - offset);
      if (written <= 0 || written > bytes.length - offset) {
        throw new Error("synchronous writer made invalid progress");
      }
      offset += written;
    } catch (error) {
      if ((error as { code?: string })?.code === "EINTR") continue;
      throw error;
    }
  }
}

/** Write every terminal byte synchronously before any caller can exit. */
function writeStdoutLine(line: string): void {
  writeAllSync(1, Buffer.from(`${line}\n`, "utf8"));
}

function emit(record: Omit<Record_, "duration_ms">): void {
  writeStdoutLine(JSON.stringify({ ...record, duration_ms: Date.now() - startedAt }));
}

/**
 * Control-flow exit that still runs cleanup.
 *
 * These paths used to call `process.exit` directly. That terminates the process
 * immediately, so the `finally` block awaiting `context.close()` and
 * `browser.close()` never completed and Chromium could be orphaned — with the
 * runner reporting a tidy blocked/fail record on the way out. Throwing instead
 * lets the `finally` run to completion; the record is emitted and the status
 * applied only after the browser is really down.
 */
class RunnerExit extends Error {
  constructor(
    readonly record: Omit<Record_, "duration_ms">,
    readonly status: number,
  ) {
    super(`runner-exit:${record.code}`);
    this.name = "RunnerExit";
  }
}

function blocked(code: string, detail: string, apex: string | null = null): never {
  throw new RunnerExit(
    {
      tool: "playwright",
      package: "e2e",
      suite: SUITE,
      status: "blocked",
      code,
      apex_host: apex,
      agent_host: null,
      cookie: null,
      cookie_omission_probe: null,
      cookie_present_probe: null,
      receipt: null,
      edge_request_id: null,
      detail,
    },
    BLOCKED_EXIT,
  );
}

function failed(code: string, detail: string, apex: string | null = null): never {
  throw new RunnerExit(
    {
      tool: "playwright",
      package: "e2e",
      suite: SUITE,
      status: "fail",
      code,
      apex_host: apex,
      agent_host: null,
      cookie: null,
      cookie_omission_probe: null,
      cookie_present_probe: null,
      receipt: null,
      edge_request_id: null,
      detail,
    },
    1,
  );
}

/** Exact https origin: no credentials, no path, no query, no fragment. */
function originHost(value: string | undefined, name: string): string {
  if (value === undefined || !/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/?$/.test(value)) {
    blocked("ORIGIN_INVALID", `${name} must be an exact https origin`);
  }
  return new URL(value).host.split(":")[0] as string;
}

/** Pure credential-fill gate: lookalike paths and host suffixes are never Google. */
export function isExactGoogleAccountsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.origin === "https://accounts.google.com" &&
      parsed.protocol === "https:" &&
      parsed.hostname === "accounts.google.com" &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the element's live owner, require exact main-frame identity, and
 * re-read that frame's URL immediately before the credential action.
 */
export async function performAtExactGoogleOwnerFrame<T>(
  elementHandle: { ownerFrame(): Promise<{ url(): string } | null> },
  expectedMainFrame: { url(): string },
  action: () => T | Promise<T>,
): Promise<T> {
  const ownerFrame = await elementHandle.ownerFrame();
  if (ownerFrame === null || ownerFrame !== expectedMainFrame) {
    throw new Error("credential element was not owned by the exact main frame");
  }
  if (!isExactGoogleAccountsOrigin(ownerFrame.url())) {
    throw new Error("credential action refused outside the exact Google accounts origin");
  }
  return await action();
}

export type GoogleLoginAction = "perform-google-login" | "refuse";

/** A live run must begin unauthenticated and exercise the configured Google account. */
export function selectGoogleLoginAction(signInControlCount: number): GoogleLoginAction {
  return signInControlCount === 1 ? "perform-google-login" : "refuse";
}

/**
 * Host-only is decided by the presence of a `Domain=` attribute in the raw
 * header, not by what a cookie jar later reports: a jar normalises away the
 * distinction this test exists to catch.
 */
export interface SessionCookieIssuance {
  readonly hostOnly: boolean;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: string | null;
}

export interface SessionCookiePolicy {
  readonly issuanceCount: number;
  readonly hostOnly: boolean;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSiteLax: boolean;
}

/** Match Auth.js' exact base cookie or one of its numeric chunk names. */
function isSessionCookieName(name: string): boolean {
  return name === SESSION_COOKIE_NAME || /^asimp\.session\.[0-9]+$/.test(name);
}

function parseSessionCookieIssuance(
  header: string,
  now = Date.now(),
): SessionCookieIssuance | null | undefined {
  if (/[\r\n\0]/.test(header)) throw new Error("invalid Set-Cookie framing");
  const pair = header.split(";", 1)[0] ?? "";
  const equals = pair.indexOf("=");
  if (equals <= 0) return undefined;
  const name = pair.slice(0, equals).trim();
  if (!isSessionCookieName(name)) return undefined;
  const value = pair.slice(equals + 1);
  const attributes = header
    .split(";")
    .slice(1)
    .map((part) => part.trim().toLowerCase());
  const maxAge = attributes.find((attribute) => attribute.startsWith("max-age="));
  const expires = attributes.find((attribute) => attribute.startsWith("expires="));
  const maxAgeSeconds = maxAge === undefined ? undefined : Number(maxAge.slice("max-age=".length));
  const expiresAt =
    expires === undefined ? undefined : Date.parse(expires.slice("expires=".length));
  if (
    value.length === 0 ||
    (maxAgeSeconds !== undefined && Number.isFinite(maxAgeSeconds) && maxAgeSeconds <= 0) ||
    (expiresAt !== undefined && Number.isFinite(expiresAt) && expiresAt <= now)
  ) {
    return null;
  }
  const sameSite = attributes.find((a) => a.startsWith("samesite="));
  return {
    hostOnly: !attributes.some((a) => a.startsWith("domain=")),
    httpOnly: attributes.includes("httponly"),
    secure: attributes.includes("secure"),
    sameSite: sameSite === undefined ? null : sameSite.slice("samesite=".length),
  };
}

function summarizeSessionCookieIssuances(
  issuances: readonly SessionCookieIssuance[],
): SessionCookiePolicy {
  return {
    issuanceCount: issuances.length,
    hostOnly: issuances.length > 0 && issuances.every((issuance) => issuance.hostOnly),
    httpOnly: issuances.length > 0 && issuances.every((issuance) => issuance.httpOnly),
    secure: issuances.length > 0 && issuances.every((issuance) => issuance.secure),
    sameSiteLax: issuances.length > 0 && issuances.every((issuance) => issuance.sameSite === "lax"),
  };
}

/** Pure causal seam: every non-deletion issuance must satisfy the policy. */
export function sessionCookiePolicyFromHeaders(
  headers: readonly string[],
  now = Date.now(),
): SessionCookiePolicy {
  const issuances: SessionCookieIssuance[] = [];
  for (const header of headers) {
    const issuance = parseSessionCookieIssuance(header, now);
    if (issuance !== undefined && issuance !== null) issuances.push(issuance);
  }
  return summarizeSessionCookieIssuances(issuances);
}

export interface SessionCookieHeaderSource {
  url(): string;
  headersArray(): Promise<readonly { readonly name: string; readonly value: string }[]>;
}

/**
 * One append-only observer used by production and delayed-header plants.
 * Observer faults are accumulated as data so teardown can continue closing
 * every browser owner before the terminal selector reports the refusal.
 */
export class SessionCookieCollector {
  readonly issuances: SessionCookieIssuance[] = [];
  readonly failures: unknown[] = [];
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly previewOrigin: string) {}

  readonly observe = (response: SessionCookieHeaderSource): void => {
    if (this.stopped) return;
    let responseOrigin: string;
    try {
      responseOrigin = new URL(response.url()).origin;
    } catch (error) {
      this.failures.push(error);
      return;
    }
    if (responseOrigin !== this.previewOrigin) return;
    let observation!: Promise<void>;
    observation = (async () => {
      for (const header of await response.headersArray()) {
        if (header.name.toLowerCase() !== "set-cookie") continue;
        const issuance = parseSessionCookieIssuance(header.value);
        if (issuance !== undefined && issuance !== null) this.issuances.push(issuance);
      }
    })()
      .catch((error: unknown) => {
        this.failures.push(error);
      })
      .finally(() => {
        this.pending.delete(observation);
      });
    this.pending.add(observation);
  };

  stop(): void {
    this.stopped = true;
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  summarize(): SessionCookiePolicy {
    return summarizeSessionCookieIssuances(this.issuances);
  }
}

export interface SessionCookieFinalization<T> {
  readonly snapshot: T | undefined;
  readonly policy: SessionCookiePolicy;
  readonly evidenceFailures: readonly unknown[];
  readonly closeFailures: readonly unknown[];
}

/**
 * Shared lifecycle seam: snapshot while open, close while observation remains
 * attached, detach, dynamically drain, then summarize every issuance.
 */
export async function finalizeSessionCookieObservation<T>(args: {
  readonly snapshotJar: () => Promise<T>;
  readonly closeContext: () => Promise<void>;
  readonly closeFallback: () => Promise<void>;
  readonly stopObserving: () => void;
  readonly drain: () => Promise<void>;
  readonly summarize: () => SessionCookiePolicy;
  readonly observationFailures: () => readonly unknown[];
}): Promise<SessionCookieFinalization<T>> {
  let snapshot: T | undefined;
  const evidenceFailures: unknown[] = [];
  const closeFailures: unknown[] = [];
  try {
    snapshot = await args.snapshotJar();
  } catch (error) {
    evidenceFailures.push(error);
  }

  let contextClosed = false;
  try {
    await args.closeContext();
    contextClosed = true;
  } catch (error) {
    closeFailures.push(error);
  }
  if (!contextClosed) {
    try {
      await args.closeFallback();
    } catch (error) {
      closeFailures.push(error);
    }
  }
  try {
    args.stopObserving();
  } catch (error) {
    evidenceFailures.push(error);
  }
  try {
    await args.drain();
  } catch (error) {
    evidenceFailures.push(error);
  }
  if (contextClosed) {
    try {
      await args.closeFallback();
    } catch (error) {
      closeFailures.push(error);
    }
  }
  evidenceFailures.push(...args.observationFailures());
  let policy: SessionCookiePolicy;
  try {
    policy = args.summarize();
  } catch (error) {
    evidenceFailures.push(error);
    policy = {
      issuanceCount: 0,
      hostOnly: false,
      httpOnly: false,
      secure: false,
      sameSiteLax: false,
    };
  }
  return { snapshot, policy, evidenceFailures, closeFailures };
}

export function cookieDirectionIsProven(omission: CookieProbe, presented: CookieProbe): boolean {
  return (
    omission.attached === false &&
    omission.status === 403 &&
    omission.code === "WRONG_PRINCIPAL" &&
    presented.attached === true &&
    presented.status === 403 &&
    presented.code === "WRONG_PRINCIPAL"
  );
}

export type BrowserEvidenceSelection =
  | { readonly kind: "pass"; readonly enrollmentId: string }
  | { readonly kind: "blocked"; readonly code: string };

export type HttpResponseExpectation =
  | { readonly kind: "claim" }
  | { readonly kind: "hello" }
  | { readonly kind: "problem"; readonly status: number; readonly code: string }
  | {
      readonly kind: "proposals-present";
      readonly enrollmentId: string;
      readonly name: string;
      readonly model: string;
      readonly harness: string;
    }
  | { readonly kind: "proposals-absent"; readonly enrollmentId: string };

export type HttpResponseSelection =
  | { readonly kind: "claim" }
  | { readonly kind: "hello" }
  | { readonly kind: "problem"; readonly status: number; readonly code: string }
  | { readonly kind: "proposals-present" }
  | { readonly kind: "proposals-absent" };

function decodeCanonicalJsonBody(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_HTTP_RESPONSE_BYTES) {
    throw new Error("HTTP response body byte bound violated");
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("HTTP response body is not valid UTF-8");
  }
  if (raw.includes("\r") || raw.includes("\n") || raw.includes("\0")) {
    throw new Error("HTTP response body framing is not canonical");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("HTTP response body is not JSON");
  }
  // JSON.parse is last-writer-wins for duplicate object keys. Requiring exact
  // reserialization rejects duplicates, whitespace, and other prefix/suffix
  // tricks before any contract field is consulted.
  if (JSON.stringify(parsed) !== raw) {
    throw new Error("HTTP response body is not canonical JSON");
  }
  return parsed;
}

/** One strict contract selector shared by browser claims, shell HTTP, and plants. */
export function selectHttpResponseBytes(
  bytes: Uint8Array,
  status: number,
  expectation: HttpResponseExpectation,
): HttpResponseSelection {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error("HTTP status is invalid");
  }
  const parsed = decodeCanonicalJsonBody(bytes);
  if (expectation.kind === "problem") {
    const problem = ProblemDocumentSchema.safeParse(parsed);
    if (
      !problem.success ||
      status !== expectation.status ||
      problem.data.status !== expectation.status ||
      problem.data.code !== expectation.code ||
      problem.data.type !== `https://asimposium.org/errors/${expectation.code}`
    ) {
      throw new Error("HTTP problem response does not match its exact contract");
    }
    return { kind: "problem", status, code: expectation.code };
  }
  if (expectation.kind === "hello") {
    if (status !== 200 || !EnrollmentHelloResponseSchema.safeParse(parsed).success) {
      throw new Error("HTTP hello response does not match its exact contract");
    }
    return { kind: "hello" };
  }
  if (expectation.kind === "claim") {
    if (status !== 202 || !EnrollmentClaimResponseSchema.safeParse(parsed).success) {
      throw new Error("HTTP claim response does not match its exact contract");
    }
    // The flow handle is deliberately discarded instead of being returned.
    return { kind: "claim" };
  }

  const proposals = SponsorProposalListResponseSchema.safeParse(parsed);
  if (status !== 200 || !proposals.success) {
    throw new Error("HTTP proposal response does not match its exact contract");
  }
  const matching = proposals.data.proposals.filter(
    (proposal) => proposal.enrollment_id === expectation.enrollmentId,
  );
  if (expectation.kind === "proposals-absent") {
    if (matching.length !== 0) throw new Error("proposal was visible to the wrong sponsor");
    return { kind: "proposals-absent" };
  }
  if (
    matching.length !== 1 ||
    matching[0]?.name !== expectation.name ||
    matching[0]?.model !== expectation.model ||
    matching[0]?.harness !== expectation.harness ||
    matching[0]?.reasoning_effort !== undefined ||
    matching[0]?.tools_note !== undefined ||
    matching[0]?.status !== "pending" ||
    matching[0]?.effective_granted_scopes !== null ||
    matching[0]?.effective_granted_resources !== null
  ) {
    throw new Error("proposal attribution card is missing, duplicated, or wrong");
  }
  return { kind: "proposals-present" };
}

/** Curl transcript contract: canonical JSON body, one LF, exact three-digit status. */
export function selectHttpResponseTranscriptBytes(
  bytes: Uint8Array,
  expectation: HttpResponseExpectation,
): HttpResponseSelection {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_HTTP_RESPONSE_BYTES + 4) {
    throw new Error("HTTP response transcript byte bound violated");
  }
  const newline = bytes.lastIndexOf(0x0a);
  if (
    newline <= 0 ||
    newline !== bytes.byteLength - 4 ||
    bytes.subarray(0, newline).includes(0x0a)
  ) {
    throw new Error("HTTP response transcript framing is invalid");
  }
  const statusBytes = bytes.subarray(newline + 1);
  if (!statusBytes.every((byte) => byte >= 0x30 && byte <= 0x39)) {
    throw new Error("HTTP response transcript status is invalid");
  }
  const status = Number(String.fromCharCode(...statusBytes));
  return selectHttpResponseBytes(bytes.subarray(0, newline), status, expectation);
}

const BROWSER_RECORD_KEYS = [
  "tool",
  "package",
  "suite",
  "status",
  "code",
  "apex_host",
  "agent_host",
  "cookie",
  "cookie_omission_probe",
  "cookie_present_probe",
  "receipt",
  "edge_request_id",
  "detail",
  "duration_ms",
] as const;

function objectWithExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key, index) => key === keys[index])
  );
}

export interface S6EvidenceExpectedScalars {
  readonly revision: string;
  readonly deploymentId: string;
  readonly agoraHost: string;
  readonly stoaHost: string;
  readonly kid: string;
  readonly payloadSha256: string;
  readonly principalPseudonym: string;
  readonly initialLatencySeconds: number;
  readonly replayLatencySeconds: number;
  readonly browserLegSeconds: number;
  readonly runSeconds: number;
  readonly assertions: number;
  readonly failures: number;
}

function expectedS6EvidenceV4(expected: S6EvidenceExpectedScalars): unknown {
  return {
    suite: "s6-cross-plane-auth",
    schema_version: 4,
    bead: "asimposiumorg-vw3",
    revision: {
      value: expected.revision,
      source: "required_harness_input",
      verification: "format_only",
    },
    deployment: {
      id: expected.deploymentId,
      source: "required_harness_input",
      verification: "format_only",
      exercised_origins: {
        agora_host: expected.agoraHost,
        stoa_host: expected.stoaHost,
        source: "exercised_https_origin",
      },
    },
    service_envelope: {
      kid: expected.kid,
      method: "GET",
      action: "enrollment.proposals.list",
      payload_sha256: expected.payloadSha256,
      principal_pseudonym: { scheme: "sha256", value: expected.principalPseudonym },
      route_template: "/v1/enrollments/proposals",
      initial_response: {
        status: 200,
        code: null,
        latency_seconds: expected.initialLatencySeconds,
      },
      replay_response: {
        status: 401,
        code: "UNAUTHORIZED",
        latency_seconds: expected.replayLatencySeconds,
      },
    },
    cookie_assertions: {
      host_only: true,
      http_only: true,
      secure: true,
      same_site: "lax",
      scoped_to_apex: true,
      natural_agent_host: { attached: false, status: 403, code: "WRONG_PRINCIPAL" },
      explicit_agent_host: { attached: true, status: 403, code: "WRONG_PRINCIPAL" },
    },
    latency: {
      browser_leg_seconds: expected.browserLegSeconds,
      run_seconds: expected.runSeconds,
    },
    assertions: expected.assertions,
    failures: expected.failures,
  };
}

/** Shared exact schema validator for the retained S6 evidence bundle. */
export function selectS6EvidenceV4(value: unknown): Record<string, unknown> {
  if (
    !objectWithExactKeys(value, [
      "suite",
      "schema_version",
      "bead",
      "revision",
      "deployment",
      "service_envelope",
      "cookie_assertions",
      "latency",
      "assertions",
      "failures",
    ]) ||
    value.suite !== "s6-cross-plane-auth" ||
    value.schema_version !== 4 ||
    value.bead !== "asimposiumorg-vw3"
  ) {
    throw new Error("S6 evidence top-level schema is invalid");
  }
  const { revision, deployment, service_envelope, cookie_assertions, latency } = value;
  if (
    !objectWithExactKeys(revision, ["value", "source", "verification"]) ||
    typeof revision.value !== "string" ||
    !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(revision.value) ||
    revision.source !== "required_harness_input" ||
    revision.verification !== "format_only"
  ) {
    throw new Error("S6 revision provenance is invalid");
  }
  if (
    !objectWithExactKeys(deployment, ["id", "source", "verification", "exercised_origins"]) ||
    typeof deployment.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deployment.id) ||
    deployment.source !== "required_harness_input" ||
    deployment.verification !== "format_only" ||
    !objectWithExactKeys(deployment.exercised_origins, ["agora_host", "stoa_host", "source"]) ||
    typeof deployment.exercised_origins.agora_host !== "string" ||
    deployment.exercised_origins.agora_host.length === 0 ||
    typeof deployment.exercised_origins.stoa_host !== "string" ||
    deployment.exercised_origins.stoa_host.length === 0 ||
    deployment.exercised_origins.agora_host === deployment.exercised_origins.stoa_host ||
    deployment.exercised_origins.source !== "exercised_https_origin"
  ) {
    throw new Error("S6 deployment provenance is invalid");
  }
  if (
    !objectWithExactKeys(service_envelope, [
      "kid",
      "method",
      "action",
      "payload_sha256",
      "principal_pseudonym",
      "route_template",
      "initial_response",
      "replay_response",
    ]) ||
    typeof service_envelope.kid !== "string" ||
    service_envelope.kid.length === 0 ||
    service_envelope.method !== "GET" ||
    service_envelope.action !== "enrollment.proposals.list" ||
    typeof service_envelope.payload_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(service_envelope.payload_sha256) ||
    !objectWithExactKeys(service_envelope.principal_pseudonym, ["scheme", "value"]) ||
    service_envelope.principal_pseudonym.scheme !== "sha256" ||
    typeof service_envelope.principal_pseudonym.value !== "string" ||
    !/^[0-9a-f]{64}$/.test(service_envelope.principal_pseudonym.value) ||
    service_envelope.route_template !== "/v1/enrollments/proposals" ||
    !objectWithExactKeys(service_envelope.initial_response, [
      "status",
      "code",
      "latency_seconds",
    ]) ||
    service_envelope.initial_response.status !== 200 ||
    service_envelope.initial_response.code !== null ||
    !Number.isSafeInteger(service_envelope.initial_response.latency_seconds) ||
    (service_envelope.initial_response.latency_seconds as number) < 0 ||
    !objectWithExactKeys(service_envelope.replay_response, ["status", "code", "latency_seconds"]) ||
    service_envelope.replay_response.status !== 401 ||
    service_envelope.replay_response.code !== "UNAUTHORIZED" ||
    !Number.isSafeInteger(service_envelope.replay_response.latency_seconds) ||
    (service_envelope.replay_response.latency_seconds as number) < 0
  ) {
    throw new Error("S6 envelope evidence is invalid");
  }
  if (
    !objectWithExactKeys(cookie_assertions, [
      "host_only",
      "http_only",
      "secure",
      "same_site",
      "scoped_to_apex",
      "natural_agent_host",
      "explicit_agent_host",
    ]) ||
    cookie_assertions.host_only !== true ||
    cookie_assertions.http_only !== true ||
    cookie_assertions.secure !== true ||
    cookie_assertions.same_site !== "lax" ||
    cookie_assertions.scoped_to_apex !== true ||
    !objectWithExactKeys(cookie_assertions.natural_agent_host, ["attached", "status", "code"]) ||
    cookie_assertions.natural_agent_host.attached !== false ||
    cookie_assertions.natural_agent_host.status !== 403 ||
    cookie_assertions.natural_agent_host.code !== "WRONG_PRINCIPAL" ||
    !objectWithExactKeys(cookie_assertions.explicit_agent_host, ["attached", "status", "code"]) ||
    cookie_assertions.explicit_agent_host.attached !== true ||
    cookie_assertions.explicit_agent_host.status !== 403 ||
    cookie_assertions.explicit_agent_host.code !== "WRONG_PRINCIPAL"
  ) {
    throw new Error("S6 cookie evidence is invalid");
  }
  if (
    !objectWithExactKeys(latency, ["browser_leg_seconds", "run_seconds"]) ||
    !Number.isSafeInteger(latency.browser_leg_seconds) ||
    (latency.browser_leg_seconds as number) < 0 ||
    !Number.isSafeInteger(latency.run_seconds) ||
    (latency.run_seconds as number) < 0 ||
    !Number.isSafeInteger(value.assertions) ||
    (value.assertions as number) < 0 ||
    !Number.isSafeInteger(value.failures) ||
    (value.failures as number) < 0
  ) {
    throw new Error("S6 evidence counts or latency are invalid");
  }
  return value;
}

/** Bind every schema field to the immutable tuple captured by the shell writer. */
export function selectS6EvidenceAgainstExpected(
  value: unknown,
  expected: S6EvidenceExpectedScalars,
): void {
  const actual = selectS6EvidenceV4(value);
  const reconstructed = selectS6EvidenceV4(expectedS6EvidenceV4(expected));
  if (JSON.stringify(actual) !== JSON.stringify(reconstructed)) {
    throw new Error("S6 evidence does not match its captured expected tuple");
  }
}

/** Canonical one-line UTF-8 framing around the exact schema-v4 object. */
export function selectS6EvidenceBytes(
  bytes: Uint8Array,
  expected: S6EvidenceExpectedScalars,
): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_S6_EVIDENCE_BYTES) {
    throw new Error("S6 evidence byte bound violated");
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("S6 evidence is not valid UTF-8");
  }
  if (raw.includes("\r") || raw.includes("\0") || !raw.endsWith("\n")) {
    throw new Error("S6 evidence framing is not canonical");
  }
  const line = raw.slice(0, -1);
  if (line.length === 0 || line.includes("\n")) {
    throw new Error("S6 evidence must contain exactly one LF-terminated record");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("S6 evidence is not JSON");
  }
  if (JSON.stringify(parsed) !== line) {
    throw new Error("S6 evidence is not canonical JSON");
  }
  selectS6EvidenceAgainstExpected(parsed, expected);
}

function probeHasExactShape(value: unknown, attached: boolean): value is CookieProbe {
  return (
    objectWithExactKeys(value, ["attached", "status", "code"]) &&
    value.attached === attached &&
    Number.isInteger(value.status) &&
    typeof value.code === "string"
  );
}

function recordBaseIsExact(record: Record<string, unknown>): boolean {
  return (
    record.tool === "playwright" &&
    record.package === "e2e" &&
    record.suite === SUITE &&
    typeof record.code === "string" &&
    (typeof record.apex_host === "string" || record.apex_host === null) &&
    (typeof record.agent_host === "string" || record.agent_host === null) &&
    (typeof record.edge_request_id === "string" || record.edge_request_id === null) &&
    typeof record.detail === "string" &&
    record.detail.length > 0 &&
    Number.isSafeInteger(record.duration_ms) &&
    (record.duration_ms as number) >= 0
  );
}

/**
 * Strict evidence selector shared by the live runner's validator mode and the
 * causal unit plants. Canonical JSON bytes are part of the contract: this
 * rejects duplicate keys, reordered/extra keys, whitespace drift, malformed
 * UTF-8, multiple records, and a missing final LF before any field is trusted.
 */
export function selectBrowserEvidenceBytes(
  bytes: Uint8Array,
  childExit: number,
): BrowserEvidenceSelection {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BROWSER_EVIDENCE_BYTES) {
    throw new Error("browser evidence byte bound violated");
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("browser evidence is not valid UTF-8");
  }
  if (raw.includes("\r") || raw.includes("\0") || !raw.endsWith("\n")) {
    throw new Error("browser evidence framing is not canonical");
  }
  const line = raw.slice(0, -1);
  if (line.length === 0 || line.includes("\n")) {
    throw new Error("browser evidence must contain exactly one LF-terminated record");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("browser evidence is not JSON");
  }
  if (!objectWithExactKeys(parsed, BROWSER_RECORD_KEYS) || JSON.stringify(parsed) !== line) {
    throw new Error("browser evidence is not the canonical record schema");
  }
  if (!recordBaseIsExact(parsed)) throw new Error("browser evidence base fields are invalid");

  if (childExit === BLOCKED_EXIT && parsed.status === "blocked") {
    if (
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(parsed.code as string) ||
      parsed.cookie !== null ||
      parsed.cookie_omission_probe !== null ||
      parsed.cookie_present_probe !== null ||
      parsed.receipt !== null
    ) {
      throw new Error("blocked browser evidence is not exact");
    }
    return { kind: "blocked", code: parsed.code as string };
  }

  if (childExit !== 0 || parsed.status !== "pass" || parsed.code !== "OK") {
    throw new Error("browser evidence status does not match the child exit");
  }
  if (
    typeof parsed.apex_host !== "string" ||
    typeof parsed.agent_host !== "string" ||
    parsed.apex_host === parsed.agent_host
  ) {
    throw new Error("browser evidence origins are invalid");
  }
  if (
    !objectWithExactKeys(parsed.cookie, [
      "issuance_count",
      "host_only",
      "http_only",
      "secure",
      "same_site",
      "scoped_to_apex",
      "present_for_agent_host",
    ]) ||
    !Number.isSafeInteger(parsed.cookie.issuance_count) ||
    (parsed.cookie.issuance_count as number) < 1 ||
    parsed.cookie.host_only !== true ||
    parsed.cookie.http_only !== true ||
    parsed.cookie.secure !== true ||
    parsed.cookie.same_site !== "lax" ||
    parsed.cookie.scoped_to_apex !== true ||
    parsed.cookie.present_for_agent_host !== false
  ) {
    throw new Error("browser cookie evidence is invalid");
  }
  if (
    !probeHasExactShape(parsed.cookie_omission_probe, false) ||
    !probeHasExactShape(parsed.cookie_present_probe, true) ||
    !cookieDirectionIsProven(parsed.cookie_omission_probe, parsed.cookie_present_probe)
  ) {
    throw new Error("browser principal-direction evidence is invalid");
  }
  if (
    !objectWithExactKeys(parsed.receipt, [
      "enrollment_id",
      "absent_before_action",
      "dedicated_locator",
      "exact_worker_origin",
      "exact_join_path",
    ]) ||
    typeof parsed.receipt.enrollment_id !== "string" ||
    !EnrollmentIdSchema.safeParse(parsed.receipt.enrollment_id).success ||
    parsed.receipt.absent_before_action !== true ||
    parsed.receipt.dedicated_locator !== true ||
    parsed.receipt.exact_worker_origin !== true ||
    parsed.receipt.exact_join_path !== true
  ) {
    throw new Error("browser origination receipt is invalid");
  }
  return { kind: "pass", enrollmentId: parsed.receipt.enrollment_id };
}

function readBoundedRegularFile(path: string, maximumBytes: number, purpose: string): Uint8Array {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maximumBytes) {
      throw new Error(`${purpose} is not a bounded regular file`);
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`${purpose} was short-read`);
      offset += count;
    }
    const after = fstatSync(fd);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.size !== before.size
    ) {
      throw new Error(`${purpose} changed while read`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function browserRecordValidatorMode(): never {
  try {
    const statusRaw = process.argv[3];
    const path = process.argv[4];
    if (process.argv.length !== 5 || !/^(0|1|78)$/.test(statusRaw ?? "") || !path) {
      throw new Error("invalid browser evidence validator invocation");
    }
    const selected = selectBrowserEvidenceBytes(
      readBoundedRegularFile(path, MAX_BROWSER_EVIDENCE_BYTES, "browser evidence file"),
      Number(statusRaw),
    );
    if (selected.kind === "pass") {
      writeStdoutLine(`pass\t${selected.enrollmentId}`);
      process.exit(0);
    }
    writeStdoutLine(`blocked\t${selected.code}`);
    process.exit(BLOCKED_EXIT);
  } catch {
    process.exit(1);
  }
}

function evidenceValidatorMode(): never {
  try {
    const path = process.argv[3];
    if (process.argv.length !== 17 || !path) {
      throw new Error("invalid S6 evidence validator invocation");
    }
    const integer = (index: number): number => {
      const raw = process.argv[index] ?? "";
      if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
        throw new Error("invalid S6 evidence expected integer");
      }
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed)) {
        throw new Error("S6 evidence expected integer exceeds the safe range");
      }
      return parsed;
    };
    const expected: S6EvidenceExpectedScalars = {
      revision: process.argv[4] ?? "",
      deploymentId: process.argv[5] ?? "",
      agoraHost: process.argv[6] ?? "",
      stoaHost: process.argv[7] ?? "",
      kid: process.argv[8] ?? "",
      payloadSha256: process.argv[9] ?? "",
      principalPseudonym: process.argv[10] ?? "",
      initialLatencySeconds: integer(11),
      replayLatencySeconds: integer(12),
      browserLegSeconds: integer(13),
      runSeconds: integer(14),
      assertions: integer(15),
      failures: integer(16),
    };
    selectS6EvidenceBytes(
      readBoundedRegularFile(path, MAX_S6_EVIDENCE_BYTES, "S6 evidence file"),
      expected,
    );
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

export function enrollmentIdIsValid(enrollmentId: string): boolean {
  return EnrollmentIdSchema.safeParse(enrollmentId).success;
}

export function claimNameForEnrollment(enrollmentId: string): string {
  const id = EnrollmentIdSchema.parse(enrollmentId);
  const suffix = id.slice("ASIMP-EN-".length).toLowerCase();
  return FellowNameSchema.parse(`s6-${suffix.slice(-29)}`);
}

function httpResponseValidatorMode(): never {
  try {
    const path = process.argv[3];
    const kind = process.argv[4];
    if (!path || !kind) throw new Error("invalid HTTP response validator invocation");
    let expectation: HttpResponseExpectation;
    if (kind === "problem" && process.argv.length === 7) {
      const statusRaw = process.argv[5] ?? "";
      const code = process.argv[6] ?? "";
      if (!/^[1-5][0-9]{2}$/.test(statusRaw) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
        throw new Error("invalid problem expectation");
      }
      expectation = { kind, status: Number(statusRaw), code };
    } else if (kind === "hello" && process.argv.length === 5) {
      expectation = { kind };
    } else if (
      (kind === "proposals-present" || kind === "proposals-absent") &&
      process.argv.length === 6
    ) {
      const enrollmentId = EnrollmentIdSchema.parse(process.argv[5]);
      expectation =
        kind === "proposals-present"
          ? {
              kind,
              enrollmentId,
              name: claimNameForEnrollment(enrollmentId),
              model: CLAIM_MODEL,
              harness: CLAIM_HARNESS,
            }
          : { kind, enrollmentId };
    } else {
      throw new Error("invalid HTTP response validator invocation");
    }
    const selected = selectHttpResponseTranscriptBytes(
      readBoundedRegularFile(path, MAX_HTTP_RESPONSE_BYTES + 4, "HTTP response transcript"),
      expectation,
    );
    writeStdoutLine(`ok\t${selected.kind}`);
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

function looksLikeChallenge(url: string, body: string): boolean {
  return (
    /\/challenge\/|\/signin\/rejected|captcha|deniedsigninrejected/i.test(url) ||
    /verify it.s you|couldn.t sign you in|2-step verification/i.test(body)
  );
}

function isMissingBrowserExecutable(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const message = (error as { message?: unknown })?.message;
  return (
    code === "ENOENT" ||
    (typeof message === "string" && /executable (?:doesn't exist|not found)/i.test(message))
  );
}

async function exactProbeResult(
  response: APIResponse,
  expectedUrl: string,
  attached: boolean,
): Promise<CookieProbe> {
  if (new URL(response.url()).href !== new URL(expectedUrl).href) {
    throw new Error("agent-host probe did not terminate at the exact configured URL");
  }
  selectHttpResponseBytes(await response.body(), response.status(), {
    kind: "problem",
    status: 403,
    code: "WRONG_PRINCIPAL",
  });
  return { attached, status: 403, code: "WRONG_PRINCIPAL" };
}

export interface SessionCookieJarSnapshot {
  readonly apexFamilyCount: number;
  readonly scopedToApex: boolean;
  readonly agentFamilyCount: number;
}

function cookieAttributesFromFinalization(
  policy: SessionCookiePolicy,
  snapshot: SessionCookieJarSnapshot | undefined,
): CookieAttributes {
  return {
    issuance_count: policy.issuanceCount,
    host_only: policy.hostOnly,
    http_only: policy.httpOnly,
    secure: policy.secure,
    same_site: policy.sameSiteLax ? "lax" : null,
    scoped_to_apex: snapshot !== undefined && snapshot.apexFamilyCount > 0 && snapshot.scopedToApex,
    present_for_agent_host: snapshot === undefined || snapshot.agentFamilyCount > 0,
  };
}

export interface SessionCookieFinalizationVerdict {
  readonly cookie: CookieAttributes;
  readonly failureCode:
    | "SET_COOKIE_OBSERVATION_FAILED"
    | "COOKIE_POLICY_CHANGED_DURING_FLOW"
    | null;
}

/** Pure terminal seam shared by production and the delayed unsafe-header plant. */
export function sessionCookieFinalizationVerdict(
  finalization: SessionCookieFinalization<SessionCookieJarSnapshot>,
): SessionCookieFinalizationVerdict {
  const cookie = cookieAttributesFromFinalization(finalization.policy, finalization.snapshot);
  if (finalization.evidenceFailures.length > 0) {
    return { cookie, failureCode: "SET_COOKIE_OBSERVATION_FAILED" };
  }
  if (
    !cookie.host_only ||
    !cookie.http_only ||
    !cookie.secure ||
    cookie.same_site !== "lax" ||
    !cookie.scoped_to_apex ||
    cookie.present_for_agent_host
  ) {
    return { cookie, failureCode: "COOKIE_POLICY_CHANGED_DURING_FLOW" };
  }
  return { cookie, failureCode: null };
}

async function claimMintedEnrollment(
  claimContext: BrowserContext,
  joinUrl: string,
  workerUrl: string,
): Promise<{ readonly enrollmentId: string; readonly name: string }> {
  const parsed = parseStoaJoinUrl(joinUrl);
  const workerOrigin = new URL(workerUrl).origin;
  if (parsed === undefined || parsed.origin !== workerOrigin) {
    throw new Error("join receipt failed the trusted exact-origin contract");
  }
  const name = claimNameForEnrollment(parsed.enrollmentId);
  const request = FellowRegistrationRequestSchema.parse({
    enrollment_id: parsed.enrollmentId,
    secret: parsed.secret,
    name,
    model: CLAIM_MODEL,
    harness: CLAIM_HARNESS,
  });
  const claimUrl = new URL("/v1/fellows", workerUrl).href;
  const response = await claimContext.request.post(claimUrl, {
    data: request,
    failOnStatusCode: false,
    maxRedirects: 0,
    headers: {
      "content-type": "application/json",
      "idempotency-key": `s6-claim-${parsed.enrollmentId}`,
    },
  });
  if (
    new URL(response.url()).href !== new URL(claimUrl).href ||
    response.headers()["cache-control"] !== "no-store"
  ) {
    throw new Error("claim response URL or cache policy was not exact");
  }
  selectHttpResponseBytes(await response.body(), response.status(), { kind: "claim" });
  // Neither the request (which contains the fragment) nor the response flow
  // handle leaves this scope. Only public attribution fields are returned.
  return { enrollmentId: parsed.enrollmentId, name };
}

async function main(): Promise<Omit<Record_, "duration_ms">> {
  // Configuration arrives as ONE bounded JSON record on stdin, never through
  // argv or the environment. Chromium is spawned from this process, so anything
  // left in `process.env` would be inherited by the browser and every renderer
  // it forks; a secret that is never in the environment cannot be.
  // Read to EOF and validate EXACT bytes: one record, one trailing LF, nothing
  // after it. The cap counts BYTES, not UTF-16 units, so a multi-byte payload
  // cannot exceed the intended bound while passing a character-count check.
  // ROOT CAUSE, measured on bun 1.3.8 / macOS: `Bun.stdin.stream()` never
  // observes end-of-stream when stdin is a FIFO. The record arrives in full —
  // the descriptor's offset equals its length and no writer remains — and the
  // process then blocks forever. The same code terminates over a plain pipe, so
  // the defect only appears once the real transport is used. A bounded
  // synchronous read is not subject to it.
  //
  // MAX+1 is read deliberately: reading exactly MAX cannot distinguish a full
  // record from an overflowing one, and over-cap must be refused, not truncated.
  const buffer = Buffer.alloc(MAX_CONFIG_RECORD_BYTES + 1);
  let total = 0;
  for (;;) {
    let read = 0;
    try {
      read = readSync(0, buffer, total, buffer.length - total, null);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      // EINTR is a genuine, bounded interruption and is retried. EAGAIN is NOT:
      // a non-blocking descriptor would make this an unbounded CPU spin, and the
      // runner's deadline is not armed until after this loop. Typed refusal.
      if (code === "EINTR") continue;
      if (code === "EOF") break;
      if (code === "EAGAIN") {
        blocked("CONFIG_STDIN_NONBLOCKING", "stdin is non-blocking; refusing to spin on it");
      }
      throw error;
    }
    if (read === 0) break;
    total += read;
    if (total > MAX_CONFIG_RECORD_BYTES) {
      blocked("CONFIG_RECORD_TOO_LARGE", "the configuration record exceeded its byte bound");
    }
  }
  // FATAL decoding: a malformed byte is a refusal, never U+FFFD substituted into
  // a credential field.
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
  } catch {
    blocked("CONFIG_RECORD_INVALID", "the configuration record is not valid UTF-8");
  }
  const lines = raw.split("\n");
  if (lines.length !== 2 || lines[1] !== "") {
    blocked("CONFIG_RECORD_INVALID", "expected exactly one LF-terminated configuration record");
  }

  let previewUrl: string | undefined;
  let workerUrl: string | undefined;
  let user: string | undefined;
  let password: string | undefined;
  try {
    const parsed = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    previewUrl = typeof parsed.previewUrl === "string" ? parsed.previewUrl : undefined;
    workerUrl = typeof parsed.workerUrl === "string" ? parsed.workerUrl : undefined;
    user = typeof parsed.user === "string" ? parsed.user : undefined;
    password = typeof parsed.password === "string" ? parsed.password : undefined;
  } catch {
    // The message could quote the record, so only the class is reported.
    blocked("CONFIG_RECORD_INVALID", "the configuration record on stdin was not valid JSON");
  }

  if (!previewUrl || !workerUrl || !user || !password) {
    blocked(
      "CONFIG_ABSENT",
      "the stdin record must carry previewUrl, workerUrl, user and password; this runner has no storage-state fallback because a jar cannot prove what the origin sent",
    );
  }

  const apexHost = originHost(previewUrl, "ASIMP_S6_PREVIEW_URL");
  const agentHost = originHost(workerUrl, "ASIMP_S6_WORKER_URL");
  if (apexHost === agentHost) {
    blocked("PLANES_NOT_SPLIT", "the two origins resolve to one host", apexHost);
  }

  const previewOrigin = new URL(previewUrl).origin;
  const workerOrigin = new URL(workerUrl).origin;
  const consoleUrl = new URL("/console", previewUrl).href;
  const probeUrl = new URL("/v1/enrollments/proposals", workerUrl).href;

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let forcedCookieContext: BrowserContext | undefined;
  let claimContext: BrowserContext | undefined;
  let cookieCollector: SessionCookieCollector | undefined;
  let cookieFinalization: SessionCookieFinalization<SessionCookieJarSnapshot> | undefined;
  let candidateRecord: Omit<Record_, "duration_ms"> | undefined;
  // The deadline callback and `finally` share one teardown owner. Whichever
  // path arrives first starts the closes; the other joins the same promise, so
  // context/browser can never be closed concurrently by competing owners.
  const teardownOnce = oneShotAsync(async () => {
    const teardown: unknown[] = [];
    let teardownTimedOut = false;
    let teardownTimer: ReturnType<typeof setTimeout> | undefined;
    const teardownBound = new Promise<void>((resolve) => {
      teardownTimer = setTimeout(() => {
        teardownTimedOut = true;
        resolve();
      }, CLOSE_GRACE_MS);
      teardownTimer.unref?.();
    });
    await Promise.race([
      (async () => {
        await forcedCookieContext?.close().catch((error: unknown) => teardown.push(error));
        await claimContext?.close().catch((error: unknown) => teardown.push(error));
        if (context !== undefined && cookieCollector !== undefined) {
          const ownedContext = context;
          const ownedBrowser = browser;
          const ownedCollector = cookieCollector;
          cookieFinalization = await finalizeSessionCookieObservation({
            snapshotJar: async () => {
              const apexFamily = (await ownedContext.cookies(previewUrl)).filter((entry) =>
                isSessionCookieName(entry.name),
              );
              const agentFamily = (await ownedContext.cookies(probeUrl)).filter((entry) =>
                isSessionCookieName(entry.name),
              );
              return {
                apexFamilyCount: apexFamily.length,
                scopedToApex:
                  apexFamily.length > 0 &&
                  apexFamily.every(
                    (entry) => entry.domain.replace(/^\./, "") === apexHost && entry.path === "/",
                  ),
                agentFamilyCount: agentFamily.length,
              };
            },
            closeContext: () => ownedContext.close(),
            closeFallback: async () => {
              await ownedBrowser?.close();
            },
            stopObserving: () => {
              ownedCollector.stop();
              ownedContext.off("response", ownedCollector.observe);
            },
            drain: () => ownedCollector.drain(),
            summarize: () => ownedCollector.summarize(),
            observationFailures: () => ownedCollector.failures,
          });
          teardown.push(...cookieFinalization.closeFailures);
        } else {
          await context?.close().catch((error: unknown) => teardown.push(error));
          await browser?.close().catch((error: unknown) => teardown.push(error));
        }
      })(),
      teardownBound,
    ]);
    if (teardownTimer !== undefined) clearTimeout(teardownTimer);
    if (teardownTimedOut) {
      teardownFailed = -1;
    } else if (teardown.length > 0) {
      teardownFailed = teardown.length;
    }
  });
  // A single monotonic bound over post-configuration browser work, including
  // browser teardown. `readConfiguration()` is synchronously blocking by
  // design; the production shell owns and causally tests the outer
  // `run_bounded` deadline across that stdin phase. Running this file directly
  // is therefore not standalone whole-run boundedness proof.
  const budget = setTimeout(() => {
    // `latchDeadlineAndTeardown` executes synchronously through its first await.
    // If normal completion races this callback, the terminal selector therefore
    // sees the fired deadline before either path waits on shared teardown.
    // A hung await cannot be unwound by throwing, so this path exits the
    // process — but it joins the single bounded teardown owner FIRST instead of
    // trusting exit to tidy up. The shell's group sweep remains the backstop if
    // teardown reports its bound expired.
    void (async () => {
      await latchDeadlineAndTeardown(teardownOnce);
      publishTerminal({
        exitStatus: 1,
        record: {
          tool: "playwright",
          package: "e2e",
          suite: SUITE,
          status: "fail",
          code: "RUNNER_DEADLINE_EXCEEDED",
          apex_host: apexHost,
          agent_host: agentHost,
          cookie: null,
          cookie_omission_probe: null,
          cookie_present_probe: null,
          receipt: null,
          edge_request_id: null,
          detail: `the runner exceeded its ${TOTAL_BUDGET_MS}ms budget`,
        },
      });
    })();
  }, TOTAL_BUDGET_MS);
  budget.unref?.();

  try {
    try {
      browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
    } catch (error) {
      if (isMissingBrowserExecutable(error)) {
        blocked(
          "PLAYWRIGHT_BROWSER_MISSING",
          "the Playwright Chromium executable is not installed for this package version",
          apexHost,
        );
      }
      failed(
        "PLAYWRIGHT_BROWSER_LAUNCH_FAILED",
        `Chromium launch failed with ${(error as Error)?.constructor?.name ?? "Error"}`,
        apexHost,
      );
    }
    context = await browser.newContext();
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);

    // Every non-deletion issuance matters. A later safe header cannot erase an
    // earlier Domain-bearing one, and an observer fault is itself a typed
    // refusal rather than an implicit "nothing unsafe was seen".
    cookieCollector = new SessionCookieCollector(previewOrigin);
    context.on("response", cookieCollector.observe);

    const page = await context.newPage();
    // ONE honest request-correlation value: the edge's `x-vercel-id`, nullable.
    //
    // It is NOT a build or revision pin, and this makes no such claim. Earlier
    // revisions called it "immutable deployment evidence" and also folded
    // `x-vercel-deployment-url` into the same field — two different kinds of
    // identity behind one overclaiming name. If a deployment identity is ever
    // required, it needs its own field and its own validation against a source
    // the platform supports for that purpose.
    const consoleResponse = await page.goto(consoleUrl);
    const edgeRequestId: string | null = consoleResponse?.headers()["x-vercel-id"] ?? null;

    // The console is behind Auth.js; an unauthenticated visit offers Google.
    const signIn = page.getByRole("button", { name: /sign in with google/i });
    if (selectGoogleLoginAction(await signIn.count()) !== "perform-google-login") {
      failed(
        "GOOGLE_LOGIN_PRECONDITION_FAILED",
        "the initial console page did not expose a Google sign-in control, so this run cannot prove credential use from an unauthenticated state",
        apexHost,
      );
    }
    await signIn.first().click();
    // Real Google sign-in. Bot challenges are common and are reported as
    // blocked, never as a failure of the seam and never as a pass.
    try {
      await page.waitForURL((url) => isExactGoogleAccountsOrigin(url.href), {
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      const emailHandle = await page.locator('input[type="email"]').elementHandle();
      if (emailHandle === null) throw new Error("Google email input was absent");
      await performAtExactGoogleOwnerFrame(emailHandle, page.mainFrame(), () =>
        emailHandle.fill(user),
      );
      await page.getByRole("button", { name: /next/i }).click();
      await page.locator('input[type="password"]').waitFor({ state: "visible" });
      // `fill` does not log its argument; the password never reaches a record.
      const passwordHandle = await page.locator('input[type="password"]').elementHandle();
      if (passwordHandle === null) throw new Error("Google password input was absent");
      await performAtExactGoogleOwnerFrame(passwordHandle, page.mainFrame(), () =>
        passwordHandle.fill(password),
      );
      await page.getByRole("button", { name: /next/i }).click();
      await page.waitForURL(consoleUrl, { timeout: NAVIGATION_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof RunnerExit) throw error;
      const currentUrl = page.url();
      const body = await page.content().catch(() => "");
      if (looksLikeChallenge(currentUrl, body)) {
        blocked(
          "GOOGLE_LOGIN_CHALLENGED",
          "Google interrupted the automated sign-in with a verification challenge; provision a test account exempt from the challenge, then re-run",
          apexHost,
        );
      }
      failed(
        "GOOGLE_LOGIN_FAILED",
        "the configured test account did not reach the exact Agora console URL",
        apexHost,
      );
    }
    if (page.url() !== consoleUrl) {
      failed(
        "CONSOLE_ORIGIN_OR_PATH_WRONG",
        "the authenticated page did not finish at the exact configured Agora console URL",
        apexHost,
      );
    }

    // Drain every header observation before deciding what was seen.
    await cookieCollector.drain();
    if (cookieCollector.failures.length > 0) {
      failed(
        "SET_COOKIE_OBSERVATION_FAILED",
        "at least one Agora Set-Cookie response could not be observed exactly",
        apexHost,
      );
    }
    const initialPolicy = cookieCollector.summarize();
    if (initialPolicy.issuanceCount === 0) {
      failed(
        "SET_COOKIE_NOT_OBSERVED",
        "no non-deletion session Set-Cookie issuance was seen from the exact Agora origin",
        apexHost,
      );
    }

    // The jar half of the claim: every live session-family chunk is scoped to
    // the apex and naturally ineligible for the exact Worker URL.
    const apexJar = await context.cookies(previewUrl);
    const session = apexJar.filter((entry) => isSessionCookieName(entry.name));
    const naturalWorkerSession = (await context.cookies(probeUrl)).filter((entry) =>
      isSessionCookieName(entry.name),
    );
    const cookie: CookieAttributes = {
      issuance_count: initialPolicy.issuanceCount,
      host_only: initialPolicy.hostOnly,
      http_only: initialPolicy.httpOnly,
      secure: initialPolicy.secure,
      same_site: initialPolicy.sameSiteLax ? "lax" : null,
      scoped_to_apex:
        session.length > 0 &&
        session.every(
          (entry) => entry.domain.replace(/^\./, "") === apexHost && entry.path === "/",
        ),
      present_for_agent_host: naturalWorkerSession.length > 0,
    };

    const cookieOk =
      cookie.host_only &&
      cookie.http_only &&
      cookie.secure &&
      cookie.same_site === "lax" &&
      cookie.scoped_to_apex &&
      !cookie.present_for_agent_host;

    if (!cookieOk) {
      throw new RunnerExit(
        {
          tool: "playwright",
          package: "e2e",
          suite: SUITE,
          status: "fail",
          code: "COOKIE_NOT_HOST_ONLY",
          apex_host: apexHost,
          agent_host: agentHost,
          cookie,
          cookie_omission_probe: null,
          cookie_present_probe: null,
          receipt: null,
          edge_request_id: edgeRequestId,
          detail: "the live Set-Cookie header or the resulting jar failed host-only apex scoping",
        },
        1,
      );
    }

    // Direction A: natural browser eligibility. The live apex session family is
    // absent for Stoa, and an exact no-redirect request is refused.
    const omissionResponse = await context.request.get(probeUrl, {
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    let cookieOmissionProbe: CookieProbe;
    try {
      cookieOmissionProbe = await exactProbeResult(omissionResponse, probeUrl, false);
    } catch {
      failed(
        "AGENT_HOST_OMISSION_PROBE_REDIRECTED",
        "the natural-omission probe did not terminate at the exact configured Worker URL",
        apexHost,
      );
    }

    // Direction B: a separate in-memory context explicitly presents every live
    // session-family chunk to the exact Stoa origin. Values never leave
    // Playwright memory and are never interpolated into diagnostics or output.
    forcedCookieContext = await browser.newContext();
    forcedCookieContext.setDefaultTimeout(ACTION_TIMEOUT_MS);
    await forcedCookieContext.addCookies(
      session.map((entry) => ({
        name: entry.name,
        value: entry.value,
        url: workerOrigin,
        httpOnly: entry.httpOnly,
        secure: entry.secure,
        sameSite: entry.sameSite,
        ...(entry.expires > 0 ? { expires: entry.expires } : {}),
      })),
    );
    const forcedEligible = (await forcedCookieContext.cookies(probeUrl)).filter((entry) =>
      isSessionCookieName(entry.name),
    );
    if (session.length === 0 || forcedEligible.length !== session.length) {
      failed(
        "COOKIE_PRESENTATION_SETUP_FAILED",
        "the isolated probe context did not hold the complete live session family for Stoa",
        apexHost,
      );
    }
    const presentedResponse = await forcedCookieContext.request.get(probeUrl, {
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    let cookiePresentProbe: CookieProbe;
    try {
      cookiePresentProbe = await exactProbeResult(presentedResponse, probeUrl, true);
    } catch {
      failed(
        "AGENT_HOST_COOKIE_PRESENT_PROBE_REDIRECTED",
        "the explicit-cookie probe did not terminate at the exact configured Worker URL",
        apexHost,
      );
    }

    if (!cookieDirectionIsProven(cookieOmissionProbe, cookiePresentProbe)) {
      throw new RunnerExit(
        {
          tool: "playwright",
          package: "e2e",
          suite: SUITE,
          status: "fail",
          code: "WRONG_PRINCIPAL_DIRECTION_NOT_PROVEN",
          apex_host: apexHost,
          agent_host: agentHost,
          cookie,
          cookie_omission_probe: cookieOmissionProbe,
          cookie_present_probe: cookiePresentProbe,
          receipt: null,
          edge_request_id: edgeRequestId,
          detail:
            "natural omission and explicit live-cookie presentation did not both receive exact 403 WRONG_PRINCIPAL",
        },
        1,
      );
    }

    // The real Server Action, reached the way a sponsor reaches it.
    const secondConsoleResponse = await page.goto(consoleUrl);
    if (
      secondConsoleResponse === null ||
      !secondConsoleResponse.ok() ||
      page.url() !== consoleUrl
    ) {
      failed(
        "CONSOLE_SECOND_NAVIGATION_FAILED",
        "the second console navigation did not return successfully at the exact Agora URL",
        apexHost,
      );
    }
    const mint = page.getByRole("button", { name: /^Mint a join URL$/ });
    if ((await mint.count()) === 0) {
      const typedProvisioningSignal = page.getByText(
        /^Join-URL minting is disabled because this deployment cannot prepare recoverable writes\.$/,
      );
      if ((await typedProvisioningSignal.count()) === 1) {
        blocked(
          "CONSOLE_WRITES_NOT_PROVISIONED",
          "the console explicitly reported that recoverable writes are not provisioned",
          apexHost,
        );
      }
      failed(
        "CONSOLE_MINT_CONTROL_MISSING",
        "the authenticated console omitted the mint control without the exact provisioning signal",
        apexHost,
      );
    }
    if ((await mint.count()) !== 1) {
      failed(
        "CONSOLE_MINT_CONTROL_AMBIGUOUS",
        "the console exposed multiple mint controls",
        apexHost,
      );
    }
    const joinReceipt = page.locator("pre.pasteblock.join-url");
    let receiptCountBefore: number;
    try {
      receiptCountBefore = await joinReceipt.count();
    } catch {
      failed(
        "MINT_RECEIPT_BASELINE_FAILED",
        "the dedicated join receipt could not be counted before the action",
        apexHost,
      );
    }
    if (receiptCountBefore !== 0) {
      failed(
        "MINT_RECEIPT_PREEXISTED",
        "the dedicated join receipt was already present before the action",
        apexHost,
      );
    }

    await mint.first().click();
    await joinReceipt.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
    if ((await joinReceipt.count()) !== 1) {
      failed(
        "MINT_RECEIPT_AMBIGUOUS",
        "the action did not render exactly one visible dedicated join receipt",
        apexHost,
      );
    }
    // Lift the exact dedicated line into Playwright memory only long enough to
    // consume its one-time fragment in the real Fellow claim. It is never
    // emitted, persisted, placed in argv/environment, or quoted by an error.
    let claimed: { readonly enrollmentId: string; readonly name: string };
    {
      const joinUrl = await joinReceipt.evaluate((element) => {
        const prefix = "Your join URL is  ";
        const lines = (element.textContent ?? "").split("\n");
        const candidates = lines.filter((line: string) => line.startsWith(prefix));
        if (!element.matches("pre.pasteblock.join-url") || candidates.length !== 1) return null;
        return candidates[0]?.slice(prefix.length) ?? null;
      });
      if (joinUrl === null) {
        failed(
          "MINT_RECEIPT_INVALID",
          "the dedicated receipt did not contain one exact trusted-origin join URL",
          apexHost,
        );
      }

      claimContext = await browser.newContext();
      claimContext.setDefaultTimeout(ACTION_TIMEOUT_MS);
      if ((await claimContext.cookies()).length !== 0) {
        failed(
          "CLAIM_CONTEXT_NOT_ISOLATED",
          "the Fellow claim context unexpectedly contained browser credentials",
          apexHost,
        );
      }
      try {
        claimed = await claimMintedEnrollment(claimContext, joinUrl, workerUrl);
      } catch {
        failed(
          "FELLOW_CLAIM_FAILED",
          "the transient join fragment did not produce the exact 202 Fellow claim contract",
          apexHost,
        );
      }
    }
    const receipt = {
      enrollment_id: claimed.enrollmentId,
      absent_before_action: true,
      dedicated_locator: true,
      exact_worker_origin: true,
      exact_join_path: true,
    };

    // The pass candidate is retained, not emitted here.
    //
    // Emitting inside `try` published a success before `finally` had closed the
    // context and the browser, so a teardown failure could follow an already
    // published pass — and exit 0 with Chromium still up. The caller emits it
    // only after cleanup has actually completed.
    candidateRecord = {
      tool: "playwright",
      package: "e2e",
      suite: SUITE,
      status: "pass",
      code: "OK",
      apex_host: apexHost,
      agent_host: agentHost,
      cookie,
      cookie_omission_probe: cookieOmissionProbe,
      cookie_present_probe: cookiePresentProbe,
      receipt,
      edge_request_id: edgeRequestId,
      detail:
        "every live session issuance was host-only and safe, natural omission plus explicit cookie presentation both proved WRONG_PRINCIPAL at Stoa, and the dedicated console receipt was claimed through the exact Worker contract",
    };
  } finally {
    // The absolute deadline stays ARMED through teardown.
    //
    // Clearing it here first left the closes unbounded: a wedged
    // `context.close()` or `browser.close()` could hang forever with no deadline
    // left to stop it. The budget is only cleared once teardown has finished,
    // and a teardown that outlives its own bound is recorded as a typed failure
    // rather than being awaited indefinitely.
    await teardownOnce();
    clearTimeout(budget);
  }

  if (candidateRecord === undefined || cookieFinalization === undefined) {
    failed(
      "SET_COOKIE_FINALIZATION_FAILED",
      "the browser settled without complete post-close cookie evidence",
      apexHost,
    );
  }
  const cookieVerdict = sessionCookieFinalizationVerdict(cookieFinalization);
  const finalCookie = cookieVerdict.cookie;
  if (cookieVerdict.failureCode === "SET_COOKIE_OBSERVATION_FAILED") {
    throw new RunnerExit(
      {
        ...candidateRecord,
        status: "fail",
        code: "SET_COOKIE_OBSERVATION_FAILED",
        cookie: finalCookie,
        receipt: null,
        detail: "at least one Agora Set-Cookie response could not be observed exactly",
      },
      1,
    );
  }
  if (cookieVerdict.failureCode === "COOKIE_POLICY_CHANGED_DURING_FLOW") {
    throw new RunnerExit(
      {
        ...candidateRecord,
        status: "fail",
        code: "COOKIE_POLICY_CHANGED_DURING_FLOW",
        cookie: finalCookie,
        receipt: null,
        detail: "the post-close Agora session-cookie issuance history was not uniformly safe",
      },
      1,
    );
  }
  return { ...candidateRecord, cookie: finalCookie };
}

export interface RunnerTerminalOutcome {
  readonly record: Omit<Record_, "duration_ms">;
  readonly exitStatus: number;
}

/** Exactly one production path may publish the terminal record. */
function publishTerminal(terminal: RunnerTerminalOutcome): never {
  if (!terminalPublished) {
    terminalPublished = true;
    emit(terminal.record);
  }
  process.exit(terminal.exitStatus);
}

/**
 * Apply the lifecycle verdict to any product outcome.
 *
 * This is deliberately pure and exported so the blocked+teardown polarity is
 * executable in the unit suite. The previous top-level catch handled
 * `RunnerExit` before consulting `teardownFailed`, so a blocked or failed
 * product path masked a browser-close failure while the pass path did not.
 */
export function resolveTerminalOutcome(
  outcome: RunnerTerminalOutcome,
  teardownFailureCount: number,
  didDeadlineExpire = false,
): RunnerTerminalOutcome {
  if (didDeadlineExpire) {
    return {
      exitStatus: 1,
      record: {
        ...outcome.record,
        status: "fail",
        code: "RUNNER_DEADLINE_EXCEEDED",
        detail: `the ${TOTAL_BUDGET_MS}ms runner deadline fired and superseded the ${outcome.record.status} ${outcome.record.code} outcome`,
      },
    };
  }
  if (teardownFailureCount === 0) return outcome;
  const timedOut = teardownFailureCount === -1;
  return {
    exitStatus: 1,
    record: {
      ...outcome.record,
      status: "fail",
      code: timedOut ? "RUNNER_TEARDOWN_TIMED_OUT" : "RUNNER_TEARDOWN_FAILED",
      detail: timedOut
        ? `teardown exceeded its ${CLOSE_GRACE_MS}ms bound and superseded the ${outcome.record.status} ${outcome.record.code} outcome; the browser may still be running`
        : `${teardownFailureCount} teardown step(s) failed and superseded the ${outcome.record.status} ${outcome.record.code} outcome; the browser may still be running`,
    },
  };
}

function unexpectedOutcome(error: unknown): RunnerTerminalOutcome {
  return {
    exitStatus: 1,
    record: {
      tool: "playwright",
      package: "e2e",
      suite: SUITE,
      status: "fail",
      code: "RUNNER_UNEXPECTED_FAULT",
      apex_host: null,
      agent_host: null,
      cookie: null,
      cookie_omission_probe: null,
      cookie_present_probe: null,
      receipt: null,
      edge_request_id: null,
      // The message is withheld: it can quote page content.
      detail: `the runner failed with ${(error as Error)?.constructor?.name ?? "Error"}`,
    },
  };
}

async function terminalSelectorSelfTest(): Promise<never> {
  const blockedOutcome: RunnerTerminalOutcome = {
    exitStatus: BLOCKED_EXIT,
    record: {
      tool: "playwright",
      package: "e2e",
      suite: SUITE,
      status: "blocked",
      code: "PLANTED_BLOCKED",
      apex_host: "preview.example.test",
      agent_host: null,
      cookie: null,
      cookie_omission_probe: null,
      cookie_present_probe: null,
      receipt: null,
      edge_request_id: null,
      detail: "plant",
    },
  };
  const teardown = resolveTerminalOutcome(blockedOutcome, 1);
  const clean = resolveTerminalOutcome(blockedOutcome, 0);
  const teardownPassed =
    teardown.exitStatus === 1 &&
    teardown.record.status === "fail" &&
    teardown.record.code === "RUNNER_TEARDOWN_FAILED" &&
    teardown.record.detail.includes("blocked PLANTED_BLOCKED") &&
    clean === blockedOutcome;
  writeStdoutLine(
    JSON.stringify({
      suite: SUITE,
      assertion: "blocked-runner-teardown-failure-overrides",
      status: teardownPassed ? "pass" : "fail",
      self_test: true,
    }),
  );

  // Deterministic completion/deadline race. The deadline callback latches its
  // verdict synchronously, then joins the same gated teardown promise as the
  // normal path. Replacing `oneShotAsync` with two owners or selecting the pass
  // after the deadline latch makes this record fail.
  let releaseTeardown!: () => void;
  const teardownGate = new Promise<void>((resolve) => {
    releaseTeardown = resolve;
  });
  let teardownOwnerCalls = 0;
  deadlineExceeded = false;
  let latchObservedBeforeTeardown = false;
  const observingTeardown = oneShotAsync(async () => {
    teardownOwnerCalls += 1;
    latchObservedBeforeTeardown = deadlineExceeded;
    await teardownGate;
  });
  const deadlineSettlement = latchDeadlineAndTeardown(observingTeardown);
  const normalSettlement = observingTeardown();
  releaseTeardown();
  await Promise.all([deadlineSettlement, normalSettlement]);
  const passOutcome: RunnerTerminalOutcome = {
    exitStatus: 0,
    record: { ...blockedOutcome.record, status: "pass", code: "OK" },
  };
  const deadline = resolveTerminalOutcome(passOutcome, 0, deadlineExceeded);
  const deadlinePassed =
    teardownOwnerCalls === 1 &&
    latchObservedBeforeTeardown &&
    deadline.exitStatus === 1 &&
    deadline.record.status === "fail" &&
    deadline.record.code === "RUNNER_DEADLINE_EXCEEDED";
  writeStdoutLine(
    JSON.stringify({
      suite: SUITE,
      assertion: "runner-deadline-race-overrides-pass",
      status: deadlinePassed ? "pass" : "fail",
      self_test: true,
    }),
  );
  process.exit(teardownPassed && deadlinePassed ? 0 : 1);
}

async function runEntrypoint(): Promise<never> {
  // Nothing is emitted until `main`'s `finally` has completed. A RunnerExit is
  // data here, not a terminal side effect, so teardown failure can supersede it.
  let outcome: RunnerTerminalOutcome;
  try {
    outcome = { record: await main(), exitStatus: 0 };
  } catch (error) {
    outcome =
      error instanceof RunnerExit
        ? { record: error.record, exitStatus: error.status }
        : unexpectedOutcome(error);
  }
  const terminal = resolveTerminalOutcome(outcome, teardownFailed, deadlineExceeded);
  publishTerminal(terminal);
}

// Importing this module for the pure planted test must never start a browser or
// consume the test runner's stdin. Direct `bun <file>` execution still does.
if (import.meta.main) {
  if (process.argv[2] === "--validate-record") browserRecordValidatorMode();
  if (process.argv[2] === "--validate-http-response") httpResponseValidatorMode();
  if (process.argv[2] === "--validate-evidence") evidenceValidatorMode();
  if (process.argv[2] === "--self-test-terminal-selector") await terminalSelectorSelfTest();
  await runEntrypoint();
}
