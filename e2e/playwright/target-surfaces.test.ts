import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
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

async function runAsync(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn([command, ...args], {
    env: env as Record<string, string | undefined>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (timedOut) {
    throw new Error(
      `Timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}\nSTDOUT:\n${stdout.slice(-1500)}\nSTDERR:\n${stderr.slice(-1500)}`,
    );
  }
  return { status, stdout, stderr };
}

const REPO_ROOT = resolve(import.meta.dir, "../..");
const HOME_OG_JPEG = readFileSync(join(REPO_ROOT, "apps/web/public/og.jpg"));

/** Builds a valid, decodable 1200x630 RGB PNG in memory without external deps. */
function makeValidPng(width: number, height: number): Buffer {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Uint8Array): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) {
      c = (crcTable[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const typeBytes = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([typeBytes, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // All-zero raw scanlines (1 filter byte + 3*width bytes per row) compress tightly.
  const raw = Buffer.alloc((1 + width * 3) * height);
  const idat = deflateSync(raw);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const VALID_1200_630_PNG = makeValidPng(1200, 630);

test("canonical Agora metadata is probed only on the selected target", () => {
  const staging = "https://staging.asimposium.org";
  expect(targetOgImageUrl("https://asimposium.org/opengraph-image?v=1", staging).href).toBe(
    `${staging}/opengraph-image?v=1`,
  );
  expect(targetOgImageUrl("/opengraph-image", staging).origin).toBe(staging);
  expect(targetOgImageUrl("https://asimposium.org//elsewhere.invalid/og", staging).href).toBe(
    `${staging}//elsewhere.invalid/og`,
  );
  for (const href of [
    "https://a.asimposium.org/og.png",
    "https://other.asimposium.org/og.png",
    "https://user@asimposium.org/og.png",
    "/og.png#not-a-resource-path",
  ]) {
    expect(() => targetOgImageUrl(href, staging)).toThrow("selected or canonical Agora");
  }
  expect(() => targetOgImageUrl("/og.png", "https://asimposium.org")).toThrow(
    "canonical production",
  );
});

describe("target-surfaces helpers & fail-closed guards (asimposiumorg-rc-staging-smoke-playwright-real-4wnk)", () => {
  test("SHOULD-FAIL CONTROL 1: refuses canonical production origins in both staging and loopback modes", () => {
    for (const prod of [
      "https://asimposium.org",
      "https://www.asimposium.org",
      "https://a.asimposium.org",
      "https://artifacts.asimposium.org",
      "https://ASIMPOSIUM.ORG.",
      "https://a.asimposium.org:443",
    ]) {
      expect(() => validateStagingOrigin("ASIMPOSIUM_STAGING_AGORA_BASE_URL", prod)).toThrow();
      expect(() =>
        validateStagingOrigin("ASIMPOSIUM_STAGING_AGORA_BASE_URL", prod, {
          allowLoopbackRehearsal: true,
        }),
      ).toThrow();
    }

    // Valid staging subdomain succeeds in default mode.
    expect(
      validateStagingOrigin("ASIMPOSIUM_STAGING_AGORA_BASE_URL", "https://staging.asimposium.org"),
    ).toBe("https://staging.asimposium.org");

    // Loopback refused unless allowLoopbackRehearsal is explicitly true.
    expect(() =>
      validateStagingOrigin("ASIMPOSIUM_STAGING_AGORA_BASE_URL", "http://127.0.0.1:4321"),
    ).toThrow();
    expect(
      validateStagingOrigin("ASIMPOSIUM_STAGING_AGORA_BASE_URL", "http://127.0.0.1:4321", {
        allowLoopbackRehearsal: true,
      }),
    ).toBe("http://127.0.0.1:4321");

    // Production refusal in e2e/run-playwright.sh before Chromium launch.
    const proc = spawnSync("bash", [resolve(REPO_ROOT, "e2e/run-playwright.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        ASIMPOSIUM_STAGING_AGENT_BASE_URL: "https://a.asimposium.org",
        ASIMPOSIUM_STAGING_AGORA_BASE_URL: "https://asimposium.org",
      },
    });
    expect(proc.status).toBe(78);
    expect(`${proc.stdout}${proc.stderr}`).toContain("STAGING_SURFACE_BASE_URL_INVALID");
    expect(`${proc.stdout}${proc.stderr}`).not.toContain("https://asimposium.org");
  });

  test("validates strict Fable §14 CSP nonce, private cache control, Rule A4 honesty, PNG IHDR, and secret-safe NDJSON telemetry", () => {
    expect(
      checkStrictCspHeaders({
        "content-security-policy":
          "default-src 'self'; script-src 'self' 'nonce-AbCdEf0123456789+/==' 'strict-dynamic'",
        "x-content-type-options": "nosniff",
      }).ok,
    ).toBe(true);

    // Missing nonce fails.
    expect(
      checkStrictCspHeaders({
        "content-security-policy": "default-src 'self'; script-src 'self'",
        "x-content-type-options": "nosniff",
      }).ok,
    ).toBe(false);

    // unsafe-inline fails.
    expect(
      checkStrictCspHeaders({
        "content-security-policy":
          "default-src 'self'; script-src 'self' 'nonce-AbCdEf0123456789+/==' 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      }).ok,
    ).toBe(false);

    expect(isPrivateCacheControl("private, no-store")).toBe(true);
    expect(isPrivateCacheControl("public, s-maxage=60")).toBe(false);
    expect(isPrivateCacheControl("private, s-maxage=60")).toBe(false);

    // Rule A4 honesty: PROVED banner fails, explanatory prose passes.
    expect(findDishonestProvedBanner(["PROVED"], ["Overview"])).not.toBeNull();
    expect(findDishonestProvedBanner(["strongly-supported"], ["Claim PROVED"])).not.toBeNull();
    expect(
      findDishonestProvedBanner(["strongly-supported", "open · unchallenged"], ["ASImposium"]),
    ).toBeNull();

    // Binary PNG dimension parser.
    expect(parsePngDimensions(VALID_1200_630_PNG)).toEqual({ width: 1200, height: 630 });
    expect(parsePngDimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull();

    // Telemetry strips origins, queries, fragments, and workshop IDs.
    const line = formatPlaywrightTelemetry({
      url_path:
        "https://staging.asimposium.org/console/workshop/F-SECRET/P-4DSP?token=bad#v1.secret",
      status: 200,
      js_mode: "on",
      csp_nonce_present: true,
      console_errors: 0,
      page_errors: 0,
      duration_ms: 42,
    });
    expect(line).not.toContain("staging.asimposium.org");
    expect(line).not.toContain("F-SECRET");
    expect(line).not.toContain("v1.secret");
    expect(JSON.parse(line)).toMatchObject({
      facility: "E2E.playwright",
      url: "/console/workshop/[redacted]/[redacted]",
      status: 200,
      js_mode: "on",
      csp_nonce_present: true,
      console_errors: 0,
      page_errors: 0,
    });

    // Canonical problem ID validation for smoke-agent.sh parameterization.
    expect(validateProblemId("P-4DSP")).toBe(true);
    expect(validateProblemId("P-CAL-01")).toBe(true);
    expect(validateProblemId("P--BAD")).toBe(false);
    expect(validateProblemId('P-BAD"INJECT')).toBe(false);
  });

  test("scripts/smoke-agent.sh rejects malformed ASIMPOSIUM_SMOKE_PROBLEM_ID without echoing it", () => {
    const proc = spawnSync("bash", [resolve(REPO_ROOT, "scripts/smoke-agent.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        ASIMPOSIUM_STAGING_AGENT_BASE_URL: "https://agent-preview.example",
        ASIMPOSIUM_SMOKE_PROBLEM_ID: "P--BAD-INJECT",
      },
    });
    expect(proc.status).toBe(91);
    expect(`${proc.stdout}${proc.stderr}`).toContain("AGENT_SMOKE_PROBLEM_ID_INVALID");
    expect(`${proc.stdout}${proc.stderr}`).not.toContain("P--BAD-INJECT");
  });
});

interface LoopbackFixtureOptions {
  readonly problemId: string;
  readonly canary: string;
  readonly plantMissingCspOnPath?: string;
  readonly plantJsErrorOnPath?: string;
}

async function startLoopbackPair(options: LoopbackFixtureOptions): Promise<{
  readonly agentOrigin: string;
  readonly agoraOrigin: string;
  readonly close: () => Promise<void>;
}> {
  const nonce = "AbCdEf0123456789+/==";
  const strictCsp = `default-src 'self'; script-src 'self' 'nonce-${nonce}'; img-src 'self' data:; style-src 'self' 'unsafe-inline'`;
  const publicAllowed = new Set<string>([...ANONYMOUS_AGORA_PATHS, `/p/${options.problemId}`]);

  const agentServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/") {
        return new Response("# ASImposium Agent Handbook\n", {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      }
      if (path === "/capabilities") {
        return Response.json({ service: "asimposium", version: "test" });
      }
      if (path === "/cursor") {
        return new Response("12", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (path === "/problems.json") {
        return Response.json({
          problems: [
            {
              id: options.problemId,
              public_seq: 12,
              created_at: "2026-11-21T00:00:00.000Z",
              updated_at: "2026-11-21T00:00:00.000Z",
              title: "Loopback Rehearsal Problem",
              status: "active",
            },
          ],
          omitted: [],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const agoraServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const isSponsor = (req.headers.get("cookie") ?? "").includes(
        "asimp.session=valid-loopback-sponsor",
      );

      if (path === "/favicon.ico") {
        return new Response(null, {
          status: 204,
          headers: { "cache-control": "public, max-age=60" },
        });
      }
      if (path === "/og.jpg") {
        return new Response(new Uint8Array(HOME_OG_JPEG), {
          status: 200,
          headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=60" },
        });
      }
      if (path === "/og.png") {
        return new Response(new Uint8Array(VALID_1200_630_PNG), {
          status: 200,
          headers: { "content-type": "image/png", "cache-control": "public, max-age=60" },
        });
      }

      const headers: Record<string, string> = {
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
        "cache-control":
          path.startsWith("/console") || path.startsWith("/admin")
            ? "private, no-store"
            : "public, max-age=60",
      };
      if (options.plantMissingCspOnPath !== path) {
        headers["content-security-policy"] = strictCsp;
      }

      const plantedScript =
        options.plantJsErrorOnPath === path
          ? `<script nonce="${nonce}">throw new Error("planted-unhandled-js-error");</script>`
          : `<script nonce="${nonce}">window.__asimpLoopbackOk = true;</script>`;

      if (path === "/console") {
        const html = isSponsor
          ? `<!doctype html><html><head><title>Sponsor Console — ASImposium</title></head><body>
          <h1>Sponsor Console</h1>
          <h2>Your account</h2>
          <p>Manage Fellows, mint join URLs, and issue sponsor directives.</p>
          <a href="/console/workshop/F-LOOPBACK/${options.problemId}">Open private workshop</a>
          ${plantedScript}
        </body></html>`
          : `<!doctype html><html><head><title>Sign in — ASImposium</title></head><body>
          <h1>Sponsor Sign-In Required</h1>
          <p>Sign in with Google to view your private console.</p>
          ${plantedScript}
        </body></html>`;
        return new Response(html, { status: 200, headers });
      }

      if (path === `/console/workshop/F-LOOPBACK/${options.problemId}`) {
        if (!isSponsor) {
          return new Response("<!doctype html><html><body><h1>Unauthorized</h1></body></html>", {
            status: 401,
            headers,
          });
        }
        return new Response(
          `<!doctype html><html><head><title>Private Workshop</title></head><body>
        <h1>Private workshop</h1>
        <p>${options.canary}</p>
        ${plantedScript}
      </body></html>`,
          { status: 200, headers },
        );
      }

      if (path === "/admin") {
        return new Response(
          `<!doctype html><html><head><title>Admin Boundary</title></head><body>
        <h1>Operator Role Required</h1>
        <p>Standard sponsors cannot access operator moderation routes.</p>
        ${plantedScript}
      </body></html>`,
          { status: 403, headers },
        );
      }

      if (publicAllowed.has(path)) {
        return new Response(
          `<!doctype html><html><head>
        <title>ASImposium ${path}</title>
        <meta property="og:image" content="https://asimposium.org${path === "/" ? "/og.jpg" : "/og.png"}" />
      </head><body>
        <h1>ASImposium Public Surface ${path}</h1>
        <span data-disposition="strongly-supported">strongly-supported</span>
        <p>Model string is self-declared by the Fellow. Public ledger content only.</p>
        <span class="katex"><span class="katex-mathml">n^2</span></span>
        ${plantedScript}
      </body></html>`,
          { status: 200, headers },
        );
      }

      return new Response("<!doctype html><html><body>Not found</body></html>", {
        status: 404,
        headers,
      });
    },
  });

  return {
    agentOrigin: `http://127.0.0.1:${agentServer.port}`,
    agoraOrigin: `http://127.0.0.1:${agoraServer.port}`,
    close: async () => {
      agentServer.stop(true);
      agoraServer.stop(true);
    },
  };
}

describe("real Chromium staging Playwright loopback rehearsal + planted failure controls (4wnk)", () => {
  test("POSITIVE: runs real Chromium (JS on/off, strict CSP, KaTeX, 1200x630 OG PNG, paired cache-leak) and blocks honestly at exit 78 without sponsor state", async () => {
    const canary = "PRIVATE-WORKSHOP-LOOPBACK-CANARY-4WNK";
    const fixture = await startLoopbackPair({ problemId: "P-CAL-4WNK", canary });
    const scratchDir = mkdtempSync(join(tmpdir(), "asimp-4wnk-state-"));
    const storageStatePath = join(scratchDir, "sponsor-state.json");
    writeFileSync(
      storageStatePath,
      JSON.stringify({
        cookies: [
          {
            name: "asimp.session",
            value: "valid-loopback-sponsor",
            domain: "127.0.0.1",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
      { mode: 0o600 },
    );

    try {
      // 1. Full authenticated + anonymous rehearsal -> exit 0 PLAYWRIGHT_LOOPBACK_REHEARSAL_PASS
      const runIdPass = `rehearsal-4wnk-pass-${Date.now()}`;
      const fullRun = await runAsync(
        "bash",
        [resolve(REPO_ROOT, "e2e/run-playwright.sh"), "--local-rehearsal", "--run-id", runIdPass],
        {
          ...process.env,
          ASIMPOSIUM_STAGING_AGENT_BASE_URL: fixture.agentOrigin,
          ASIMPOSIUM_STAGING_AGORA_BASE_URL: fixture.agoraOrigin,
          ASIMPOSIUM_STAGING_SPONSOR_STORAGE_STATE: storageStatePath,
          ASIMPOSIUM_STAGING_WORKSHOP_CANARY: canary,
        },
        240_000,
      );
      expect(fullRun.status, `stderr=${fullRun.stderr}\nstdout=${fullRun.stdout}`).toBe(0);
      expect(fullRun.stdout).toContain("PLAYWRIGHT_LOOPBACK_REHEARSAL_PASS");
      expect(fullRun.stdout).toContain('"facility":"E2E.playwright"');
      expect(fullRun.stdout).toContain('"js_mode":"off"');
      expect(fullRun.stdout).toContain('"js_mode":"on"');
      expect(fullRun.stdout).toContain('"csp_nonce_present":true');
      expect(fullRun.stdout).not.toContain(canary);
      expect(fullRun.stdout).not.toContain("valid-loopback-sponsor");

      // 2. Without sponsor storage state -> anonymous checks pass, runner blocks honestly at exit 78
      const runIdBlocked = `rehearsal-4wnk-blocked-${Date.now()}`;
      const envWithoutSponsor = { ...process.env };
      delete envWithoutSponsor.ASIMPOSIUM_STAGING_SPONSOR_STORAGE_STATE;
      const blockedRun = await runAsync(
        "bash",
        [
          resolve(REPO_ROOT, "e2e/run-playwright.sh"),
          "--local-rehearsal",
          "--run-id",
          runIdBlocked,
        ],
        {
          ...envWithoutSponsor,
          ASIMPOSIUM_STAGING_AGENT_BASE_URL: fixture.agentOrigin,
          ASIMPOSIUM_STAGING_AGORA_BASE_URL: fixture.agoraOrigin,
        },
        240_000,
      );
      expect(blockedRun.status).toBe(78);
      expect(blockedRun.stdout).toContain("PLAYWRIGHT_LOOPBACK_REHEARSAL_SPONSOR_BLOCKED");

      const signedOutPath = join(scratchDir, "signed-out-state.json");
      writeFileSync(signedOutPath, '{"cookies":[],"origins":[]}', { mode: 0o600 });
      const signedOut = await runAsync(
        "bash",
        [
          resolve(REPO_ROOT, "e2e/run-playwright.sh"),
          "--local-rehearsal",
          "--run-id",
          `rehearsal-4wnk-signed-out-${Date.now()}`,
        ],
        {
          ...envWithoutSponsor,
          ASIMPOSIUM_STAGING_AGENT_BASE_URL: fixture.agentOrigin,
          ASIMPOSIUM_STAGING_AGORA_BASE_URL: fixture.agoraOrigin,
          ASIMPOSIUM_STAGING_SPONSOR_STORAGE_STATE: signedOutPath,
        },
        240_000,
      );
      expect(signedOut.status).toBe(1);
      expect(signedOut.stdout).toContain("Your account");
      expect(signedOut.stdout).not.toContain("PLAYWRIGHT_LOOPBACK_REHEARSAL_PASS");
    } finally {
      await fixture.close();
    }
  }, 360_000);

  test("SHOULD-FAIL CONTROL 2A: removing CSP nonce on a rendered page fails Chromium suite immediately", async () => {
    const fixture = await startLoopbackPair({
      problemId: "P-CAL-4WNK",
      canary: "CANARY-CSP",
      plantMissingCspOnPath: "/explore",
    });
    try {
      const runId = `rehearsal-4wnk-nocsp-${Date.now()}`;
      const run = await runAsync(
        "bash",
        [
          resolve(REPO_ROOT, "e2e/run-playwright.sh"),
          "--local-rehearsal",
          "--anonymous-only",
          "--run-id",
          runId,
        ],
        {
          ...process.env,
          ASIMPOSIUM_STAGING_AGENT_BASE_URL: fixture.agentOrigin,
          ASIMPOSIUM_STAGING_AGORA_BASE_URL: fixture.agoraOrigin,
        },
        120_000,
      );
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain("PLAYWRIGHT_TARGET_SURFACE_CHECK_FAILED");
      expect(`${run.stdout}${run.stderr}`).toContain("strict Fable §14 CSP");
    } finally {
      await fixture.close();
    }
  }, 120_000);

  test("SHOULD-FAIL CONTROL 2B: planting an unhandled JS error fails Chromium suite immediately", async () => {
    const fixture = await startLoopbackPair({
      problemId: "P-CAL-4WNK",
      canary: "CANARY-JSERR",
      plantJsErrorOnPath: "/now",
    });
    try {
      const runId = `rehearsal-4wnk-jserr-${Date.now()}`;
      const run = await runAsync(
        "bash",
        [
          resolve(REPO_ROOT, "e2e/run-playwright.sh"),
          "--local-rehearsal",
          "--anonymous-only",
          "--run-id",
          runId,
        ],
        {
          ...process.env,
          ASIMPOSIUM_STAGING_AGENT_BASE_URL: fixture.agentOrigin,
          ASIMPOSIUM_STAGING_AGORA_BASE_URL: fixture.agoraOrigin,
        },
        120_000,
      );
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain("PLAYWRIGHT_TARGET_SURFACE_CHECK_FAILED");
      expect(`${run.stdout}${run.stderr}`).toContain("uncaught pageerror");
    } finally {
      await fixture.close();
    }
  }, 120_000);
});
