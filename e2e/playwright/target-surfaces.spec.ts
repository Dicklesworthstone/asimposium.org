import { type APIRequestContext, expect, test } from "@playwright/test";

/**
 * Tamper-evidence rule: a green run must prove the REAL ASImposium staging
 * planes, not an arbitrary look-alike server someone pointed the env at.
 * Mock-free requests are not identity; the origin itself is constrained to
 * operator-owned *.asimposium.org subdomains, minus the production family,
 * so only a machine this project actually controls can produce a pass.
 */
function requiredStagingOrigin(variableName: string): string {
  const supplied = process.env[variableName];
  if (!supplied) {
    throw new Error(`${variableName} is required; refusing to infer a staging target.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(supplied);
  } catch {
    throw new Error(
      `${variableName} must be an HTTPS origin without credentials, a path, query, or fragment, on an operator-owned *.asimposium.org subdomain.`,
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    new Set([
      "a.asimposium.org",
      "artifacts.asimposium.org",
      "asimposium.org",
      "www.asimposium.org",
    ]).has(hostname) ||
    !hostname.endsWith(".asimposium.org")
  ) {
    throw new Error(
      `${variableName} must be an HTTPS origin without credentials, a path, query, or fragment, and must be an operator-owned *.asimposium.org subdomain other than the production family.`,
    );
  }

  return parsed.origin;
}

const stagingOrigins =
  process.env.ASIMPOSIUM_PLAYWRIGHT_ENTRY === "1"
    ? {
        agent: requiredStagingOrigin("ASIMPOSIUM_STAGING_AGENT_BASE_URL"),
        agora: requiredStagingOrigin("ASIMPOSIUM_STAGING_AGORA_BASE_URL"),
      }
    : undefined;

async function expectPublicSurface(
  request: APIRequestContext,
  origin: string,
  path: string,
  expectedText: RegExp,
  surfaceName: string,
): Promise<void> {
  const response = await request.get(`${origin}${path}`, {
    failOnStatusCode: false,
    timeout: 15_000,
  });

  expect(response.status(), `${surfaceName} must return a 2xx response.`).toBeGreaterThanOrEqual(
    200,
  );
  expect(response.status(), `${surfaceName} must return a 2xx response.`).toBeLessThan(300);
  expect(
    await response.text(),
    `${surfaceName} must identify ASImposium rather than an unrelated fallback.`,
  ).toMatch(expectedText);
}

if (process.env.ASIMPOSIUM_PLAYWRIGHT_ENTRY === "1") {
  test("agent handbook and capabilities are served from the configured staging agent origin", async ({
    request,
  }) => {
    const origin = stagingOrigins?.agent;
    if (origin === undefined) throw new Error("Playwright staging preflight was not completed.");

    await expectPublicSurface(request, origin, "/", /asimp|asimposium/i, "agent handbook");
    await expectPublicSurface(
      request,
      origin,
      "/capabilities",
      /asimp|asimposium/i,
      "agent capabilities",
    );
  });

  test("Agora public root is served from the configured staging human origin", async ({
    request,
  }) => {
    const origin = stagingOrigins?.agora;
    if (origin === undefined) throw new Error("Playwright staging preflight was not completed.");

    await expectPublicSurface(request, origin, "/", /asimp|asimposium/i, "Agora public root");
  });
}
