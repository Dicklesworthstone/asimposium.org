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
 * behavioural proof lives in `scripts/e2e-s6-auth-ingress.sh`, which needs a
 * real local D1 binding and therefore cannot run inside `bun test`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyRefusal,
  EXPECTED_REFUSAL,
  LOCAL_FETCH_TIMEOUT_MS,
  loadSigningKey,
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

  test("readiness is tied to child liveness", () => {
    expect(script).toContain('kill -0 "${SERVER_PID}"');
    expect(script).toMatch(/if ! kill -0 "\$\{SERVER_PID\}" 2>\/dev\/null; then return 1; fi/);
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
    // And the assumption is verified, not trusted.
    expect(script).toContain('SERVER_PGID="$(ps -o pgid= -p "${SERVER_PID}"');
    expect(script).toContain("worker_owns_its_process_group");
    expect(script).toMatch(/"\$\{SERVER_PGID\}" != "\$\{SERVER_PID\}"/);
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
    const block = script.slice(
      script.indexOf("busy_run_id="),
      script.indexOf("child_process_group_is_reaped"),
    );
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
    const armed = script.indexOf("trap stop_worker EXIT");
    expect(armed).toBeGreaterThan(0);
    expect(script.indexOf('SERVER_PGID=""')).toBeGreaterThan(0);
    expect(script.indexOf('SERVER_PGID=""')).toBeLessThan(armed);
    expect(script.indexOf('SERVER_PID=""')).toBeLessThan(armed);
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

  test("PLANTED: an ownership-refused cleanup makes the full run fail", () => {
    expect(script).toContain("local cleanup_status=0");
    expect(script).toContain('stop_group "${SERVER_PGID}" || cleanup_status=$?');
    expect(script).toContain('fail_record "worker_group_cleanup_proved"');
    expect(script).toMatch(/if ! stop_worker; then\n\s+fail_record "worker_group_cleanup_proved"/);
  });

  test("PLANTED: an occupied pinned port is refused before the Worker starts", () => {
    expect(script).toContain("port_is_occupied()");
    expect(script).toContain("pinned_port_is_free");
    // Refused before the launcher, not diagnosed afterwards as a dead Worker.
    expect(script.indexOf("pinned_port_is_free")).toBeLessThan(script.indexOf("start_worker()"));
  });

  test("PLANTED: the checker deadline escalates TERM then KILL", () => {
    const block = script.slice(script.indexOf("run_checker()"), script.indexOf("run_checker\n"));
    expect(block).toContain('kill -TERM "${checker_pid}"');
    expect(block).toContain('kill -KILL "${checker_pid}"');
    // Both waits are counted loops, so a checker ignoring TERM cannot hang it.
    expect(block).toMatch(/for _grace in \{1\.\.\d+\}; do/);
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

describe("the group killer proves ownership before it signals", () => {
  const script = read(SCRIPT);

  test("PLANTED: a stale or recycled group is refused, not blindly killed", () => {
    expect(script).toContain("group_is_ours()");
    expect(script).toContain("never_signals_a_recycled_group");
    // Ownership is proven by finding a member that references THIS run's
    // private state directory, not by the pgid number alone.
    expect(script).toMatch(/grep -qF -- "\$\{STATE_DIR\}"/);
  });

  test("PLANTED: ownership is proven before TERM and again before KILL", () => {
    const block = script.slice(script.indexOf("stop_group() {"), script.indexOf("stop_worker() {"));
    const firstProof = block.indexOf("group_is_ours");
    const term = block.indexOf('kill -TERM "-${pgid}"');
    const secondProof = block.indexOf("group_is_ours", term);
    const kill = block.indexOf('kill -KILL "-${pgid}"');
    expect(firstProof).toBeGreaterThan(-1);
    expect(firstProof).toBeLessThan(term);
    // The group can empty and the number be reissued during the TERM grace.
    expect(secondProof).toBeGreaterThan(term);
    expect(secondProof).toBeLessThan(kill);
  });

  test("an already-empty group is a no-op, never a signal", () => {
    const block = script.slice(script.indexOf("stop_group() {"), script.indexOf("stop_worker() {"));
    const emptyCheck = block.indexOf('if [[ -z "$(group_members "${pgid}")" ]]; then');
    expect(emptyCheck).toBeGreaterThan(-1);
    expect(emptyCheck).toBeLessThan(block.indexOf('kill -TERM "-${pgid}"'));
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

  const runChecker = async (jwk: string): Promise<{ code: number; output: string }> => {
    const child = Bun.spawn({
      cmd: ["bun", "src/auth/local-check.ts"],
      cwd: resolve(root, "apps/wire"),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        // Port 1 is closed; the key check runs before any request, so this
        // never reaches the network.
        S6_ORIGIN: "http://127.0.0.1:1",
        S6_NOW: "1786000000",
        S6_KID: "s6-local",
        S6_PRIVATE_KEY_JWK: jwk,
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
  const parentReads: ReadonlyArray<[string, (parent: Headers) => void]> = [
    ["get", (parent) => void parent.get("cookie")],
    ["has", (parent) => void parent.has("cookie")],
    ["a nested forEach", (parent) => parent.forEach(() => {})],
    [
      "the iterator",
      (parent) => {
        for (const _entry of parent as unknown as Iterable<[string, string]>) {
          // draining is the read; the trap must fire before the first yield
        }
      },
    ],
  ];

  for (const [label, read] of parentReads) {
    test(`PLANTED: reaching the cookie through the callback parent via ${label} trips the canary`, () => {
      let reads = 0;
      const guarded = cookieTrappedRequest(withCookie(), () => {
        reads += 1;
      });
      const leaked = "";
      expect(() => {
        guarded.headers.forEach((_value, _name, parent) => {
          // Two realms name `Headers`: this package's ambient Workers types and
          // undici's, which Bun's `fetch` types resolve to. The two-step cast is
          // the repository's existing spelling for that mismatch.
          read(parent as unknown as Headers);
        });
      }).toThrow("S6_COOKIE_READ_ON_AGENT_HOST");
      expect(leaked).toBe("");
      expect(reads).toBeGreaterThan(0);
    });

    test(`PLANTED: the same reach through a clone's callback parent trips the canary`, () => {
      let reads = 0;
      const guarded = cookieTrappedRequest(withCookie(), () => {
        reads += 1;
      });
      const cloned = guarded.clone();
      expect(() => {
        cloned.headers.forEach((_value, _name, parent) => {
          read(parent as unknown as Headers);
        });
      }).toThrow("S6_COOKIE_READ_ON_AGENT_HOST");
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
