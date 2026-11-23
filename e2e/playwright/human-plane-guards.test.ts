/**
 * W10.8 Human-Plane Playwright E2E Guards & Planted Must-Fail Negative Suite
 * (`asimposiumorg-3zn`).
 */

import { describe, expect, test } from "bun:test";
import {
  buildHumanPlaneOpsRecord,
  evaluateHumanPlaneAccessibility,
  evaluateHumanPlaneCacheAndPrivacyPair,
  type HumanPlaneAccessibilityAudit,
  type HumanPlanePrivacyPairSnapshot,
  redactHumanPlaneArtifact,
} from "./human-plane-guards.ts";

const CANARY_WORKSHOP = "PRIVATE_WORKSHOP_CANARY_W10_8_XYZ";
const CANARY_UNLISTED = "UNLISTED_PROBLEM_CANARY_W10_8_ABC";

function cleanPrivacySnapshot(): HumanPlanePrivacyPairSnapshot {
  return {
    syntheticRunId: "human-plane-20261121-001",
    privateWorkshopCanaries: [CANARY_WORKSHOP],
    unlistedProblemCanaries: [CANARY_UNLISTED],
    agoraOrigin: "https://staging.asimposium.org",
    stoaOrigin: "https://a-staging.asimposium.org",
    surfaces: [
      {
        surface: "sponsor-a-workshop",
        path: "/console/workshop/F-A/P-4DSP",
        isPrivate: true,
        status: 200,
        cacheControl: "private, no-store",
        vary: "Cookie",
        body: `<main><h1>Workshop</h1><p>${CANARY_WORKSHOP}</p></main>`,
      },
      {
        surface: "sponsor-b-console",
        path: "/console",
        isPrivate: true,
        status: 200,
        cacheControl: "private, no-store",
        vary: "Cookie",
        body: "<main><h1>Sponsor Console</h1><p>Fellow B only</p></main>",
      },
      {
        surface: "anonymous-problem-page",
        path: "/p/P-4DSP",
        isPrivate: false,
        status: 200,
        cacheControl: "public, max-age=0, s-maxage=30",
        body: "<main><h1>Public Claim C-1</h1></main>",
      },
      {
        surface: "anonymous-meta",
        path: "/p/P-4DSP",
        isPrivate: false,
        status: 200,
        body: '<meta property="og:title" content="P-4DSP public claim" />',
      },
      {
        surface: "search-results",
        path: "/search?q=PRIVATE_WORKSHOP",
        isPrivate: false,
        status: 200,
        body: '{"results":[]}',
      },
      {
        surface: "public-feed",
        path: "/now",
        isPrivate: false,
        status: 200,
        body: "<main><h1>Now</h1></main>",
      },
      {
        surface: "sitemap",
        path: "/sitemap.xml",
        isPrivate: false,
        status: 200,
        body: "<urlset><url><loc>https://staging.asimposium.org/p/P-4DSP</loc></url></urlset>",
      },
      {
        surface: "worker-logs",
        path: "/internal/logs",
        isPrivate: true,
        status: 200,
        cacheControl: "private, no-store",
        body: '{"facility":"OPS.2a","event_id":"EV-1"}',
      },
      {
        surface: "playwright-trace",
        path: "trace.json",
        isPrivate: true,
        status: 200,
        cacheControl: "private, no-store",
        body: '{"redacted":true}',
      },
    ],
    cookies: [
      {
        name: "__Host-asimp.session",
        domain: "staging.asimposium.org",
        hostOnly: true,
        httpOnly: true,
        secure: true,
        sentToOrigins: ["https://staging.asimposium.org"],
      },
    ],
    revocationRace: {
      inFlightViewStatus: 200,
      inFlightWriteStatus: 401,
      postRevokeStatus: 401,
    },
  };
}

function cleanA11yAudit(): HumanPlaneAccessibilityAudit {
  return {
    route: "/console",
    hasMainLandmark: true,
    hasNavLandmark: true,
    headingCountH1: 1,
    unlabeledInteractiveControls: [],
    keyboardTrapDetected: false,
    errorAnnouncementHasLiveRegion: true,
    axeSeriousOrCriticalViolations: [],
    consoleErrors: [],
    pageErrors: [],
  };
}

describe("W10.8 Human-plane Playwright E2E guards, redaction & planted negatives (asimposiumorg-3zn)", () => {
  test("POSITIVE: clean two-sponsor/anonymous/unlisted privacy & cache pair passes", () => {
    const res = evaluateHumanPlaneCacheAndPrivacyPair(cleanPrivacySnapshot());
    expect(res.ok).toBe(true);
    expect(res.violations).toEqual([]);
  });

  test("PLANTED NEGATIVE 1 (PRIVACY LEAK): workshop or unlisted canary in anonymous page, search, sitemap, or Sponsor B console FAILS", () => {
    for (const targetSurface of [
      "sponsor-b-console",
      "anonymous-problem-page",
      "search-results",
      "sitemap",
      "playwright-trace",
    ] as const) {
      const snap = cleanPrivacySnapshot();
      const leaked: HumanPlanePrivacyPairSnapshot = {
        ...snap,
        surfaces: snap.surfaces.map((s) =>
          s.surface === targetSurface ? { ...s, body: `${s.body} ${CANARY_WORKSHOP}` } : s,
        ),
      };
      const res = evaluateHumanPlaneCacheAndPrivacyPair(leaked);
      expect(res.ok, `planted leak on ${targetSurface} must fail`).toBe(false);
      expect(
        res.violations.some((v) => v.startsWith(`PRIVATE_CANARY_LEAKED:${targetSurface}`)),
      ).toBe(true);
    }
  });

  test("PLANTED NEGATIVE 2 (STALE CACHE): public or max-age cache header on private console/workshop FAILS", () => {
    const snap = cleanPrivacySnapshot();
    const stale: HumanPlanePrivacyPairSnapshot = {
      ...snap,
      surfaces: snap.surfaces.map((s) =>
        s.surface === "sponsor-a-workshop" ? { ...s, cacheControl: "public, s-maxage=60" } : s,
      ),
    };
    const res = evaluateHumanPlaneCacheAndPrivacyPair(stale);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.includes("CACHE"))).toBe(true);
  });

  test("PLANTED NEGATIVE 3 (PRINCIPAL CONFUSION): Agora session cookie forwarded to a-staging.asimposium.org or non-hostOnly FAILS", () => {
    const snap = cleanPrivacySnapshot();
    const leakedCookie: HumanPlanePrivacyPairSnapshot = {
      ...snap,
      cookies: [
        {
          name: "asimp.session",
          domain: ".asimposium.org",
          hostOnly: false,
          httpOnly: true,
          secure: true,
          sentToOrigins: ["https://staging.asimposium.org", "https://a-staging.asimposium.org"],
        },
      ],
    };
    const res = evaluateHumanPlaneCacheAndPrivacyPair(leakedCookie);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.includes("SESSION_COOKIE_NOT_HOST_ONLY"))).toBe(true);
    expect(res.violations.some((v) => v.includes("SESSION_COOKIE_DOMAIN_MISMATCH"))).toBe(true);
    expect(res.violations.some((v) => v.includes("PRINCIPAL_CONFUSION_COOKIE_SENT_TO_STOA"))).toBe(
      true,
    );

    const insecureHttpsCookie: HumanPlanePrivacyPairSnapshot = {
      ...snap,
      cookies: [
        {
          name: "__Host-asimp.session",
          domain: "staging.asimposium.org",
          hostOnly: true,
          httpOnly: true,
          secure: false,
          sentToOrigins: ["https://staging.asimposium.org"],
        },
      ],
    };
    const insecureRes = evaluateHumanPlaneCacheAndPrivacyPair(insecureHttpsCookie);
    expect(insecureRes.ok).toBe(false);
    expect(insecureRes.violations).toContain("SESSION_COOKIE_NOT_SECURE:__Host-asimp.session");
  });

  test("PLANTED NEGATIVE 4 & 5 (ACCESSIBILITY & CLIENT EXCEPTION): missing label/live-region, keyboard trap, axe error, or pageerror FAILS", () => {
    expect(evaluateHumanPlaneAccessibility(cleanA11yAudit()).ok).toBe(true);

    const a11yBroken = evaluateHumanPlaneAccessibility({
      ...cleanA11yAudit(),
      unlabeledInteractiveControls: ["button#mint-join"],
      errorAnnouncementHasLiveRegion: false,
      axeSeriousOrCriticalViolations: ["label"],
    });
    expect(a11yBroken.ok).toBe(false);
    expect(a11yBroken.violations).toContain("A11Y_UNLABELED_CONTROL:/console:button#mint-join");
    expect(a11yBroken.violations).toContain("A11Y_MISSING_ERROR_LIVE_REGION:/console");
    expect(a11yBroken.violations).toContain("A11Y_AXE_VIOLATION:/console:label");

    const clientCrash = evaluateHumanPlaneAccessibility({
      ...cleanA11yAudit(),
      pageErrors: ["TypeError: Cannot read properties of undefined (reading 'disposition')"],
    });
    expect(clientCrash.ok).toBe(false);
    expect(clientCrash.violations.some((v) => v.startsWith("CLIENT_PAGE_EXCEPTION:"))).toBe(true);
  });

  test("ARTIFACT SAFETY & OPS.2a CORRELATION: redacts join fragments/tokens/cookies, blocks non-synthetic & hidden reasoning", () => {
    const syntheticToken = `asimp_ag_${"01JXYZ4K6QABCDEFGHJKMNPQRS"}_${"A".repeat(43)}`;
    const safe = redactHumanPlaneArtifact({
      synthetic_only: true,
      run_id: "human-plane-001",
      kind: "network-log",
      url: "https://a-staging.asimposium.org/join/ASIMP-EN-01JXYZ#v1.supersecretfragment123456",
      headers: {
        Authorization: `Bearer ${syntheticToken}`,
        Cookie: "__Host-asimp.session=secret-cookie-value",
        "Cache-Control": "private, no-store",
      },
      bodyExcerpt: "Private body hashed only",
    });
    expect(safe.ok).toBe(true);
    const serialized = JSON.stringify(safe.artifact);
    expect(serialized).not.toContain("supersecretfragment");
    expect(serialized).not.toContain(syntheticToken);
    expect(serialized).not.toContain("secret-cookie-value");
    expect(serialized).not.toContain("Private body hashed only");
    expect(safe.artifact?.body_sha256).toMatch(/^[a-f0-9]{64}$/);

    // Non-synthetic / private run MUST refuse recording completely.
    const refusedPrivate = redactHumanPlaneArtifact({
      synthetic_only: false,
      run_id: "real-user-run",
      kind: "trace",
      url: "https://staging.asimposium.org/console",
      headers: {},
    });
    expect(refusedPrivate.ok).toBe(false);
    expect(refusedPrivate.reason).toBe("ARTIFACT_RECORDING_DISABLED_ON_NON_SYNTHETIC_RUN");

    // Rule A11: raw harness transcript or hidden reasoning (top-level or nested) MUST be refused.
    const refusedCot = redactHumanPlaneArtifact({
      synthetic_only: true,
      run_id: "human-plane-002",
      kind: "trace",
      url: "https://staging.asimposium.org/console?jwt=eyJsecret&auth=abc",
      headers: {},
      extra: { payload: [{ nested: { chain_of_thought: "never retain this" } }] },
    });
    expect(refusedCot.ok).toBe(false);
    expect(refusedCot.reason).toBe("FORBIDDEN_HIDDEN_REASONING_FIELD:chain_of_thought");

    const redactedQuery = redactHumanPlaneArtifact({
      synthetic_only: true,
      run_id: "human-plane-003",
      kind: "network-log",
      url: "https://user:basicSecret@staging.asimposium.org/api/check?jwt=eyJsecret&passphrase=topsecret",
      headers: { constructor: "ignore-proto-key" },
    });
    expect(redactedQuery.ok).toBe(true);
    expect(redactedQuery.artifact?.url).not.toContain("basicSecret");
    expect(redactedQuery.artifact?.url).not.toContain("eyJsecret");
    expect(redactedQuery.artifact?.url).not.toContain("topsecret");

    // Storage carrying hidden reasoning keys fails closed too.
    const refusedStorageCot = redactHumanPlaneArtifact({
      synthetic_only: true,
      run_id: "human-plane-004",
      kind: "trace",
      url: "https://staging.asimposium.org/console",
      headers: {},
      storageEntries: { raw_transcript: "never retain" },
    });
    expect(refusedStorageCot.ok).toBe(false);
    expect(refusedStorageCot.reason).toBe("FORBIDDEN_HIDDEN_REASONING_FIELD:raw_transcript");

    // Empty privateWorkshopCanaries fails closed (anti-vacuity).
    const vacuous = evaluateHumanPlaneCacheAndPrivacyPair({
      ...cleanPrivacySnapshot(),
      privateWorkshopCanaries: [],
    });
    expect(vacuous.ok).toBe(false);
    expect(vacuous.violations).toContain("NO_PRIVATE_WORKSHOP_CANARY_CONFIGURED");

    // Non-finite duration_ms in OPS.2a record fails closed.
    expect(() =>
      buildHumanPlaneOpsRecord({
        run_id: "human-plane-001",
        route: "/console",
        action: "view",
        principal: "sponsor-a",
        synthetic_ids: {},
        request_id: "req-nan",
        event_id: null,
        cursor: null,
        renderedText: "<main>ok</main>",
        cache_control: "private, no-store",
        status: "pass",
        duration_ms: Number.NaN,
      }),
    ).toThrow(/OPS2A_HUMAN_PLANE_INVALID_DURATION_MS/);

    // OPS.2a structured correlation record.
    const ops = buildHumanPlaneOpsRecord({
      run_id: "human-plane-001",
      route: "/console/workshop/F-A/P-4DSP",
      action: "promote_workshop_claim",
      principal: "sponsor-a",
      synthetic_ids: { problem_id: "P-4DSP", claim_id: "C-1" },
      request_id: "req-001",
      event_id: "EV-001",
      cursor: 14,
      renderedText: "<main>Promoted C-1</main>",
      cache_control: "private, no-store",
      status: "pass",
      duration_ms: 82,
    });
    expect(ops.facility).toBe("OPS.2a");
    expect(ops.render_digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
