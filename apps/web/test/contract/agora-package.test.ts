/**
 * Contract suite: the shipped `apps/web` package, not a fixture.
 *
 * The unit suite proves each rule *can* fire. This suite points the same rules
 * at the real tree, so a future commit that adds a write path to Agora, brings
 * back the Pages Router, widens the Auth.js cookie to the whole domain, or
 * drops a gate entry point turns `bun run test:contract` red.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { GET } from "../../app/api/health/route.ts";
import {
  formatAuthViolations,
  PROPYLON_EXPORTS,
  readAuthSurface,
  validateAuthFile,
} from "../../scripts/auth-contract.ts";
import {
  formatViolations,
  validateAgoraPackage,
  WRITE_PATH_EXEMPTIONS,
} from "../../scripts/route-contract.ts";

const PACKAGE_DIR = dirname(dirname(import.meta.dir));

function readPackageFile(relativePath: string): string {
  return readFileSync(join(PACKAGE_DIR, relativePath), "utf8");
}

describe("app router + one-writer contract, against the real tree", () => {
  test("apps/web satisfies every route-contract rule", () => {
    const violations = validateAgoraPackage(PACKAGE_DIR);
    // formatViolations first: a failure should read as the rule, not a diff.
    expect(formatViolations(violations)).toBe("no violations");
  });

  test("every declared write-path exemption still exists on disk", () => {
    for (const relativePath of WRITE_PATH_EXEMPTIONS.keys()) {
      expect(existsSync(join(PACKAGE_DIR, relativePath))).toBe(true);
    }
  });

  test("the app tree contains no Pages Router directory", () => {
    expect(existsSync(join(PACKAGE_DIR, "pages"))).toBe(false);
    expect(existsSync(join(PACKAGE_DIR, "src", "pages"))).toBe(false);
  });
});

describe("Propylon configuration (Fable §5.1, §14.1) — structural guard", () => {
  const surface = readAuthSurface(readPackageFile("auth.ts"), "auth.ts");

  test("the shipped auth.ts satisfies every Propylon rule", () => {
    // Parsed, not pattern-matched: an adversarial probe defeated the three
    // regexes this replaced by reformatting, hyphenating and destructuring.
    expect(formatAuthViolations(validateAuthFile(PACKAGE_DIR))).toBe("no violations");
  });

  test("the configured provider set is exactly the Google module", () => {
    // The configured array, not the import list: a locally-built provider
    // object never appears in an import, and an imported-but-unused Google
    // satisfies an import scan while configuring nothing.
    expect(surface.providers.literalArray).toBe(true);
    expect(surface.providers.unresolvable).toBe(false);
    expect(surface.providers.entries.map((entry) => entry.module)).toEqual([
      "next-auth/providers/google",
    ]);
    expect(surface.imports).toEqual([
      "next-auth",
      "next-auth/providers/google",
      "./lib/sponsor-id",
    ]);
  });

  test("OAuth callbacks request and preserve Google's signed authentication time", () => {
    const configuredGoogle = surface.providers.entries[0]?.text ?? "";
    expect(configuredGoogle).toContain(
      `claims: '{"id_token":{"auth_time":{"essential":true}}}'`,
    );
    expect(configuredGoogle).not.toContain('prompt: "login"');
    expect(configuredGoogle).not.toContain("max_age");
    for (const page of ["app/page.tsx", "app/console/page.tsx", "app/approve/page.tsx"]) {
      const source = readPackageFile(page);
      expect(source).not.toContain('prompt: "login"');
      expect(source).not.toContain("max_age");
    }
  });

  test("the exported Propylon surface comes from that very factory call", () => {
    // A safe call somewhere in the file is not the property; the exported
    // `handlers` binding being initialised by it is.
    expect(surface.providers.factoryCalls).toBe(1);
    expect(surface.wiring.fromFactory).toEqual([...PROPYLON_EXPORTS]);
    expect(surface.wiring.missing).toEqual([]);
    expect(surface.wiring.foreign).toEqual([]);
    expect(surface.dynamicCode).toEqual([]);
  });

  test("the sponsor session cookie is configured and host-only", () => {
    // A `domain` key would send the sponsor cookie to a.asimposium.org, which
    // is exactly the cross-plane confusion WRONG_PRINCIPAL exists for.
    expect(surface.cookies.present).toBe(true);
    expect(surface.cookies.unresolvable).toBe(false);
    expect(surface.cookies.keys).not.toContain("domain");
    expect(surface.cookies.keys).toContain("httpOnly");
  });

  test("ordinary session reads cannot refresh the recent-auth claim", () => {
    expect(surface.recentAuth).toMatchObject({
      callbacksPresent: true,
      unresolvable: false,
      jwtStampCount: 1,
      safeJwtStampCount: 1,
      sessionProjectionCount: 1,
      safeSessionProjectionCount: 1,
      iatReads: [],
    });
  });

  test("the file contains exactly one environment expression: process.env.NODE_ENV", () => {
    // Auth.js resolves AUTH_* itself at request time, so auth.ts never needs a
    // secret at any scope. The rule is an allowlist over the whole file rather
    // than a search for bad spellings, which is what kept getting bypassed.
    expect(surface.envAccesses).toHaveLength(1);
    expect(surface.envAccesses[0]?.allowed).toBe(true);
    expect(surface.envAccesses[0]?.text).toBe("process.env.NODE_ENV");
  });
});

describe("sponsor console trust boundary", () => {
  const stoa = readPackageFile("lib/stoa.ts");
  const stoaSponsor = readPackageFile("lib/stoa-sponsor.ts");
  const auth = readPackageFile("auth.ts");
  const actions = readPackageFile("app/console/actions.ts");

  test("the Stoa client is server-only and uses the hardened signed dispatcher", () => {
    expect(stoa).toContain('import "server-only"');
    expect(stoa).toContain("dispatchSignedSponsorRequest");
    expect(stoa).not.toMatch(/\bfetch\s*\(/);
    expect(stoa).not.toContain("mintServiceEnvelope");
  });

  test("the configured Stoa origin is closed, environment-only, and cannot fall back to production", () => {
    const consolePage = readPackageFile("app/console/page.tsx");
    expect(stoa).toContain("isTrustedStoaOrigin");
    expect(stoa).toContain("process.env.STOA_ORIGIN");
    expect(stoa).toContain("const stoaOrigin = configuredStoaOrigin()");
    expect(stoa).toContain("if (stoaOrigin === undefined) return { ok: false, reason: \"unconfigured\" }");
    expect(stoa).toContain("stoaOrigin,");
    expect(stoa).toContain('insecureLoopbackOrigin: stoaOrigin');
    expect(stoa).toContain("parseStoaJoinUrl(response.join_url)");
    expect(stoa).toContain("parsedJoinUrl.origin !== stoaOrigin");
    expect(stoa).not.toContain("SITE.stoa");
    expect(stoaSponsor).toContain("isTrustedStoaOrigin");
    expect(stoaSponsor).not.toContain("SITE.stoa");
    expect(stoaSponsor).toContain("stoaOrigin: string");
    expect(stoaSponsor).toContain("Insecure Stoa origin allowance must name the configured origin exactly");
    expect(consolePage).toContain("configuredStoaOrigin");
    expect(consolePage).toContain("probeLedger(stoaOrigin)");
    expect(consolePage).toContain("stoaOrigin}/problems.json");
    expect(consolePage).not.toContain("SITE.stoa}/problems.json");
    expect(consolePage).not.toContain("SITE.stoa}/internal/health");
  });

  test("the client join handoff uses the runtime-tested validated-origin renderer", () => {
    const cards = readPackageFile("app/console/cards.tsx");
    const joinPaste = readPackageFile("app/console/join-paste.ts");
    expect(cards).toContain('import { buildJoinPasteBlock } from "./join-paste"');
    expect(cards).toContain("const pasteBlock = buildJoinPasteBlock(joinUrl)");
    expect(cards).not.toContain("https://a.asimposium.org/v1/hello");
    expect(joinPaste).toContain("parseStoaJoinUrl");
    expect(joinPaste).toContain("stoaHelloUrl(parsed.origin)");
  });

  test("validated Google subjects deterministically become opaque Worker sponsor ids", () => {
    expect(auth).toContain(
      'import { isCanonicalSponsorId, sponsorIdFromGoogleSubject } from "./lib/sponsor-id"',
    );
    expect(auth).toContain("token.sub = await sponsorIdFromGoogleSubject(profile?.sub)");
    expect(auth).toContain("if (isCanonicalSponsorId(token.sub)) session.user.id = token.sub");
    expect(auth).not.toMatch(/session\.user\.id\s*=\s*`usr_\$\{token\.sub\}`/);
    expect(actions).toContain("isCanonicalSponsorId");
  });

  test("server actions parse decision bodies at runtime before dispatch", () => {
    expect(actions).toContain("SponsorEnrollmentDecisionSchema.safeParse(opened.request)");
    expect(actions).toContain("parsed.data.enrollment_id,");
    expect(actions).toContain("return dispatchPreparedDecision(");
    expect(actions).toContain("recoveryPayload,");
  });

  test("sponsor minting sends validated, configurable least-authority enrollment settings", () => {
    const cards = readPackageFile("app/console/cards.tsx");
    expect(actions).toContain("MintEnrollmentRequestSchema.safeParse(opened.request)");
    expect(actions).toContain("stoaMintEnrollment(sponsorId, request, idempotencyKey)");
    expect(actions).not.toContain(
      'requested_scopes: ["promote", "review", "propose-problems", "upload-artifacts"]',
    );
    expect(cards).toContain('recoveredDraft?.requested_scopes ?? ["promote", "review"]');
    expect(cards).toContain("Broader powers are");
    expect(cards).toContain("opt-in.");
    expect(cards).toContain("problem_binding: problemBinding.trim().toUpperCase()");
    expect(cards).toContain("first_directive: firstDirective.trim()");
    expect(cards).toContain("event_budget: eventLimit");
    expect(cards).toContain("artifact_budget_bytes: artifactLimitMiB * 1_048_576");
    expect(cards).toContain("fellow_grant_expires_in_ms: grantLifetimeDays * 86_400_000");
    expect(cards).toContain("expires_in_ms: joinLifetimeMinutes * 60_000");
  });

  test("approval consent shows every requested resource, including explicit unbounded states", () => {
    const cards = readPackageFile("app/console/cards.tsx");
    for (const label of [
      "Problem assignment",
      "First directive",
      "Agent-declared tools",
      "Event budget",
      "Artifact budget",
      "Fellow grant expires",
      "Proposal expires",
    ]) {
      expect(cards).toContain(`<dt>${label}</dt>`);
    }
    expect(cards).toContain('? "Unbounded"');
    expect(cards).toContain('? "No grant expiry"');
    expect(cards).toContain('card.tools_note ?? "None declared"');
    expect(cards).toContain(
      "This grants every requested scope and resource limit shown above to this Fellow.",
    );
  });

  test("ambiguous writes keep recovery truthful and strict reductions are expressible", () => {
    const cards = readPackageFile("app/console/cards.tsx");
    const idempotency = readPackageFile("app/console/idempotency.ts");
    const recovery = readPackageFile("lib/enrollment-recovery.ts");
    const consolePage = readPackageFile("app/console/page.tsx");
    const approvePage = readPackageFile("app/approve/page.tsx");
    const rootLayout = readPackageFile("app/layout.tsx");
    const recoverySentinel = readPackageFile("app/enrollment-recovery-sentinel.tsx");
    expect(actions).toContain("did not confirm the mint");
    expect(actions).toContain("Retry without changing these settings");
    expect(actions).toContain("did not confirm the outcome");
    expect(actions).not.toContain("The agent host did not answer. The proposal is unchanged.");
    expect(cards).toContain("optionalDurationMilliseconds");
    expect(cards).toContain("Grant lifetime from decision (seconds)");
    expect(cards).toContain("resources.event_budget - 1");
    expect(cards).toContain("resources.artifact_budget_bytes - 1");
    expect(cards).toContain("fingerprintEnrollmentAttempt(");
    expect(cards).toContain("recoverMintJoinUrl(");
    expect(cards).toContain("recoverProposalDecision(");
    expect(cards).toContain("retainedEnrollmentAttempts(");
    expect(cards).toContain("recoveryOwner,");
    expect(actions).toContain("expectedRecoveryOwner");
    expect(actions).toContain("openEnrollmentRecoveryPayload(");
    expect(actions).toContain("recoverMintJoinUrl(");
    expect(actions).toContain("recoverProposalDecision(");
    expect(actions).toContain("opened.idempotencyKey !== idempotencyKey");
    expect(actions).toContain("opened.idempotencyKey,");
    expect(actions).toContain("SponsorEnrollmentDecisionCommandSchema.parse");
    expect(actions).toContain("step_up_authenticated_at: stepUpAuthenticatedAt");
    expect(stoa).toContain("SponsorEnrollmentDecisionCommand");
    expect(actions).toContain("recoveryOwnerMatchesSponsor(");
    expect(actions).toContain("currentRecoveryOwner !== undefined &&");
    expect(actions).toContain("currentRecoveryOwner === expectedRecoveryOwner");
    expect(
      consolePage.match(/key=\{recoveryOwner \?\? "enrollment-writes-unavailable"\}/g),
    ).toHaveLength(3);
    expect(approvePage).toContain('key={recoveryOwner ?? "enrollment-writes-unavailable"}');
    const approveForm = readPackageFile("app/approve/form.tsx");
    expect(approveForm).toContain("<DecisionRecoveryList");
    expect(approveForm).toContain("onDecisionRecovered=");
    expect(approveForm).toContain("cardDecisionUnresolved || retainedDecisionUnresolved");
    expect(rootLayout).toContain("<EnrollmentRecoverySentinel />");
    expect(recoverySentinel).toContain('addEventListener("beforeunload"');
    expect(recoverySentinel).toContain(
      "enrollmentRecoveryMarkersMayRemain(availableSessionStorage())",
    );
    expect(cards).not.toContain('addEventListener("beforeunload"');
    expect(cards).toContain("otherRecoveryPending || decisionWarning");
    expect(cards).toContain("proposedIdempotencyKey");
    expect(recovery).toContain("idempotencyKey: candidate.idempotencyKey");
    expect(cards).toContain("mintInFlight.current");
    expect(cards).toContain("decisionInFlight.current");
    expect(cards).toContain("MINT_SCOPES.map(({ scope }) => scope).filter");
    expect(actions).toContain("ENROLLMENT_RECOVERY_HMAC_KEY_HEX");
    expect(actions).toContain("enrollmentRecoveryConfigurationIsValid(");
    expect(recovery).toContain("recoveryKeyHex !== serviceEnvelopeKeyHex");
    expect(stoa).toContain("ProblemDocumentSchema.safeParse");
    expect(stoa).toContain("problem.data.status !== response.status");
    expect(recovery).toContain("status !== 408");
    expect(recovery).toContain("problemCode !== undefined");
    const mintCall = cards.indexOf("const result = await mintJoinUrl(");
    const successStart = cards.indexOf("if (result.ok)", mintCall);
    const successEnd = cards.indexOf("} else {", successStart);
    const remember = cards.indexOf("successfulMintFingerprint.current =", successStart);
    const display = cards.indexOf("setJoinUrl(result.joinUrl)", successStart);
    const doneStart = cards.indexOf("const fingerprint = successfulMintFingerprint.current");
    const acknowledge = cards.indexOf("clearEnrollmentAttempt(", doneStart);
    const dismiss = cards.indexOf("setJoinUrl(null)", doneStart);
    for (const position of [
      mintCall,
      successStart,
      successEnd,
      remember,
      display,
      doneStart,
      acknowledge,
      dismiss,
    ]) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    expect(remember).toBeLessThan(display);
    expect(cards.slice(successStart, successEnd)).not.toContain("clearEnrollmentAttempt");
    expect(doneStart).toBeLessThan(acknowledge);
    expect(acknowledge).toBeLessThan(dismiss);
    expect(idempotency).not.toContain("subtle.digest");
    expect(idempotency).not.toContain("TextEncoder");
    expect(idempotency).toContain("recoveryPayload");
    expect(idempotency).toContain(".v2`");
    expect(idempotency).toContain("No enrollment write was sent");
  });

  test("lifecycle controls retain exact commands, legal transitions, and non-secret receipts", () => {
    const cards = readPackageFile("app/console/cards.tsx");
    const idempotency = readPackageFile("app/console/idempotency.ts");
    const recovery = readPackageFile("lib/enrollment-recovery.ts");
    const consolePage = readPackageFile("app/console/page.tsx");

    for (const routeAndAction of [
      'ROUTE_CREDENTIAL_REVOKE = "/v1/fellows/credentials/revoke"',
      'ROUTE_FELLOW_LIFECYCLE = "/v1/fellows/lifecycle"',
      'ROUTE_SPONSOR_PANIC = "/v1/sponsors/panic"',
      'ACTION_CREDENTIAL_REVOKE = "fellow.credential.revoke"',
      'ACTION_FELLOW_LIFECYCLE = "fellow.lifecycle.change"',
      'ACTION_SPONSOR_PANIC = "sponsor.panic"',
    ]) {
      expect(stoa).toContain(routeAndAction);
    }
    expect(actions).toContain("fingerprintLifecycleAttempt(");
    expect(actions).toContain("recoverLifecycleAttempt(");
    expect(actions).toContain("step_up_authenticated_at: stepUpAuthenticatedAt");
    expect(actions).toContain("SponsorCredentialRevokeRequestSchema.omit");
    expect(actions).toContain("SponsorFellowLifecycleRequestSchema.omit");
    expect(actions).toContain("SponsorPanicRequestSchema.omit");
    expect(cards).toContain("LIFECYCLE_TARGETS");
    expect(cards).toContain('revoked: ["archived"]');
    expect(cards).toContain('compromised: ["archived"]');
    expect(cards).toContain("Confirm sponsor panic");
    expect(cards).toContain("LifecycleReceiptView");
    expect(cards).toContain("never renders a credential token or token hash");
    expect(idempotency).toContain('"credential-revoke"');
    expect(idempotency).toContain('"fellow-lifecycle"');
    expect(idempotency).toContain('"sponsor-panic"');
    expect(recovery).toContain('"credential-revoke"');
    expect(recovery).toContain('"fellow-lifecycle"');
    expect(recovery).toContain('"sponsor-panic"');
    expect(consolePage).toContain("<LifecycleManager");
  });

  test("Fellow history stays server-mediated and continuation does not fork lifecycle controls", () => {
    const consolePage = readPackageFile("app/console/page.tsx");

    expect(stoa).toContain('ROUTE_FELLOWS_AFTER = "/v1/fellows/after/:cursor"');
    expect(stoa).toContain('action: ACTION_FELLOWS');
    expect(stoa).toContain(
      `path: cursor === undefined ? ROUTE_FELLOWS : \`/v1/fellows/after/\${cursor}\``,
    );
    expect(stoa).toContain("SponsorFellowCursorSchema.parse(after)");
    expect(consolePage).toContain("SponsorFellowCursorSchema.safeParse(value)");
    expect(consolePage).toContain("stoaFellows(sponsorId, fellowCursor)");
    expect(consolePage).toContain("nextFellowCursor = fellowResult.data.next_cursor");
    expect(consolePage).toContain(`/console?fellow_cursor=\${encodeURIComponent(nextFellowCursor)}`);
    expect(consolePage).toContain('href="/console"');
    expect(consolePage).toContain("<LifecycleManager");
    expect(consolePage).not.toContain("prepareAndDispatch(");
  });

  test("PLANTED: a retained lifecycle retry remains actionable when the Fellows read is non-live", () => {
    const cards = readPackageFile("app/console/cards.tsx");
    const managerStart = cards.indexOf("export function LifecycleManager");
    const recoveryControlsStart = cards.indexOf(
      "const retainedRecoveryControls = (",
      managerStart,
    );
    const nonLiveStart = cards.indexOf('if (hostState !== "live")', managerStart);
    const normalLiveReturn = cards.indexOf("\n  return (\n    <div>", nonLiveStart);
    const nonLiveBranch = cards.slice(nonLiveStart, normalLiveReturn);
    const recoveryControls = cards.slice(recoveryControlsStart, nonLiveStart);
    const settleStart = cards.indexOf("const settle = (", managerStart);
    const prepareStart = cards.indexOf("const prepareAndDispatch = (", settleStart);
    const settle = cards.slice(settleStart, prepareStart);
    const recoverExactStart = cards.indexOf(
      "const recoverExactAttempt = (",
      managerStart,
    );
    const recoverExact = cards.slice(recoverExactStart, recoveryControlsStart);

    for (const position of [
      managerStart,
      recoveryControlsStart,
      nonLiveStart,
      normalLiveReturn,
      settleStart,
      prepareStart,
      recoverExactStart,
    ]) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    expect(recoveryControlsStart).toBeLessThan(nonLiveStart);
    expect(nonLiveBranch).toContain("{retainedRecoveryControls}");
    expect(recoveryControls).toContain("state.attempts.map((attempt) => (");
    expect(recoveryControls).toContain("recoverExactAttempt(scope, attempt)");
    expect(recoveryControls).toContain(
      "disabled={pending || recoveryOwner === undefined}",
    );
    expect(nonLiveBranch).not.toContain("fellows.map(");
    expect(nonLiveBranch).not.toContain("prepareAndDispatch(");
    expect(nonLiveBranch).not.toContain("Start sponsor panic confirmation");

    expect(recoverExact).toContain("recoverLifecycleAttempt(");
    expect(recoverExact).toContain("attempt.recoveryPayload");
    expect(recoverExact).toContain("attempt.key");
    expect(recoverExact).toContain("settle(scope, attempt.fingerprint, result)");
    const clear = settle.indexOf("const cleared = clearAttempt(scope, fingerprint)");
    const receipt = settle.indexOf("setReceipt(result.receipt)");
    const refresh = settle.indexOf("router.refresh()");
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(receipt).toBeGreaterThan(clear);
    expect(refresh).toBeGreaterThan(receipt);
  });

  test("the evidence-refresh buttons use only Google's supported account chooser", () => {
    const consolePage = readPackageFile("app/console/page.tsx");
    const approvePage = readPackageFile("app/approve/page.tsx");
    for (const page of [consolePage, approvePage]) {
      expect(page).toContain('prompt: "select_account"');
      expect(page).not.toContain('prompt: "login"');
      expect(page).not.toContain("max_age");
      expect(page).toContain("Recheck Google authentication");
      expect(page).toContain("signed authentication time");
    }
  });

  /**
   * Owner-scoped recovery state must not survive a sponsor change on one tab.
   *
   * `recoveryOwner` is an opaque per-sponsor digest, so owner A → owner B moves
   * it. React reconciles by position and element type: an unkeyed component in
   * the same slot keeps its internal state across that change, which would show
   * A's resolution notice above B's markers. Every approve branch that renders
   * recovery UI is therefore keyed by owner.
   *
   * These are source assertions, not a mounted render — this package has no DOM
   * test runtime, and `cards.tsx` cannot be imported by a test because it pulls
   * the `"use server"` action module. They pin the keying and the barrier's
   * ordering; they do not execute React's reconciler or a real double click.
   */
  test("every approve branch that renders recovery UI is keyed by recovery owner", () => {
    const approve = readPackageFile("app/approve/page.tsx");
    const deviceForm = readPackageFile("app/approve/form.tsx");

    // Both keyed components, with their sentinels captured from the source
    // rather than restated here — asserting a literal this test typed would
    // prove nothing about the page.
    const keyed = [
      ...approve.matchAll(
        /<(DecisionRecoveryList|DeviceApprovalForm)\s+key=\{recoveryOwner \?\? "([^"]+)"\}/gu,
      ),
    ];
    // Branch 2 renders the list directly; branch 3 renders the form, and the
    // list it nests remounts with it, so the inner element needs no key.
    expect(keyed.map((match) => match[1]).sort()).toEqual([
      "DecisionRecoveryList",
      "DeviceApprovalForm",
    ]);
    expect(deviceForm).toContain("<DecisionRecoveryList");
    for (const match of keyed) {
      const sentinel = match[2] ?? "";
      // A real owner is a 64-hex digest, so a non-hex sentinel cannot collide
      // with one and be mistaken for a genuine owner scope.
      expect(sentinel).not.toMatch(/^[a-f0-9]{64}$/u);
      expect(sentinel.length).toBeGreaterThan(0);
    }
    // Distinct sentinels, so the two branches cannot share a reconciliation slot.
    expect(new Set(keyed.map((match) => match[2])).size).toBe(2);
    // Branch 1 is signed-out and renders no recovery surface to key.
    expect(approve).toContain("Approving an agent is a sponsor act");
    // No unkeyed recovery list may reappear on the approve page.
    expect(approve).not.toMatch(/<DecisionRecoveryList\s+recoveryOwner=/u);
  });

  test("the retained-decision recovery control has a synchronous double-submit barrier", () => {
    const cards = readPackageFile("app/console/cards.tsx");
    const claimAt = cards.indexOf("if (!claimEnrollmentRecoveryLock(inFlight)) return;");
    const dispatchAt = cards.indexOf("await recoverProposalDecision(");
    const releaseAt = cards.indexOf("releaseEnrollmentRecoveryLock(inFlight);");

    // The barrier is a ref, so it flips in the same tick. `pending` is state and
    // is still false for a second invocation that runs before the next render,
    // which is why `disabled` alone cannot hold this.
    expect(cards).toContain("const inFlight = useRef(false);");
    expect(claimAt).toBeGreaterThan(-1);
    // Claim before dispatch, or two invocations both reach the action.
    expect(claimAt).toBeLessThan(dispatchAt);
    // Released after the action, on every path, so a retained refusal stays
    // retryable rather than making the control single-use.
    expect(releaseAt).toBeGreaterThan(dispatchAt);
    // Exactly one claim and one release: a second pair elsewhere would mean
    // another path could hold or drop the same barrier.
    expect(cards.match(/claimEnrollmentRecoveryLock\(/gu)).toHaveLength(1);
    expect(cards.match(/releaseEnrollmentRecoveryLock\(/gu)).toHaveLength(1);
    // The lock body itself is not inline here. That is what makes the unit test
    // in `test/unit/console-idempotency.test.ts` a test of the shipped path
    // rather than of a second spelling that could drift from it.
    expect(cards).not.toContain("inFlight.current = true");
    expect(cards).not.toContain("inFlight.current = false");
    expect(readPackageFile("app/console/idempotency.ts")).toContain(
      "export function claimEnrollmentRecoveryLock(cell: { current: boolean }): boolean {",
    );
    // The visible affordance stays, but it is no longer the only guard.
    expect(cards).toContain("disabled={pending}");
  });

  test("the console exposes state changes and expandable controls to assistive technology", () => {
    const cards = readPackageFile("app/console/cards.tsx");
    const page = readPackageFile("app/console/page.tsx");
    const deviceForm = readPackageFile("app/approve/form.tsx");
    expect(cards).toContain('aria-live="polite"');
    expect(cards).toContain("aria-expanded={reduceOpen}");
    expect(cards).toContain('role="alert"');
    expect(page).toContain('aria-labelledby="account-title"');
    expect(page).not.toMatch(/<section[^>]+aria-label=/);
    expect(deviceForm.match(/aria-live="polite"/gu)).toHaveLength(1);
    expect(deviceForm).toContain('className="sr-only"');
    expect(deviceForm).toContain("Proposal found");
    expect(deviceForm).toContain("That character is not used in device codes.");
    expect(deviceForm).not.toContain('aria-label="Device code"');
    expect(deviceForm).toContain("Check another code");
    expect(deviceForm).toContain("no Fellow or");
    expect(deviceForm).toContain('decision === "deny"');
    expect(deviceForm).toContain("Enter a different code");
    expect(deviceForm).toContain('aria-label="Device proposal"');
  });
});

describe("the health face states availability, never implies it", () => {
  test("GET /api/health returns exactly the declared fields", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      plane: "agora",
      stage: "pre-G1",
      // Ownership is architecture and is true today; liveness is a separate
      // fact and is false. Rule A4 forbids collapsing them into one phrase.
      writes_owned_by: "https://a.asimposium.org",
      writes_live: false,
      ledger_live: false,
    });
  });

  test("no field advertises a capability that does not exist", async () => {
    const body = (await GET().json()) as Record<string, unknown>;
    // "accepted at"/"endpoint"/"available" all read as a live route. No write
    // route exists on either plane yet.
    for (const key of Object.keys(body)) {
      expect(key).not.toMatch(/accept|endpoint|available|ready/i);
    }
    expect(body.writes_live).toBe(false);
    expect(body.ledger_live).toBe(false);
  });

  test("the face discloses no environment value", async () => {
    process.env.ASIMP_HEALTH_CANARY = "canary-health-value";
    expect(await GET().text()).not.toContain("canary-health-value");
  });
});

describe("OPS.1 gate entry points", () => {
  const manifest = JSON.parse(readPackageFile("package.json")) as {
    name: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  test("every suite this package owes is invocable", () => {
    // Root policy (scripts/suite/policy.ts) gives apps/web the baseline plus
    // `security`. Those are the scripts that must exist.
    for (const script of [
      "typecheck",
      "lint",
      "test",
      "test:unit",
      "test:contract",
      "test:security",
    ]) {
      expect(manifest.scripts[script]).toBeDefined();
    }
  });

  test("suites this package does not owe are not declared", () => {
    // The dispatcher runs any declared script (scripts/suite/cli.ts resolution
    // rule 1), so declaring a deliberate blocker for a suite apps/web does not
    // owe turns a root suite permanently red while adding no coverage. Human
    // E2E against staging belongs to the `e2e` workspace, which owns that gate.
    for (const script of ["test:integration", "test:e2e", "test:performance"]) {
      expect(manifest.scripts[script]).toBeUndefined();
    }
  });

  test("toolchain versions are pinned exactly, not floated", () => {
    const allDeps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    for (const [name, range] of Object.entries(allDeps)) {
      // Workspace-internal packages are pinned by the monorepo itself; the
      // workspace protocol is the only acceptable range for them, since any
      // published-looking version would drift from the tree.
      if (name.startsWith("@asimposium/")) {
        expect(range).toBe("workspace:*");
        continue;
      }
      expect(`${name}@${range}`).toMatch(/@\d+\.\d+\.\d+(-[\w.]+)?$/);
    }
  });

  test("the stack table is respected: App Router, Tailwind, Auth.js v5", () => {
    expect(manifest.dependencies["next"]).toMatch(/^16\./);
    expect(manifest.dependencies["next-auth"]).toMatch(/^5\./);
    expect(manifest.devDependencies["tailwindcss"]).toMatch(/^4\./);
    expect(readPackageFile("postcss.config.mjs")).toContain("@tailwindcss/postcss");
    expect(readPackageFile("app/globals.css")).toContain('@import "tailwindcss"');
  });
});
