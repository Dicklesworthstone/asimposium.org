import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

/**
 * Typed Worker bindings for `apps/wire` (Stoa / Propylon / Symposiarch / Herald).
 *
 * Only bindings this scaffold actually needs are declared. Herald's Durable
 * Object namespace (Fable §11) is deliberately absent: a DO binding without an
 * exported DO class is a deploy-time failure, and the class belongs to W7.
 *
 * The *names* are not this package's to choose. `infra/wrangler.toml` pins them
 * and `infra/validate-scaffold.mjs` asserts them, so that one file stays the
 * single place a binding name is decided. These declarations follow it.
 */
export interface Env {
  /** Krater's system of record (Fable §10.1). This Worker is its only writer. */
  DB: D1Database;
  /** Krater's content-addressed body store (Fable §10.4), bound as ARTIFACTS. */
  ARTIFACTS: R2Bucket;
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
}

export const REQUIRED_BINDINGS = ["DB", "ARTIFACTS"] as const;

export type RequiredBinding = (typeof REQUIRED_BINDINGS)[number];

export type BindingState = "bound" | "missing";

const isFunction = (value: unknown): boolean => typeof value === "function";

const readProperty = (container: unknown, key: string): unknown =>
  typeof container === "object" && container !== null
    ? (container as Record<string, unknown>)[key]
    : undefined;

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
};

/** True when `value` looks like a live handle for the named binding. */
export function isBindingHealthy(name: RequiredBinding, value: unknown): boolean {
  return BINDING_PROBES[name](value);
}

/** The required bindings that are absent or the wrong shape, in declaration order. */
export function missingBindings(env: unknown): RequiredBinding[] {
  return REQUIRED_BINDINGS.filter((name) => !isBindingHealthy(name, readProperty(env, name)));
}

/**
 * A presence map safe to serialise onto a response: binding *names* and a
 * two-state verdict, never binding values, ids, or secrets (Fable §14.3's
 * never-log list applies to faces as well as logs).
 */
export function bindingStates(env: unknown): Record<RequiredBinding, BindingState> {
  const missing = new Set<RequiredBinding>(missingBindings(env));
  const states = {} as Record<RequiredBinding, BindingState>;
  for (const name of REQUIRED_BINDINGS) {
    states[name] = missing.has(name) ? "missing" : "bound";
  }
  return states;
}
