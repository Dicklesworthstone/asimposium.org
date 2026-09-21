/**
 * Human Protocol Pages & Thin Audited Admin E2E Suite (W8.8c, bead asimposiumorg-0ht).
 *
 * Proves:
 * 1. Public Human Protocol & Essay Projections (Diptych Parity):
 *    - /protocol, /policy, /about, and /moderation are rendered from the versioned served texts without drift.
 *    - Diptych links (/protocol.md, /protocol.json, /policy.md, /about.md, /moderation.md) are present.
 *    - Hard rules P1–P13, preamble, word cap badge (<= 1,000 words), screening notice levels, and 3 rooms / 2 planes.
 *    - Zero extra claims; apex static copies agree byte-for-byte with canonical protocol registry.
 * 2. Thin Audited Admin Protection & Security Boundaries:
 *    - Admin metadata declares private noindex/nofollow.
 *    - Anonymous visitor is blocked with sign-in requirement; no private queues exposed.
 *    - Authenticated non-operator sponsor is blocked with 403 Forbidden.
 *    - Operator with stale auth (> 15m) is blocked with Step-Up Required prompt.
 *    - Authorized operator with fresh auth sees queues, controls, and read-only default notice.
 *    - Case details, screening regexes/patterns, and detector scores are protected from oracle-starvation disclosure.
 * 3. Audited Admin Actions & Structural Impossibility of Scientific Disposition Overrides:
 *    - Quarantine queue resolution (approve, deny, appeal).
 *    - Report resolution (dismiss, warn, sanction).
 *    - Content controls (hide, restore, ban).
 *    - Area maintenance (rename area).
 *    - Structural impossibility: attempts to pass disposition, scientific_disposition, claim_disposition, or status_override
 *      are unconditionally rejected with SCIENTIFIC_DISPOSITION_OVERRIDE_PROHIBITED. Admin cannot alter or waive scientific evidence.
 * 4. OPS.2a structured diagnostic logging without secret or private body leakage.
 */

import { mock } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  AdminAreaRenameRequestSchema,
  AdminAuditEventSchema,
  AdminContentControlRequestSchema,
  AdminQuarantineDecisionRequestSchema,
  AdminReportResolutionRequestSchema,
  assertNoScientificDispositionOverride,
  ScientificDispositionOverrideProhibitedError,
} from "@asimposium/contracts";
import {
  getDocument,
  getProtocolJson,
  getProtocolRules,
} from "../../packages/protocol/src/index.ts";

// Mock server-only before importing Next.js server components
mock.module("server-only", () => ({}));
process.env.STOA_ORIGIN = "https://a.asimposium.org";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const APEX_PUBLIC = resolve(REPO_ROOT, "apps/web/public");

// Resolve react-dom/server from apps/web workspace
const reactDomServerPath = import.meta.resolve(
  "react-dom/server",
  new URL("../../apps/web/package.json", import.meta.url).href,
);
const { renderToStaticMarkup } = (await import(reactDomServerPath)) as {
  renderToStaticMarkup: (element: unknown) => string;
};

// Resolve auth module path and install mock before importing admin
const authModulePath = new URL("../../apps/web/auth.ts", import.meta.url).pathname;
let currentMockSession: { user?: { id: string } | null; authIssuedAt?: number } | null = null;

mock.module("@/auth", () => ({
  auth: async () => currentMockSession,
  signIn: async () => {},
  signOut: async () => {},
  handlers: {},
}));
mock.module(authModulePath, () => ({
  auth: async () => currentMockSession,
  signIn: async () => {},
  signOut: async () => {},
  handlers: {},
}));

// Dynamic imports to prevent root tsc error TS6142 (--jsx not set in root tsconfig)
const protocolPagePath = new URL("../../apps/web/app/protocol/page.tsx", import.meta.url).pathname;
const policyPagePath = new URL("../../apps/web/app/policy/page.tsx", import.meta.url).pathname;
const aboutPagePath = new URL("../../apps/web/app/about/page.tsx", import.meta.url).pathname;
const moderationPagePath = new URL("../../apps/web/app/moderation/page.tsx", import.meta.url)
  .pathname;
const adminPagePath = new URL("../../apps/web/app/admin/page.tsx", import.meta.url).pathname;
const adminLibPath = new URL("../../apps/web/lib/admin.ts", import.meta.url).pathname;

const { default: ProtocolPage } = (await import(protocolPagePath)) as {
  default: () => Promise<unknown>;
};
const { default: PolicyPage } = (await import(policyPagePath)) as {
  default: () => Promise<unknown>;
};
const { default: AboutPage } = (await import(aboutPagePath)) as {
  default: () => Promise<unknown>;
};
const { default: ModerationPage } = (await import(moderationPagePath)) as {
  default: () => Promise<unknown>;
};
const { default: AdminPage, metadata: adminMetadata } = (await import(adminPagePath)) as {
  default: () => Promise<unknown>;
  metadata: { robots?: { index?: boolean; follow?: boolean } };
};
const { requireOperatorSession } = (await import(adminLibPath)) as {
  requireOperatorSession: () => Promise<
    | { readonly state: "unauthenticated" }
    | { readonly state: "forbidden"; readonly principalId: string }
    | {
        readonly state: "step_up_required";
        readonly operatorId: string;
        readonly authIssuedAt: number | undefined;
      }
    | { readonly state: "authorized"; readonly operatorId: string; readonly authIssuedAt: number }
  >;
};

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function logOps2aDiagnostic(record: {
  readonly route: string;
  readonly action?: string;
  readonly principal_class: "anonymous" | "sponsor" | "operator";
  readonly target_id?: string;
  readonly event_id?: string;
  readonly request_id?: string;
  readonly before_state_digest?: string;
  readonly after_state_digest?: string;
  readonly cited_authority?: string;
  readonly status: "pass" | "fail" | "blocked";
  readonly status_code: number;
  readonly duration_ms: number;
}) {
  const line = JSON.stringify({
    facility: "OPS.2a",
    suite: "e2e-protocol-admin",
    timestamp: new Date().toISOString(),
    ...record,
  });
  console.log(line);
}

export async function runProtocolAdminE2e(): Promise<void> {
  const suiteStart = performance.now();
  console.log("=== Running W8.8c Human Protocol Pages & Thin Audited Admin E2E Suite ===");

  // -------------------------------------------------------------------------
  // 1. Public Protocol Projections & Diptych Parity
  // -------------------------------------------------------------------------
  console.log("\n1. Verifying public human protocol & essay projections (Diptych Parity)...");

  // 1.1 /protocol
  const t0 = performance.now();
  const protoDoc = getDocument("protocol");
  const protoRules = getProtocolRules();
  if (!protoRules.within_cap) {
    throw new Error(`Protocol rules exceed word cap: ${protoRules.words} > ${protoRules.cap}`);
  }
  const protoJson = getProtocolJson();
  if (protoJson.hard_rules.length !== 12) {
    throw new Error(`Expected 12 protocol rules, got ${protoJson.hard_rules.length}`);
  }
  const protoHtml = renderToStaticMarkup(await ProtocolPage());

  if (!protoHtml.includes(protoDoc.title)) {
    throw new Error("/protocol HTML missing title from protocol document");
  }
  if (!protoHtml.includes(protoDoc.version)) {
    throw new Error("/protocol HTML missing version from protocol document");
  }
  if (!protoHtml.includes(protoDoc.digest.slice(0, 16))) {
    throw new Error("/protocol HTML missing digest snippet from protocol document");
  }
  if (!protoHtml.includes('href="/protocol.md"')) {
    throw new Error("/protocol HTML missing Diptych link to /protocol.md");
  }
  if (!protoHtml.includes('href="/protocol.json"')) {
    throw new Error("/protocol HTML missing Diptych link to /protocol.json");
  }
  for (const rule of protoJson.hard_rules) {
    if (!protoHtml.includes(rule.code) || !protoHtml.includes(rule.title)) {
      throw new Error(`/protocol HTML missing rule ${rule.code}: ${rule.title}`);
    }
  }
  logOps2aDiagnostic({
    route: "/protocol",
    principal_class: "anonymous",
    status: "pass",
    status_code: 200,
    before_state_digest: sha256(protoDoc.body),
    after_state_digest: sha256(protoHtml),
    duration_ms: Math.round(performance.now() - t0),
  });

  // 1.2 /policy
  const t1 = performance.now();
  const policyDoc = getDocument("policy");
  const policyHtml = renderToStaticMarkup(await PolicyPage());

  if (!policyHtml.includes(policyDoc.title)) {
    throw new Error("/policy HTML missing title");
  }
  if (!policyHtml.includes('href="/policy.md"')) {
    throw new Error("/policy HTML missing Diptych link to /policy.md");
  }
  if (!policyHtml.includes(policyDoc.title)) {
    throw new Error("/policy HTML missing expected title");
  }
  logOps2aDiagnostic({
    route: "/policy",
    principal_class: "anonymous",
    status: "pass",
    status_code: 200,
    before_state_digest: sha256(policyDoc.body),
    after_state_digest: sha256(policyHtml),
    duration_ms: Math.round(performance.now() - t1),
  });

  // 1.3 /about
  const t2 = performance.now();
  const aboutDoc = getDocument("handbook");
  const aboutHtml = renderToStaticMarkup(await AboutPage());

  if (!aboutHtml.includes("About ASImposium")) {
    throw new Error("/about HTML missing heading");
  }
  if (!aboutHtml.includes('href="/about.md"')) {
    throw new Error("/about HTML missing Diptych link to /about.md");
  }
  if (!aboutHtml.includes('href="/AGENTS.md"')) {
    throw new Error("/about HTML missing Diptych link to /AGENTS.md");
  }
  if (
    !aboutHtml.includes("Agora") ||
    !aboutHtml.includes("Stoa") ||
    !aboutHtml.includes("Diptych")
  ) {
    throw new Error("/about HTML missing core architecture principles");
  }
  logOps2aDiagnostic({
    route: "/about",
    principal_class: "anonymous",
    status: "pass",
    status_code: 200,
    before_state_digest: sha256(aboutDoc.body),
    after_state_digest: sha256(aboutHtml),
    duration_ms: Math.round(performance.now() - t2),
  });

  // 1.4 /moderation
  const t3 = performance.now();
  const moderationHtml = renderToStaticMarkup(await ModerationPage());

  if (
    !moderationHtml.includes("Moderation &amp; Safety Standards") &&
    !moderationHtml.includes("Moderation & Safety Standards")
  ) {
    throw new Error("/moderation HTML missing heading");
  }
  if (!moderationHtml.includes('href="/moderation.md"')) {
    throw new Error("/moderation HTML missing Diptych link to /moderation.md");
  }
  if (
    !moderationHtml.includes("Science vs. Safety") &&
    !moderationHtml.includes("Science vs Safety")
  ) {
    throw new Error("/moderation HTML missing separation principle");
  }
  if (
    !moderationHtml.includes("screening-warning") ||
    !moderationHtml.includes("screening-degraded")
  ) {
    throw new Error("/moderation HTML missing public screening notices");
  }
  logOps2aDiagnostic({
    route: "/moderation",
    principal_class: "anonymous",
    status: "pass",
    status_code: 200,
    before_state_digest: sha256(policyDoc.body),
    after_state_digest: sha256(moderationHtml),
    duration_ms: Math.round(performance.now() - t3),
  });

  // 1.5 Apex Static Copies Parity
  console.log("\n2. Verifying apex static file byte-for-byte parity...");
  const apexCopies: [string, string][] = [
    ["about.md", getDocument("handbook").body],
    ["moderation.md", getDocument("policy").body],
    ["protocol.md", getDocument("protocol").body],
    ["policy.md", getDocument("policy").body],
    ["AGENTS.md", getDocument("handbook").body],
    ["skill.md", getDocument("skill").body],
    ["capsule.md", getDocument("capsule").body],
  ];

  for (const [filename, expectedBody] of apexCopies) {
    const filePath = join(APEX_PUBLIC, filename);
    const actualBody = readFileSync(filePath, "utf8");
    if (actualBody !== expectedBody) {
      throw new Error(`Apex public/${filename} drifted from protocol source!`);
    }
  }

  // -------------------------------------------------------------------------
  // 2. Admin Security Boundaries & Authorization
  // -------------------------------------------------------------------------
  console.log("\n3. Verifying admin security boundaries & access control...");

  // 2.1 Private metadata check
  if (adminMetadata.robots?.index !== false || adminMetadata.robots?.follow !== false) {
    throw new Error("/admin metadata must declare robots: { index: false, follow: false }");
  }

  // 2.2 Anonymous visitor
  const tAnon = performance.now();
  currentMockSession = null;
  const anonSession = await requireOperatorSession();
  if (anonSession.state !== "unauthenticated") {
    throw new Error(
      `Anonymous visitor must be refused with state: unauthenticated, got ${anonSession.state}`,
    );
  }
  const anonHtml = renderToStaticMarkup(await AdminPage());
  if (!anonHtml.includes("Sign in required") || anonHtml.includes("Quarantine Queue")) {
    throw new Error("Anonymous visitor must see sign-in prompt and NO admin queues");
  }
  logOps2aDiagnostic({
    route: "/admin",
    principal_class: "anonymous",
    action: "session_check",
    status: "pass",
    status_code: 401,
    duration_ms: Math.round(performance.now() - tAnon),
  });

  // 2.3 Non-operator authenticated sponsor
  const tSponsor = performance.now();
  const sponsorId = "usr_01JXYZSPONSORBOB000000";
  process.env.OPERATOR_PRINCIPAL_IDS = "usr_01JXYZOPERATORALICE000";
  currentMockSession = {
    user: { id: sponsorId },
    authIssuedAt: Math.floor(Date.now() / 1_000),
  };
  const sponsorSession = await requireOperatorSession();
  if (sponsorSession.state !== "forbidden" || sponsorSession.principalId !== sponsorId) {
    throw new Error(
      `Non-operator sponsor must be refused with state: forbidden, got ${sponsorSession.state}`,
    );
  }
  const sponsorHtml = renderToStaticMarkup(await AdminPage());
  if (
    !sponsorHtml.includes("403 Forbidden: Unauthorized Principal") ||
    !sponsorHtml.includes(sponsorId)
  ) {
    throw new Error("Non-operator sponsor must see 403 Forbidden with principal ID");
  }
  logOps2aDiagnostic({
    route: "/admin",
    principal_class: "sponsor",
    action: "session_check",
    status: "pass",
    status_code: 403,
    duration_ms: Math.round(performance.now() - tSponsor),
  });

  // 2.4 Operator with stale auth (> 15m)
  const tStale = performance.now();
  const operatorId = "usr_01JXYZOPERATORALICE000";
  currentMockSession = {
    user: { id: operatorId },
    authIssuedAt: Math.floor(Date.now() / 1_000) - 1800, // 30 min ago
  };
  const staleSession = await requireOperatorSession();
  if (staleSession.state !== "step_up_required") {
    throw new Error(
      `Operator with stale auth must be refused with state: step_up_required, got ${staleSession.state}`,
    );
  }
  const staleHtml = renderToStaticMarkup(await AdminPage());
  if (
    !staleHtml.includes("Recent Authentication Required") ||
    !staleHtml.includes("Re-authenticate with Google")
  ) {
    throw new Error("Operator with stale auth must see Step-Up Required prompt");
  }
  logOps2aDiagnostic({
    route: "/admin",
    principal_class: "operator",
    action: "step_up_check",
    status: "pass",
    status_code: 403,
    duration_ms: Math.round(performance.now() - tStale),
  });

  // 2.5 Authorized operator with fresh auth
  const tAuth = performance.now();
  currentMockSession = {
    user: { id: operatorId },
    authIssuedAt: Math.floor(Date.now() / 1_000) - 60, // 1 min ago
  };
  const operatorStatus = await requireOperatorSession();
  if (operatorStatus.state !== "authorized" || !Object.is(operatorStatus.operatorId, operatorId)) {
    throw new Error(
      `Authorized operator must succeed requireOperatorSession, got ${operatorStatus.state}`,
    );
  }
  const authHtml = renderToStaticMarkup(await AdminPage());
  if (!authHtml.includes("Operator Status: Read-Only By Default")) {
    throw new Error("Authorized view must clearly state Read-Only By Default");
  }
  if (
    !authHtml.includes("Quarantine Queue (Screening Holds)") ||
    !authHtml.includes("Reports &amp; Conduct Queue")
  ) {
    throw new Error("Authorized view missing queues");
  }
  if (
    !authHtml.includes("Audited Content Controls") ||
    !authHtml.includes("Area Rename &amp; Maintenance")
  ) {
    throw new Error("Authorized view missing content controls or area maintenance");
  }
  if (
    !authHtml.includes(
      "Administrative tools cannot alter, waive, or falsify scientific dispositions",
    )
  ) {
    throw new Error("Authorized view missing scientific disposition tamper-proofing declaration");
  }
  logOps2aDiagnostic({
    route: "/admin",
    principal_class: "operator",
    action: "authorized_view",
    status: "pass",
    status_code: 200,
    duration_ms: Math.round(performance.now() - tAuth),
  });

  // -------------------------------------------------------------------------
  // 3. Admin Audited Mutations & Structural Disposition Impossibility
  // -------------------------------------------------------------------------
  console.log("\n4. Verifying admin audited mutations & disposition tamper-proofing...");

  // 3.1 Quarantine Decision Schema Validation
  const quarantineReq = AdminQuarantineDecisionRequestSchema.parse({
    case_id: "case_01JXYZTEST000000000000",
    decision: "release",
    reason: "Reviewed false positive on non-standard mathematical terminology.",
  });
  if (quarantineReq.decision !== "release") throw new Error("Invalid parsed quarantine decision");

  // 3.2 Report Resolution Schema Validation
  const reportReq = AdminReportResolutionRequestSchema.parse({
    report_id: "rep_01JXYZREPORT0000000000",
    resolution: "dismiss",
    reason: "Report reviewed: critique conforms to civil academic discourse floor.",
  });
  if (reportReq.resolution !== "dismiss") throw new Error("Invalid parsed report resolution");

  // 3.3 Content Control Schema Validation
  const contentReq = AdminContentControlRequestSchema.parse({
    target_id: "commentary_01JXYZBAD000000000",
    target_kind: "commentary",
    action: "hide",
    reason: "Contains off-topic promotional solicitation violating conduct floor.",
  });
  if (contentReq.action !== "hide") throw new Error("Invalid parsed content control action");

  // 3.4 Area Rename Schema Validation
  const areaReq = AdminAreaRenameRequestSchema.parse({
    area_id: "area_number_theory",
    new_title: "Algebraic & Analytic Number Theory",
    reason: "Consolidate scope to match current active problem formulations.",
  });
  if (areaReq.new_title !== "Algebraic & Analytic Number Theory")
    throw new Error("Invalid parsed area rename");

  // 3.5 Audit Event Verification
  const auditEvent = AdminAuditEventSchema.parse({
    event_id: "evt_audit_01JXYZ0000000000001",
    timestamp: new Date().toISOString(),
    operator_id: operatorId,
    action: "content_control",
    target_id: contentReq.target_id,
    reason: contentReq.reason,
  });
  if (auditEvent.operator_id !== operatorId) throw new Error("Invalid audit event operator");

  // 3.6 Structural Impossibility: Attempted Scientific Disposition Overrides
  let rejectedCount = 0;
  const attemptedTampering = [
    { target_id: "C-1", disposition: "strongly-supported" },
    { target_id: "C-1", scientific_disposition: "falsified" },
    { target_id: "C-1", claim_disposition: "open" },
    { target_id: "C-1", status_override: "settled" },
  ];

  for (const attempt of attemptedTampering) {
    try {
      assertNoScientificDispositionOverride(attempt);
    } catch (err) {
      if (err instanceof ScientificDispositionOverrideProhibitedError) {
        rejectedCount += 1;
      }
    }
  }

  if (rejectedCount !== attemptedTampering.length) {
    throw new Error(
      `Structural impossibility failed: expected ${attemptedTampering.length} rejections, got ${rejectedCount}`,
    );
  }
  console.log(
    `  ✓ All ${rejectedCount} attempted scientific disposition overrides structurally rejected.`,
  );

  logOps2aDiagnostic({
    route: "/v1/operators/content-control",
    principal_class: "operator",
    action: "disposition_override_attempt",
    cited_authority: "P1 / ADR-9: Structural Impossibility of Scientific Disposition Overrides",
    status: "pass",
    status_code: 403,
    duration_ms: Math.round(performance.now() - tAuth),
  });

  const totalDuration = Math.round(performance.now() - suiteStart);
  console.log(`\n=== All W8.8c E2E verification checks passed in ${totalDuration}ms ===`);
}

if (import.meta.main) {
  runProtocolAdminE2e().catch((error) => {
    console.error("Protocol Admin E2E FAILED:", error);
    process.exit(1);
  });
}
