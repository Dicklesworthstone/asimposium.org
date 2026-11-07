import "server-only";

import {
  canonicalReadinessReceipt,
  PRODUCTION_STOA_ORIGIN,
  ProblemsIndexResponseSchema,
  ReadinessRevisionSchema,
  type ReadinessStatus,
  ReadinessStatusSchema,
  type ReadinessUnavailableReason,
  readinessEnvironmentForOrigin,
  readinessReceiptProblem,
  STAGING_STOA_ORIGIN,
  unavailableReadiness,
} from "@asimposium/contracts";

import { enrollmentRecoveryConfigurationIsValid } from "./enrollment-recovery";
import { sha256Hex } from "./service-envelope";
import { LAUNCH_STAGE, PLANE } from "./site";
import { configuredStoaOriginValue } from "./stoa";

/** A status read never needs an unbounded response body. */
export const PLANE_STATUS_MAX_JSON_BYTES = 128 * 1024;
/** Immutable public canaries are deliberately tiny. */
export const ARTIFACT_CANARY_MAX_BYTES = 64 * 1024;
export const PLANE_STATUS_TIMEOUT_MS = 3_000;
/** Status is shared briefly to keep public and console reads cheap by construction. */
export const PLANE_STATUS_CACHE_TTL_MS = 15_000;
/** A CDN can cache a response that was produced from an almost-expired snapshot. */
export const PLANE_STATUS_PUBLIC_RESPONSE_CACHE_TTL_MS = 15_000;
export const PLANE_STATUS_PUBLIC_MAX_AGE_SECONDS =
  (PLANE_STATUS_CACHE_TTL_MS + PLANE_STATUS_PUBLIC_RESPONSE_CACHE_TTL_MS) / 1000;

const SERVICE_ENVELOPE_SEED = /^[0-9a-f]{64}$/;
const SERVICE_ENVELOPE_KID = /^[A-Za-z0-9._-]{1,64}$/;
const publicJsonDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * The exact public object an operator uploads before marking a deployment
 * provisioned. Keeping both bytes and digest here makes a later deployment
 * reproducible without inventing an ad-hoc remote contract.
 */
export const ARTIFACT_CANARY_BODY = "ASImposium artifact canary v1\n";
export const ARTIFACT_CANARY_SHA256 =
  "f4d09526dbdd48a1ec56879d3f1efd1bb7ca09382d2c55fb18608d013638008e";
const ARTIFACT_CANARY_VERSION = "v1";

/**
 * This mapping is intentionally closed. A public artifact URL is never taken
 * from a Worker response, Host header, or an arbitrary environment string.
 * Local R2 has no public custom domain in infra/environments.toml, so local
 * status has no public artifact canary to fetch.
 */
const PRODUCTION_ARTIFACT_ORIGIN = "https://artifacts.asimposium.org";
const STAGING_ARTIFACT_ORIGIN = "https://artifacts-staging.asimposium.org";

export type ConfigurationState = "configured" | "missing" | "invalid";
export type ReachabilityState = "not_probed" | "reachable" | "http_error" | "unreachable";
export type ArtifactCanaryState =
  | "not_provisioned"
  | "invalid_configuration"
  | "not_configured"
  | "verified"
  | "wrong_status"
  | "wrong_bytes"
  | "oversize"
  | "unreachable";
export type PublicLedgerIndexState =
  | "not_probed"
  | "reachable_empty"
  | "reachable_with_entries"
  | "http_error"
  | "invalid_response"
  | "oversize"
  | "unreachable";

export interface PlaneStatus {
  readonly plane: typeof PLANE;
  readonly stage: typeof LAUNCH_STAGE;
  readonly freshness: {
    /** Maximum snapshot age on the authenticated console's server-render path. */
    readonly console_snapshot_max_age_seconds: number;
    /** Includes a public CDN response cache layered after the server snapshot. */
    readonly public_response_max_age_seconds: number;
  };
  readonly agora: { readonly reachability: "serving" };
  readonly stoa: {
    readonly origin_configuration: ConfigurationState;
    readonly internal_health_reachability: ReachabilityState;
    readonly capabilities_reachability: ReachabilityState;
    readonly sponsor_dispatch_configuration: ConfigurationState;
    readonly enrollment_recovery_hmac_configuration: ConfigurationState;
    /** Configuration only; it is not proof that a Worker write is accepted. */
    readonly sponsor_enrollment_write_configuration: "configured" | "not_configured";
  };
  readonly artifacts: {
    readonly origin_mapping: "configured" | "not_configured";
    readonly canary: ArtifactCanaryState;
  };
  readonly ledger: {
    readonly public_index: PublicLedgerIndexState;
    readonly public_index_entries: number | null;
    /** A valid public index is not evidence that scientific writes are live. */
    readonly research_writes: "not_ready" | "ready";
    readonly product_readiness: "not_ready" | "ready";
    readonly readiness: ReadinessStatus;
  };
}

export interface PlaneStatusEnvironment {
  readonly STOA_ORIGIN?: string;
  readonly SERVICE_ENVELOPE_PRIVATE_KEY_HEX?: string;
  readonly SERVICE_ENVELOPE_KID?: string;
  readonly ENROLLMENT_RECOVERY_HMAC_KEY_HEX?: string;
  /** Non-secret operator marker after the source-defined canary is uploaded. */
  readonly ARTIFACT_CANARY_VERSION?: string;
  /** Explicit exact application revision, never inferred from endpoint reachability. */
  readonly ASIMPOSIUM_SOURCE_REVISION?: string;
  /** When the hosting provider supplies a build identity, the explicit revision must match. */
  readonly VERCEL_GIT_COMMIT_SHA?: string;
}

export type PlaneStatusFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ResolvePlaneStatusOptions {
  readonly environment?: PlaneStatusEnvironment;
  readonly fetchImpl?: PlaneStatusFetch;
  readonly now?: () => number;
}

export interface PlaneStatusCache {
  get(): Promise<PlaneStatus>;
}

export interface PlaneStatusCacheOptions {
  readonly refresh: () => Promise<PlaneStatus>;
  readonly now?: () => number;
  readonly ttlMs?: number;
  /** Wall clock is separate from the monotonic snapshot-cache clock. */
  readonly wallNow?: () => number;
}

export interface ArtifactCanaryProbeOptions {
  readonly artifactOrigin: string | undefined;
  readonly provisioning: ConfigurationState;
  readonly fetchImpl: PlaneStatusFetch;
}

export interface ConsolePlaneStatusRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly healthy: boolean;
}

function configurationState(value: string | undefined, valid: boolean): ConfigurationState {
  if (value === undefined) return "missing";
  return valid ? "configured" : "invalid";
}

function serviceEnvelopeConfiguration(environment: PlaneStatusEnvironment): ConfigurationState {
  const key = environment.SERVICE_ENVELOPE_PRIVATE_KEY_HEX;
  const kid = environment.SERVICE_ENVELOPE_KID;
  if (key === undefined || kid === undefined) return "missing";
  return SERVICE_ENVELOPE_SEED.test(key) && SERVICE_ENVELOPE_KID.test(kid)
    ? "configured"
    : "invalid";
}

function recoveryHmacConfiguration(environment: PlaneStatusEnvironment): ConfigurationState {
  const root = environment.ENROLLMENT_RECOVERY_HMAC_KEY_HEX;
  if (root === undefined) return "missing";
  return enrollmentRecoveryConfigurationIsValid(root, environment.SERVICE_ENVELOPE_PRIVATE_KEY_HEX)
    ? "configured"
    : "invalid";
}

function canaryProvisioning(environment: PlaneStatusEnvironment): ConfigurationState {
  return configurationState(
    environment.ARTIFACT_CANARY_VERSION,
    environment.ARTIFACT_CANARY_VERSION === ARTIFACT_CANARY_VERSION,
  );
}

/** Resolve the public-delivery origin from the already trusted Stoa environment. */
export function artifactOriginForStoaOrigin(stoaOrigin: string | undefined): string | undefined {
  switch (stoaOrigin) {
    case PRODUCTION_STOA_ORIGIN:
      return PRODUCTION_ARTIFACT_ORIGIN;
    case STAGING_STOA_ORIGIN:
      return STAGING_ARTIFACT_ORIGIN;
    default:
      return undefined;
  }
}

function isMappedArtifactOrigin(origin: string): boolean {
  return origin === PRODUCTION_ARTIFACT_ORIGIN || origin === STAGING_ARTIFACT_ORIGIN;
}

function statusRequestInit(): RequestInit {
  return {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(PLANE_STATUS_TIMEOUT_MS),
  };
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status result is already determined by the HTTP response.
  }
}

async function probeReachability(
  url: string | undefined,
  fetchImpl: PlaneStatusFetch,
): Promise<ReachabilityState> {
  if (url === undefined) return "not_probed";
  try {
    const response = await fetchImpl(url, statusRequestInit());
    const result: ReachabilityState = response.ok ? "reachable" : "http_error";
    await discard(response);
    return result;
  } catch {
    return "unreachable";
  }
}

async function readBoundedBytes(
  response: Response,
  maximum: number,
): Promise<Uint8Array | undefined> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximum) {
    await discard(response);
    return undefined;
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Verify the exact immutable bytes at one closed, public CAS path. */
export async function probeArtifactCanary(
  options: ArtifactCanaryProbeOptions,
): Promise<ArtifactCanaryState> {
  if (options.provisioning === "missing") return "not_provisioned";
  if (options.provisioning === "invalid") {
    return "invalid_configuration";
  }
  if (options.artifactOrigin === undefined || !isMappedArtifactOrigin(options.artifactOrigin)) {
    return "not_configured";
  }

  const target = new URL(`/sha256/${ARTIFACT_CANARY_SHA256}`, options.artifactOrigin);
  if (
    target.origin !== options.artifactOrigin ||
    target.pathname !== `/sha256/${ARTIFACT_CANARY_SHA256}`
  ) {
    return "not_configured";
  }

  try {
    const response = await options.fetchImpl(target.toString(), statusRequestInit());
    if (response.status !== 200) {
      await discard(response);
      return "wrong_status";
    }
    const bytes = await readBoundedBytes(response, ARTIFACT_CANARY_MAX_BYTES);
    if (bytes === undefined) return "oversize";
    return (await sha256Hex(bytes)) === ARTIFACT_CANARY_SHA256 ? "verified" : "wrong_bytes";
  } catch {
    return "unreachable";
  }
}

async function probePublicLedgerIndex(
  stoaOrigin: string | undefined,
  fetchImpl: PlaneStatusFetch,
): Promise<Pick<PlaneStatus["ledger"], "public_index" | "public_index_entries">> {
  if (stoaOrigin === undefined) {
    return { public_index: "not_probed", public_index_entries: null };
  }
  try {
    const response = await fetchImpl(`${stoaOrigin}/problems.json`, statusRequestInit());
    if (!response.ok) {
      await discard(response);
      return { public_index: "http_error", public_index_entries: null };
    }
    const bytes = await readBoundedBytes(response, PLANE_STATUS_MAX_JSON_BYTES);
    if (bytes === undefined) return { public_index: "oversize", public_index_entries: null };
    let value: unknown;
    try {
      value = JSON.parse(publicJsonDecoder.decode(bytes));
    } catch {
      return { public_index: "invalid_response", public_index_entries: null };
    }
    const parsed = ProblemsIndexResponseSchema.safeParse(value);
    if (!parsed.success) return { public_index: "invalid_response", public_index_entries: null };
    const entries = parsed.data.problems.length;
    return {
      public_index: entries === 0 ? "reachable_empty" : "reachable_with_entries",
      public_index_entries: entries,
    };
  } catch {
    return { public_index: "unreachable", public_index_entries: null };
  }
}

async function probeCapabilities(
  origin: string | undefined,
  environment: PlaneStatusEnvironment,
  fetchImpl: PlaneStatusFetch,
  now: () => number,
): Promise<{ readonly reachability: ReachabilityState; readonly readiness: ReadinessStatus }> {
  const unavailable = (reachability: ReachabilityState, reason: ReadinessUnavailableReason) => ({
    reachability,
    readiness: unavailableReadiness(reason),
  });
  if (origin === undefined) return unavailable("not_probed", "origin_unavailable");
  try {
    const response = await fetchImpl(`${origin}/capabilities`, statusRequestInit());
    if (!response.ok) {
      await discard(response);
      return unavailable("http_error", "capabilities_unavailable");
    }
    const bytes = await readBoundedBytes(response, PLANE_STATUS_MAX_JSON_BYTES);
    if (bytes === undefined) return unavailable("reachable", "receipt_oversize");
    let value: unknown;
    try {
      value = JSON.parse(publicJsonDecoder.decode(bytes));
    } catch {
      return unavailable("reachable", "invalid_evidence");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return unavailable("reachable", "invalid_evidence");
    }
    const capabilities = value as Record<string, unknown>;
    if (typeof capabilities.origin !== "string")
      return unavailable("reachable", "invalid_evidence");
    if (capabilities.origin !== origin) return unavailable("reachable", "origin_mismatch");
    if (readinessEnvironmentForOrigin(origin) === undefined) {
      return unavailable("reachable", "origin_unavailable");
    }
    const revision = ReadinessRevisionSchema.safeParse(environment.ASIMPOSIUM_SOURCE_REVISION);
    if (!revision.success) return unavailable("reachable", "revision_unavailable");
    if (
      environment.VERCEL_GIT_COMMIT_SHA !== undefined &&
      environment.VERCEL_GIT_COMMIT_SHA !== revision.data
    ) {
      return unavailable("reachable", "build_revision_mismatch");
    }
    const parsed = ReadinessStatusSchema.safeParse(capabilities.readiness);
    if (!parsed.success) return unavailable("reachable", "invalid_evidence");
    if (parsed.data.status === "unavailable") {
      return { reachability: "reachable", readiness: parsed.data };
    }
    const receipt = parsed.data.receipt;
    if (
      (await sha256Hex(new TextEncoder().encode(canonicalReadinessReceipt(receipt)))) !==
      parsed.data.receipt_sha256
    ) {
      return unavailable("reachable", "receipt_digest_mismatch");
    }
    const problem = readinessReceiptProblem(receipt, {
      origin,
      revision: revision.data,
      now: now(),
    });
    if (problem !== undefined) return unavailable("reachable", problem);
    return { reachability: "reachable", readiness: parsed.data };
  } catch {
    return unavailable("unreachable", "capabilities_unavailable");
  }
}

/** Recheck expiry at consumption time, including cached snapshots and slow sibling probes. */
export function planeStatusAtTime(status: PlaneStatus, now = Date.now()): PlaneStatus {
  if (
    status.ledger.readiness.status !== "ready" ||
    Date.parse(status.ledger.readiness.receipt.expires_at) > now
  ) {
    return status;
  }
  return {
    ...status,
    ledger: {
      ...status.ledger,
      research_writes: "not_ready",
      product_readiness: "not_ready",
      readiness: unavailableReadiness("expired_evidence"),
    },
  };
}

/** Never allow a downstream public cache to retain ready evidence past its expiry. */
export function planeStatusCacheControl(status: PlaneStatus, now = Date.now()): string {
  const maxAge =
    status.ledger.readiness.status === "ready"
      ? Math.max(
          0,
          Math.min(
            PLANE_STATUS_PUBLIC_RESPONSE_CACHE_TTL_MS / 1000,
            Math.floor((Date.parse(status.ledger.readiness.receipt.expires_at) - now) / 1000),
          ),
        )
      : PLANE_STATUS_PUBLIC_RESPONSE_CACHE_TTL_MS / 1000;
  return `public, max-age=0, s-maxage=${maxAge}, must-revalidate`;
}

/**
 * Gather only environment-bound operational facts. It intentionally does not
 * infer research-write or product readiness from an HTTP 200 or empty index.
 */
export async function resolvePlaneStatus(
  options: ResolvePlaneStatusOptions = {},
): Promise<PlaneStatus> {
  const environment: PlaneStatusEnvironment = options.environment ?? {
    STOA_ORIGIN: process.env.STOA_ORIGIN,
    SERVICE_ENVELOPE_PRIVATE_KEY_HEX: process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX,
    SERVICE_ENVELOPE_KID: process.env.SERVICE_ENVELOPE_KID,
    ENROLLMENT_RECOVERY_HMAC_KEY_HEX: process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX,
    ARTIFACT_CANARY_VERSION: process.env.ARTIFACT_CANARY_VERSION,
    ASIMPOSIUM_SOURCE_REVISION: process.env.ASIMPOSIUM_SOURCE_REVISION,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const rawStoaOrigin = environment.STOA_ORIGIN;
  const stoaOrigin = configuredStoaOriginValue(rawStoaOrigin);
  const stoaOriginConfiguration = configurationState(rawStoaOrigin, stoaOrigin !== undefined);
  const sponsorDispatchConfiguration = serviceEnvelopeConfiguration(environment);
  const enrollmentRecoveryHmacConfiguration = recoveryHmacConfiguration(environment);
  const canaryConfiguration = canaryProvisioning(environment);
  const artifactOrigin = artifactOriginForStoaOrigin(stoaOrigin);
  const sponsorEnrollmentWriteConfiguration =
    stoaOriginConfiguration === "configured" &&
    sponsorDispatchConfiguration === "configured" &&
    enrollmentRecoveryHmacConfiguration === "configured"
      ? "configured"
      : "not_configured";

  const [internalHealth, capabilities, ledger, canary] = await Promise.all([
    probeReachability(
      stoaOrigin === undefined ? undefined : `${stoaOrigin}/internal/health`,
      fetchImpl,
    ),
    probeCapabilities(stoaOrigin, environment, fetchImpl, now),
    probePublicLedgerIndex(stoaOrigin, fetchImpl),
    probeArtifactCanary({
      artifactOrigin,
      provisioning: canaryConfiguration,
      fetchImpl,
    }),
  ]);

  return planeStatusAtTime(
    {
      plane: PLANE,
      stage: LAUNCH_STAGE,
      freshness: {
        console_snapshot_max_age_seconds: PLANE_STATUS_CACHE_TTL_MS / 1000,
        public_response_max_age_seconds: PLANE_STATUS_PUBLIC_MAX_AGE_SECONDS,
      },
      agora: { reachability: "serving" },
      stoa: {
        origin_configuration: stoaOriginConfiguration,
        internal_health_reachability: internalHealth,
        capabilities_reachability: capabilities.reachability,
        sponsor_dispatch_configuration: sponsorDispatchConfiguration,
        enrollment_recovery_hmac_configuration: enrollmentRecoveryHmacConfiguration,
        sponsor_enrollment_write_configuration: sponsorEnrollmentWriteConfiguration,
      },
      artifacts: {
        origin_mapping: artifactOrigin === undefined ? "not_configured" : "configured",
        canary,
      },
      ledger: {
        ...ledger,
        research_writes: capabilities.readiness.status === "ready" ? "ready" : "not_ready",
        product_readiness: capabilities.readiness.status === "ready" ? "ready" : "not_ready",
        readiness: capabilities.readiness,
      },
    },
    now(),
  );
}

/**
 * Shares one bounded refresh in a server instance. Failures never become a
 * permanent cache entry: a rejected refresh clears its flight immediately and
 * an operational-failure snapshot is refreshed after the same short horizon.
 */
export function createPlaneStatusCache(options: PlaneStatusCacheOptions): PlaneStatusCache {
  const ttlMs = options.ttlMs ?? PLANE_STATUS_CACHE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("Plane status cache TTL must be finite and positive");
  }

  const rawNow = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? Date.now;
  let lastNow = rawNow();
  const now = () => {
    const current = rawNow();
    if (current > lastNow) lastNow = current;
    return lastNow;
  };
  let snapshot: { readonly value: PlaneStatus; readonly expiresAt: number } | undefined;
  let inFlight: Promise<PlaneStatus> | undefined;

  return {
    async get(): Promise<PlaneStatus> {
      if (snapshot !== undefined && now() < snapshot.expiresAt) {
        const fresh = planeStatusAtTime(snapshot.value, wallNow());
        if (fresh === snapshot.value) return fresh;
      }
      if (inFlight !== undefined) return inFlight;

      inFlight = options
        .refresh()
        .then((value) => {
          const checkedAt = wallNow();
          const fresh = planeStatusAtTime(value, checkedAt);
          const remaining =
            fresh.ledger.readiness.status === "ready"
              ? Date.parse(fresh.ledger.readiness.receipt.expires_at) - checkedAt
              : ttlMs;
          snapshot = { value: fresh, expiresAt: now() + Math.min(ttlMs, remaining) };
          return fresh;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}

const sharedPlaneStatusCache = createPlaneStatusCache({ refresh: () => resolvePlaneStatus() });

/** The console and public health face share this bounded, server-only snapshot. */
export function resolveCachedPlaneStatus(): Promise<PlaneStatus> {
  return sharedPlaneStatusCache.get();
}

/** Copy is tied to the exact cache horizon rather than pretending every render probes now. */
export function planeStatusFreshnessCopy(): string {
  return `Checked recently: this snapshot is cached for up to ${PLANE_STATUS_CACHE_TTL_MS / 1000} seconds.`;
}

function probeCopy(value: ReachabilityState): string {
  switch (value) {
    case "reachable":
      return "reachable";
    case "not_probed":
      return "not probed";
    case "http_error":
      return "answered with an HTTP error";
    case "unreachable":
      return "unreachable";
  }
}

function configurationCopy(value: ConfigurationState): string {
  return value === "configured" ? "configured" : value === "missing" ? "missing" : "invalid";
}

const readinessUnavailableCopy: Readonly<Record<ReadinessUnavailableReason, string>> = {
  origin_unavailable: "this deployment has no qualifying production or staging Stoa origin",
  revision_unavailable: "the exact application revision is not configured",
  build_revision_mismatch: "the configured application revision differs from the Agora build",
  receipt_unconfigured: "no completed mock-free qualification receipt is configured",
  receipt_configuration_invalid: "the configured qualification receipt digest is invalid",
  receipt_unavailable: "the retained qualification receipt could not be read",
  receipt_oversize: "the qualification response exceeds its bounded size",
  receipt_digest_mismatch: "the qualification receipt does not match its authorized digest",
  invalid_evidence: "the qualification evidence is malformed or incomplete",
  mixed_evidence: "the proofs do not describe one coherent revision and research journey",
  origin_mismatch: "the qualification evidence belongs to a different Stoa origin",
  environment_mismatch: "the qualification evidence belongs to a different environment",
  revision_mismatch: "the qualification evidence belongs to a different application revision",
  future_evidence: "the qualification evidence has an observation time in the future",
  expired_evidence: "the qualification evidence has expired",
  capabilities_unavailable: "Stoa capabilities could not provide qualification evidence",
};

/** Copy is derived from the machine status, so it cannot silently overclaim it. */
export function consolePlaneStatusRows(status: PlaneStatus): readonly ConsolePlaneStatusRow[] {
  const readiness = planeStatusAtTime(status).ledger.readiness;
  const stoaReachability =
    status.stoa.origin_configuration === "missing"
      ? "Not probed: this Agora deployment lacks STOA_ORIGIN. This does not say Stoa is down."
      : status.stoa.origin_configuration === "invalid"
        ? "Not probed: STOA_ORIGIN is invalid, so this deployment will not select an agent host."
        : `Internal-health endpoint reachability is ${probeCopy(status.stoa.internal_health_reachability)}; capabilities endpoint reachability is ${probeCopy(status.stoa.capabilities_reachability)}.`;
  const recoveryWiring =
    status.stoa.enrollment_recovery_hmac_configuration === "missing"
      ? "ENROLLMENT_RECOVERY_HMAC_KEY_HEX is missing; recoverable sponsor writes are unavailable."
      : `Sponsor dispatch is ${configurationCopy(status.stoa.sponsor_dispatch_configuration)} and ENROLLMENT_RECOVERY_HMAC_KEY_HEX is ${configurationCopy(status.stoa.enrollment_recovery_hmac_configuration)}; sponsor enrollment write configuration is ${status.stoa.sponsor_enrollment_write_configuration}.`;
  const artifactCanary =
    status.artifacts.canary === "not_provisioned"
      ? "Not provisioned: no immutable public canary is configured for this environment."
      : status.artifacts.canary === "verified"
        ? "Verified: the configured immutable public canary returned the expected bytes."
        : `Not verified: immutable public canary is ${status.artifacts.canary.replaceAll("_", " ")}.`;
  const publicIndex =
    status.ledger.public_index === "reachable_empty"
      ? "Reachable but empty: this proves only the public index contract."
      : status.ledger.public_index === "reachable_with_entries"
        ? `Reachable with ${status.ledger.public_index_entries} public index entries; this is still read-surface evidence only.`
        : `Not established: public index is ${status.ledger.public_index.replaceAll("_", " ")}.`;

  return [
    {
      key: "agora",
      label: "Agora, the human plane",
      value: "Serving this status response.",
      healthy: true,
    },
    {
      key: "stoa-reachability",
      label: "Stoa endpoint reachability",
      value: stoaReachability,
      healthy:
        status.stoa.origin_configuration === "configured" &&
        status.stoa.internal_health_reachability === "reachable" &&
        status.stoa.capabilities_reachability === "reachable",
    },
    {
      key: "agora-stoa-wiring",
      label: "Agora-to-Stoa sponsor wiring",
      value: recoveryWiring,
      healthy: false,
    },
    {
      key: "artifact-canary",
      label: "Artifacts immutable canary",
      value: artifactCanary,
      healthy: status.artifacts.canary === "verified",
    },
    {
      key: "public-ledger-index",
      label: "Public ledger index",
      value: publicIndex,
      healthy: status.ledger.public_index === "reachable_with_entries",
    },
    {
      key: "ledger-product-readiness",
      label: "Research-write and product readiness",
      value:
        readiness.status === "ready"
          ? `Verified for revision ${readiness.receipt.revision.slice(0, 12)}: the complete mock-free research journey, cursor movement, and visible budgets. Evidence expires ${readiness.receipt.expires_at}.`
          : `Unavailable: ${readinessUnavailableCopy[readiness.reason]}.`,
      healthy: readiness.status === "ready",
    },
  ];
}
