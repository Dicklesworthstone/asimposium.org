import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { Env } from "../../src/env";
import worker from "../../src/index";

/**
 * Binding *shapes*, not D1/R2 behaviour.
 *
 * READ THIS BEFORE CITING ANY TEST THAT USES THIS FILE.
 *
 * These stubs exist for exactly one purpose: to exercise the presence/shape
 * probes in `src/env.ts` and the fail-closed paths that hang off them. Every
 * method throws when called, so no test can quietly come to depend on stub
 * behaviour. Nothing here executes SQL, stores bytes, or opens a transaction,
 * and no result obtained through this file may be cited as evidence that D1,
 * R2, or a Durable Object works.
 *
 * That proof requires real bindings and is deliberately withheld until the
 * integration suite has them (`bun run test:integration` names the blocker).
 * AGENTS.md is explicit: do not mock D1 or R2 in integration tests.
 */

const refuse = (method: string) => (): never => {
  throw new Error(`binding shim: ${method}() is not implemented and must not be called`);
};

/** An object with D1's method shape. It is not a database. */
export function d1Shaped(): D1Database {
  return {
    prepare: refuse("prepare"),
    batch: refuse("batch"),
    dump: refuse("dump"),
    exec: refuse("exec"),
    withSession: refuse("withSession"),
  } as unknown as D1Database;
}

/** An object with R2's method shape. It is not a bucket. */
export function r2Shaped(): R2Bucket {
  return {
    get: refuse("get"),
    put: refuse("put"),
    head: refuse("head"),
    delete: refuse("delete"),
    list: refuse("list"),
    createMultipartUpload: refuse("createMultipartUpload"),
    resumeMultipartUpload: refuse("resumeMultipartUpload"),
  } as unknown as R2Bucket;
}

/** A fully-bound `Env` whose handles are shape-only. */
export function boundEnv(overrides: Partial<Record<keyof Env, unknown>> = {}): Env {
  return { DB: d1Shaped(), ARTIFACTS: r2Shaped(), ...overrides } as Env;
}

/** An `ExecutionContext` stand-in; the scaffold schedules no deferred work. */
export function executionContext(): {
  waitUntil: (p: Promise<unknown>) => void;
  passThroughOnException: () => void;
} {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  };
}

export interface WorkerCall {
  status: number;
  contentType: string;
  bodyText: string;
  body: unknown;
  headers: Headers;
}

/**
 * Invoke the real Worker default export — the same object `wrangler` runs —
 * rather than reaching into a route function.
 */
export async function callWorker(path: string, env: unknown = boundEnv()): Promise<WorkerCall> {
  const request = new Request(`https://a.asimposium.org${path}`);
  const response = await worker.fetch(
    request,
    env as Env,
    executionContext() as unknown as Parameters<typeof worker.fetch>[2],
  );
  const bodyText = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = undefined;
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    bodyText,
    body,
    headers: response.headers,
  };
}
