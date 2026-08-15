import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { DEVICE_USER_CODE_PATTERN, DeviceCodeStartRequestSchema } from "@asimposium/contracts";
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  chromium,
} from "@playwright/test";

const SUITE = "device-enrollment-browser";
const MAX_INPUT_BYTES = 4_096;
const MAX_STORAGE_STATE_BYTES = 1_048_576;
const TIMEOUT_MS = 20_000;

type DecisionMode = "approve" | "deny" | "lookup-rejected" | "reduce";

interface BrowserInput {
  readonly userCode: string;
  readonly name: string;
  readonly model: string;
  readonly harness: string;
  readonly requestedScopes: readonly string[];
}

interface BrowserObservation {
  consoleErrors: number;
  pageErrors: number;
}

interface SafeRecord {
  readonly ts: string;
  readonly tool: "playwright";
  readonly package: "e2e";
  readonly suite: typeof SUITE;
  readonly scenario: DecisionMode | "configuration" | "self-test" | "sponsor-preflight";
  readonly status: "blocked" | "fail" | "pass";
  readonly code: string;
  readonly duration_ms: number;
  readonly request_id: null;
  readonly event_id: null;
  // A user code has only 30^8 possibilities. Even a truncated deterministic
  // digest makes that code cheaply recoverable, so this field must stay null.
  readonly device_digest: null;
  readonly proposal_digest: string | null;
  readonly flow_digest: null;
  readonly console_error_count: number;
  readonly page_error_count: number;
  readonly screenshot_policy: "disabled";
  readonly trace_policy: "disabled";
}

class BrowserRunError extends Error {
  constructor(
    readonly code: string,
    readonly exitCode: 1 | 78,
    readonly consoleErrorCount = 0,
    readonly pageErrorCount = 0,
  ) {
    super(code);
  }
}

function durationMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function digestPrefix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function emit(record: SafeRecord): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function timestamp(): string {
  return new Date().toISOString();
}

function requiredMode(): DecisionMode {
  const mode = Bun.argv[2];
  if (mode === "approve" || mode === "deny" || mode === "lookup-rejected" || mode === "reduce") {
    return mode;
  }
  throw new BrowserRunError("BROWSER_MODE_INVALID", 1);
}

function requiredAgoraOrigin(): string {
  const value = process.env.ASIMPOSIUM_STAGING_AGORA_BASE_URL;
  if (value === undefined) throw new BrowserRunError("STAGING_AGORA_BASE_URL_MISSING", 78);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserRunError("STAGING_AGORA_BASE_URL_INVALID", 78);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const productionHostnames = new Set([
    "a.asimposium.org",
    "artifacts.asimposium.org",
    "asimposium.org",
    "www.asimposium.org",
  ]);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    productionHostnames.has(hostname)
  ) {
    throw new BrowserRunError("STAGING_AGORA_BASE_URL_INVALID", 78);
  }
  return parsed.origin;
}

function storageState(
  variableName:
    | "ASIMPOSIUM_DEVICE_E2E_SECOND_STORAGE_STATE"
    | "ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE",
): NonNullable<BrowserContextOptions["storageState"]> {
  const missingCode =
    variableName === "ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE"
      ? "SPONSOR_STORAGE_STATE_MISSING"
      : "SECOND_SPONSOR_STORAGE_STATE_MISSING";
  const invalidCode =
    variableName === "ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE"
      ? "SPONSOR_STORAGE_STATE_INVALID"
      : "SECOND_SPONSOR_STORAGE_STATE_INVALID";
  const path = process.env[variableName];
  if (path === undefined || path === "") {
    throw new BrowserRunError(missingCode, 78);
  }
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size <= 0 ||
      stat.size > MAX_STORAGE_STATE_BYTES ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new BrowserRunError(invalidCode, 78);
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !("cookies" in parsed) ||
      !("origins" in parsed) ||
      !Array.isArray(parsed.cookies) ||
      !Array.isArray(parsed.origins)
    ) {
      throw new BrowserRunError(invalidCode, 78);
    }
    return parsed as NonNullable<BrowserContextOptions["storageState"]>;
  } catch (error) {
    if (error instanceof BrowserRunError) throw error;
    throw new BrowserRunError(invalidCode, 78);
  }
}

async function sponsorAccountIdentity(
  context: BrowserContext,
  agoraOrigin: string,
): Promise<string> {
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  try {
    const response = await page.goto(`${agoraOrigin}/console`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT_MS,
    });
    if (response === null || response.status() < 200 || response.status() >= 300) {
      throw new BrowserRunError("SPONSOR_IDENTITY_PREFLIGHT_UNAVAILABLE", 78);
    }
    if (await page.getByRole("heading", { name: "Sign in required" }).isVisible()) {
      throw new BrowserRunError("SPONSOR_SESSION_NOT_AUTHENTICATED", 78);
    }
    const account = page.locator('section[aria-labelledby="account-title"]');
    await account.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    const labels = (await account.locator("dt").allTextContents()).map((label) => label.trim());
    const emailIndex = labels.indexOf("Email");
    const values = account.locator("dd");
    if (emailIndex < 0 || (await values.count()) <= emailIndex) {
      throw new BrowserRunError("SPONSOR_IDENTITY_PREFLIGHT_UNAVAILABLE", 78);
    }
    const email = (await values.nth(emailIndex).innerText()).trim().toLowerCase();
    if (!email.includes("@") || email.length > 320) {
      throw new BrowserRunError("SPONSOR_IDENTITY_PREFLIGHT_UNAVAILABLE", 78);
    }
    return email;
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function assertDistinctSponsorSessions(
  browser: Browser,
  agoraOrigin: string,
  primaryState: NonNullable<BrowserContextOptions["storageState"]>,
  secondState: NonNullable<BrowserContextOptions["storageState"]>,
): Promise<void> {
  const primary = await browser.newContext({ storageState: primaryState });
  const second = await browser.newContext({ storageState: secondState });
  try {
    const [primaryIdentity, secondIdentity] = await Promise.all([
      sponsorAccountIdentity(primary, agoraOrigin),
      sponsorAccountIdentity(second, agoraOrigin),
    ]);
    if (primaryIdentity === secondIdentity) {
      throw new BrowserRunError("SECOND_SPONSOR_SESSION_NOT_DISTINCT", 78);
    }
  } finally {
    await Promise.all([
      primary.close().catch(() => undefined),
      second.close().catch(() => undefined),
    ]);
  }
}

async function browserInput(): Promise<BrowserInput> {
  const text = await Bun.stdin.text();
  if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
    throw new BrowserRunError("BROWSER_INPUT_INVALID", 1);
  }
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length !== 5) throw new BrowserRunError("BROWSER_INPUT_INVALID", 1);
  const [userCode, name, model, harness, scopesText] = lines;
  if (
    userCode === undefined ||
    name === undefined ||
    model === undefined ||
    harness === undefined ||
    scopesText === undefined ||
    !DEVICE_USER_CODE_PATTERN.test(userCode)
  ) {
    throw new BrowserRunError("BROWSER_INPUT_INVALID", 1);
  }
  const requestedScopes = scopesText.split(",");
  const proposal = DeviceCodeStartRequestSchema.safeParse({
    name,
    model,
    harness,
    requested_scopes: requestedScopes,
  });
  if (!proposal.success) throw new BrowserRunError("BROWSER_INPUT_INVALID", 1);
  return { userCode, name, model, harness, requestedScopes };
}

function isBrowserExecutableFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /executable.*(?:doesn.t exist|missing)|browser.*not.*found|install.*chromium/i.test(
    error.message,
  );
}

async function assertCompleteCard(
  context: BrowserContext,
  agoraOrigin: string,
  input: BrowserInput,
  mode: DecisionMode,
  observation: BrowserObservation,
): Promise<{
  readonly proposalDigest: string | null;
}> {
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  page.on("console", (message) => {
    if (message.type() === "error") observation.consoleErrors += 1;
  });
  page.on("pageerror", () => {
    observation.pageErrors += 1;
  });

  const response = await page.goto(`${agoraOrigin}/approve`, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT_MS,
  });
  if (response === null || response.status() < 200 || response.status() >= 300) {
    throw new BrowserRunError("AGORA_APPROVE_SURFACE_UNAVAILABLE", 78);
  }
  if (await page.getByRole("heading", { name: "Sign in required" }).isVisible()) {
    throw new BrowserRunError("SPONSOR_SESSION_NOT_AUTHENTICATED", 78);
  }
  if (!(await page.getByRole("heading", { name: "Enter the code" }).isVisible())) {
    throw new BrowserRunError("AGORA_APPROVE_SURFACE_UNAVAILABLE", 78);
  }

  const codeInput = page.getByLabel("The code your agent shows, like ABCD-2345");
  await codeInput.fill(input.userCode.toLowerCase().replace("-", ""));
  if ((await codeInput.inputValue()) !== input.userCode) {
    throw new BrowserRunError("DEVICE_CODE_INPUT_MISMATCH", 1);
  }
  await page.getByRole("button", { name: "Find the proposal" }).click();

  if (mode === "lookup-rejected") {
    const alert = page.getByRole("alert").first();
    await alert.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    if ((await alert.innerText()).trim() !== "No pending proposal for that code") {
      throw new BrowserRunError("DEVICE_LOOKUP_WRONG_REFUSAL", 1);
    }
    if ((await page.getByRole("list", { name: "Device proposal" }).count()) !== 0) {
      throw new BrowserRunError("REJECTED_LOOKUP_EXPOSED_PROPOSAL", 1);
    }
    if (observation.consoleErrors > 0 || observation.pageErrors > 0) {
      throw new BrowserRunError("BROWSER_RUNTIME_ERRORS_OBSERVED", 1);
    }
    return {
      proposalDigest: null,
    };
  }

  const card = page.getByRole("list", { name: "Device proposal" }).getByRole("listitem");
  await card.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  if ((await card.count()) !== 1) throw new BrowserRunError("PROPOSAL_CARD_COUNT_INVALID", 1);
  const cardText = await card.innerText();
  for (const expected of [
    input.name,
    input.model,
    input.harness,
    input.requestedScopes.join(", "),
  ]) {
    if (!cardText.includes(expected)) throw new BrowserRunError("PROPOSAL_CARD_INCOMPLETE", 1);
  }
  const controls = await card
    .getByRole("button", { name: "Reduce…" })
    .getAttribute("aria-controls");
  if (controls === null || !controls.startsWith("reduce-") || controls.length <= "reduce-".length) {
    throw new BrowserRunError("PROPOSAL_CARD_ID_MISSING", 1);
  }
  const proposalDigest = digestPrefix(controls.slice("reduce-".length));

  if (mode === "approve" || mode === "deny") {
    await card.getByRole("button", { name: mode === "approve" ? "Approve" : "Deny" }).click();
    await card.getByRole("button", { name: `Yes, ${mode}` }).click();
  } else {
    if (!input.requestedScopes.includes("promote") || input.requestedScopes.length < 2) {
      throw new BrowserRunError("REDUCTION_FIXTURE_INVALID", 1);
    }
    await card.getByRole("button", { name: "Reduce…" }).click();
    const promote = card.getByLabel("promote", { exact: true });
    if (!(await promote.isChecked())) throw new BrowserRunError("REDUCTION_SCOPE_STATE_INVALID", 1);
    await promote.uncheck();
    await card.getByRole("button", { name: "Approve with these reductions" }).click();
  }

  const decision = page.getByText("Decision recorded", { exact: true }).last();
  try {
    await decision.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  } catch {
    if (
      await page
        .getByRole("alert")
        .filter({ hasText: "Decisions need a Google sign-in" })
        .first()
        .isVisible()
    ) {
      throw new BrowserRunError("SPONSOR_RECENT_AUTH_REQUIRED", 78);
    }
    throw new BrowserRunError("SPONSOR_DECISION_NOT_RECORDED", 1);
  }
  const outcomeCopy =
    mode === "deny"
      ? "Decision recorded. The agent’s next poll receives the denial; no Fellow or credential was created."
      : "Decision recorded. The agent’s next poll completes its enrollment; it appears under Your Fellows on the console.";
  await page
    .getByText(outcomeCopy, { exact: true })
    .waitFor({ state: "visible", timeout: TIMEOUT_MS });
  if (observation.consoleErrors > 0 || observation.pageErrors > 0) {
    throw new BrowserRunError("BROWSER_RUNTIME_ERRORS_OBSERVED", 1);
  }
  return {
    proposalDigest,
  };
}

async function run(): Promise<void> {
  const startedAt = performance.now();
  if (Bun.argv[2] === "--self-test-runtime-error") {
    throw new BrowserRunError("BROWSER_RUNTIME_ERRORS_OBSERVED", 1, 1, 2);
  }
  if (Bun.argv[2] === "--self-test") {
    const secretCanary = `flow_v1.${"A".repeat(43)}`;
    const record: SafeRecord = {
      ts: timestamp(),
      tool: "playwright",
      package: "e2e",
      suite: SUITE,
      scenario: "self-test",
      status: "pass",
      code: "BROWSER_RUNNER_SELF_TEST_OK",
      duration_ms: durationMs(startedAt),
      request_id: null,
      event_id: null,
      device_digest: null,
      proposal_digest: digestPrefix(secretCanary),
      flow_digest: null,
      console_error_count: 0,
      page_error_count: 0,
      screenshot_policy: "disabled",
      trace_policy: "disabled",
    };
    const rendered = JSON.stringify(record);
    if (
      rendered.includes(secretCanary) ||
      rendered.includes("asimp_ag_") ||
      rendered.includes("#v1.")
    ) {
      throw new BrowserRunError("BROWSER_RUNNER_SELF_TEST_FAILED", 1);
    }
    emit(record);
    return;
  }

  const suppliedMode = Bun.argv[2];
  const mode = suppliedMode === "assert-distinct-sponsors" ? undefined : requiredMode();
  const input = mode === undefined ? undefined : await browserInput();
  const state = storageState("ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE");
  const agoraOrigin = requiredAgoraOrigin();
  let browser: Browser | undefined;
  const observation: BrowserObservation = { consoleErrors: 0, pageErrors: 0 };
  try {
    browser = await chromium.launch({
      headless: process.env.ASIMPOSIUM_DEVICE_E2E_HEADED !== "1",
    });
    if (mode === undefined) {
      await assertDistinctSponsorSessions(
        browser,
        agoraOrigin,
        state,
        storageState("ASIMPOSIUM_DEVICE_E2E_SECOND_STORAGE_STATE"),
      );
      emit({
        ts: timestamp(),
        tool: "playwright",
        package: "e2e",
        suite: SUITE,
        scenario: "sponsor-preflight",
        status: "pass",
        code: "DISTINCT_SPONSOR_SESSIONS_VERIFIED",
        duration_ms: durationMs(startedAt),
        request_id: null,
        event_id: null,
        device_digest: null,
        proposal_digest: null,
        flow_digest: null,
        console_error_count: 0,
        page_error_count: 0,
        screenshot_policy: "disabled",
        trace_policy: "disabled",
      });
      return;
    }
    if (input === undefined) throw new BrowserRunError("BROWSER_INPUT_INVALID", 1);
    const context = await browser.newContext({
      storageState: state,
      viewport: { width: 1440, height: 1_000 },
    });
    try {
      const result = await assertCompleteCard(context, agoraOrigin, input, mode, observation);
      emit({
        ts: timestamp(),
        tool: "playwright",
        package: "e2e",
        suite: SUITE,
        scenario: mode,
        status: "pass",
        code:
          mode === "lookup-rejected" ? "DEVICE_LOOKUP_REJECTED" : "DEVICE_DECISION_UI_CONFIRMED",
        duration_ms: durationMs(startedAt),
        request_id: null,
        event_id: null,
        device_digest: null,
        proposal_digest: result.proposalDigest,
        flow_digest: null,
        console_error_count: observation.consoleErrors,
        page_error_count: observation.pageErrors,
        screenshot_policy: "disabled",
        trace_policy: "disabled",
      });
    } finally {
      await context.close().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof BrowserRunError) {
      throw new BrowserRunError(
        error.code,
        error.exitCode,
        Math.max(error.consoleErrorCount, observation.consoleErrors),
        Math.max(error.pageErrorCount, observation.pageErrors),
      );
    }
    if (isBrowserExecutableFailure(error)) {
      throw new BrowserRunError(
        "BROWSER_RUNTIME_UNAVAILABLE",
        78,
        observation.consoleErrors,
        observation.pageErrors,
      );
    }
    throw new BrowserRunError(
      "BROWSER_DEVICE_FLOW_FAILED",
      1,
      observation.consoleErrors,
      observation.pageErrors,
    );
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

const processStartedAt = performance.now();
try {
  await run();
} catch (error) {
  const failure =
    error instanceof BrowserRunError ? error : new BrowserRunError("BROWSER_RUNNER_FAILED", 1);
  const suppliedMode = Bun.argv[2];
  const safeScenario: SafeRecord["scenario"] =
    suppliedMode === "approve" ||
    suppliedMode === "deny" ||
    suppliedMode === "lookup-rejected" ||
    suppliedMode === "reduce" ||
    suppliedMode === "assert-distinct-sponsors" ||
    suppliedMode === "--self-test" ||
    suppliedMode === "--self-test-runtime-error"
      ? suppliedMode === "--self-test"
        ? "self-test"
        : suppliedMode === "--self-test-runtime-error"
          ? "self-test"
          : suppliedMode === "assert-distinct-sponsors"
            ? "sponsor-preflight"
            : suppliedMode
      : "configuration";
  emit({
    ts: timestamp(),
    tool: "playwright",
    package: "e2e",
    suite: SUITE,
    scenario: safeScenario,
    status: failure.exitCode === 78 ? "blocked" : "fail",
    code: failure.code,
    duration_ms: durationMs(processStartedAt),
    request_id: null,
    event_id: null,
    device_digest: null,
    proposal_digest: null,
    flow_digest: null,
    console_error_count: failure.consoleErrorCount,
    page_error_count: failure.pageErrorCount,
    screenshot_policy: "disabled",
    trace_policy: "disabled",
  });
  process.exit(failure.exitCode);
}
