#!/usr/bin/env bun
/**
 * OPS.2a browser adapter — a real Chromium assertion against a real local page.
 *
 * Replaces an `ADAPTER_UNAVAILABLE` placeholder with a genuine browser
 * navigation: Playwright launches Chromium, loads a page served from a loopback
 * listener, and asserts rendered DOM state. Nothing here is simulated; if the
 * browser cannot launch, the adapter says so and exits 78 rather than pretending.
 *
 * ## Artifact policy — deliberately restrictive
 *
 * Screenshots, videos, traces and HAR files are **disabled**, not merely
 * redacted. A screenshot of a signed-in page is the single richest accidental
 * disclosure a test suite can produce: it can carry a session cookie banner, a
 * sponsor's email, or a private workshop body, and no redaction pass can read
 * pixels reliably. The adapter therefore captures none, and asserts on text
 * content it selected itself. What it reports is a bounded set of scalar facts.
 *
 * ## Modes
 *
 * `--mode ok`            asserts the heading the local page actually renders.
 * `--mode planted-fail`  asserts a heading the page does not render, proving the
 *                        assertion can fail rather than passing vacuously.
 *
 * Exits 78 with `BROWSER_ADAPTER_UNAVAILABLE` when no Chromium is installed.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const BLOCKED_EXIT_CODE = 78;
const NAVIGATION_TIMEOUT_MS = 10_000;
const ADAPTER_WATCHDOG_MS = 30_000;

type Mode = "ok" | "planted-fail";

/**
 * Structural seam over Playwright.
 *
 * The adapter drives a real browser, but this file is compiled by the *root*
 * tsconfig, which owns only `scripts/**` and does not depend on Playwright —
 * the dependency belongs to the `e2e` workspace. A static `import` would
 * therefore break the root typecheck on every machine, including CI, purely
 * because of where the types live.
 *
 * So the import is resolved through a non-literal specifier and landed on the
 * narrow interface below. This is not `any`-washing: every method the adapter
 * calls is declared here with its real signature, so a Playwright API change
 * still fails the typecheck. What it avoids is a compile-time dependency on a
 * package this tsconfig has no business owning.
 */
interface BrowserPage {
  setDefaultTimeout(timeout: number): void;
  goto(
    url: string,
    options?: { waitUntil?: string; timeout?: number },
  ): Promise<{
    status(): number;
  } | null>;
  textContent(selector: string): Promise<string | null>;
  getAttribute(selector: string, name: string): Promise<string | null>;
}

interface BrowserContext {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

interface LaunchedBrowser {
  newContext(options?: {
    recordVideo?: undefined;
    recordHar?: undefined;
    serviceWorkers?: "block" | "allow";
  }): Promise<BrowserContext>;
  close(): Promise<void>;
}

interface ChromiumLauncher {
  launch(options?: { headless?: boolean }): Promise<LaunchedBrowser>;
}

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..");
/** The workspace that actually declares Playwright (`e2e/package.json`). */
const E2E_MANIFEST = join(REPOSITORY_ROOT, "e2e", "package.json");
const PLAYWRIGHT_SPECIFIERS = ["@playwright/test", "playwright"] as const;

/**
 * Load Chromium, resolving from the workspace that owns the dependency.
 *
 * A bare `import("@playwright/test")` resolves relative to *this file*, and
 * this file lives in `scripts/`, which declares no Playwright. The package is
 * installed for `e2e/`, so a bare import reports "missing" while the dependency
 * is sitting right there — a false blocker, and the worst kind, because it
 * looks exactly like an honest one.
 *
 * So resolution is anchored at `e2e/package.json` with `createRequire`, and the
 * *resolved absolute path* is then imported. Hoisted layouts still work through
 * the plain specifier attempted first.
 */
/**
 * Point Playwright at its installed browsers.
 *
 * The harness gives every child a fixed environment with no `HOME`, which is
 * the right policy — an inherited environment is how an unlabelled secret
 * reaches a log. But Playwright locates its browser cache relative to the home
 * directory, so without help it reports "Chromium could not launch" while a
 * perfectly good Chromium sits in the cache: another false blocker.
 *
 * `os.homedir()` reads the passwd database rather than `$HOME`, so this
 * recovers the well-known cache location without inheriting any ambient value.
 * An explicit `PLAYWRIGHT_BROWSERS_PATH` always wins.
 */
function ensureBrowsersPath(): string | undefined {
  const explicit = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const candidates =
    process.platform === "darwin"
      ? [join(homedir(), "Library", "Caches", "ms-playwright")]
      : [join(homedir(), ".cache", "ms-playwright")];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found !== undefined) process.env.PLAYWRIGHT_BROWSERS_PATH = found;
  return found;
}

async function loadChromium(): Promise<ChromiumLauncher | undefined> {
  ensureBrowsersPath();
  for (const specifier of PLAYWRIGHT_SPECIFIERS) {
    try {
      // Non-literal specifier: deliberately opaque to the root tsconfig.
      const loaded = (await import(specifier)) as unknown as { chromium?: ChromiumLauncher };
      if (loaded.chromium !== undefined) return loaded.chromium;
    } catch {
      // Not resolvable from here; try the e2e workspace below.
    }
  }
  if (!existsSync(E2E_MANIFEST)) return undefined;
  const requireFromE2e = createRequire(E2E_MANIFEST);
  for (const specifier of PLAYWRIGHT_SPECIFIERS) {
    try {
      const resolved = requireFromE2e.resolve(specifier);
      const loaded = (await import(resolved)) as unknown as { chromium?: ChromiumLauncher };
      if (loaded.chromium !== undefined) return loaded.chromium;
    } catch {
      // Try the next specifier; a genuinely missing package is a blocker.
    }
  }
  return undefined;
}

function say(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ adapter: "browser", ...record })}\n`);
}

function parseMode(argv: readonly string[]): Mode {
  const index = argv.indexOf("--mode");
  const value = index >= 0 ? argv[index + 1] : "ok";
  if (value !== "ok" && value !== "planted-fail") {
    say({
      status: "fail",
      code: "USAGE",
      detail: "usage: browser-assert.ts --mode <ok|planted-fail>",
    });
    process.exit(2);
  }
  return value;
}

/**
 * The page under test. Authored here so the assertion targets content this
 * adapter controls, never product markup — a harness proof must not silently
 * become a product assertion.
 */
const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>harness page</title></head>
<body>
  <h1 id="heading">harness adapter page</h1>
  <p id="status" data-state="ready">ready</p>
</body></html>`;

async function main(): Promise<number> {
  const mode = parseMode(process.argv.slice(2));

  const chromium = await loadChromium();
  if (chromium === undefined) {
    say({
      status: "blocked",
      code: "BROWSER_ADAPTER_UNAVAILABLE",
      missing: "@playwright/test",
      package_resolved: false,
      detail:
        "Playwright does not resolve from this file or from the e2e workspace, so Chromium was never launched. `e2e/package.json` declares @playwright/test; install the workspace. No browser behavior was exercised.",
    });
    return BLOCKED_EXIT_CODE;
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 20,
    fetch: () =>
      new Response(PAGE_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      }),
  });

  const watchdog = setTimeout(() => {
    say({
      status: "fail",
      code: "BROWSER_ADAPTER_WATCHDOG",
      detail: "The adapter exceeded its hard ceiling and force-exited; no result is claimed.",
    });
    process.exit(1);
  }, ADAPTER_WATCHDOG_MS);
  watchdog.unref?.();

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      // Two very different blockers wear the same exception, and conflating
      // them is how a false blocker hides: "the package is missing" means the
      // workspace is not installed, while "this Playwright wants a browser
      // build the cache does not have" means the package resolved fine. Only
      // the build name is reported — the full path names a user's home.
      const message = error instanceof Error ? error.message : "";
      const build = /chromium[_a-z]*-\d+/.exec(message)?.[0];
      say({
        status: "blocked",
        code: "BROWSER_ADAPTER_UNAVAILABLE",
        missing: build === undefined ? "chromium-build" : build,
        package_resolved: true,
        error_class: error instanceof Error ? error.name : "unknown",
        detail:
          build === undefined
            ? "Chromium could not launch; run `bunx playwright install chromium` for the Playwright version this workspace declares. No browser behavior was exercised."
            : `The resolved Playwright expects browser build ${build}, which is not in the Playwright cache; run \`bunx playwright install chromium\` from the e2e workspace. No browser behavior was exercised.`,
      });
      return BLOCKED_EXIT_CODE;
    }

    // Explicitly artifact-free: no video directory, no HAR, no trace, and the
    // adapter never calls page.screenshot().
    const context = await browser.newContext({
      recordVideo: undefined,
      recordHar: undefined,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);

    const response = await page.goto(`http://127.0.0.1:${server.port}/`, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    const heading = (await page.textContent("#heading"))?.trim() ?? "";
    const state = await page.getAttribute("#status", "data-state");
    const expectedHeading =
      mode === "ok" ? "harness adapter page" : "a heading this page never renders";
    const passed = response?.status() === 200 && heading === expectedHeading && state === "ready";

    say({
      status: passed ? "pass" : "fail",
      code: passed ? "BROWSER_ASSERTION_VERIFIED" : "BROWSER_ASSERTION_MISMATCH",
      mode,
      http_status: response?.status() ?? null,
      // Bounded, adapter-authored strings only — never page-supplied user data.
      expected_heading: expectedHeading.slice(0, 64),
      observed_heading: heading.slice(0, 64),
      observed_state: state,
      artifacts_captured: "none",
      screenshot_policy: "disabled",
      trace_policy: "disabled",
      detail: passed
        ? "Chromium loaded a local page over loopback and the asserted DOM text matched; no screenshot, video, HAR or trace was captured."
        : "The rendered DOM text did not match the asserted value; no screenshot, video, HAR or trace was captured.",
    });
    await context.close();
    return passed ? 0 : 1;
  } catch (error) {
    say({
      status: "fail",
      code: "BROWSER_ADAPTER_ERROR",
      error_class: error instanceof Error ? error.name : "unknown",
      detail: "The browser adapter failed before it could complete its assertion.",
    });
    return 1;
  } finally {
    clearTimeout(watchdog);
    // Bounded cleanup in dependency order: browser first so no page holds the
    // socket, then the listener.
    try {
      await browser?.close();
    } catch {
      /* the process is exiting anyway */
    }
    try {
      server.stop(true);
    } catch {
      /* the process is exiting anyway */
    }
  }
}

process.exit(await main());
