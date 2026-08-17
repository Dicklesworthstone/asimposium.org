// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this suite asserts on the
// text of a bash script, where `${VAR}` is the shell expansion being checked, not a
// JavaScript template placeholder. Rewriting them would stop the assertions matching
// the source they exist to pin.

/**
 * S-6 DEPLOYED-spike harness invariants (bead asimposiumorg-vw3).
 *
 * `scripts/e2e-s6-cross-plane-auth.sh` and `e2e/playwright/s6-cross-plane-runner.ts`
 * are the only runners allowed to claim the cross-plane seam works against real
 * infrastructure. They cannot be executed here — by construction they need a
 * Vercel preview, a deployed Worker, and a real Google account.
 *
 * An earlier revision of this suite was rejected for asserting with broad
 * substring greps over the whole file, which pass for the wrong reasons and
 * cannot tell a real guard from the same words in a comment. This revision:
 *
 *   - slices each assertion to the FUNCTION that must contain it;
 *   - executes the shell's causal self-tests instead of describing them;
 *   - proves its own teeth with a mutation: deleting a required `exit` must
 *     make a test fail, or the test was never load-bearing.
 */

import { describe, expect, test } from "bun:test";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..", "..", "..");
const read = (relative: string): string => readFileSync(resolve(root, relative), "utf8");

/** Strip comments: a guard must be code, never the prose describing a guard. */
const code = (relative: string): string =>
  read(relative)
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");

const SCRIPT = "scripts/e2e-s6-cross-plane-auth.sh";
const RUNNER = "e2e/playwright/s6-cross-plane-runner.ts";
const SHELL_TIMEOUT_MS = 120_000;

/**
 * The body of one shell function, from `name() {` to the first line that is
 * exactly `}`. Slicing to the function is what makes an assertion mean "this
 * guard is in the code path", rather than "these characters exist somewhere".
 */
function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`shell function not found: ${name}`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  if (end === -1) throw new Error(`unterminated shell function: ${name}`);
  return rest.slice(0, end);
}

/** Hard ceiling on captured bytes, so a runaway child cannot exhaust memory. */
const MAX_CAPTURE_BYTES = 1_048_576;
/** One absolute bound per child, independent of any assertion timeout. */
const RUN_TIMEOUT_MS = 100_000;

class OverCapture extends Error {}

/**
 * Bounded read of a capture file. Never deletes.
 *
 * An over-cap file is REJECTED rather than truncated: silently parsing a green
 * prefix of a runaway capture would let a test pass on the first megabyte of
 * output that went wrong after it.
 */
function readBounded(path: string): string {
  const size = statSync(path).size;
  if (size > MAX_CAPTURE_BYTES) {
    throw new OverCapture(`capture exceeded ${MAX_CAPTURE_BYTES} bytes (${size})`);
  }
  if (size === 0) return "";
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(size);
    const read = readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

interface ShellRun {
  readonly exitCode: number;
  readonly stdout: string;
  /** Diagnostics only. Never asserted on: the contract is the stdout NDJSON. */
  readonly stderr: string;
  readonly timedOut: boolean;
  /** True if anything remained in the child's process group after the census. */
  readonly survivors: boolean;
  /**
   * True when the run had to be hard-killed, so its nested process groups
   * cannot be shown to have been reaped.
   *
   * This is NOT a containment claim in either direction — it records that the
   * question is unanswerable for that run, because the script's trap was cut
   * short and this controller cannot see groups it does not lead.
   */
  readonly cleanupUnproven: boolean;
}

/**
 * Run the shell with FILE-BACKED capture rather than pipes.
 *
 * The previous implementation spawned with `stderr: "pipe"` and then awaited
 * only stdout and `exited`. Nothing ever drained stderr, so once the script's
 * human log filled the stderr pipe buffer the child blocked mid-write: under
 * `bun test` that surfaced as `--self-test` exiting 1 and the blocked case
 * returning 78 with an empty stdout, while the identical spawn under `bun -e`
 * and a direct `bash` run both passed. Pre-opened private files have no such
 * back-pressure, and they remove the Bun-under-Bun pipe transport from the path
 * entirely — the same failure class already seen in S3/environment.
 *
 * Capture files are mode 600 and are deliberately RETAINED (AGENTS.md forbids
 * cleanup-by-deletion); they hold harness output only, never a credential.
 */
async function runShell(
  args: readonly string[],
  env: Record<string, string | undefined>,
  script = SCRIPT,
): Promise<ShellRun> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-run-"));
  const stdoutPath = join(dir, "stdout");
  const stderrPath = join(dir, "stderr");
  // NO OWNERSHIP LEDGER, and no claim of zero-survivor containment.
  //
  // `set -m` puts each of the script's jobs in its own process group, so this
  // controller — which knows only the script's pgid — cannot reach them if the
  // script's trap is prevented from finishing. A pgid ledger was tried and
  // removed: bare pgids are not identity, so signalling from them risks killing a
  // recycled group, and censusing them is fail-open (a missing or unwritten row
  // hides a survivor, a recycled row invents one). Proving containment here would
  // need live nonce-bearing supervisors pinning each nested group, which this
  // pass does not build. The hard-kill path is therefore reported as
  // CLEANUP-UNPROVEN rather than described as contained.
  const stdoutFd = openSync(stdoutPath, "w", 0o600);
  const stderrFd = openSync(stderrPath, "w", 0o600);

  // TOTAL descriptor ownership, released exactly once.
  //
  // Holding the descriptors until the child exits fixed the lost-output race,
  // but on its own it leaked them on every abnormal path: a `Bun.spawn` throw, a
  // rejected `child.exited`, a census exception, or an `OverCapture` from the
  // reader. The `finally` below covers all of them, and the flag makes a double
  // release harmless.
  // Each descriptor is tracked separately and cleared ONLY after its close
  // actually succeeded. The previous shape set one flag before either close and
  // swallowed every error, so a real close refusal leaked silently while the
  // suite went green — and a stdout failure meant stderr was never retried.
  // EINTR is retried; anything else is aggregated and thrown so the test fails.
  let stdoutOpen = true;
  let stderrOpen = true;
  const releaseCaptureFds = (): void => {
    const failures: string[] = [];
    const close = (fd: number, label: string, clear: () => void): void => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          closeSync(fd);
          clear();
          return;
        } catch (error) {
          const code = (error as { code?: string })?.code;
          if (code === "EINTR") continue;
          if (code === "EBADF") {
            // Genuinely not open any more; that is a successful release.
            clear();
            return;
          }
          failures.push(`${label}: ${code ?? "unknown"}`);
          return;
        }
      }
      failures.push(`${label}: EINTR after 4 attempts`);
    };
    if (stdoutOpen) {
      close(stdoutFd, "stdout", () => {
        stdoutOpen = false;
      });
    }
    if (stderrOpen) {
      close(stderrFd, "stderr", () => {
        stderrOpen = false;
      });
    }
    if (failures.length > 0) {
      throw new Error(`capture descriptors could not be released: ${failures.join("; ")}`);
    }
  };

  try {
    // A REAL separate process group, so `child.pid` genuinely IS the pgid.
    //
    // `bash -c 'set -m; …'` did not do this: job control changes the groups of
    // the jobs that shell starts, not the group of the shell itself, so
    // `process.kill(-child.pid, …)` was addressing a group this process did not
    // lead — and the bare-pid fallback then fired, which after the reap can hit a
    // reused number. `setpgrp(0,0)` before `exec` makes the child a group leader
    // for real, and macOS has no `setsid(1)` to do it with.
    const child = Bun.spawn({
      cmd: [
        "/usr/bin/perl",
        "-e",
        "setpgrp(0,0) or die $!; exec @ARGV or die $!;",
        "bash",
        script,
        ...args,
      ],
      cwd: root,
      env: env as Record<string, string>,
      stdin: "ignore",
      stdout: stdoutFd,
      stderr: stderrFd,
    });
    // The parent's descriptors are held until the child has EXITED.
    //
    // Closing them immediately after `Bun.spawn` returned lost the child's output
    // entirely: some runs produced `stdout=0 stderr=0` while still exiting 0 or 78,
    // so every record assertion failed against empty captures and the exit code
    // looked correct. It is load-sensitive, which is why it surfaced on a loaded
    // machine first. Holding the descriptors costs nothing — these are regular
    // files read by size after exit, so no reader needs EOF.

    /** Is the child's group still present? */
    const groupAlive = (): boolean => {
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    /**
     * GROUP-ONLY. No bare-pid fallback: once the leader has been reaped its number
     * can belong to anything, and the fallback fired in exactly that window.
     */
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is gone. Nothing to signal, which is the correct outcome.
      }
    };

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        // TERM first so the script's own trap reaps its descendants, then KILL.
        // Only the group this controller leads is signalled; the script's nested
        // groups are outside its authority, which is why a hard-killed run is
        // reported as cleanup-unproven rather than contained.
        signalGroup("SIGTERM");
        killTimer = setTimeout(() => signalGroup("SIGKILL"), 2_000);
        killTimer.unref?.();
        resolve();
      }, RUN_TIMEOUT_MS);
    });

    await Promise.race([child.exited, deadline]);
    if (timer !== undefined) clearTimeout(timer);
    // Always reap, whether it exited on its own or was killed.
    const exitCode = await child.exited;
    // Cancel and drain the escalation timer. Leaving it armed meant a SIGKILL
    // could be delivered AFTER the reap, to whatever then held the number.
    if (killTimer !== undefined) clearTimeout(killTimer);

    // CENSUS ONLY. No signal is sent after the reap.
    //
    // Once `child.exited` has resolved, the leader is reaped and the kernel may
    // recycle the pgid — so a post-reap SIGKILL could land on an unrelated group
    // that merely inherited the number. Observation is still worth having and may
    // fail closed (a recycled group can make this report a survivor that is not
    // ours), but it cannot authorise signalling something unpinned. The pre-reap
    // timeout path above keeps its TERM-then-KILL, where the identity is certain.
    // Only OUR OWN group is observable here, and only as an observation.
    const survivors = groupAlive();
    // A run we had to hard-kill cannot claim its nested groups were reaped: the
    // script's trap was cut short, and this controller cannot see those groups.
    const cleanupUnproven = timedOut;

    // Only now are the parent's descriptors released.
    releaseCaptureFds();

    const stdout = readBounded(stdoutPath);
    const stderr = readBounded(stderrPath);

    // AN EMPTY CAPTURE CAN NEVER PASS FOR A SUCCESSFUL RUN.
    //
    // This script always emits at least one NDJSON record on any path it can exit
    // 0 or 78 from. If the capture is empty on such an exit, the transport lost the
    // output and no assertion below it means anything — so this throws rather than
    // letting record assertions fail one by one against "". A future capture
    // regression cannot be mistaken for a content failure.
    if (stdout.length === 0 && (exitCode === 0 || exitCode === 78)) {
      throw new Error(
        `capture lost: exit=${exitCode} produced an empty stdout at ${stdoutPath}. ` +
          `The script emits a record on every such path, so this is a transport fault, not a content failure.`,
      );
    }

    return { exitCode, stdout, stderr, timedOut, survivors, cleanupUnproven };
  } finally {
    releaseCaptureFds();
  }
}

/** Failure context. stderr appears here and nowhere else. */
function diag(run: ShellRun): string {
  const tail = run.stderr.slice(-2_000);
  return `exit=${run.exitCode} timedOut=${run.timedOut} survivors=${run.survivors} stderr(tail)=${tail}`;
}

/**
 * The shell's `--self-test` is executed ONCE and shared.
 *
 * Its causal plants sleep on real timers, so re-running it per assertion pushed
 * the suite past its own timeout. One run, many assertions against the same
 * recorded output, keeps every claim causal without paying for it repeatedly.
 */
let selfTestRun: Promise<ShellRun> | undefined;
function sharedSelfTest(): Promise<ShellRun> {
  // The ambient S6 variables are REMOVED and explicit canaries planted in their
  // place. Passing `process.env` meant that on an ordinary machine — where the
  // real variables are absent — `export -n` could be deleted and the held-helper
  // plant would still see a clean environ. With canaries planted, that line is
  // the only reason the helper cannot read them.
  //
  // The real operator secrets are never passed into the test.
  selfTestRun ??= runShell(["--self-test"], {
    ...withoutS6Env(),
    ASIMP_S6_TEST_GOOGLE_PASS: "planted-selftest-pass-0123456789",
    ASIMP_S6_TEST_GOOGLE_USER: "planted-selftest-user@example.com",
    ASIMP_S6_FELLOW_TOKEN: "planted-selftest-bearer-0123456789",
    ASIMP_S6_SIGNING_KEY_HEX: "planted-selftest-key-0123456789",
  });
  return selfTestRun;
}

/** A process environment with every S-6 variable removed. */
function withoutS6Env(): Record<string, string | undefined> {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("ASIMP_S6_")) delete environment[key];
  }
  return environment;
}

describe("the spike is executable and registered", () => {
  test("the script is executable", () => {
    expect(statSync(resolve(root, SCRIPT)).mode & 0o111).toBeGreaterThan(0);
  });

  test("the G0 manifest still points at this script", () => {
    expect(code("scripts/suite/g0-spikes.ts")).toContain(SCRIPT);
  });

  test("the browser leg exists and the script requires it", () => {
    expect(statSync(resolve(root, RUNNER)).isFile()).toBe(true);
    expect(shellFunction(code(SCRIPT), "run_browser_leg")).toContain("BROWSER_RUNNER_MISSING");
  });
});

describe("the cookie claim is live, not an artifact", () => {
  const runner = read(RUNNER);

  test("the runner matches the EXACT configured cookie name", () => {
    // `apps/web/auth.ts` overrides the Auth.js default. Matching the framework
    // name finds nothing and silently proves nothing — the defect that sank the
    // previous revision.
    expect(read("apps/web/auth.ts")).toContain('name: "asimp.session"');
    expect(runner).toContain('SESSION_COOKIE_NAME = "asimp.session"');
    expect(runner).not.toContain('authjs.session-token";');
  });

  test("host-only is decided from the Set-Cookie header, not from a jar", () => {
    const parser = runner.slice(runner.indexOf("function parseSetCookie"));
    expect(parser).toContain('a.startsWith("domain=")');
  });

  test("there is no storage-state fallback for the cookie claim", () => {
    // A storage-state file is the product of a login that already happened and
    // cannot testify to what the origin sent.
    expect(runner).not.toContain("storageState");
    expect(runner).toContain("CONFIG_ABSENT");
  });

  test("the Google credentials are actually used", () => {
    // The account now arrives on stdin, so the runner names the fields and the
    // shell is what supplies them.
    expect(runner).toContain('typeof parsed.user === "string"');
    expect(runner).toContain('typeof parsed.password === "string"');
    expect(runner).toContain('input[type="password"]');
    expect(shellFunction(code(SCRIPT), "run_browser_leg")).toContain("ASIMP_S6_TEST_GOOGLE_PASS");
  });

  test("a Google challenge is blocked, never passed or failed silently", () => {
    expect(runner).toContain("GOOGLE_LOGIN_CHALLENGED");
    expect(runner).toContain("BLOCKED_EXIT");
  });
});

describe("exactly two WRONG_PRINCIPAL legs, each exact", () => {
  const source = code(SCRIPT);

  test("the bearer leg requires exactly 403 WRONG_PRINCIPAL", () => {
    const leg = shellFunction(source, "assert_bearer_on_sponsor_route_refused");
    expect(leg).toContain('"$status" == "403"');
    expect(leg).toContain('"$code" == "WRONG_PRINCIPAL"');
  });

  test("the agent-host leg requires exactly 403 WRONG_PRINCIPAL", () => {
    // The browser measures it; the shell asserts the exact pair.
    const leg = shellFunction(source, "run_browser_leg");
    expect(leg).toContain('"cookie_probe":{"status":403,"code":"WRONG_PRINCIPAL"}');
  });

  test("the evidence does not claim a cookie was presented to the agent host", () => {
    // A host-only apex cookie is never attached to an agent-host request, so
    // nothing is presented and nothing is refused. Saying otherwise would
    // describe a weaker world than the one proved — one where the cookie
    // reached `a.` and was merely rejected there.
    const leg = shellFunction(source, "run_browser_leg");
    expect(leg).toContain("cookie-not-sent-to-agent-host");
    expect(leg).toContain("was not sent to the agent host");
    expect(leg).not.toContain("cookie on ${ROUTE_PROPOSALS} was refused");
    expect(read(RUNNER)).not.toContain("the live cookie was refused");
  });

  test("no leg accepts an arbitrary non-2xx, a curl 000, a 404 or a 5xx", () => {
    // The rejected revision passed the cookie direction on any non-2xx, so a
    // dead Worker (curl 000) read as a security proof.
    expect(source).not.toContain("=~ ^2");
    for (const leg of ["assert_bearer_on_sponsor_route_refused", "assert_cookie_changed_nothing"]) {
      const body = shellFunction(source, leg);
      expect(body).not.toMatch(/!=\s*"?2/);
      expect(body).toContain("403");
    }
  });

  test("a sessionless differential pins the agent-host answer", () => {
    const control = shellFunction(source, "assert_cookie_changed_nothing");
    // The browser's agent-host request carried no cookie; this issues the same
    // request from a client with no session and requires the identical answer,
    // so holding an apex session is shown to buy nothing on `a.`.
    expect(control).toContain('http_request GET "${worker}${ROUTE_PROPOSALS}" "" ""');
    expect(control).toContain("no-credential-differential");
    expect(control).toContain("WRONG_PRINCIPAL");
  });

  test("there are exactly two WRONG_PRINCIPAL legs", () => {
    const names = [...source.matchAll(/(?:pass|fail)_record "([a-z-]+)"/g)].map((m) => m[1]);
    const legs = names.filter(
      (n) => n === "bearer-on-sponsor-route-refused" || n === "cookie-not-sent-to-agent-host",
    );
    expect(new Set(legs).size).toBe(2);
  });
});

describe("each opaque 401 is tied to its own function", () => {
  const source = code(SCRIPT);

  // Rule A5: replay, tamper and expiry share one opaque face. Each assertion
  // must carry its own check rather than inheriting one from a sibling.
  for (const fn of [
    "assert_replay_refused",
    "assert_altered_payload_refused",
    "assert_expired_envelope_refused",
  ]) {
    test(`${fn} checks 401 UNAUTHORIZED itself`, () => {
      const body = shellFunction(source, fn);
      expect(body).toContain('"$status" == "401"');
      expect(body).toContain('"$code" == "UNAUTHORIZED"');
    });
  }

  test("no per-mode envelope code is asserted anywhere", () => {
    for (const leaky of ["NONCE_REPLAYED", "BAD_SIGNATURE", "ENVELOPE_EXPIRED", "PAYLOAD_DIGEST"]) {
      expect(source).not.toContain(leaky);
    }
  });

  test("the tamper case posts to a route that is mounted for POST", () => {
    const body = shellFunction(source, "assert_altered_payload_refused");
    expect(body).toContain("$ROUTE_MINT");
    expect(source).toContain('ROUTE_MINT="/v1/enrollments"');
    // A POST to a GET-only route is refused by routing before the verifier
    // runs, so it would prove nothing about tamper detection.
    expect(code("apps/wire/src/enrollment/router.ts")).toContain('app.post("/v1/enrollments"');
    expect(body).not.toContain("$ROUTE_PROPOSALS");
  });
});

describe("credentials never enter argv or a child environment", () => {
  const source = code(SCRIPT);

  test("curl receives credential headers on stdin, not as arguments", () => {
    const http = shellFunction(source, "http_request");
    expect(http).toContain("--config -");
    expect(http).not.toContain("--header");
  });

  test("the bearer is passed as a config document", () => {
    const leg = shellFunction(source, "assert_bearer_on_sponsor_route_refused");
    expect(leg).toContain('header = \\"authorization: Bearer');
    // It must be an argument to http_request's config parameter, never a curl flag.
    expect(leg).not.toContain("--header");
  });

  test("the child environment is scrubbed", () => {
    expect(shellFunction(source, "http_request")).toContain("minimal_env_command");
    expect(shellFunction(source, "minimal_env_command")).toContain("env -i");
  });

  test("the live cookie value never leaves the browser", () => {
    const runner = read(RUNNER);
    expect(runner).toContain("context.request.get");
    // Exporting the jar to the shell would put a live human session in an argv.
    expect(runner).not.toContain("cookie.value");
    expect(source).not.toContain("ASIMP_S6_STORAGE_STATE");
  });

  test("no shell request follows a redirect", () => {
    const http = shellFunction(source, "http_request");
    expect(http).not.toContain("--location");
    expect(http).not.toContain(" -L ");
  });

  test("the browser probe refuses redirects and pins the final origin", () => {
    // A 3xx to the apex would move the probe onto the plane that DOES consult
    // cookies; a 403 collected there would silently invalidate both the
    // host-only and the non-consultation claims. Absence of `curl -L` in the
    // shell says nothing about this — the probe is made by Playwright.
    const runner = read(RUNNER);
    const probe = runner.slice(runner.indexOf("const probeUrl ="));
    expect(probe).toContain("maxRedirects: 0");
    expect(probe).toContain("AGENT_HOST_PROBE_REDIRECTED");
    expect(probe).toContain("finalUrl.host !== expectedUrl.host");
    expect(probe).toContain("finalUrl.pathname !== expectedUrl.pathname");
    // The origin check must precede accepting the 403.
    expect(probe.indexOf("AGENT_HOST_PROBE_REDIRECTED")).toBeLessThan(
      probe.indexOf('cookieProbe.code !== "WRONG_PRINCIPAL"'),
    );
  });
});

describe("the leak canary scans every secret, including short ones", () => {
  const canary = shellFunction(code(SCRIPT), "assert_no_secret_escaped");

  test("no value is skipped for being short", () => {
    // The rejected revision did `[[ ${#value} -ge 16 ]] || continue`, which
    // silently declined to scan exactly the values easiest to leak.
    //
    // The only permitted skip is for an UNSET variable, which has nothing to
    // scan for. So: no length test may reach a `continue`, and the single
    // `continue` in the function must be the empty-value one.
    expect(canary).not.toMatch(/\$\{#value\}[\s\S]{0,80}?continue/);
    // Scoped to the declared-secrets loop: the signature loop below it has its
    // own empty-value guard, so a whole-function count would drift.
    const secretLoop = canary.slice(
      canary.indexOf('for name in "${SECRET_VARS[@]}"'),
      canary.indexOf("for signature in "),
    );
    const continues = [...secretLoop.matchAll(/\bcontinue\b/g)];
    expect(continues.length).toBe(1);
    expect(canary).toContain('[[ -n "$value" ]] || continue');
    // A short value is reported as a weak canary and still scanned.
    expect(canary).toContain("secret-canary-weak");
    const lengthBranch = canary.slice(canary.indexOf("${#value} < 16"));
    expect(lengthBranch).toContain("scan_regular_files_for");
  });

  test("it scans regular files only, with a fixed string", () => {
    expect(canary).toContain("scan_regular_files_for");
    const scanner = shellFunction(code(SCRIPT), "scan_regular_files_for");
    expect(scanner).toContain('"$SCAN_GREP" -qFf -');
    // A recursive grep would open the envelope FIFO and block forever once its
    // writers closed, hanging the run on its own secure transport.
    expect(scanner).toContain("-type f");
    // `xargs -r` still exits 0 on empty input on macOS, so an empty directory
    // was reported as a hit.
    expect(scanner).not.toContain("xargs");
  });

  test("every declared secret is named in the never-log list", () => {
    const list = code(SCRIPT).slice(
      code(SCRIPT).indexOf("SECRET_VARS=("),
      code(SCRIPT).indexOf(")", code(SCRIPT).indexOf("SECRET_VARS=(")),
    );
    for (const name of [
      "ASIMP_S6_TEST_GOOGLE_PASS",
      "ASIMP_S6_FELLOW_TOKEN",
      "ASIMP_S6_SIGNING_KEY_HEX",
    ]) {
      expect(list).toContain(name);
    }
  });
});

describe("the receipt is structured, bound, and matched as a fixed string", () => {
  const source = code(SCRIPT);

  test("it is not taken from an unrestricted environment variable", () => {
    // ASIMP_S6_WRITE_RECEIPT was an unbound, unvalidated operator input.
    expect(source).not.toContain("ASIMP_S6_WRITE_RECEIPT");
  });

  test("only a structured receipt proven absent before the action is accepted", () => {
    const leg = shellFunction(source, "run_browser_leg");
    expect(leg).toContain('"absent_before_action":true');
    expect(leg).toContain("ASIMP-EN-[0-9A-HJKMNP-TV-Z]\\{26\\}");
  });

  test("attribution matching is fixed-string, never a regex", () => {
    const leg = shellFunction(source, "assert_receipt_attributed");
    expect(leg).toContain("grep -qF");
    expect(leg).not.toMatch(/grep -q[^F]/);
  });

  test("the runner proves the id was absent before the click", () => {
    const runner = read(RUNNER);
    expect(runner).toContain("beforeIds");
    expect(runner).toContain("!beforeIds.has(id)");
  });

  test("edge request id is request correlation, not a deployment claim", () => {
    const runner = read(RUNNER);
    expect(runner).toContain("edgeRequestId");
    expect(runner).toContain('headers()["x-vercel-id"]');
    // `x-vercel-id` identifies one request through one edge. Calling it
    // immutable deployment evidence overclaimed, and folding
    // `x-vercel-deployment-url` into the same field mixed two identities.
    // The bans target USAGE: the comment records why the header is refused.
    expect(runner).not.toContain('headers()["x-vercel-deployment-url"]');
    expect(runner).not.toMatch(/let deployment\b/);
    expect(runner).not.toMatch(/readonly deployment:/);
  });

  test("the runner emits its pass record only after cleanup", () => {
    const runner = read(RUNNER);
    // Emitting inside `try` published a success before `finally` closed the
    // browser, so a teardown failure could follow an already published pass.
    expect(runner).toContain("return {");
    expect(runner).toContain("const passRecord = await main();");
    expect(runner).toContain("RUNNER_TEARDOWN_FAILED");
    expect(runner).toContain("teardownFailed");
    const tail = runner.slice(runner.indexOf("const passRecord = await main();"));
    expect(tail.indexOf("teardownFailed > 0")).toBeLessThan(tail.indexOf("emit(passRecord)"));
  });

  test("neither reader spins on EAGAIN", () => {
    // An immediate EAGAIN retry is an unbounded CPU spin, and the runner's
    // deadline is not armed until after the read loop.
    for (const source of [read(RUNNER), code(SCRIPT)]) {
      expect(source).not.toMatch(/EAGAIN"\)? continue/);
      expect(source).toContain('=== "EINTR") continue');
      expect(source).toContain("EAGAIN");
    }
  });
});

describe("the run is bounded and leaves no survivors", () => {
  const source = code(SCRIPT);

  test("secrets are de-exported at main's first built-in step", () => {
    // Until this runs, every ordinary mktemp/chmod/sleep/grep/find/stat helper
    // inherits the password, bearer and seed in its own environ.
    const main = source.slice(source.indexOf("main() {"));
    const deExport = main.indexOf("export -n ASIMP_S6_TEST_GOOGLE_PASS");
    expect(deExport).toBeGreaterThanOrEqual(0);
    // Before any mode dispatch or helper call.
    expect(deExport).toBeLessThan(main.indexOf("--self-test-signal-victim"));
    for (const name of [
      "ASIMP_S6_TEST_GOOGLE_PASS",
      "ASIMP_S6_TEST_GOOGLE_USER",
      "ASIMP_S6_FELLOW_TOKEN",
      "ASIMP_S6_SIGNING_KEY_HEX",
    ]) {
      expect(main).toContain(`export -n ${name}`);
    }
  });

  test("the leak scan never puts its needle in an argv", () => {
    const scanner = shellFunction(source, "scan_regular_files_for");
    // `grep -qF -- "$needle" file` published the secret in grep's command line
    // for the life of the process — by the canary meant to detect leaks.
    expect(scanner).not.toMatch(/grep -qF -- "\$needle"/);
    expect(scanner).toContain(`printf '%s' "$needle" | "$SCAN_GREP" -qFf -`);
  });

  test("every minted signature is retained and scanned", () => {
    const minter = shellFunction(source, "mint_envelope_config");
    expect(minter).toContain("MINTED_SIGNATURES+=");
    const canary = shellFunction(source, "assert_no_secret_escaped");
    expect(canary).toContain("MINTED_SIGNATURES");
    // MINTED_CONFIG is overwritten by the next mint, so scanning only it left
    // every earlier signature — each live until its nonce is consumed — unseen.
    expect(canary).toContain("minted envelope signature");
  });

  test("nothing is sealed while a child group survives", () => {
    // No scan, no evidence artifact, no verdict may be published with a
    // survivor outstanding.
    for (const marker of ["CLEANUP_UNPROVEN", "EX_CLEANUP_UNPROVEN"]) {
      expect(source).toContain(marker);
    }
    const finish = shellFunction(source, "finish");
    expect(finish.indexOf("reap_children")).toBeLessThan(
      finish.indexOf("assert_no_secret_escaped"),
    );
    expect(finish.indexOf("CLEANUP_UNPROVEN")).toBeLessThan(
      finish.indexOf("write_evidence_bundle"),
    );
  });

  test("the watchdog-allocation failure path surrenders only on proof", () => {
    const bounded = shellFunction(source, "run_bounded");
    const arm = bounded.slice(bounded.indexOf('if [[ -z "$dog_dir" ]]'));
    expect(arm).toContain("sweep_group");
    expect(arm).toContain("unregister_child");
    // Unregister must be guarded by the sweep, never unconditional.
    expect(arm).toMatch(/if sweep_group "\$pid"; then\s+unregister_child/);
  });

  test("one monotonic deadline is computed from a single start stamp", () => {
    expect(source).toContain("WORK_BUDGET_SECONDS=");
    expect(source).toContain("SCRIPT_CLEANUP_RESERVE_SECONDS=45");
    // Every child bound is clamped to what remains, so no phase can begin with
    // its full nominal bound when only the reserve is left.
    for (const fn of ["mint_envelope_config", "run_browser_leg", "http_request"]) {
      expect(shellFunction(source, fn)).toContain("phase_budget");
    }
  });

  test("EXIT, INT and TERM all reach cleanup", () => {
    expect(source).toContain("trap 'on_exit' EXIT");
    expect(source).toContain("trap 'on_signal INT' INT");
    expect(source).toContain("trap 'on_signal TERM' TERM");
  });

  test("children are TERMed, then KILLed, then counted", () => {
    const reaper = shellFunction(source, "reap_children");
    expect(reaper).toContain("signal_group");
    expect(reaper).toContain("TERM");
    expect(reaper).toContain("KILL");
    // The verdict is a global, not a printed value, so callers cannot reap in
    // a subshell by capturing it.
    expect(reaper).toContain("REAP_SURVIVORS");
  });

  test("the browser and minter children are bounded", () => {
    expect(shellFunction(source, "run_browser_leg")).toContain("$BROWSER_TIMEOUT_SECONDS");
    expect(shellFunction(source, "mint_envelope_config")).toContain("$MINTER_TIMEOUT_SECONDS");
  });

  test("the bound is an owned watchdog, with no liveness polling at all", () => {
    const bounded = shellFunction(source, "run_bounded");
    // The parent blocks in `wait`, which reaps the instant the child exits.
    expect(bounded).toContain('wait "$pid" || status=$?');
    // A watchdog owns the clock and records the timeout before signalling.
    expect(bounded).toContain('sleep "$seconds"');
    expect(bounded).toContain("timed-out");
    expect(bounded).toContain("return 124");
    // No polling of any kind. `kill -0` reports an exited-but-unreaped child as
    // alive on macOS, so a poll loop turned every fast success into a 124;
    // polling `ps` instead was fail-open and unbounded on every tick.
    expect(bounded).not.toContain("kill -0");
    expect(bounded).not.toContain("child_running");
    expect(bounded).not.toContain("date +%s");
    expect(bounded).not.toContain("limit=$((seconds * 10))");
    // Arming failure is typed and fail-closed, never an unbounded child.
    expect(bounded).toContain("EX_WATCHDOG_UNAVAILABLE");
    // Ownership is surrendered only after reap AND a proven-empty group.
    expect(bounded).toContain("EX_CLEANUP_UNPROVEN");
    const surrender = bounded.slice(bounded.indexOf('if sweep_group "$pid"'));
    expect(surrender).toContain("unregister_child");
  });

  test("lifecycle signalling and census are group-only", () => {
    // A bare-pid fallback fires in exactly the dangerous case: the group has
    // gone, the record has not yet been dropped, and the number now belongs to
    // something else.
    const signal = shellFunction(source, "signal_group");
    expect(signal).toContain('-- "-${pid}"');
    expect(signal).not.toMatch(/kill "-\$\{signal\}" "\$pid"/);
    const census = shellFunction(source, "group_alive");
    expect(census).toContain('kill -0 -- "-${pid}"');
    expect(census).not.toMatch(/kill -0 "\$pid"/);
    // The watchdog is the ONE justified direct signal: it is our own subshell,
    // still unreaped at that instant, so its number cannot yet belong to
    // anything else. Group-only there was a real regression — a subshell is not
    // reliably its own group leader, so the signal missed and `wait` blocked for
    // the watchdog's whole sleep, turning every fast child into a late 124.
    const bounded = shellFunction(source, "run_bounded");
    expect(bounded).toContain('kill -TERM -- "-${dog}" 2>/dev/null || kill -TERM "$dog"');
    // The child itself is still never signalled by bare pid.
    expect(bounded).not.toMatch(/kill -(TERM|KILL) "\$pid"/);
  });

  test("cleanup reaches descendants, not only the direct child", () => {
    // Playwright launches Chromium as a grandchild; killing one pid leaves it.
    expect(source).toContain("set -m");
    const group = shellFunction(source, "signal_group");
    expect(group).toContain('-- "-${pid}"');
    expect(shellFunction(source, "run_bounded")).toContain("signal_group");
  });

  test("pid ownership is registered in the parent shell, not a subshell", () => {
    // `out="$(run_bounded ...)"` runs the whole call in a subshell, so
    // `CHILD_PIDS+=` mutates a copy that dies with it and the EXIT trap holds
    // no pid and no pgid. Both real call sites must therefore write to a file.
    for (const fn of ["mint_envelope_config", "run_browser_leg", "http_request"]) {
      const body = shellFunction(source, fn);
      expect(body).not.toMatch(/\$\(\s*run_bounded/);
      expect(body).toContain("run_bounded ");
    }
    // These helpers must also not be CALLED inside a command substitution, or
    // the registration dies one level up instead.
    expect(source).not.toMatch(/=\s*"\$\(mint_envelope_config/);
    expect(source).not.toMatch(/=\s*"\$\(http_request/);
  });

  test("the reaper does not return its verdict through a subshell", () => {
    // `survivors="$(reap_children)"` would run every `wait` in a subshell, so
    // the parent would never actually reap the children it owns.
    expect(source).not.toContain('"$(reap_children)"');
    expect(source).toContain("REAP_SURVIVORS");
    expect(shellFunction(source, "on_exit")).toContain("reap_children");
    expect(shellFunction(source, "on_exit")).toContain("REAP_SURVIVORS");
  });

  test("the group is swept on ordinary and failing child exits too", () => {
    // A child can exit cleanly and still leave Chromium behind; waiting on the
    // direct pid alone would call that success.
    const bounded = shellFunction(source, "run_bounded");
    expect(bounded).toContain("sweep_group");
    const afterWait = bounded.slice(bounded.indexOf('wait "$pid" || status=$?'));
    expect(afterWait).toContain("sweep_group");
  });
});

describe("the runner record and the shell parser cannot drift apart", () => {
  const runner = read(RUNNER);
  const shell = code(SCRIPT);

  /** Field names the runner declares on its NDJSON record. */
  const declared = [
    ...runner
      .slice(runner.indexOf("interface Record_ {"), runner.indexOf("const startedAt"))
      .matchAll(/^\s+readonly ([a-z_]+)[?:]/gm),
  ].map((m) => m[1] as string);

  test("the runner declares the fields the shell reads", () => {
    // Renaming `deployment` to `edge_request_id` in the runner left the shell
    // parsing a field that no longer existed, so every otherwise-green live run
    // failed on it. Neither file was wrong alone, which is why only a contract
    // spanning both can catch it.
    expect(declared).toContain("edge_request_id");
    expect(declared).toContain("cookie_probe");
    expect(declared).toContain("receipt");
    expect(declared).not.toContain("deployment");
  });

  test("every field the shell parses out of the record is declared", () => {
    const parsed = [...shell.matchAll(/"([a-z_]+)":\\"/g)].map((m) => m[1] as string);
    const knownNonRecord = new Set(["suite", "status", "code", "detail", "assertion", "reproduce"]);
    for (const field of parsed) {
      if (knownNonRecord.has(field)) continue;
      expect(declared, `shell parses "${field}" but the runner does not declare it`).toContain(
        field,
      );
    }
  });

  test("the shell no longer claims a deployment pin", () => {
    expect(shell).not.toContain('"deployment"');
    expect(shell).not.toContain("deployment-identified");
    expect(shell).toContain("edge_request_id");
    // Wording bans: nothing may describe this as immutable or pinned.
    expect(shell).not.toMatch(/immutable deployment/i);
    expect(shell).not.toMatch(/pinned to deployment/i);
  });

  test("edge correlation is not an S6 gate", () => {
    // Fable S-6 does not require `x-vercel-id`, and the runner types the field
    // as nullable, so its absence proves nothing. No assertion may depend on it
    // and it must not inflate the assertion count in either direction.
    const leg = shellFunction(shell, "run_browser_leg");
    const region = leg.slice(leg.indexOf("edge_request_id"));
    expect(region).not.toContain('pass_record "edge-request');
    expect(region).not.toContain('fail_record "edge-request');
    expect(shell).not.toContain("edge-request-identified");
  });
});

describe("stdin records are read in a way that terminates on a FIFO", () => {
  const runner = read(RUNNER);
  const shell = code(SCRIPT);

  test("neither reader uses Bun.stdin.stream()", () => {
    // Measured on bun 1.3.8 / macOS: `Bun.stdin.stream()` never observes
    // end-of-stream when stdin is a FIFO. The record arrives in full and the
    // process then blocks forever, while the identical code terminates over a
    // plain pipe — so the defect is invisible until the real transport is used.
    // It is what made the minter hang and the shim plant report "did-not-mint".
    // The ban is on the USAGE form. Both files name the API in a comment that
    // records why it is refused, and that prose must stay readable.
    expect(runner).not.toContain("of Bun.stdin.stream(");
    expect(shell).not.toContain("of Bun.stdin.stream(");
  });

  test("both read bounded and synchronously, MAX+1, refusing over-cap", () => {
    for (const source of [runner, shell]) {
      expect(source).toContain("readSync(0, buffer, total, buffer.length - total, null)");
      // MAX+1 so a full record can be told apart from an overflowing one.
      expect(source).toMatch(/Buffer\.alloc\(MAX_\w+_RECORD_BYTES \+ 1\)/);
      expect(source).toContain("if (read === 0) break;");
    }
  });

  test("both decode UTF-8 fatally, never substituting U+FFFD", () => {
    for (const source of [runner, shell]) {
      expect(source).toContain('new TextDecoder("utf-8", { fatal: true })');
      // A non-fatal `Buffer.toString("utf8")` would smuggle U+FFFD into a
      // credential field instead of refusing the record.
      expect(source).not.toContain('.toString("utf8")');
    }
  });
});

describe("the browser runner cannot exit before cleanup", () => {
  const runner = read(RUNNER);

  test("blocked and failed throw rather than exiting at the throw site", () => {
    // `process.exit` at the throw site skips the `finally` that awaits
    // context/browser close, orphaning Chromium while still printing a tidy
    // record.
    expect(runner).toContain("class RunnerExit");
    const blocked = runner.slice(
      runner.indexOf("function blocked("),
      runner.indexOf("function failed("),
    );
    expect(blocked).toContain("throw new RunnerExit");
    expect(blocked).not.toContain("process.exit");
    const failed = runner.slice(
      runner.indexOf("function failed("),
      runner.indexOf("function originHost("),
    );
    expect(failed).toContain("throw new RunnerExit");
    expect(failed).not.toContain("process.exit");
  });

  test("the status is applied only after the finally has closed the browser", () => {
    const tail = runner.slice(runner.indexOf("const passRecord = await main();"));
    expect(tail).toContain("error instanceof RunnerExit");
    expect(tail).toContain("process.exit(error.status)");
    const cleanup = runner.slice(runner.indexOf("} finally {"));
    expect(cleanup).toContain("await context?.close()");
    expect(cleanup).toContain("await browser?.close()");
  });

  test("the hard deadline closes the browser before exiting", () => {
    const budget = runner.slice(runner.indexOf("const budget = setTimeout("));
    expect(budget).toContain("await browser?.close()");
    expect(budget).toContain("CLOSE_GRACE_MS");
  });

  test("the cookie-probe comment does not claim the cookie was presented", () => {
    expect(runner).not.toContain("Present the LIVE session cookie");
    expect(runner).toContain("host-only on the apex");
  });
});

describe("every child gets a minimal environment", () => {
  const source = code(SCRIPT);

  test("the minter gets a minimal env and its key over stdin", () => {
    const minter = shellFunction(source, "mint_envelope_config");
    // The key must reach the child as a bounded stdin record, never in argv
    // (process table) and never in environ (inherited by descendants).
    expect(minter).toContain("minimal_env_command");
    expect(minter).toContain("new_secret_fifo");
    expect(minter).not.toContain("ASIMP_S6_SIGNING_KEY_HEX=");
    expect(minter).not.toContain("ASIMP_S6_FELLOW_TOKEN");
  });

  test("the browser gets a minimal env and its config over stdin", () => {
    const browser = shellFunction(source, "run_browser_leg");
    expect(browser).toContain("minimal_env_command");
    expect(browser).toContain("new_secret_fifo");
    // Chromium inherits this process's environment, so nothing secret may be in it.
    expect(browser).not.toContain('ASIMP_S6_TEST_GOOGLE_PASS="$ASIMP');
    expect(browser).not.toContain("ASIMP_S6_SIGNING_KEY_HEX=");
  });

  test("the launcher is minimal AT SPAWN, not unset-after-startup", () => {
    const launcher = shellFunction(source, "minimal_env_command");
    expect(launcher).toContain("env -i");
    // `bash -c 'unset X; exec …'` inherits every secret before unsetting, so on
    // any platform exposing same-UID environ the leak just moves from argv to
    // environ. No secret name may appear in the launcher's own argv either.
    expect(launcher).not.toContain("unset ");
    for (const secret of [
      "ASIMP_S6_SIGNING_KEY_HEX=",
      "ASIMP_S6_TEST_GOOGLE_PASS=",
      "ASIMP_S6_FELLOW_TOKEN=",
    ]) {
      expect(launcher).not.toContain(secret);
    }
    expect(shellFunction(source, "http_request")).toContain("minimal_env_command");
  });
});

describe("the tamper case reaches the verifier", () => {
  const source = code(SCRIPT);

  test("it sends a JSON content-type", () => {
    // The router checks content-type BEFORE authenticating, so a tamper POST
    // without it is refused by the wrong gate.
    const body = shellFunction(source, "assert_altered_payload_refused");
    expect(body).toContain("content-type: application/json");
  });

  test("a content-type refusal is an explicit failure, not a silent pass", () => {
    const body = shellFunction(source, "assert_altered_payload_refused");
    expect(body).toContain("JSON_CONTENT_TYPE_REQUIRED");
    const guard = body.slice(body.indexOf("JSON_CONTENT_TYPE_REQUIRED"));
    expect(guard).toContain("fail_record");
  });

  test("the router really checks content-type before auth", () => {
    const router = code("apps/wire/src/enrollment/router.ts");
    const start = router.indexOf('app.post("/v1/enrollments"');
    expect(start).toBeGreaterThanOrEqual(0);
    const route = router.slice(start);
    const contentType = route.indexOf("hasJsonContentType");
    const auth = route.indexOf("requireSponsor");
    // Both must be PRESENT before their order means anything. `indexOf` returns
    // -1 for a missing guard, and -1 is less than any real index, so comparing
    // the two directly would keep passing after the content-type check was
    // deleted — the exact vacuity this assertion exists to prevent.
    expect(contentType).toBeGreaterThanOrEqual(0);
    expect(auth).toBeGreaterThanOrEqual(0);
    expect(contentType).toBeLessThan(auth);
  });
});

describe("the shell's causal self-tests actually run", () => {
  test(
    "--self-test passes, and its cleanup assertions are executed rather than described",
    async () => {
      const run = await sharedSelfTest();
      const { stdout } = run;
      expect(run.timedOut, diag(run)).toBe(false);
      expect(run.exitCode, diag(run)).toBe(0);
      expect(stdout, diag(run)).toContain('"status":"self_test_complete"');
      // These two are causal: a real child is killed, and a runaway child is
      // bounded at 124. They cannot pass by reading the source.
      expect(stdout, diag(run)).toContain('"assertion":"reaper-actually-kills","status":"pass"');
      expect(stdout, diag(run)).toContain('"assertion":"run-bounded-times-out","status":"pass"');
      // The four repairs the moving audit demanded, each proven by running it.
      expect(stdout, diag(run)).toContain(
        '"assertion":"run-bounded-honours-wall-clock","status":"pass"',
      );
      expect(stdout, diag(run)).toContain('"assertion":"reaper-kills-descendants","status":"pass"');
      expect(stdout, diag(run)).toContain(
        '"assertion":"child-environment-scrubbed","status":"pass"',
      );
      // Active-only ownership records, and the fast-exit property that the
      // zombie-poll defect used to break.
      expect(stdout, diag(run)).toContain(
        '"assertion":"child-record-armed-then-disarmed","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"unregister-is-exact-not-glob","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"run-bounded-fast-exit-is-prompt","status":"pass"',
      );
      expect(stdout, diag(run)).toContain(
        '"assertion":"generated-shim-executes-and-mints","status":"pass"',
      );
      expect(stdout, diag(run)).toContain('"assertion":"normal-exit-sweeps-group","status":"pass"');
      expect(stdout, diag(run)).toContain('"assertion":"error-exit-sweeps-group","status":"pass"');
      expect(stdout, diag(run)).not.toMatch(/"status"\s*:\s*"fail"/);
      // A self-test must never look like a passing S-6 run.
      expect(stdout, diag(run)).not.toContain('"status":"pass","assertions"');
    },
    SHELL_TIMEOUT_MS,
  );

  test(
    "with no configuration it blocks at 78 and runs nothing",
    async () => {
      const run = await runShell([], withoutS6Env());
      expect(run.timedOut, diag(run)).toBe(false);
      expect(run.exitCode, diag(run)).toBe(78);
      // The blocked record is the whole contract here, so an empty stdout is a
      // failure in its own right rather than something the next assertion
      // happens to catch.
      expect(run.stdout.length, diag(run)).toBeGreaterThan(0);
      expect(run.stdout, diag(run)).toContain('"code":"PREVIEW_NOT_PROVISIONED"');
      expect(run.stdout, diag(run)).not.toContain('"assertion"');
    },
    SHELL_TIMEOUT_MS,
  );
});

describe("the test harness contains what it launches", () => {
  test("it owns a REAL process group and censuses it", () => {
    const self = read("apps/wire/test/auth/cross-plane-spike.test.ts");
    // `bash -c 'set -m; …'` changes the groups of the jobs that shell starts,
    // not the group of the shell itself, so `kill(-child.pid)` was addressing a
    // group this process did not lead. `setpgrp(0,0)` before exec is real.
    // Sliced to the spawn itself. A whole-file ban would be self-referential:
    // the assertion string would live in the very file it reads.
    // Bounded by the spawn call itself. `closeSync(stdoutFd)` is no longer a
    // valid end marker: it now appears in `releaseCaptureFds` ABOVE the spawn,
    // so the slice inverted and matched nothing.
    const spawn = self.slice(
      self.indexOf("const child = Bun.spawn({"),
      self.indexOf("/** Is the child's group still present?"),
    );
    // Every check is scoped to the CONTROLLER. Whole-file bans here are
    // self-referential: the forbidden string would live in the assertion itself.
    const controller = self.slice(
      self.indexOf("async function runShell("),
      self.indexOf("/** Failure context."),
    );
    expect(spawn).toContain("setpgrp(0,0)");
    expect(spawn).not.toContain("set -m");
    expect(controller).toContain("process.kill(-child.pid");
    expect(controller).toContain('signalGroup("SIGTERM")');
    // Group-only: no bare-pid fallback that can hit a reused number.
    expect(controller).not.toContain("child.kill(");
    // The escalation timer is owned, cancelled and drained.
    expect(controller).toContain("clearTimeout(killTimer)");
    // No post-reap signal at all: after the reap the pgid may be recycled, so a
    // SIGKILL there could land on an unrelated group. Census only.
    expect(controller).toContain("const survivors = groupAlive();");
    const afterReap = controller.slice(controller.indexOf("const survivors = groupAlive();"));
    expect(afterReap).not.toContain("signalGroup(");
  });

  test("an over-cap capture is rejected, not truncated", () => {
    const self = read("apps/wire/test/auth/cross-plane-spike.test.ts");
    expect(self).toContain("class OverCapture");
    expect(self).toContain("capture exceeded");
  });

  test(
    "an ordinary run leaves no survivor in the group this controller leads",
    async () => {
      // The claim is scoped to OUR group. The script's own nested groups are
      // covered by its plants below; this controller cannot see them, and on a
      // hard-killed run it reports `cleanupUnproven` rather than pretending to.
      const run = await sharedSelfTest();
      expect(run.timedOut, diag(run)).toBe(false);
      expect(run.cleanupUnproven, diag(run)).toBe(false);
      expect(run.survivors, diag(run)).toBe(false);
    },
    SHELL_TIMEOUT_MS,
  );

  test("a hard-killed run is reported as cleanup-unproven, not contained", () => {
    const self = read("apps/wire/test/auth/cross-plane-spike.test.ts");
    // A pgid ledger was tried and removed: signalling from bare pgids risks a
    // recycled group, and censusing them is fail-open. So the hard-kill path
    // makes no containment claim in either direction.
    // Scoped to the controller: a whole-file ban would match this assertion.
    const controller = self.slice(
      self.indexOf("async function runShell("),
      self.indexOf("/** Failure context."),
    );
    expect(controller).toContain("const cleanupUnproven = timedOut;");
    expect(controller).not.toContain("S6_PGID_LEDGER");
    expect(controller).not.toContain("ledgerSurvivors");
    expect(code(SCRIPT)).not.toContain("ledger_note");
  });

  test(
    "the script's own plants cover the descendant, timeout and signal paths",
    async () => {
      // The shell's own `normal-exit-sweeps-group` plant proves the sweep; this
      // asserts the harness reports no survivor for that same run.
      const run = await sharedSelfTest();
      expect(run.stdout, diag(run)).toContain(
        '"assertion":"normal-exit-sweeps-group","status":"pass"',
      );
      expect(run.stdout, diag(run)).toContain('"assertion":"timeout-sweeps-group","status":"pass"');
      expect(run.stdout, diag(run)).toContain(
        '"assertion":"term-signal-reaps-descendants","status":"pass"',
      );
      expect(run.survivors, diag(run)).toBe(false);
    },
    SHELL_TIMEOUT_MS,
  );
});

describe("anti-vacuity: the blocked exit is load-bearing", () => {
  test(
    "deleting the required blocked exit makes the boundary test fail",
    async () => {
      // If the suite still passed against a script whose `exit "$EX_CONFIG"`
      // was removed, the exit-78 assertion would be decoration.
      const source = read(SCRIPT);
      const marker = '    CLEANED_UP=1\n    exit "$EX_CONFIG"\n  fi';
      expect(source).toContain(marker);
      const mutant = source.replace(marker, "    CLEANED_UP=1\n  fi");
      expect(mutant).not.toBe(source);

      const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s6-mutant-"));
      const mutantPath = join(dir, "mutant.sh");
      writeFileSync(mutantPath, mutant, { mode: 0o700 });

      const run = await runShell([], withoutS6Env(), mutantPath);
      expect(run.timedOut, diag(run)).toBe(false);
      // The real script exits 78 here. The mutant must not, or the assertion
      // in "with no configuration it blocks at 78" proves nothing.
      expect(run.exitCode, diag(run)).not.toBe(78);
    },
    SHELL_TIMEOUT_MS,
  );
});
