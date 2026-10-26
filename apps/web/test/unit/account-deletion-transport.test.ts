import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN, type SponsorAccountDeleteRequest } from "@asimposium/contracts";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";
import { deletionCommand, deletionPreview, deletionReceipt, deletionSponsor } from "../fixtures/account-deletion";

mock.module("server-only", () => ({}));
const { stoaAccountDeletionPreview, stoaDeleteAccount } = await import("../../lib/account-deletion");
const envKeys = ["STOA_ORIGIN", "SERVICE_ENVELOPE_PRIVATE_KEY_HEX", "SERVICE_ENVELOPE_KID"] as const;
const realFetch = globalThis.fetch;
let previous: Map<string, string | undefined>;
beforeEach(() => {
  previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "14".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "deletion-test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("deletion preview and confirmation sign the exact account, impact and stable retry key", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(init?.method === "GET" ? deletionPreview : deletionReceipt);
  }) as unknown as typeof fetch;
  expect(await stoaAccountDeletionPreview(deletionSponsor)).toEqual({ ok: true, data: deletionPreview });
  expect(await stoaDeleteAccount(deletionSponsor, deletionCommand, "reviewed-deletion-key"))
    .toEqual({ ok: true, data: deletionReceipt });
  for (const call of calls) {
    const read = call.init.method === "GET";
    const path = `/v1/sponsors/account/${read ? "delete-preview" : "delete"}`;
    const body = read ? "" : JSON.stringify(deletionCommand);
    expect(call.url).toBe(`${PRODUCTION_STOA_ORIGIN}${path}`);
    expect(call.init).toMatchObject({ credentials: "omit", cache: "no-store", redirect: "error" });
    expect(call.init.body).toBe(read ? undefined : body);
    const headers = new Headers(call.init.headers);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
    expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
      principal_type: "sponsor", principal_id: deletionSponsor, route: path,
      action: `sponsor.account.${read ? "delete-preview" : "delete"}`,
      payload_sha256: await payloadDigest(body),
    });
    if (!read) expect(headers.get("idempotency-key")).toBe("reviewed-deletion-key");
  }
});

test("missing review, injected authority, malformed principals and retry keys never dispatch", async () => {
  const request = mock(async () => Response.json(deletionReceipt));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const candidate of [
    { ...deletionCommand, expected_preview: undefined }, { ...deletionCommand, sponsor_id: "usr_victim" },
    { ...deletionCommand, expected_preview: { ...deletionPreview.review, digest: "changed" } },
    { ...deletionCommand, confirm: "delete" },
  ]) expect((await stoaDeleteAccount(deletionSponsor, candidate as SponsorAccountDeleteRequest, "key")).ok).toBe(false);
  for (const key of ["", "bad key", "key\n", "x".repeat(161)]) {
    expect((await stoaDeleteAccount(deletionSponsor, deletionCommand, key)).ok).toBe(false);
  }
  expect((await stoaAccountDeletionPreview("../usr_victim")).ok).toBe(false);
  expect(request).not.toHaveBeenCalled();
});

test("private preview and deletion receipts cannot substitute a different owner or reviewed impact", async () => {
  let value: unknown;
  globalThis.fetch = mock(async () => Response.json(value)) as unknown as typeof fetch;
  value = { ...deletionPreview, sponsor_id: "usr_other" };
  expect(await stoaAccountDeletionPreview(deletionSponsor)).toEqual({ ok: false, reason: "unreachable" });
  for (const candidate of [
    { ...deletionReceipt, sponsor_id: "usr_other" },
    { ...deletionReceipt, review: { ...deletionReceipt.review, digest: `sha256:${"c".repeat(64)}` } },
    { ...deletionReceipt, retention_control_record: { ...deletionReceipt.retention_control_record, targetId: "usr_other" } },
    { ...deletionReceipt, retention_control_record: { ...deletionReceipt.retention_control_record, action: "unrelated" } },
    { ...deletionReceipt, deletion_receipt: { ...deletionReceipt.deletion_receipt, targetType: "problem" } },
    { ...deletionReceipt, deletion_receipt: { ...deletionReceipt.deletion_receipt, deletedAt: "2020-01-01T00:00:00.000Z" } },
  ]) {
    value = candidate;
    expect(await stoaDeleteAccount(deletionSponsor, deletionCommand, "key"))
      .toEqual({ ok: false, reason: "unreachable" });
  }
});

test("a lost response recovers only with the same reviewed body and retry key", async () => {
  const bodies: unknown[] = [];
  const keys: unknown[] = [];
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(init?.body);
    keys.push(new Headers(init?.headers).get("idempotency-key"));
    if (bodies.length === 1) throw new Error("synthetic lost response");
    return Response.json(deletionReceipt);
  }) as unknown as typeof fetch;
  expect(await stoaDeleteAccount(deletionSponsor, deletionCommand, "original-deletion-key"))
    .toEqual({ ok: false, reason: "unreachable" });
  expect(await stoaDeleteAccount(deletionSponsor, deletionCommand, "original-deletion-key"))
    .toEqual({ ok: true, data: deletionReceipt });
  expect(bodies).toEqual([JSON.stringify(deletionCommand), JSON.stringify(deletionCommand)]);
  expect(keys).toEqual(["original-deletion-key", "original-deletion-key"]);
});
