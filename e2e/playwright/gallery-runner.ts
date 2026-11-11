import {
  EnrollmentApprovedResponseSchema,
  EnrollmentClaimResponseSchema,
  EnrollmentHelloResponseSchema,
  PackResponseSchema,
  ProblemIdSchema,
  parseStoaJoinUrl,
  SessionCloseResponseSchema,
  SessionOpenResponseSchema,
  WorkshopPushResponseSchema,
} from "@asimposium/contracts";
import type { Browser, Page } from "@playwright/test";

const USER_AGENT = "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)";
const ACTION_TIMEOUT_MS = 20_000;

class GalleryFailure extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, exitCode = 1) {
    super(code);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function requireStep(condition: unknown, code: string): asserts condition {
  if (!condition) throw new GalleryFailure(code);
}

interface GalleryJourney {
  sponsorPage: Page;
  otherSponsorPage: Page;
  anonymousPage: Page;
  agoraOrigin: string;
  workerOrigin: string;
  problemId: string;
  runId: string;
  signal?: AbortSignal;
}

interface ResponseContract<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** Shared by the hosted Google entrypoint and the real local browser lane. */
export async function runGalleryJourney(input: GalleryJourney): Promise<readonly string[]> {
  try {
    return await galleryJourney(input);
  } catch (error) {
    if (error instanceof GalleryFailure) throw error;
    throw new GalleryFailure("GALLERY_PRODUCT_STEP_FAILED");
  }
}

async function galleryJourney(input: GalleryJourney): Promise<readonly string[]> {
  const { sponsorPage, otherSponsorPage, anonymousPage, agoraOrigin, workerOrigin, problemId } =
    input;
  const steps: string[] = [];
  const runId = input.runId;
  requireStep(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId), "GALLERY_RUN_ID_INVALID");
  requireStep(ProblemIdSchema.safeParse(problemId).success, "GALLERY_PROBLEM_INVALID");
  requireStep(
    (await anonymousPage.context().cookies()).length === 0,
    "GALLERY_ANONYMOUS_CONTEXT_NOT_CLEAN",
  );
  await otherSponsorPage.goto(`${agoraOrigin}/console`, { waitUntil: "load" });
  await otherSponsorPage.getByRole("button", { name: "Mint a join URL", exact: true }).waitFor({
    state: "visible",
  });

  async function request<T>(
    path: string,
    schema: ResponseContract<T>,
    expectedStatus: number,
    body?: unknown,
    token?: string,
    cleanup = false,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(cleanup ? 5_000 : ACTION_TIMEOUT_MS);
    const signal = !cleanup && input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const response = await fetch(new URL(path, workerOrigin), {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal,
      headers: {
        "User-Agent": USER_AGENT,
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "Idempotency-Key": `gallery-${runId}-${path.replaceAll("/", "-")}`,
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    requireStep(response.status === expectedStatus, "GALLERY_WORKER_STATUS_INVALID");
    const decoded = schema.safeParse(await response.json());
    requireStep(decoded.success, "GALLERY_WORKER_CONTRACT_INVALID");
    return decoded.data;
  }

  await sponsorPage.goto(`${agoraOrigin}/console`, { waitUntil: "load" });
  await sponsorPage.getByLabel("Problem assignment", { exact: true }).fill(problemId);
  const receipt = sponsorPage.locator("pre.pasteblock.join-url");
  requireStep((await receipt.count()) === 0, "GALLERY_JOIN_RECEIPT_PREEXISTED");
  await sponsorPage.getByRole("button", { name: "Mint a join URL", exact: true }).click();
  await receipt.waitFor({ state: "visible" });
  requireStep((await receipt.count()) === 1, "GALLERY_JOIN_RECEIPT_AMBIGUOUS");
  const joinUrl = await receipt.evaluate((element) => {
    const prefix = "Your join URL is  ";
    const candidates = (element.textContent ?? "")
      .split("\n")
      .filter((line: string) => line.startsWith(prefix));
    return candidates.length === 1 ? candidates[0]?.slice(prefix.length) : undefined;
  });
  const invitation = typeof joinUrl === "string" ? parseStoaJoinUrl(joinUrl) : undefined;
  requireStep(
    invitation !== undefined && invitation.origin === workerOrigin,
    "GALLERY_JOIN_RECEIPT_INVALID",
  );
  steps.push("sponsor-minted-invitation");

  const name = `gallery-${invitation.enrollmentId.slice(-16).toLowerCase()}`;
  const claim = await request("/v1/fellows", EnrollmentClaimResponseSchema, 202, {
    enrollment_id: invitation.enrollmentId,
    secret: invitation.secret,
    name,
    model: "synthetic-gallery-model",
    harness: "gallery-smoke",
  });
  steps.push("fellow-proposed");
  await sponsorPage.reload({ waitUntil: "load" });
  const proposal = sponsorPage.locator("li.proposal").filter({ hasText: name });
  await proposal.getByRole("button", { name: "Approve", exact: true }).waitFor();
  requireStep((await proposal.count()) === 1, "GALLERY_PROPOSAL_AMBIGUOUS");
  await proposal.getByRole("button", { name: "Approve", exact: true }).click();
  await proposal.getByRole("button", { name: "Yes, approve", exact: true }).click();
  await proposal.waitFor({ state: "detached" });
  const issued = await request("/v1/fellows/flow", EnrollmentApprovedResponseSchema, 200, {
    flow_handle: claim.flow_handle,
  });
  steps.push("sponsor-approved");
  const token = issued.token;
  const hello = await request("/v1/hello", EnrollmentHelloResponseSchema, 200, undefined, token);
  requireStep(
    hello.fellow.name === name && hello.granted_resources.problem_binding === problemId,
    "GALLERY_GRANT_INVALID",
  );
  const session = await request(
    "/v1/sessions",
    SessionOpenResponseSchema,
    201,
    { problem_id: problemId, intent: "explore" },
    token,
  );
  steps.push("session-opened");
  const sessionPath = `/v1/sessions/${session.session_id}`;
  let visibilityVerified = false;
  try {
    const pack = await request(
      `${sessionPath}/pack?profile=working`,
      PackResponseSchema,
      200,
      undefined,
      token,
    );
    requireStep(Array.isArray(pack.omitted), "GALLERY_PACK_OMISSIONS_MISSING");
    steps.push("working-pack-read");
    const canary = `ASIMPOSIUM_PRIVATE_GALLERY_${runId}`;
    const draft = await request(
      `${sessionPath}/workshop`,
      WorkshopPushResponseSchema,
      201,
      { type: "scratch", title: "Gallery private draft", body_md: canary },
      token,
    );
    steps.push("workshop-pushed");
    const workshopPath = `/console/workshop/${hello.fellow.fellow_id}/${problemId}`;
    const privateResponse = await sponsorPage.goto(`${agoraOrigin}${workshopPath}`, {
      waitUntil: "load",
    });
    requireStep(privateResponse?.status() === 200, "GALLERY_SPONSOR_WORKSHOP_UNAVAILABLE");
    await sponsorPage.getByText(canary, { exact: true }).waitFor();
    const cache = privateResponse.headers()["cache-control"] ?? "";
    requireStep(
      /\bprivate\b/.test(cache) && /\bno-store\b/.test(cache) && !/\bpublic\b/.test(cache),
      "GALLERY_WORKSHOP_CACHE_INVALID",
    );
    steps.push("sponsor-sees-workshop");

    async function mustHide(page: Page, path: string, code: string, publicPage = false) {
      const response = await page.goto(`${agoraOrigin}${path}`, { waitUntil: "load" });
      requireStep(response !== null && response.status() < 500, "GALLERY_PAGE_UNAVAILABLE");
      if (publicPage) requireStep(response.status() === 200, "GALLERY_PUBLIC_PAGE_UNAVAILABLE");
      const html = await page.content();
      requireStep(!html.includes(canary) && !html.includes(draft.workshop_id), code);
    }
    await mustHide(anonymousPage, workshopPath, "GALLERY_ANONYMOUS_WORKSHOP_LEAK");
    await mustHide(otherSponsorPage, workshopPath, "GALLERY_OTHER_SPONSOR_WORKSHOP_LEAK");
    await mustHide(anonymousPage, `/p/${problemId}`, "GALLERY_PUBLIC_WORKSHOP_LEAK", true);
    for (const suffix of ["json", "md"]) {
      const response = await fetch(`${workerOrigin}/p/${problemId}.${suffix}`, {
        redirect: "error",
        signal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(ACTION_TIMEOUT_MS)])
          : AbortSignal.timeout(ACTION_TIMEOUT_MS),
        headers: { "User-Agent": USER_AGENT },
      });
      requireStep(response.status === 200, "GALLERY_PUBLIC_FACE_UNAVAILABLE");
      const text = await response.text();
      requireStep(
        !text.includes(canary) && !text.includes(draft.workshop_id),
        "GALLERY_PUBLIC_FACE_WORKSHOP_LEAK",
      );
    }
    steps.push("anonymous-and-other-sponsor-excluded", "public-faces-exclude-workshop");
    visibilityVerified = true;
  } finally {
    await request(
      `${sessionPath}/close`,
      SessionCloseResponseSchema,
      201,
      {
        handback: visibilityVerified
          ? "Gallery smoke verified private workshop visibility."
          : "Gallery smoke stopped before completing its visibility checks.",
        promote: [],
      },
      token,
      true,
    );
    steps.push("session-closed");
  }
  return steps;
}

interface HostedInput {
  agoraOrigin: string;
  workerOrigin: string;
  problemId: string;
  runId: string;
  user: string;
  password: string;
  secondUser: string;
  secondPassword: string;
}

function parseHostedInput(text: string): HostedInput {
  requireStep(Buffer.byteLength(text) <= 16_384, "GALLERY_INPUT_TOO_LARGE");
  const input: unknown = JSON.parse(text);
  requireStep(
    input !== null && typeof input === "object" && !Array.isArray(input),
    "GALLERY_INPUT_INVALID",
  );
  const values = input as Record<string, unknown>;
  const limits = {
    agoraOrigin: 400,
    workerOrigin: 400,
    problemId: 80,
    runId: 80,
    user: 320,
    password: 4096,
    secondUser: 320,
    secondPassword: 4096,
  };
  requireStep(Object.keys(values).length === Object.keys(limits).length, "GALLERY_INPUT_INVALID");
  for (const [field, max] of Object.entries(limits)) {
    const value = values[field];
    requireStep(
      typeof value === "string" && value.length > 0 && value.length <= max,
      "GALLERY_INPUT_INVALID",
    );
  }
  requireStep(ProblemIdSchema.safeParse(values.problemId).success, "GALLERY_PROBLEM_INVALID");
  return values as unknown as HostedInput;
}

function hostedOrigin(value: string): boolean {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return (
    url.protocol === "https:" &&
    url.origin === value &&
    ![
      "asimposium.org",
      "www.asimposium.org",
      "a.asimposium.org",
      "artifacts.asimposium.org",
    ].includes(hostname)
  );
}

/** Own launch and close together so an expired launch cannot orphan its browser. */
export function galleryBrowserLifecycle(budgetMs: number) {
  let launching: Promise<{ close(): Promise<void> }> | undefined;
  let closing: Promise<void> | undefined;
  let expired = false;
  const abort = new AbortController();
  const closeOnce = (): Promise<void> => {
    closing ??= (async () => {
      const browser = await launching?.catch(() => undefined);
      if (browser !== undefined) await browser.close();
    })();
    return closing;
  };
  const deadline = setTimeout(() => {
    expired = true;
    abort.abort();
    void closeOnce().catch(() => undefined);
  }, budgetMs);
  return {
    signal: abort.signal,
    get expired() {
      return expired;
    },
    launch<T extends { close(): Promise<void> }>(start: () => Promise<T>): Promise<T> {
      requireStep(!expired && launching === undefined, "GALLERY_BROWSER_LAUNCH_INVALID");
      const pending = start();
      launching = pending;
      return pending;
    },
    async close(): Promise<void> {
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closeOnce(),
          new Promise<never>((_, reject) => {
            closeTimer = setTimeout(
              () => reject(new GalleryFailure("GALLERY_BROWSER_CLOSE_TIMED_OUT")),
              10_000,
            );
          }),
        ]);
      } finally {
        if (closeTimer !== undefined) clearTimeout(closeTimer);
        clearTimeout(deadline);
      }
    },
  };
}

async function googleSignIn(page: Page, origin: string, user: string, password: string) {
  const { isExactGoogleAccountsOrigin, performAtExactGoogleOwnerFrame } = await import(
    "./s6-cross-plane-runner.ts"
  );
  await page.goto(`${origin}/console`, { waitUntil: "load" });
  const signIn = page.getByRole("button", { name: /sign in with google/i });
  requireStep((await signIn.count()) === 1, "GALLERY_GOOGLE_SIGN_IN_CONTROL_MISSING");
  await signIn.click();
  try {
    await page.waitForURL((url) => isExactGoogleAccountsOrigin(url.href));
    const email = await page.locator('input[type="email"]').elementHandle();
    requireStep(email !== null, "GALLERY_GOOGLE_EMAIL_INPUT_MISSING");
    await performAtExactGoogleOwnerFrame(email, page.mainFrame(), () => email.fill(user));
    await page.getByRole("button", { name: /next/i }).click();
    await page.locator('input[type="password"]').waitFor({ state: "visible" });
    const passwordInput = await page.locator('input[type="password"]').elementHandle();
    requireStep(passwordInput !== null, "GALLERY_GOOGLE_PASSWORD_INPUT_MISSING");
    await performAtExactGoogleOwnerFrame(passwordInput, page.mainFrame(), () =>
      passwordInput.fill(password),
    );
    await page.getByRole("button", { name: /next/i }).click();
    await page.waitForURL(`${origin}/console`);
  } catch {
    throw new GalleryFailure("GALLERY_GOOGLE_SIGN_IN_BLOCKED", 78);
  }
}

async function main() {
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;
  const started = Date.now();
  let browser: Browser | undefined;
  const lifecycle = galleryBrowserLifecycle(240_000);
  let exitCode = 1;
  let code = "GALLERY_RUNNER_FAILED";
  let steps: readonly string[] = [];
  try {
    const chunks: Buffer[] = [];
    let inputBytes = 0;
    const stopInput = () => {
      process.stdin.destroy();
    };
    lifecycle.signal.addEventListener("abort", stopInput, { once: true });
    try {
      for await (const chunk of process.stdin) {
        const bytes = Buffer.from(chunk as Uint8Array);
        inputBytes += bytes.byteLength;
        requireStep(inputBytes <= 16_384, "GALLERY_INPUT_TOO_LARGE");
        chunks.push(bytes);
      }
    } finally {
      lifecycle.signal.removeEventListener("abort", stopInput);
    }
    requireStep(!lifecycle.expired, "GALLERY_DEADLINE_EXCEEDED");
    const config = parseHostedInput(Buffer.concat(chunks).toString("utf8"));
    requireStep(
      hostedOrigin(config.agoraOrigin) &&
        hostedOrigin(config.workerOrigin) &&
        config.agoraOrigin !== config.workerOrigin &&
        config.user.toLowerCase() !== config.secondUser.toLowerCase(),
      "GALLERY_TARGET_OR_ACCOUNTS_INVALID",
    );
    const { chromium } = await import("@playwright/test");
    requireStep(!lifecycle.expired, "GALLERY_DEADLINE_EXCEEDED");
    try {
      browser = await lifecycle.launch(() => chromium.launch());
      requireStep(!lifecycle.expired, "GALLERY_DEADLINE_EXCEEDED");
    } catch (error) {
      if (error instanceof Error && error.message.includes("Executable doesn't exist")) {
        throw new GalleryFailure("GALLERY_BROWSER_UNAVAILABLE", 78);
      }
      throw new GalleryFailure("GALLERY_BROWSER_LAUNCH_FAILED");
    }
    const sponsor = await browser.newContext({ userAgent: USER_AGENT });
    const otherSponsor = await browser.newContext({ userAgent: USER_AGENT });
    const anonymous = await browser.newContext({ userAgent: USER_AGENT });
    for (const context of [sponsor, otherSponsor, anonymous]) {
      context.setDefaultTimeout(ACTION_TIMEOUT_MS);
      requireStep((await context.cookies()).length === 0, "GALLERY_BROWSER_CONTEXT_NOT_CLEAN");
    }
    const sponsorPage = await sponsor.newPage();
    const otherSponsorPage = await otherSponsor.newPage();
    await googleSignIn(sponsorPage, config.agoraOrigin, config.user, config.password);
    await googleSignIn(
      otherSponsorPage,
      config.agoraOrigin,
      config.secondUser,
      config.secondPassword,
    );
    steps = await runGalleryJourney({
      sponsorPage,
      otherSponsorPage,
      anonymousPage: await anonymous.newPage(),
      agoraOrigin: config.agoraOrigin,
      workerOrigin: config.workerOrigin,
      problemId: config.problemId,
      runId: config.runId,
      signal: lifecycle.signal,
    });
    code = "GALLERY_PRODUCT_FLOW_GREEN";
    exitCode = 0;
  } catch (error) {
    if (error instanceof GalleryFailure) {
      code = error.code;
      exitCode = error.exitCode;
    }
  } finally {
    try {
      await lifecycle.close();
    } catch {
      code = "GALLERY_BROWSER_CLOSE_FAILED";
      exitCode = 1;
    }
    if (lifecycle.expired) {
      code = "GALLERY_DEADLINE_EXCEEDED";
      exitCode = 1;
    }
  }
  console.log(
    JSON.stringify({
      suite: "smoke-gallery-product",
      status: exitCode === 0 ? "pass" : exitCode === 78 ? "blocked" : "fail",
      code,
      steps,
      duration_ms: Date.now() - started,
    }),
  );
  process.exitCode = exitCode;
}

if (import.meta.main) await main();
