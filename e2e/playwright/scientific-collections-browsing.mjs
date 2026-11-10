import assert from "node:assert/strict";
import { ConflictsListResponseSchema, conflictsListPath } from "../../packages/contracts/src/conflicts.ts";
import { QuestionsListResponseSchema, questionsListPath } from "../../packages/contracts/src/questions.ts";
import { enrollSetupFellow, fellowPost } from "../gauntlet/local-product-flow.mjs";
import { USER_AGENT } from "../gauntlet/local-target.mjs";

const ALIGNMENT = String.raw`Both claims use the positive integer index $n \geq 1$. <img src=x onerror="window.__asimpConflictXss=1">`;
const QUESTION = String.raw`Which finite calculation discriminates the proposed identities for $n^2$? <img src=x onerror="window.__asimpQuestionXss=1">`;
const RESOLUTION = "A direct finite calculation separates the indexing conventions used in these two statements.";

async function readCollection(target, path, schema) {
  const response = await fetch(`${target.origin}${path}`, { headers: { "user-agent": USER_AGENT } });
  assert.equal(response.status, 200, `canonical collection ${path}`);
  return schema.parse(await response.json());
}

async function sessionFor(target, problemId, sponsorId, name) {
  const fellow = await enrollSetupFellow(target, sponsorId, name, ["promote"]);
  const session = await fellowPost(target, "/v1/sessions", { problem_id: problemId, intent: "prove" }, fellow.token);
  assert.equal(session.status, 201, `${name} session`);
  return { ...fellow, path: `/v1/sessions/${session.body.session_id}` };
}

// Reuse the separate claims-pagination problem only after its snapshot was
// captured. Nothing changes the original browser journey's pinned problem.
// Publications and all lifecycle changes pass through the real product routes.
export async function seedScientificCollections(target, claimsFixture) {
  const { problemId, ids: claims } = claimsFixture;
  const author = await sessionFor(target, problemId, "usr_agora_questions_conflicts", "agora-research-pages");
  const resolver = await sessionFor(target, problemId, "usr_agora_resolution_pages", "agora-resolution-pages");
  const conflicts = [];
  const questions = [];
  for (let index = 0; index < 9; index += 1) {
    const conflict = await fellowPost(target, `${author.path}/conflicts`, {
      claims: [{ claim_id: claims[index], version: 1 }, { claim_id: claims[(index + 1) % 9], version: 1 }],
      aligned_definitions: ALIGNMENT,
      aligned_scope: "Both statements concern finite sums of positive odd integers.",
      aligned_quantifiers: "Every integer index in the common positive domain is quantified universally.",
      smallest_disagreement: `Comparison ${index + 1} isolates whether both statements use the same initial term.`,
      agreed_facts: ["The first positive odd integer is one."],
      discriminating_tests: ["Compute the first three partial sums using each stated indexing convention."],
    }, author.token);
    assert.equal(conflict.status, 201, `conflict ${index + 1}: ${conflict.body.code ?? ""}`);
    conflicts.push(conflict.body.conflict_id);
    const question = await fellowPost(target, `${author.path}/questions`, {
      body_md: `${QUESTION}\n\nResearch question ${index + 1}.`,
      target_refs: [`${claims[index]}@1`, conflict.body.conflict_id],
      blocking: `${claims[index]}@1`,
    }, author.token);
    assert.equal(question.status, 201, `question ${index + 1}: ${question.body.code ?? ""}`);
    questions.push(question.body.question_id);
  }
  const historical = await readCollection(target, conflictsListPath(problemId, "json", { limit: 8 }), ConflictsListResponseSchema);
  assert.equal(historical.conflicts.length, 8);
  assert.notEqual(historical.next_after, null);
  const historicalQuestions = await readCollection(target, questionsListPath(problemId, "json", {
    through: historical.cursor, limit: 8,
  }), QuestionsListResponseSchema);
  assert.equal(historicalQuestions.questions.length, 8);
  assert.notEqual(historicalQuestions.next_after, null);

  const resolution = await fellowPost(target, `${resolver.path}/conflicts/${conflicts[8]}/resolve`, {
    status: "resolved", resolution: RESOLUTION,
  }, resolver.token);
  assert.equal(resolution.status, 200, `resolution: ${resolution.body.code ?? ""}`);
  const answer = await fellowPost(target, `${resolver.path}/questions/${questions[8]}/answer`, {
    resolved_by_object: `${claims[8]}@1`,
  }, resolver.token);
  assert.equal(answer.status, 200, `answer: ${answer.body.code ?? ""}`);
  const lease = await fellowPost(target, `${resolver.path}/questions/${questions[0]}/lease`, {
    ttl_seconds: 7200, objective: "Compare the finite indexing conventions", deliverable: "An exact finite calculation",
  }, resolver.token);
  assert.equal(lease.status, 200, `lease: ${lease.body.code ?? ""}`);
  const withdrawn = await fellowPost(target, `${author.path}/questions/${questions[1]}/withdraw`, {
    reason: "The author has consolidated this request into the remaining research questions.",
  }, author.token);
  assert.equal(withdrawn.status, 200, `withdrawal: ${withdrawn.body.code ?? ""}`);
  const current = await readCollection(target, conflictsListPath(problemId, "json", { target: conflicts[8] }), ConflictsListResponseSchema);
  assert.equal(current.conflicts[0].resolution_event?.author_fellow_id, resolver.fellowId);
  const sourceEvents = [];
  for (const [kind, objectId] of [["conflict.normalized", conflicts[8]], ["question.asked", questions[8]]]) {
    const event = await target.env.DB.prepare(
      "SELECT id FROM events WHERE problem_id = ? AND object_id = ? AND type = ?",
    ).bind(problemId, objectId, kind).first();
    assert.ok(event?.id, `${kind} source for current content withdrawal`);
    sourceEvents.push(event.id);
  }
  return {
    problemId, claims, conflicts, questions, sourceEvents,
    cursor: historical.cursor, currentCursor: current.cursor,
    conflictAfter: historical.next_after, questionAfter: historicalQuestions.next_after,
    resolution: current.conflicts[0].resolution_event, resolver: resolver.fellowId,
  };
}

async function cardIds(page) {
  return page.locator("main .claim-card").evaluateAll((elements) => elements.map((element) => element.id));
}

export async function scientificCollectionsBrowsing({ page, agora, target, fixture, mode, record }) {
  const { problemId, claims, conflicts, questions, cursor, currentCursor } = fixture;
  const historical = { through: cursor, limit: 8 };
  const conflictPath = conflictsListPath(problemId, "human", historical);
  const questionPath = questionsListPath(problemId, "human", historical);
  const canonicalConflicts = await readCollection(target, conflictsListPath(problemId, "json", historical), ConflictsListResponseSchema);
  const canonicalQuestions = await readCollection(target, questionsListPath(problemId, "json", historical), QuestionsListResponseSchema);
  await page.goto(`${agora.origin}${conflictPath}`, { waitUntil: "load" });
  record(`${mode} conflicts: real server page agrees with eight canonical records`,
    await page.getByRole("heading", { level: 1, name: "Scientific disagreements", exact: true }).count() === 1 &&
      JSON.stringify(await cardIds(page)) === JSON.stringify(canonicalConflicts.conflicts.map((item) => item.conflict_id)));
  const firstConflict = page.locator(`article[id="${conflicts[0]}"]`);
  record(`${mode} conflicts: aligned science and exact-version sources survive without scripts`,
    (await firstConflict.innerText()).includes("The first positive odd integer is one.") &&
      await firstConflict.getByRole("heading", { name: "Proposed discriminating tests", exact: true }).count() === 1 &&
      await firstConflict.getByRole("link", { name: `${claims[0]}@1`, exact: true }).getAttribute("href") ===
        `/p/${problemId}/claims/${encodeURIComponent(`${claims[0]}@1`)}?through=${cursor}` &&
      await firstConflict.locator(".katex").count() > 0);
  record(`${mode} conflicts: author markup stays inert and canonical links retain the page`,
    await page.locator("main img[onerror], main a[href^='javascript:']").count() === 0 &&
      await page.evaluate(() => window.__asimpConflictXss ?? null) === null &&
      await page.getByRole("link", { name: "Canonical JSON", exact: true }).getAttribute("href") ===
        `${target.origin}${conflictsListPath(problemId, "json", { ...historical, after: 0 })}`);
  await page.getByRole("link", { name: "Next conflicts at this snapshot", exact: true }).click();
  await page.waitForURL(`${agora.origin}${conflictsListPath(problemId, "human", { ...historical, after: fixture.conflictAfter })}`);
  await page.locator(`article[id="${conflicts[8]}"]`).waitFor();
  record(`${mode} conflicts: continuation reaches the ninth disagreement at its original state`,
    JSON.stringify(await cardIds(page)) === JSON.stringify([conflicts[8]]) &&
      await page.locator('[data-conflict-status="open"]').count() === 1 &&
      !(await page.locator("main").innerText()).includes(RESOLUTION));
  await page.goto(`${agora.origin}/r/p/${problemId}/conflicts/${conflicts[8]}?through=${cursor}`, { waitUntil: "load" });
  record(`${mode} conflicts: exact record alias preserves the captured open disagreement`,
    new URL(page.url()).pathname === `/p/${problemId}/conflicts` &&
      new URL(page.url()).searchParams.get("target") === conflicts[8] &&
      await page.getByRole("heading", { level: 1, name: conflicts[8], exact: true }).count() === 1 &&
      await page.locator('[data-conflict-status="open"]').count() === 1);
  await page.getByRole("link", { name: "Read the latest public record", exact: true }).click();
  await page.waitForURL(`${agora.origin}${conflictsListPath(problemId, "human", { target: conflicts[8] })}`);
  record(`${mode} conflicts: latest resolution retains its own Fellow and source event`,
    (await page.locator("main").innerText()).includes(RESOLUTION) &&
      await page.locator('[data-conflict-status="resolved"]').count() === 1 &&
      await page.getByRole("link", { name: fixture.resolver, exact: true }).count() === 1 &&
      await page.getByRole("link", { name: `${fixture.resolution.event_id} · ledger sequence ${fixture.resolution.seq}`, exact: true })
        .getAttribute("href") === `/r/p/${problemId}/events/${fixture.resolution.seq}`);
  await page.getByRole("link", { name: `${fixture.resolution.event_id} · ledger sequence ${fixture.resolution.seq}`, exact: true }).click();
  await page.getByText(fixture.resolution.event_id, { exact: true }).waitFor();
  record(`${mode} conflicts: resolution source link opens its real public event`,
    (await page.locator("main").innerText()).includes(fixture.resolution.event_id));
  await page.goto(`${agora.origin}${conflictsListPath(problemId, "human", { through: currentCursor, limit: 8, status: "resolved" })}`, { waitUntil: "load" });
  record(`${mode} conflicts: empty filtered page keeps its continuation`,
    await page.locator("main .claim-card").count() === 0 &&
      await page.getByRole("link", { name: "Next conflicts at this snapshot", exact: true }).count() === 1);
  await page.getByRole("link", { name: "Next conflicts at this snapshot", exact: true }).click();
  await page.locator('[data-conflict-status="resolved"]').waitFor();
  record(`${mode} conflicts: filtered continuation reaches the later recorded resolution`,
    JSON.stringify(await cardIds(page)) === JSON.stringify([conflicts[8]]));

  await page.goto(`${agora.origin}${questionPath}`, { waitUntil: "load" });
  record(`${mode} questions: real server page agrees with eight canonical records`,
    await page.getByRole("heading", { level: 1, name: "Research questions", exact: true }).count() === 1 &&
      JSON.stringify(await cardIds(page)) === JSON.stringify(canonicalQuestions.questions.map((item) => item.question_id)) &&
      await page.locator('[data-question-status="open"]').count() === 8);
  const firstQuestion = page.locator(`article[id="${questions[0]}"]`);
  record(`${mode} questions: scientific targets and equations remain usable without script execution`,
    await firstQuestion.locator(".katex").count() > 0 &&
      await firstQuestion.getByRole("link", { name: conflicts[0], exact: true }).getAttribute("href") ===
        conflictsListPath(problemId, "human", { through: cursor, target: conflicts[0] }) &&
      await page.locator("main img[onerror], main a[href^='javascript:']").count() === 0 &&
      await page.evaluate(() => window.__asimpQuestionXss ?? null) === null &&
      await page.getByRole("link", { name: "Canonical JSON", exact: true }).getAttribute("href") ===
        `${target.origin}${questionsListPath(problemId, "json", { ...historical, after: 0 })}`);
  await page.getByRole("link", { name: "Next questions at this snapshot", exact: true }).click();
  await page.waitForURL(`${agora.origin}${questionsListPath(problemId, "human", { ...historical, after: fixture.questionAfter })}`);
  await page.locator(`article[id="${questions[8]}"]`).waitFor();
  record(`${mode} questions: continuation preserves the ninth question before its later answer`,
    JSON.stringify(await cardIds(page)) === JSON.stringify([questions[8]]) &&
      await page.locator('[data-question-status="open"]').count() === 1 &&
      await page.getByRole("heading", { name: "Submitted answering work", exact: true }).count() === 0);
  await page.goto(`${agora.origin}/r/p/${problemId}/questions/${questions[8]}?through=${cursor}`, { waitUntil: "load" });
  record(`${mode} questions: exact record alias preserves the original question`,
    new URL(page.url()).pathname === `/p/${problemId}/questions` &&
      new URL(page.url()).searchParams.get("target") === questions[8] &&
      await page.getByRole("heading", { level: 1, name: questions[8], exact: true }).count() === 1 &&
      await page.locator('[data-question-status="open"]').count() === 1);
  await page.getByRole("link", { name: "Read the latest public record", exact: true }).click();
  await page.waitForURL(`${agora.origin}${questionsListPath(problemId, "human", { target: questions[8] })}`);
  const answer = page.getByRole("heading", { name: "Submitted answering work", exact: true }).locator("..");
  record(`${mode} questions: answering work links to its exact statement without claiming verification`,
    await page.locator('[data-question-status="resolved"]').count() === 1 &&
      await answer.getByRole("link", { name: `${claims[8]}@1`, exact: true }).getAttribute("href") ===
        `/p/${problemId}/claims/${encodeURIComponent(`${claims[8]}@1`)}?through=${currentCursor}` &&
      (await answer.innerText()).includes("does not independently verify"));
  await answer.getByRole("link", { name: `${claims[8]}@1`, exact: true }).click();
  await page.getByRole("heading", { level: 1, name: `${claims[8]}@1`, exact: true }).waitFor();
  record(`${mode} questions: submitted answer resolves to the public scientific source`,
    (await page.locator("main").innerText()).includes("sum of the first n odd numbers equals n squared"));
  await page.goto(`${agora.origin}${questionsListPath(problemId, "human", { through: currentCursor, limit: 8 })}`, { waitUntil: "load" });
  record(`${mode} questions: committed coordination and withdrawal stay distinct from answers`,
    await page.locator('[data-question-status="leased"]').count() === 1 &&
      await page.locator('[data-question-status="withdrawn"]').count() === 1 &&
      (await page.locator("main").innerText()).includes("not a live-presence signal") &&
      (await page.locator("main").innerText()).includes("withdrawal does not establish an answer"));
  await page.getByRole("link", { name: "Answer recorded", exact: true }).click();
  await page.waitForURL(`${agora.origin}${questionsListPath(problemId, "human", { through: currentCursor, limit: 8, status: "resolved" })}`);
  await page.getByRole("link", { name: "Next questions at this snapshot", exact: true }).waitFor();
  record(`${mode} questions: empty answer filter retains continuation`,
    await page.locator("main .claim-card").count() === 0);
  await page.getByRole("link", { name: "Next questions at this snapshot", exact: true }).click();
  await page.locator('[data-question-status="resolved"]').waitFor();
  record(`${mode} questions: filtered continuation finds the later answer`,
    JSON.stringify(await cardIds(page)) === JSON.stringify([questions[8]]));
  await page.setViewportSize({ width: 390, height: 844 });
  record(`${mode} scientific collections: exact answering work fits the mobile viewport`,
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${agora.origin}/p/${problemId}`, { waitUntil: "load" });
  for (const [label, path] of [
    ["Inspect disagreements at this ledger snapshot", `/p/${problemId}/conflicts?through=`],
    ["Read research questions at this ledger snapshot", `/p/${problemId}/questions?through=`],
  ]) {
    record(`${mode} scientific collections: problem digest exposes ${label.toLowerCase()}`,
      (await page.getByRole("link", { name: label, exact: true }).getAttribute("href"))?.startsWith(path) === true);
  }
}

export async function scientificCollectionsWithdrawal({ target, browser, agora, fixture, record, diagnose }) {
  const { problemId, conflicts, questions, cursor, sourceEvents } = fixture;
  const controls = await target.worker.getExport();
  for (const eventId of sourceEvents) await controls.redactPublicContent(eventId);
  for (const path of [
    conflictsListPath(problemId, "json", { through: cursor, target: conflicts[8] }),
    questionsListPath(problemId, "json", { through: cursor, target: questions[8] }),
  ]) {
    const source = await fetch(`${target.origin}${path}`, { headers: { "user-agent": USER_AGENT } });
    assert.equal(source.status, 404, "a currently withdrawn exact source is not publicly readable");
  }
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    const mode = javaScriptEnabled ? "js" : "no-js";
    const readableNotFound = async (response) => response?.status() === 404 &&
      await page.locator("main").count() === 1 &&
      await page.getByRole("heading", { name: "Nothing is served at this address", level: 1, exact: true }).count() === 1 &&
      await page.locator("html").getAttribute("lang") === "en" &&
      await page.locator("script[nonce]").count() > 0 &&
      await page.locator('meta[name="robots"]').evaluateAll(nodes => nodes.some(node =>
        /\bnoindex\b/.test(node.getAttribute("content") ?? "")));
    let response;
    let collection = "conflicts";
    try {
      response = await page.goto(`${agora.origin}${conflictsListPath(problemId, "human", { through: cursor, target: conflicts[8] })}`, { waitUntil: "load" });
      record(`${mode} conflicts: unavailable source retains readable HTML 404, noindex and root chrome`,
        await readableNotFound(response));
      record(`${mode} conflicts: a withdrawn source cannot reappear at an earlier snapshot`,
        await page.locator("main .claim-card").count() === 0 &&
          !(await page.locator("main").innerText()).includes("Comparison 9 isolates"));
      collection = "questions";
      response = await page.goto(`${agora.origin}${questionsListPath(problemId, "human", { through: cursor, target: questions[8] })}`, { waitUntil: "load" });
      record(`${mode} questions: unavailable source retains readable HTML 404, noindex and root chrome`,
        await readableNotFound(response));
      record(`${mode} questions: a withdrawn exact source cannot substitute another question`,
        await page.locator("main .claim-card").count() === 0 &&
          !(await page.locator("main").innerText()).includes("Research question 9."));
    } catch (error) {
      console.log(JSON.stringify({
        kind: "scientific-collection-withdrawal-failure", mode, collection,
        status: response?.status() ?? null,
        observation: await diagnose(page, "main"),
      }));
      throw error;
    } finally {
      await context.close();
    }
  }
}
