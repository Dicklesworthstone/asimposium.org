/**
 * S-6 browser leg: the two claims a shell cannot make (bead asimposiumorg-vw3).
 *
 * 1. LIVE COOKIE SCOPING. A real Google sign-in against the real Agora preview,
 *    reading the `Set-Cookie` response header as the server actually sent it.
 *    A Playwright storage-state file is NOT accepted here: it is a *product* of
 *    a login that already happened, so it can show what a cookie jar holds but
 *    never what the origin asserted. Host-only is an assertion about the header
 *    (no `Domain=`), and only the header can prove it.
 *
 * 2. REAL SERVER-ACTION ORIGINATION. `mintJoinUrl` is gated on an HMAC-sealed
 *    payload minted by a prior action and is addressed by a per-build action id.
 *    The supported way to invoke it is the way a sponsor does: click the button.
 *    This runner never scrapes an action id and never posts a synthesised
 *    Server Action request.
 *
 * ## What this file must never emit
 *
 * The cookie VALUE, the Google password, the join-URL fragment secret, any
 * bearer, any screenshot, any trace. The join URL is read only far enough to
 * recover the public enrollment id; the fragment is never captured, because
 * `ASIMP-EN-<id>#v1.<secret>` is the one string in this flow that is a
 * credential (ADR-20). Cookie evidence is reported as ATTRIBUTES, never bytes.
 *
 * Output is exactly one NDJSON record on stdout. Exit 0 pass, 1 fail, 78 blocked.
 */

import { readSync } from "node:fs";
import { type Browser, type BrowserContext, chromium, type Response } from "@playwright/test";

const SUITE = "s6-cross-plane-browser";
const BLOCKED_EXIT = 78;

/** Whole-runner bound. A browser that hangs must not hold a CI slot open. */
const TOTAL_BUDGET_MS = 180_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 20_000;
/** Last-resort bound on browser teardown once the total budget has expired. */
const CLOSE_GRACE_MS = 10_000;
/** The stdin configuration record is a single bounded line, never a stream. */
const MAX_CONFIG_RECORD_BYTES = 8192;

/**
 * The EXACT session cookie name configured in `apps/web/auth.ts`.
 *
 * This deployment overrides the Auth.js default, so matching on the framework's
 * `authjs.session-token` finds nothing and silently proves nothing. Exact
 * equality, not a suffix: a suffix match would also accept a cookie some future
 * middleware named `evil-asimp.session`.
 */
const SESSION_COOKIE_NAME = "asimp.session";
/** The public half of a join URL. The fragment after it is never matched. */
const ENROLLMENT_ID = /ASIMP-EN-[0-9A-HJKMNP-TV-Z]{26}/;

interface CookieAttributes {
  readonly host_only: boolean;
  readonly http_only: boolean;
  readonly secure: boolean;
  readonly same_site: string | null;
  readonly scoped_to_apex: boolean;
  readonly present_for_agent_host: boolean;
}

interface Record_ {
  readonly tool: "playwright";
  readonly package: "e2e";
  readonly suite: typeof SUITE;
  readonly status: "pass" | "fail" | "blocked";
  readonly code: string;
  readonly duration_ms: number;
  readonly apex_host: string | null;
  readonly agent_host: string | null;
  readonly cookie: CookieAttributes | null;
  /**
   * Outcome when the LOGGED-IN browser requests a Worker sponsor route.
   *
   * Deliberately not called "presenting the cookie": the session cookie is
   * host-only on the apex, so the jar does not attach it to an agent-host
   * request at all. That non-transmission is the property under test, and
   * `cookie.present_for_agent_host` is its direct evidence. What this field
   * records is the answer the agent host gives a browser that holds a live apex
   * session — which must be the same answer it gives a stranger.
   *
   * The probe runs INSIDE the browser context so the cookie value never leaves
   * the jar: exporting it to a shell would put a live human session into an
   * argv, an env, or a file for the sake of testing that it is not sent.
   */
  readonly cookie_probe: { readonly status: number; readonly code: string | null } | null;
  /**
   * Structured origination receipt. `enrollment_id` is the PUBLIC half of the
   * join URL only — never the URL, never its `#v1.<secret>` fragment.
   *
   * `absent_before_action` is what makes it a receipt rather than a reading:
   * the id is proven not present on the console before the click, so it cannot
   * be a pre-existing enrollment the runner merely noticed.
   */
  readonly receipt: {
    readonly enrollment_id: string;
    readonly absent_before_action: boolean;
  } | null;
  /**
   * The serving edge's REQUEST identifier (`x-vercel-id`), or null.
   *
   * Request correlation only. It is not a build, a revision, or a deployment
   * pin, and nothing here claims otherwise: `x-vercel-id` identifies one request
   * through one edge. A deployment identity would need its own field validated
   * against a source the platform supports for that purpose.
   */
  readonly edge_request_id: string | null;
  readonly detail: string;
}

const startedAt = Date.now();

function emit(record: Omit<Record_, "duration_ms">): void {
  process.stdout.write(`${JSON.stringify({ ...record, duration_ms: Date.now() - startedAt })}\n`);
}

/**
 * Control-flow exit that still runs cleanup.
 *
 * These paths used to call `process.exit` directly. That terminates the process
 * immediately, so the `finally` block awaiting `context.close()` and
 * `browser.close()` never completed and Chromium could be orphaned — with the
 * runner reporting a tidy blocked/fail record on the way out. Throwing instead
 * lets the `finally` run to completion; the record is emitted and the status
 * applied only after the browser is really down.
 */
class RunnerExit extends Error {
  constructor(
    readonly record: Omit<Record_, "duration_ms">,
    readonly status: number,
  ) {
    super(`runner-exit:${record.code}`);
    this.name = "RunnerExit";
  }
}

function blocked(code: string, detail: string, apex: string | null = null): never {
  throw new RunnerExit(
    {
      tool: "playwright",
      package: "e2e",
      suite: SUITE,
      status: "blocked",
      code,
      apex_host: apex,
      agent_host: null,
      cookie: null,
      cookie_probe: null,
      receipt: null,
      edge_request_id: null,
      detail,
    },
    BLOCKED_EXIT,
  );
}

function failed(code: string, detail: string, apex: string | null = null): never {
  throw new RunnerExit(
    {
      tool: "playwright",
      package: "e2e",
      suite: SUITE,
      status: "fail",
      code,
      apex_host: apex,
      agent_host: null,
      cookie: null,
      cookie_probe: null,
      receipt: null,
      edge_request_id: null,
      detail,
    },
    1,
  );
}

/** Exact https origin: no credentials, no path, no query, no fragment. */
function originHost(value: string | undefined, name: string): string {
  if (value === undefined || !/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/?$/.test(value)) {
    blocked("ORIGIN_INVALID", `${name} must be an exact https origin`);
  }
  return new URL(value).host.split(":")[0] as string;
}

/**
 * Host-only is decided by the presence of a `Domain=` attribute in the raw
 * header, not by what a cookie jar later reports: a jar normalises away the
 * distinction this test exists to catch.
 */
function parseSetCookie(header: string): {
  readonly hostOnly: boolean;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: string | null;
} {
  const attributes = header
    .split(";")
    .slice(1)
    .map((part) => part.trim().toLowerCase());
  const sameSite = attributes.find((a) => a.startsWith("samesite="));
  return {
    hostOnly: !attributes.some((a) => a.startsWith("domain=")),
    httpOnly: attributes.includes("httponly"),
    secure: attributes.includes("secure"),
    sameSite: sameSite === undefined ? null : sameSite.slice("samesite=".length),
  };
}

function looksLikeChallenge(url: string, body: string): boolean {
  return (
    /\/challenge\/|\/signin\/rejected|captcha|deniedsigninrejected/i.test(url) ||
    /verify it.s you|couldn.t sign you in|2-step verification/i.test(body)
  );
}

async function main(): Promise<Omit<Record_, "duration_ms">> {
  // Configuration arrives as ONE bounded JSON record on stdin, never through
  // argv or the environment. Chromium is spawned from this process, so anything
  // left in `process.env` would be inherited by the browser and every renderer
  // it forks; a secret that is never in the environment cannot be.
  // Read to EOF and validate EXACT bytes: one record, one trailing LF, nothing
  // after it. The cap counts BYTES, not UTF-16 units, so a multi-byte payload
  // cannot exceed the intended bound while passing a character-count check.
  // ROOT CAUSE, measured on bun 1.3.8 / macOS: `Bun.stdin.stream()` never
  // observes end-of-stream when stdin is a FIFO. The record arrives in full —
  // the descriptor's offset equals its length and no writer remains — and the
  // process then blocks forever. The same code terminates over a plain pipe, so
  // the defect only appears once the real transport is used. A bounded
  // synchronous read is not subject to it.
  //
  // MAX+1 is read deliberately: reading exactly MAX cannot distinguish a full
  // record from an overflowing one, and over-cap must be refused, not truncated.
  const buffer = Buffer.alloc(MAX_CONFIG_RECORD_BYTES + 1);
  let total = 0;
  for (;;) {
    let read = 0;
    try {
      read = readSync(0, buffer, total, buffer.length - total, null);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      // EINTR is a genuine, bounded interruption and is retried. EAGAIN is NOT:
      // a non-blocking descriptor would make this an unbounded CPU spin, and the
      // runner's deadline is not armed until after this loop. Typed refusal.
      if (code === "EINTR") continue;
      if (code === "EOF") break;
      if (code === "EAGAIN") {
        blocked("CONFIG_STDIN_NONBLOCKING", "stdin is non-blocking; refusing to spin on it");
      }
      throw error;
    }
    if (read === 0) break;
    total += read;
    if (total > MAX_CONFIG_RECORD_BYTES) {
      blocked("CONFIG_RECORD_TOO_LARGE", "the configuration record exceeded its byte bound");
    }
  }
  // FATAL decoding: a malformed byte is a refusal, never U+FFFD substituted into
  // a credential field.
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
  } catch {
    blocked("CONFIG_RECORD_INVALID", "the configuration record is not valid UTF-8");
  }
  const lines = raw.split("\n");
  if (lines.length !== 2 || lines[1] !== "") {
    blocked("CONFIG_RECORD_INVALID", "expected exactly one LF-terminated configuration record");
  }

  let previewUrl: string | undefined;
  let workerUrl: string | undefined;
  let user: string | undefined;
  let password: string | undefined;
  try {
    const parsed = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    previewUrl = typeof parsed.previewUrl === "string" ? parsed.previewUrl : undefined;
    workerUrl = typeof parsed.workerUrl === "string" ? parsed.workerUrl : undefined;
    user = typeof parsed.user === "string" ? parsed.user : undefined;
    password = typeof parsed.password === "string" ? parsed.password : undefined;
  } catch {
    // The message could quote the record, so only the class is reported.
    blocked("CONFIG_RECORD_INVALID", "the configuration record on stdin was not valid JSON");
  }

  if (!previewUrl || !workerUrl || !user || !password) {
    blocked(
      "CONFIG_ABSENT",
      "the stdin record must carry previewUrl, workerUrl, user and password; this runner has no storage-state fallback because a jar cannot prove what the origin sent",
    );
  }

  const apexHost = originHost(previewUrl, "ASIMP_S6_PREVIEW_URL");
  const agentHost = originHost(workerUrl, "ASIMP_S6_WORKER_URL");
  if (apexHost === agentHost) {
    blocked("PLANES_NOT_SPLIT", "the two origins resolve to one host", apexHost);
  }

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  // A single monotonic bound over the whole run, including browser teardown.
  const budget = setTimeout(() => {
    // A hung await cannot be unwound by throwing, so this path exits the
    // process — but it closes the browser FIRST, with its own bound, instead of
    // trusting exit to tidy up. Exiting immediately here is what would orphan
    // Chromium. If even the close hangs, the inner grace fires and the shell's
    // process-group sweep is the remaining backstop.
    void (async () => {
      const grace = setTimeout(() => process.exit(1), CLOSE_GRACE_MS);
      grace.unref?.();
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      clearTimeout(grace);
      emit({
        tool: "playwright",
        package: "e2e",
        suite: SUITE,
        status: "fail",
        code: "RUNNER_DEADLINE_EXCEEDED",
        apex_host: apexHost,
        agent_host: agentHost,
        cookie: null,
        cookie_probe: null,
        receipt: null,
        edge_request_id: null,
        detail: `the runner exceeded its ${TOTAL_BUDGET_MS}ms budget`,
      });
      process.exit(1);
    })();
  }, TOTAL_BUDGET_MS);
  budget.unref?.();

  try {
    try {
      browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
    } catch (error) {
      blocked(
        "PLAYWRIGHT_BROWSER_MISSING",
        `chromium is not installed for this Playwright version: ${(error as Error)?.name ?? "Error"}`,
        apexHost,
      );
    }
    context = await browser.newContext();
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);

    // Capture the session cookie exactly as the Agora origin asserted it. Only
    // the attribute half of the header is retained; the value is dropped here
    // and never enters a variable that is logged.
    let observed: ReturnType<typeof parseSetCookie> | undefined;
    // `headersArray()` is async, so each observation is tracked and drained
    // before the assertion runs. An un-awaited async listener would let the
    // check read `observed` before the header that sets it has been parsed —
    // a race that would report "no Set-Cookie seen" on a correct deployment.
    const pending: Promise<void>[] = [];
    context.on("response", (response: Response) => {
      if (new URL(response.url()).host.split(":")[0] !== apexHost) return;
      pending.push(
        (async () => {
          for (const header of await response.headersArray()) {
            if (header.name.toLowerCase() !== "set-cookie") continue;
            for (const line of header.value.split("\n")) {
              if (line.split("=")[0]?.trim() === SESSION_COOKIE_NAME) {
                observed = parseSetCookie(line);
              }
            }
          }
        })().catch(() => undefined),
      );
    });

    const page = await context.newPage();
    // ONE honest request-correlation value: the edge's `x-vercel-id`, nullable.
    //
    // It is NOT a build or revision pin, and this makes no such claim. Earlier
    // revisions called it "immutable deployment evidence" and also folded
    // `x-vercel-deployment-url` into the same field — two different kinds of
    // identity behind one overclaiming name. If a deployment identity is ever
    // required, it needs its own field and its own validation against a source
    // the platform supports for that purpose.
    const consoleResponse = await page.goto(`${previewUrl.replace(/\/$/, "")}/console`);
    const edgeRequestId: string | null = consoleResponse?.headers()["x-vercel-id"] ?? null;

    // The console is behind Auth.js; an unauthenticated visit offers Google.
    const signIn = page.getByRole("button", { name: /sign in with google/i });
    if ((await signIn.count()) > 0) {
      await signIn.first().click();
    }

    // Real Google sign-in. Bot challenges are common and are reported as
    // blocked, never as a failure of the seam and never as a pass.
    try {
      await page.waitForURL(/accounts\.google\.com/, { timeout: NAVIGATION_TIMEOUT_MS });
      await page.locator('input[type="email"]').fill(user);
      await page.getByRole("button", { name: /next/i }).click();
      await page.locator('input[type="password"]').waitFor({ state: "visible" });
      // `fill` does not log its argument; the password never reaches a record.
      await page.locator('input[type="password"]').fill(password);
      await page.getByRole("button", { name: /next/i }).click();
      await page.waitForURL(new RegExp(apexHost.replace(/\./g, "\\.")), {
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    } catch {
      const currentUrl = page.url();
      const body = await page.content().catch(() => "");
      if (looksLikeChallenge(currentUrl, body)) {
        blocked(
          "GOOGLE_LOGIN_CHALLENGED",
          "Google interrupted the automated sign-in with a verification challenge; provision a test account exempt from the challenge, then re-run",
          apexHost,
        );
      }
      failed(
        "GOOGLE_LOGIN_FAILED",
        "the configured test account did not reach the Agora origin",
        apexHost,
      );
    }

    // Drain every header observation before deciding what was seen.
    await Promise.all(pending);

    if (observed === undefined) {
      failed(
        "SET_COOKIE_NOT_OBSERVED",
        "no session Set-Cookie header was seen from the Agora origin during sign-in",
        apexHost,
      );
    }

    // The jar half of the claim: scoped to the apex, absent for the agent host.
    const jar = await context.cookies();
    const session = jar.filter((c) => c.name === SESSION_COOKIE_NAME);
    const cookie: CookieAttributes = {
      host_only: observed.hostOnly,
      http_only: observed.httpOnly,
      secure: observed.secure,
      same_site: observed.sameSite,
      scoped_to_apex: session.length === 1 && session[0]?.domain.replace(/^\./, "") === apexHost,
      present_for_agent_host: jar.some((c) => c.domain.replace(/^\./, "") === agentHost),
    };

    const cookieOk =
      cookie.host_only &&
      cookie.http_only &&
      cookie.secure &&
      cookie.same_site === "lax" &&
      cookie.scoped_to_apex &&
      !cookie.present_for_agent_host;

    if (!cookieOk) {
      throw new RunnerExit(
        {
          tool: "playwright",
          package: "e2e",
          suite: SUITE,
          status: "fail",
          code: "COOKIE_NOT_HOST_ONLY",
          apex_host: apexHost,
          agent_host: agentHost,
          cookie,
          cookie_probe: null,
          receipt: null,
          edge_request_id: edgeRequestId,
          detail: "the live Set-Cookie header or the resulting jar failed host-only apex scoping",
        },
        1,
      );
    }

    // Ask the agent host for a sponsor route from the LOGGED-IN browser.
    //
    // Note precisely what this is NOT. `context.request` shares the browser jar,
    // and the session cookie is host-only on the apex, so the jar does not
    // attach it to an agent-host request at all — it is OMITTED, by the same
    // machinery a real browser would use. Nothing is "presented and refused".
    // `cookie.present_for_agent_host` is the direct evidence of that omission.
    //
    // The expected outcome is therefore an exact 403 WRONG_PRINCIPAL for a
    // request carrying no credential. On its own that is also what a stranger
    // gets, so the shell issues the identical request from a sessionless client
    // and requires the same answer; agreement is what shows an apex session buys
    // nothing here.
    // Redirects are REFUSED, not followed. A 3xx to the apex would move this
    // request onto the plane that does consult cookies, and a 403 collected
    // there would say nothing about the agent host — it would quietly invalidate
    // both the host-only and the non-consultation claims.
    const probeUrl = `${workerUrl.replace(/\/$/, "")}/v1/enrollments/proposals`;
    const probe = await context.request.get(probeUrl, {
      failOnStatusCode: false,
      maxRedirects: 0,
    });

    // The answer must have come from the exact configured Worker origin and
    // route, not from wherever a redirect chain happened to land.
    const finalUrl = new URL(probe.url());
    const expectedUrl = new URL(probeUrl);
    if (
      finalUrl.host !== expectedUrl.host ||
      finalUrl.protocol !== expectedUrl.protocol ||
      finalUrl.pathname !== expectedUrl.pathname
    ) {
      throw new RunnerExit(
        {
          tool: "playwright",
          package: "e2e",
          suite: SUITE,
          status: "fail",
          code: "AGENT_HOST_PROBE_REDIRECTED",
          apex_host: apexHost,
          agent_host: agentHost,
          cookie,
          cookie_probe: { status: probe.status(), code: null },
          receipt: null,
          edge_request_id: edgeRequestId,
          detail:
            "the agent-host probe did not terminate on the exact configured Worker origin and route",
        },
        1,
      );
    }
    let probeCode: string | null = null;
    try {
      const parsed = (await probe.json()) as { code?: unknown };
      probeCode = typeof parsed.code === "string" ? parsed.code : null;
    } catch {
      probeCode = null;
    }
    const cookieProbe = { status: probe.status(), code: probeCode };

    if (cookieProbe.status !== 403 || cookieProbe.code !== "WRONG_PRINCIPAL") {
      throw new RunnerExit(
        {
          tool: "playwright",
          package: "e2e",
          suite: SUITE,
          status: "fail",
          code: "AGENT_HOST_NOT_REFUSED_FOR_LOGGED_IN_BROWSER",
          apex_host: apexHost,
          agent_host: agentHost,
          cookie,
          cookie_probe: cookieProbe,
          receipt: null,
          edge_request_id: edgeRequestId,
          detail:
            "a browser holding a live apex session did not receive the exact 403 WRONG_PRINCIPAL refusal from the agent host",
        },
        1,
      );
    }

    // The real Server Action, reached the way a sponsor reaches it.
    await page.goto(`${previewUrl.replace(/\/$/, "")}/console`);
    const mint = page.getByRole("button", { name: /^Mint a join URL$/ });
    if ((await mint.count()) === 0) {
      blocked(
        "CONSOLE_MINT_UNAVAILABLE",
        "the console did not offer the mint control; the sponsor may not be bootstrapped on this deployment",
        apexHost,
      );
    }
    // Pre-action state. Without this the runner could report an enrollment that
    // was already on the page and call it the product of its own click.
    const before = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    const beforeIds = new Set(before.match(new RegExp(ENROLLMENT_ID, "g")) ?? []);

    await mint.first().click();

    // Read ONLY the public enrollment id, and only one that was NOT present
    // before the click. The join URL's `#v1.<secret>` is a credential and is
    // never matched, captured, or emitted.
    let enrollmentId: string | null = null;
    const deadline = Date.now() + ACTION_TIMEOUT_MS;
    while (Date.now() < deadline && enrollmentId === null) {
      const text = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      enrollmentId =
        (text.match(new RegExp(ENROLLMENT_ID, "g")) ?? []).find((id) => !beforeIds.has(id)) ?? null;
      if (enrollmentId === null) await page.waitForTimeout(500);
    }
    if (enrollmentId === null) {
      failed(
        "MINT_RECEIPT_NOT_OBSERVED",
        "the console rendered no enrollment id that was absent before the action",
        apexHost,
      );
    }
    const receipt = { enrollment_id: enrollmentId, absent_before_action: true };

    // The pass record is RETURNED, not emitted here.
    //
    // Emitting inside `try` published a success before `finally` had closed the
    // context and the browser, so a teardown failure could follow an already
    // published pass — and exit 0 with Chromium still up. The caller emits it
    // only after cleanup has actually completed.
    return {
      tool: "playwright",
      package: "e2e",
      suite: SUITE,
      status: "pass",
      code: "OK",
      apex_host: apexHost,
      agent_host: agentHost,
      cookie,
      cookie_probe: cookieProbe,
      receipt,
      edge_request_id: edgeRequestId,
      detail:
        "live Set-Cookie proved host-only apex scoping, the cookie was not sent to the agent host and that request answered exactly 403 WRONG_PRINCIPAL, and the real console Server Action minted an enrollment",
    };
  } finally {
    clearTimeout(budget);
    // Bounded teardown, and its failure is NOT swallowed. A close that throws
    // must not be reported as exit 0 with a browser still running.
    const teardown: unknown[] = [];
    await context?.close().catch((error: unknown) => teardown.push(error));
    await browser?.close().catch((error: unknown) => teardown.push(error));
    if (teardown.length > 0) {
      teardownFailed = teardown.length;
    }
  }
}

/** Set by `main`'s `finally` when context/browser teardown threw. */
let teardownFailed = 0;

// The record is emitted and the status applied only after `main`'s `finally`
// has closed the context and the browser. A `RunnerExit` thrown deep inside the
// run therefore cannot leave Chromium behind, which an immediate `process.exit`
// at the throw site could.
try {
  const passRecord = await main();
  // Cleanup has completed by now. A teardown failure outranks the pass.
  if (teardownFailed > 0) {
    emit({
      ...passRecord,
      status: "fail",
      code: "RUNNER_TEARDOWN_FAILED",
      detail: `the run succeeded but ${teardownFailed} teardown step(s) failed; the browser may still be running`,
    });
    process.exit(1);
  }
  emit(passRecord);
} catch (error) {
  if (error instanceof RunnerExit) {
    emit(error.record);
    process.exit(error.status);
  }
  // An unexpected fault is still a runner failure, reported in the same shape
  // and only after cleanup. The message is withheld: it can quote page content.
  emit({
    tool: "playwright",
    package: "e2e",
    suite: SUITE,
    status: "fail",
    code: "RUNNER_UNEXPECTED_FAULT",
    apex_host: null,
    agent_host: null,
    cookie: null,
    cookie_probe: null,
    receipt: null,
    edge_request_id: null,
    detail: `the runner failed with ${(error as Error)?.constructor?.name ?? "Error"}`,
  });
  process.exit(1);
}
