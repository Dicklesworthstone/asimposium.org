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
    const snapshot = Object.freeze([...bindings]);
    super(`required Worker bindings are not configured: ${snapshot.join(", ")}`);
    this.name = "BindingMissingError";
    this.bindings = snapshot;
  }
}

/**
 * Opaque dependency failure at Krater's execution boundary.
 *
 * Drizzle 0.45.2's `DrizzleQueryError` reflects the SQL string and bound
 * parameters through its message and public fields. Neither that wrapper nor
 * its dependency cause may cross this boundary: both can contain credentials,
 * private bodies, or other values on Fable's never-log list.
 */
export class D1ExecutionError extends Error {
  readonly code = "D1_EXECUTION_FAILED";

  constructor() {
    super("D1 execution failed");
    this.name = "D1ExecutionError";
    for (const key of Reflect.ownKeys(this)) {
      if (key !== "name" && key !== "message" && key !== "code") {
        Reflect.deleteProperty(this, key);
      }
    }
    Object.freeze(this);
  }
}

type D1Query = Parameters<DrizzleD1Database["run"]>[0];

/**
 * The only public execution capabilities over the Drizzle client.
 *
 * This deliberately exposes fixed terminal operations instead of a callback.
 * A callback can retain or return the raw client, a lazy builder, or a closure
 * that executes after the redaction boundary has ended. Atomic batch support
 * must use a separately reviewed repository-owned statement plan; Drizzle's
 * callback transaction and builder surfaces are intentionally absent here.
 */
export interface D1ExecutionBoundary {
  readonly run: (query: D1Query) => Promise<Awaited<ReturnType<DrizzleD1Database["run"]>>>;
  readonly all: <T = unknown>(query: D1Query) => Promise<T[]>;
  readonly get: <T = unknown>(query: D1Query) => Promise<T | undefined>;
  readonly values: <T extends unknown[] = unknown[]>(query: D1Query) => Promise<T[]>;
}

async function executeOrRedact<T>(operation: () => PromiseLike<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    // Always allocate a new opaque error. Dependency code can throw a forged
    // D1ExecutionError instance carrying query/params/cause properties.
    throw new D1ExecutionError();
  }
}

/**
 * Build an opaque execution boundary over the D1 binding, or fail closed.
 *
 * The binding check is deliberately shape-only. Mounted local integration
 * proves local behavior; provider/deployed authority and liveness require
 * separate provider evidence.
 *
 * @throws {BindingMissingError} when `DB` is absent or is not D1-shaped.
 */
export function createDb(env: Pick<Env, "DB">): D1ExecutionBoundary {
  let binding: unknown;
  try {
    binding = (env as { DB?: unknown }).DB;
  } catch {
    throw new BindingMissingError(["DB"]);
  }
  if (!isBindingHealthy("DB", binding)) {
    throw new BindingMissingError(["DB"]);
  }
  const db = drizzle(binding as Env["DB"]);
  const run: D1ExecutionBoundary["run"] = (query: D1Query) => executeOrRedact(() => db.run(query));
  const all: D1ExecutionBoundary["all"] = <T = unknown>(query: D1Query) =>
    executeOrRedact(() => db.all<T>(query));
  const get: D1ExecutionBoundary["get"] = <T = unknown>(query: D1Query) =>
    executeOrRedact(() => db.get<T>(query));
  const values: D1ExecutionBoundary["values"] = <T extends unknown[] = unknown[]>(query: D1Query) =>
    executeOrRedact(() => db.values<T>(query));

  return Object.freeze({
    run,
    all,
    get,
    values,
  });
}
