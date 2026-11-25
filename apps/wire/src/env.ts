import type { Ai, D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { HeraldNamespace } from "./herald/outbox";
import type { KraterOutboxNamespace } from "./krater/outbox-do";

/**
 * Typed Worker bindings for `apps/wire` (Stoa / Propylon / Symposiarch / Herald).
 *
 * The *names* are not this package's to choose. `infra/wrangler.toml` and
 * `infra/environments.toml` pin them, and `infra/validate-scaffold.mjs` /
 * `infra/validate-environments.mjs` assert them, so the topology stays the
 * single place a binding name is decided. These declarations follow it.
 */
export interface Env {
  /** Krater's system of record (Fable §10.1). This Worker is its only writer. */
  DB: D1Database;
  /** Krater's private content-addressed body store (Fable §10.4), bound as ARTIFACTS. */
  ARTIFACTS: R2Bucket;
  /**
   * Direct-R2 public artifact delivery (Fable §10.4), bound as
   * PUBLIC_ARTIFACTS. The Worker checks only that this handle is structurally
   * present; public `/sha256/<hex>` delivery remains a direct R2 path, not a
   * Worker blob route.
   */
  PUBLIC_ARTIFACTS: R2Bucket;
  /** Durable retry owner for Krater's transactional outbox. */
  KRATER_OUTBOX: KraterOutboxNamespace;
  /**
   * Herald's hibernatable Durable Object room namespace (Fable §11).
   * Exported by `apps/wire/src/index.ts` as `HeraldRoom` and bound in
   * `infra/wrangler.toml` and all environment deploy configs; kept optional at
   * the `/health` runtime boundary so room upgrades fail closed cleanly if an
   * older harness omits the binding.
   */
  HERALD_ROOMS?: HeraldNamespace;
  /**
   * Base64url 256-bit enrollment replay binding (wrangler secret). Absent
   * disables enrollment with a typed 503 rather than a fallback.
   */
  ENROLLMENT_REPLAY_KEY?: string;
  /**
   * JSON array of service-envelope verification key records
   * (`[{kid, publicKeyHex, notBefore, notAfter?}]`; public, non-secret).
   * Absent disables sponsor routes only.
   */
  SERVICE_ENVELOPE_KEYS?: string;
  /**
   * Checkpoint signing key (wrangler secret): JSON `{"kid": "...", "seedHex":
   * "<64 hex chars>"}` holding an Ed25519 private seed. Absent: checkpoints stay
   * unsigned and the public checkpoint face says so.
   */
  CHECKPOINT_SIGNING_KEY?: string;
  /**
   * Public checkpoint verification keys (non-secret): JSON
   * `[{"kid": "...", "publicKeyHex": "<64 hex chars>"}]`, including retired keys
   * so older signatures stay verifiable.
   */
  CHECKPOINT_VERIFY_KEYS?: string;
  /** Independent SHA-256 pin for a pre-provisioned private backup-destination
   * marker. The Worker never creates that marker. Absent: SQL backups disabled. */
  DATABASE_BACKUP_DESTINATION_SHA256?: string;
  /**
   * Comma-separated opaque Google-subject-derived ids permitted to perform the
   * operator Fellow-cap command. Absent, blank, duplicated, or malformed
   * configuration fails closed for that route; it never promotes a sponsor by
   * default.
   */
  OPERATOR_PRINCIPAL_IDS?: string;
  /**
   * The trusted Stoa origin this deployment issues enrollment URLs for
   * (production, staging, or an explicit loopback). Non-secret, and
   * deliberately a binding rather than anything derived from a request:
   * `Host` and `X-Forwarded-Host` are caller-supplied, and an enrollment URL
   * built from one would be a credential redirector. Absent or untrusted
   * disables enrollment with a typed 503 rather than falling back.
   */
  STOA_ORIGIN?: string;
  /** Exact application Git SHA, supplied by the sanctioned deployment pipeline. */
  ASIMPOSIUM_SOURCE_REVISION?: string;
  /** SHA-256 of a retained, canonical mock-free readiness receipt in private ARTIFACTS. */
  ASIMPOSIUM_READINESS_RECEIPT_SHA256?: string;
  /**
   * The Agora origin the device flow's verification URL names. Validated at
   * stack build; absent or untrusted disables enrollment with a typed 503.
   */
  AGORA_ORIGIN?: string;
  /**
   * Workers AI binding for promotion-time policy screening and the S-4 staging
   * corpus surface (asimposiumorg-xeg). Optional at the type/topology level so
   * local development can start without a provider account; promotion fails
   * closed to a private hold, and `POST /internal/screen` returns a typed 503,
   * wherever it is absent.
   */
  AI?: Ai;
  /**
   * Bearer token gating `POST /internal/screen` (wrangler secret, staging
   * only). Absent or shorter than the runner's own minimum disables the
   * screening surface with a typed 503; a wrong token is a flat 401 that
   * teaches nothing about the expected value.
   */
  S4_SCREENING_BEARER?: string;
  /**
   * Optional sponsor-level promotion rate limit per hour across all Fellows and problems.
   * Defaults to 60 per hour when unset. An explicit zero pauses quota-governed
   * public writes while keeping the workshop available (Fable §7.10 / Rule A5).
   */
  SPONSOR_PROMOTION_RATE_LIMIT?: string | number;
  /**
   * OPS.7 (asimposiumorg-d5x) optional Resend REST API key (wrangler secret).
   * Absent disables outbound transactional email cleanly while keeping Agora
   * Console canonical and outbox rows visibly queued.
   */
  RESEND_API_KEY?: string;
  /** OPS.7 verified sender address (e.g. `ASImposium <notices@asimposium.org>`). */
  EMAIL_FROM_ADDRESS?: string;
  /** OPS.7 HMAC-SHA256 secret signing host-only Agora action & unsubscribe links. */
  EMAIL_ACTION_LINK_SECRET?: string;
  /** OPS.7 monthly transactional email volume cap (defaults to 3000). */
  EMAIL_MONTHLY_CAP?: string | number;
}

export const REQUIRED_BINDINGS = ["DB", "ARTIFACTS", "PUBLIC_ARTIFACTS", "KRATER_OUTBOX"] as const;

/** Exact binding roster declared in `infra/wrangler.toml` (all required bindings plus `HERALD_ROOMS`). */
export const CONFIGURED_BASE_BINDINGS = [...REQUIRED_BINDINGS, "HERALD_ROOMS"] as const;

export type RequiredBinding = (typeof REQUIRED_BINDINGS)[number];

export type BindingState = "bound" | "missing";

export interface BindingHealthSnapshot {
  missing: RequiredBinding[];
  bindings: Record<RequiredBinding, BindingState>;
}

const isFunction = (value: unknown): boolean => typeof value === "function";

const readProperty = (container: unknown, key: string): unknown => {
  if (typeof container !== "object" || container === null) {
    return undefined;
  }

  try {
    return (container as Record<string, unknown>)[key];
  } catch {
    // A Proxy or accessor may throw while a binding is inspected. Health is a
    // fail-closed shape probe, so an unreadable property is indistinguishable
    // from a missing one and must never turn the health route into a 500.
    return undefined;
  }
};

/**
 * Structural probes rather than `!= null` checks.
 *
 * A binding that is *present but not actually a handle* — a stale `wrangler`
 * config, a plain `var` shadowing a binding name, a preview environment wired
 * to nothing — must fail closed here, at the edge, instead of throwing later
 * from inside a write transaction where the failure is far more expensive.
 */
const BINDING_PROBES: Record<RequiredBinding, (value: unknown) => boolean> = {
  DB: (value) =>
    isFunction(readProperty(value, "prepare")) && isFunction(readProperty(value, "batch")),
  ARTIFACTS: (value) =>
    isFunction(readProperty(value, "get")) && isFunction(readProperty(value, "put")),
  PUBLIC_ARTIFACTS: (value) =>
    isFunction(readProperty(value, "get")) && isFunction(readProperty(value, "put")),
  KRATER_OUTBOX: (value) =>
    isFunction(readProperty(value, "idFromName")) && isFunction(readProperty(value, "get")),
};

/** True when `value` looks like a live handle for the named binding. */
export function isBindingHealthy(name: RequiredBinding, value: unknown): boolean {
  return BINDING_PROBES[name](value);
}

/**
 * One coherent read of every required binding for a single health decision.
 *
 * Environment objects are normally inert Worker binding bags, but tests,
 * preview adapters, and malformed configuration can expose stateful Proxies.
 * Reading the environment twice could otherwise produce a contradictory
 * `missing` list and state map, or even a 200 carrying a missing state.
 */
export function bindingHealthSnapshot(env: unknown): BindingHealthSnapshot {
  const missing: RequiredBinding[] = [];
  const bindings = {} as Record<RequiredBinding, BindingState>;

  for (const name of REQUIRED_BINDINGS) {
    const state = isBindingHealthy(name, readProperty(env, name)) ? "bound" : "missing";
    bindings[name] = state;
    if (state === "missing") {
      missing.push(name);
    }
  }

  return { missing, bindings };
}

/** The required bindings that are absent or the wrong shape, in declaration order. */
export function missingBindings(env: unknown): RequiredBinding[] {
  return bindingHealthSnapshot(env).missing;
}

/**
 * A presence map safe to serialise onto a response: binding *names* and a
 * two-state verdict, never binding values, ids, or secrets (Fable §14.3's
 * never-log list applies to faces as well as logs).
 */
export function bindingStates(env: unknown): Record<RequiredBinding, BindingState> {
  return bindingHealthSnapshot(env).bindings;
}
