#!/usr/bin/env bun
/**
 * OPS.2a HTTP adapter — a real loopback server and a real client fault.
 *
 * Replaces an `ADAPTER_UNAVAILABLE` placeholder with an assertion over an actual
 * TCP connection: a server is bound on 127.0.0.1 with an ephemeral port, a
 * client makes real requests, and the adapter asserts the fault surface an
 * agent-facing route must present — status, route template, and a request id
 * that correlates the client's view with the server's.
 *
 * ## What it exercises
 *
 * - `/ok`     -> 200, echoes the caller's `x-request-id`
 * - `/fault`  -> 500 with a *server-minted* request id, so a client that sent
 *                none can still correlate its failure with a server record
 * - `/slow`   -> never answers, to prove the client's own timeout is bounded
 *
 * ## Modes
 *
 * `--mode ok`            asserts the fault route really answers 500 and returns
 *                        a usable request id. Exits 0 only if it does.
 * `--mode planted-fail`  asserts `/fault` returns 200 — which it does not — so
 *                        the check fails. This proves the assertion can fail
 *                        rather than passing vacuously.
 *
 * ## Bounded cleanup
 *
 * The server is stopped in a `finally`, and a watchdog force-exits the process
 * if shutdown ever hangs, so a harness step can never leak a listening socket
 * into the next run. Loopback only: this binds no external interface.
 */
const BLOCKED_EXIT_CODE = 78;
const CLIENT_TIMEOUT_MS = 2_000;
/** Hard ceiling on the whole adapter, independent of any individual request. */
const ADAPTER_WATCHDOG_MS = 15_000;

type Mode = "ok" | "planted-fail";

function say(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ adapter: "http", ...record })}\n`);
}

function parseMode(argv: readonly string[]): Mode {
  const index = argv.indexOf("--mode");
  const value = index >= 0 ? argv[index + 1] : "ok";
  if (value !== "ok" && value !== "planted-fail") {
    say({ status: "fail", code: "USAGE", detail: "usage: http-fault.ts --mode <ok|planted-fail>" });
    process.exit(2);
  }
  return value;
}

/** Deterministic, non-secret correlation id. Carries no caller data. */
function mintRequestId(counter: number): string {
  return `req-harness-${counter.toString(36).padStart(6, "0")}`;
}

async function main(): Promise<number> {
  const mode = parseMode(process.argv.slice(2));
  let served = 0;

  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 8,
      fetch(request) {
        served += 1;
        const url = new URL(request.url);
        const requestId = request.headers.get("x-request-id") ?? mintRequestId(served);
        if (url.pathname === "/ok") {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json", "x-request-id": requestId },
          });
        }
        if (url.pathname === "/fault") {
          // An agent-facing fault must be correlatable even when the caller sent
          // no id of its own, which is why the server mints one here.
          return new Response(JSON.stringify({ ok: false, code: "PLANTED_SERVER_FAULT" }), {
            status: 500,
            headers: { "content-type": "application/json", "x-request-id": requestId },
          });
        }
        if (url.pathname === "/slow") {
          return new Promise<Response>(() => {
            /* deliberately never settles; the client timeout is the assertion */
          });
        }
        return new Response("not found", { status: 404, headers: { "x-request-id": requestId } });
      },
    });
  } catch (error) {
    say({
      status: "blocked",
      code: "HTTP_ADAPTER_UNAVAILABLE",
      error_class: error instanceof Error ? error.name : "unknown",
      detail: "A loopback listener could not be bound; no HTTP behavior was exercised.",
    });
    return BLOCKED_EXIT_CODE;
  }

  const watchdog = setTimeout(() => {
    say({
      status: "fail",
      code: "HTTP_ADAPTER_WATCHDOG",
      detail: "The adapter exceeded its hard ceiling and force-exited; no result is claimed.",
    });
    process.exit(1);
  }, ADAPTER_WATCHDOG_MS);
  // Do not hold the event loop open on the watchdog alone.
  watchdog.unref?.();

  const base = `http://127.0.0.1:${server.port}`;
  try {
    // 1. Healthy route, caller-supplied id must be echoed back.
    const callerId = "req-harness-caller";
    const okResponse = await fetch(`${base}/ok`, {
      headers: { "x-request-id": callerId },
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
    const okEcho = okResponse.headers.get("x-request-id");

    // 2. The planted fault.
    const faultResponse = await fetch(`${base}/fault`, {
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
    const faultId = faultResponse.headers.get("x-request-id");

    // 3. The client's own timeout must bound a server that never answers.
    let slowTimedOut = false;
    try {
      await fetch(`${base}/slow`, { signal: AbortSignal.timeout(250) });
    } catch {
      slowTimedOut = true;
    }

    const expectedFaultStatus = mode === "ok" ? 500 : 200;
    const passed =
      okResponse.status === 200 &&
      okEcho === callerId &&
      faultResponse.status === expectedFaultStatus &&
      typeof faultId === "string" &&
      faultId.length > 0 &&
      slowTimedOut;

    say({
      status: passed ? "pass" : "fail",
      code: passed ? "HTTP_FAULT_SURFACE_VERIFIED" : "HTTP_FAULT_SURFACE_MISMATCH",
      mode,
      route_template: "/fault",
      http_method: "GET",
      expected_status: expectedFaultStatus,
      observed_status: faultResponse.status,
      request_id_echoed: okEcho === callerId,
      request_id_minted: typeof faultId === "string" && faultId.startsWith("req-harness-"),
      slow_route_timed_out: slowTimedOut,
      requests_served: served,
      detail: passed
        ? "A real loopback fault answered with the expected status and a correlatable request id, and an unanswered route was bounded by the client timeout."
        : "The observed fault surface did not match the asserted status or request-id contract.",
    });
    return passed ? 0 : 1;
  } catch (error) {
    say({
      status: "fail",
      code: "HTTP_CLIENT_ERROR",
      error_class: error instanceof Error ? error.name : "unknown",
      detail: "The client could not complete its requests against the loopback server.",
    });
    return 1;
  } finally {
    clearTimeout(watchdog);
    try {
      // Bounded shutdown: close listeners and in-flight sockets, including the
      // deliberately unanswered /slow request.
      server.stop(true);
    } catch {
      /* the process is exiting anyway */
    }
  }
}

process.exit(await main());
