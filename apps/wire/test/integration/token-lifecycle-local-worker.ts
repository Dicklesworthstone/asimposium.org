import type { ExecutionContext } from "@cloudflare/workers-types";

import { createApp } from "../../src/app.ts";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import type { CredentialRevokeAttempt, EnrollmentStore } from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { KraterOutboxDrainer } from "../../src/krater/outbox-do.ts";

interface LocalHarnessEnv extends Env {
  readonly TOKEN_LIFECYCLE_LOCAL_HARNESS?: string;
  readonly TOKEN_LIFECYCLE_BARRIER_CAP?: string;
}

interface BarrierWindow {
  readonly expected: number;
  arrivals: number;
  released: boolean;
}

type SessionReplayScope = "session_open" | "workshop_push" | "promote" | "session_close";

interface SessionReplayBarrierWindow extends BarrierWindow {
  readonly scope: SessionReplayScope;
}

const CONTROL_PREFIX = "/__token-lifecycle/";
const LOCAL_HARNESS_ENABLED = "enabled";
const CAPABILITY_PATTERN = /^[a-f0-9]{64}$/;
const BARRIER_WAIT_LIMIT_MS = 5_000;
const SESSION_REPLAY_SCOPES: readonly SessionReplayScope[] = [
  "session_open",
  "workshop_push",
  "promote",
  "session_close",
];

/**
 * Local-only witnesses for two real HTTP requests reaching the store after
 * service idempotency preparation: one before D1's transactional revoke and
 * one immediately before a session replay/side-effect batch. This entrypoint
 * is mounted solely by wrangler.token-lifecycle.toml; production index.ts
 * neither imports it nor declares its enabling binding.
 */
class RevokeBarrier {
  #window: BarrierWindow | undefined;

  arm(expected: number): { readonly expected: number; readonly arrivals: number } {
    if (!Number.isSafeInteger(expected) || expected !== 2) throw new Error("invalid barrier size");
    if (this.#window !== undefined && !this.#window.released)
      throw new Error("barrier already armed");
    this.#window = {
      expected,
      arrivals: 0,
      released: false,
    };
    return { expected, arrivals: 0 };
  }

  status(): { readonly expected: number; readonly arrivals: number; readonly released: boolean } {
    const current = this.#window;
    if (current === undefined) return { expected: 0, arrivals: 0, released: false };
    return {
      expected: current.expected,
      arrivals: current.arrivals,
      released: current.released,
    };
  }

  release(): { readonly expected: number; readonly arrivals: number; readonly released: boolean } {
    const current = this.#window;
    if (current === undefined || current.arrivals !== current.expected || current.released) {
      throw new Error("barrier is not ready to release");
    }
    current.released = true;
    return this.status();
  }

  async awaitRevoke(): Promise<void> {
    const current = this.#window;
    if (current === undefined || current.released) return;
    if (current.arrivals >= current.expected) throw new Error("unexpected revoke barrier arrival");
    current.arrivals += 1;
    const deadline = Date.now() + BARRIER_WAIT_LIMIT_MS;
    // A timer-backed yield lets local Workerd dispatch the second independent
    // HTTP request and the capability-bound release control; an unresolved
    // in-memory promise pins this local isolate and falsely serializes them.
    while (!current.released) {
      if (Date.now() >= deadline) throw new Error("revoke barrier release timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

const barrier = new RevokeBarrier();

/**
 * Local-only gate immediately before the real D1 transaction boundary used by
 * session writes. Each contender has already prepared its replay claim and
 * side effects, but neither `DB.batch()` can execute until two independent
 * HTTP requests have arrived and the capability-bound controller releases
 * them. This makes the same-key collision causal without mocking D1.
 */
class SessionReplayBarrier {
  #window: SessionReplayBarrierWindow | undefined;

  arm(scope: SessionReplayScope): SessionReplayBarrierWindow {
    if (this.#window !== undefined && !this.#window.released) {
      throw new Error("session replay barrier already armed");
    }
    this.#window = { scope, expected: 2, arrivals: 0, released: false };
    return this.status();
  }

  status(): SessionReplayBarrierWindow {
    const current = this.#window;
    if (current === undefined) {
      return { scope: "session_open", expected: 0, arrivals: 0, released: false };
    }
    return { ...current };
  }

  release(): SessionReplayBarrierWindow {
    const current = this.#window;
    if (current === undefined || current.arrivals !== current.expected || current.released) {
      throw new Error("session replay barrier is not ready to release");
    }
    current.released = true;
    return this.status();
  }

  async awaitBatch(scope: SessionReplayScope): Promise<void> {
    const current = this.#window;
    if (current === undefined || current.scope !== scope || current.released) return;
    if (current.arrivals >= current.expected) {
      throw new Error("unexpected session replay barrier arrival");
    }
    current.arrivals += 1;
    const deadline = Date.now() + BARRIER_WAIT_LIMIT_MS;
    while (!current.released) {
      if (Date.now() >= deadline) throw new Error("session replay barrier release timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

const sessionReplayBarrier = new SessionReplayBarrier();

type HarnessPreparedStatement = ReturnType<Env["DB"]["prepare"]>;

const rawStatementByWrapper = new WeakMap<object, HarnessPreparedStatement>();
const replayScopeByWrapper = new WeakMap<object, SessionReplayScope>();
const wrappedDatabaseByBinding = new WeakMap<object, Env["DB"]>();

function sessionReplayScope(sql: string): SessionReplayScope | undefined {
  if (!sql.includes("INSERT INTO session_write_replays")) return undefined;
  return SESSION_REPLAY_SCOPES.find((scope) => sql.includes(`'${scope}'`));
}

function wrappedStatement(
  statement: HarnessPreparedStatement,
  scope: SessionReplayScope | undefined,
): HarnessPreparedStatement {
  const wrapper = new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...values: unknown[]) => wrappedStatement(target.bind(...values), scope);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  rawStatementByWrapper.set(wrapper, statement);
  if (scope !== undefined) replayScopeByWrapper.set(wrapper, scope);
  return wrapper;
}

function sessionReplayDatabase(binding: Env["DB"]): Env["DB"] {
  const cached = wrappedDatabaseByBinding.get(binding);
  if (cached !== undefined) return cached;
  const wrapper = new Proxy(binding, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => wrappedStatement(target.prepare(sql), sessionReplayScope(sql));
      }
      if (property === "batch") {
        return async (statements: readonly HarnessPreparedStatement[]) => {
          const scope = statements
            .map((statement) => replayScopeByWrapper.get(statement))
            .find((candidate) => candidate !== undefined);
          if (scope !== undefined) await sessionReplayBarrier.awaitBatch(scope);
          const rawStatements = statements.map(
            (statement) => rawStatementByWrapper.get(statement) ?? statement,
          );
          return await target.batch(rawStatements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Env["DB"];
  wrappedDatabaseByBinding.set(binding, wrapper);
  return wrapper;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}

function controlAuthorized(request: Request, env: LocalHarnessEnv): boolean {
  return (
    env.TOKEN_LIFECYCLE_LOCAL_HARNESS === LOCAL_HARNESS_ENABLED &&
    typeof env.TOKEN_LIFECYCLE_BARRIER_CAP === "string" &&
    CAPABILITY_PATTERN.test(env.TOKEN_LIFECYCLE_BARRIER_CAP) &&
    request.headers.get("x-token-lifecycle-barrier-cap") === env.TOKEN_LIFECYCLE_BARRIER_CAP
  );
}

async function controlResponse(
  request: Request,
  env: LocalHarnessEnv,
): Promise<Response | undefined> {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith(CONTROL_PREFIX)) return undefined;
  if (!controlAuthorized(request, env)) return new Response(null, { status: 404 });
  if (pathname.startsWith(`${CONTROL_PREFIX}session-replay/`)) {
    const action = pathname.slice(`${CONTROL_PREFIX}session-replay/`.length);
    if (action === "status" && request.method === "GET") {
      return json(sessionReplayBarrier.status());
    }
    if (action === "release" && request.method === "POST") {
      try {
        return json(sessionReplayBarrier.release());
      } catch {
        return new Response(null, { status: 409 });
      }
    }
    if (action === "arm" && request.method === "POST") {
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return new Response(null, { status: 400 });
      }
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload) ||
        Object.keys(payload).length !== 1 ||
        typeof (payload as Record<string, unknown>).scope !== "string" ||
        !SESSION_REPLAY_SCOPES.includes(
          (payload as Record<string, unknown>).scope as SessionReplayScope,
        )
      ) {
        return new Response(null, { status: 400 });
      }
      try {
        return json(
          sessionReplayBarrier.arm(
            (payload as Record<string, unknown>).scope as SessionReplayScope,
          ),
        );
      } catch {
        return new Response(null, { status: 409 });
      }
    }
    return new Response(null, { status: 404 });
  }
  if (pathname === `${CONTROL_PREFIX}arm` && request.method === "POST") {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload) ||
      Object.keys(payload).length !== 1 ||
      (payload as Record<string, unknown>).expected !== 2
    ) {
      return new Response(null, { status: 400 });
    }
    try {
      return json(barrier.arm(2));
    } catch {
      return new Response(null, { status: 409 });
    }
  }
  if (pathname === `${CONTROL_PREFIX}status` && request.method === "GET")
    return json(barrier.status());
  if (pathname === `${CONTROL_PREFIX}release` && request.method === "POST") {
    try {
      return json(barrier.release());
    } catch {
      return new Response(null, { status: 409 });
    }
  }
  return new Response(null, { status: 404 });
}

function barrierStore(env: Env): EnrollmentStore {
  const delegate = new D1EnrollmentStore(env.DB);
  return new Proxy(delegate, {
    get(target, property) {
      if (property === "revokeCredential") {
        return async (attempt: CredentialRevokeAttempt) => {
          await barrier.awaitRevoke();
          return await target.revokeCredential(attempt);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as EnrollmentStore;
}

const app = createApp({ createEnrollmentStore: barrierStore });

export default {
  async fetch(request: Request, env: LocalHarnessEnv, ctx: ExecutionContext): Promise<Response> {
    const control = await controlResponse(request, env);
    if (control !== undefined) return control;
    const requestEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "DB") return sessionReplayDatabase(target.DB);
        if (property === "AI") {
          return {
            async run() {
              return {
                response: JSON.stringify({
                  decision: "pass",
                  coarse_category: "benign-context",
                  bands: {
                    "benign-context": "high",
                    "spam-commercial": "low",
                    injection: "low",
                    "dual-use-boundary": "low",
                    "operational-harm": "low",
                    harassment: "low",
                    "sexual-content": "low",
                    "provider-unavailable": null,
                  },
                }),
              };
            },
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    return app.fetch(request, requestEnv, ctx);
  },
};

export { KraterOutboxDrainer };
