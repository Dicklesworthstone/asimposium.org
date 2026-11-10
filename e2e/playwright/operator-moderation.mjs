import assert from "node:assert/strict";
import { enrollSetupFellow, fellowPost } from "../gauntlet/local-product-flow.mjs";
import { USER_AGENT } from "../gauntlet/local-target.mjs";

export const ADMIN_OPERATORS = ["usr_agora_moderator", "usr_agora_other_moderator"];

/** Actual Next forms and signed Worker requests, with genuine local D1/R2. */
export async function operatorModerationJourney({
  browser, agora, target, problemId, record, privateToCaches, authSecret, sessionCookie, encode,
}) {
  const fixtures = await target.worker.getExport();
  const operator = ADMIN_OPERATORS[0];
  const signedInAs = async (context, sub, authTime = Math.floor(Date.now() / 1000)) => {
    await context.clearCookies();
    await context.addCookies([{
      name: sessionCookie,
      value: await encode({ token: { sub, name: "Local moderation operator", authTime }, secret: authSecret, salt: sessionCookie }),
      url: agora.origin, httpOnly: true, sameSite: "Lax",
    }]);
  };
  const auditCount = async (id) => (await target.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM operator_audit WHERE target_id = ?",
  ).bind(id).first()).n;
  const auditReceipt = async (id, action) => target.env.DB.prepare(
    "SELECT event_id FROM operator_audit WHERE target_id = ? AND action = ? ORDER BY created_at DESC, event_id DESC LIMIT 1",
  ).bind(id, action).first();
  const publicStatus = async (claim) => (await fetch(
    `${target.origin}/p/${problemId}/claims/${claim}.json`, { headers: { "user-agent": USER_AGENT } },
  )).status;

  for (const javaScriptEnabled of [true, false]) {
    const mode = javaScriptEnabled ? "js" : "no-js";
    const author = await enrollSetupFellow(target, `usr_moderation_browser_${mode.replaceAll("-", "_")}`, `moderation-browser-${mode}`, ["promote"]);
    const opened = await fellowPost(target, "/v1/sessions", { problem_id: problemId, intent: "prove" }, author.token);
    assert.equal(opened.status, 201, "moderation browser session");
    const path = `/v1/sessions/${opened.body.session_id}`;
    const draft = await fellowPost(target, `${path}/workshop`, { type: "claim-draft", title: "Moderation browser work", body_md: "A private deliberate work product." }, author.token);
    assert.equal(draft.status, 201, "moderation browser draft");
    const published = await fellowPost(target, `${path}/promote`, {
      workshop_id: draft.body.workshop_id, kind: "conjecture",
      statement: javaScriptEnabled ? "The sum of the integers one and two is three." : "The sum of the integers two and three is five.",
      falsifier: "A direct integer calculation that contradicts this equality.",
    }, author.token);
    assert.equal(published.status, 201, `moderation browser public claim: ${published.body.code ?? "unclassified"}`);
    const claim = published.body.claim_id;
    const targetId = `${problemId}/${claim}`;
    const heldDraft = await fellowPost(target, `${path}/workshop`, {
      type: "claim-draft", title: "Work awaiting screening review", body_md: "A private arithmetic candidate.",
    }, author.token);
    assert.equal(heldDraft.status, 201, "moderation browser held draft");
    await fixtures.setScreenMode("quarantine");
    let held;
    try {
      held = await fellowPost(target, `${path}/promote`, {
        workshop_id: heldDraft.body.workshop_id, kind: "conjecture",
        statement: javaScriptEnabled ? "The product of integers two and three is six." : "The product of integers three and four is twelve.",
        falsifier: "An integer calculation contradicting the multiplication.",
      }, author.token);
    } finally { await fixtures.setScreenMode("pass"); }
    assert.equal(held.status, 202, "moderation browser screening hold");
    const report = await fellowPost(target, "/v1/reports", { problem_id: problemId, target: claim, reason: "spam" }, author.token);
    assert.equal(report.status, 201, "moderation browser report");

    const context = await browser.newContext({ javaScriptEnabled });
    try {
      await signedInAs(context, operator);
      const page = await context.newPage();
      const response = await page.goto(`${agora.origin}/admin`, { waitUntil: "load" });
      record(`admin ${mode}: operator page is private and shows a real held case`,
        response?.status() === 200 && privateToCaches(response.headers()) && (await page.content()).includes(held.body.case_id));
      await page.locator("#admin-quarantine-target").selectOption(held.body.case_id);
      await page.locator("#admin-quarantine-decision").selectOption("release");
      await page.locator("#admin-quarantine-reason").fill("Reviewed the ordinary arithmetic and exact held context.");
      await page.locator("#admin-quarantine-confirm").check();
      await page.locator("#admin-quarantine-target").locator("xpath=ancestor::form").getByRole("button", { name: "Record decision", exact: true }).click();
      await page.getByText("Release recorded.", { exact: false }).waitFor({ state: "visible" });
      const release = await auditReceipt(held.body.case_id, "quarantine.release");
      record(`admin ${mode}: a decided case retains its real receipt after leaving the queue`,
        release !== null && (await page.locator(".admin-action-result").allTextContents()).join(" ").includes(release.event_id) && await auditCount(held.body.case_id) === 1);

      await page.goto(`${agora.origin}/admin`, { waitUntil: "load" });
      await page.locator(`a[href="/admin/reports/${encodeURIComponent(report.body.report_id)}"]`).click();
      await page.getByRole("heading", { name: "Review a report", level: 1, exact: true }).waitFor();
      await page.locator("#admin-report-target").selectOption(report.body.report_id);
      await page.locator("#admin-report-decision").selectOption("dismiss");
      await page.locator("#admin-report-reason").fill("The reviewed arithmetic claim is not spam.");
      await page.locator("#admin-report-confirm").check();
      await page.locator("#admin-report-target").locator("xpath=ancestor::form").getByRole("button", { name: "Record decision", exact: true }).click();
      await page.getByText("Report dismissal recorded.", { exact: false }).waitFor({ state: "visible" });
      const dismissed = await auditReceipt(report.body.report_id, "report.dismiss");
      record(`admin ${mode}: report resolution displays its persisted audit receipt`,
        dismissed !== null && (await page.locator(".admin-action-result").allTextContents()).join(" ").includes(dismissed.event_id));

      await page.goto(`${agora.origin}/admin`, { waitUntil: "load" });
      await page.locator("#admin-content-target").fill(targetId);
      await page.locator("#admin-content-kind").selectOption("claim");
      await page.locator("#admin-content-reason").fill("Temporary visibility hold after reviewing this exact claim.");
      await page.locator("#admin-content-confirm").check();
      const contentForm = page.locator("#admin-content-target").locator("xpath=ancestor::form");
      const originalKey = await contentForm.locator('[name="idempotency_key"]').inputValue();
      const before = await auditCount(targetId);
      // A real D1 failure, not an intercepted response: no decision or receipt
      // can commit. Restoring the store lets the exact browser draft replay.
      await target.env.DB.prepare(`CREATE TRIGGER lane_admin_receipt_failure BEFORE INSERT ON operator_command_receipts
        BEGIN SELECT RAISE(ABORT, 'native admin receipt fault'); END`).run();
      try {
        await contentForm.getByRole("button", { name: "Record decision", exact: true }).click();
        await page.getByRole("button", { name: "Retry the exact pending decision", exact: true }).waitFor({ state: "visible" });
        record(`admin ${mode}: unavailable write keeps its exact key and commits no audit`,
          await contentForm.locator('[name="idempotency_key"]').inputValue() === originalKey && await auditCount(targetId) === before && await publicStatus(claim) === 200);
      } finally { await target.env.DB.prepare("DROP TRIGGER lane_admin_receipt_failure").run(); }
      await page.getByRole("button", { name: "Retry the exact pending decision", exact: true }).click();
      await page.getByText("Content hide recorded.", { exact: false }).waitFor({ state: "visible" });
      record(`admin ${mode}: exact retry records one hide and changes the real public face`,
        await auditCount(targetId) === before + 1 && await publicStatus(claim) === 403);

      await page.goto(`${agora.origin}/admin`, { waitUntil: "load" });
      await page.locator("#admin-content-target").fill(targetId);
      await page.locator("#admin-content-kind").selectOption("claim");
      await page.locator("#admin-content-action").selectOption("restore");
      await page.locator("#admin-content-reason").fill("Review is complete; lift this operator's visibility hold.");
      await page.locator("#admin-content-confirm").check();
      await signedInAs(context, ADMIN_OPERATORS[1]);
      await contentForm.getByRole("button", { name: "Record decision", exact: true }).click();
      await page.getByText("Re-authenticate as the same operator", { exact: false }).waitFor({ state: "visible" });
      record(`admin ${mode}: account switching cannot submit a former operator's decision`,
        await auditCount(targetId) === before + 1 && await publicStatus(claim) === 403);
      await signedInAs(context, operator);
      await page.goto(`${agora.origin}/admin`, { waitUntil: "load" });
      await page.locator("#admin-content-target").fill(targetId);
      await page.locator("#admin-content-kind").selectOption("claim");
      await page.locator("#admin-content-action").selectOption("restore");
      await page.locator("#admin-content-reason").fill("Review is complete; lift this operator's visibility hold.");
      await page.locator("#admin-content-confirm").check();
      await contentForm.getByRole("button", { name: "Record decision", exact: true }).click();
      await page.getByText("Content restore recorded.", { exact: false }).waitFor({ state: "visible" });
      record(`admin ${mode}: explicit restore recovers the public claim without changing science`,
        await auditCount(targetId) === before + 2 && await publicStatus(claim) === 200);

      await signedInAs(context, "usr_non_operator_moderation_browser");
      await page.goto(`${agora.origin}/admin`, { waitUntil: "load" });
      record(`admin ${mode}: a sponsor cannot read operator cases or use controls`,
        (await page.getByText("403 Forbidden: Unauthorized Principal", { exact: true }).isVisible()) &&
        !(await page.content()).includes(held.body.case_id) && await page.locator("#admin-content-target").count() === 0);
    } finally { await context.close(); }
  }
}
