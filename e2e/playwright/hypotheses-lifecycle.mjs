import assert from "node:assert/strict";
import { HypothesesResponseSchema } from "../../packages/contracts/src/hypotheses.ts";
import { enrollSetupFellow, fellowPost } from "../gauntlet/local-product-flow.mjs";
import { USER_AGENT } from "../gauntlet/local-target.mjs";

const DEFER_REASON = 'Pause the broad parity enumeration until the missing bound is established. <img src=x onerror="window.__asimpHypothesisXss=1">';

// Real mounted writes and canonical reads on Workerd/D1/R2. The one warning
// uses the lane's explicit synthetic classifier; this does not test hosted AI.
export async function seedHypothesisLifecycle(target, problemId) {
  const author = await enrollSetupFellow(target, "usr_agora_hypothesis_lifecycle",
    "agora-hypothesis-lifecycle", ["promote", "review"]);
  const session = await fellowPost(target, "/v1/sessions", { problem_id: problemId, intent: "explore" }, author.token);
  assert.equal(session.status, 201, "hypothesis lifecycle session");
  const path = `/v1/sessions/${session.body.session_id}`;
  const fixtures = await target.worker.getExport();
  const ids = [];
  for (let index = 1; index <= 9; index += 1) {
    if (index === 1) await fixtures.setScreenMode("allow-with-warning");
    try {
      const published = await fellowPost(target, `${path}/hypotheses`, {
        route: `Parity research route ${index}`,
        mechanism: `Enumerate the residue classes under decomposition ${index}.`,
        falsifier: `A boundary input that contradicts decomposition ${index}.`,
        discriminating_predictions: [`The boundary observable for route ${index} is zero.`],
        origin: "proposed",
        body_md: `Original scientific statement for parity route ${index}.`,
      }, author.token);
      assert.equal(published.status, 201, `hypothesis ${index}: ${published.body.code ?? ""}`);
      ids.push(published.body.hypothesis_id);
    } finally {
      if (index === 1) await fixtures.setScreenMode("pass");
    }
  }
  const read = async (id) => {
    const response = await fetch(`${target.origin}/p/${problemId}/hypotheses/${id}.json`, {
      headers: { "user-agent": USER_AGENT },
    });
    assert.equal(response.status, 200, "canonical hypothesis");
    return HypothesesResponseSchema.parse(await response.json());
  };
  const change = async (id, action, reason, successor) => {
    const current = (await read(id)).hypotheses[0];
    const changed = await fellowPost(target, `${path}/hypotheses/${id}/lifecycle`, {
      action, reason, expected_last_event_id: current.last_event.event_id,
      ...(successor === undefined ? {} : { successor_hypothesis_id: successor }),
    }, author.token);
    assert.equal(changed.status, 200, `hypothesis ${action}: ${changed.body.code ?? ""}`);
    return (await read(id)).hypotheses[0];
  };
  await change(ids[0], "defer", DEFER_REASON);
  const narrowed = await change(ids[1], "narrow", "Keep the original evidence here and continue on the bounded successor.", ids[8]);
  await change(ids[2], "supersede", "The alternate decomposition replaces this route without moving its evidence.", ids[8]);
  const paused = await change(ids[3], "defer", "Wait for the missing parity bound.");
  const resumed = await change(ids[3], "resume", "The missing bound is now available; resume investigation.");
  const evidence = await fellowPost(target, `${path}/evidence`, {
    bears_on_kind: "hypothesis", bears_on_id: ids[4], direction: "refutes",
    kind: "argument", mode: "exploratory", source: { kind: "model_memory" },
    body_md: "The boundary calculation contradicts the fifth route's parity prediction.",
  }, author.token);
  assert.equal(evidence.status, 201, "hypothesis counterexample");
  const killed = await fellowPost(target, `${path}/hypotheses/${ids[4]}/kill`, {
    hypothesis_id: ids[4],
    killed_by_evidence_id: evidence.body.evidence_id,
    reason: "The recorded boundary calculation refutes this route.",
  }, author.token);
  assert.equal(killed.status, 200, `hypothesis refutation: ${killed.body.code ?? ""}`);
  const latest = await read(ids[0]);
  assert.equal(latest.hypotheses[0].screening_notice?.notice, "screening-warning");
  return { ids, cursor: latest.cursor, narrowed, paused, resumed, fellowId: author.fellowId,
    originalEventId: latest.hypotheses[0].publication.event_id };
}

export async function hypothesisLifecycleBrowsing({ page, agora, target, problemId, fixture, mode, record }) {
  const { ids, cursor, narrowed, paused, resumed } = fixture;
  const listPath = `/p/${problemId}/hypotheses`;
  const cut = `?through=${cursor}`;
  const response = await fetch(`${target.origin}${listPath}.json${cut}`, { headers: { "user-agent": USER_AGENT } });
  const canonical = HypothesesResponseSchema.parse(await response.json());
  await page.goto(`${agora.origin}${listPath}${cut}`, { waitUntil: "load" });
  const statuses = await page.locator("[data-hypothesis-status]").evaluateAll((elements) =>
    elements.map((element) => ({ status: element.dataset.hypothesisStatus, label: element.innerText.trim() })));
  const labels = { active: "Active", deferred: "Deferred", narrowed: "Narrowed", superseded: "Superseded", killed: "Killed" };
  record(`${mode} hypotheses: all route statuses agree with canonical records`,
    statuses.length === 8 && canonical.hypotheses.every((item, index) =>
      statuses[index]?.status === item.status && statuses[index]?.label === labels[item.status]), statuses);
  const warnedCard = page.locator(`[id="${ids[0]}"]`);
  record(`${mode} hypotheses: the original publication retains its screening notice after deferral`,
    await warnedCard.locator('[data-screening-notice="screening-warning"]').count() === 1 &&
      (await warnedCard.innerText()).includes("Parity research route 1") &&
      (await warnedCard.innerText()).includes("Pause the broad parity enumeration"));
  record(`${mode} hypotheses: lifecycle markup remains inert`,
    await page.locator("main img[onerror], main a[href^='javascript:']").count() === 0 &&
      await page.evaluate(() => window.__asimpHypothesisXss ?? null) === null);
  const next = `${listPath}${cut}&after=${canonical.next_after}`;
  await page.getByRole("link", { name: "Next hypotheses at this snapshot", exact: true }).click();
  await page.waitForURL(`${agora.origin}${next}`);
  await page.getByText("Parity research route 9", { exact: true }).waitFor();
  record(`${mode} hypotheses: continuation reaches the ninth route at the same snapshot`,
    await page.locator("[data-hypothesis-status]").count() === 1 &&
      (await page.locator("main").innerText()).includes("Parity research route 9") &&
      await page.getByRole("link", { name: "Next hypotheses at this snapshot", exact: true }).count() === 0);

  await page.goto(`${agora.origin}${listPath}/${ids[1]}${cut}`, { waitUntil: "load" });
  const decision = page.getByRole("region", { name: `Latest route decision for ${ids[1]}` });
  await decision.locator("summary").click();
  const source = decision.getByRole("link", { name: `Read source event ${narrowed.last_event.event_id}`, exact: true });
  record(`${mode} hypotheses: narrowing retains its original statement and exact attributed event`,
    (await page.locator("main").innerText()).includes("Parity research route 2") &&
      await source.getAttribute("href") === `/r/p/${problemId}/events/${narrowed.last_event.seq}` &&
      (await decision.innerText()).includes(fixture.fellowId));
  await source.click();
  await page.waitForURL(`${agora.origin}/r/p/${problemId}/events/${narrowed.last_event.seq}`);
  await page.getByText(narrowed.last_event.event_id, { exact: true }).waitFor();
  record(`${mode} hypotheses: decision source opens the actual recorded lifecycle event`,
    (await page.locator("main").innerText()).includes(narrowed.last_event.event_id));
  await page.goto(`${agora.origin}${listPath}/${ids[1]}${cut}`, { waitUntil: "load" });
  await page.getByRole("link", { name: `Read ${ids[8]}, the narrower successor at this snapshot`, exact: true }).click();
  await page.waitForURL(`${agora.origin}${listPath}/${ids[8]}${cut}`);
  await page.getByRole("heading", { name: ids[8], exact: true, level: 1 }).waitFor();
  record(`${mode} hypotheses: a successor beyond the first page resolves directly at the captured cut`,
    await page.locator("h1").innerText() === ids[8] &&
      (await page.locator("main").innerText()).includes("Parity research route 9") &&
      await page.locator("[data-hypothesis-status]").getAttribute("data-hypothesis-status") === "active");

  await page.goto(`${agora.origin}${listPath}/${ids[3]}?through=${paused.last_event.seq}`, { waitUntil: "load" });
  record(`${mode} hypotheses: an earlier snapshot retains the deferred state after a later resumption`,
    await page.locator("[data-hypothesis-status]").innerText() === "Deferred" &&
      (await page.locator("main").innerText()).includes("Wait for the missing parity bound.") &&
      !(await page.locator("main").innerText()).includes("The missing bound is now available"));
  await page.goto(`${agora.origin}${listPath}/${ids[3]}${cut}`, { waitUntil: "load" });
  record(`${mode} hypotheses: resumption is visibly attributed while the route returns to active`,
    await page.locator("[data-hypothesis-status]").innerText() === "Active" &&
      await page.locator('[data-hypothesis-lifecycle="resume"]').innerText() === "Resumed");
  const history = page.getByRole("link", { name: "Problem history from this publication at this snapshot", exact: true });
  const historyPath = `/p/${problemId}/events?since=${resumed.publication.seq - 1}&limit=50&through=${cursor}`;
  record(`${mode} hypotheses: problem history stays bounded by the route publication and captured cut`,
    await history.getAttribute("href") === historyPath);
  await history.click();
  await page.waitForURL(`${agora.origin}${historyPath}`);
  await page.getByText(resumed.last_event.event_id, { exact: true }).waitFor();
  const historyText = await page.locator("main").innerText();
  record(`${mode} hypotheses: event history exposes both deferral and resumption`,
    historyText.includes(paused.last_event.event_id) && historyText.includes(resumed.last_event.event_id));
}

export async function hypothesisPublicationWithdrawal({ target, browser, agora, problemId, fixture, record }) {
  const fixtures = await target.worker.getExport();
  // Explicit ephemeral operator action through the same content-control helper
  // as the native integration lanes; scientific event bytes remain unchanged.
  await fixtures.redactPublicContent(fixture.originalEventId);
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    const mode = javaScriptEnabled ? "js" : "no-js";
    try {
      await page.goto(`${agora.origin}/p/${problemId}/hypotheses/${fixture.ids[0]}?through=${fixture.cursor}`, { waitUntil: "load" });
      const text = await page.locator("main").innerText();
      record(`${mode} hypotheses: present-day withdrawal removes the old publication and its screening notice`,
        text.includes("published hypothesis content is currently unavailable or withdrawn") &&
          !text.includes("Parity research route 1") &&
          await page.locator("[data-screening-notice]").count() === 0);
    } finally {
      await context.close();
    }
  }
}
