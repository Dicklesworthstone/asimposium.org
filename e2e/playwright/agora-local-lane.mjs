/**
 * Real-browser Agora lane (bead asimposiumorg-uaw7).
 *
 *   node e2e/playwright/agora-local-lane.mjs            # needs `bun run build` in apps/web first
 *   node e2e/playwright/agora-local-lane.mjs --build    # builds apps/web itself (bun run e2e:agora-local)
 *   node e2e/playwright/agora-local-lane.mjs --dev      # identical checks on next dev --webpack; no production-build claim
 *   ASIMPOSIUM_CHROMIUM_EXECUTABLE=/path/to/chrome ... # optional existing local Chromium
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
 * Workshop buttons exercise real signed actions: failed low-bar promotion,
 * keep, discard/reopen, and publication of exact stored Fellow claims,
 * hypotheses and evidence, with real public record links and computed classes,
 * including a browser reload that retains the completed archived draft.
 * A directive is issued by clicking the console's server action, lands once in
 * the Fellow's inbox (never another sponsor's Fellow, never a public face),
 * is acknowledged by the Fellow, and shows as acknowledged on the console.
 * Sponsor commentary is posted, corrected and removed through actual forms;
 * the ledger keeps attribution and correction links, while public scientific
 * faces omit the commentary. Account changes and private destinations refuse.
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
import { gunzipSync } from "node:zlib";
import {
  ClaimFaceResponseSchema,
  ProblemFaceResponseSchema,
  SINGLE_TEAM_PROBLEM_NOTICE,
} from "../../packages/contracts/src/ledger.ts";
import { HonorsResponseSchema } from "../../packages/contracts/src/honors.ts";
import {
  parsePublicProblemExport,
  PUBLIC_EXPORT_FORMAT,
  verifyPublicProblemExportChain,
} from "../../apps/wire/src/krater/export.ts";
import { PUBLIC_EXPORT_MAX_BYTES } from "../../apps/wire/src/ledger/event-export-snapshot.ts";
import { SITE } from "../../apps/web/lib/site.ts";
import {
  enrollSetupFellow,
  fellowPost,
  SPONSOR,
  setUpProblem,
} from "../gauntlet/local-product-flow.mjs";
import { startLocalTarget, USER_AGENT } from "../gauntlet/local-target.mjs";
import {
  claimsListBrowsing,
  claimsListWithdrawal,
  seedClaimsList,
} from "./claims-list-browsing.mjs";
import {
  hypothesisLifecycleBrowsing,
  hypothesisPublicationWithdrawal,
  seedHypothesisLifecycle,
} from "./hypotheses-lifecycle.mjs";
import {
  scientificCollectionsBrowsing,
  scientificCollectionsWithdrawal,
  seedScientificCollections,
} from "./scientific-collections-browsing.mjs";
import { citationsBrowsing, citationsWithdrawal, seedCitations } from "./citations-browsing.mjs";
import { seedSyntheses, synthesisBrowsing, synthesisClosingReview } from "./synthesis-browsing.mjs";
import { ADMIN_OPERATORS, operatorModerationJourney } from "./operator-moderation.mjs";
import { runGalleryJourney } from "./gallery-runner.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(`${root}e2e/package.json`);
const { chromium } = require("@playwright/test");
const developmentMode = process.argv.includes("--dev");
const serverMode = developmentMode ? "development" : "production";
const browserOptions = {
  args: [`--user-agent=${USER_AGENT}`],
  ...(process.env.ASIMPOSIUM_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.ASIMPOSIUM_CHROMIUM_EXECUTABLE }
    : {}),
};
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
  'Squares keep parity <script>window.__asimpXss=1</script><img src=x onerror="window.__asimpXss=2"> [link](javascript:window.__asimpXss=3) for every n in 0..77.\n\n' +
  String.raw`**Mathematical statement:** $n^2 \equiv n \pmod{2}$.

$$
\sum_{k=1}^{n} k = \frac{n(n+1)}{2}
$$

| n | parity |
| --- | --- |
| 2 | even |

Unsafe TeX stays inert: $\href{javascript:window.__asimpXss=5}{click}$.
Malformed TeX stays readable: $\frac{1}{$.`;
const WORKSHOP_CANARY = "PRIVATE-WORKSHOP-CANARY-7Q4";
const SCRATCH_CANARY = "PRIVATE-SCRATCH-CANARY-2K9";
const GAP_OBLIGATION = "State the integer parity substitution explicitly (browser obligation 7Q4)";
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

// Failure-only observation must not hide the original native action timeout if
// the renderer or its protocol connection has stopped responding.
async function nativeClickFailureState(page, selector) {
  let timer;
  try {
    return await Promise.race([
      page.evaluate((selector) => {
        const sources = [...document.querySelectorAll(selector)];
        return {
          ready: document.readyState,
          fonts: document.fonts.status,
          visibility: document.visibilityState,
          time_origin: performance.timeOrigin,
          now_ms: performance.now(),
          scroll_y: window.scrollY,
          viewport_height: window.innerHeight,
          navigation: performance
            .getEntriesByType("navigation")
            .slice(0, 8)
            .map((entry) => ({
              type: entry.type,
              response_end_ms: entry.responseEnd,
              load_end_ms: entry.loadEventEnd,
              duration_ms: entry.duration,
            })),
          animation_count: document.getAnimations().length,
          source_count: sources.length,
          body_child_tags: [...document.body.children]
            .slice(0, 32)
            .map((element) => element.tagName),
          next_error_document: document.documentElement.id === "__next_error__",
          not_found_templates: document.querySelectorAll(
            'template[data-dgst="NEXT_HTTP_ERROR_FALLBACK;404"]',
          ).length,
          sources: sources.slice(0, 8).map((element) => {
            const box = element.getBoundingClientRect();
            return {
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
              connected: element.isConnected,
            };
          }),
        };
      }, selector),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ unavailable: true, reason: "diagnostic-timeout" }),
          1000,
        );
      }),
    ]);
  } catch {
    return { unavailable: true };
  } finally {
    clearTimeout(timer);
  }
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
  const negative = await fellowPost(
    target,
    `/v1/sessions/${sessionId}/dead-ends`,
    {
      approach: `Enumerate a finite parity interval as an attempted proof over all integers. ${XSS_CANARY}`,
      why_it_fails:
        "The finite parity interval does not establish an unbounded assertion without a reduction theorem.",
      retry_predicate: "Retry after an exact finite reduction is proved for the complete domain.",
      retry_when: { kind: "statement-revised" },
    },
    author.token,
  );
  assert.equal(negative.status, 201, `negative history publication ${negative.body.code ?? ""}`);

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
  const spare = await enrollSetupFellow(target, SPONSOR, "agora-lane-spare", ["review"]);
  const sameSponsorSession = await fellowPost(
    target,
    "/v1/sessions",
    {
      problem_id: problemId,
      intent: "review",
    },
    spare.token,
  );
  assert.equal(sameSponsorSession.status, 201, "same-sponsor review session");
  const sameSponsorReview = await fellowPost(
    target,
    `/v1/sessions/${sameSponsorSession.body.session_id}/review`,
    {
      target_claim_id: promoted.body.claim_id,
      target_version: 1,
      verdict: "inform",
      basis: "Checked the parity statement against its bounded falsifier.",
      capable_of_failure: "An opposite-parity square in the declared range would refute it.",
      body_md:
        "This review is by another Fellow of the author’s sponsor, not independent sponsorship.",
    },
    spare.token,
  );
  assert.equal(sameSponsorReview.status, 201, "same-sponsor review publication");
  // A deliberate false claim is conceded through the real typed path, without
  // an independent review. All pins come from public faces/event envelopes.
  // Its own ordinary Fellow preserves the original author's publication quota.
  const concessionAuthor = await enrollSetupFellow(
    target,
    "usr_agora_lane_concession",
    "agora-lane-concession-author",
    ["promote"],
  );
  const concessionSession = await fellowPost(
    target,
    "/v1/sessions",
    {
      problem_id: problemId,
      intent: "prove",
    },
    concessionAuthor.token,
  );
  assert.equal(concessionSession.status, 201, "concession author session");
  const concessionSessionId = concessionSession.body.session_id;
  const falseDraft = await fellowPost(
    target,
    `/v1/sessions/${concessionSessionId}/workshop`,
    {
      type: "claim-draft",
      title: "A false parity assertion",
      body_md: "Every integer square is odd.",
    },
    concessionAuthor.token,
  );
  assert.equal(falseDraft.status, 201);
  const falseClaim = await fellowPost(
    target,
    `/v1/sessions/${concessionSessionId}/promote`,
    {
      workshop_id: falseDraft.body.workshop_id,
      kind: "conjecture",
      statement: "For every integer n, the square n times n is odd.",
      falsifier: "An integer with an even square, such as n = 2.",
    },
    concessionAuthor.token,
  );
  assert.equal(falseClaim.status, 201, "false claim publication");
  const counterexample = await fellowPost(
    target,
    `/v1/sessions/${concessionSessionId}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: falseClaim.body.claim_id,
      bears_on_version: 1,
      direction: "refutes",
      kind: "argument",
      mode: "confirmatory",
      source: {
        kind: "locator",
        locator: "https://example.invalid/parity/two-squared",
        excerpt: "The square of 2 is 4, which is even.",
      },
      body_md: "At n = 2 the square is 4, an even integer. The universal oddness assertion fails.",
    },
    concessionAuthor.token,
  );
  assert.equal(counterexample.status, 201, "counterexample publication");
  const publicClaim = async (id) =>
    ClaimFaceResponseSchema.parse(
      await (
        await fetch(`${target.origin}/p/${problemId}/claims/${id}.json`, {
          headers: { "user-agent": USER_AGENT },
        })
      ).json(),
    );
  const disputed = await publicClaim(falseClaim.body.claim_id);
  assert.equal(disputed.claim_state.disposition, "disputed");
  const adverseBasis = disputed.claim_state.status_basis;
  assert.equal(adverseBasis?.kind, "transition");
  assert.equal(adverseBasis.cause, "refuting-evidence");
  const eventWindow = await (
    await fetch(
      `${target.origin}/p/${problemId}/events.json?since=${adverseBasis.seq - 1}&through=${adverseBasis.seq}&limit=1`,
      {
        headers: { "user-agent": USER_AGENT },
      },
    )
  ).json();
  const sourceEvent = eventWindow.events.find(
    (entry) => entry.event?.id === adverseBasis.event_id,
  )?.event;
  assert.equal(sourceEvent?.object_id, counterexample.body.evidence_id);
  const statement = JSON.parse(disputed.items.find((item) => item.kind === "claim-detail").body);
  const concession = await fellowPost(
    target,
    `/v1/sessions/${concessionSessionId}/retract`,
    {
      target_object: falseClaim.body.claim_id,
      reason: "I concede the oddness assertion because the square of 2 is even.",
      concession: {
        target_version: 1,
        target_digest: statement.content_digest,
        evidence: {
          evidence_id: counterexample.body.evidence_id,
          digest: `sha256:${sourceEvent.payload_sha256}`,
        },
      },
    },
    concessionAuthor.token,
  );
  assert.equal(concession.status, 201, `author concession ${concession.body.code ?? ""}`);
  const conceded = await publicClaim(falseClaim.body.claim_id);
  assert.equal(conceded.claim_state.disposition, "refuted");
  assert.equal(conceded.claim_state.review_state, "unreviewed");
  assert.equal(conceded.claim_state.status_basis?.cause, "author-concession");
  assert.equal(conceded.claim_state.status_basis.seq, concession.body.seq);
  const hypothesisLifecycle = await seedHypothesisLifecycle(target, problemId);
  // Keep these filings last: the original pagination assertions require the
  // final gap cursor to equal the live problem head at the start of browsing.
  // Nine real filings exceed the canonical eight-item page budget. The ninth
  // must remain reachable through continuation and the registered exact URL.
  const gapIds = [];
  let gapCursor;
  for (let index = 1; index <= 9; index += 1) {
    const gap = await fellowPost(
      target,
      `/v1/sessions/${sessionId}/gaps`,
      {
        target_claim_id: promoted.body.claim_id,
        target_version: 1,
        obligation: `${GAP_OBLIGATION}, step ${index}.`,
        closes_what: `This supplies missing step ${index} in the claimed parity argument.`,
      },
      author.token,
    );
    assert.equal(gap.status, 201, `gap filing ${gap.body.code ?? ""}`);
    gapIds.push(gap.body.gap_id);
    gapCursor = gap.body.seq;
  }
  return {
    problemId,
    claimId: promoted.body.claim_id,
    noveltyId: noveltyClaim.body.claim_id,
    reviewId: noveltyReview.body.review_id,
    fellowId: author.fellowId,
    authorToken: author.token,
    reviewerToken: reviewer.token,
    // A second Fellow of the same sponsor, for an individual revocation.
    spareToken: spare.token,
    // A third, offered to the reviewer's sponsor through the transfer card.
    transferToken: (await enrollSetupFellow(target, SPONSOR, "agora-lane-transfer", ["review"]))
      .token,
    sessionId,
    gapIds,
    gapCursor,
    deadEndId: negative.body.dead_end_id,
    concessionClaimId: falseClaim.body.claim_id,
    claimReviewId: sameSponsorReview.body.review_id,
    claimReviewFellowId: spare.fellowId,
    concessionEvidenceId: counterexample.body.evidence_id,
    concessionEvidenceFellowId: concessionAuthor.fellowId,
    concessionBasis: conceded.claim_state.status_basis,
    hypothesisLifecycle,
  };
}

async function proofGapBrowsing({ page, agora, problemId, claimId, gapIds, gapCursor, mode }) {
  const listPath = `/p/${problemId}/gaps`;
  const firstId = gapIds[0];
  const lastId = gapIds.at(-1);
  await page.goto(`${agora.origin}${listPath}`, { waitUntil: "load" });
  const firstPage = await page.textContent("body");
  const continuation = await page
    .getByRole("link", { name: "Next proof gaps at this snapshot", exact: true })
    .getAttribute("href");
  const expectedContinuation = `${listPath}?through=${gapCursor}&after=${gapIds[7].slice(2)}`;
  record(
    `${mode} proof gaps: real filings render within an eight-item budget with a frozen continuation`,
    (await page.locator("[data-gap-status]").count()) === 8 &&
      firstPage.includes(`${GAP_OBLIGATION}, step 1.`) &&
      !firstPage.includes(`${GAP_OBLIGATION}, step 9.`) &&
      continuation === expectedContinuation,
    { cards: await page.locator("[data-gap-status]").count(), continuation },
  );
  await page.getByRole("link", { name: "Next proof gaps at this snapshot", exact: true }).click();
  await page.waitForURL(`${agora.origin}${expectedContinuation}`);
  await page.getByText(`${GAP_OBLIGATION}, step 9.`, { exact: true }).waitFor();
  // Next retains earlier public Flight scripts after a client navigation.
  // Pagination concerns the visible list, not those inert serialized payloads.
  const secondPage = await page.locator("main").innerText();
  record(
    `${mode} proof gaps: continuation shows the remaining filing once at the same snapshot`,
    new URL(page.url()).pathname + new URL(page.url()).search === expectedContinuation &&
      (await page.locator("[data-gap-status]").count()) === 1 &&
      secondPage.includes(`${GAP_OBLIGATION}, step 9.`) &&
      !secondPage.includes(`${GAP_OBLIGATION}, step 1.`) &&
      (await page
        .getByRole("link", { name: "Next proof gaps at this snapshot", exact: true })
        .count()) === 0,
    {
      path: new URL(page.url()).pathname + new URL(page.url()).search,
      cards: await page.locator("[data-gap-status]").count(),
      has_last: secondPage.includes(`${GAP_OBLIGATION}, step 9.`),
      has_first: secondPage.includes(`${GAP_OBLIGATION}, step 1.`),
      continuations: await page
        .getByRole("link", { name: "Next proof gaps at this snapshot", exact: true })
        .count(),
    },
  );
  const response = await page.goto(
    `${agora.origin}/r/p/${problemId}/gaps/${lastId}?through=${gapCursor}`,
    { waitUntil: "load" },
  );
  const exact = page.getByRole("link", { name: `Exact claim ${claimId}@1`, exact: true });
  record(
    `${mode} proof gaps: registered exact URL reaches a filing beyond the first page`,
    response?.status() === 200 &&
      new URL(page.url()).search === `?through=${gapCursor}&target=${lastId}` &&
      (await page.locator("[data-gap-status='open']").count()) === 1 &&
      (await page.textContent("body")).includes(`${GAP_OBLIGATION}, step 9.`) &&
      (await exact.getAttribute("href")) ===
        `/p/${problemId}/claims/${claimId}%401?through=${gapCursor}`,
  );
  const clickStarted = performance.now();
  const navigations = [];
  const onNavigation = (frame) => {
    if (frame === page.mainFrame() && navigations.length < 8) {
      navigations.push({
        elapsed_ms: performance.now() - clickStarted,
        path: new URL(frame.url()).pathname,
      });
    }
  };
  page.on("framenavigated", onNavigation);
  try {
    await exact.click();
  } catch (error) {
    const state = await nativeClickFailureState(page, ".claim-card > p > a");
    console.error(
      JSON.stringify({
        stage: "proof-gap-exact-claim-click-failed",
        mode,
        path: listPath,
        elapsed_ms: performance.now() - clickStarted,
        navigations,
        state,
      }),
    );
    throw error;
  } finally {
    page.off("framenavigated", onNavigation);
  }
  await page.waitForURL(
    (url) => decodeURIComponent(url.pathname) === `/p/${problemId}/claims/${claimId}@1`,
  );
  await page.getByRole("heading", { name: `${claimId}@1`, exact: true }).waitFor();
  await page.waitForFunction(() => document.body.innerText.includes("Squares keep parity"));
  record(
    `${mode} proof gaps: exact claim link opens the published version at the same cut`,
    decodeURIComponent(new URL(page.url()).pathname) === `/p/${problemId}/claims/${claimId}@1` &&
      new URL(page.url()).search === `?through=${gapCursor}` &&
      (await page.textContent("body")).includes("Squares keep parity"),
  );
  for (const path of [
    `${listPath}?through=01`,
    `${listPath}?target=${firstId}&target=${lastId}`,
    `${listPath}?through=${gapCursor}&after=${gapCursor + 1}`,
    `/r/p/${problemId}/gaps/${firstId}?target=${lastId}`,
  ]) {
    await page.goto(`${agora.origin}${path}`, { waitUntil: "load" });
    record(
      `${mode} proof gaps: malformed or substituted query refuses ${path}`,
      (await page
        .getByRole("heading", { name: "Invalid proof-gap view", exact: true })
        .isVisible()) &&
        !(await page.content()).includes(GAP_OBLIGATION) &&
        (await page.locator("[data-gap-status]").count()) === 0,
    );
  }
}

async function publicLedgerDownload({ page, target, problemId, mode }) {
  const link = page.getByRole("link", {
    name: "Download current public ledger (.jsonl.gz)",
    exact: true,
  });
  const href = `${target.origin}/p/${problemId}/export.jsonl.gz`;
  const canonical = (await link.count()) === 1 && (await link.getAttribute("href")) === href;
  record(`${mode} dataset: problem history exposes one canonical Worker download`, canonical);
  assert.ok(canonical, "the canonical Worker dataset download link must exist exactly once");
  const history = await page.locator("#history-heading").locator("..").innerText();
  record(
    `${mode} dataset: scope distinguishes current public events from private workshops`,
    history.includes("CC BY 4.0") &&
      history.includes("current ledger") &&
      history.includes("newer than this page’s snapshot") &&
      history.includes("Private workshops and account credentials are excluded") &&
      history.includes("withheld or too large") &&
      history.includes("event history above"),
  );
  const head = await target.env.DB.prepare(`SELECT p.public_seq, p.chain_digest,
    (SELECT COUNT(*) FROM events e WHERE e.problem_id = p.id AND e.seq <= p.public_seq) AS event_count
    FROM problems p WHERE p.id = ?`)
    .bind(problemId)
    .first();
  const pageUrl = page.url();
  const attachment = page.waitForEvent("download");
  const response = page.waitForResponse((value) => value.url() === href);
  await link.click();
  const download = await attachment;
  const receipt = await response;
  const headers = receipt.headers();
  record(
    `${mode} dataset: clicked response is a private no-store gzip attachment`,
    receipt.status() === 200 &&
      headers["content-type"] === "application/gzip" &&
      headers["content-disposition"] === `attachment; filename="${problemId}.export.jsonl.gz"` &&
      /\bprivate\b/.test(headers["cache-control"] ?? "") &&
      /\bno-store\b/.test(headers["cache-control"] ?? "") &&
      privateToCaches(headers),
  );
  record(
    `${mode} dataset: native click receives the named attachment without navigating the page`,
    download.url() === href &&
      download.suggestedFilename() === `${problemId}.export.jsonl.gz` &&
      page.url() === pageUrl &&
      (await download.failure()) === null,
  );
  const chunks = [];
  const stream = await download.createReadStream();
  assert.ok(stream, "the actual browser download must be readable");
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = gunzipSync(Buffer.concat(chunks), { maxOutputLength: PUBLIC_EXPORT_MAX_BYTES });
  const ndjson = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const header = JSON.parse(ndjson.slice(0, ndjson.indexOf("\n")));
  const parsed = parsePublicProblemExport(ndjson);
  record(
    `${mode} dataset: downloaded gzip has strict v5 framing, public license and exact problem`,
    parsed.ok &&
      parsed.format === PUBLIC_EXPORT_FORMAT &&
      header.license === "CC BY 4.0" &&
      parsed.header.problem === problemId &&
      parsed.trailer.finalCursor === head.public_seq &&
      parsed.trailer.eventCount === head.event_count &&
      head.event_count > 0,
  );
  const verified = await verifyPublicProblemExportChain(ndjson);
  record(
    `${mode} dataset: complete downloaded event chain agrees with the independent live D1 head`,
    verified.intact &&
      verified.eventCount === head.event_count &&
      verified.finalChainDigest === head.chain_digest,
  );
  record(
    `${mode} dataset: the actual archive omits private workshop and scratch canaries`,
    !ndjson.includes(WORKSHOP_CANARY) && !ndjson.includes(SCRATCH_CANARY),
  );
}

async function proofGapWithdrawal({
  target,
  browser,
  agora,
  problemId,
  sessionId,
  authorToken,
  gapIds,
  gapCursor,
}) {
  const firstId = gapIds[0];
  const withdrawn = await fellowPost(
    target,
    `/v1/sessions/${sessionId}/gaps/close`,
    { gap_id: firstId, outcome: "withdrawn" },
    authorToken,
  );
  assert.equal(withdrawn.status, 201, `gap withdrawal ${withdrawn.body.code ?? ""}`);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${agora.origin}/p/${problemId}/gaps?target=${firstId}`, { waitUntil: "load" });
    record(
      "proof gaps: a real withdrawal appears as withdrawn, with no proof claim",
      (await page.locator("[data-gap-status='withdrawn']").count()) === 1 &&
        (await page.locator("[data-gap-status='closed-by'], [data-gap-status='open']").count()) ===
          0 &&
        (await page.textContent("body")).includes("Withdrawal is not a proof."),
    );
    const historicalPath = `/p/${problemId}/gaps?through=${gapCursor}&target=${firstId}`;
    await page.goto(`${agora.origin}${historicalPath}`, { waitUntil: "load" });
    record(
      "proof gaps: an earlier cut retains the recorded pre-withdrawal status",
      (await page.locator("[data-gap-status='open']").count()) === 1 &&
        (await page.textContent("body")).includes(`${GAP_OBLIGATION}, step 1.`),
    );
    // Explicit ephemeral operator fixture, as used by the real-binding content
    // control tests: append a visibility decision without rewriting publication
    // bytes. This browser check exercises present-day hiding on an older cut.
    await target.env.DB.prepare(`INSERT INTO content_controls
      (control_id, problem_id, target_kind, target_ref, visibility, source,
       reason_category, actor, reason, version, created_at)
      VALUES (?, ?, 'gap', ?, 'hidden', 'operator', 'privacy', 'agora-gap-visibility-fixture',
       'Exercise current content controls on a historical public gap.', 1, ?)`)
      .bind(`CC-agora-gap-${firstId}`, problemId, firstId, new Date().toISOString())
      .run();
    await page.reload({ waitUntil: "load" });
    record(
      "proof gaps: current withholding removes old obligation bytes from a pinned browser view",
      (await page.locator("[data-gap-status='unavailable']").count()) === 1 &&
        (await page.locator("[data-gap-status='open'], [data-gap-status='withdrawn']").count()) ===
          0 &&
        !(await page.content()).includes(GAP_OBLIGATION) &&
        (await page.textContent("body")).includes("currently withheld or unavailable"),
    );
    const archive = await fetch(`${target.origin}/p/${problemId}/export.jsonl.gz`, {
      headers: { "user-agent": USER_AGENT },
    });
    const refusal = await archive.json();
    record(
      "dataset: current withholding refuses the complete archive rather than returning partial gzip",
      archive.status === 409 &&
        refusal.code === "PUBLIC_EXPORT_CONTENT_WITHHELD" &&
        archive.headers.get("content-type")?.includes("application/problem+json") &&
        archive.headers.get("content-disposition") === null &&
        privateToCaches(Object.fromEntries(archive.headers)) &&
        !JSON.stringify(refusal).includes(GAP_OBLIGATION),
    );
  } finally {
    await context.close();
  }
}

async function commentaryJourney({
  target,
  agora,
  sponsorPage,
  signedIn,
  encode,
  problemId,
  claimId,
}) {
  const path = `/console/commentary/${problemId}`;
  const originalText =
    'Human boundary note COMMENTARY-BROWSER-7Q4 <img src=x onerror="window.__commentaryXss=1">';
  const correctedText =
    "Corrected human boundary note COMMENTARY-CORRECTION-2K9: the endpoint needs a separate argument.";
  const switchText = "UNCOMMITTED-ACCOUNT-SWITCH-COMMENTARY-5J2";
  const setAccount = async (sub) =>
    signedIn.addCookies([
      {
        name: SESSION_COOKIE,
        value: await encode({
          token: { sub, name: "Local sponsor", authTime: Math.floor(Date.now() / 1000) },
          secret: AUTH_SECRET,
          salt: SESSION_COOKIE,
        }),
        url: agora.origin,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  const commentaryRows = async () =>
    (
      await target.env.DB.prepare(
        "SELECT id, seq, sponsor_id, body, supersedes_commentary_id, superseded_by_commentary_id, tombstoned FROM problem_commentaries WHERE problem_id = ? ORDER BY seq",
      )
        .bind(problemId)
        .all()
    ).results;

  await sponsorPage
    .getByRole("link", { name: "Post sponsor commentary in console", exact: true })
    .click();
  await sponsorPage.waitForURL(`${agora.origin}${path}#compose-commentary`);
  const composer = sponsorPage.locator('section[aria-labelledby="compose-commentary"]');
  await composer.getByLabel("Public commentary", { exact: true }).fill(originalText);
  await composer.getByText("References (optional)", { exact: true }).click();
  await composer.getByRole("button", { name: "Add reference", exact: true }).click();
  await composer.getByLabel("Object ID", { exact: true }).fill(claimId);
  await composer
    .getByLabel("Label (optional)", { exact: true })
    .fill("Human context for the boundary");
  await composer.getByRole("button", { name: "Post public commentary", exact: true }).click();
  await composer
    .getByRole("status")
    .filter({ hasText: "Your commentary is published." })
    .waitFor({ timeout: 20_000 });
  const firstRows = await commentaryRows();
  const original = firstRows.find((row) => row.body === originalText);
  record(
    "commentary: the real form posts one sponsor-attributed public entry",
    firstRows.length === 1 && original?.sponsor_id === SPONSOR,
  );
  assert.ok(original, "the real commentary post must return its durable row");
  await composer.getByRole("link", { name: "View its public record", exact: true }).click();
  await sponsorPage.waitForURL(
    (url) => url.pathname === `/p/${problemId}` && url.hash === `#commentary-${original.id}`,
  );
  const publicEntry = sponsorPage.locator(`#commentary-${original.id}`);
  await publicEntry.waitFor({ state: "visible" });
  record(
    "commentary: the receipt opens its exact public record with inert human text",
    (await publicEntry.textContent()).includes(originalText) &&
      (await sponsorPage.evaluate(() => window.__commentaryXss === undefined)) &&
      (await publicEntry.locator("img").count()) === 0,
  );
  const scientificFace = await (
    await fetch(`${target.origin}/p/${problemId}.json`, { headers: { "user-agent": USER_AGENT } })
  ).text();
  record(
    "commentary: human discussion never enters the default scientific face",
    !scientificFace.includes("COMMENTARY-BROWSER-7Q4") &&
      !scientificFace.includes("Human context for the boundary"),
  );

  await sponsorPage.goto(`${agora.origin}${path}`, { waitUntil: "load" });
  const originalCard = sponsorPage.locator(`#commentary-${original.id}`);
  await originalCard.getByText("Correct your commentary", { exact: true }).click();
  await originalCard.getByLabel("Corrected public commentary", { exact: true }).fill(correctedText);
  await originalCard.getByRole("button", { name: "Publish correction", exact: true }).click();
  await originalCard
    .getByRole("status")
    .filter({ hasText: "Your correction is published." })
    .waitFor({ timeout: 20_000 });
  const correctedRows = await commentaryRows();
  const corrected = correctedRows.find((row) => row.body === correctedText);
  record(
    "commentary: correction appends one linked entry and preserves the original bytes",
    correctedRows.length === 2 &&
      corrected?.sponsor_id === SPONSOR &&
      corrected.supersedes_commentary_id === original.id &&
      correctedRows.find((row) => row.id === original.id)?.superseded_by_commentary_id ===
        corrected.id &&
      correctedRows.find((row) => row.id === original.id)?.body === originalText,
  );
  assert.ok(corrected, "the correction must be a new durable entry");
  const correctedCard = sponsorPage.locator(`#commentary-${corrected.id}`);
  await correctedCard.getByText("Remove your public text", { exact: true }).click();
  await correctedCard.getByRole("checkbox").check();
  await correctedCard.getByRole("button", { name: "Remove my public text", exact: true }).click();
  await correctedCard
    .getByRole("status")
    .filter({ hasText: "public text has been removed" })
    .waitFor({ timeout: 20_000 });
  const removedRows = await commentaryRows();
  record(
    "commentary: exact-entry removal keeps the attributed tombstone and the earlier history",
    removedRows.length === 2 &&
      removedRows.find((row) => row.id === corrected.id)?.tombstoned === 1 &&
      removedRows.find((row) => row.id === corrected.id)?.body === null &&
      removedRows.find((row) => row.id === original.id)?.body === originalText,
  );
  await correctedCard.getByRole("link", { name: "View its public record", exact: true }).click();
  await sponsorPage.waitForURL(
    (url) => url.pathname === `/p/${problemId}` && url.hash === `#commentary-${corrected.id}`,
  );
  const removedEntry = sponsorPage.locator(`#commentary-${corrected.id}`);
  await removedEntry.waitFor({ state: "visible" });
  record(
    "commentary: public removal suppresses both body and reference labels",
    !(await removedEntry.textContent()).includes("COMMENTARY-CORRECTION-2K9") &&
      !(await removedEntry.textContent()).includes("Human context for the boundary"),
  );

  await sponsorPage.goto(`${agora.origin}${path}`, { waitUntil: "load" });
  await composer.getByLabel("Public commentary", { exact: true }).fill(switchText);
  await setAccount("usr_agora_lane_reviewer");
  await composer.getByRole("button", { name: "Post public commentary", exact: true }).click();
  await composer
    .getByRole("alert")
    .filter({ hasText: "Your signed-in account changed" })
    .waitFor({ timeout: 20_000 });
  record(
    "commentary: changing account while a form is open refuses the old sponsor intent",
    (await commentaryRows()).length === 2 &&
      !(await commentaryRows()).some((row) => row.body === switchText),
  );
  await sponsorPage.reload({ waitUntil: "load" });
  record(
    "commentary: another signed-in sponsor sees public history without the author's edit controls",
    (await sponsorPage.getByText("Correct your commentary", { exact: true }).count()) === 0 &&
      (await sponsorPage.getByText("Remove your public text", { exact: true }).count()) === 0 &&
      (await composer.getByLabel("Public commentary", { exact: true }).count()) === 1,
  );

  const privateOwner = "usr_agora_commentary_private";
  const steward = await enrollSetupFellow(target, privateOwner, "agora-commentary-steward", [
    "propose-problems",
  ]);
  const draftProblem = {
    title: "Private divisibility calibration for commentary",
    statement: "Every integer divisible by six is divisible by three, including negative integers.",
    falsifier: "An integer divisible by six that is not divisible by three.",
    motivation:
      "A private draft used to verify that human commentary cannot publish hidden problem context.",
    areas: ["number-theory"],
  };
  const brief = await target.sponsor(
    privateOwner,
    "POST",
    "/v1/sponsors/problem-briefs",
    "save-problem-brief",
    { ...draftProblem, assigned_fellow_id: steward.fellowId },
  );
  assert.equal(brief.status, 201);
  const proposed = await fellowPost(
    target,
    "/v1/problems",
    {
      ...draftProblem,
      brief_id: brief.body.brief.id,
      expected_brief_version: brief.body.brief.version,
    },
    steward.token,
  );
  assert.equal(proposed.status, 201);
  const privateId = proposed.body.problem.id;
  const privatePost = await target.sponsor(
    privateOwner,
    "POST",
    `/v1/problems/${privateId}/commentary`,
    "post-commentary",
    { problem_id: privateId, body: "PRIVATE-COMMENTARY-MUST-NOT-PUBLISH-3W8" },
  );
  await setAccount(privateOwner);
  const privateResponse = await sponsorPage.goto(
    `${agora.origin}/console/commentary/${privateId}`,
    { waitUntil: "load" },
  );
  await sponsorPage
    .getByRole("heading", { name: "Nothing is served at this address", exact: true })
    .waitFor();
  const privateForms = await sponsorPage.locator("form").count();
  const privateNotFound = await sponsorPage
    .getByRole("heading", { name: "Nothing is served at this address", exact: true })
    .isVisible();
  const privateStatementVisible = (await sponsorPage.content()).includes(draftProblem.statement);
  record(
    "commentary: even the private problem owner cannot open a public composer or post hidden commentary",
    privatePost.status === 404 &&
      privatePost.body.code === "PROBLEM_NOT_FOUND" &&
      // Next may have begun the streamed response before notFound() resolves.
      // The visible not-found face and absence of all forms/bytes are required.
      (privateResponse?.status() === 404 || privateResponse?.status() === 200) &&
      privateNotFound &&
      privateForms === 0 &&
      !privateStatementVisible,
    {
      worker_status: privatePost.status,
      worker_code: privatePost.body.code,
      agora_status: privateResponse?.status(),
      not_found_visible: privateNotFound,
      forms: privateForms,
      statement_visible: privateStatementVisible,
    },
  );
  await sponsorPage.goto(`${agora.origin}/p/${privateId}/gaps`, { waitUntil: "load" });
  record(
    "proof gaps: a private problem remains unavailable on the public page even to its signed-in owner",
    (await sponsorPage
      .getByRole("heading", { name: "Nothing is served at this address", exact: true })
      .isVisible()) &&
      !(await sponsorPage.content()).includes(draftProblem.statement) &&
      (await sponsorPage.locator("[data-gap-status]").count()) === 0,
  );
  await sponsorPage.goto(`${agora.origin}/p/${privateId}`, { waitUntil: "load" });
  const privateArchive = await fetch(`${target.origin}/p/${privateId}/export.jsonl.gz`, {
    headers: { "user-agent": USER_AGENT },
  });
  record(
    "dataset: the private problem owner has no public download control or archive access",
    (await sponsorPage
      .getByRole("link", { name: "Download current public ledger (.jsonl.gz)", exact: true })
      .count()) === 0 &&
      !(await sponsorPage.content()).includes(draftProblem.statement) &&
      privateArchive.status === 404 &&
      privateArchive.headers.get("content-disposition") === null &&
      !(await privateArchive.text()).includes(draftProblem.statement),
  );
  await setAccount(SPONSOR);
}

async function startAgora(stoaOrigin, signingEnv) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      createRequire(`${root}apps/web/package.json`).resolve("next/dist/bin/next"),
      ...(developmentMode ? ["dev", "--webpack"] : ["start"]),
      "-p",
      String(port),
      "-H",
      "127.0.0.1",
    ],
    {
      cwd: `${root}apps/web`,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...(process.env.NODE_OPTIONS === undefined
          ? {}
          : { NODE_OPTIONS: process.env.NODE_OPTIONS }),
        NODE_ENV: serverMode,
        STOA_ORIGIN: stoaOrigin,
        AUTH_SECRET,
        AUTH_TRUST_HOST: "true",
        OPERATOR_PRINCIPAL_IDS: ADMIN_OPERATORS.join(","),
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
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await stopAgora(child);
  throw new Error(`next ${developmentMode ? "dev" : "start"} did not come up: ${log}`);
}

async function stopAgora(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.kill("SIGTERM");
  try {
    await exited;
  } finally {
    clearTimeout(deadline);
  }
}

async function main() {
  if (developmentMode && process.argv.includes("--build")) {
    console.log(
      JSON.stringify({
        kind: "agora-local-lane-summary",
        status: "fail",
        server_mode: serverMode,
        code: "AGORA_LANE_ARGUMENTS_INVALID",
        detail: "Use either --dev or --build, not both.",
      }),
    );
    process.exit(1);
  }
  // Blocked, not failed, when there is no browser to drive; probed with a real
  // launch first so a missing binary costs seconds, not a Next build.
  try {
    console.log(
      JSON.stringify({ kind: "agora-local-lane-stage", stage: "browser-preflight-launch" }),
    );
    const preflightBrowser = await chromium.launch(browserOptions);
    console.log(
      JSON.stringify({ kind: "agora-local-lane-stage", stage: "browser-preflight-launched" }),
    );
    await preflightBrowser.close();
    console.log(
      JSON.stringify({ kind: "agora-local-lane-stage", stage: "browser-preflight-closed" }),
    );
  } catch (error) {
    if (!/Executable doesn't exist|browserType\.launch/i.test(String(error?.message ?? error))) {
      throw error;
    }
    console.log(
      JSON.stringify({
        kind: "agora-local-lane-summary",
        server_mode: serverMode,
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
          server_mode: serverMode,
          status: "fail",
          code: "AGORA_BUILD_FAILED",
        }),
      );
      process.exit(1);
    }
  }
  const target = await startLocalTarget({
    injectPromoteRefusal: false,
    operatorPrincipalIds: ADMIN_OPERATORS,
  });
  let agora;
  let browser;
  try {
    const {
      problemId,
      claimId,
      noveltyId,
      reviewId,
      fellowId,
      authorToken,
      reviewerToken,
      spareToken,
      transferToken,
      sessionId,
      gapIds,
      gapCursor,
      deadEndId,
      concessionClaimId,
      claimReviewId,
      claimReviewFellowId,
      concessionEvidenceId,
      concessionEvidenceFellowId,
      concessionBasis,
      hypothesisLifecycle,
    } = await seed(target);
    const claimsList = await seedClaimsList(target);
    const scientificCollections = await seedScientificCollections(target, claimsList);
    const citations = await seedCitations(target);
    const syntheses = await seedSyntheses(target);
    // A separate real board preserves all earlier scenarios. Its current
    // roster becomes single-team while the earlier cross-sponsor statement
    // review stays in the ledger; the warning cannot deny that history.
    const singleTeamProblemId = await setUpProblem(target, 4);
    const singleTeamOwner = (
      await target.env.DB.prepare("SELECT sponsor_id FROM problems WHERE id=?")
        .bind(singleTeamProblemId)
        .first()
    ).sponsor_id;
    const noticeRoster = (
      await target.env.DB.prepare(`SELECT m.fellow_id,f.sponsor_id
      FROM problem_memberships m JOIN enrollment_fellows f ON f.fellow_id=m.fellow_id
      WHERE m.problem_id=?`)
        .bind(singleTeamProblemId)
        .all()
    ).results;
    assert.ok(noticeRoster.some((member) => member.sponsor_id !== singleTeamOwner));
    const changeNoticeRoster = async (operation) => {
      for (const member of noticeRoster.filter((member) => member.sponsor_id !== singleTeamOwner)) {
        const changed = await target.sponsor(
          singleTeamOwner,
          "POST",
          `/v1/sponsors/problems/${singleTeamProblemId}/lifecycle`,
          "problem-lifecycle",
          {
            action: "manage-member",
            operation,
            target_fellow_id: member.fellow_id,
            ...(operation === "set-role" ? { role: "contributor" } : {}),
          },
        );
        assert.equal(changed.status, 200, "the current steward changes the actual membership");
      }
    };
    await changeNoticeRoster("remove");
    const rosterNoticeFace = ProblemFaceResponseSchema.parse(
      await (
        await fetch(`${target.origin}/p/${singleTeamProblemId}.json`, {
          headers: { "user-agent": USER_AGENT },
        })
      ).json(),
    );
    record(
      "single-team source: canonical current roster notice preserves a real earlier review",
      rosterNoticeFace.omitted.some(
        (item) =>
          item.reason === "single_team" &&
          item.detail === `Single-team problem: ${SINGLE_TEAM_PROBLEM_NOTICE}`,
      ) && rosterNoticeFace.items.some((item) => item.kind === "statement-review"),
    );
    const claimProbe = await fetch(`${target.origin}/p/${problemId}/claims/${claimId}.json`, {
      headers: { "user-agent": USER_AGENT },
    });
    const claimProbeBody = await claimProbe.json();
    const claimProbeShape = ClaimFaceResponseSchema.safeParse(claimProbeBody);
    record(
      "claim source: the current canonical face satisfies the shared contract",
      claimProbe.status === 200 && claimProbeShape.success,
      {
        status: claimProbe.status,
        code: claimProbeBody.code ?? null,
        issues: claimProbeShape.success
          ? []
          : claimProbeShape.error.issues.map((i) => ({ path: i.path, code: i.code })),
      },
    );
    agora = await startAgora(target.origin, await target.agoraSigningEnv());
    browser = await chromium.launch(browserOptions);

    {
      const { encode } = await import(
        require.resolve("next-auth/jwt", {
          paths: [`${root}apps/web`],
        })
      );
      const contexts = [];
      try {
        const pages = [];
        for (const sponsorId of ["usr_gallery_owner", "usr_gallery_other"]) {
          const bootstrap = await target.sponsor(
            sponsorId,
            "POST",
            "/v1/sponsors/bootstrap",
            "sponsor.bootstrap",
            {},
          );
          assert.ok(bootstrap.status === 200 || bootstrap.status === 201);
          const context = await browser.newContext();
          contexts.push(context);
          await context.addCookies([
            {
              name: SESSION_COOKIE,
              value: await encode({
                token: {
                  sub: sponsorId,
                  name: "Local Gallery sponsor",
                  authTime: Math.floor(Date.now() / 1000),
                },
                secret: AUTH_SECRET,
                salt: SESSION_COOKIE,
              }),
              url: agora.origin,
              httpOnly: true,
              sameSite: "Lax",
            },
          ]);
          const page = await context.newPage();
          page.setDefaultTimeout(20_000);
          pages.push(page);
        }
        const anonymous = await browser.newContext();
        contexts.push(anonymous);
        const completed = await runGalleryJourney({
          sponsorPage: pages[0],
          otherSponsorPage: pages[1],
          anonymousPage: await anonymous.newPage(),
          agoraOrigin: agora.origin,
          workerOrigin: target.origin,
          problemId,
          runId: "gallery-local-product",
        });
        record(
          "Gallery shared journey completes with two local sponsor sessions",
          completed.length === 10,
        );
      } finally {
        await Promise.all(contexts.map((context) => context.close()));
      }
    }

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
      const context = await browser.newContext();
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
      "/explore",
      "/area/number-theory",
      "/a/agora-lane-author",
      "/a/agora-lane-reviewer",
      `/r/p/${problemId}/reviews/${reviewId}`,
      `/p/${problemId}`,
      `/p/${problemId}/claims/${claimId}`,
      `/p/${problemId}/gaps`,
      `/r/p/${problemId}/gaps/${gapIds[0]}`,
      "/now",
      "/results",
      "/search?q=parity",
    ];

    for (const javaScriptEnabled of [true, false]) {
      const context = await browser.newContext({ javaScriptEnabled });
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
      const honorsResponse = await fetch(`${target.origin}/results.json`, {
        headers: { "user-agent": USER_AGENT },
      });
      assert.equal(honorsResponse.status, 200, "canonical Honors record");
      const honorsFace = HonorsResponseSchema.parse(await honorsResponse.json());
      await page.goto(agora.origin, { waitUntil: "load" });
      await page.getByRole("link", { name: "Honors record", exact: true }).click();
      await page.waitForURL(`${agora.origin}/results`);
      await page.getByRole("heading", { name: "Honors Record", exact: true, level: 1 }).waitFor();
      const honorsDescription = "Chronological record of claim recognition and problem resolution events. Inspect the recorded standing and evidence for each entry.";
      const honorsHeader = await page.locator("main > header").innerText();
      record(`${mode} Honors: discovery and metadata describe recognition events without blanket certainty`,
        honorsHeader.includes(honorsDescription) &&
          !honorsHeader.includes("conclusively settled") &&
          await page.locator('meta[name="description"]').getAttribute("content") === honorsDescription);
      const displayedHonors = await page.locator("li.result-card").evaluateAll((cards) => cards.map((card) => [
        card.querySelector(".result-sub code")?.textContent?.trim(),
        card.querySelector(".status-badge")?.textContent?.trim(),
      ]));
      const honorsHeading = page.locator("#results-heading");
      const headingText = await honorsHeading.textContent();
      const visibleHeadingText = await honorsHeading.innerText();
      const expectedHeading = `Honors entries on this page (${honorsFace.results.length})`;
      const entriesMatch = JSON.stringify(displayedHonors) === JSON.stringify(honorsFace.results.map((item) => [
        `${item.result_id}${item.kind === "claim" ? `@${item.version}` : ""}`, item.status,
      ]));
      record(`${mode} Honors: the returned page keeps canonical entry order and individual standing`,
        entriesMatch && await honorsHeading.isVisible() && headingText.includes(expectedHeading),
        {
          entries_match: entriesMatch,
          expected_count: honorsFace.results.length,
          rendered_count: displayedHonors.length,
          logical_heading_matches: headingText.includes(expectedHeading),
          visible_heading_matches_case: visibleHeadingText.includes(expectedHeading),
          heading_text_transform: await honorsHeading.evaluate((element) => getComputedStyle(element).textTransform),
        });
      const honorsMdHref = await page.getByRole("link", { name: "Honors Markdown face", exact: false }).getAttribute("href");
      record(`${mode} Honors: the human page points at its canonical agent record`,
        honorsMdHref === `${target.origin}/results.md`);
      for (const suffix of ["md", "html"]) {
        const response = await fetch(`${target.origin}/results.${suffix}`, {
          headers: { "user-agent": USER_AGENT },
        });
        const body = await response.text();
        record(`${mode} Honors: canonical ${suffix} retains the same event-reading context`,
          response.status === 200 && body.includes(honorsDescription) &&
            !body.includes(WORKSHOP_CANARY) && !body.includes(SCRATCH_CANARY));
      }
      const followClaimPublication = async (kind, id, claimPin, work, fellow, sponsor) => {
        const previous = page.url();
        const segment = kind === "evidence" ? "evidence" : "reviews";
        const href = `/r/p/${problemId}/${segment}/${id}`;
        const itemKind = kind === "evidence" ? "claim-evidence" : "claim-review";
        const publicationBody = page.locator(
          `.asimp-item[data-id="${id}"][data-kind="${itemKind}"] .asimp-item__body`,
        );
        const timeline = page.locator(`.timeline-list a[href="${href}"]`);
        const card = page.getByRole("link", {
          name: `Read complete published ${kind} ${id} →`,
          exact: true,
        });
        record(
          `${mode} claim ${kind}: timeline and card expose the exact registered publication`,
          (await timeline.count()) === 1 &&
            (await card.count()) === 1 &&
            (await card.getAttribute("href")) === href,
        );
        await timeline.click();
        await page.waitForURL(`${agora.origin}${href}`, { waitUntil: "load" });
        await page
          .getByRole("heading", { name: id, level: 1, exact: true })
          .waitFor({ state: "visible" });
        const timelineBody = await page.locator("main").innerText();
        const timelineCount = await publicationBody.count();
        const timelineRecord = timelineCount === 1 ? await publicationBody.innerText() : "";
        record(
          `${mode} claim ${kind}: timeline opens the complete work, claim pin and publication attribution`,
          timelineCount === 1 &&
            timelineRecord.includes(work) &&
            timelineRecord.includes(claimPin) &&
            timelineRecord.includes(fellow) &&
            timelineRecord.includes(sponsor),
        );
        const timelineInert =
          !timelineBody.includes(WORKSHOP_CANARY) &&
          !timelineBody.includes(SCRATCH_CANARY) &&
          (await page.locator("img[onerror], a[href^='javascript:']").count()) === 0;
        await page.goto(previous, { waitUntil: "load" });
        await card.click();
        await page.waitForURL(`${agora.origin}${href}`, { waitUntil: "load" });
        await page
          .getByRole("heading", { name: id, level: 1, exact: true })
          .waitFor({ state: "visible" });
        const cardBody = await page.locator("main").innerText();
        const cardCount = await publicationBody.count();
        const cardRecord = cardCount === 1 ? await publicationBody.innerText() : "";
        record(
          `${mode} claim ${kind}: record card opens the same complete published work`,
          cardCount === 1 && cardRecord.includes(work) && cardRecord.includes(claimPin) &&
            cardRecord.includes(fellow) && cardRecord.includes(sponsor),
        );
        record(
          `${mode} claim ${kind}: both source entry points preserve private-workshop and markup boundaries`,
          timelineInert &&
            !cardBody.includes(WORKSHOP_CANARY) &&
            !cardBody.includes(SCRATCH_CANARY) &&
            (await page.locator("img[onerror], a[href^='javascript:']").count()) === 0,
        );
        await page.goto(previous, { waitUntil: "load" });
      };
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
        if (path === `/p/${problemId}`) {
          await publicLedgerDownload({ page, target, problemId, mode });
        }
        if (path === "/a/agora-lane-reviewer") {
          const exactHref = `/r/p/${problemId}/reviews/${reviewId}`;
          const source = page.getByRole("link", { name: `Read review ${reviewId}`, exact: true });
          record(
            `${mode} Fellow review links the exact published human record`,
            (await source.count()) === 1 && (await source.getAttribute("href")) === exactHref,
          );
          await source.click();
          await page.waitForURL(`${agora.origin}${exactHref}`, { waitUntil: "load" });
          const reviewBody = await page.locator("main").innerText();
          record(
            `${mode} review click-through displays the full work product and publication pin`,
            reviewBody.includes("Search log.") &&
              reviewBody.includes(`${noveltyId}@1`) &&
              reviewBody.includes("usr_agora_lane_reviewer"),
          );
          record(
            `${mode} exact review click-through contains no private draft or executable injection`,
            !reviewBody.includes(WORKSHOP_CANARY) &&
              !reviewBody.includes(SCRATCH_CANARY) &&
              (await page.locator("img[onerror], a[href^='javascript:']").count()) === 0,
          );
        }
        if (path === "/a/agora-lane-author") {
          const history = page.locator(".asimp-negative-history");
          record(
            `${mode} Fellow card shows the published negative work with its retry condition`,
            (await history
              .getByRole("heading", { name: "Negative Work History", exact: true })
              .count()) === 1 &&
              (await history.textContent()).includes(
                "The finite parity interval does not establish",
              ) &&
              (await history.textContent()).includes("Retry after an exact finite reduction"),
          );
          record(
            `${mode} negative work links its public problem history`,
            (await history
              .locator(`a[href='/p/${problemId}/dead-ends']`)
              .filter({ hasText: deadEndId })
              .count()) === 1,
          );
          record(
            `${mode} negative work retains publication attribution without a volume score`,
            (await history.textContent()).includes(SPONSOR) &&
              (await history.textContent()).includes(sessionId) &&
              (await history.textContent()).toLowerCase().includes("self-declared") &&
              !html.includes("dead_ends_recorded") &&
              !html.includes("Checked Dead Ends"),
          );
          const previousViewport = page.viewportSize();
          await page.setViewportSize({ width: 390, height: 844 });
          const dimensions = await page.evaluate(() => ({
            viewport: window.innerWidth,
            document: document.documentElement.scrollWidth,
            history: [...document.querySelectorAll(".asimp-negative-history pre")].map(
              (element) => ({
                client: element.clientWidth,
                scroll: element.scrollWidth,
              }),
            ),
          }));
          record(
            `${mode} negative work stays readable inside a 390px viewport`,
            dimensions.document <= dimensions.viewport &&
              dimensions.history.length > 0 &&
              dimensions.history.every((element) => element.scroll <= element.client),
            dimensions,
          );
          await page.setViewportSize(previousViewport);
        }
        if (path === "/explore" || path === "/area/number-theory") {
          record(
            `${mode} ${path} renders a public scientific review need`,
            (await page.getByText("review-ready", { exact: true }).count()) > 0,
          );
          if (path === "/area/number-theory") {
            record(
              `${mode} ${path} links the published problem needing review`,
              (await page.locator(`a[href='/p/${problemId}']`).count()) > 0,
            );
          }
        }
        if (path === `/p/${problemId}` || path === `/p/${problemId}/claims/${claimId}`) {
          record(
            `${mode} ${path} renders the published mathematics through KaTeX and MathML`,
            (await page.locator(".scientific-markdown .katex").count()) > 0 &&
              (await page.locator(".scientific-markdown math mfrac").count()) > 0,
          );
          record(
            `${mode} ${path} renders the published GFM table`,
            (await page.locator(".scientific-markdown table").count()) > 0,
          );
          record(
            `${mode} ${path} preserves malformed TeX as readable source`,
            (await page.locator('.asimp-math-fallback[data-math-rendered="false"]').count()) > 0,
          );
          const math = page.locator(".scientific-markdown .katex").first();
          const mathFont = await math.evaluate((element) => getComputedStyle(element).fontFamily);
          record(
            `${mode} ${path} loads the local math stylesheet`,
            mathFont.includes("KaTeX_Main"),
          );
          const source = page
            .locator(".scientific-markdown")
            .filter({ has: page.locator("math mfrac") })
            .first()
            .locator(".asimp-source");
          const clickStarted = performance.now();
          const navigations = [];
          const onNavigation = (frame) => {
            if (frame === page.mainFrame() && navigations.length < 8) {
              navigations.push({
                elapsed_ms: performance.now() - clickStarted,
                path: new URL(frame.url()).pathname,
              });
            }
          };
          page.on("framenavigated", onNavigation);
          try {
            await source.locator("summary").click();
          } catch (error) {
            // Retain geometry and load state when native disclosure controls
            // fail actionability. Never include authored text or credentials.
            const state = await nativeClickFailureState(
              page,
              ".scientific-markdown .asimp-source summary",
            );
            console.error(
              JSON.stringify({
                stage: "math-source-click-failed",
                mode,
                path,
                elapsed_ms: performance.now() - clickStarted,
                navigations,
                state,
              }),
            );
            throw error;
          } finally {
            page.off("framenavigated", onNavigation);
          }
          record(
            `${mode} ${path} offers copyable LaTeX without requiring page scripts`,
            (await source.locator("pre").isVisible()) &&
              (await source.locator("code").textContent()).includes(String.raw`\frac{n(n+1)}{2}`),
          );
        }
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
      record(
        `${mode} a multiple-sponsor roster does not show a single-team problem notice`,
        (await page.locator(".single-team-banner").count()) === 0,
      );
      await page.goto(`${agora.origin}/p/${singleTeamProblemId}`, { waitUntil: "load" });
      const currentRosterNotice = await page.locator(".single-team-banner").innerText();
      const shareRosterNotice = await page.locator(".single-team-alert-banner").innerText();
      record(
        `${mode} actual problem page consumes the canonical current-roster notice`,
        currentRosterNotice.includes(SINGLE_TEAM_PROBLEM_NOTICE),
      );
      record(
        `${mode} actual share panel consumes the same current-roster notice`,
        shareRosterNotice.includes(SINGLE_TEAM_PROBLEM_NOTICE),
      );
      record(
        `${mode} a current single team cannot erase historical review independence`,
        !`${currentRosterNotice} ${shareRosterNotice}`.includes(
          "nothing has been independently reviewed",
        ) && (await page.textContent("body"))?.includes("statement-clear"),
      );
      await changeNoticeRoster("set-role");
      await page.reload({ waitUntil: "load" });
      record(
        `${mode} a warmed same-URL page refresh removes both notices after another sponsor rejoins`,
        (await page.locator(".single-team-banner").count()) === 0 &&
          (await page.locator(".single-team-alert-banner").count()) === 0 &&
          (await page.textContent("body"))?.includes("statement-clear"),
      );
      await changeNoticeRoster("remove");
      await page.goto(`${agora.origin}/p/${problemId}/claims/${claimId}`, { waitUntil: "load" });
      const claimText = await page.textContent("body");
      record(
        `${mode} claim page shows the untrusted statement as text`,
        claimText?.includes("Squares keep parity") ?? false,
        claimText?.includes("Squares keep parity")
          ? null
          : (claimText ?? "").replace(/\s+/g, " ").slice(0, 600),
      );
      const tierCounts = await page
        .locator(".tier-card .tier-card-footer strong")
        .allTextContents();
      record(
        `${mode} review tiers match the Worker's pinned T0 rather than upgrading it to T1`,
        claimProbeBody.items.some(
          (item) => item.kind === "claim-review" && JSON.parse(item.body).tier === "T0",
        ) && JSON.stringify(tierCounts) === JSON.stringify(["1", "0", "0", "0"]),
      );
      const tiersText = await page.locator(".tier-explainer-section").innerText();
      record(
        `${mode} independence copy distinguishes sponsorship, self-declaration and disjoint method`,
        tiersText.includes("Same-sponsor review") &&
          tiersText.includes("Cross-sponsor review") &&
          tiersText.includes("self-declared model families") &&
          tiersText.includes("Disjoint-method review") &&
          tiersText.includes("does not run proof checkers") &&
          tiersText.includes("Later transfers do not upgrade earlier reviews") &&
          !tiersText.includes("Formal Machine Proof") &&
          !tiersText.includes("cryptographically verified"),
      );
      record(
        `${mode} different Fellows with one recorded sponsor retain single-team caution`,
        tiersText.includes("All displayed contributions have the same recorded sponsor") &&
          (await page
            .locator(`[data-disposition="${claimProbeBody.claim_state.disposition}"]`)
            .count()) > 0,
        {
          singleTeam: tiersText.includes(
            "All displayed contributions have the same recorded sponsor",
          ),
          disposition: claimProbeBody.claim_state.disposition,
          unchallenged: claimProbeBody.claim_state.unchallenged,
        },
      );
      const publicationBasis = claimProbeBody.claim_state.status_basis;
      const unverifiedText = await page.locator("#what-remains-unverified").innerText();
      record(
        `${mode} unverified gaps describe bounded coverage and qualifying support without invented global absence`,
        unverifiedText.includes("No displayed cross-family (T2/T3) review") &&
          unverifiedText.includes("bounded face") &&
          unverifiedText.includes("qualifying refutation attempts") &&
          unverifiedText.includes("does not execute proof checkers") &&
          !unverifiedText.includes("All reviews stem") &&
          !unverifiedText.includes("cryptographically validated") &&
          !unverifiedText.includes("No independently compiled"),
      );
      const publicationLink = await page
        .locator("#why-this-status")
        .getByRole("link", { name: /Recorded status step/ })
        .getAttribute("href");
      record(
        `${mode} ordinary claim links its canonical publication cause rather than its T0 review`,
        publicationBasis?.kind === "transition" &&
          publicationBasis.cause === "claim-created" &&
          publicationLink ===
            `/p/${problemId}/events?since=${publicationBasis.seq - 1}&through=${publicationBasis.seq}&limit=1`,
      );
      await followClaimPublication(
        "review",
        claimReviewId,
        `${claimId}@1`,
        "This review is by another Fellow of the author’s sponsor, not independent sponsorship.",
        claimReviewFellowId,
        SPONSOR,
      );
      await page.goto(`${agora.origin}/p/${problemId}/claims/${concessionClaimId}`, {
        waitUntil: "load",
      });
      await followClaimPublication(
        "evidence",
        concessionEvidenceId,
        `${concessionClaimId}@1`,
        "At n = 2 the square is 4, an even integer. The universal oddness assertion fails.",
        concessionEvidenceFellowId,
        "usr_agora_lane_concession",
      );
      const why = page.locator("#why-this-status");
      const whyText = await why.innerText();
      record(
        `${mode} conceded false claim explains author concession without inventing independent verification`,
        whyText.includes("author conceded") &&
          whyText.includes("Canonical standing: refuted") &&
          !whyText.includes("survived adversarial review") &&
          !whyText.includes("verified on the public ledger"),
      );
      const step = why.getByRole("link", { name: /Recorded status step/ });
      record(
        `${mode} concession link names the exact canonical event window`,
        (await step.getAttribute("href")) ===
          `/p/${problemId}/events?since=${concessionBasis.seq - 1}&through=${concessionBasis.seq}&limit=1`,
      );
      await step.click();
      await page.waitForURL(
        `${agora.origin}/p/${problemId}/events?since=${concessionBasis.seq - 1}&through=${concessionBasis.seq}&limit=1`,
      );
      await page.getByText(concessionBasis.event_id, { exact: true }).waitFor();
      record(
        `${mode} concession click-through resolves the real public event and retraction`,
        (await page.locator("main").innerText()).includes(concessionBasis.event_id),
      );
      await proofGapBrowsing({ page, agora, problemId, claimId, gapIds, gapCursor, mode });
      await hypothesisLifecycleBrowsing({
        page,
        agora,
        target,
        problemId,
        fixture: hypothesisLifecycle,
        mode,
        record,
      });
      await claimsListBrowsing({ page, agora, target, fixture: claimsList, mode, record });
      await scientificCollectionsBrowsing({
        page,
        agora,
        target,
        fixture: scientificCollections,
        mode,
        record,
      });
      await synthesisBrowsing({ page, agora, target, fixture: syntheses, mode, record });
      await citationsBrowsing({ page, agora, target, fixture: citations, mode, record });
      await context.close();
    }
    await scientificCollectionsWithdrawal({
      target,
      browser,
      agora,
      fixture: scientificCollections,
      record,
      diagnose: nativeClickFailureState,
    });
    await citationsWithdrawal({ target, browser, agora, fixture: citations, record });
    await claimsListWithdrawal({ target, browser, agora, fixture: claimsList, record });
    await hypothesisPublicationWithdrawal({
      target,
      browser,
      agora,
      problemId,
      fixture: hypothesisLifecycle,
      record,
    });
    await proofGapWithdrawal({
      target,
      browser,
      agora,
      problemId,
      sessionId,
      authorToken,
      gapIds,
      gapCursor,
    });

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
      const context = await browser.newContext();
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
      const context = await browser.newContext();
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
      const signedIn = await browser.newContext();
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
      const grant = await target.env.DB.prepare(
        "SELECT granted_resources_json FROM enrollment_grants WHERE fellow_id = ?",
      )
        .bind(fellowId)
        .first();
      const resources = JSON.parse(grant.granted_resources_json);
      record(
        "sponsor: the discovered Fellow has no mint-time problem assignment",
        resources.problemBinding === undefined && resources.problem_binding === undefined,
      );
      const directoryConsoleResponse = await sponsorPage.goto(`${agora.origin}/console`, {
        waitUntil: "load",
      });
      const discoveredWorkshop = sponsorPage
        .getByRole("list", { name: "Your private workshops", exact: true })
        .getByRole("link", { name: `Browse agora-lane-author on ${problemId}`, exact: true });
      await discoveredWorkshop.waitFor({ state: "visible", timeout: 20_000 });
      record(
        "sponsor: console discovers an unbound Fellow's actual private workshop",
        (await discoveredWorkshop.getAttribute("href")) === workshopPath,
      );
      record(
        "sponsor: unbound workshop preview is visible only in the private console",
        (await sponsorPage.textContent(".workshop-view"))?.includes(SCRATCH_CANARY) === true,
      );
      record(
        "sponsor: directory-bearing console is not publicly cacheable",
        privateToCaches(directoryConsoleResponse?.headers() ?? {}),
      );
      const workshopNavigation = sponsorPage.waitForResponse(
        (response) => new URL(response.url()).pathname === workshopPath,
      );
      await discoveredWorkshop.click();
      const workshop = await workshopNavigation;
      await sponsorPage.waitForURL(`${agora.origin}${workshopPath}`);
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

      // The sponsor acts on stored science, never on private scratch prose.
      const lowBarCard = sponsorPage.locator(".workshop-card").filter({ hasText: LIVE_CANARY });
      const beforeRefusal = await target.env.DB.prepare(
        "SELECT public_seq FROM problems WHERE id = ?",
      )
        .bind(problemId)
        .first();
      await lowBarCard.getByRole("checkbox").check();
      await lowBarCard.getByRole("button", { name: "Promote to Ledger", exact: true }).click();
      await lowBarCard.getByRole("alert").waitFor({ state: "visible", timeout: 20_000 });
      const refusalText = await lowBarCard.getByRole("alert").innerText();
      const afterRefusal = await target.env.DB.prepare(
        "SELECT public_seq FROM problems WHERE id = ?",
      )
        .bind(problemId)
        .first();
      record(
        "workshop: low-bar promotion shows the real repair instructions without a public write",
        refusalText.includes("PROMOTE_BODY_INVALID") &&
          refusalText.includes("Ask the Fellow") &&
          beforeRefusal.public_seq === afterRefusal.public_seq,
      );

      const STORED_STATEMENT = "For an integer k, (8k + 3)^2 leaves remainder 9 modulo 16.";
      const PRIVATE_PUBLICATION_NOTES = "PRIVATE-SPONSOR-PUBLICATION-NOTES-2T8";
      const publication = {
        kind: "conjecture",
        statement: STORED_STATEMENT,
        falsifier: "An integer k for which (8k + 3)^2 modulo 16 differs from 9.",
        scientific_provenance: {
          model_family_self_declared: "local-browser-author",
          method: {
            category: "deductive",
            procedure: "Expand the square and reduce each term modulo 16.",
            evidence: [],
          },
        },
      };
      const publishable = await fellowPost(
        target,
        `/v1/sessions/${sessionId}/workshop`,
        {
          type: "claim-draft",
          title: "Sponsor publication test",
          body_md: PRIVATE_PUBLICATION_NOTES,
          publication,
        },
        authorToken,
      );
      assert.equal(publishable.status, 201, `publication draft ${publishable.body.code ?? ""}`);
      const workshopId = publishable.body.workshop_id;
      const publishCard = sponsorPage.locator(".workshop-card").filter({ hasText: workshopId });
      await publishCard.waitFor({ state: "visible", timeout: 20_000 });
      const shownPublication = await publishCard.locator(".workshop-publication").innerText();
      record(
        "workshop: the sponsor can review the stored statement, falsifier and method before publication",
        shownPublication.includes(STORED_STATEMENT) &&
          shownPublication.includes(publication.falsifier) &&
          shownPublication.includes(publication.scientific_provenance.method.procedure),
      );
      const head = () =>
        target.env.DB.prepare(
          "SELECT current_version, state FROM workshop_objects WHERE workshop_id = ?",
        )
          .bind(workshopId)
          .first();
      await publishCard.getByRole("button", { name: "Keep Draft", exact: true }).click();
      await publishCard
        .locator(".workshop-version")
        .filter({ hasText: /^v2$/ })
        .waitFor({ state: "visible", timeout: 20_000 });
      const kept = await head();
      record(
        "workshop: Keep creates a real private revision",
        kept.current_version === 2 && kept.state === "open",
      );
      await publishCard.getByRole("button", { name: "Discard (Soft-hide)", exact: true }).click();
      await publishCard
        .getByRole("button", { name: "Keep / Reopen Draft", exact: true })
        .waitFor({ state: "visible", timeout: 20_000 });
      const discarded = await head();
      record(
        "workshop: Discard soft-hides the draft while retaining a recoverable revision",
        discarded.current_version === 3 &&
          discarded.state === "discarded" &&
          !(await publishCard.locator(".workshop-body").isVisible()),
      );
      await publishCard.getByRole("button", { name: "Keep / Reopen Draft", exact: true }).click();
      await publishCard
        .locator(".workshop-version")
        .filter({ hasText: /^v4$/ })
        .waitFor({ state: "visible", timeout: 20_000 });
      const reopened = await head();
      record(
        "workshop: Keep reopens the same stored draft",
        reopened.current_version === 4 &&
          reopened.state === "open" &&
          (await publishCard.locator(".workshop-publication").isVisible()),
      );
      await publishCard.getByRole("checkbox").check();
      await publishCard.getByRole("button", { name: "Promote to Ledger", exact: true }).click();
      await publishCard
        .getByRole("status")
        .filter({ hasText: "was promoted as" })
        .waitFor({ state: "visible", timeout: 20_000 })
        .catch(async () => {
          const notice = await publishCard
            .getByRole("alert")
            .innerText()
            .catch(() => "No receipt or refusal appeared.");
          const attempts = target.observations
            .filter((entry) => entry.path === "/v1/sponsors/workshop/action")
            .slice(-2);
          throw new Error(
            `Sponsor publication did not return a receipt: ${JSON.stringify({ notice, attempts })}`,
          );
        });
      const promotedHref = await publishCard
        .getByRole("link", { name: /^C-\d+$/ })
        .getAttribute("href");
      const sponsorClaimId = promotedHref?.split("/").at(-1);
      assert.match(sponsorClaimId ?? "", /^C-\d+$/);
      const readPublicationEvent = () =>
        target.env.DB.prepare(
          `SELECT e.actor_fellow_id, e.actor_sponsor_id, e.actor_session_id, c.payload_json
         FROM events e JOIN event_content c ON c.event_id = e.id
         WHERE e.problem_id = ? AND e.object_id = ? AND e.type = 'claim.created'`,
        )
          .bind(problemId, sponsorClaimId)
          .all();
      const promotedEvents = (await readPublicationEvent()).results;
      const payload = JSON.parse(promotedEvents[0].payload_json);
      record(
        "workshop: sponsor publication keeps the original Fellow/session and records the acting sponsor",
        promotedEvents.length === 1 &&
          promotedEvents[0].actor_fellow_id === fellowId &&
          promotedEvents[0].actor_sponsor_id === SPONSOR &&
          promotedEvents[0].actor_session_id === sessionId &&
          payload.statement === STORED_STATEMENT &&
          payload.sponsor_promotion?.acting_sponsor_id === SPONSOR &&
          payload.sponsor_promotion?.workshop_version === 4,
      );
      // Archival is durable across a browser reload; the page does not offer to
      // publish the same completed draft again. Exact retry law is exercised by
      // the real-bindings sponsor lane and the server-action retry test.
      await sponsorPage.reload({ waitUntil: "load" });
      await publishCard
        .getByRole("button", { name: "Keep / Reopen Draft", exact: true })
        .waitFor({ state: "visible", timeout: 20_000 });
      const publishedHead = await head();
      record(
        "workshop: reloading preserves the archived completed draft without another public event",
        (await readPublicationEvent()).results.length === 1 &&
          publishedHead.state === "archived" &&
          publishedHead.current_version === 5 &&
          (await publishCard
            .getByRole("button", { name: "Promote to Ledger", exact: true })
            .count()) === 0,
      );
      await sponsorPage.goto(`${agora.origin}${promotedHref}`, { waitUntil: "load" });
      const publicClaim = await sponsorPage.textContent("main");
      record(
        "workshop: the published claim is readable on Agora without private working notes",
        publicClaim?.includes(STORED_STATEMENT) && !publicClaim.includes(PRIVATE_PUBLICATION_NOTES),
      );

      const publishTypedWorkshop = async (kind, type, publicPayload, previewFields, assessment) => {
        const privateCanary = `PRIVATE-TYPED-${kind.toUpperCase()}-DRAFT-9K2`;
        const draft = await fellowPost(
          target,
          `/v1/sessions/${sessionId}/workshop`,
          {
            type,
            title: `Sponsor ${kind} publication`,
            body_md: privateCanary,
            ledger_intent: { kind: "create", target_kind: kind },
            publication: { object_kind: kind, payload: publicPayload },
          },
          authorToken,
        );
        assert.equal(draft.status, 201, `${kind} workshop ${draft.body.code ?? ""}`);
        await sponsorPage.goto(`${agora.origin}${workshopPath}`, { waitUntil: "load" });
        const card = sponsorPage
          .locator(".workshop-card")
          .filter({ hasText: draft.body.workshop_id });
        await card.waitFor({ state: "visible", timeout: 20_000 });
        const preview = await card.locator(".workshop-publication").innerText();
        record(
          `workshop: the sponsor inspects the exact stored ${kind} before publication`,
          previewFields.every((value) => preview.includes(value)) &&
            !preview.includes(privateCanary) &&
            (await card.locator(".workshop-body").innerText()).includes(privateCanary),
        );
        await card.getByRole("checkbox").check();
        await card.getByRole("button", { name: "Promote to Ledger", exact: true }).click();
        await card
          .getByRole("status")
          .filter({ hasText: "was promoted as" })
          .waitFor({ state: "visible", timeout: 20_000 })
          .catch(async () => {
            const notice = await card
              .getByRole("alert")
              .innerText()
              .catch(() => "No typed publication receipt or refusal appeared.");
            throw new Error(`${kind} publication did not complete: ${notice}`);
          });
        const link = card.getByRole("link", {
          name: new RegExp(`^${kind === "hypothesis" ? "H" : "E"}-[0-9A-HJKMNP-TV-Z]+$`),
        });
        const objectId = await link.innerText();
        const href = await link.getAttribute("href");
        assert.ok(href, `${kind} receipt must link its public record`);
        const rows = (
          await target.env.DB.prepare(
            `SELECT e.seq, e.actor_fellow_id, e.actor_sponsor_id, e.actor_session_id, c.payload_json
             FROM events e JOIN event_content c ON c.event_id = e.id
             WHERE e.problem_id = ? AND e.object_id = ? AND e.type = ?`,
          )
            .bind(problemId, objectId, `${kind}.created`)
            .all()
        ).results;
        assert.equal(rows.length, 1, `${kind} action creates one ledger record`);
        const event = rows[0];
        const publicRecord = JSON.parse(event.payload_json);
        record(
          `workshop: ${kind} publication preserves Fellow attribution and excludes private draft data`,
          event.actor_fellow_id === fellowId &&
            event.actor_sponsor_id === SPONSOR &&
            event.actor_session_id === sessionId &&
            publicRecord.body_md === publicPayload.body_md &&
            publicRecord.sponsor_promotion?.acting_sponsor_id === SPONSOR &&
            publicRecord.sponsor_promotion?.workshop_version === 1 &&
            !event.payload_json.includes(privateCanary) &&
            !event.payload_json.includes(draft.body.workshop_id),
        );
        const archived = await target.env.DB.prepare(
          "SELECT current_version,state FROM workshop_objects WHERE workshop_id=?",
        )
          .bind(draft.body.workshop_id)
          .first();
        record(
          `workshop: successful ${kind} publication archives the exact selected revision`,
          archived.current_version === 2 && archived.state === "archived",
        );
        if (kind === "hypothesis") {
          await link.click();
          await sponsorPage.waitForURL(href, { timeout: 20_000 });
          const publicFace = (await sponsorPage.textContent("body")) ?? "";
          record(
            "workshop: the hypothesis receipt opens its actual canonical public HTML record",
            href === `${target.origin}/p/${problemId}/hypotheses/${objectId}.html` &&
              publicFace.includes(publicPayload.route) &&
              publicFace.includes(publicPayload.falsifier) &&
              publicFace.includes(publicPayload.body_md) &&
              !publicFace.includes(privateCanary),
          );
        } else {
          const receipt = await card.getByRole("status").innerText();
          assert.ok(assessment, "Evidence verification needs its declared expected class and flag");
          record(
            "workshop: evidence receipt discloses the real computed class and exploratory limit",
            publicRecord.computed_class === assessment.class &&
              publicRecord.mode === "exploratory" &&
              publicRecord.coercion_flags.includes(assessment.flag) &&
              receipt.includes(`Computed evidence class: ${assessment.class}`) &&
              receipt.includes("cannot drive claim promotion") &&
              receipt.includes(assessment.flag),
          );
          const publicResponse = await sponsorPage.request.get(new URL(href, agora.origin).href);
          const publicFace = await publicResponse.text();
          record(
            "workshop: evidence on a hypothesis links to its complete canonical public evidence record",
            href === `/r/p/${problemId}/evidence/${objectId}` &&
              publicResponse.status() === 200 &&
              publicFace.includes(objectId) &&
              publicFace.includes(publicPayload.bears_on_id) &&
              publicFace.includes(publicPayload.body_md) &&
              !publicFace.includes(privateCanary) &&
              !publicFace.includes(draft.body.workshop_id),
          );
        }
        return objectId;
      };
      const hypothesisPayload = {
        route: "Induction on the length of a finite integer path.",
        mechanism: "Remove the last step and compare parity with the shorter path.",
        falsifier: "A last step changes the claimed parity invariant.",
        expected_evidence: "An explicit recurrence with checked boundary cases.",
        discriminating_predictions: ["The invariant survives every endpoint removal."],
        origin: "proposed",
        body_md: "PUBLIC-TYPED-HYPOTHESIS-9K2: this is a proposed route, not a proven statement.",
      };
      const sponsorHypothesisId = await publishTypedWorkshop(
        "hypothesis",
        "scratch",
        hypothesisPayload,
        [
          hypothesisPayload.route,
          hypothesisPayload.mechanism,
          hypothesisPayload.falsifier,
          hypothesisPayload.expected_evidence,
          hypothesisPayload.discriminating_predictions[0],
          hypothesisPayload.body_md,
        ],
      );
      const evidencePayload = {
        bears_on_kind: "hypothesis",
        bears_on_id: sponsorHypothesisId,
        direction: "informs",
        kind: "computation",
        source: { kind: "model_memory" },
        mode: "exploratory",
        body_md: "PUBLIC-TYPED-EVIDENCE-9K2: observed examples suggest the route warrants a check.",
      };
      await publishTypedWorkshop(
        "evidence",
        "evidence-draft",
        evidencePayload,
        [sponsorHypothesisId, "exploratory", "Model memory", evidencePayload.body_md],
        { class: "assertion", flag: "p8_model_memory_caps_at_assertion" },
      );
      const locatedEvidence = {
        ...evidencePayload,
        source: {
          kind: "locator",
          locator: "https://example.org/parity-observations",
          excerpt: "Finite observations without a declared computation domain.",
        },
        body_md: "PUBLIC-LOCATED-EVIDENCE-9K2: these observations have no stated detection floor.",
      };
      await publishTypedWorkshop(
        "evidence",
        "evidence-draft",
        locatedEvidence,
        [
          sponsorHypothesisId,
          "exploratory",
          "Located source",
          locatedEvidence.source.locator,
          locatedEvidence.source.excerpt,
          locatedEvidence.body_md,
        ],
        { class: "heuristic", flag: "p5_no_detection_floor_coerced_to_heuristic" },
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
      const sponsorInboxPath = `/console/inbox/${encodeURIComponent(fellowId)}`;
      record(
        "sponsor inbox: the console links to the Fellow's private notices",
        (await sponsorPage.locator(`a[href="${sponsorInboxPath}"]`).count()) === 1,
      );
      const noticeBeforeRead = await target.env.DB.prepare(
        "SELECT acknowledged_at FROM fellow_inbox_notices WHERE id = ?",
      )
        .bind(delivered[0]?.id ?? "missing-directive")
        .first();
      const inboxResponse = await sponsorPage.goto(`${agora.origin}${sponsorInboxPath}`, {
        waitUntil: "load",
      });
      await sponsorPage.waitForFunction(
        (text) => document.querySelector("main")?.textContent?.includes(text),
        DIRECTIVE_TEXT,
        { timeout: 20_000 },
      );
      record(
        "sponsor inbox: the actual private page reads the UI-issued directive",
        inboxResponse?.status() === 200 &&
          (await sponsorPage.locator("main").textContent()).includes(DIRECTIVE_TEXT),
      );
      record(
        "sponsor inbox: the rendered private page is not publicly cacheable",
        privateToCaches(inboxResponse?.headers() ?? {}),
      );
      const noticeAfterRead = await target.env.DB.prepare(
        "SELECT acknowledged_at FROM fellow_inbox_notices WHERE id = ?",
      )
        .bind(delivered[0]?.id ?? "missing-directive")
        .first();
      record(
        "sponsor inbox: reading does not acknowledge the Fellow's directive",
        noticeBeforeRead?.acknowledged_at === null && noticeAfterRead?.acknowledged_at === null,
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
      await sponsorPage.goto(`${agora.origin}${sponsorInboxPath}`, { waitUntil: "load" });
      const directiveNotice = sponsorPage
        .locator(".workshop-card")
        .filter({ hasText: DIRECTIVE_TEXT });
      await directiveNotice.getByText("Acknowledged by the Fellow:", { exact: false }).waitFor();
      record(
        "sponsor inbox: a fresh page reflects the actual Fellow acknowledgment",
        (await directiveNotice.count()) === 1,
      );
      await sponsorPage
        .getByRole("link", { name: "Unacknowledged by Fellow", exact: true })
        .click();
      await sponsorPage.waitForURL((url) => url.searchParams.get("unacknowledged_only") === "true");
      await sponsorPage
        .getByRole("heading", { name: "agora-lane-author’s notices", exact: true })
        .waitFor();
      record(
        "sponsor inbox: the live unacknowledged filter omits the acknowledged directive",
        !(await sponsorPage.locator("main").textContent()).includes(DIRECTIVE_TEXT),
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
      await commentaryJourney({ target, agora, sponsorPage, signedIn, encode, problemId, claimId });
      await signedIn.close();

      // Same URL, after the sponsor's request, with no session: nothing private.
      const anonymous = await browser.newContext();
      const anonymousPage = await anonymous.newPage();
      await anonymousPage.goto(`${agora.origin}${workshopPath}`, { waitUntil: "load" });
      const anonymousHtml = await anonymousPage.content();
      record(
        "anonymous: the same workshop URL asks for sign-in and shows no private bytes",
        /sign in required/i.test(anonymousHtml) &&
          !anonymousHtml.includes(SCRATCH_CANARY) &&
          !anonymousHtml.includes(WORKSHOP_CANARY),
      );
      const anonymousInboxResponse = await anonymousPage.goto(
        `${agora.origin}${sponsorInboxPath}`,
        { waitUntil: "load" },
      );
      await anonymousPage
        .getByRole("heading", { name: "Sign in to read your Fellow’s notices" })
        .waitFor();
      record(
        "sponsor inbox: an anonymous visit has no private notice bytes",
        anonymousInboxResponse?.status() === 200 &&
          !(await anonymousPage.content()).includes(DIRECTIVE_TEXT),
      );
      record(
        "sponsor inbox: the anonymous response is not publicly cacheable",
        privateToCaches(anonymousInboxResponse?.headers() ?? {}),
      );
      await anonymousPage.goto(`${agora.origin}/console/commentary/${problemId}`, {
        waitUntil: "load",
      });
      await anonymousPage
        .getByRole("button", { name: "Sign in with Google", exact: true })
        .waitFor();
      record(
        "commentary: anonymous visitors reach sign-in without a writable form",
        (await anonymousPage
          .getByRole("button", { name: "Sign in with Google", exact: true })
          .count()) === 1 && (await anonymousPage.locator("textarea").count()) === 0,
      );
      await anonymous.close();

      // A cookie signed with another secret is not a session.
      const forged = await browser.newContext();
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

      const foreignSponsor = await browser.newContext();
      try {
        await foreignSponsor.addCookies([
          {
            name: SESSION_COOKIE,
            value: await encode({
              token: { sub: "usr_agora_lane_reviewer", authTime: Math.floor(Date.now() / 1000) },
              secret: AUTH_SECRET,
              salt: SESSION_COOKIE,
            }),
            url: agora.origin,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
        const foreignPage = await foreignSponsor.newPage();
        const foreignResponse = await foreignPage.goto(`${agora.origin}${sponsorInboxPath}`, {
          waitUntil: "load",
        });
        await foreignPage
          .getByRole("heading", { name: "Fellow inbox unavailable", exact: true })
          .waitFor();
        record(
          "sponsor inbox: an authenticated foreign sponsor receives no private notice bytes",
          foreignResponse?.status() === 200 &&
            !(await foreignPage.content()).includes(DIRECTIVE_TEXT),
        );
        record(
          "sponsor inbox: the foreign sponsor's refusal is not publicly cacheable",
          privateToCaches(foreignResponse?.headers() ?? {}),
        );
      } finally {
        await foreignSponsor.close();
      }
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
        if (match === null) return null;
        const image = new URL(match[1], agora.origin);
        if (
          (image.origin !== agora.origin && image.origin !== SITE.agora) ||
          image.username !== "" ||
          image.password !== ""
        )
          return null;
        return `${image.pathname}${image.search}`;
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
      const context = await browser.newContext();
      const page = await context.newPage();
      for (const path of [
        "/results",
        `/p/${problemId}`,
        `/p/${problemId}/claims/${claimId}`,
        `/p/${singleTeamProblemId}`,
      ]) {
        const imagePath = await ogImagePath(path);
        record(`og ${path} declares an og:image for Agora`, imagePath !== null, imagePath);
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
      const rosterCard = await ogImagePath(`/p/${singleTeamProblemId}`);
      assert.notEqual(rosterCard, null, "the single-team page has a real image route");
      const rosterImageBefore = await card(rosterCard);
      await changeNoticeRoster("set-role");
      const rosterImageAfter = await card(rosterCard);
      record(
        "og a warmed same-URL image refreshes after the actual roster governance change",
        rosterImageBefore.status === 200 &&
          rosterImageAfter.status === 200 &&
          rosterImageAfter.width === 1200 &&
          rosterImageAfter.height === 630 &&
          !rosterImageBefore.bytes.equals(rosterImageAfter.bytes),
      );
      await changeNoticeRoster("remove");
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
          { status: later.status, code: later.body.code },
        );
      }
      await context.close();
    }

    // W3.8 bilateral transfer through the console: the offering sponsor
    // offers a Fellow, nothing moves until the receiving sponsor (a different
    // Google identity) accepts on its own console, and acceptance revokes the
    // Fellow's credentials (rebinding under the new sponsor is not available yet).
    {
      const { encode } = await import(
        createRequire(`${root}apps/web/package.json`).resolve("next-auth/jwt")
      );
      const signedInAs = async (sub) => {
        const context = await browser.newContext();
        await context.addCookies([
          {
            name: SESSION_COOKIE,
            value: await encode({
              token: { sub, name: "Local sponsor", authTime: Math.floor(Date.now() / 1000) },
              secret: AUTH_SECRET,
              salt: SESSION_COOKIE,
            }),
            url: agora.origin,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
        return context;
      };
      const RECEIVER = "usr_agora_lane_reviewer";
      const bearerStatus = async (token) =>
        (
          await fetch(`${target.origin}/v1/inbox`, {
            headers: { "user-agent": USER_AGENT, authorization: `Bearer ${token}` },
          })
        ).status;
      const offering = await signedInAs(SPONSOR);
      const offerPage = await offering.newPage();
      await offerPage.goto(`${agora.origin}/console`, { waitUntil: "load" });
      const card = offerPage.locator('section[aria-labelledby="transfers-title"]');
      await card.locator("select").selectOption({ label: "agora-lane-transfer" });
      // A refused offer shows the Worker's own reason, not a guessed one: no
      // sponsor holds this id.
      await card.getByLabel("Receiving sponsor id").fill("usr_agora_lane_nobody");
      await card.getByRole("checkbox").check();
      await card.getByRole("button", { name: "Offer Fellow" }).click({ timeout: 20_000 });
      const refusedText = await card
        .getByRole("status")
        .filter({ hasText: "Stoa refused" })
        .textContent({ timeout: 20_000 })
        .catch(async () => `no refusal; card: ${(await card.textContent()) ?? ""}`);
      record(
        "transfer: a refused offer shows the Worker's reason (an unknown sponsor)",
        (refusedText ?? "").includes("Stoa refused: Transfer target sponsor is invalid"),
        (refusedText ?? "").slice(0, 300),
      );
      await card.getByLabel("Receiving sponsor id").fill(RECEIVER);
      await card.getByRole("checkbox").check();
      await card.getByRole("button", { name: "Offer Fellow" }).click({ timeout: 20_000 });
      const offered = await card
        .getByRole("status")
        .filter({ hasText: "is pending" })
        .waitFor({ timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      record("transfer: the offering sponsor's console click creates a pending offer", offered);
      const offerStatus = offered ? ((await card.getByRole("status").textContent()) ?? "") : "";
      const thisYear = new Date().getUTCFullYear();
      record(
        "transfer: the offer's expiry is shown as a real date (epoch milliseconds, not seconds)",
        [thisYear, thisYear + 1].some((year) => offerStatus.includes(`until ${year}-`)),
        offerStatus.slice(0, 160),
      );
      record(
        "transfer: an offer alone moves nothing (the Fellow's credential still works)",
        (await bearerStatus(transferToken)) === 200,
      );
      await offering.close();

      const receiving = await signedInAs(RECEIVER);
      const acceptPage = await receiving.newPage();
      await acceptPage.goto(`${agora.origin}/console`, { waitUntil: "load" });
      const offerRow = acceptPage
        .locator('section[aria-labelledby="transfers-title"] li')
        .filter({ hasText: "agora-lane-transfer" });
      await offerRow.getByRole("button", { name: "Accept transfer" }).click({ timeout: 20_000 });
      let moved = false;
      for (let i = 0; i < 20 && !moved; i++) {
        moved = (await bearerStatus(transferToken)) === 401;
        if (!moved) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      record(
        "transfer: the receiving sponsor's acceptance revokes the Fellow's credentials",
        moved,
      );
      await acceptPage.goto(`${agora.origin}/console`, { waitUntil: "load" });
      const fellowsCard = (
        (await acceptPage.locator('section[aria-labelledby="fellows-title"]').textContent()) ?? ""
      ).replace(/\s+/g, " ");
      record(
        "transfer: the Fellow now appears among the receiving sponsor's Fellows",
        fellowsCard.includes("agora-lane-transfer"),
      );
      record(
        "transfer: the offering sponsor's other Fellow is unaffected",
        (await bearerStatus(authorToken)) === 200,
      );

      // dwml: the receiving sponsor rebinds the Fellow in the browser. It
      // mints a one-time URL, the Fellow's agent claims it with its exact
      // identity, the sponsor approves the claim here, the agent's poll
      // issues the new token, and once resumed the Fellow works again.
      const transfers = acceptPage.locator('section[aria-labelledby="transfers-title"]');
      const rebindRow = transfers
        .locator("li[data-rebind-fellow]")
        .filter({ hasText: "agora-lane-transfer" });
      const movedFellowId = (await rebindRow.getAttribute("data-rebind-fellow")) ?? "";
      await rebindRow.getByRole("button", { name: "Mint rebind URL" }).click({ timeout: 20_000 });
      const rebindUrl =
        (await transfers
          .locator("code[data-rebind-url]")
          .textContent({ timeout: 20_000 })
          .catch(() => "")) ?? "";
      const parsedRebind = /\/rebind\/(ASIMP-RB-[0-9A-Z]{26})#(v1\.[A-Za-z0-9_-]{43})$/.exec(
        rebindUrl,
      );
      record(
        "rebind: the console shows a one-time rebind URL",
        parsedRebind !== null,
        rebindUrl.split("#")[0],
      );
      let rebindToken;
      if (parsedRebind !== null) {
        const claimed = await fellowPost(target, "/v1/fellows/rebind", {
          rebind_id: parsedRebind[1],
          secret: parsedRebind[2],
          name: "agora-lane-transfer",
          model: "local/setup",
          harness: "gauntlet-setup",
        });
        record("rebind: the Fellow's agent claims it", claimed.status === 202, claimed.body.code);
        await acceptPage.goto(`${agora.origin}/console`, { waitUntil: "load" });
        const claimRow = acceptPage.locator(`li[data-rebind="${parsedRebind[1]}"]`);
        record(
          "rebind: the claim shows the declared identity matching the Fellow",
          ((await claimRow.textContent()) ?? "").includes("matching the Fellow"),
        );
        await claimRow.getByRole("button", { name: "Approve rebind" }).click({ timeout: 20_000 });
        for (let i = 0; i < 20 && rebindToken === undefined; i++) {
          const polled = await fellowPost(target, "/v1/fellows/rebind/flow", {
            flow_handle: claimed.body.flow_handle,
          });
          if (polled.body.status === "approved") rebindToken = polled.body.token;
          else await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      record(
        "rebind: the sponsor's approval in the console issues the token",
        rebindToken !== undefined,
      );
      if (rebindToken !== undefined) {
        const resumed = await target.sponsor(
          RECEIVER,
          "POST",
          "/v1/fellows/lifecycle",
          "fellow.lifecycle.change",
          {
            fellow_id: movedFellowId,
            status: "active",
            confirm: "change-fellow-lifecycle",
            step_up_authenticated_at: Math.floor(Date.now() / 1000),
          },
        );
        record(
          "rebind: once resumed, the rebound Fellow's new bearer works",
          resumed.status === 200 && (await bearerStatus(rebindToken)) === 200,
          resumed.status,
        );
        record(
          "rebind: the pre-transfer bearer stays dead",
          (await bearerStatus(transferToken)) === 401,
        );
      }
      // d52t (Rule A4): a read the Worker cannot answer is said, never shown
      // as an empty list. Each table goes offline on the real local D1, the
      // console reloads in the browser, then the table comes back.
      const offline = async (table, check) => {
        await target.env.DB.exec(`ALTER TABLE ${table} RENAME TO ${table}_offline`);
        try {
          await acceptPage.reload({ waitUntil: "load" });
          await check(acceptPage.locator('section[aria-labelledby="transfers-title"]'));
        } finally {
          await target.env.DB.exec(`ALTER TABLE ${table}_offline RENAME TO ${table}`);
        }
      };
      await offline("fellow_rebinds", async (card) => {
        const text = await card.innerText();
        record(
          "transfer: a failed rebinds read says so instead of listing no Fellows",
          text.includes("Your rebinds could not be loaded just now") &&
            !text.includes("No Fellow has been transferred to you"),
          text.slice(0, 400),
        );
      });
      await offline("sponsor_fellow_transfers", async (card) => {
        const text = await card.innerText();
        record(
          "transfer: a failed transfers read says so instead of showing no pending offers",
          text.includes("Your transfers could not be loaded just now") &&
            !text.includes("No pending offers"),
          text.slice(0, 400),
        );
      });
      await acceptPage.reload({ waitUntil: "load" });
      record(
        "transfer: once the tables are back the card lists transfers again",
        (
          await acceptPage.locator('section[aria-labelledby="transfers-title"]').innerText()
        ).includes("agora-lane-transfer"),
      );
      await receiving.close();
    }

    // Sponsor panic from the console (last: it revokes the author's bearer).
    // A real two-step click; afterwards the Worker refuses that Fellow's
    // credential, while another sponsor's Fellow keeps working.
    {
      const { encode } = await import(
        createRequire(`${root}apps/web/package.json`).resolve("next-auth/jwt")
      );
      const context = await browser.newContext();
      await context.addCookies([
        {
          name: SESSION_COOKIE,
          value: await encode({
            token: { sub: SPONSOR, name: "Local sponsor", authTime: Math.floor(Date.now() / 1000) },
            secret: AUTH_SECRET,
            salt: SESSION_COOKIE,
          }),
          url: agora.origin,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const inboxStatus = async (token) =>
        (
          await fetch(`${target.origin}/v1/inbox`, {
            headers: { "user-agent": USER_AGENT, authorization: `Bearer ${token}` },
          })
        ).status;
      record(
        "panic: the Fellow's credential works before the panic",
        (await inboxStatus(authorToken)) === 200,
      );
      const page = await context.newPage();
      await page.goto(`${agora.origin}/console`, { waitUntil: "load" });
      // First an individual revocation of the spare Fellow's credential only.
      const spareRow = page.locator("li", { hasText: "agora-lane-spare" });
      await spareRow.getByRole("button", { name: "Revoke credential" }).click({ timeout: 20_000 });
      await spareRow.getByRole("button", { name: "Confirm revocation" }).click();
      let spareRevoked = false;
      for (let i = 0; i < 20 && !spareRevoked; i++) {
        spareRevoked = (await inboxStatus(spareToken)) === 401;
        if (!spareRevoked) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      record("revoke: a console click revokes exactly that credential", spareRevoked);
      record(
        "revoke: the sponsor's other Fellow keeps working",
        (await inboxStatus(authorToken)) === 200,
      );
      await page.goto(`${agora.origin}/console`, { waitUntil: "load" });
      await page
        .getByRole("button", { name: "Start sponsor panic confirmation" })
        .click({ timeout: 20_000 });
      await page.getByRole("button", { name: "Confirm sponsor panic" }).click();
      let revoked = false;
      for (let i = 0; i < 20 && !revoked; i++) {
        revoked = (await inboxStatus(authorToken)) === 401;
        if (!revoked) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      record("panic: a console click revokes the sponsor's Fellow credential", revoked);
      record(
        "panic: another sponsor's Fellow is unaffected",
        (await inboxStatus(reviewerToken)) === 200,
      );
      await context.close();
    }

    // Accessibility and keyboard, with JavaScript on. Reduced motion, so axe
    // measures final colours rather than the body's 0.5 s fade-in.
    // The moderation journey publishes fresh work in both browser modes. Its
    // own board preserves the normal writer cap without borrowing seats from
    // all the earlier, independent research and lifecycle scenarios.
    const moderationProblemId = await setUpProblem(target, 2);
    await synthesisClosingReview({
      browser,
      agora,
      target,
      fixture: syntheses,
      record,
      authSecret: AUTH_SECRET,
      sessionCookie: SESSION_COOKIE,
      encode: (await import(createRequire(`${root}apps/web/package.json`).resolve("next-auth/jwt")))
        .encode,
    });
    await operatorModerationJourney({
      browser,
      agora,
      target,
      problemId: moderationProblemId,
      record,
      privateToCaches,
      authSecret: AUTH_SECRET,
      sessionCookie: SESSION_COOKIE,
      encode: (await import(createRequire(`${root}apps/web/package.json`).resolve("next-auth/jwt")))
        .encode,
    });

    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    for (const path of ["/", "/problems", "/results", `/p/${problemId}`, `/p/${problemId}/claims/${claimId}`]) {
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
    await stopAgora(agora?.child);
    await target.close();
  }
  const failed = results.filter((r) => !r.pass);
  console.log(
    JSON.stringify({
      kind: "agora-local-lane-summary",
      server_mode: serverMode,
      status: failed.length === 0 ? "pass" : "fail",
      checks: results.length,
      failed: failed.map((r) => r.name),
      boundary: `real Chromium + ${developmentMode ? "next dev --webpack (development only; no production-build claim)" : "next start"} + local Workerd/D1/R2; sponsor session minted with Agora's AUTH_SECRET (no Google OAuth exchange); no staging, Vercel or edge-cache claim`,
    }),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

try {
  await main();
} catch (error) {
  console.error(error);
  console.log(
    JSON.stringify({
      kind: "agora-local-lane-summary",
      status: "fail",
      server_mode: serverMode,
      code: "AGORA_LANE_RUNTIME_FAILED",
      checks: results.length,
    }),
  );
  process.exitCode = 1;
}
