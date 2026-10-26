import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  SPONSOR_DATA_EXPORT_EXCLUSIONS,
  SPONSOR_DATA_EXPORT_FORMAT,
  type SponsorDataExportResponse,
} from "@asimposium/contracts/account-export";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";

mock.module("server-only", () => ({}));
const { stoaSponsorDataExportPage } = await import("../../lib/account-export");

const principalId = "usr_export_transport";
const snapshot = { revision: 8, exported_at: "2026-10-26T01:00:00.000Z" };
const first: SponsorDataExportResponse = {
  version: SPONSOR_DATA_EXPORT_FORMAT, sponsor_id: principalId, snapshot, section: "account",
  records: [{ kind: "account", data: { sponsor_id: principalId, created_at: 1, active_fellow_limit: 5 } }],
  next_cursor: { snapshot, section: "fellows", after: 0 }, omitted: [...SPONSOR_DATA_EXPORT_EXCLUSIONS],
};
const second: SponsorDataExportResponse = {
  ...first, section: "fellows", records: [], next_cursor: { snapshot, section: "enrollments", after: 0 },
};
const envKeys = ["STOA_ORIGIN", "SERVICE_ENVELOPE_PRIVATE_KEY_HEX", "SERVICE_ENVELOPE_KID"] as const;
const realFetch = globalThis.fetch;
let previous: Map<string, string | undefined>;
beforeEach(() => {
  previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "12".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "export-test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("every export page signs the current sponsor and exact cursor body without cookies", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(calls.length === 1 ? first : second);
  }) as unknown as typeof fetch;
  expect(await stoaSponsorDataExportPage(principalId, {})).toEqual({ ok: true, data: first });
  expect(await stoaSponsorDataExportPage(principalId, { cursor: first.next_cursor! }))
    .toEqual({ ok: true, data: second });
  for (const [index, call] of calls.entries()) {
    const body = JSON.stringify(index === 0 ? {} : { cursor: first.next_cursor });
    expect(call.url).toBe(`${PRODUCTION_STOA_ORIGIN}/v1/sponsors/account/export-page`);
    expect(call.init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store", body });
    const headers = new Headers(call.init.headers);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
    expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
      principal_type: "sponsor", principal_id: principalId, method: "POST",
      route: "/v1/sponsors/account/export-page", action: "sponsor.account.export-page",
      payload_sha256: await payloadDigest(body),
    });
  }
});

test("response account, section, snapshot and strict schemas are validated before private bytes leave the adapter", async () => {
  let result: unknown;
  globalThis.fetch = mock(async () => Response.json(result)) as unknown as typeof fetch;
  for (const bad of [
    { ...first, sponsor_id: "usr_other" },
    { ...first, section: "fellows", records: [] },
    { ...first, credential: "private-credential-material" },
  ]) {
    result = bad;
    expect(await stoaSponsorDataExportPage(principalId, {})).toEqual({ ok: false, reason: "unreachable" });
  }
  for (const bad of [
    { ...second, sponsor_id: "usr_other" },
    { ...second, snapshot: { ...snapshot, revision: 9 }, next_cursor: null },
    { ...second, snapshot: { ...snapshot, exported_at: "2026-10-26T02:00:00.000Z" }, next_cursor: null },
    { ...second, section: "enrollments" },
  ]) {
    result = bad;
    expect(await stoaSponsorDataExportPage(principalId, { cursor: first.next_cursor! }))
      .toEqual({ ok: false, reason: "unreachable" });
  }
});

test("browser-supplied identity fields and invalid sponsor principals are never dispatched", async () => {
  const dispatch = mock(async () => Response.json(first));
  globalThis.fetch = dispatch as unknown as typeof fetch;
  expect((await stoaSponsorDataExportPage(principalId, { sponsor_id: "usr_other" } as never)).ok).toBe(false);
  expect((await stoaSponsorDataExportPage("../not-an-account", {})).ok).toBe(false);
  expect(dispatch).not.toHaveBeenCalled();
});
