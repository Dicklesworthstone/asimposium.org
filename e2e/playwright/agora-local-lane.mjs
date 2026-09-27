/**
 * Real-browser Agora lane (bead asimposiumorg-uaw7).
 *
 *   node e2e/playwright/agora-local-lane.mjs            # needs `bun run build` in apps/web first
 *   node e2e/playwright/agora-local-lane.mjs --build    # builds apps/web itself (bun run e2e:agora-local)
 *
 * Exits 0 pass, 1 fail, 78 blocked (AGORA_LANE_BROWSER_UNAVAILABLE: no
 * Chromium binary; checked before any build). The apps/web security gate runs
 * this lane.
 *
 * Boots the real Worker on local Workerd/D1/R2 (the gauntlet's local target,
 * seeded only through real routes), then `next start` for Agora pointed at it,
 * then drives Chromium with JavaScript enabled and disabled. It checks what the
 * W8 closures claimed without a browser: pages render real ledger data, served
 * security headers, untrusted text never executes, private workshop bytes never
 * reach a public page, axe finds no critical violations, and keyboard focus
 * starts at the skip link.
 *
 * Signed-in sponsor leg: Agora holds the local Worker's envelope key, and the
 * sponsor browser carries a real Auth.js session cookie minted with Agora's
 * own AUTH_SECRET by next-auth's `encode` (the same JWE a Google callback
 * yields). It checks the S-3 split through real pages: the sponsor's private
 * workshop shows the Fellow's draft; the same URL anonymously, and every
 * public page, never does; the private response is not publicly cacheable.
 * A directive is issued by clicking the console's server action, lands once in
 * the Fellow's inbox (never another sponsor's Fellow, never a public face),
 * is acknowledged by the Fellow, and shows as acknowledged on the console.
 * Share cards: each page's og:image is a 1200x630 PNG Chromium decodes, and
 * the problem card changes after a public write (it follows the live face).
 *
 * Not covered: the Google OAuth exchange itself (xeg), staging/Vercel
 * behaviour and edge caches (3zn), hosted screening.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
const SCRATCH_CANARY = "PRIVATE-SCRATCH-CANARY-2K9";
const AUTH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const SESSION_COOKIE = "asimp.session";
const DIRECTIVE_TEXT = "Focus on odd residues modulo 8 first (lane directive 7Q4).";
const results = [];
const hasCsp = (headers) =>
  typeof headers["content-security-policy"] === "string" &&
  headers["content-security-policy"].includes("default-src");
const hasNosniff = (headers) => headers["x-content-type-options"] === "nosniff";
// Fable §14 strict CSP: scripts need a nonce; inline script is never allowed.
const scriptSrc = (headers) =>
  /(?:^|;)\s*script-src ([^;]*)/.exec(headers["content-security-policy"] ?? "")?.[1] ?? "";
const strictScripts = (headers) =>
  /'nonce-[A-Za-z0-9+/=]{16,}'/.test(scriptSrc(headers)) &&
  !scriptSrc(headers).includes("'unsafe-inline'");
// A response that carries a sponsor's private bytes must never be storable by
// a shared cache (paired-principal cache leak).
const privateToCaches = (headers) => {
  const value = (headers["cache-control"] ?? "").toLowerCase();
  return /\b(private|no-store)\b/.test(value) && !/\b(public|s-maxage)\b/.test(value);
};

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
  // A draft that is never promoted: only the sponsor's workshop may show it.
  const scratch = await fellowPost(
    target,
    `/v1/sessions/${sessionId}/workshop`,
    {
      type: "scratch",
      title: `Scratch <img src=x onerror="window.__asimpXss=4">`,
      body_md: `Unpromoted ${SCRATCH_CANARY}. ${XSS_CANARY}`,
    },
    author.token,
  );
  assert.equal(scratch.status, 201, `scratch ${scratch.body.code ?? ""}`);
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

  // A novelty-claim with one independent novelty review (another sponsor).
  const noveltyDraft = await fellowPost(
    target,
    `/v1/sessions/${sessionId}/workshop`,
    { type: "claim-draft", title: "Novelty notes", body_md: "Private novelty notes." },
    author.token,
  );
  const noveltyClaim = await fellowPost(
    target,
    `/v1/sessions/${sessionId}/promote`,
    {
      workshop_id: noveltyDraft.body.workshop_id,
      kind: "novelty-claim",
      statement: "No published work states this parity range bound before 2026.",
      falsifier: "A published statement of the same bound.",
    },
    author.token,
  );
  assert.equal(noveltyClaim.status, 201, `novelty promote ${noveltyClaim.body.code ?? ""}`);
  const reviewer = await enrollSetupFellow(
    target,
    "usr_agora_lane_reviewer",
    "agora-lane-reviewer",
    ["review"],
  );
  const reviewSession = await fellowPost(
    target,
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    reviewer.token,
  );
  const noveltyReview = await fellowPost(
    target,
    `/v1/sessions/${reviewSession.body.session_id}/review`,
    {
      target_claim_id: noveltyClaim.body.claim_id,
      target_version: 1,
      verdict: "inform",
      basis: "Searched an index for the bound.",
      capable_of_failure: "Any earlier statement of this bound would make it a rediscovery.",
      novelty: {
        verdict: "new",
        searches: [
          {
            source: "arXiv full-text search",
            searched_on: "2026-09-24",
            terms: ["parity range bound"],
          },
        ],
        nearest_prior_art: [],
        semantic_difference: "No prior statement found.",
      },
      body_md: "Search log.",
    },
    reviewer.token,
  );
  assert.equal(noveltyReview.status, 201, `novelty review ${noveltyReview.body.code ?? ""}`);
  return {
    problemId,
    claimId: promoted.body.claim_id,
    noveltyId: noveltyClaim.body.claim_id,
    fellowId: author.fellowId,
    authorToken: author.token,
    reviewerToken: reviewer.token,
    sessionId,
  };
}

async function startAgora(stoaOrigin, signingEnv) {
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
        AUTH_SECRET,
        AUTH_TRUST_HOST: "true",
        ...signingEnv,
        // Sponsor writes need a recovery key distinct from the envelope key.
        ENROLLMENT_RECOVERY_HMAC_KEY_HEX: Buffer.from(
          crypto.getRandomValues(new Uint8Array(32)),
        ).toString("hex"),
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
  // Blocked, not failed, when there is no browser to drive; probed with a real
  // launch first so a missing binary costs seconds, not a Next build.
  try {
    await (await chromium.launch()).close();
  } catch (error) {
    if (!/Executable doesn't exist|browserType\.launch/i.test(String(error?.message ?? error))) {
      throw error;
    }
    console.log(
      JSON.stringify({
        kind: "agora-local-lane-summary",
        status: "blocked",
        code: "AGORA_LANE_BROWSER_UNAVAILABLE",
        detail: "Playwright could not launch its Chromium headless shell on this host",
      }),
    );
    process.exit(78);
  }
  if (process.argv.includes("--build")) {
    const build = spawnSync("bun", ["run", "build"], { cwd: `${root}apps/web`, stdio: "inherit" });
    if (build.status !== 0) {
      console.log(
        JSON.stringify({
          kind: "agora-local-lane-summary",
          status: "fail",
          code: "AGORA_BUILD_FAILED",
        }),
      );
      process.exit(1);
    }
  }
  const target = await startLocalTarget({ injectPromoteRefusal: false });
  let agora;
  let browser;
  try {
    const { problemId, claimId, noveltyId, fellowId, authorToken, reviewerToken, sessionId } =
      await seed(target);
    agora = await startAgora(target.origin, await target.agoraSigningEnv());
    browser = await chromium.launch();

    // Detector self-test: each check below must flag a deliberately bad page,
    // or a green run would prove nothing (planted negatives).
    record("self-test: CSP detector flags a response without a policy", !hasCsp({}));
    record(
      "self-test: CSP detector flags a policy without default-src",
      !hasCsp({ "content-security-policy": "frame-ancestors 'none'" }),
    );
    record("self-test: nosniff detector flags a missing header", !hasNosniff({}));
    record(
      "self-test: strict-script detector flags 'unsafe-inline' and a missing nonce",
      !strictScripts({ "content-security-policy": "script-src 'self' 'unsafe-inline'" }) &&
        !strictScripts({
          "content-security-policy":
            "script-src 'self' 'nonce-AAAAAAAAAAAAAAAAAAAAAA==' 'unsafe-inline'",
        }) &&
        strictScripts({
          "content-security-policy":
            "default-src 'self'; script-src 'self' 'nonce-AAAAAAAAAAAAAAAAAAAAAA==' 'strict-dynamic'",
        }),
    );
    record(
      "self-test: cache detector flags a publicly cacheable private page",
      !privateToCaches({ "cache-control": "public, max-age=60" }) &&
        !privateToCaches({ "cache-control": "private, s-maxage=60" }) &&
        !privateToCaches({}),
    );
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
      // A nonce missing from Next's own scripts shows up as a CSP refusal.
      const cspViolations = [];
      page.on("console", (message) => {
        if (/Content Security Policy/i.test(message.text())) cspViolations.push(message.text());
      });
      const mode = javaScriptEnabled ? "js" : "no-js";
      for (const path of pages) {
        const response = await page.goto(`${agora.origin}${path}`, { waitUntil: "load" });
        const status = response?.status() ?? 0;
        const html = await page.content();
        record(`${mode} ${path} responds`, status === 200, status);
        record(
          `${mode} ${path} never contains private workshop bytes`,
          !html.includes(WORKSHOP_CANARY) && !html.includes(SCRATCH_CANARY),
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
            hasCsp(headers),
            headers["content-security-policy"]?.slice(0, 120) ?? null,
          );
          record(`${mode} / serves nosniff`, hasNosniff(headers));
          record(
            `${mode} / script-src requires a nonce and allows no inline script`,
            strictScripts(headers),
            scriptSrc(headers),
          );
        }
      }
      if (javaScriptEnabled) {
        record(
          `${mode} pages report no CSP violations`,
          cspViolations.length === 0,
          cspViolations.slice(0, 3),
        );
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

    // Diptych for novelty: the Worker's JSON and Markdown faces and the Agora
    // HTML page agree on the computed novelty standing at the same state.
    {
      const json = await (
        await fetch(`${target.origin}/p/${problemId}/claims/${noveltyId}.json`, {
          headers: { "user-agent": USER_AGENT },
        })
      ).json();
      const markdown = await (
        await fetch(`${target.origin}/p/${problemId}/claims/${noveltyId}.md`, {
          headers: { "user-agent": USER_AGENT },
        })
      ).text();
      const standing = json.claim_state?.novelty;
      record("novelty: the JSON face computes a standing", standing === "new", standing ?? null);
      record(
        "novelty: the Markdown face carries the same standing",
        markdown.includes(`"novelty": "${standing}"`),
      );
      const context = await browser.newContext({ userAgent: USER_AGENT });
      const page = await context.newPage();
      await page.goto(`${agora.origin}/p/${problemId}/claims/${noveltyId}`, { waitUntil: "load" });
      const shown = await page.getAttribute("[data-novelty]", "data-novelty").catch(() => null);
      record("novelty: the Agora page shows the same standing", shown === standing, shown);
      // Rule A4: the searches behind the standing are displayed, not only the verdict.
      const searches = await page.textContent("[data-novelty-searches]").catch(() => null);
      record(
        "novelty: the Agora page lists the recorded search behind the standing",
        typeof searches === "string" &&
          searches.includes("arXiv full-text search") &&
          searches.includes("2026-09-24") &&
          searches.includes("parity range bound"),
        searches,
      );
      await context.close();
    }

    // Prefetched documents carry the same strict policy (a prefetch can be
    // reused for navigation).
    for (const prefetch of [{ purpose: "prefetch" }, { "next-router-prefetch": "1" }]) {
      const response = await fetch(`${agora.origin}/`, {
        headers: { "user-agent": USER_AGENT, ...prefetch },
      });
      const headers = Object.fromEntries(response.headers);
      record(
        `prefetch ${Object.keys(prefetch)[0]} / carries the strict script policy`,
        strictScripts(headers),
        scriptSrc(headers),
      );
    }

    // The one static HTML file runs its inline scripts under a hash-pinned
    // policy (next.config.ts), again with no 'unsafe-inline'.
    {
      const context = await browser.newContext({ userAgent: USER_AGENT });
      const page = await context.newPage();
      const violations = [];
      page.on("console", (message) => {
        if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
      });
      const response = await page.goto(`${agora.origin}/design`, { waitUntil: "load" });
      const policy = scriptSrc(response?.headers() ?? {});
      record(
        "design.html pins its inline scripts by hash and allows no other inline script",
        response?.status() === 200 &&
          /'sha256-[A-Za-z0-9+/=]{44}'/.test(policy) &&
          !policy.includes("'unsafe-inline'") &&
          violations.length === 0,
        { policy, violations: violations.slice(0, 2) },
      );
      await context.close();
    }

    // Signed-in sponsor: the S-3 split through real pages.
    {
      const jwtModule = createRequire(`${root}apps/web/package.json`).resolve("next-auth/jwt");
      const { encode } = await import(jwtModule);
      const sessionToken = await encode({
        token: { sub: SPONSOR, name: "Local sponsor", authTime: Math.floor(Date.now() / 1000) },
        secret: AUTH_SECRET,
        salt: SESSION_COOKIE,
      });
      const workshopPath = `/console/workshop/${fellowId}/${problemId}`;
      const signedIn = await browser.newContext({ userAgent: USER_AGENT });
      await signedIn.addCookies([
        {
          name: SESSION_COOKIE,
          value: sessionToken,
          url: agora.origin,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const sponsorPage = await signedIn.newPage();
      const workshop = await sponsorPage.goto(`${agora.origin}${workshopPath}`, {
        waitUntil: "load",
      });
      const workshopHtml = await sponsorPage.content();
      // Fellow-authored workshop text is untrusted on the sponsor's own page too.
      record(
        "sponsor: untrusted workshop text executes no script",
        (await sponsorPage.evaluate(() => window.__asimpXss ?? null)) === null,
      );
      record(
        "sponsor: untrusted workshop text emits no live injected element",
        (await sponsorPage.locator("img[onerror], a[href^='javascript:']").count()) === 0,
      );
      record(
        "sponsor: private workshop shows the Fellow's unpromoted draft",
        workshop?.status() === 200 && workshopHtml.includes(SCRATCH_CANARY),
        workshopHtml.includes(SCRATCH_CANARY)
          ? null
          : ((await sponsorPage.textContent("main")) ?? "").replace(/\s+/g, " ").slice(0, 300),
      );
      // Live view: a push made while the page is open appears without a reload.
      const LIVE_CANARY = "PRIVATE-LIVE-PUSH-5M1";
      const livePush = await fellowPost(
        target,
        `/v1/sessions/${sessionId}/workshop`,
        { type: "scratch", title: "Live", body_md: `Pushed while watched ${LIVE_CANARY}.` },
        authorToken,
      );
      const appeared = await sponsorPage
        .waitForFunction((text) => document.body.innerText.includes(text), LIVE_CANARY, {
          timeout: 15_000,
        })
        .then(() => true)
        .catch(() => false);
      record(
        "sponsor: a workshop push appears on the open page without a reload",
        livePush.status === 201 && appeared,
        livePush.status,
      );
      record(
        "sponsor: the private workshop response is not publicly cacheable",
        privateToCaches(workshop?.headers() ?? {}),
        workshop?.headers()["cache-control"] ?? null,
      );
      const consoleResponse = await sponsorPage.goto(`${agora.origin}/console`, {
        waitUntil: "load",
      });
      // The console streams in after its reads answer; wait for the Fellow.
      await sponsorPage
        .waitForFunction(
          (name) => document.querySelector("main")?.textContent?.includes(name),
          "agora-lane-author",
          { timeout: 20_000 },
        )
        .catch(() => undefined);
      const consoleText = (await sponsorPage.textContent("main")) ?? "";
      record(
        "sponsor: the console response is not publicly cacheable",
        privateToCaches(consoleResponse?.headers() ?? {}),
        consoleResponse?.headers()["cache-control"] ?? null,
      );
      record(
        "sponsor: the console lists the sponsor's own Fellow",
        consoleResponse?.status() === 200 && consoleText.includes("agora-lane-author"),
        consoleText.replace(/\s+/g, " ").slice(0, 300),
      );
      // Directive: issued by a real click on the console's server action,
      // delivered to the Fellow's inbox by the Worker, acknowledged by the
      // Fellow, and shown as acknowledged back on the console.
      const inbox = async (token) => {
        const response = await fetch(`${target.origin}/v1/inbox`, {
          headers: { "user-agent": USER_AGENT, authorization: `Bearer ${token}` },
        });
        return (await response.json()).items ?? [];
      };
      const directiveCard = sponsorPage.locator('section[aria-labelledby="directives-title"]');
      await directiveCard.locator("select").first().selectOption({ label: "agora-lane-author" });
      await directiveCard.locator("textarea").fill(DIRECTIVE_TEXT);
      await directiveCard.getByRole("button", { name: "Deliver directive" }).click();
      const status = await directiveCard
        .getByRole("status")
        .textContent({ timeout: 20_000 })
        .catch(() => null);
      record(
        "directive: the console reports delivery",
        /delivered to the Fellow inbox/i.test(status ?? ""),
        status,
      );
      const delivered = (await inbox(authorToken)).filter(
        (item) =>
          item.type === "sponsor_directive" && JSON.stringify(item).includes(DIRECTIVE_TEXT),
      );
      record(
        "directive: the Fellow's inbox holds it once",
        delivered.length === 1,
        delivered.length,
      );
      record(
        "directive: another sponsor's Fellow never receives it",
        !JSON.stringify(await inbox(reviewerToken)).includes(DIRECTIVE_TEXT),
      );
      const ack =
        delivered.length === 1
          ? await fellowPost(
              target,
              "/v1/inbox/ack",
              { notice_ids: [delivered[0].id] },
              authorToken,
            )
          : { status: 0 };
      record("directive: the Fellow acknowledges it", ack.status === 200, ack.status);
      await sponsorPage.goto(`${agora.origin}/console`, { waitUntil: "load" });
      const acknowledged = await sponsorPage
        .waitForFunction(
          (text) =>
            [...document.querySelectorAll("li")].some(
              (li) =>
                li.textContent.includes(text) &&
                li.textContent.includes("acknowledged") &&
                !li.textContent.includes("awaiting"),
            ),
          DIRECTIVE_TEXT,
          { timeout: 20_000 },
        )
        .then(() => true)
        .catch(() => false);
      record(
        "directive: the console shows the acknowledgment",
        acknowledged,
        acknowledged
          ? null
          : (
              (await directiveCard
                .locator("ul")
                .textContent()
                .catch(() => null)) ?? ""
            ).slice(0, 300),
      );

      // The public page, read by the signed-in sponsor, still omits workshop bytes.
      await sponsorPage.goto(`${agora.origin}/p/${problemId}`, { waitUntil: "load" });
      const sponsorPublic = await sponsorPage.content();
      record(
        "sponsor: the public problem page omits workshop bytes even when signed in",
        !sponsorPublic.includes(SCRATCH_CANARY) && !sponsorPublic.includes(WORKSHOP_CANARY),
      );
      record(
        "directive: the public problem page never shows directive text",
        !sponsorPublic.includes(DIRECTIVE_TEXT) &&
          !(
            await (
              await fetch(`${target.origin}/p/${problemId}.json`, {
                headers: { "user-agent": USER_AGENT },
              })
            ).text()
          ).includes(DIRECTIVE_TEXT),
      );
      await signedIn.close();

      // Same URL, after the sponsor's request, with no session: nothing private.
      const anonymous = await browser.newContext({ userAgent: USER_AGENT });
      const anonymousPage = await anonymous.newPage();
      await anonymousPage.goto(`${agora.origin}${workshopPath}`, { waitUntil: "load" });
      const anonymousHtml = await anonymousPage.content();
      record(
        "anonymous: the same workshop URL asks for sign-in and shows no private bytes",
        /sign in required/i.test(anonymousHtml) &&
          !anonymousHtml.includes(SCRATCH_CANARY) &&
          !anonymousHtml.includes(WORKSHOP_CANARY),
      );
      await anonymous.close();

      // A cookie signed with another secret is not a session.
      const forged = await browser.newContext({ userAgent: USER_AGENT });
      await forged.addCookies([
        {
          name: SESSION_COOKIE,
          value: await encode({
            token: { sub: SPONSOR, authTime: Math.floor(Date.now() / 1000) },
            secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
            salt: SESSION_COOKIE,
          }),
          url: agora.origin,
        },
      ]);
      const forgedPage = await forged.newPage();
      await forgedPage.goto(`${agora.origin}${workshopPath}`, { waitUntil: "load" });
      record(
        "forged session: a cookie under another secret shows no private bytes",
        !(await forgedPage.content()).includes(SCRATCH_CANARY),
      );
      await forged.close();
    }

    // Share cards: the og:image each page declares is a real 1200x630 PNG
    // that Chromium decodes, built from the live face (it differs from the
    // not-found fallback card). Pixels are not OCR-checked.
    {
      const ogImagePath = async (path) => {
        const html = await (
          await fetch(`${agora.origin}${path}`, { headers: { "user-agent": USER_AGENT } })
        ).text();
        const match = /<meta property="og:image" content="([^"]+)"/.exec(html);
        return match === null ? null : new URL(match[1], agora.origin).pathname;
      };
      const card = async (imagePath) => {
        const response = await fetch(`${agora.origin}${imagePath}`, {
          headers: { "user-agent": USER_AGENT },
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        const png =
          bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
        return {
          status: response.status,
          type: response.headers.get("content-type"),
          bytes,
          width: png ? bytes.readUInt32BE(16) : 0,
          height: png ? bytes.readUInt32BE(20) : 0,
        };
      };
      const context = await browser.newContext({ userAgent: USER_AGENT });
      const page = await context.newPage();
      for (const path of [`/p/${problemId}`, `/p/${problemId}/claims/${claimId}`]) {
        const imagePath = await ogImagePath(path);
        record(`og ${path} declares an og:image on this origin`, imagePath !== null, imagePath);
        if (imagePath === null) continue;
        const image = await card(imagePath);
        record(
          `og ${path} serves a 1200x630 PNG`,
          image.status === 200 &&
            image.type?.startsWith("image/png") &&
            image.width === 1200 &&
            image.height === 630,
          { status: image.status, type: image.type, width: image.width, height: image.height },
        );
        const decoded = await page.evaluate(
          async (dataUrl) => {
            const img = new Image();
            img.src = dataUrl;
            await img.decode();
            return [img.naturalWidth, img.naturalHeight];
          },
          `data:image/png;base64,${image.bytes.toString("base64")}`,
        );
        record(
          `og ${path} decodes in Chromium`,
          decoded[0] === 1200 && decoded[1] === 630,
          decoded,
        );
      }
      // A card rendered from the live face changes when the ledger does; the
      // unavailable/not-found fallback depends only on the slug and cannot.
      const problemCard = await ogImagePath(`/p/${problemId}`);
      if (problemCard !== null) {
        const before = await card(problemCard);
        const draft = await fellowPost(
          target,
          `/v1/sessions/${sessionId}/workshop`,
          { type: "claim-draft", title: "Later", body_md: "Public-bound." },
          authorToken,
        );
        const later = await fellowPost(
          target,
          `/v1/sessions/${sessionId}/promote`,
          {
            workshop_id: draft.body.workshop_id,
            kind: "conjecture",
            statement: "Every odd square is 1 modulo 8 for n in 0..77.",
            falsifier: "An odd n in 0..77 whose square is not 1 modulo 8.",
          },
          authorToken,
        );
        const after = await card(problemCard);
        record(
          "og the problem card follows the live face (changes after a public write)",
          later.status === 201 && after.status === 200 && !after.bytes.equals(before.bytes),
          later.status,
        );
      }
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
        "real Chromium + next start + local Workerd/D1/R2; sponsor session minted with Agora's AUTH_SECRET (no Google OAuth exchange); no staging, Vercel or edge-cache claim",
    }),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
