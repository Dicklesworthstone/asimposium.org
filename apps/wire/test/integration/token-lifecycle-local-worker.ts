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

const CONTROL_PREFIX = "/__token-lifecycle/";
const LOCAL_HARNESS_ENABLED = "enabled";
const CAPABILITY_PATTERN = /^[a-f0-9]{64}$/;
const BARRIER_WAIT_LIMIT_MS = 5_000;

/**
 * Local-only witness for two real HTTP requests reaching the store after
 * service idempotency preparation and before D1's transactional revoke.
 * It is mounted solely by wrangler.token-lifecycle.toml; production index.ts
 * neither imports this entrypoint nor declares its enabling binding.
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
    return control ?? app.fetch(request, env, ctx);
  },
};

export { KraterOutboxDrainer };
