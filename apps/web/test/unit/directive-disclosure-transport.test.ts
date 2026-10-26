import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import {
  DIRECTIVE_DISCLOSURE_MAX_RESPONSE_BYTES,
  type SponsorDirectiveDisclosureRequest,
} from "@asimposium/contracts/directive-disclosures";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";
import {
  disclosureCommand, disclosureCompleted, disclosureDirectiveId, disclosureInitial, disclosureInitialInstructionId,
  disclosureOtherSponsor, disclosureReceipt, disclosureSponsor, disclosureTarget,
} from "../fixtures/directive-disclosure";

mock.module("server-only", () => ({}));
const { stoaDirectiveDisclosure, stoaRecordDirectiveDisclosure } = await import("../../lib/directive-disclosures");
const envKeys = ["STOA_ORIGIN", "SERVICE_ENVELOPE_PRIVATE_KEY_HEX", "SERVICE_ENVELOPE_KID"] as const;
const realFetch = globalThis.fetch;
let previous: Map<string, string | undefined>;
beforeEach(() => {
  previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "13".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "disclosure-test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("disclosure reads and declarations sign the exact claim version and current sponsor", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(init?.method === "GET" ? disclosureInitial : disclosureReceipt);
  }) as unknown as typeof fetch;
  expect(await stoaDirectiveDisclosure(disclosureSponsor, disclosureTarget))
    .toEqual({ ok: true, data: disclosureInitial });
  expect(await stoaRecordDirectiveDisclosure(disclosureSponsor, disclosureTarget, disclosureCommand, "retain-this-declaration"))
    .toEqual({ ok: true, data: disclosureReceipt });
  for (const call of calls) {
    const isRead = call.init.method === "GET";
    const body = isRead ? "" : JSON.stringify(disclosureCommand);
    expect(call.url).toBe(`${PRODUCTION_STOA_ORIGIN}/v1/sponsors/disclosures/P-4DSP/C-7/2`);
    expect(call.init).toMatchObject({ credentials: "omit", cache: "no-store", redirect: "error" });
    expect(call.init.body).toBe(isRead ? undefined : body);
    const headers = new Headers(call.init.headers);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
    expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
      principal_type: "sponsor", principal_id: disclosureSponsor,
      route: "/v1/sponsors/disclosures/:problemId/:claimId/:version",
      action: `sponsor.disclosure.${isRead ? "read" : "write"}`,
      payload_sha256: await payloadDigest(body),
    });
    if (!isRead) expect(headers.get("idempotency-key")).toBe("retain-this-declaration");
  }
});

test("malformed targets, caller-supplied authority and invalid keys never dispatch", async () => {
  const request = mock(async () => Response.json(disclosureReceipt));
  globalThis.fetch = request as unknown as typeof fetch;
  expect((await stoaDirectiveDisclosure(disclosureSponsor, { ...disclosureTarget, claimId: "../C-7" })).ok).toBe(false);
  expect((await stoaRecordDirectiveDisclosure(disclosureSponsor, { ...disclosureTarget, version: 1.5 }, disclosureCommand, "key")).ok).toBe(false);
  expect((await stoaRecordDirectiveDisclosure(disclosureSponsor, disclosureTarget, disclosureCommand, "bad key")).ok).toBe(false);
  expect((await stoaRecordDirectiveDisclosure(disclosureSponsor, disclosureTarget, disclosureCommand, "key\n")).ok).toBe(false);
  for (const extra of [
    { sponsor_id: disclosureOtherSponsor }, { authored_by_current_sponsor: true },
    { unresolved_transferred_directives: [] }, { step_up_authenticated_at: 9999999999 },
  ]) {
    expect((await stoaRecordDirectiveDisclosure(disclosureSponsor, disclosureTarget,
      { ...disclosureCommand, ...extra } as SponsorDirectiveDisclosureRequest, "key")).ok).toBe(false);
  }
  expect(request).not.toHaveBeenCalled();
});

test("an initial enrollment instruction has its own exact public source kind", async () => {
  const command: SponsorDirectiveDisclosureRequest = { ...disclosureCommand, decision: "disclose", disclosures: [{
    directive_id: disclosureInitialInstructionId, source_kind: "enrollment-instruction",
    scope: "Initial study direction", summary: "The sponsor asked the Fellow to examine the endpoint before generalizing.",
  }] };
  const receipt = { ...disclosureReceipt, decision: "disclose" as const, disclosures: command.disclosures };
  let response: unknown = receipt;
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  expect(await stoaRecordDirectiveDisclosure(disclosureSponsor, disclosureTarget, command, "initial-instruction-key"))
    .toEqual({ ok: true, data: receipt });
  response = { ...receipt, disclosures: [{ ...command.disclosures[0], source_kind: "directive" }] };
  expect(await stoaRecordDirectiveDisclosure(disclosureSponsor, disclosureTarget, command, "initial-instruction-key"))
    .toEqual({ ok: false, reason: "unreachable" });
});

test("a private inspection cannot substitute claim identity or another sponsor's authority and bytes", async () => {
  let value: unknown;
  globalThis.fetch = mock(async () => Response.json(value)) as unknown as typeof fetch;
  for (const candidate of [
    { ...disclosureInitial, target: { ...disclosureInitial.target, version: 3 } },
    { ...disclosureInitial, scopes: disclosureInitial.scopes.map((scope) => ({ ...scope, can_attest: true })) },
    { ...disclosureInitial, scopes: disclosureInitial.scopes.map((scope) => scope.can_attest ? scope : {
      ...scope, directives: disclosureInitial.scopes[0]!.directives,
    }) },
    { ...disclosureCompleted, scopes: disclosureCompleted.scopes.map((scope) => scope.receipt === null ? scope : {
      ...scope, receipt: { ...scope.receipt, sponsor_id: disclosureOtherSponsor },
    }) },
    { ...disclosureInitial, private_workshop_body: "UNRELATED_PRIVATE_FIXTURE" },
  ]) {
    value = candidate;
    expect(await stoaDirectiveDisclosure(disclosureSponsor, disclosureTarget))
      .toEqual({ ok: false, reason: "unreachable" });
  }
});

test("a receipt must match the target, sponsor, scope, revision, decision and actual public summaries", async () => {
  let value: unknown;
  globalThis.fetch = mock(async () => Response.json(value)) as unknown as typeof fetch;
  for (const candidate of [
    { ...disclosureReceipt, target: { ...disclosureReceipt.target, claim_id: "C-8" } },
    { ...disclosureReceipt, sponsor_id: disclosureOtherSponsor },
    { ...disclosureReceipt, scope_id: "f".repeat(64) },
    { ...disclosureReceipt, revision: 2 },
    { ...disclosureReceipt, decision: "withdraw" },
  ]) {
    value = candidate;
    expect(await stoaRecordDirectiveDisclosure(disclosureSponsor, disclosureTarget, disclosureCommand, "key"))
      .toEqual({ ok: false, reason: "unreachable" });
  }
  const command: SponsorDirectiveDisclosureRequest = { ...disclosureCommand, decision: "disclose", disclosures: [{
    directive_id: disclosureDirectiveId, source_kind: "directive", scope: "Boundary case selection", summary: "The sponsor requested an explicit endpoint check.",
  }] };
  value = { ...disclosureReceipt, decision: "disclose", disclosures: [{ ...command.disclosures[0], summary: "SUBSTITUTED_PUBLIC_SUMMARY" }] };
  expect(await stoaRecordDirectiveDisclosure(disclosureSponsor, disclosureTarget, command, "key"))
    .toEqual({ ok: false, reason: "unreachable" });
  value = { ...disclosureReceipt, decision: "disclose", disclosures: command.disclosures };
  expect((await stoaRecordDirectiveDisclosure(disclosureSponsor, disclosureTarget, command, "key")).ok).toBe(true);
});

test("an uncertain response can recover with exactly the same declaration and key", async () => {
  const bodies: unknown[] = [];
  const keys: unknown[] = [];
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(init?.body);
    keys.push(new Headers(init?.headers).get("idempotency-key"));
    if (bodies.length === 1) throw new Error("synthetic lost response");
    return Response.json(disclosureReceipt);
  }) as unknown as typeof fetch;
  expect(await stoaRecordDirectiveDisclosure(disclosureSponsor, disclosureTarget, disclosureCommand, "exact-retry-key"))
    .toEqual({ ok: false, reason: "unreachable" });
  expect(await stoaRecordDirectiveDisclosure(disclosureSponsor, disclosureTarget, disclosureCommand, "exact-retry-key"))
    .toEqual({ ok: true, data: disclosureReceipt });
  expect(bodies).toEqual([JSON.stringify(disclosureCommand), JSON.stringify(disclosureCommand)]);
  expect(keys).toEqual(["exact-retry-key", "exact-retry-key"]);
});

test("screening holds remain unpublished outcomes and oversized private reads fail closed", async () => {
  const held = { code: "SCREENING_HOLD", coarse_category: "injection", appeal: "SPONSOR_APPEAL_AVAILABLE", case_id: `QC-${"0".repeat(26)}` } as const;
  globalThis.fetch = mock(async () => Response.json(held, { status: 202 })) as unknown as typeof fetch;
  expect(await stoaRecordDirectiveDisclosure(disclosureSponsor, disclosureTarget, disclosureCommand, "held-key"))
    .toEqual({ ok: false, reason: "refused", status: 202, screening: held });
  globalThis.fetch = mock(async () => new Response("x".repeat(DIRECTIVE_DISCLOSURE_MAX_RESPONSE_BYTES + 1))) as unknown as typeof fetch;
  expect(await stoaDirectiveDisclosure(disclosureSponsor, disclosureTarget))
    .toEqual({ ok: false, reason: "unreachable" });
});
