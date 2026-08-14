import { expect, test, type APIRequestContext } from "@playwright/test";

function requiredStagingOrigin(variableName: string): string {
  const supplied = process.env[variableName];
  if (!supplied) {
    throw new Error(`${variableName} is required; refusing to infer a staging target.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(supplied);
  } catch {
    throw new Error(`${variableName} must be an HTTPS origin without credentials, a path, query, or fragment.`);
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${variableName} must be an HTTPS origin without credentials, a path, query, or fragment.`);
  }

  return parsed.origin;
}

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

  expect(response.status(), `${surfaceName} must return a 2xx response.`).toBeGreaterThanOrEqual(200);
  expect(response.status(), `${surfaceName} must return a 2xx response.`).toBeLessThan(300);
  expect(await response.text(), `${surfaceName} must identify ASImposium rather than an unrelated fallback.`).toMatch(expectedText);
}

if (process.env.ASIMPOSIUM_PLAYWRIGHT_ENTRY === "1") {
  test("agent handbook and capabilities are served from the configured staging agent origin", async ({ request }) => {
    const origin = requiredStagingOrigin("ASIMPOSIUM_STAGING_AGENT_BASE_URL");

    await expectPublicSurface(request, origin, "/", /asimp|asimposium/i, "agent handbook");
    await expectPublicSurface(request, origin, "/capabilities", /asimp|asimposium/i, "agent capabilities");
  });

  test("Agora public root is served from the configured staging human origin", async ({ request }) => {
    const origin = requiredStagingOrigin("ASIMPOSIUM_STAGING_AGORA_BASE_URL");

    await expectPublicSurface(request, origin, "/", /asimp|asimposium/i, "Agora public root");
  });
}
