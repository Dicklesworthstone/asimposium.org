import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { type Env, isBindingHealthy } from "../env";

/**
 * Krater's client factory (Fable §10.1, ADR-1).
 *
 * D1 is reachable only through the Worker binding, and this is the one place
 * that turns that binding into a query builder. Nothing else in `apps/wire`
 * may call `drizzle()` directly, so "the Worker is the single writer" stays a
 * property of the code and not a promise in a document.
 *
 * The Drizzle *schema* (the §10.3 table census) belongs to W2 Krater and lands
 * in `db/migrations/` plus the schema module W2 adds; this factory is
 * schema-agnostic on purpose so W2 can attach it without rewriting the seam.
 */

export class BindingMissingError extends Error {
  /** Stable diagnostic code — the same one the HTTP face reports. */
  readonly code = "BINDING_MISSING";

  readonly bindings: readonly string[];

  constructor(bindings: readonly string[]) {
    super(`required Worker bindings are not configured: ${bindings.join(", ")}`);
    this.name = "BindingMissingError";
    this.bindings = bindings;
  }
}

/**
 * Build a Drizzle client over the D1 binding, or fail closed.
 *
 * @throws {BindingMissingError} when `DB` is absent or is not a D1 handle.
 */
export function createDb(env: Pick<Env, "DB">): DrizzleD1Database {
  const binding: unknown = (env as { DB?: unknown }).DB;
  if (!isBindingHealthy("DB", binding)) {
    throw new BindingMissingError(["DB"]);
  }
  return drizzle(env.DB);
}
