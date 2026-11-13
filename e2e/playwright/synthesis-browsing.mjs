import assert from "node:assert/strict";
import {
  SingleSynthesisResponseSchema,
  SynthesesListResponseSchema,
  synthesesListPath,
} from "../../packages/contracts/src/syntheses.ts";
import { enrollSetupFellow, fellowPost, setUpProblem, SPONSOR } from "../gauntlet/local-product-flow.mjs";
import { USER_AGENT } from "../gauntlet/local-target.mjs";

const PRIVATE = "PRIVATE-SYNTHESIS-WORKSHOP-7H4";
const END = "End of the complete published synthesis, including its limits.";
const BODY = `The recorded claim concerns the final decimal digit of fifth powers. ${"The author has supplied a conjecture, not an independent verification. ".repeat(6)}\n\nThe identity $1^5 = 1$ is an example only. <img src=x onerror="window.__asimpSynthesisXss=1">\n\n${END}`;
const BOUNDARY = {
  verified: ["A conjecture and its falsifier were recorded; no universal result was verified."],
  mechanisms: ["One finite example, with no general proof or independent review."],
  independence_tiers: ["No independent support is asserted."],
  remaining_external_validation: ["An independently checked argument for the full stated range."],
};

async function readJson(target, path, schema) {
  const response = await fetch(`${target.origin}${path}`, {
    headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, "canonical synthesis read");
  return schema.parse(await response.json());
}

// This board is separate from every earlier browser scenario. All scientific
// objects and governance transitions use mounted routes, never projection seeds.
export async function seedSyntheses(target) {
  const problemId = await setUpProblem(target, 5);
  const sponsorId = `${SPONSOR}_p5`;
  const author = await enrollSetupFellow(target, sponsorId, "agora-synthesis-author", ["promote"]);
  const session = await fellowPost(target, "/v1/sessions", { problem_id: problemId, intent: "prove" }, author.token);
  assert.equal(session.status, 201, "synthesis author session");
  const path = `/v1/sessions/${session.body.session_id}`;
  async function publish(statement, falsifier) {
    const draft = await fellowPost(target, `${path}/workshop`, {
      type: "claim-draft", title: "Fifth-power work product", body_md: PRIVATE,
    }, author.token);
    assert.equal(draft.status, 201, "private synthesis source draft");
    const claim = await fellowPost(target, `${path}/promote`, {
      workshop_id: draft.body.workshop_id, kind: "conjecture", statement, falsifier,
    }, author.token);
    assert.equal(claim.status, 201, `synthesis source: ${claim.body.code ?? ""}`);
    return claim.body.claim_id;
  }
  const claimId = await publish(
    "For each integer n from zero through one thousand, the final decimal digit of n to the fifth equals the final digit of n.",
    "An integer in the stated range whose fifth power has a different final decimal digit.",
  );
  const coverage = (await target.env.DB.prepare("SELECT public_seq FROM problems WHERE id=?").bind(problemId).first()).public_seq;
  const common = {
    covers_through: coverage,
    anchors: [{ target_kind: "claim", target_id: claimId, target_version: 1 }],
    omitted: ["No independent review or general proof has been supplied."],
    selection_policy: "Include the exact current conjecture and disclose the absence of independent support.",
  };
  const first = await fellowPost(target, `${path}/synthesize`, {
    ...common, body_md: "The initial digest records the conjecture and leaves independent checking open.",
  }, author.token);
  assert.equal(first.status, 201, `initial synthesis: ${first.body.code ?? ""}`);
  const closing = await fellowPost(target, `${path}/synthesize`, {
    ...common, body_md: BODY,
    closing_resolution: { result_claim: { claim_id: claimId, version: 1 }, direction: "affirmed", no_claim_boundary: BOUNDARY },
  }, author.token);
  assert.equal(closing.status, 201, `closing declaration: ${closing.body.code ?? ""}`);

  // A later genuine scientific publication makes freshness observably stale;
  // publishing a synthesis itself must not manufacture material activity.
  await publish("The fifth power of the integer two equals thirty-two.", "Computing two to the fifth yields an integer other than thirty-two.");
  const list = await readJson(target, synthesesListPath(problemId, "json", { limit: 1 }), SynthesesListResponseSchema);
  assert.equal(list.syntheses[0].synthesis_id, closing.body.synthesis_id);
  assert.notEqual(list.next_before, null);
  const exact = await readJson(target, `/p/${problemId}/syntheses/${closing.body.synthesis_id}@1.json`, SingleSynthesisResponseSchema);
  const encodedExact = await readJson(target, `/p/${problemId}/syntheses/${encodeURIComponent(`${closing.body.synthesis_id}@1`)}.json`, SingleSynthesisResponseSchema);
  assert.deepEqual(encodedExact, exact, "both canonical exact spellings identify the same publication");
  assert.equal(exact.synthesis.body_md, BODY);
  assert.equal(exact.staleness.stale, true);
  assert.ok(exact.staleness.material_events_since > 0);
  return { problemId, sponsorId, claimId, authorId: author.fellowId, firstId: first.body.synthesis_id,
    closingId: closing.body.synthesis_id, coverage, list, exact };
}

export async function synthesisBrowsing({ page, agora, target, fixture, mode, record }) {
  const { problemId, claimId, closingId, coverage, exact, list } = fixture;
  await page.goto(`${agora.origin}/p/${problemId}`, { waitUntil: "load" });
  const discovery = page.getByRole("link", { name: "Browse syntheses at this ledger snapshot", exact: true });
  record(`${mode} syntheses: problem digest exposes its real snapshot collection`,
    (await discovery.getAttribute("href"))?.startsWith(`/p/${problemId}/syntheses?through=`) === true);
  await discovery.click();
  await page.getByRole("heading", { name: "Published syntheses", exact: true }).waitFor();
  record(`${mode} syntheses: collection discovers both real attributed publications`,
    await page.locator("main li.claim-card").count() === 2 &&
      await page.getByRole("link", { name: closingId, exact: true }).count() === 1 &&
      !(await page.content()).includes(PRIVATE));
  const query = { through: list.cursor, limit: 1 };
  await page.goto(`${agora.origin}${synthesesListPath(problemId, "human", query)}`, { waitUntil: "load" });
  record(`${mode} syntheses: bounded list agrees with canonical JSON and preserves snapshot`,
    await page.locator("main li.claim-card").count() === list.syntheses.length &&
      await page.getByRole("link", { name: "Canonical JSON", exact: true }).getAttribute("href") ===
        `${target.origin}${synthesesListPath(problemId, "json", query)}`);
  await page.getByRole("link", { name: "Older syntheses at this snapshot", exact: true }).click();
  await page.waitForURL(`${agora.origin}${synthesesListPath(problemId, "human", { ...query, before: list.next_before })}`);
  record(`${mode} syntheses: older-page navigation reaches the first publication`,
    await page.getByRole("link", { name: fixture.firstId, exact: true }).count() === 1 &&
      await page.getByRole("link", { name: closingId, exact: true }).count() === 0);
  await page.goto(`${agora.origin}${synthesesListPath(problemId, "human", query)}`, { waitUntil: "load" });
  await page.getByRole("link", { name: closingId, exact: true }).click();
  const exactPath = `/p/${problemId}/syntheses/${encodeURIComponent(`${closingId}@1`)}`;
  await page.waitForURL(`${agora.origin}${exactPath}`);
  assert.equal(await page.getByRole("heading", { level: 1, name: closingId, exact: true }).count(), 1,
    `exact synthesis navigation must render its publication; headings=${JSON.stringify(await page.locator("main h1").allTextContents())}`);
  const text = await page.locator("main").innerText();
  record(`${mode} syntheses: exact publication shows complete science, attribution and honest freshness`,
    text.includes(END) && text.includes(fixture.authorId) && text.includes(fixture.sponsorId) &&
      text.includes(exact.synthesis.selection_policy) && text.includes(exact.synthesis.omitted[0]) &&
      text.includes(`${exact.staleness.material_events_since} later material event`) &&
      text.includes("This publication does not establish that the problem has been resolved.") &&
      Object.values(BOUNDARY).flat().every((value) => text.includes(value)));
  record(`${mode} syntheses: untrusted markup stays inert and equations render`,
    await page.locator("main img[onerror], main a[href^='javascript:']").count() === 0 &&
      await page.evaluate(() => window.__asimpSynthesisXss ?? null) === null &&
      await page.locator("section[aria-labelledby='synthesis-body'] .katex").count() > 0 && !(await page.content()).includes(PRIVATE));
  const anchor = page.locator("section[aria-labelledby='synthesis-anchors']");
  record(`${mode} syntheses: exact sources retain their frozen coverage and canonical faces`,
    await anchor.getByRole("link", { name: "Read the referenced public record", exact: true }).getAttribute("href") ===
      `/p/${problemId}/claims/${encodeURIComponent(`${claimId}@1`)}?through=${coverage}` &&
      await page.getByRole("link", { name: "JSON", exact: true }).getAttribute("href") === `${target.origin}${exactPath}.json`);
  await anchor.getByRole("link", { name: "Read the referenced public record", exact: true }).click();
  await page.getByRole("heading", { level: 1, name: `${claimId}@1`, exact: true }).waitFor();
  record(`${mode} syntheses: scientific source link opens the actual pinned conjecture`,
    (await page.locator("main").innerText()).includes("final decimal digit"));
  await page.goto(`${agora.origin}${exactPath}`, { waitUntil: "load" });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({
    viewport: window.innerWidth,
    width: document.documentElement.scrollWidth,
    headings: [...document.querySelectorAll("main h1, main h2")].map((element) => ({
      width: element.clientWidth, scroll: element.scrollWidth,
    })),
    overflowing: [...document.querySelectorAll("main *")].filter((element) =>
      element.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 8).map((element) => ({
      tag: element.tagName, id: element.id, class: element.className,
      width: Math.round(element.getBoundingClientRect().width),
    })),
  }));
  record(`${mode} syntheses: full science and long identifiers fit the mobile viewport`,
    mobile.width <= mobile.viewport, mobile.width <= mobile.viewport ? null : mobile);
  await page.goto(`${agora.origin}${synthesesListPath(problemId, "human", query)}`, { waitUntil: "load" });
  record(`${mode} syntheses: bounded publication choices fit the mobile viewport`,
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({ width: 1280, height: 720 });
}

export async function synthesisClosingReview({ browser, agora, target, fixture, record, authSecret, sessionCookie, encode }) {
  const { problemId, sponsorId, claimId, closingId } = fixture;
  const disclosurePath = `/v1/sponsors/disclosures/${problemId}/${claimId}/1`;
  const disclosure = await target.sponsor(sponsorId, "GET", disclosurePath, "sponsor.disclosure.read");
  assert.equal(disclosure.status, 200, "actual result disclosure read");
  for (const scope of disclosure.body.scopes) {
    assert.equal(scope.sponsor_id, sponsorId);
    const written = await target.sponsor(sponsorId, "POST", disclosurePath, "sponsor.disclosure.write", {
      scope_id: scope.scope_id, expected_lineage_digest: disclosure.body.lineage_digest,
      expected_revision: scope.revision, decision: "no-undisclosed", disclosures: [],
    });
    assert.equal(written.status, 200, "actual sponsor disclosure write");
  }
  const context = await browser.newContext();
  try {
    await context.addCookies([{
      name: sessionCookie,
      value: await encode({ token: { sub: sponsorId, name: "Local synthesis sponsor", authTime: Math.floor(Date.now() / 1000) }, secret: authSecret, salt: sessionCookie }),
      url: agora.origin, httpOnly: true, sameSite: "Lax",
    }]);
    const page = await context.newPage();
    const consolePath = `/console/problems/${problemId}`;
    await page.goto(`${agora.origin}${consolePath}`, { waitUntil: "load" });
    await page.getByLabel("Claim identifier", { exact: true }).fill(claimId);
    await page.getByLabel("Claim version", { exact: true }).fill("1");
    await page.getByRole("checkbox", { name: /I confirm entering result review/ }).check();
    await page.getByRole("button", { name: "Enter result review for this claim", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Confirmed receipt:" }).waitFor();
    record("synthesis closing: sponsor browser enters review of the exact real claim",
      (await target.env.DB.prepare("SELECT status FROM problems WHERE id=?").bind(problemId).first()).status === "under-result-review");
    await page.reload({ waitUntil: "load" });
    await page.getByRole("button", { name: `Load exact preview of ${closingId}`, exact: true }).click();
    await page.getByRole("heading", { name: "Exact published closing synthesis", exact: true }).waitFor();
    const preview = page.locator("section[aria-labelledby='closing-synthesis-review']");
    const previewText = await preview.innerText();
    record("synthesis closing: exact preview preserves the complete Fellow work and limits",
      previewText.includes(BODY) && Object.values(BOUNDARY).flat().every((value) => previewText.includes(value)) &&
        await preview.getByRole("link", { name: "Read this exact closing publication in canonical text", exact: true }).getAttribute("href") ===
          `${target.origin}/p/${problemId}/syntheses/${closingId}.md`);
    const before = await target.env.DB.prepare("SELECT status,public_seq FROM problems WHERE id=?").bind(problemId).first();
    const eventCount = await target.env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id=?").bind(problemId).first();
    const observedFrom = target.observations.length;
    await page.getByRole("checkbox", { name: /I have read this exact synthesis and its limits/ }).check();
    await page.getByRole("button", { name: "Resolve using this exact synthesis", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Stoa refused this transition." }).waitFor();
    const after = await target.env.DB.prepare("SELECT status,public_seq FROM problems WHERE id=?").bind(problemId).first();
    const afterCount = await target.env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id=?").bind(problemId).first();
    record("synthesis closing: unsupported science is really refused without a resolution event",
      JSON.stringify(before) === JSON.stringify(after) && eventCount.n === afterCount.n &&
        target.observations.slice(observedFrom).some((item) => item.path === `/v1/sponsors/problems/${problemId}/lifecycle` &&
          item.status === 422 && item.code === "PREMATURE_RESOLUTION"));
    await page.goto(`${agora.origin}/p/${problemId}`, { waitUntil: "load" });
    record("synthesis closing: public status remains under review after the refused command",
      (await page.locator("main").innerText()).includes("under-result-review") &&
        await page.getByRole("heading", { name: "Resolution", exact: true }).count() === 0);
  } finally {
    await context.close();
  }
}
