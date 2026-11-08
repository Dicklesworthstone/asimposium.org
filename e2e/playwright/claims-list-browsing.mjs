import assert from "node:assert/strict";
import { ClaimsListResponseSchema } from "../../packages/contracts/src/claims-list.ts";
import { enrollSetupFellow, fellowPost, setUpProblem } from "../gauntlet/local-product-flow.mjs";
import { USER_AGENT } from "../gauntlet/local-target.mjs";

const PRIVATE_CANARY = "PRIVATE-CLAIMS-PAGINATION-DRAFT-9K2";
const ORIGINAL = String.raw`The first odd number is $1 = 1^2$. <img src=x onerror="window.__asimpClaimListXss=1">`;
const REVISED = "The first two odd numbers have sum 1 + 3 = 4.";
const STATEMENTS = [
  ORIGINAL,
  "Consecutive odd numbers differ by exactly two.",
  "The sum of the first three positive odd numbers is nine.",
  "The difference between adjacent integer squares is odd.",
  "An odd integer has an even predecessor.",
  "Pairing the first and last of n consecutive positive odd numbers gives twice n.",
  "Appending the next positive odd number increases the partial sum by 2n + 1.",
  "The arithmetic mean of the first n positive odd numbers is n.",
  "For every positive integer n, the sum of the first n odd numbers equals n squared.",
];

async function readPage(target, problemId, query = "") {
  const response = await fetch(`${target.origin}/p/${problemId}/claims.json${query}`, {
    headers: { "user-agent": USER_AGENT },
  });
  assert.equal(response.status, 200, "canonical claims collection");
  return ClaimsListResponseSchema.parse(await response.json());
}

// A separate problem keeps these writes from changing other browser journeys'
// captured cursors. All scientific publications use the mounted product routes.
export async function seedClaimsList(target) {
  const problemId = await setUpProblem(target, 1);
  const author = await enrollSetupFellow(target, "usr_agora_claim_pages", "agora-claim-pages", ["promote"]);
  const session = await fellowPost(target, "/v1/sessions", { problem_id: problemId, intent: "prove" }, author.token);
  assert.equal(session.status, 201, "claims pagination session");
  const path = `/v1/sessions/${session.body.session_id}`;
  const ids = [];
  const events = [];
  for (const [index, statement] of STATEMENTS.entries()) {
    const draft = await fellowPost(target, `${path}/workshop`, {
      type: "claim-draft", title: `Odd-sum statement ${index + 1}`, body_md: PRIVATE_CANARY,
    }, author.token);
    assert.equal(draft.status, 201, "claims pagination private draft");
    const published = await fellowPost(target, `${path}/promote`, {
      workshop_id: draft.body.workshop_id, kind: "conjecture", statement,
      falsifier: "An integer in the stated domain for which the asserted equality or parity fails.",
    }, author.token);
    assert.equal(published.status, 201, `claims pagination publication ${index + 1}: ${published.body.code ?? ""}`);
    ids.push(published.body.claim_id);
    const event = await target.env.DB.prepare(
      "SELECT id FROM events WHERE problem_id = ? AND object_id = ? AND type = 'claim.created'",
    ).bind(problemId, published.body.claim_id).first();
    assert.ok(event?.id, "publication event for later lawful content withdrawal");
    events.push(event.id);
  }
  const captured = await readPage(target, problemId);
  assert.equal(captured.count, 8);
  assert.notEqual(captured.next_after, null);
  const revised = await fellowPost(target, `${path}/revise`, {
    claim_id: ids[0], base_version: 1, kind: "conjecture", statement: REVISED,
    falsifier: "The sum of one and three differs from four.", depends_on: [],
    client_context_cursor: captured.cursor,
  }, author.token);
  assert.equal(revised.status, 201, `claims pagination later revision: ${revised.body.code ?? ""}`);
  return { problemId, ids, events, cursor: captured.cursor, nextAfter: captured.next_after };
}

export async function claimsListBrowsing({ page, agora, target, fixture, mode, record }) {
  const { problemId, ids, cursor, nextAfter } = fixture;
  const listPath = `/p/${problemId}/claims`;
  const cut = `?through=${cursor}`;
  const canonical = await readPage(target, problemId, cut);
  await page.goto(`${agora.origin}${listPath}${cut}`, { waitUntil: "load" });
  const cards = page.locator("main .claim-card");
  const displayedIds = await cards.evaluateAll((elements) => elements.map((element) => element.id));
  record(`${mode} claims: first page agrees with eight canonical exact versions`,
    JSON.stringify(displayedIds) === JSON.stringify(canonical.claims.map((claim) => claim.id)) &&
      await cards.count() === 8 &&
      await page.getByRole("link", { name: `${ids[0]}@1`, exact: true }).count() === 1);
  const text = await page.locator("main").innerText();
  record(`${mode} claims: a later revision cannot replace the captured statement`,
    text.includes("The first odd number is") && !text.includes(REVISED));
  record(`${mode} claims: private drafts stay private and scientific markup stays inert`,
    !(await page.content()).includes(PRIVATE_CANARY) &&
      await page.locator("main img[onerror], main a[href^='javascript:']").count() === 0 &&
      await page.evaluate(() => window.__asimpClaimListXss ?? null) === null &&
      await cards.first().locator(".katex").count() > 0);
  record(`${mode} claims: canonical and snapshot links retain the exact page`,
    await page.getByRole("link", { name: "Canonical JSON", exact: true }).getAttribute("href") ===
      `${target.origin}${listPath}.json${cut}&after=0` &&
      await page.getByRole("link", { name: "Link to this ledger snapshot", exact: true }).getAttribute("href") === `${listPath}${cut}&after=0`);
  const exact = `${listPath}/${encodeURIComponent(`${ids[0]}@1`)}${cut}`;
  await page.getByRole("link", { name: `${ids[0]}@1`, exact: true }).click();
  await page.waitForURL(`${agora.origin}${exact}`);
  record(`${mode} claims: exact-version link opens the original scientific record`,
    (await page.locator("main").innerText()).includes("The first odd number is") &&
      !(await page.locator("main").innerText()).includes(REVISED));
  await page.goto(`${agora.origin}${listPath}${cut}`, { waitUntil: "load" });
  await page.getByRole("link", { name: "Next claims at this snapshot", exact: true }).click();
  await page.waitForURL(`${agora.origin}${listPath}${cut}&after=${nextAfter}`);
  await page.getByRole("link", { name: `${ids[8]}@1`, exact: true }).waitFor();
  record(`${mode} claims: continuation reaches the ninth claim without moving the snapshot`,
    await page.locator("main .claim-card").count() === 1 &&
      await page.getByRole("link", { name: "Next claims at this snapshot", exact: true }).count() === 0 &&
      await page.getByRole("link", { name: "First claims at this snapshot", exact: true }).getAttribute("href") === `${listPath}${cut}&after=0`);
  await page.setViewportSize({ width: 390, height: 844 });
  record(`${mode} claims: mobile continuation fits the viewport`,
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${agora.origin}/p/${problemId}`, { waitUntil: "load" });
  const browse = page.getByRole("link", { name: "Browse all claim pages at this snapshot", exact: true });
  const href = await browse.getAttribute("href");
  record(`${mode} claims: the bounded digest exposes a path to the full collection`,
    href?.startsWith(`${listPath}?through=`) === true);
  await browse.click();
  await page.waitForURL(`${agora.origin}${href}`);
  record(`${mode} claims: digest navigation resolves a readable claims page`,
    await page.getByRole("heading", { name: "Claims", level: 1, exact: true }).count() === 1 &&
      await page.locator("main .claim-card").count() > 0);
}

export async function claimsListWithdrawal({ target, browser, agora, fixture, record }) {
  const { problemId, ids, events, cursor, nextAfter } = fixture;
  const controls = await target.worker.getExport();
  // Explicit ephemeral operator action, through the native harness's lawful
  // content-control helper. Historical browsing must obey current withdrawals.
  for (const eventId of events.slice(0, 8)) await controls.redactPublicContent(eventId);
  const canonical = await readPage(target, problemId, `?through=${cursor}`);
  assert.equal(canonical.count, 0);
  assert.equal(canonical.next_after, nextAfter);
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    const mode = javaScriptEnabled ? "js" : "no-js";
    try {
      const path = `/p/${problemId}/claims?through=${cursor}`;
      await page.goto(`${agora.origin}${path}`, { waitUntil: "load" });
      const text = await page.locator("main").innerText();
      record(`${mode} claims: a fully withheld historical page explains omissions and retains continuation`,
        await page.locator("main .claim-card").count() === 0 &&
          text.includes("No readable statements were returned on this page") &&
          !text.includes("The first odd number is") &&
          await page.getByRole("link", { name: "Next claims at this snapshot", exact: true }).getAttribute("href") === `${path}&after=${nextAfter}`);
      await page.getByRole("link", { name: "Next claims at this snapshot", exact: true }).click();
      await page.waitForURL(`${agora.origin}${path}&after=${nextAfter}`);
      record(`${mode} claims: an empty withheld page does not strand the later public claim`,
        await page.getByRole("link", { name: `${ids[8]}@1`, exact: true }).count() === 1 &&
          await page.locator("main .claim-card").count() === 1);
    } finally {
      await context.close();
    }
  }
}
