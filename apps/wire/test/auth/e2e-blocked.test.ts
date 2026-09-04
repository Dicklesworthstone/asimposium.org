// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this suite asserts on the
// text of a bash script, where `${VAR}` is the shell expansion being checked, not a
// JavaScript template placeholder. Rewriting them would stop the assertions matching
// the source they exist to pin.

/**
 * S-6 harness invariants that must hold without starting workerd.
 *
 * These guard the *shape* of the local proof: that the harness stays unmounted,
 * that it names no product route, that its blockers are stated rather than
 * implied, and that local proof is never described as deployed proof. The
 * behavioural proof lives in `scripts/e2e-s6-auth-ingress.sh`. Its self-test
 * needs real local Workerd and D1, so the wire integration suite executes it
 * as a bounded preflight rather than relabelling it as an in-process unit test.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyRefusal,
  EXPECTED_REFUSAL,
  LOCAL_FETCH_TIMEOUT_MS,
  loadSigningKey,
  localD1ExpiredCountMatches,
  localFetch,
  validateLoopbackOrigin,
} from "../../src/auth/local-check";
import { cookieTrappedRequest } from "../../src/auth/local-worker";

const root = resolve(import.meta.dir, "..", "..", "..", "..");
const read = (relative: string): string => readFileSync(resolve(root, relative), "utf8");

/**
 * Assertions about what a file *does* must read the code, not the prose. These
 * files deliberately name the substitutes they refuse ("not a `bun:sqlite`
 * shim", "no account_id") and a comment saying so must never be mistaken for
 * the thing itself.
 */
const code = (relative: string): string =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|\s)(\/\/|#).*$/, "$1"))
    .join("\n");

const WORKER = "apps/wire/src/auth/local-worker.ts";
const CHECKER = "apps/wire/src/auth/local-check.ts";
const SCRIPT = "scripts/e2e-s6-auth-ingress.sh";
const CONFIG = "apps/wire/wrangler.s6.toml";
const SUITES = "apps/wire/scripts/suites.ts";

// The shell runs a real workerd/D1 lifecycle and can be slow on a loaded host.
// Leave enough room for its direct-child TERM/KILL cleanup before Bun's outer
// test timeout, so the test runner never strands the bash process it spawned.
const SHELL_SELF_TEST_INNER_BUDGET_MS = 230_000;
const SHELL_SELF_TEST_TERM_GRACE_MS = 40_000;
const SHELL_SELF_TEST_KILL_GRACE_MS = 20_000;
const SHELL_SELF_TEST_STREAM_DRAIN_MS = 5_000;
const SHELL_SELF_TEST_TIMEOUT_MS = 300_000;
const FAIL_STATUS_RECORD = /"status"\s*:\s*"fail"/;

interface ShellSelfTest {
  result(): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  cleanup(): Promise<void>;
}

function startShellSelfTest(): ShellSelfTest {
  const {
    S6_PORT: _port,
    S6_SELF_TEST: _selfTest,
    S6_TEST_CHECK_DEADLINE_SECONDS: _deadline,
    S6_TEST_SIGNAL_WINDOW: _signalWindow,
    S6_TEST_REPEAT_SIGNAL_DURING_CLEANUP: _repeatSignal,
    S6_TEST_GROUP_INSPECTION_FAILURES_REMAINING: _inspectionFailures,
    S6_TEST_WEDGE_AFTER_RESTART: _wedge,
    ...environment
  } = process.env;
  const child = Bun.spawn({
    cmd: ["bash", SCRIPT],
    cwd: root,
    env: { ...environment, S6_SELF_TEST: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let childHasExited = false;
  const childExit = child.exited.then((exitCode) => {
    childHasExited = true;
    return exitCode;
  });
  let cleanupPromise: Promise<void> | undefined;

  const waitForExit = async (timeoutMs: number): Promise<number | undefined> =>
    await new Promise<number | undefined>((complete) => {
      const timer = setTimeout(() => complete(undefined), timeoutMs);
      void childExit.then((exitCode) => {
        clearTimeout(timer);
        complete(exitCode);
      });
    });

  const completeWithin = async <Value>(
    promise: Promise<Value>,
    timeoutMs: number,
    operation: string,
  ): Promise<Value> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`S-6 shell self-test timed out while ${operation}`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const cleanup = async (): Promise<void> => {
    if (cleanupPromise !== undefined) return cleanupPromise;
    cleanupPromise = (async () => {
      if (!childHasExited) {
        // This is the exact direct bash child only. The script itself owns and
        // proves cleanup of its workerd process groups.
        child.kill("SIGTERM");
        if ((await waitForExit(SHELL_SELF_TEST_TERM_GRACE_MS)) === undefined) {
          child.kill("SIGKILL");
          if ((await waitForExit(SHELL_SELF_TEST_KILL_GRACE_MS)) === undefined) {
            throw new Error("S-6 shell self-test direct child survived SIGKILL");
          }
        }
      }
      await completeWithin(
        Promise.allSettled([stdout, stderr]),
        SHELL_SELF_TEST_STREAM_DRAIN_MS,
        "draining direct-child output during cleanup",
      );
    })();
    return cleanupPromise;
  };

  return {
    async result(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      const deadline = performance.now() + SHELL_SELF_TEST_INNER_BUDGET_MS;
      const remaining = (): number => Math.max(1, Math.floor(deadline - performance.now()));
      const exitCode = await completeWithin(
        childExit,
        remaining(),
        `waiting for the direct child within ${SHELL_SELF_TEST_INNER_BUDGET_MS}ms`,
      );
      const [capturedStdout, capturedStderr] = await completeWithin(
        Promise.all([stdout, stderr]),
        remaining(),
        "draining direct-child output within the inner budget",
      );
      return { exitCode, stdout: capturedStdout, stderr: capturedStderr };
    },
    cleanup,
  };
}

describe("the S-6 harness stays a harness", () => {
  test("the production router never imports it", () => {
    const app = read("apps/wire/src/app.ts");
    const index = read("apps/wire/src/index.ts");
    expect(app).not.toContain("local-worker");
    expect(app).not.toContain("auth/local");
    expect(index).not.toContain("local-worker");
  });

  test("it mounts no product route", () => {
    const worker = read(WORKER);
    // Every mounted path must live under the `__s6` harness prefix.
    for (const match of worker.matchAll(/url\.pathname === "([^"]+)"/g)) {
      expect(match[1]).toStartWith("/__s6/");
    }
    expect(worker).toContain('S6_INGRESS_ROUTE = "/__s6/ingress"');
  });

  test("the ingress route performs no business write", () => {
    const worker = read(WORKER);
    // The only durable write is the nonce, and it belongs to D1NonceStore.
    expect(worker).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/);
    expect(worker).toContain("new D1NonceStore(env.DB)");
  });
});

describe("no mock may stand in for the binding", () => {
  test("neither harness file imports a SQLite substitute", () => {
    for (const file of [WORKER, CHECKER]) {
      const source = code(file);
      expect(source).not.toContain("bun:sqlite");
      expect(source).not.toContain("better-sqlite3");
      expect(source).not.toContain("MemoryNonceStore");
    }
  });

  test("the runner has no offline or fixture fallback", () => {
    const script = read(SCRIPT);
    expect(script).not.toMatch(/OFFLINE|FIXTURE_MODE|--simulate/);
    // A missing binding must fail, never degrade into a green run.
    expect(script).toContain("local_d1_migrations_applied");
  });

  test("the config binds real local D1 through the numbered migrations", () => {
    const config = code(CONFIG);
    expect(config).toContain('binding = "DB"');
    expect(config).toContain('migrations_dir = "../../db/migrations"');
    expect(config).toContain("workers_dev = false");
    expect(config).not.toContain("account_id");
    expect(config).not.toMatch(/^route/m);
  });
});

describe("the external boundary is stated, not implied", () => {
  const script = read(SCRIPT);

  test("every required external blocker is named with its forbidden substitute", () => {
    for (const code of [
      "VERCEL_AUTHJS_GOOGLE_COOKIE_ABSENT",
      "DEPLOYED_WORKER_AND_D1_ABSENT",
      "MULTI_COLO_DISTRIBUTION_ABSENT",
      "TRUE_CROSS_PLANE_PROOF_ABSENT",
    ]) {
      expect(script).toContain(code);
    }
    expect(script).toContain("forbidden_substitutes");
    expect(script).toContain("local workerd or local D1 presented as deployed proof");
  });

  test("the run ends blocked at 78, never green", () => {
    expect(script).toContain("readonly BLOCKED_EXIT=78");
    expect(script).toContain('exit "${BLOCKED_EXIT}"');
  });

  test("no emitted record ever calls local proof deployed proof", () => {
    // Prose may discuss the deployed seam; emitted evidence may not claim it.
    for (const file of [SCRIPT, WORKER, CHECKER]) {
      for (const line of code(file).split("\n")) {
        if (!/deployed/i.test(line)) continue;
        // A line mentioning "deployed" in executable code must be a blocked
        // record or a refusal, never a pass.
        expect(line).not.toMatch(/"status"\s*:\s*\\?"pass/);
      }
    }
    // And the blocked records must actually name the deployed seam.
    expect(script).toContain("DEPLOYED_WORKER_AND_D1_ABSENT");
  });

  test("the checker labels its scope on the summary record", () => {
    expect(read(CHECKER)).toContain("local-workerd + local-D1 on one machine; not deployed proof");
  });
});

describe("lifecycle discipline", () => {
  const script = read(SCRIPT);

  test("the port is owned and dynamic, and a supplied one is validated", () => {
    expect(script).toContain("allocate_port()");
    expect(script).toContain("port: 0");
    expect(script).toMatch(/S6_PORT < 1024 \|\| S6_PORT > 65535/);
  });

  test("the inspector port never collides", () => {
    expect(script).toContain("--inspector-port 0");
  });

  test("readiness is tied to the exact pinned supervisor", () => {
    expect(script).toContain("supervisor_identity_is_exact()");
    expect(script).toContain("SERVER_SUPERVISOR_PID");
    expect(script).toContain('"${SERVER_SUPERVISOR_STARTED_AT}" "${SERVER_SUPERVISOR_TOKEN}"');
  });

  test("cleanup terminates the process group, then escalates within a bound", () => {
    // Addressed by group id, which `start_worker` has proven equals the child pid.
    expect(script).toContain('kill -TERM "-${pgid}"');
    expect(script).toContain('kill -KILL "-${pgid}"');
    // The escalation is bounded: each wait is a counted loop, not an open block.
    expect(script).toMatch(/for _wait in \{1\.\.\d+\}; do/);
  });

  test("every terminating signal is trapped", () => {
    for (const signal of ["EXIT", "INT", "TERM", "HUP"]) {
      expect(script).toMatch(new RegExp(`trap [^\\n]*${signal}`));
    }
  });

  test("state is isolated and never deleted", () => {
    expect(script).toContain("mktemp -d -t asimposium-s6-auth");
    expect(script).not.toMatch(/rm -rf|rm -f/);
  });

  test("every curl carries a timeout", () => {
    // Executable lines only: a comment discussing curl is prose, and holding it
    // to an invocation's contract would make the guard fire on documentation
    // while proving nothing about a real call.
    for (const line of code(SCRIPT).split("\n")) {
      if (!line.includes("curl ")) continue;
      expect(line).toContain("--max-time");
      expect(line).toContain("--connect-timeout");
    }
  });

  test("the self-test proves the gate can fail and that children are reaped", () => {
    expect(script).toContain("planted_failure_is_detected");
    expect(script).toContain("busy_port_contender_never_wins");
    expect(script).toContain("child_process_group_is_reaped");
  });
});

/**
 * Regressions found live by an independent reviewer. Each of these fails against
 * the behaviour that shipped before the fix, which is what makes them worth
 * keeping: a lifecycle guarantee that was only ever true by luck reads exactly
 * like one that is enforced.
 */
describe("lifecycle defects that must not return", () => {
  const script = read(SCRIPT);
  const worker = read(WORKER);

  test("the runner owns a real process group instead of assuming one", () => {
    // Without job control `$!` is a pid inside the script's own group, so
    // `kill -TERM -$!` fails and the fallback reaps only the wrapper.
    expect(script).toMatch(/^set -m$/m);
    // And the assumption is verified, not trusted, while the leader is stopped
    // before it can execute Wrangler.
    expect(script).toContain('SUPERVISOR_PGID="$(ps -o pgid= -p "${SUPERVISOR_PID}"');
    expect(script).toContain("pinned_supervisor_identity");
    expect(script).toMatch(/"\$\{SUPERVISOR_PID\}" != "\$\{SUPERVISOR_PGID\}"/);
    expect(script).toContain('kill -STOP "$$"');
  });

  test("no cleanup path silently degrades to killing the parent only", () => {
    expect(script).not.toMatch(
      /kill -TERM "-\$\{SERVER_PID\}".*\|\|.*kill -TERM "\$\{SERVER_PID\}"/,
    );
    expect(script).not.toMatch(
      /kill -KILL "-\$\{SERVER_PID\}".*\|\|.*kill -KILL "\$\{SERVER_PID\}"/,
    );
  });

  test("survivors are counted by process group, not by parent pid alone", () => {
    expect(script).toContain("group_members()");
    expect(script).toContain("ps -eo pid=,pgid=");
    // The cleanup assertion must consult the group, not only the listening socket.
    expect(script).toMatch(/members="\$\(group_members/);
  });

  test("readiness requires this run's ownership marker, not any 200", () => {
    // A foreign Worker already on the port answers /__s6/health too.
    expect(worker).toContain("run_id: env.S6_RUN_ID");
    expect(script).toContain('--var "S6_RUN_ID:${S6_RUN_ID}"');
    expect(script).toMatch(/health\}" == \*"\\"run_id\\":\\"\$\{S6_RUN_ID\}\\""\*/);
    // The old readiness probe discarded the body entirely.
    expect(script).not.toMatch(/curl[^\n]*--output \/dev\/null[^\n]*__s6\/health/);
  });

  test("the busy-port self-test asserts a real outcome instead of emitting pass", () => {
    // Bounded by the self-test that follows it. This used to end at
    // `child_process_group_is_reaped`, which has since moved above the
    // busy-port block into the shared survivor helper -- leaving the slice
    // empty and the assertions below vacuously true against no text at all.
    const start = script.indexOf("busy_run_id=");
    const end = script.indexOf("foreign_readiness_is_rejected");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = script.slice(start, end);
    expect(block.length).toBeGreaterThan(0);
    // A contender must be proven not to win, with failure paths that can fire.
    expect(block).toContain("busy_port_contender_never_wins");
    expect(block).toContain('fail_record "busy_port_contender_never_wins"');
    expect(block).toContain('fail_record "busy_port_owner_keeps_the_port"');
    expect(block).toContain('fail_record "busy_port_contender_group_is_reaped"');
    // The contender carries its own marker so "it never served" is checkable.
    expect(block).toMatch(/--var "S6_RUN_ID:\$\{busy_run_id\}"/);
  });

  test("redaction survives an unset HOME under set -u", () => {
    expect(script).toContain('readonly REDACTION_REPOSITORY="<repo>"');
    expect(script).toContain('readonly REDACTION_HOME="<home>"');
    expect(script).toContain('readonly REDACTION_SECRET="<redacted>"');
    expect(script).toContain('local home="${HOME:-}"');
    // A bare ${HOME} expansion would abort exactly when a failure needs showing.
    expect(script).not.toMatch(/s\|\$\{HOME\}\|/);
  });
});

/**
 * The cookie canary, exercised rather than read.
 *
 * `Headers` is iterable, so a canary that watches only `get`/`has` reports zero
 * reads while an adapter reads the session cookie through `entries()`,
 * `forEach()`, `keys()`, `values()` or `for…of`. That is worse than no canary:
 * the zero is trusted. Each access path below is a real read attempt against
 * the real trap.
 */
describe("the cookie canary observes every access path", () => {
  const withCookie = (): Request =>
    new Request("https://a.asimposium.org/__s6/ingress", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "__Host-authjs.session-token=CANARY_SESSION_VALUE",
        "x-asimposium-envelope": "envelope-placeholder",
      },
      body: "{}",
    });

  /** Every way a consumer can reach a header, named by how it reads. */
  const accessPaths: ReadonlyArray<[string, (headers: Headers) => void]> = [
    ["get", (headers) => void headers.get("cookie")],
    ["get (mixed case)", (headers) => void headers.get("CoOkIe")],
    ["has", (headers) => void headers.has("cookie")],
    ["entries", (headers) => void [...headers.entries()]],
    ["Symbol.iterator", (headers) => void [...headers]],
    ["keys", (headers) => void [...headers.keys()]],
    ["values", (headers) => void [...headers.values()]],
    [
      "forEach",
      (headers) => {
        // A `forEach` callback returns nothing by contract; a block body says so.
        headers.forEach(() => {});
      },
    ],
  ];

  for (const [label, read] of accessPaths) {
    test(`PLANTED: reading the cookie via ${label} trips the canary`, () => {
      let reads = 0;
      const guarded = cookieTrappedRequest(withCookie(), () => {
        reads += 1;
      });
      expect(() => read(guarded.headers)).toThrow("S6_COOKIE_READ_ON_AGENT_HOST");
      expect(reads).toBe(1);
    });
  }

  test("the cookie value never escapes through an iterator before the trap fires", () => {
    const guarded = cookieTrappedRequest(withCookie(), () => undefined);
    const seen: string[] = [];
    try {
      for (const [name, value] of guarded.headers as unknown as Iterable<[string, string]>) {
        seen.push(`${name}=${value}`);
      }
    } catch {
      // expected
    }
    // Whatever was yielded before the throw must not contain the session value.
    expect(seen.join("|")).not.toContain("CANARY_SESSION_VALUE");
    expect(seen.some((entry) => /^cookie=/i.test(entry))).toBe(false);
  });

  test("headers that are not Cookie still read normally", () => {
    let reads = 0;
    const guarded = cookieTrappedRequest(
      new Request("https://a.asimposium.org/__s6/ingress", {
        method: "POST",
        headers: { "content-type": "application/json", "x-asimposium-envelope": "e" },
        body: "{}",
      }),
      () => {
        reads += 1;
      },
    );
    expect(guarded.headers.get("content-type")).toBe("application/json");
    expect(guarded.headers.has("x-asimposium-envelope")).toBe(true);
    expect([...guarded.headers.keys()].length).toBeGreaterThan(0);
    let iterated = 0;
    guarded.headers.forEach(() => {
      iterated += 1;
    });
    expect(iterated).toBeGreaterThan(0);
    // A request without a cookie must never trip the canary.
    expect(reads).toBe(0);
  });

  test("the request proxy still exposes the real method, url and body", async () => {
    const guarded = cookieTrappedRequest(withCookie(), () => undefined);
    expect(guarded.method).toBe("POST");
    expect(new URL(guarded.url).pathname).toBe("/__s6/ingress");
    expect(await guarded.text()).toBe("{}");
  });
});

describe("lifecycle defects the takeover had to fix", () => {
  const script = read(SCRIPT);

  test("PLANTED: trap variables are initialised before the trap is armed", () => {
    // The EXIT trap reads SERVER_PGID and is armed before start_worker runs, so
    // an early exit under `set -u` would abort cleanup with "unbound variable".
    const armed = script.indexOf("trap on_exit EXIT");
    expect(armed).toBeGreaterThan(0);
    expect(script.indexOf('SERVER_PGID=""')).toBeGreaterThan(0);
    expect(script.indexOf('SERVER_PGID=""')).toBeLessThan(armed);
    expect(script.indexOf('SERVER_SUPERVISOR_PID=""')).toBeLessThan(armed);
  });

  test("PLANTED: the controller's own process group can never be signalled", () => {
    expect(script).toContain("CONTROLLER_PGID=");
    expect(script).toMatch(/"\$\{pgid\}" == "\$\{CONTROLLER_PGID\}"/);
    expect(script).toContain("never_signals_the_controller_group");
    // The guard must sit before any kill in stop_group.
    const stopGroup = script.slice(
      script.indexOf("stop_group() {"),
      script.indexOf("stop_worker() {"),
    );
    expect(stopGroup.indexOf("CONTROLLER_PGID")).toBeLessThan(stopGroup.indexOf("kill -TERM"));
  });

  test("PLANTED: an identity-refused cleanup makes the full run fail", () => {
    expect(script).toContain("local cleanup_status=0");
    expect(script).toContain('stop_group "${SERVER_PGID}" "${SERVER_SUPERVISOR_PID}"');
    expect(script).toContain('fail_record "worker_group_cleanup_proved"');
    const terminalCleanup = script.slice(script.lastIndexOf("if cleanup_and_verify; then"));
    expect(terminalCleanup).toContain('fail_record "worker_group_cleanup_proved"');
    expect(terminalCleanup).toContain("exit 1");
  });

  test("PLANTED: an occupied pinned port is refused before the Worker starts", () => {
    expect(script).toContain("port_is_occupied()");
    expect(script).toContain("pinned_port_is_free");
    // Refused before the launcher, not diagnosed afterwards as a dead Worker.
    expect(script.indexOf("pinned_port_is_free")).toBeLessThan(script.indexOf("start_worker()"));
  });

  test("PLANTED: the checker deadline escalates TERM then KILL", () => {
    const block = script.slice(script.indexOf("run_checker()"), script.indexOf("run_checker\n"));
    const cleanup = script.slice(
      script.indexOf("stop_exact_direct_child()"),
      script.indexOf("clear_restart_checker_identity()"),
    );
    expect(block).toContain("if ! stop_checker; then");
    expect(cleanup).toContain('kill -TERM "${pid}"');
    expect(cleanup).toContain('kill -KILL "${pid}"');
    expect(cleanup).toContain("TEST_DIRECT_CHILD_CLEANUP_SECONDS");
  });

  test("PLANTED: curl failure evidence is retained, not discarded", () => {
    expect(script).toContain("probe()");
    expect(script).toContain('2>>"${CURL_LOG}"');
    expect(script).toContain('show_redacted "curl" "${CURL_LOG}"');
    // No health probe may silently swallow its diagnostics any more.
    expect(script).not.toMatch(/curl[^\n]*__s6\/health[^\n]*2>\/dev\/null/);
  });

  test("PLANTED: foreign readiness, SIGTERM and orphan checks exist and can fail", () => {
    for (const assertion of [
      "foreign_readiness_is_rejected",
      "sigterm_terminates_the_worker_group",
      "sigterm_releases_the_port",
      "no_orphaned_runtime_survives",
    ]) {
      expect(script).toContain(assertion);
      expect(script).toContain(`fail_record "${assertion}"`);
    }
    // The orphan check must look beyond the group, since a reparented
    // grandchild still holds the port.
    expect(script).toContain("ps -eo pid=,ppid=,command=");
  });
});

describe("the checker sends only to a validated loopback origin", () => {
  test("a correct loopback origin is accepted", () => {
    for (const value of ["http://127.0.0.1:8787", "http://127.0.0.1:1024", "http://[::1]:9000"]) {
      expect(() => validateLoopbackOrigin(value)).not.toThrow();
    }
    expect(validateLoopbackOrigin("http://127.0.0.1:8787").origin).toBe("http://127.0.0.1:8787");
  });

  test("PLANTED: an origin that is not http loopback is refused", () => {
    // This checker mints real signatures and sends them wherever S6_ORIGIN
    // points, so `!== undefined` is not validation — each of these would have
    // passed it while sending signed envelopes somewhere else entirely.
    const refused: ReadonlyArray<[string, string | undefined]> = [
      ["unset", undefined],
      ["empty", ""],
      ["not a URL", "127.0.0.1:8787"],
      ["https", "https://127.0.0.1:8787"],
      ["public host", "http://example.com:80"],
      ["localhost name", "http://localhost:8787"],
      ["userinfo smuggling a host", "http://127.0.0.1@evil.test:8787"],
      ["password userinfo", "http://user:pass@127.0.0.1:8787"],
      ["no explicit port", "http://127.0.0.1"],
      ["path", "http://127.0.0.1:8787/prefix"],
      ["query", "http://127.0.0.1:8787/?a=1"],
      ["fragment", "http://127.0.0.1:8787/#f"],
    ];
    for (const [label, value] of refused) {
      expect(() => validateLoopbackOrigin(value), label).toThrow();
    }
  });

  test("PLANTED: every request the checker makes is deadline-bounded", () => {
    const checker = read(CHECKER);
    // Exactly one call to the platform `fetch`, inside the wrapper.
    const bare = [...checker.matchAll(/(?<![A-Za-z])fetch\(/g)].length;
    const wrapped = [...checker.matchAll(/localFetch\(/g)].length;
    expect(bare).toBe(1);
    expect(wrapped).toBeGreaterThanOrEqual(4);
    expect(checker).toContain("AbortSignal.timeout(LOCAL_FETCH_TIMEOUT_MS)");
    // A hanging Worker must fail as a request timeout, not as an opaque
    // runner-level kill that names the wrong subsystem.
    expect(LOCAL_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test("localFetch rejects rather than hangs when nothing answers", async () => {
    // Port 1 on loopback: connect fails fast, which is enough to prove the
    // wrapper propagates a rejection instead of returning a phantom response.
    await expect(localFetch("http://127.0.0.1:1/__s6/health")).rejects.toThrow();
  });
});

describe("the group killer pins an exact supervisor before it signals", () => {
  // Lifecycle ownership is an executable property. Keep these checks on
  // comment-stripped source so a narrative mention of an owner or stop path
  // cannot satisfy one of the five signal-window guarantees.
  const script = code(SCRIPT);

  test("PLANTED: a stale or recycled group is refused, not blindly killed", () => {
    expect(script).toContain("supervisor_identity_is_exact()");
    expect(script).toContain("never_signals_a_recycled_group");
    expect(script).toContain("s6-pinned-supervisor:");
    expect(script).toContain("SUPERVISOR_STARTED_AT");
  });

  test("PLANTED: the exact leader is proven before TERM and again before KILL", () => {
    const block = script.slice(script.indexOf("stop_group() {"), script.indexOf("stop_worker() {"));
    const firstProof = block.indexOf("supervisor_identity_is_exact");
    const term = block.indexOf('kill -TERM "-${pgid}"');
    const secondProof = block.indexOf("supervisor_identity_is_exact", term);
    const kill = block.indexOf('kill -KILL "-${pgid}"');
    expect(firstProof).toBeGreaterThan(-1);
    expect(firstProof).toBeLessThan(term);
    // The group can empty and the number be reissued during the TERM grace.
    expect(secondProof).toBeGreaterThan(term);
    expect(secondProof).toBeLessThan(kill);
  });

  test("PLANTED: an already-empty group is a no-op only after the group probe succeeds", () => {
    const block = script.slice(script.indexOf("stop_group() {"), script.indexOf("stop_worker() {"));
    expect(block).toContain('members="$(group_members "${pgid}")"');
    expect(block).toContain("group_members_status=$?");
    expect(block).toContain('fail_record "group_inspection_available"');
    expect(block).not.toContain('[[ -z "$(group_members "${pgid}")" ]]');
    expect(block.indexOf("group_members_status=$?")).toBeLessThan(
      block.indexOf('kill -TERM "-${pgid}"'),
    );
  });

  test("PLANTED: a failed cleanup preserves worker identity for the EXIT retry", () => {
    const block = script.slice(script.indexOf("stop_worker() {"), script.indexOf("on_exit() {"));
    expect(block).toContain('stop_group "${SERVER_PGID}" "${SERVER_SUPERVISOR_PID}"');
    expect(block).toMatch(/if \(\( cleanup_status != 0 \)\); then\n\s+return/);
    const failedReturn = block.indexOf("if (( cleanup_status != 0 )); then");
    expect(failedReturn).toBeGreaterThan(-1);
    expect(block.indexOf('SERVER_PGID=""')).toBeGreaterThan(failedReturn);
  });

  test("PLANTED: every nonempty process row parses and the runner is present", () => {
    const block = script.slice(
      script.indexOf("assert_no_survivors() {"),
      script.indexOf("# ── the checks"),
    );
    expect(block).toContain("process_inspection_parsable");
    expect(block).toContain("runner pid $$");
    expect(block).toContain('awk -v runner="$$"');
    expect(block).not.toContain('if [[ "${rows}" == "0" ]]');
  });

  test("PLANTED: a live kernel group cannot disappear from a partial ps table", () => {
    const block = script.slice(
      script.indexOf("group_members() {"),
      script.indexOf("stop_group() {"),
    );
    expect(block).toContain('kill -0 "-${pgid}"');
    expect(block).toContain("group_liveness_status=$?");
    expect(block).toContain("return 2");
  });

  test("PLANTED: a successful but blank direct ps lookup fails closed", () => {
    const members = script.slice(
      script.indexOf("group_members() {"),
      script.indexOf("stop_group() {"),
    );
    expect(members).toContain("if (( leader_status == 0 )); then");
    expect(members).toContain('[[ -n "${leader}" ]] || return 2');
    expect(script).toContain("blank_direct_group_probe");
    expect(script).toContain("group_members_rejects_blank_direct_ps");
  });

  test("PLANTED: a start failure reaches a defined survivor helper through EXIT", () => {
    const helper = script.indexOf("assert_no_survivors() {");
    const armed = script.indexOf("trap on_exit EXIT");
    const start = script.indexOf("if ! start_worker; then");
    expect(helper).toBeGreaterThan(-1);
    expect(armed).toBeGreaterThan(helper);
    expect(start).toBeGreaterThan(armed);
  });

  test("PLANTED: a pre-exec launch failure reaps its exact direct child before start returns", () => {
    const launcher = script.slice(
      script.indexOf("reap_provisional_supervisor() {"),
      script.indexOf("resume_pinned_supervisor()"),
    );
    const start = script.slice(
      script.indexOf("start_worker() {"),
      script.indexOf("assert_no_survivors() {"),
    );
    expect(launcher).toContain('kill -KILL "${pid}"');
    expect(launcher).toContain('wait_for_killed_direct_child_reap "${pid}"');
    expect(script).toContain('wait -f "${pid}"');
    expect(launcher).toContain("supervisor_direct_child_is_exact");
    expect(start.indexOf("if (( launch_status != 0 )); then")).toBeLessThan(
      start.indexOf("adopt_provisional_as_worker"),
    );
    expect(script).toContain('run_preexec_fault "not-group-leader"');
    expect(script).toContain('run_preexec_fault "identity-unavailable"');
  });

  test("PLANTED: self-test cleanup uses the production stop path and blocks unavailable lsof", () => {
    const busy = script.slice(
      script.indexOf("busy_run_id="),
      script.indexOf("foreign_readiness_is_rejected"),
    );
    expect(busy).toContain("busy_group_status=$?");
    expect(busy).not.toContain('group_members "${busy_pgid}" | wc -l');

    const sigterm = script.slice(
      script.indexOf('sigterm_pgid="${SERVER_PGID}"'),
      script.indexOf(
        "if ! cleanup_and_verify; then",
        script.indexOf('sigterm_pgid="${SERVER_PGID}"'),
      ),
    );
    expect(sigterm).toContain("if ! stop_worker; then");
    expect(sigterm).toContain('assert_no_survivors "${sigterm_pgid}"');
    expect(script).toContain("listener_bind_proves_port_released");
    expect(script).toContain("LIFECYCLE_LSOF_UNAVAILABLE");
    expect(script).toContain('"status":"blocked"');
    expect(sigterm).not.toContain('lsof -ti tcp:"${S6_PORT}" 2>/dev/null | wc -l');
  });

  test("PLANTED: wait -f capability detection is localized to the C synopsis", () => {
    const helper = script.slice(
      script.indexOf("wait_supports_full_completion()"),
      script.indexOf("wait_for_killed_direct_child_reap()"),
    );
    expect(helper).toContain("LC_ALL=C help wait");
    expect(helper).toContain("LC_ALL=C grep");
    expect(helper).not.toContain("BASH_VERSINFO");
  });

  test("PLANTED: the EXIT finalizer masks repeated signals and covers every ownership window", () => {
    const finalizer = script.slice(
      script.indexOf("cleanup_with_retry() {"),
      script.indexOf("KEY_MATERIAL="),
    );
    const onExit = script.slice(script.indexOf("on_exit() {"), script.indexOf("KEY_MATERIAL="));
    expect(finalizer).toContain("for attempt in 1 2");
    expect(finalizer).toContain("finalizer_retried_transient_inspection");
    expect(onExit).toContain("trap '' INT TERM HUP");
    expect(onExit).toContain("cleanup_with_retry");
    expect(script).toContain(
      "for signal_window in provisional-supervisor ordinary-checker restart-checker worker busy-contender",
    );
    expect(script).toContain("S6_TEST_REPEAT_SIGNAL_DURING_CLEANUP");
    expect(script).toContain('kill -HUP "$$"');
    expect(script).toContain("repeated_signal_finalizer");
    expect(script).toContain("run_nested_harness");
    expect(script).not.toMatch(/\$\([^\n]*bash "\$\{BASH_SOURCE\[0\]\}"/);
  });

  test("PLANTED: nested self-test settings are validated before dynamic export", () => {
    const nestedHarness = script.slice(
      script.indexOf("run_nested_harness()"),
      script.indexOf("NESTED_HARNESS_PID=$!", script.indexOf("run_nested_harness()")),
    );
    expect(nestedHarness).toContain('[[ "${assignment}" =~ ^S6_TEST_[A-Z0-9_]+= ]]');
    expect(nestedHarness).toContain('name="${assignment%%=*}"');
    expect(nestedHarness).toContain('value="${assignment#*=}"');
    expect(nestedHarness).toContain('export "${name}=${value}"');
    expect(nestedHarness).not.toContain('export "${assignment}"');
  });

  test("PLANTED: every S6_TEST seam is refused unless the self-test is explicit", async () => {
    const child = Bun.spawn({
      cmd: ["bash", SCRIPT],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        S6_TEST_WEDGE_AFTER_RESTART: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(`${stdout}\n${stderr}`).toContain("test_seams_require_explicit_self_test");
    expect(`${stdout}\n${stderr}`).toContain('"status":"fail"');
  });
});

describe("harness signing-key configuration fails closed", () => {
  /**
   * A private key reaching a log is the failure these guard.
   *
   * `JSON.parse(process.env.S6_PRIVATE_KEY_JWK)` was unguarded, so a malformed
   * value crashed the checker with an unhandled rejection — and a JSON parser's
   * message routinely quotes the offending input, which here is key material.
   * Every case below asserts both halves: a non-zero exit, and no fragment of
   * the supplied value anywhere in stdout or stderr.
   */
  const SECRET_D = "S3CRET_PRIVATE_SCALAR_DO_NOT_ECHO_0f1e2d";

  const runChecker = async (
    jwk: string,
    extraEnv: Record<string, string | undefined> = {},
    args: string[] = [],
  ): Promise<{ code: number; output: string }> => {
    const child = Bun.spawn({
      cmd: ["bun", "src/auth/local-check.ts", ...args],
      cwd: resolve(root, "apps/wire"),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        // Port 1 is closed; the key check runs before any request, so this
        // never reaches the network.
        S6_ORIGIN: "http://127.0.0.1:1",
        S6_NOW: "1786000000",
        S6_KID: "s6-local",
        S6_PRIVATE_KEY_JWK: jwk,
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: await child.exited, output: `${out}\n${err}` };
  };

  test("PLANTED: malformed JSON exits nonzero and never echoes the value", async () => {
    const malformed = `{"kty":"OKP","crv":"Ed25519","d":"${SECRET_D}"`; // truncated on purpose
    const { code, output } = await runChecker(malformed);
    expect(code).not.toBe(0);
    expect(output).toContain("S6_HARNESS_KEY_MALFORMED");
    expect(output).toContain("value withheld");
    // The parser's own message quotes the input; it must never be forwarded.
    expect(output).not.toContain(SECRET_D);
    expect(output).not.toContain('"d"');
  }, 30_000);

  test("PLANTED: a structurally valid but unusable JWK exits nonzero without echo", async () => {
    // Right shape, wrong curve: this reaches importKey and must be refused
    // there rather than crashing.
    const wrongCurve = JSON.stringify({ kty: "OKP", crv: "X25519", d: SECRET_D, x: SECRET_D });
    const { code, output } = await runChecker(wrongCurve);
    expect(code).not.toBe(0);
    expect(output).toMatch(/S6_HARNESS_KEY_(MALFORMED|UNUSABLE)/);
    expect(output).not.toContain(SECRET_D);
  }, 30_000);

  test("PLANTED: an OKP/Ed25519 JWK that will not import exits nonzero without echo", async () => {
    const badMaterial = JSON.stringify({
      kty: "OKP",
      crv: "Ed25519",
      d: SECRET_D,
      x: "not-base64url!",
    });
    const { code, output } = await runChecker(badMaterial);
    expect(code).not.toBe(0);
    expect(output).toContain("S6_HARNESS_KEY_UNUSABLE");
    expect(output).not.toContain(SECRET_D);
  }, 30_000);

  test("PLANTED: an absent key is its own condition, not a crash", async () => {
    const { code, output } = await runChecker("");
    expect(code).not.toBe(0);
    expect(output).toContain("S6_HARNESS_KEY_MISSING");
  }, 30_000);

  test("PLANTED: checker test seams are refused before any harness work without self-test", async () => {
    const supplied = `{"kty":"OKP","d":"${SECRET_D}"}`;
    const { code, output } = await runChecker(supplied, { S6_TEST_WEDGE_AFTER_RESTART: "1" });
    expect(code).not.toBe(0);
    expect(output).toContain("test_seams_require_explicit_self_test");
    expect(output).not.toContain(SECRET_D);
  }, 30_000);

  test("PLANTED: restart mode refuses a missing or mismatched argv identity marker", async () => {
    const token = crypto.randomUUID().replaceAll("-", "");
    const missing = await runChecker("", { S6_PHASE: "restart", S6_RESTART_CHECKER_TOKEN: token });
    expect(missing.code).not.toBe(0);
    expect(missing.output).toContain("restart_checker_identity_configured");

    const validMarker = await runChecker(
      "",
      { S6_PHASE: "restart", S6_RESTART_CHECKER_TOKEN: token },
      [`s6-restart-checker:${token}`],
    );
    expect(validMarker.code).not.toBe(0);
    expect(validMarker.output).not.toContain("restart_checker_identity_configured");
    expect(validMarker.output).toContain("S6_HARNESS_KEY_MISSING");
  }, 30_000);

  test("the loader accepts a real Ed25519 JWK", async () => {
    // The ambient types resolve `generateKey` to the single-key arm, so the
    // two-step cast is this repository's established form for an asymmetric
    // keypair (auth-s6-hardening.test.ts:71, auth-http-ingress.test.ts:49).
    // The runtime assertion stays: a cast that stops being true should fail
    // here rather than surface as a confusing undefined further down.
    const generated = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]);
    expect(generated).toHaveProperty("privateKey");
    const pair = generated as unknown as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const loaded = await loadSigningKey(JSON.stringify(jwk));
    expect(loaded.ok).toBe(true);
    expect(loaded.key).toBeDefined();
    expect(loaded.code).toBeUndefined();
  });

  test("no failure detail ever contains the supplied value", async () => {
    for (const raw of [
      undefined,
      "",
      `{"kty":"OKP","d":"${SECRET_D}"`,
      JSON.stringify({ kty: "RSA", d: SECRET_D }),
      JSON.stringify([SECRET_D]),
      JSON.stringify({ kty: "OKP", crv: "Ed25519", d: SECRET_D, x: "!!!" }),
    ]) {
      const loaded = await loadSigningKey(raw);
      expect(loaded.ok).toBe(false);
      expect(loaded.detail ?? "").not.toContain(SECRET_D);
      expect(loaded.detail ?? "").not.toContain("!!!");
      // Bounded: a diagnostic is a sentence, not a dump.
      expect((loaded.detail ?? "").length).toBeLessThan(200);
    }
  });
});

describe("the cookie trap survives every Request-returning path", () => {
  const withCookie = (): Request =>
    new Request("https://a.asimposium.org/__s6/ingress", {
      method: "POST",
      headers: {
        cookie: "__Host-authjs.session-token=CLONE_LEAK_CANARY",
        "content-type": "application/json",
      },
      body: '{"a":1}',
    });

  test("PLANTED: clone() does not hand back an unguarded Request", () => {
    // Reproduced before the fix: every method was bound to the real target, so
    // `guarded.clone()` returned a raw Request and
    // `clone.headers.get("cookie")` read the session value while the canary
    // counted zero. A trap a caller can step around by cloning is not a trap.
    let reads = 0;
    const guarded = cookieTrappedRequest(withCookie(), () => {
      reads += 1;
    });
    expect(() => guarded.clone().headers.get("cookie")).toThrow("S6_COOKIE_READ_ON_AGENT_HOST");
    expect(reads).toBe(1);
  });

  test("PLANTED: a clone of a clone stays guarded", () => {
    const guarded = cookieTrappedRequest(withCookie(), () => undefined);
    expect(() => guarded.clone().clone().headers.get("cookie")).toThrow(
      "S6_COOKIE_READ_ON_AGENT_HOST",
    );
  });

  test("PLANTED: every iteration path is trapped on a clone too", () => {
    for (const read of [
      (h: Headers) => void [...h.entries()],
      (h: Headers) => void [...h],
      (h: Headers) => void [...h.keys()],
      (h: Headers) => void [...h.values()],
      (h: Headers) => {
        h.forEach(() => {});
      },
    ]) {
      const guarded = cookieTrappedRequest(withCookie(), () => undefined);
      // `clone()` is typed against the ambient fetch types, so its `headers`
      // needs the same two-step cast this repository uses for that mismatch.
      const cloned = guarded.clone().headers as unknown as Headers;
      expect(() => read(cloned)).toThrow("S6_COOKIE_READ_ON_AGENT_HOST");
    }
  });

  test("cloning still works for its actual purpose: reading the body twice", async () => {
    const guarded = cookieTrappedRequest(withCookie(), () => undefined);
    const copy = guarded.clone();
    expect(await copy.text()).toBe('{"a":1}');
    expect(await guarded.text()).toBe('{"a":1}');
  });

  test("a clone of a cookie-free request reads normally", () => {
    const plain = cookieTrappedRequest(
      new Request("https://a.asimposium.org/__s6/ingress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      () => undefined,
    );
    expect(plain.clone().headers.get("content-type")).toBe("application/json");
  });

  test("clone is the only Request-returning member on the guarded object", () => {
    const guarded = cookieTrappedRequest(withCookie(), () => undefined);
    // Body readers return data, not a Request, so they cannot leak headers.
    for (const member of ["text", "json", "arrayBuffer", "formData", "blob"]) {
      expect(typeof (guarded as unknown as Record<string, unknown>)[member]).toBe("function");
    }
    expect(typeof guarded.clone).toBe("function");
  });
});

describe("a refusal must be an exact refusal", () => {
  test("PLANTED: a 500 is never accepted as a refusal", () => {
    // `status !== 200` accepted every server error, so a wholly broken harness
    // reported a clean sweep of refusals.
    for (const status of [500, 502, 503, 504]) {
      const verdict = classifyRefusal(
        status,
        { code: "S6_FORCED_STATUS" },
        EXPECTED_REFUSAL.unauthorized,
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.detail).toContain("server error");
    }
  });

  test("PLANTED: the wrong 4xx status or the wrong code is refused", () => {
    expect(classifyRefusal(404, { code: "UNAUTHORIZED" }, EXPECTED_REFUSAL.unauthorized).ok).toBe(
      false,
    );
    expect(
      classifyRefusal(401, { code: "WRONG_PRINCIPAL" }, EXPECTED_REFUSAL.unauthorized).ok,
    ).toBe(false);
    expect(classifyRefusal(401, {}, EXPECTED_REFUSAL.unauthorized).ok).toBe(false);
    expect(classifyRefusal(200, { ok: true }, EXPECTED_REFUSAL.unauthorized).ok).toBe(false);
  });

  test("the exact expected refusal is accepted", () => {
    expect(classifyRefusal(401, { code: "UNAUTHORIZED" }, EXPECTED_REFUSAL.unauthorized).ok).toBe(
      true,
    );
    expect(
      classifyRefusal(403, { code: "WRONG_PRINCIPAL" }, EXPECTED_REFUSAL.wrongPrincipal).ok,
    ).toBe(true);
  });

  test("every refusal assertion goes through the exact-refusal helper", () => {
    // Comments stripped: this is about what the checker *does*. The rule is not
    // "the string `status !== 200` never appears" — one legitimate use remains,
    // asserting that exactly one of a concurrent pair was accepted, whose
    // refusal quality is then asserted separately by `checkRefusal`. The rule
    // is that no assertion *named* for a refusal may use the loose form.
    const lines = code(CHECKER).split("\n");
    const loose = lines.filter(
      (line) => /\bcheck\(/.test(line) && !/checkRefusal\(/.test(line) && /refused/.test(line),
    );
    expect(loose).toEqual([]);
    expect(code(CHECKER)).toContain("checkRefusal(");
    expect(code(CHECKER)).toContain("EXPECTED_REFUSAL");
  });

  test("the cookie-on-agent probe actually presents a Cookie", () => {
    const checker = read(CHECKER);
    const block = checker.slice(
      checker.indexOf("a_cookie_on_the_agent_write_route_is_wrong_principal") - 1200,
      checker.indexOf("the_presented_cookie_is_never_echoed_by_the_principal_route"),
    );
    // A probe named for a cookie must carry one, and assert the exact reason.
    expect(block).toContain("headers: { cookie:");
    expect(block).toContain('"no_credential"');
    expect(block).toContain("WRONG_PRINCIPAL");
  });
});

describe("the forEach callback's parent argument is the guarded proxy", () => {
  const withCookie = (): Request =>
    new Request("https://a.asimposium.org/__s6/ingress", {
      method: "POST",
      headers: {
        cookie: "__Host-authjs.session-token=PARENT_ARG_CANARY",
        "content-type": "application/json",
      },
      body: "{}",
    });

  /**
   * `Headers.forEach` hands its callback three arguments: value, name, and the
   * Headers object being iterated. That third one is a full, independent handle
   * -- and if the proxy passes the *real* target there, every guard above it is
   * decorative. A consumer writes the most ordinary line imaginable,
   * `headers.forEach((_v, _n, parent) => parent.get("cookie"))`, and reads the
   * session token with the canary still reporting zero.
   *
   * These are planted: each one failed against the pre-fix proxy, returning the
   * cookie value verbatim.
   */
  const parentReads: ReadonlyArray<[string, (parent: Headers) => unknown]> = [
    ["get", (parent) => parent.get("cookie")],
    ["has", (parent) => parent.has("cookie")],
    [
      "a nested forEach",
      (parent) => {
        const yielded: string[] = [];
        parent.forEach((value, name) => {
          yielded.push(`${name}=${value}`);
        });
        return yielded;
      },
    ],
    [
      "the iterator",
      (parent) => {
        return [...(parent as unknown as Iterable<[string, string]>)];
      },
    ],
  ];

  for (const [label, read] of parentReads) {
    test(`PLANTED: reaching the cookie through the callback parent via ${label} trips the canary`, () => {
      let reads = 0;
      const guarded = cookieTrappedRequest(withCookie(), () => {
        reads += 1;
      });
      let leaked: unknown;
      expect(() => {
        guarded.headers.forEach((_value, _name, parent) => {
          // Two realms name `Headers`: this package's ambient Workers types and
          // undici's, which Bun's `fetch` types resolve to. The two-step cast is
          // the repository's existing spelling for that mismatch.
          leaked = read(parent as unknown as Headers);
        });
      }).toThrow("S6_COOKIE_READ_ON_AGENT_HOST");
      // The old false-green test assigned a constant and never captured the
      // callback result. A raw callback parent returns the canary here before
      // the outer iterator reaches Cookie and throws.
      expect(leaked).toBeUndefined();
      expect(reads).toBeGreaterThan(0);
    });

    test(`PLANTED: the same reach through a clone's callback parent trips the canary`, () => {
      let reads = 0;
      const guarded = cookieTrappedRequest(withCookie(), () => {
        reads += 1;
      });
      const cloned = guarded.clone();
      let leaked: unknown;
      expect(() => {
        cloned.headers.forEach((_value, _name, parent) => {
          leaked = read(parent as unknown as Headers);
        });
      }).toThrow("S6_COOKIE_READ_ON_AGENT_HOST");
      expect(leaked).toBeUndefined();
      expect(reads).toBeGreaterThan(0);
    });
  }

  test("the callback parent still serves an ordinary header normally", () => {
    // No cookie on this one: `forEach` over cookie-bearing headers trips the
    // trap while *reaching* the cookie, which is the point of the cases above.
    // What must still work is the ordinary path -- the guard is a cookie guard,
    // not a general obstruction, and a proxy that broke every header read would
    // pass every leak assertion while making the harness useless.
    let reads = 0;
    const guarded = cookieTrappedRequest(
      new Request("https://a.asimposium.org/__s6/ingress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      () => {
        reads += 1;
      },
    );
    const seen: string[] = [];
    guarded.headers.forEach((_value, name, parent) => {
      if (name === "content-type") seen.push(String(parent.get("content-type")));
    });
    expect(seen).toEqual(["application/json"]);
    expect(reads).toBe(0);
  });

  test("the cookie header is not yielded to the callback in the first place", () => {
    const guarded = cookieTrappedRequest(withCookie(), () => undefined);
    const names: string[] = [];
    try {
      guarded.headers.forEach((_value, name) => {
        names.push(name);
      });
    } catch {
      // the trap fires on reaching `cookie`; whatever was yielded before it counts
    }
    expect(names).not.toContain("cookie");
    expect(names.join(",")).not.toContain("PARENT_ARG_CANARY");
  });
});

describe("localFetch never carries a signed envelope to a second origin", () => {
  /**
   * A redirect is the one way a correct-looking checker sends real credentials
   * somewhere it never validated. `S6_ORIGIN` is checked to be loopback, but
   * that check happens once, before any request; `fetch` defaults to
   * `redirect: "follow"`, so a 302 makes the *runtime* re-issue the request --
   * same headers, same envelope -- against whatever `Location` names. The origin
   * validation would have passed and the assertion would still report against a
   * response from a host nobody approved.
   *
   * This runs two real listeners. The second one records everything it is ever
   * asked for, and must record nothing.
   */
  test("PLANTED: a 302 is returned as-is and the redirect target is never contacted", async () => {
    const received: string[] = [];
    const second = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const envelope = request.headers.get("x-asimposium-envelope") ?? "(none)";
        received.push(`${request.method} ${new URL(request.url).pathname} envelope=${envelope}`);
        return new Response("second origin answered", { status: 200 });
      },
    });
    const first = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${second.port}/__s6/ingress` },
        });
      },
    });

    try {
      const response = await localFetch(`http://127.0.0.1:${first.port}/__s6/ingress`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-asimposium-envelope": "SIGNED_ENVELOPE_MUST_NOT_TRAVEL",
        },
        body: '{"claim":"redirect"}',
      });

      // The redirect is data, not an instruction to be followed.
      expect(response.status).toBe(302);
      expect(await response.text()).not.toContain("second origin answered");
    } finally {
      first.stop(true);
      second.stop(true);
    }

    // The whole point: the signed request never reached the second origin.
    expect(received).toEqual([]);
  });

  test("localFetch pins redirect handling after the caller's init", () => {
    // Comment-stripped on purpose. Read raw, this assertion is satisfied by the
    // prose above the call explaining why `redirect: "manual"` is set -- so
    // deleting the actual line would leave the test green. It caught exactly
    // that during mutation testing.
    const checker = code(CHECKER);
    const body = checker.slice(checker.indexOf("export async function localFetch"));
    const spread = body.indexOf("...init");
    const manual = body.indexOf('redirect: "manual"');
    const signal = body.indexOf("AbortSignal.timeout");
    expect(spread).toBeGreaterThan(-1);
    // Before the spread, a caller passing `redirect: "follow"` silently wins.
    expect(manual).toBeGreaterThan(spread);
    expect(signal).toBeGreaterThan(spread);
  });
});

describe("restart persistence retains envelope state in one stopped checker", () => {
  const checker = code(CHECKER);
  const script = read(SCRIPT);

  test("PLANTED: no credential handoff path or filesystem primitive remains", () => {
    for (const forbidden of [
      "S6_STATE_DIR",
      "HANDOFF_",
      "persist-mint",
      "persist-replay",
      "readFileSync",
      "writeFileSync",
      "openSync",
    ]) {
      expect(checker).not.toContain(forbidden);
    }
    expect(script).toContain("export S6_PUBLIC_KEY_HEX S6_PRIVATE_KEY_JWK S6_KID S6_NOW");
    expect(script).not.toContain("env S6_PRIVATE_KEY_JWK=");
  });

  test("PLANTED: the signing key is bootstrap environment only, never phase handoff state", () => {
    const start = script.slice(
      script.indexOf("start_restart_checker()"),
      script.indexOf("resume_restart_checker()"),
    );
    expect(checker).toContain("loadSigningKey(process.env.S6_PRIVATE_KEY_JWK)");
    expect(script).toContain("export S6_PUBLIC_KEY_HEX S6_PRIVATE_KEY_JWK S6_KID S6_NOW");
    expect(start).not.toContain("S6_PRIVATE_KEY_JWK=");
    expect(start).not.toContain("env S6_PRIVATE_KEY_JWK");
    expect(script).toContain("never used as phase handoff");
  });

  test("PLANTED: one checker stops with the spent envelope then proves both replay and fresh acceptance", () => {
    const accepted = checker.indexOf("an_in_memory_envelope_is_accepted_before_restart");
    const stopped = checker.indexOf("restart_checker_stopped_with_spent_envelope");
    const stop = checker.indexOf('process.kill(process.pid, "SIGSTOP")', stopped);
    const replay = checker.indexOf("the_same_in_memory_envelope_is_refused_after_a_worker_restart");
    const fresh = checker.indexOf("a_new_valid_envelope_is_accepted_after_a_worker_restart");
    expect(accepted).toBeGreaterThan(-1);
    expect(stopped).toBeGreaterThan(accepted);
    expect(stop).toBeGreaterThan(stopped);
    expect(replay).toBeGreaterThan(stop);
    expect(fresh).toBeGreaterThan(replay);
    expect(checker).toContain("the_post_restart_envelope_is_distinct_from_the_replayed_envelope");
  });

  test("PLANTED: restart proof does not clone a second verifier", () => {
    expect(checker).not.toContain("VerificationKeyring");
    expect(checker).not.toContain("parseEnvelope");
    expect(checker).not.toContain("verifyRestartHandoff");
  });

  test("PLANTED: the phase record is emitted before the uncatchable stop", () => {
    const stopped = checker.indexOf("restart_checker_stopped_with_spent_envelope");
    expect(stopped).toBeGreaterThan(-1);
    expect(stopped).toBeLessThan(checker.indexOf('process.kill(process.pid, "SIGSTOP")', stopped));
  });

  test("PLANTED: the phase record carries no dynamic credential field", () => {
    const block = checker.slice(
      checker.indexOf("restart_checker_stopped_with_spent_envelope"),
      checker.indexOf('process.kill(process.pid, "SIGSTOP")'),
    );
    for (const forbidden of ["signature", "nonce", "privateKey", "oldBody"]) {
      expect(block).not.toContain(forbidden);
    }
  });

  test("PLANTED: the shell accepts a phase only with the exact safe shape", () => {
    expect(script).toContain("const expectedKeys");
    expect(script).toContain('expected_assertion="restart_checker_stopped_with_spent_envelope"');
    expect(script).toContain(
      'expected_detail="one accepted envelope remains only in this checker process memory"',
    );
  });

  test("PLANTED: pre-migration refusal, migration, restart, and held-envelope replay are ordered", () => {
    const checkerPhase = checker.slice(
      checker.indexOf('if (PHASE === "pre-migration")'),
      checker.indexOf('if (PHASE === "retention")'),
    );
    const shellPhase = script.slice(
      script.indexOf("# ── pre-migration replay-store refusal"),
      script.indexOf("# ── cross-clock nonce retention"),
    );
    const unavailable = checkerPhase.indexOf("EXPECTED_REFUSAL.replayStoreUnavailable");
    const stopped = checkerPhase.indexOf("pre_migration_checker_stopped_with_held_envelope");
    const stop = checkerPhase.indexOf('process.kill(process.pid, "SIGSTOP")');
    const accepted = checkerPhase.indexOf(
      "the_same_held_envelope_is_accepted_after_real_migrations_and_restart",
    );
    const replayed = checkerPhase.indexOf(
      "the_same_held_envelope_is_refused_on_its_second_post_migration_presentation",
    );
    expect(unavailable).toBeGreaterThan(-1);
    expect(stopped).toBeGreaterThan(unavailable);
    expect(stop).toBeGreaterThan(stopped);
    expect(accepted).toBeGreaterThan(stop);
    expect(replayed).toBeGreaterThan(accepted);
    expect(checkerPhase).toContain("EXPECTED_REFUSAL.unauthorized");
    expect(shellPhase).toContain("AUTH_REPLAY_STORE_UNAVAILABLE");
    const start = shellPhase.indexOf("if ! start_worker; then");
    const checkerStart = shellPhase.indexOf('start_restart_checker "pre-migration" "unavailable"');
    const stopBeforeMigration = shellPhase.indexOf("if ! stop_worker; then", checkerStart);
    const migrate = shellPhase.indexOf("apply_local_d1_migrations");
    const restart = shellPhase.indexOf("if ! start_worker; then", migrate);
    const resume = shellPhase.indexOf("resume_restart_checker", restart);
    expect(start).toBeGreaterThan(-1);
    expect(checkerStart).toBeGreaterThan(start);
    expect(stopBeforeMigration).toBeGreaterThan(checkerStart);
    expect(migrate).toBeGreaterThan(stopBeforeMigration);
    expect(restart).toBeGreaterThan(migrate);
    expect(resume).toBeGreaterThan(restart);
  });

  test("PLANTED: cross-clock retention uses fresh workers and exact causal order", () => {
    const checkerPhase = checker.slice(
      checker.indexOf('if (PHASE === "retention")'),
      checker.indexOf('if (PHASE === "restart")'),
    );
    const shellPhase = script.slice(
      script.indexOf("# ── cross-clock nonce retention"),
      script.indexOf("# Restore the ordinary checker clock"),
    );
    const original = checkerPhase.indexOf(
      "the_original_nonce_is_accepted_by_the_slow_worker_at_exp_plus_skew",
    );
    const fast = checkerPhase.indexOf(
      "the_fresh_fast_envelope_triggers_real_d1_cleanup_at_exp_plus_three_skew",
    );
    const slowReplay = checkerPhase.indexOf(
      "the_original_nonce_is_exactly_replayed_by_the_fresh_slow_worker_at_exp_plus_skew",
    );
    const boundary = checkerPhase.indexOf(
      "the_same_nonce_is_accepted_once_after_the_exclusive_expiry_boundary",
    );
    const boundaryReplay = checkerPhase.indexOf(
      "the_same_nonce_is_refused_after_its_post_expiry_boundary_acceptance",
    );
    expect(original).toBeGreaterThan(-1);
    expect(fast).toBeGreaterThan(original);
    expect(slowReplay).toBeGreaterThan(fast);
    expect(boundary).toBeGreaterThan(slowReplay);
    expect(boundaryReplay).toBeGreaterThan(boundary);
    expect(checkerPhase).toContain("EXPECTED_REFUSAL.unauthorized");
    expect(checkerPhase).toContain("fastNow + 1");
    expect(checkerPhase).toContain("originalEnvelope.claims.nonce");
    expect(shellPhase).toContain('WORKER_NOW="${RETENTION_FAST_NOW}"');
    expect(shellPhase).toContain(
      "WORKER_NOW=$((S6_NOW + ENVELOPE_LIFETIME_SECONDS + 3 * CLOCK_SKEW_SECONDS + 1))",
    );
    const originalStart = shellPhase.indexOf('start_restart_checker "retention" "original"');
    const fastStart = shellPhase.indexOf("if ! start_worker; then", originalStart);
    const fastResume = shellPhase.indexOf('resume_restart_checker_until_stopped "fast-cleanup"');
    const slowStart = shellPhase.indexOf("if ! start_worker; then", fastResume);
    const slowResume = shellPhase.indexOf('resume_restart_checker_until_stopped "slow-replay"');
    const boundaryStart = shellPhase.indexOf("if ! start_worker; then", slowResume);
    const boundaryResume = shellPhase.indexOf("resume_restart_checker\n", boundaryStart);
    expect(originalStart).toBeGreaterThan(-1);
    expect(fastStart).toBeGreaterThan(originalStart);
    expect(fastResume).toBeGreaterThan(fastStart);
    expect(slowStart).toBeGreaterThan(fastResume);
    expect(slowResume).toBeGreaterThan(slowStart);
    expect(boundaryStart).toBeGreaterThan(slowResume);
    expect(boundaryResume).toBeGreaterThan(boundaryStart);
  });

  test("PLANTED: real D1 cleanup removes a separately seeded expired row before nonce reuse", () => {
    const seedPhase = checker.slice(
      checker.indexOf('if (PHASE === "retention-seed")'),
      checker.indexOf('if (PHASE === "pre-migration")'),
    );
    expect(seedPhase).toContain("lifetimeSeconds: 1");
    expect(seedPhase).toContain('nonce: "c".repeat(43)');
    expect(seedPhase).toContain("seedEnvelope.claims.exp === NOW + 1");
    expect(seedPhase).toContain(
      "the_cleanup_seed_nonce_is_persisted_through_the_real_worker_ingress",
    );

    const query = script.slice(
      script.indexOf("assert_expired_nonce_row_count()"),
      script.indexOf("# ── cleanup survivors"),
    );
    expect(query).toContain(
      "SELECT COUNT(*) AS expired_count FROM auth_envelope_nonces WHERE expires_at <= ${observed_at};",
    );
    expect(query).toContain('--persist-to "${STATE_DIR}" --json');
    expect(query).toContain("constants.O_RDONLY | constants.O_NOFOLLOW");
    expect(query).toContain('new TextDecoder("utf-8", { fatal: true })');
    expect(query).toContain("localD1ExpiredCountMatches(JSON.parse(text), expected)");

    const shellPhase = script.slice(
      script.indexOf("# Seed one short-lived nonce"),
      script.indexOf("# Restore the ordinary checker clock"),
    );
    const seed = shellPhase.indexOf('run_checker "retention-seed"');
    const present = shellPhase.indexOf(
      'assert_expired_nonce_row_count "${RETENTION_FAST_NOW}" 1 "before-fast-cleanup"',
    );
    const original = shellPhase.indexOf('start_restart_checker "retention" "original"');
    const cleanup = shellPhase.indexOf('resume_restart_checker_until_stopped "fast-cleanup"');
    const absent = shellPhase.indexOf(
      'assert_expired_nonce_row_count "${RETENTION_FAST_NOW}" 0 "after-fast-cleanup"',
    );
    const reuse = shellPhase.indexOf('resume_restart_checker_until_stopped "slow-replay"');
    expect(seed).toBeGreaterThan(-1);
    expect(present).toBeGreaterThan(seed);
    expect(original).toBeGreaterThan(present);
    expect(cleanup).toBeGreaterThan(original);
    expect(absent).toBeGreaterThan(cleanup);
    expect(reuse).toBeGreaterThan(absent);

    const retentionPhase = checker.slice(
      checker.indexOf('if (PHASE === "retention")'),
      checker.indexOf('if (PHASE === "restart")'),
    );
    expect(retentionPhase).toContain('nonce: "o".repeat(43)');
    expect(retentionPhase).toContain(
      "freshEnvelope.claims.nonce !== originalEnvelope.claims.nonce",
    );
  });

  test("PLANTED: persisted cleanup count accepts only Wrangler's exact result shape", () => {
    const valid = [
      {
        results: [{ expired_count: 1 }],
        success: true,
        meta: { duration: 0.25 },
      },
    ];
    expect(localD1ExpiredCountMatches(valid, 1)).toBe(true);
    expect(
      localD1ExpiredCountMatches([{ results: [{ expired_count: 1 }], success: true, meta: {} }], 1),
    ).toBe(true);

    const malformed: unknown[] = [
      [],
      [valid[0], valid[0]],
      [{ ...valid[0], extra: true }],
      [{ ...valid[0], success: false }],
      [{ ...valid[0], results: [] }],
      [{ ...valid[0], results: [{ expired_count: 1 }, { expired_count: 1 }] }],
      [{ ...valid[0], results: [{ expired_count: 1, extra: true }] }],
      [{ ...valid[0], results: [{ expired_count: 1.5 }] }],
      [{ ...valid[0], results: [{ expired_count: "1" }] }],
      [{ ...valid[0], meta: { duration: -1 } }],
      [{ ...valid[0], meta: { duration: Number.NaN } }],
      [{ ...valid[0], meta: { duration: 0.25, extra: true } }],
    ];
    for (const value of malformed) expect(localD1ExpiredCountMatches(value, 1)).toBe(false);
    expect(localD1ExpiredCountMatches(valid, 0)).toBe(false);
    expect(localD1ExpiredCountMatches(valid, -1)).toBe(false);
    expect(localD1ExpiredCountMatches(valid, 1.5)).toBe(false);
  });

  test("PLANTED: stopped-checker coordination observes a stopped process state", () => {
    const block = script.slice(
      script.indexOf("start_restart_checker()"),
      script.indexOf("resume_restart_checker()"),
    );
    expect(block).toContain('ps -o stat= -p "${RESTART_CHECKER_PID}"');
    expect(block).toContain('"${state}" == *T*');
    expect(block).toContain("CHECK_DEADLINE_SECONDS");
  });

  test("PLANTED: the restart checker is pinned by birth time and argv before direct signals", () => {
    const checkerStart = script.slice(
      script.indexOf("start_restart_checker()"),
      script.indexOf("resume_restart_checker()"),
    );
    const checkerStop = script.slice(
      script.indexOf("direct_child_identity_is_exact()"),
      script.indexOf("cleanup_and_verify()"),
    );
    expect(checkerStart).toContain('S6_RESTART_CHECKER_TOKEN="${RESTART_CHECKER_TOKEN}"');
    expect(checkerStart).toContain('"s6-restart-checker:${RESTART_CHECKER_TOKEN}"');
    expect(checkerStop).toContain("ps -o lstart=");
    expect(checkerStop).toContain("s6-restart-checker:");
    expect(checkerStop).toContain(
      'direct_child_identity_is_exact "${pid}" "${started_at}" "${marker}"',
    );
    expect(checkerStop).toContain("sent no signal");
  });

  test("PLANTED: aborted coordination resumes then bounds checker cleanup", () => {
    const block = script.slice(
      script.indexOf("stop_exact_direct_child()"),
      script.indexOf("clear_restart_checker_identity()"),
    );
    expect(block).toContain('kill -CONT "${pid}"');
    expect(block).toContain('kill -TERM "${pid}"');
    expect(block).toContain('kill -KILL "${pid}"');
  });

  test("PLANTED: the pinned supervisor stops before it executes Wrangler", () => {
    const block = script.slice(
      script.indexOf("launch_pinned_supervisor()"),
      script.indexOf("resume_pinned_supervisor()"),
    );
    expect(block.indexOf('kill -STOP "$$"')).toBeLessThan(block.indexOf('"$@" &'));
    expect(block.indexOf("set +m")).toBeLessThan(block.indexOf('"$@" &'));
  });

  test("PLANTED: the supervisor survives group TERM and has an explicit release", () => {
    const block = script.slice(
      script.indexOf("launch_pinned_supervisor()"),
      script.indexOf("resume_pinned_supervisor()"),
    );
    expect(block).toContain('trap ":" TERM INT HUP');
    expect(block).toContain('trap "exit 0" USR1');
  });

  test("PLANTED: supervisor identity binds pid, pgid, birth time, and marker", () => {
    const block = script.slice(
      script.indexOf("supervisor_identity_is_exact()"),
      script.indexOf("launch_pinned_supervisor()"),
    );
    expect(block).toContain("ps -o lstart=");
    expect(block).toContain("ps -ww -o command=");
    expect(block).toContain("s6-pinned-supervisor:");
  });

  test("PLANTED: the exact pinned supervisor is required before every group signal", () => {
    const block = script.slice(script.indexOf("stop_group() {"), script.indexOf("stop_worker() {"));
    const term = block.indexOf('kill -TERM "-${pgid}"');
    const kill = block.indexOf('kill -KILL "-${pgid}"');
    expect(block.lastIndexOf("supervisor_identity_is_exact", term)).toBeLessThan(term);
    expect(block.lastIndexOf("supervisor_identity_is_exact", kill)).toBeLessThan(kill);
  });

  test("PLANTED: empty lsof cannot green an occupied port", () => {
    expect(script).toContain("lsof() { return 1; }; run_inspection");
    expect(script).toContain("port_accepts_bind()");
    expect(script).toContain("listener_bind_proves_port_released");
  });

  test("PLANTED: state-directory FD inspection fails closed and narrows its claim", () => {
    expect(script).toContain('lsof -t +D "${STATE_DIR}"');
    expect(script).toContain("LIFECYCLE_LSOF_UNAVAILABLE");
    expect(script).toContain("arbitrary daemon containment is not claimed");
  });

  test("PLANTED: the SIGTERM self-test uses production stop_group through stop_worker", () => {
    const block = script.slice(
      script.indexOf('sigterm_pgid="${SERVER_PGID}"'),
      script.indexOf(
        "if ! cleanup_and_verify; then",
        script.indexOf('sigterm_pgid="${SERVER_PGID}"'),
      ),
    );
    expect(block).toContain("if ! stop_worker; then");
    expect(block).not.toContain('kill -TERM "-${sigterm_pgid}"');
  });

  test("PLANTED: the shell observes the safe stop, restarts workerd, resumes, and bounds cleanup", () => {
    expect(script).toContain("start_restart_checker()");
    expect(script).toContain("restart_checker_phase_is_safe_and_recorded()");
    expect(script).toContain('kill -CONT "${RESTART_CHECKER_PID}"');
    expect(script).toContain("stop_restart_checker()");
    expect(script).toContain("restart_checker_cleanup");
    expect(script.indexOf("if ! start_restart_checker; then")).toBeLessThan(
      script.indexOf("if ! stop_worker; then", script.indexOf("if ! start_restart_checker; then")),
    );
  });

  test("PLANTED: exact marker and lstart are mandatory before every direct-PID signal", () => {
    const cleanup = script.slice(
      script.indexOf("stop_exact_direct_child()"),
      script.indexOf("clear_restart_checker_identity()"),
    );
    for (const signal of ["CONT", "TERM", "KILL"]) {
      const send = cleanup.indexOf(`kill -${signal} "\${pid}"`);
      expect(send).toBeGreaterThan(-1);
      expect(cleanup.lastIndexOf("direct_child_identity_is_exact", send)).toBeLessThan(send);
    }
    expect(cleanup).not.toContain("unreaped direct-child PID");
    expect(script).toContain("reused_direct_pid_is_never_signalled");
    expect(script).toContain("persistent_identity_inspection_fails_closed");
  });

  test("PLANTED: the finalizer owns every child class before survivor inspection", () => {
    const initialized = script.slice(0, script.indexOf("trap on_exit EXIT"));
    for (const owner of [
      "PROVISIONAL_SUPERVISOR_OWNED",
      "CHECKER_OWNED",
      "BUSY_SUPERVISOR_OWNED",
      "RESTART_CHECKER_PID",
      "SERVER_SUPERVISOR_PID",
      "NESTED_HARNESS_PID",
    ]) {
      expect(initialized).toContain(`${owner}=`);
    }
    const cleanup = script.slice(
      script.indexOf("cleanup_and_verify()"),
      script.indexOf("cleanup_with_retry()"),
    );
    for (const stop of [
      "stop_nested_harness",
      "stop_checker",
      "stop_restart_checker",
      "stop_busy_contender",
      "stop_worker",
      "reap_provisional_supervisor",
    ]) {
      expect(cleanup).toContain(`if ! ${stop}`);
    }
    expect(script).not.toMatch(
      /stop_(?:nested_harness|worker|checker|restart_checker|busy_contender)[^\n]*\|\| true/,
    );
  });

  test("PLANTED: post-resume inspection failure consumes one immutable deadline", () => {
    const resume = script.slice(
      script.indexOf("resume_restart_checker()"),
      script.indexOf("run_checker\n"),
    );
    const deadline = resume.indexOf(
      'deadline="$(deadline_after_work "${CHECK_DEADLINE_SECONDS}")"',
    );
    const continued = resume.indexOf('kill -CONT "${RESTART_CHECKER_PID}"');
    expect(deadline).toBeGreaterThan(-1);
    expect(deadline).toBeLessThan(continued);
    expect(
      resume.match(/deadline="\$\(deadline_after_work "\$\{CHECK_DEADLINE_SECONDS\}"\)"/g)?.length,
    ).toBe(1);
    expect(resume).toContain("TEST_RESTART_INSPECTION_FAILURES_REMAINING");
    expect(resume).toContain("post_resume_inspection_failure_is_bounded");
    expect(resume).toContain("if direct_child_is_gone");
    expect(script).toContain("wedged_restart_checker_is_bounded");
  });

  test("the self-test has a conventional machine-readable success contract", () => {
    expect(script).toContain("self_test_complete");
    expect(script).toContain("mode");
    expect(script).toContain("self-test");
    expect(script).toContain("exit_code");
    const selfTestEnd = script.slice(script.indexOf("self_test_complete"));
    expect(selfTestEnd).toMatch(/exit 0\nfi/);
    expect(script).toContain("expected_negative");
    // Normal mode still terminates at the explicit deployed blocker.
    expect(script).toContain('exit "${BLOCKED_EXIT}"');
  });

  test("the local workerd/D1 self-test is an integration preflight, not a security-suite cost", () => {
    const suites = read(SUITES);
    const security = suites.slice(suites.indexOf("security:"), suites.indexOf("integration:"));
    const integration = suites.slice(
      suites.indexOf("integration:"),
      suites.indexOf("performance:"),
    );
    expect(security).toContain('dirs: ["test/security"]');
    expect(security).not.toContain("test/auth");
    expect(integration).toContain('status: "pending"');
    expect(integration).toContain("preflight:");
    expect(integration).toContain('dirs: ["test/auth"]');
    expect(integration).toContain('file: "test/integration/s2-krater-real-bindings.test.ts"');
    expect(integration).toContain('code: "S2_REAL_BINDING_PROOF_BLOCKED"');
    expect(integration).toContain("2x660-second lifecycle lane is not run");
    // The downstream verdict is blocked, but the diagnostic must not erase
    // the Bun preflight that really ran before it.
    expect(suites).toContain('tool: suite.preflight === undefined ? "none" : "bun test"');
    expect(suites).toContain("preflight_covers: preflightCovers");
    expect(suites).toContain("preflight_blocked_code: suite.preflight?.expectedBlocked?.code");
    expect(suites).toContain("records.length !== 1");
    expect(suites).toContain("JSON.parse(candidate) as Record<string, unknown>");
    expect(suites).toContain('record.status !== "blocked"');
    expect(suites).toContain('record.suite !== "s2-krater-real-bindings"');
  });

  test(
    "the local shell self-test is executed as a bounded automatic gate",
    async () => {
      expect(
        SHELL_SELF_TEST_INNER_BUDGET_MS +
          SHELL_SELF_TEST_TERM_GRACE_MS +
          SHELL_SELF_TEST_KILL_GRACE_MS +
          SHELL_SELF_TEST_STREAM_DRAIN_MS,
      ).toBeLessThan(SHELL_SELF_TEST_TIMEOUT_MS);
      const shellSource = code(SCRIPT);
      expect(shellSource).toContain("readonly SCRIPT_TOTAL_DEADLINE_SECONDS=210");
      expect(shellSource).toContain("readonly SCRIPT_CLEANUP_RESERVE_SECONDS=30");
      expect(210_000).toBeLessThan(SHELL_SELF_TEST_INNER_BUDGET_MS);
      const selfTest = startShellSelfTest();
      try {
        const { exitCode, stdout, stderr } = await selfTest.result();
        expect(exitCode).toBe(0);
        // A fail record is invalid on either stream. The self-test normally
        // emits records on stdout, but error paths may emit diagnostics on stderr.
        expect(stdout).not.toMatch(FAIL_STATUS_RECORD);
        expect(stderr).not.toMatch(FAIL_STATUS_RECORD);
        const records = stdout
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(
          records.some(
            (record) =>
              record.assertion ===
                "group_members_parser_rejects_malformed_truncated_and_unreadable_tables" &&
              record.status === "expected_negative",
          ),
        ).toBe(true);
        for (const assertion of [
          "process_table_parser_rejects_malformed_row",
          "process_table_parser_rejects_truncated_row",
          "group_members_parser_rejects_malformed_table",
          "group_members_parser_rejects_truncated_table",
        ]) {
          expect(
            records.some(
              (record) => record.assertion === assertion && record.status === "expected_negative",
            ),
          ).toBe(true);
        }
        for (const window of [
          "provisional_supervisor",
          "ordinary_checker",
          "restart_checker",
          "worker",
          "busy_contender",
        ]) {
          expect(
            records.some(
              (record) =>
                record.assertion === `finalizer_owns_${window}` &&
                record.status === "expected_negative",
            ),
          ).toBe(true);
        }
        expect(
          records.some(
            (record) =>
              record.assertion === "lifecycle_lsof_unavailable_is_blocked" &&
              record.status === "pass",
          ),
        ).toBe(true);
        expect(
          records.some(
            (record) =>
              record.assertion === "self_test_complete" &&
              record.status === "pass" &&
              record.mode === "self-test" &&
              record.exit_code === 0,
          ),
        ).toBe(true);
      } finally {
        await selfTest.cleanup();
      }
    },
    SHELL_SELF_TEST_TIMEOUT_MS,
  );
});
