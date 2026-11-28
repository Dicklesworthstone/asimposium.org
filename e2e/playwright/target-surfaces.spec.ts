import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import {
  ANONYMOUS_AGORA_PATHS,
  checkStrictCspHeaders,
  findDishonestProvedBanner,
  formatPlaywrightTelemetry,
  isPrivateCacheControl,
  parsePngDimensions,
  targetOgImageUrl,
  validateProblemId,
  validateStagingOrigin,
} from "./target-surfaces.helpers";

const allowLoopbackRehearsal = process.env.ASIMPOSIUM_PLAYWRIGHT_LOOPBACK_REHEARSAL === "1";

const stagingOrigins =
  process.env.ASIMPOSIUM_PLAYWRIGHT_ENTRY === "1"
    ? {
        agent: validateStagingOrigin(
          "ASIMPOSIUM_STAGING_AGENT_BASE_URL",
          process.env.ASIMPOSIUM_STAGING_AGENT_BASE_URL,
          { allowLoopbackRehearsal },
        ),
        agora: validateStagingOrigin(
          "ASIMPOSIUM_STAGING_AGORA_BASE_URL",
          process.env.ASIMPOSIUM_STAGING_AGORA_BASE_URL,
          { allowLoopbackRehearsal },
        ),
      }
    : undefined;

const sponsorStorageStatePath =
  process.env.ASIMPOSIUM_STAGING_SPONSOR_STORAGE_STATE?.trim() || undefined;
const workshopCanary = process.env.ASIMPOSIUM_STAGING_WORKSHOP_CANARY?.trim() || undefined;
const explicitWorkshopPath = process.env.ASIMPOSIUM_STAGING_WORKSHOP_PATH?.trim() || undefined;
const explicitProblemId = process.env.ASIMPOSIUM_PLAYWRIGHT_PROBLEM_ID?.trim() || undefined;

const USER_AGENT = "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)";

async function expectPublicApiSurface(
  request: APIRequestContext,
  origin: string,
  path: string,
  expectedText: RegExp,
  surfaceName: string,
): Promise<string> {
  const response = await request.get(`${origin}${path}`, {
    failOnStatusCode: false,
    timeout: 15_000,
    headers: { "user-agent": USER_AGENT },
  });

  expect(response.status(), `${surfaceName} must return a 2xx response.`).toBeGreaterThanOrEqual(
    200,
  );
  expect(response.status(), `${surfaceName} must return a 2xx response.`).toBeLessThan(300);
  const body = await response.text();
  expect(
    body,
    `${surfaceName} must identify ASImposium rather than an unrelated fallback.`,
  ).toMatch(expectedText);
  return body;
}

async function resolveTargetProblemId(
  request: APIRequestContext,
  agentOrigin: string,
): Promise<string | null> {
  if (explicitProblemId) {
    expect(
      validateProblemId(explicitProblemId),
      "ASIMPOSIUM_PLAYWRIGHT_PROBLEM_ID must match canonical problem ID grammar.",
    ).toBe(true);
    return explicitProblemId;
  }

  const response = await request.get(`${agentOrigin}/problems.json`, {
    failOnStatusCode: false,
    timeout: 15_000,
    headers: { "user-agent": USER_AGENT },
  });
  if (response.status() !== 200) return null;
  try {
    const parsed = (await response.json()) as { problems?: Array<{ id?: unknown }> };
    const firstId = parsed?.problems?.[0]?.id;
    if (typeof firstId === "string" && validateProblemId(firstId)) {
      return firstId;
    }
  } catch {
    return null;
  }
  return null;
}

async function inspectAgoraPage(
  page: Page,
  agoraOrigin: string,
  path: string,
  jsEnabled: boolean,
  options: {
    readonly principal: "anonymous" | "sponsor";
    readonly requirePrivateCache?: boolean;
    readonly forbiddenCanary?: string;
    readonly requiredCanary?: string;
    readonly expectedHeading?: string;
    readonly allowStatusCodes?: readonly number[];
  },
): Promise<{
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly ogImageHref: string | null;
  readonly workshopLinks: string[];
}> {
  const startedAt = Date.now();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  const onConsole = (msg: { type(): string; text(): string }) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  };
  const onPageError = (err: Error) => {
    pageErrors.push(err.message);
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  try {
    const response = await page.goto(`${agoraOrigin}${path}`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(response, `Expected HTTP response for ${path}`).not.toBeNull();
    const status = response?.status() ?? 0;
    const headers = response?.headers() ?? {};

    const allowedStatuses = options.allowStatusCodes ?? [200];
    expect(
      allowedStatuses.includes(status),
      `${path} (js=${jsEnabled ? "on" : "off"}) returned unexpected HTTP ${status}`,
    ).toBe(true);

    if (jsEnabled) {
      await page.waitForTimeout(50);
    }
    if (options.expectedHeading) {
      await expect(
        page.getByRole("heading", { name: options.expectedHeading, exact: true }),
      ).toBeVisible();
    }

    const csp = checkStrictCspHeaders(headers);
    const domSnapshot = await page.evaluate(() => {
      const katexNodes = document.querySelectorAll(".katex").length;
      const katexErrors = document.querySelectorAll(".katex-error").length;
      const bodyText = document.body?.innerText ?? "";
      const badgeTexts = Array.from(
        document.querySelectorAll("[data-disposition], [data-status], [data-badge]"),
      ).map((el) => (el as HTMLElement).innerText ?? "");
      const headingTexts = Array.from(document.querySelectorAll("h1, h2, h3")).map(
        (el) => (el as HTMLElement).innerText ?? "",
      );
      const ogImageHref =
        document.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? null;
      const workshopLinks = Array.from(document.querySelectorAll('a[href^="/console/workshop/"]'))
        .map((el) => el.getAttribute("href"))
        .filter(
          (href): href is string =>
            typeof href === "string" && href.startsWith("/console/workshop/"),
        );
      return {
        katexNodes,
        katexErrors,
        bodyText,
        badgeTexts,
        headingTexts,
        ogImageHref,
        workshopLinks,
      };
    });

    // Chromium natively logs "Failed to load resource: the server responded with a status of 401/403/404"
    // when navigating to an explicitly expected access-boundary refusal (e.g. non-operator /admin).
    const unexpectedConsoleErrors =
      status >= 400 && allowedStatuses.includes(status)
        ? consoleErrors.filter(
            (msg) =>
              !msg.startsWith(
                `Failed to load resource: the server responded with a status of ${status}`,
              ),
          )
        : consoleErrors;

    console.log(
      formatPlaywrightTelemetry({
        url_path: path,
        status,
        js_mode: jsEnabled ? "on" : "off",
        csp_nonce_present: csp.hasNonce,
        console_errors: unexpectedConsoleErrors.length,
        page_errors: pageErrors.length,
        katex_nodes: domSnapshot.katexNodes,
        katex_errors: domSnapshot.katexErrors,
        principal: options.principal,
        duration_ms: Date.now() - startedAt,
      }),
    );

    expect(
      csp.ok,
      `${path} must enforce strict Fable §14 CSP with cryptographic nonce, no unsafe-inline, and nosniff (got defaultSrc=${csp.hasDefaultSrc}, nonce=${csp.hasNonce}, unsafeInline=${csp.hasUnsafeInline}, nosniff=${csp.hasNosniff})`,
    ).toBe(true);

    expect(
      unexpectedConsoleErrors,
      `${path} (js=${jsEnabled ? "on" : "off"}) emitted console.error`,
    ).toEqual([]);
    expect(pageErrors, `${path} (js=${jsEnabled ? "on" : "off"}) threw uncaught pageerror`).toEqual(
      [],
    );
    expect(domSnapshot.katexErrors, `${path} rendered malformed KaTeX (.katex-error)`).toBe(0);

    if (options.requirePrivateCache) {
      expect(
        isPrivateCacheControl(headers["cache-control"]),
        `${path} must carry private/no-store Cache-Control without public/s-maxage`,
      ).toBe(true);
    }

    const rawHtml = options.forbiddenCanary ? await page.content() : "";

    if (status === 200) {
      expect(domSnapshot.bodyText.trim().length, `${path} rendered an empty body`).toBeGreaterThan(
        20,
      );
      const honestyViolation = findDishonestProvedBanner(
        domSnapshot.badgeTexts,
        domSnapshot.headingTexts,
      );
      expect(honestyViolation, `${path} violated Rule A4 honesty`).toBeNull();
    }

    if (options.forbiddenCanary) {
      expect(
        domSnapshot.bodyText.includes(options.forbiddenCanary),
        `Private workshop canary leaked into DOM on ${path}`,
      ).toBe(false);
      expect(
        rawHtml.includes(options.forbiddenCanary),
        `Private workshop canary leaked into HTML on ${path}`,
      ).toBe(false);
    }

    if (options.requiredCanary) {
      expect(
        domSnapshot.bodyText.includes(options.requiredCanary),
        `Expected private workshop canary to be visible to authenticated sponsor on ${path}`,
      ).toBe(true);
    }

    return {
      status,
      headers,
      ogImageHref: domSnapshot.ogImageHref,
      workshopLinks: domSnapshot.workshopLinks,
    };
  } finally {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
}

async function verifyOgImage1200x630(
  request: APIRequestContext,
  page: Page,
  agoraOrigin: string,
  pagePath: string,
  ogImageHref: string | null,
): Promise<void> {
  expect(ogImageHref, `${pagePath} must publish an og:image meta tag`).toBeTruthy();
  const resolved = targetOgImageUrl(ogImageHref as string, agoraOrigin, { allowLoopbackRehearsal });

  const response = await request.get(resolved.toString(), {
    failOnStatusCode: false,
    maxRedirects: 0,
    timeout: 15_000,
    headers: { "user-agent": USER_AGENT },
  });
  expect(response.status(), `OG image for ${pagePath} must return HTTP 200`).toBe(200);
  // The home page uses the site's static JPEG. Scientific cards use the
  // PNG renderer and must keep their lossless output and exact dimensions.
  const expectedType = pagePath === "/" ? "image/jpeg" : "image/png";
  const contentType = response.headers()["content-type"]?.split(";")[0]?.trim().toLowerCase();
  expect(contentType, `OG image for ${pagePath} must be ${expectedType}`).toBe(expectedType);

  const imageBytes = await response.body();
  if (expectedType === "image/png") {
    expect(
      parsePngDimensions(imageBytes),
      `OG image for ${pagePath} must carry a valid PNG IHDR`,
    ).toEqual({ width: 1200, height: 630 });
  } else {
    expect(imageBytes.subarray(0, 3).toString("hex"), "Home OG image must contain JPEG bytes").toBe(
      "ffd8ff",
    );
  }

  // Decode in real Chromium on a clean about:blank document (free of page CSP).
  await page.goto("about:blank");
  const dataUrl = `data:${expectedType};base64,${imageBytes.toString("base64")}`;
  const decoded = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  }, dataUrl);
  expect(decoded, `Chromium failed to decode a 1200x630 image for ${pagePath}`).toEqual({
    width: 1200,
    height: 630,
  });
}

if (process.env.ASIMPOSIUM_PLAYWRIGHT_ENTRY === "1") {
  test.describe.configure({ mode: "serial" });

  test("Stoa staging agent entry surfaces and cursor contract", async ({ request }) => {
    const agentOrigin = stagingOrigins?.agent;
    if (agentOrigin === undefined)
      throw new Error("Playwright staging preflight was not completed.");

    await expectPublicApiSurface(request, agentOrigin, "/", /asimp|asimposium/i, "agent handbook");
    await expectPublicApiSurface(
      request,
      agentOrigin,
      "/capabilities",
      /asimp|asimposium/i,
      "agent capabilities",
    );
    const cursorBody = await expectPublicApiSurface(
      request,
      agentOrigin,
      "/cursor",
      /^\s*\d+\s*$/,
      "agent cursor",
    );
    expect(Number.isSafeInteger(Number(cursorBody.trim()))).toBe(true);
  });

  test("Agora anonymous Chromium rendering, strict CSP, honest labels and 1200x630 share cards", async ({
    browser,
    request,
  }) => {
    test.setTimeout(180_000);
    const agentOrigin = stagingOrigins?.agent;
    const agoraOrigin = stagingOrigins?.agora;
    if (agentOrigin === undefined || agoraOrigin === undefined) {
      throw new Error("Playwright staging preflight was not completed.");
    }

    const problemId = await resolveTargetProblemId(request, agentOrigin);
    const routesToCheck: string[] = [...ANONYMOUS_AGORA_PATHS];
    if (problemId !== null) {
      routesToCheck.push(`/p/${problemId}`);
    }

    const ogTargets = new Map<string, string | null>();

    for (const jsEnabled of [true, false]) {
      const context = await browser.newContext({
        javaScriptEnabled: jsEnabled,
        userAgent: USER_AGENT,
      });
      try {
        const page = await context.newPage();
        for (const route of routesToCheck) {
          const result = await inspectAgoraPage(page, agoraOrigin, route, jsEnabled, {
            principal: "anonymous",
            forbiddenCanary: workshopCanary,
          });
          if (route === "/") {
            await expect(page.locator(".hero-agents a")).toHaveAttribute("href", `${agentOrigin}/`);
            await expect(
              page.getByRole("link", { name: "Agent handbook", exact: true }),
            ).toHaveAttribute("href", `${agentOrigin}/`);
          }
          if (jsEnabled && (route === "/" || route === "/results" || route === `/p/${problemId}`)) {
            ogTargets.set(route, result.ogImageHref);
          }
        }
        if (jsEnabled) {
          for (const [route, ogHref] of ogTargets.entries()) {
            await verifyOgImage1200x630(request, page, agoraOrigin, route, ogHref);
          }
          // Anonymous /console must never be publicly cacheable and must never leak workshop canary bytes.
          await inspectAgoraPage(page, agoraOrigin, "/console", true, {
            principal: "anonymous",
            requirePrivateCache: true,
            forbiddenCanary: workshopCanary,
            allowStatusCodes: [200, 401, 403],
          });
        }
      } finally {
        await context.close();
      }
    }
  });

  if (sponsorStorageStatePath) {
    test("Agora authenticated staging sponsor flows: /console, mint & directives UI, private workshop cache-leak pair, and /admin access boundary", async ({
      browser,
    }) => {
      test.setTimeout(120_000);
      const agoraOrigin = stagingOrigins?.agora;
      if (agoraOrigin === undefined) {
        throw new Error("Playwright staging preflight was not completed.");
      }

      const sponsorContext = await browser.newContext({
        javaScriptEnabled: true,
        userAgent: USER_AGENT,
        storageState: sponsorStorageStatePath,
      });
      try {
        const sponsorPage = await sponsorContext.newPage();
        const consoleResult = await inspectAgoraPage(sponsorPage, agoraOrigin, "/console", true, {
          principal: "sponsor",
          requirePrivateCache: true,
          expectedHeading: "Your account",
        });

        // Inspect private workshop view (explicit path or discovered link) and confirm private cacheability + canary visibility.
        const workshopPath = explicitWorkshopPath ?? consoleResult.workshopLinks[0];
        if (workshopPath) {
          await inspectAgoraPage(sponsorPage, agoraOrigin, workshopPath, true, {
            principal: "sponsor",
            requirePrivateCache: true,
            requiredCanary: workshopCanary,
            expectedHeading: "Private workshop",
          });
        }

        // Check /admin access boundary (200 for operator or 403/404 for non-operator, always private/no-store, never 500).
        await inspectAgoraPage(sponsorPage, agoraOrigin, "/admin", true, {
          principal: "sponsor",
          requirePrivateCache: true,
          allowStatusCodes: [200, 403, 404],
        });
      } finally {
        await sponsorContext.close();
      }
    });
  }
}
