import assert from "node:assert/strict";
import {
  citationPath,
  CitationsListResponseSchema,
  citationsListPath,
  SingleCitationResponseSchema,
} from "../../packages/contracts/src/citations.ts";
import { enrollSetupFellow, fellowPost, setUpProblem } from "../gauntlet/local-product-flow.mjs";
import { USER_AGENT } from "../gauntlet/local-target.mjs";

const ORIGINAL_EXCERPT = String.raw`One of $n$ and $n + 1$ is even. <img src=x onerror="window.__asimpCitationXss=1">`;
const CORRECTED_EXCERPT = "For every integer n, exactly one member of the consecutive pair n and n + 1 is even.";
const CORRECTED_TITLE = "Consecutive-product parity with the integer domain clarified";
const PRIVATE_CANARY = "PRIVATE-CITATION-WORKSHOP-DRAFT-7M3";

async function readSource(target, path, schema) {
  const response = await fetch(`${target.origin}${path}`, { headers: { "user-agent": USER_AGENT } });
  assert.equal(response.status, 200, `canonical citation source ${path}`);
  return schema.parse(await response.json());
}

// A third isolated problem leaves every earlier browser journey's captured
// cursor unchanged. Scientific writes use product routes, not fixture SQL.
export async function seedCitations(target) {
  const problemId = await setUpProblem(target, 3);
  const author = await enrollSetupFellow(target, "usr_agora_citation_pages", "agora-citation-pages", ["promote"]);
  const session = await fellowPost(target, "/v1/sessions", { problem_id: problemId, intent: "prove" }, author.token);
  assert.equal(session.status, 201, "citation browsing session");
  const path = `/v1/sessions/${session.body.session_id}`;
  const ids = [];
  const publications = [];
  for (let index = 0; index < 9; index += 1) {
    const request = index === 8 ? {
      title: "Remembered consecutive-product parity lemma", authors: ["A. Reader"],
      locator_kind: "model_memory", source_provenance: "model_memory",
      excerpt: "A recalled elementary parity argument for the product of consecutive integers.",
    } : {
      title: `Consecutive-product source ${index + 1}: finite integer parity`, authors: ["A. Reader"], year: 2025,
      locator_kind: "url", locator: `https://literature.example.org/consecutive-products/${index + 1}`,
      excerpt: index === 0 ? ORIGINAL_EXCERPT : `The parity argument is recorded with convention ${index + 1}.`,
      retrieved_at: "2026-11-08T11:00:00.000Z", source_provenance: "retrieved",
    };
    const published = await fellowPost(target, `${path}/citations`, request, author.token);
    assert.equal(published.status, 201, `citation ${index + 1}: ${published.body.code ?? ""}`);
    ids.push(published.body.citation_id);
    publications.push(request);
  }
  const draft = await fellowPost(target, `${path}/workshop`, {
    type: "claim-draft", title: "Consecutive integer parity", body_md: PRIVATE_CANARY,
  }, author.token);
  assert.equal(draft.status, 201, "private citation-associated claim draft");
  const claim = await fellowPost(target, `${path}/promote`, {
    workshop_id: draft.body.workshop_id, kind: "conjecture",
    statement: `For every integer n in 0..1000, the product n(n+1) is even, using the argument recorded in ${ids[0]}@1.`,
    falsifier: "An integer n in 0..1000 for which the product n(n+1) has odd parity.",
  }, author.token);
  assert.equal(claim.status, 201, `citation-associated claim: ${claim.body.code ?? ""}`);
  const captured = await readSource(target, citationsListPath(problemId, "json", { limit: 8 }), CitationsListResponseSchema);
  assert.equal(captured.citations.length, 8);
  assert.notEqual(captured.next_after, null);
  const corrected = await fellowPost(target, `${path}/citations/correct`, {
    ...publications[0], citation_id: ids[0], base_version: 1,
    title: CORRECTED_TITLE, excerpt: CORRECTED_EXCERPT,
    correction_rationale: "Specify the integer domain of the parity statement without rewriting the original excerpt.",
  }, author.token);
  assert.equal(corrected.status, 200, `citation correction: ${corrected.body.code ?? ""}`);
  const current = await readSource(target, citationPath(problemId, ids[0], "json"), SingleCitationResponseSchema);
  assert.equal(current.citation.version, 2);
  const original = await readSource(target, citationPath(problemId, `${ids[0]}@1`, "json", { through: current.cursor }), SingleCitationResponseSchema);
  assert.ok(original.associated_claims.some((item) => item.claim_id === claim.body.claim_id), "immutable associated claim reference");
  const event = await target.env.DB.prepare(
    "SELECT id FROM events WHERE problem_id = ? AND object_id = ? AND object_version = 1 AND type = 'citation.recorded'",
  ).bind(problemId, ids[0]).first();
  assert.ok(event?.id, "citation publication event for current visibility withdrawal");
  return {
    problemId, ids, cursor: captured.cursor, nextAfter: captured.next_after,
    currentCursor: current.cursor, claimId: claim.body.claim_id,
    author: author.fellowId, sourceEvent: event.id,
  };
}

async function displayedCitations(page) {
  return page.locator("main article.claim-card").evaluateAll((elements) => elements.map((element) => element.id));
}

export async function citationsBrowsing({ page, agora, target, fixture, mode, record }) {
  const { problemId, ids, cursor, currentCursor, claimId } = fixture;
  const query = { through: cursor, limit: 8 };
  const canonical = await readSource(target, citationsListPath(problemId, "json", query), CitationsListResponseSchema);
  await page.goto(`${agora.origin}${citationsListPath(problemId, "human", query)}`, { waitUntil: "load" });
  record(`${mode} citations: server collection agrees with the canonical frozen page`,
    await page.getByRole("heading", { name: "Literature and citations", level: 1, exact: true }).count() === 1 &&
      JSON.stringify(await displayedCitations(page)) === JSON.stringify(canonical.citations.map((item) => `${item.citation_id}-v${item.version}`)));
  const first = page.locator(`article[id="${ids[0]}-v1"]`);
  record(`${mode} citations: complete declared provenance and excerpt survive without executing authored markup`,
    (await first.innerText()).includes("Retrieved (Fellow-declared)") &&
      (await first.innerText()).includes("2026-11-08T11:00:00.000Z") &&
      await first.locator(".katex").count() > 0 &&
      await page.locator("main img[onerror], main a[href^='javascript:']").count() === 0 &&
      await page.evaluate(() => window.__asimpCitationXss ?? null) === null &&
      !(await page.content()).includes(PRIVATE_CANARY));
  record(`${mode} citations: machine and external-source links retain their actual destinations`,
    await page.getByRole("link", { name: "Canonical JSON", exact: true }).getAttribute("href") ===
      `${target.origin}${citationsListPath(problemId, "json", { ...query, after: 0 })}` &&
      await first.locator('a[rel="nofollow noopener noreferrer"]').getAttribute("href") ===
        "https://literature.example.org/consecutive-products/1");
  await first.getByRole("heading", { level: 2 }).getByRole("link").click();
  await page.waitForURL(`${agora.origin}${citationPath(problemId, `${ids[0]}@1`, "human", { through: cursor })}`);
  record(`${mode} citations: exact original version cannot become a later correction`,
    await page.getByRole("heading", { name: `${ids[0]}@1`, level: 1, exact: true }).count() === 1 &&
      !(await page.locator("main").innerText()).includes(CORRECTED_TITLE));
  await page.getByText(`Publication attribution for ${ids[0]}@1`, { exact: true }).click();
  record(`${mode} citations: original publication retains its Fellow attribution`,
    await page.getByRole("link", { name: fixture.author, exact: true }).count() === 1);
  const claimLink = page.locator('section[aria-labelledby="citation-references"]').getByRole("link", { name: `${claimId}@1`, exact: true });
  record(`${mode} citations: associated work links to its scoped exact claim version`,
    await claimLink.getAttribute("href") === `/p/${problemId}/claims/${encodeURIComponent(`${claimId}@1`)}?through=${cursor}`);
  await claimLink.click();
  await page.getByRole("heading", { name: `${claimId}@1`, level: 1, exact: true }).waitFor();
  record(`${mode} citations: the associated claim link opens published scientific work`,
    (await page.locator("main").innerText()).includes(`argument recorded in ${ids[0]}@1`));

  await page.goto(`${agora.origin}${citationsListPath(problemId, "human", query)}`, { waitUntil: "load" });
  await page.getByRole("link", { name: "Next citations at this snapshot", exact: true }).click();
  await page.waitForURL(`${agora.origin}${citationsListPath(problemId, "human", { ...query, after: fixture.nextAfter })}`);
  await page.locator(`article[id="${ids[8]}-v1"]`).waitFor();
  record(`${mode} citations: continuation reaches model-memory literature beyond the first page`,
    JSON.stringify(await displayedCitations(page)) === JSON.stringify([`${ids[8]}-v1`]) &&
      (await page.locator("main").innerText()).includes("Model memory (self-declared)") &&
      (await page.locator("main").innerText()).includes("Unanchored citation"));

  await page.goto(`${agora.origin}${citationPath(problemId, ids[0], "human")}`, { waitUntil: "load" });
  record(`${mode} citations: current exact source exposes the correction and actual version history`,
    await page.getByRole("heading", { name: `${ids[0]}@2`, level: 1, exact: true }).count() === 1 &&
      (await page.locator(`article[id="${ids[0]}-v2"]`).innerText()).includes(CORRECTED_EXCERPT) &&
      await page.locator('section[aria-labelledby="citation-history"] a').filter({ hasText: `${ids[0]}@1 ·` }).count() === 1);
  await page.locator('section[aria-labelledby="citation-history"] a').filter({ hasText: `${ids[0]}@1 ·` }).click();
  await page.waitForURL(`${agora.origin}${citationPath(problemId, `${ids[0]}@1`, "human", { through: currentCursor })}`);
  record(`${mode} citations: history opens the original version at the later snapshot`,
    await page.getByRole("heading", { name: `${ids[0]}@1`, level: 1, exact: true }).count() === 1 &&
      !(await page.locator(`article[id="${ids[0]}-v1"]`).innerText()).includes(CORRECTED_EXCERPT));
  for (const [name, format] of [["BibTeX", "bib"], ["CSL-JSON", "csl.json"]]) {
    const href = await page.getByRole("link", { name, exact: true }).getAttribute("href");
    const expected = `${target.origin}${citationPath(problemId, `${ids[0]}@1`, format, { through: currentCursor })}`;
    assert.equal(href, expected);
    const exported = await fetch(href, { headers: { "user-agent": USER_AGENT } });
    record(`${mode} citations: ${name} exports the selected original version`, exported.status === 200 &&
      !(await exported.text()).includes(CORRECTED_TITLE));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  record(`${mode} citations: exact sources and version history fit the mobile viewport`,
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({ width: 1280, height: 720 });
  const filtered = { through: currentCursor, limit: 8, unanchored: true };
  const unanchored = await readSource(target, citationsListPath(problemId, "json", filtered), CitationsListResponseSchema);
  await page.goto(`${agora.origin}${citationsListPath(problemId, "human", filtered)}`, { waitUntil: "load" });
  record(`${mode} citations: source-anchor filtering matches the canonical snapshot`,
    JSON.stringify(await displayedCitations(page)) === JSON.stringify(unanchored.citations.map((item) => `${item.citation_id}-v${item.version}`)) &&
      await page.getByRole("link", { name: "Unanchored", exact: true }).getAttribute("aria-current") === "page");
  await page.goto(`${agora.origin}/p/${problemId}`, { waitUntil: "load" });
  const browse = page.getByRole("link", { name: "Browse literature, provenance and citation versions", exact: true });
  const href = await browse.getAttribute("href");
  record(`${mode} citations: the digest links its own literature snapshot`,
    href === citationsListPath(problemId, "human", { through: currentCursor }) &&
      (await page.locator("main").innerText()).includes("literature citations in this preview"));
  await browse.click();
  await page.waitForURL(`${agora.origin}${href}`);
  record(`${mode} citations: problem literature navigation resolves a real readable page`,
    await page.getByRole("heading", { name: "Literature and citations", level: 1, exact: true }).count() === 1);
}

export async function citationsWithdrawal({ target, browser, agora, fixture, record }) {
  const { problemId, ids, cursor, sourceEvent } = fixture;
  const controls = await target.worker.getExport();
  await controls.redactPublicContent(sourceEvent);
  const exact = citationPath(problemId, `${ids[0]}@1`, "json", { through: cursor });
  const source = await fetch(`${target.origin}${exact}`, { headers: { "user-agent": USER_AGENT } });
  assert.equal(source.status, 404, "withdrawn original citation source is unavailable even at its earlier snapshot");
  const query = { through: cursor, limit: 8 };
  const canonical = await readSource(target, citationsListPath(problemId, "json", query), CitationsListResponseSchema);
  assert.ok(canonical.omitted.length > 0);
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    const mode = javaScriptEnabled ? "js" : "no-js";
    try {
      await page.goto(`${agora.origin}${citationPath(problemId, `${ids[0]}@1`, "human", { through: cursor })}`, { waitUntil: "load" });
      record(`${mode} citations: withdrawn historical source cannot reappear or substitute its correction`,
        await page.locator("main article.claim-card").count() === 0 &&
          !(await page.locator("main").innerText()).includes(CORRECTED_EXCERPT));
      await page.goto(`${agora.origin}${citationsListPath(problemId, "human", query)}`, { waitUntil: "load" });
      record(`${mode} citations: current visibility applies to the frozen collection with honest omissions`,
        JSON.stringify(await displayedCitations(page)) === JSON.stringify(canonical.citations.map((item) => `${item.citation_id}-v${item.version}`)) &&
          await page.getByRole("heading", { name: "Omissions and limits", exact: true }).count() === 1 &&
          await page.locator(`article[id="${ids[0]}-v1"]`).count() === 0);
    } finally {
      await context.close();
    }
  }
}
