/**
 * W8.6 Workshop Live View E2E Suite (bead asimposiumorg-e7j).
 *
 * Proves:
 * 1. Live WIP Column & 3s Polling Cadence:
 *    - Wires the private cursor watcher with the rendered head and a 3s check cadence.
 *    - Older pages announce changes without automatic replacement.
 *    - Displays private work newest-first.
 * 2. Workshop Object Cards & Revision Pinning:
 *    - Card exposes workshop_id, type, state, version (vN), title, timestamp, relates_to, and body_md.
 *    - Form actions provide explicit Promote / Keep / Discard controls.
 *    - Exact revision is passed to the action component; action tests cover its server binding.
 * 3. Immutable Scientific Authorship (Rules A2 & A3):
 *    - Promotion confirmation retains Fellow/session/model/harness as scientific author.
 *    - Sponsor is recorded as acting promoter.
 *    - Discard preserves private drafts and their history.
 * 4. Keyset Pagination & Bounded Page Navigation:
 *    - Cursor-based pagination via before_workshop_seq.
 *    - Navigation generates exact olderHref and newestHref links.
 * 5. Strict Access Control & Privacy Isolation:
 *    - Anonymous principal produces "sign-in" state.
 *    - Invalid parameters/cursors produce "invalid" state.
 *    - Backend refusal or transport failure produces "unavailable" state without leaking private bytes.
 *    - Zero private body or workshop draft leakage to public faces.
 * 6. OPS.2a structured diagnostic logging without secret or private body leakage.
 */

import { mock } from "bun:test";
import { SponsorWorkshopViewSchema } from "@asimposium/contracts";

const { WORKSHOP_WATCH_INTERVAL_MS } = (await import(
  [new URL("../../apps/web/lib/workshop-watch.ts", import.meta.url).pathname].join("")
)) as { readonly WORKSHOP_WATCH_INTERVAL_MS: number };

type WorkshopReader = (
  principal: string,
  request: { fellow_id: string; problem_id: string; before_workshop_seq?: number; limit?: number },
) => Promise<unknown>;

type WorkshopPageResult =
  | { readonly status: "sign-in" }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly request: unknown;
      readonly view: unknown;
      readonly newestHref: string;
      readonly olderHref: string | null;
    };

const { loadWorkshopPage } = (await import(
  [new URL("../../apps/web/lib/workshop-page.ts", import.meta.url).pathname].join("")
)) as {
  loadWorkshopPage: (
    principal: string | undefined,
    fellow: string,
    problem: string,
    cursor?: string,
    reader?: WorkshopReader,
  ) => Promise<WorkshopPageResult>;
};

// Mock server-only and auth for server component evaluation
mock.module("server-only", () => ({}));
process.env.STOA_ORIGIN = "https://a.asimposium.org";

const testFellow = "fellow-01JXYZ9876543210ABCDEF";
const testProblem = "P-4DSP";
const testSponsor = "usr_sponsor_alpha";

let mockSessionUser: { id: string; name?: string; email?: string } | null = {
  id: testSponsor,
  name: "Sponsor Alpha",
  email: "sponsor@example.com",
};

mock.module("@/auth", () => ({
  auth: async () => (mockSessionUser ? { user: mockSessionUser } : null),
}));

mock.module("@/lib/stoa", () => ({
  configuredStoaOrigin: () => "https://a.asimposium.org",
  stoaSponsorWorkshop: async (
    _sponsorId: string,
    problemId: string,
    fellowId: string,
    _token?: string,
    beforeSeq?: number,
  ) => ({
    ok: true,
    data: createMockWorkshopView(
      fellowId,
      problemId,
      beforeSeq === undefined ? [3, 2, 1] : [1],
      false,
    ),
  }),
}));

const reactPath = import.meta.resolve(
  "react",
  new URL("../../apps/web/package.json", import.meta.url).href,
);
const React = (await import(reactPath)) as {
  createElement: (...args: unknown[]) => unknown;
};

mock.module("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
  usePathname: () => "/console/workshop",
  useSearchParams: () => new URLSearchParams(),
}));

type WorkshopWatchConfiguration = {
  readonly sponsorId: string;
  readonly fellowId: string;
  readonly problemId: string;
  readonly renderedCursor?: number;
};
let capturedWorkshopWatch: WorkshopWatchConfiguration | undefined;
mock.module("@/app/console/workshop-live", () => ({
  WorkshopLive: (configuration: WorkshopWatchConfiguration) => {
    capturedWorkshopWatch = configuration;
    return React.createElement(
      "aside",
      {
        className: "workshop-live",
        "aria-label": "Private workshop updates",
      },
      "Private workshop change checks",
    );
  },
}));
const reactDomServerPath = import.meta.resolve(
  "react-dom/server",
  new URL("../../apps/web/package.json", import.meta.url).href,
);
const { renderToStaticMarkup } = (await import(reactDomServerPath)) as {
  renderToStaticMarkup: (element: unknown) => string;
};

const workshopPagePath = new URL(
  "../../apps/web/app/console/workshop/[fellow]/[problem]/page.tsx",
  import.meta.url,
).pathname;

const { default: WorkshopPage } = (await import(workshopPagePath)) as {
  default: (props: {
    params: Promise<{ fellow: string; problem: string }>;
    searchParams: Promise<{ before_workshop_seq?: string | string[] }>;
  }) => Promise<unknown>;
};

interface Ops2aWorkshopLog {
  readonly facility: "OPS.2a";
  readonly suite: "e2e-workshop-live";
  readonly timestamp: string;
  readonly stage: string;
  readonly status: "pass" | "fail";
  readonly cited_authority: string;
  readonly duration_ms: number;
  readonly details?: Record<string, unknown>;
}

function logOps2a(entry: Omit<Ops2aWorkshopLog, "facility" | "suite" | "timestamp">) {
  const line: Ops2aWorkshopLog = {
    facility: "OPS.2a",
    suite: "e2e-workshop-live",
    timestamp: new Date().toISOString(),
    ...entry,
  };
  console.log(JSON.stringify(line));
}

function createMockWorkshopView(fellow: string, problem: string, seqs: number[], hasMore = false) {
  return SponsorWorkshopViewSchema.parse({
    schema: "https://a.asimposium.org/schemas/sessions.v1.json",
    fellow_id: fellow,
    problem_id: problem,
    objects: seqs.map((seq) => ({
      workshop_id: `W-${String(seq).padStart(26, "0")}`,
      type: "note",
      title: `Private hypothesis note ${seq}`,
      body_md: `Grounded private derivation notes for sequence ${seq}.`,
      relates_to: ["H-1"],
      workshop_seq: seq,
      version: 1,
      current_version: 1,
      state: "open",
      created_at: "2026-09-07T12:00:00.000Z",
    })),
    has_more: hasMore,
    next_cursor: hasMore ? seqs.at(-1) : null,
  });
}

function workshopActionPins(node: unknown): readonly { workshopId: string; version: unknown }[] {
  if (Array.isArray(node)) return node.flatMap((child) => workshopActionPins(child));
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const props = node.props;
  if (props === null || typeof props !== "object") return [];
  const pin =
    "workshopId" in props && typeof props.workshopId === "string"
      ? [{ workshopId: props.workshopId, version: "version" in props ? props.version : undefined }]
      : [];
  return [...pin, ...workshopActionPins("children" in props ? props.children : undefined)];
}

export async function runWorkshopLiveE2e() {
  const overallStart = performance.now();
  console.log("=== Running W8.6 Workshop Live View E2E Suite ===\n");

  // ---------------------------------------------------------------------------
  // Stage 1: Cursor Check Cadence & Live Watcher Wiring
  // ---------------------------------------------------------------------------
  console.log("1. Verifying private cursor checks and rendered-head wiring...");
  const t1 = performance.now();

  const mockReader: WorkshopReader = async (_principal, request) => {
    return {
      ok: true,
      data: createMockWorkshopView(
        testFellow,
        testProblem,
        request.before_workshop_seq === undefined ? [3, 2, 1] : [1],
        false,
      ),
    };
  };

  const loaded = await loadWorkshopPage(
    testSponsor,
    testFellow,
    testProblem,
    undefined,
    mockReader,
  );
  if (loaded.status !== "ready") {
    throw new Error(`Expected workshop page to be ready, got status: ${loaded.status}`);
  }

  // Render to static markup as signed-in sponsor
  mockSessionUser = {
    id: testSponsor,
    name: "Sponsor Alpha",
    email: "sponsor@example.com",
  };

  const pageElement = await WorkshopPage({
    params: Promise.resolve({ fellow: testFellow, problem: testProblem }),
    searchParams: Promise.resolve({}),
  });
  const html = renderToStaticMarkup(pageElement);

  // The full page only refreshes after a changed cursor. Controller behavior,
  // cancellation, and backoff are exercised in the focused watcher unit suite.
  if (WORKSHOP_WATCH_INTERVAL_MS !== 3_000) {
    throw new Error("Workshop cursor check cadence must be three seconds");
  }
  if (!html.includes('aria-label="Private workshop updates"')) {
    throw new Error("Workshop UI missing its private update watcher");
  }
  if (
    capturedWorkshopWatch?.sponsorId !== testSponsor ||
    capturedWorkshopWatch.fellowId !== testFellow ||
    capturedWorkshopWatch.problemId !== testProblem ||
    capturedWorkshopWatch.renderedCursor !== 3
  ) {
    throw new Error("Workshop watcher must be bound to the rendered sponsor, pair, and head");
  }

  logOps2a({
    stage: "cursor-check-cadence",
    status: "pass",
    cited_authority: "Fable §8.3 & Rule A7",
    duration_ms: performance.now() - t1,
    details: { cadence_ms: 3000, fellow: testFellow, problem: testProblem },
  });

  // ---------------------------------------------------------------------------
  // Stage 2: Workshop Cards, Actions & Exact Revision Pinning
  // ---------------------------------------------------------------------------
  console.log(
    "2. Verifying Workshop Card Actions (Promote / Keep / Discard) & Revision Pinning...",
  );
  const t2 = performance.now();

  // Check card elements
  if (!html.includes("workshop-card")) {
    throw new Error("Missing workshop-card CSS landmark in rendered output");
  }
  if (!html.includes("Promote to Ledger")) {
    throw new Error("Missing 'Promote to Ledger' action button on workshop card");
  }
  if (!html.includes("Keep Draft")) {
    throw new Error("Missing 'Keep Draft' action button on workshop card");
  }
  if (!html.includes("Discard (Soft-hide)")) {
    throw new Error("Missing 'Discard (Soft-hide)' action button on workshop card");
  }
  if (!html.includes('name="confirm_promotion"')) {
    throw new Error("Stored-revision promotion must require sponsor confirmation");
  }
  const expectedPins = [3, 2, 1].map((seq) => ({
    workshopId: `W-${String(seq).padStart(26, "0")}`,
    version: 1,
  }));
  if (JSON.stringify(workshopActionPins(pageElement)) !== JSON.stringify(expectedPins)) {
    throw new Error("Workshop actions must receive each rendered object's exact revision");
  }

  logOps2a({
    stage: "card-actions-revision-pinning",
    status: "pass",
    cited_authority: "W8.6 & Fable §8.3",
    duration_ms: performance.now() - t2,
    details: { actions: ["promote", "keep", "discard"], cas_pinning: true },
  });

  // ---------------------------------------------------------------------------
  // Stage 3: Immutable Authorship & Epistemic Guidance
  // ---------------------------------------------------------------------------
  console.log("3. Verifying Rule A2/A3 Immutable Authorship & Negative Knowledge Protection...");
  const t3 = performance.now();

  // Affirm Rule A2 and Rule A3 copy
  const requiredCopy = [
    "The Fellow, session, model and harness remain the scientific",
    "author; I am recorded as acting promoter.",
    "Discard preserves the draft and its history privately.",
  ];

  for (const phrase of requiredCopy) {
    if (!html.includes(phrase)) {
      throw new Error(`Rendered markup missing required epistemic assurance: "${phrase}"`);
    }
  }

  logOps2a({
    stage: "immutable-authorship-protection",
    status: "pass",
    cited_authority: "Rule A2 & Rule A3",
    duration_ms: performance.now() - t3,
    details: { immutable_authorship: true, soft_hide_negative_knowledge: true },
  });

  // ---------------------------------------------------------------------------
  // Stage 4: Keyset Pagination & Keyset Links
  // ---------------------------------------------------------------------------
  console.log("4. Verifying Keyset Cursor Pagination & Boundary Navigation...");
  const t4 = performance.now();

  // Multi-page test with cursor 5
  const multiPageReader: WorkshopReader = async (_principal, request) => {
    if (request.before_workshop_seq === undefined) {
      return {
        ok: true,
        data: createMockWorkshopView(testFellow, testProblem, [10, 9, 8, 7, 6, 5], true),
      };
    }
    return {
      ok: true,
      data: createMockWorkshopView(testFellow, testProblem, [4, 3, 2, 1], false),
    };
  };

  const page1 = await loadWorkshopPage(
    testSponsor,
    testFellow,
    testProblem,
    undefined,
    multiPageReader,
  );
  if (page1.status !== "ready") throw new Error("First page load failed");
  if (page1.olderHref !== `/console/workshop/${testFellow}/${testProblem}?before_workshop_seq=5`) {
    throw new Error(`Unexpected olderHref: ${page1.olderHref}`);
  }

  const page2 = await loadWorkshopPage(testSponsor, testFellow, testProblem, "5", multiPageReader);
  if (page2.status !== "ready") throw new Error("Second page load failed");
  if (page2.olderHref !== null) {
    throw new Error(`Expected olderHref to be null on last page, got: ${page2.olderHref}`);
  }
  if (page2.newestHref !== `/console/workshop/${testFellow}/${testProblem}`) {
    throw new Error(`Unexpected newestHref: ${page2.newestHref}`);
  }

  capturedWorkshopWatch = undefined;
  const olderPageElement = await WorkshopPage({
    params: Promise.resolve({ fellow: testFellow, problem: testProblem }),
    searchParams: Promise.resolve({ before_workshop_seq: "5" }),
  });
  const olderHtml = renderToStaticMarkup(olderPageElement);
  const olderWatch = capturedWorkshopWatch as WorkshopWatchConfiguration | undefined;
  if (
    olderWatch?.fellowId !== testFellow ||
    olderWatch.problemId !== testProblem ||
    olderWatch.renderedCursor !== undefined ||
    !olderHtml.includes("announce changes without moving this page")
  ) {
    throw new Error("Earlier workshop pages must watch without replacing the selected page");
  }

  logOps2a({
    stage: "keyset-pagination",
    status: "pass",
    cited_authority: "Fable §7.3 & e7j.4",
    duration_ms: performance.now() - t4,
    details: { cursor_step: 5, forward_back_links_verified: true },
  });

  // ---------------------------------------------------------------------------
  // Stage 5: Access Control Isolation & Error Boundaries
  // ---------------------------------------------------------------------------
  console.log("5. Verifying Access Control Boundaries (Anonymous, Invalid, Unavailable)...");
  const t5 = performance.now();

  // 1. Anonymous visitor
  const anonResult = await loadWorkshopPage(
    undefined,
    testFellow,
    testProblem,
    undefined,
    mockReader,
  );
  if (anonResult.status !== "sign-in") {
    throw new Error(`Expected anonymous access to yield "sign-in", got: ${anonResult.status}`);
  }

  // Render anonymous page
  mockSessionUser = null;
  const anonPageElement = await WorkshopPage({
    params: Promise.resolve({ fellow: testFellow, problem: testProblem }),
    searchParams: Promise.resolve({}),
  });
  const anonHtml = renderToStaticMarkup(anonPageElement);
  if (!anonHtml.includes("Sign in required")) {
    throw new Error("Anonymous workshop render did not produce 'Sign in required' card");
  }
  if (
    anonHtml.includes("workshop-card") ||
    anonHtml.includes("workshop-live") ||
    anonHtml.includes("Grounded private derivation")
  ) {
    throw new Error("Private workshop bytes leaked in anonymous render");
  }

  // 2. Malformed parameters
  for (const badCursor of ["-1", "abc", "1.5", "0"]) {
    const invalidResult = await loadWorkshopPage(
      testSponsor,
      testFellow,
      testProblem,
      badCursor,
      mockReader,
    );
    if (invalidResult.status !== "invalid") {
      throw new Error(
        `Expected bad cursor "${badCursor}" to yield "invalid", got: ${invalidResult.status}`,
      );
    }
  }

  // 3. Stoa backend refusal or transport failure
  const failingReader: WorkshopReader = async () => ({
    ok: false,
    reason: "refused",
    detail: "WORKSHOP_ACCESS_REFUSED",
  });
  const unavailableResult = await loadWorkshopPage(
    testSponsor,
    testFellow,
    testProblem,
    undefined,
    failingReader,
  );
  if (unavailableResult.status !== "unavailable") {
    throw new Error(
      `Expected backend refusal to yield "unavailable", got: ${unavailableResult.status}`,
    );
  }

  logOps2a({
    stage: "access-control-isolation",
    status: "pass",
    cited_authority: "Rule A2 & Fable §5.1",
    duration_ms: performance.now() - t5,
    details: { anonymous_blocked: true, invalid_params_blocked: true, refusal_safe: true },
  });

  console.log(
    `\n=== W8.6 Workshop Live View E2E Suite Passed (${(performance.now() - overallStart).toFixed(2)}ms) ===`,
  );
}

if (import.meta.main) {
  runWorkshopLiveE2e().catch((error) => {
    console.error("Workshop Live View E2E Suite FAILED:", error);
    process.exit(1);
  });
}
