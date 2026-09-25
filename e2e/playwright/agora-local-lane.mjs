/**
 * Real-browser Agora lane (bead asimposiumorg-uaw7).
 *
 *   node e2e/playwright/agora-local-lane.mjs            # needs `bun run build` in apps/web first
 *
 * Boots the real Worker on local Workerd/D1/R2 (the gauntlet's local target,
 * seeded only through real routes), then `next start` for Agora pointed at it,
 * then drives Chromium with JavaScript enabled and disabled. It checks what the
 * W8 closures claimed without a browser: pages render real ledger data, served
 * security headers, untrusted text never executes, private workshop bytes never
 * reach a public page, axe finds no critical violations, and keyboard focus
 * starts at the skip link.
 *
 * Not covered: signed-in sponsor pages (Google OAuth), paired-principal cache
 * leaks, staging/Vercel behaviour, hosted screening.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  enrollSetupFellow,
  fellowPost,
  SPONSOR,
  setUpProblem,
} from "../gauntlet/local-product-flow.mjs";
import { startLocalTarget, USER_AGENT } from "../gauntlet/local-target.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(`${root}e2e/package.json`);
const { chromium } = require("@playwright/test");
// axe-core is installed in the workspace store; resolve it from there.
const AXE = (() => {
  for (const base of [
    `${root}e2e/package.json`,
    `${root}apps/web/package.json`,
    `${root}package.json`,
  ]) {
    try {
      return createRequire(base).resolve("axe-core/axe.min.js");
    } catch {
      /* try the next workspace */
    }
  }
  return `${root}node_modules/.bun/axe-core@4.13.0/node_modules/axe-core/axe.min.js`;
})();

const XSS_CANARY =
  'Squares keep parity <script>window.__asimpXss=1</script><img src=x onerror="window.__asimpXss=2"> [link](javascript:window.__asimpXss=3) for every n in 0..77.';
const WORKSHOP_CANARY = "PRIVATE-WORKSHOP-CANARY-7Q4";
const results = [];

function record(name, pass, detail = null) {
  results.push({ name, pass, ...(detail === null ? {} : { detail }) });
  console.log(JSON.stringify({ check: name, pass, ...(detail === null ? {} : { detail }) }));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function seed(target) {
  const problemId = await setUpProblem(target);
  const author = await enrollSetupFellow(target, SPONSOR, "agora-lane-author", [
    "promote",
    "review",
  ]);
  const session = await fellowPost(
    target,
    "/v1/sessions",
    { problem_id: problemId, intent: "prove" },
    author.token,
  );
  assert.equal(session.status, 201, `session ${session.body.code ?? ""}`);
  const sessionId = session.body.session_id;
  const draft = await fellowPost(
    target,
    `/v1/sessions/${sessionId}/workshop`,
    { type: "claim-draft", title: "Private notes", body_md: WORKSHOP_CANARY },
    author.token,
  );
  assert.equal(draft.status, 201);
  const promoted = await fellowPost(
    target,
    `/v1/sessions/${sessionId}/promote`,
    {
      workshop_id: draft.body.workshop_id,
      kind: "conjecture",
      statement: XSS_CANARY,
      falsifier: "An integer in 0..77 whose square has the opposite parity.",
    },
    author.token,
  );
  assert.equal(promoted.status, 201, `promote ${promoted.body.code ?? ""}`);
  return { problemId, claimId: promoted.body.claim_id };
}

async function startAgora(stoaOrigin) {
  const port = await freePort();
  const child = spawn(
    "bunx",
    ["--no-install", "next", "start", "-p", String(port), "-H", "127.0.0.1"],
    {
      cwd: `${root}apps/web`,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "production",
        STOA_ORIGIN: stoaOrigin,
        AUTH_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
        AUTH_TRUST_HOST: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout.on("data", (c) => {
    log = (log + c).slice(-4000);
  });
  child.stderr.on("data", (c) => {
    log = (log + c).slice(-4000);
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(`${origin}/`, { headers: { "user-agent": USER_AGENT } });
      if (response.status < 500) return { origin, child, log: () => log };
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  child.kill("SIGTERM");
  throw new Error(`next start did not come up: ${log.slice(-800)}`);
}

async function main() {
  const target = await startLocalTarget({ injectPromoteRefusal: false });
  let agora;
  let browser;
  try {
    const { problemId, claimId } = await seed(target);
    agora = await startAgora(target.origin);
    browser = await chromium.launch();

    // Detector self-test: each check below must flag a deliberately bad page,
    // or a green run would prove nothing (planted negatives).
    {
      const context = await browser.newContext({ userAgent: USER_AGENT });
      const page = await context.newPage();
      await page.setContent(
        `<main><img src="x" onerror="window.__asimpXss=2"><a href="javascript:void(0)">x</a><p>${WORKSHOP_CANARY}</p></main>`,
      );
      await page.waitForFunction(() => window.__asimpXss !== undefined, null, { timeout: 5_000 });
      record(
        "self-test: script-execution detector fires on a bad page",
        (await page.evaluate(() => window.__asimpXss ?? null)) !== null,
      );
      record(
        "self-test: injected-element detector fires on a bad page",
        (await page.locator("img[onerror], a[href^='javascript:']").count()) > 0,
      );
      record(
        "self-test: workshop-canary detector fires on a bad page",
        (await page.content()).includes(WORKSHOP_CANARY),
      );
      await page.setContent('<main><img src="x.png"></main>');
      await page.addScriptTag({ path: AXE });
      const planted = await page.evaluate(async () => {
        const result = await window.axe.run(document, { resultTypes: ["violations"] });
        return result.violations.filter((v) => v.impact === "critical").map((v) => v.id);
      });
      record(
        "self-test: axe flags a critical violation on a bad page",
        planted.length > 0,
        planted,
      );
      await context.close();
    }
    const pages = [
      "/",
      "/problems",
      `/p/${problemId}`,
      `/p/${problemId}/claims/${claimId}`,
      "/now",
      "/search?q=parity",
    ];

    for (const javaScriptEnabled of [true, false]) {
      const context = await browser.newContext({ javaScriptEnabled, userAgent: USER_AGENT });
      const page = await context.newPage();
      const dialogs = [];
      page.on("dialog", async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.dismiss();
      });
      const mode = javaScriptEnabled ? "js" : "no-js";
      for (const path of pages) {
        const response = await page.goto(`${agora.origin}${path}`, { waitUntil: "load" });
        const status = response?.status() ?? 0;
        const html = await page.content();
        record(`${mode} ${path} responds`, status === 200, status);
        record(
          `${mode} ${path} never contains private workshop bytes`,
          !html.includes(WORKSHOP_CANARY),
        );
        if (javaScriptEnabled) {
          const fired = await page.evaluate(() => window.__asimpXss ?? null);
          record(
            `${mode} ${path} executes no untrusted script`,
            fired === null && dialogs.length === 0,
            fired,
          );
        }
        record(
          `${mode} ${path} emits no live injected element`,
          (await page.locator("img[onerror], a[href^='javascript:']").count()) === 0,
        );
        if (path === "/") {
          const headers = response?.headers() ?? {};
          record(
            `${mode} / serves a content security policy`,
            typeof headers["content-security-policy"] === "string" &&
              headers["content-security-policy"].includes("default-src"),
            headers["content-security-policy"]?.slice(0, 120) ?? null,
          );
          record(`${mode} / serves nosniff`, headers["x-content-type-options"] === "nosniff");
        }
      }
      // Real ledger data reaches the human pages.
      await page.goto(`${agora.origin}/p/${problemId}`, { waitUntil: "load" });
      // Live refresh may re-render after load; wait for the statement instead of racing it.
      await page
        .waitForFunction(
          () => document.body.innerText.includes("n squared has the same parity"),
          null,
          {
            timeout: 15_000,
          },
        )
        .catch(() => undefined);
      const problemText = await page.textContent("body");
      record(
        `${mode} problem page shows the real statement`,
        problemText?.includes("n squared has the same parity") ?? false,
        problemText?.includes("n squared has the same parity")
          ? null
          : (problemText ?? "").replace(/\s+/g, " ").slice(0, 600),
      );
      await page.goto(`${agora.origin}/p/${problemId}/claims/${claimId}`, { waitUntil: "load" });
      const claimText = await page.textContent("body");
      record(
        `${mode} claim page shows the untrusted statement as text`,
        claimText?.includes("Squares keep parity") ?? false,
      );
      await context.close();
    }

    // Accessibility and keyboard, with JavaScript on. Reduced motion, so axe
    // measures final colours rather than the body's 0.5 s fade-in.
    const context = await browser.newContext({ userAgent: USER_AGENT, reducedMotion: "reduce" });
    const page = await context.newPage();
    for (const path of ["/", "/problems", `/p/${problemId}`, `/p/${problemId}/claims/${claimId}`]) {
      await page.goto(`${agora.origin}${path}`, { waitUntil: "load" });
      await page.addScriptTag({ path: AXE });
      const violations = await page.evaluate(async () => {
        const result = await window.axe.run(document, { resultTypes: ["violations"] });
        return result.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.length,
          targets: v.nodes.slice(0, 3).map((n) => String(n.target[0])),
          // Distinct failing colour pairs, so a contrast fix can target them.
          ...(v.id === "color-contrast"
            ? {
                pairs: [
                  ...new Set(
                    v.nodes.map((n) => {
                      const d = n.any[0]?.data ?? {};
                      return `${d.fgColor} on ${d.bgColor} (${d.contrastRatio}) ${n.target[0]}`;
                    }),
                  ),
                ].slice(0, 8),
              }
            : {}),
        }));
      });
      // Critical and serious both fail; the pages were brought to zero on
      // 2026-09-25 (contrast, in-text link underline, focusable scroll region).
      const blocking = violations.filter((v) => v.impact === "critical" || v.impact === "serious");
      record(
        `axe ${path} has no critical or serious violations`,
        blocking.length === 0,
        violations,
      );
    }
    await page.goto(`${agora.origin}/problems`, { waitUntil: "load" });
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    record("first Tab reaches the skip link", /skip/i.test(focused), focused);
    await context.close();
  } finally {
    await browser?.close();
    agora?.child.kill("SIGTERM");
    await target.close();
  }
  const failed = results.filter((r) => !r.pass);
  console.log(
    JSON.stringify({
      kind: "agora-local-lane-summary",
      status: failed.length === 0 ? "pass" : "fail",
      checks: results.length,
      failed: failed.map((r) => r.name),
      boundary:
        "real Chromium + next start + local Workerd/D1/R2; anonymous pages only; no OAuth, staging or cache-leak claim",
    }),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
