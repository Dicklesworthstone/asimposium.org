import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SponsorAccountDeletePreviewResponse, SponsorAccountDeleteResponse } from "@asimposium/contracts";
import type { AccountDeletionIntent } from "../../app/console/account/actions";
import type { StoaCall } from "../../lib/stoa";
import {
  accountDeletionRecoveryKey, clearPendingAccountDeletion, parsePendingAccountDeletion,
  persistPendingAccountDeletion, type PendingAccountDeletion,
} from "../../lib/account-deletion-recovery";
import { deletionPreview, deletionReceipt, deletionSponsor } from "../fixtures/account-deletion";

mock.module("server-only", () => ({}));
const intent: AccountDeletionIntent = {
  confirm: "delete-sponsor-account-and-revoke-all-fellows", expected_preview: deletionPreview.review,
};
const pending: PendingAccountDeletion = { version: "asimposium.account-deletion-recovery.v1",
  sponsor_id: deletionSponsor, preview: deletionPreview, idempotency_key: "persistent-deletion-key" };
let identity: string | null;
let issuedAt: number | undefined;
let readResult: StoaCall<SponsorAccountDeletePreviewResponse>;
let writeResult: StoaCall<SponsorAccountDeleteResponse>;
let failWrite: boolean;
const reads: unknown[][] = [];
const writes: unknown[][] = [];
let realAuth: typeof import("../../auth");
let realTransport: typeof import("../../lib/account-deletion");
let actions: typeof import("../../app/console/account/actions");
let control: typeof import("../../components/account-deletion-control");
beforeAll(async () => {
  realAuth = { ...(await import("../../auth")) };
  realTransport = { ...(await import("../../lib/account-deletion")) };
  mock.module("@/auth", () => ({ ...realAuth,
    auth: async () => identity === null ? null : { user: { id: identity }, authIssuedAt: issuedAt },
  }));
  mock.module("@/lib/account-deletion", () => ({ ...realTransport,
    stoaAccountDeletionPreview: async (...args: unknown[]) => { reads.push(args); return readResult; },
    stoaDeleteAccount: async (...args: unknown[]) => {
      writes.push(args);
      if (failWrite) throw new Error("PRIVATE_INTERNAL_DIAGNOSTIC");
      return writeResult;
    },
  }));
  actions = await import("../../app/console/account/actions");
  control = await import("../../components/account-deletion-control");
});
beforeEach(() => {
  identity = deletionSponsor;
  issuedAt = Math.floor(Date.now() / 1000) - 5;
  readResult = { ok: true, data: deletionPreview };
  writeResult = { ok: true, data: deletionReceipt };
  failWrite = false;
  reads.length = 0;
  writes.length = 0;
});
afterAll(() => {
  mock.module("@/auth", () => realAuth);
  mock.module("@/lib/account-deletion", () => realTransport);
});

test("explicit preview is read-only and confirmation uses current server authentication evidence", async () => {
  issuedAt = 0;
  expect(await actions.prepareAccountDeletion(deletionSponsor)).toEqual({ ok: true, preview: deletionPreview });
  expect(reads).toEqual([[deletionSponsor]]);
  expect(writes).toHaveLength(0);
  issuedAt = Math.floor(Date.now() / 1000);
  expect(await actions.confirmAccountDeletion(deletionSponsor, intent, "retained-key"))
    .toEqual({ ok: true, receipt: deletionReceipt });
  expect(writes).toEqual([[deletionSponsor, { ...intent, step_up_authenticated_at: issuedAt }, "retained-key"]]);
});

test("changed identity, stale authentication and injected client authority cannot dispatch", async () => {
  for (const who of [null, "usr_another_account", "../private"]) {
    identity = who;
    expect((await actions.prepareAccountDeletion(deletionSponsor)).ok).toBe(false);
    expect((await actions.confirmAccountDeletion(deletionSponsor, intent, "key")).ok).toBe(false);
  }
  identity = deletionSponsor;
  for (const time of [undefined, 0, Math.floor(Date.now() / 1000) - 961,
    Math.floor(Date.now() / 1000) + 61, Number.NaN, 1.5]) {
    issuedAt = time;
    expect((await actions.confirmAccountDeletion(deletionSponsor, intent, "key")).ok).toBe(false);
  }
  issuedAt = Math.floor(Date.now() / 1000);
  for (const value of [
    { ...intent, sponsor_id: "usr_another_account" }, { ...intent, step_up_authenticated_at: issuedAt },
    { ...intent, confirm: "delete" }, { ...intent, expected_preview: undefined },
  ]) expect((await actions.confirmAccountDeletion(deletionSponsor, value as AccountDeletionIntent, "key")).ok).toBe(false);
  for (const key of ["", "bad key", "key\n"]) {
    expect((await actions.confirmAccountDeletion(deletionSponsor, intent, key)).ok).toBe(false);
  }
  expect(reads).toHaveLength(0);
  expect(writes).toHaveLength(0);
});

test("changed impact starts a new review; uncertain responses and authorization preserve the original intent", async () => {
  writeResult = { ok: false, reason: "refused", status: 409, problemCode: "OBJECT_VERSION_CONFLICT" };
  expect(await actions.confirmAccountDeletion(deletionSponsor, intent, "key"))
    .toMatchObject({ ok: false, recovery: "review" });
  for (const failure of [
    { ok: false, reason: "unreachable" }, { ok: false, reason: "unconfigured" },
    { ok: false, reason: "refused", status: 503 },
    { ok: false, reason: "refused", status: 409, problemCode: "IDEMPOTENCY_CONFLICT" },
  ] as const) {
    writeResult = failure;
    const result = await actions.confirmAccountDeletion(deletionSponsor, intent, "key");
    expect(result).toMatchObject({ ok: false, recovery: "retain" });
  }
  writeResult = { ok: false, reason: "refused", status: 403 };
  expect(await actions.confirmAccountDeletion(deletionSponsor, intent, "key"))
    .toMatchObject({ ok: false, recovery: "retain", reauthenticate: true });
  failWrite = true;
  const interrupted = await actions.confirmAccountDeletion(deletionSponsor, intent, "key");
  expect(interrupted).toMatchObject({ ok: false, recovery: "retain" });
  expect(JSON.stringify(interrupted)).not.toContain("PRIVATE_INTERNAL_DIAGNOSTIC");
});

test("initial rendering cannot delete and clearly separates retained history from the counted operations", () => {
  const html = renderToStaticMarkup(<control.AccountDeletionControl principalId={deletionSponsor} canDelete />);
  expect(html).toContain("Review exact deletion impact");
  expect(html).toContain("disabled");
  expect(html).toContain("bilateral transfer");
  expect(html).toContain("not confirmed erased");
  expect(html).toContain("tombstoned sponsor attribution");
  expect(html).not.toContain("Delete account and revoke Fellows");
  expect(reads).toHaveLength(0);
  expect(writes).toHaveLength(0);
});

function memoryStorage() {
  const records = new Map<string, string>();
  return { records, getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); },
    removeItem: (key: string) => { records.delete(key); } };
}

test("recovery persists and reads back exact intent before dispatch and cannot replace an unresolved confirmation", () => {
  const storage = memoryStorage();
  persistPendingAccountDeletion(storage, pending);
  expect(parsePendingAccountDeletion(storage.getItem(accountDeletionRecoveryKey(deletionSponsor))!, deletionSponsor))
    .toEqual(pending);
  persistPendingAccountDeletion(storage, pending);
  expect(() => persistPendingAccountDeletion(storage, { ...pending, idempotency_key: "different" })).toThrow();
  expect(() => clearPendingAccountDeletion(storage, { ...pending, idempotency_key: "different" })).toThrow();
  expect(storage.records.size).toBe(1);
  clearPendingAccountDeletion(storage, pending);
  expect(storage.records.size).toBe(0);
  expect(() => persistPendingAccountDeletion({ getItem: () => null, setItem: () => {} }, pending)).toThrow();
});

test("recovery is account-scoped, bounded, strict and contains no client authentication override", () => {
  for (const value of [
    { ...pending, sponsor_id: "usr_other" }, { ...pending, preview: { ...deletionPreview, sponsor_id: "usr_other" } },
    { ...pending, step_up_authenticated_at: 9999999999 }, { ...pending, idempotency_key: "bad key" },
    { ...pending, idempotency_key: "key\n" }, { ...pending, version: "unknown" },
    { ...pending, preview: { ...deletionPreview, private_body: "PRIVATE_BYTES" } },
  ]) expect(() => parsePendingAccountDeletion(JSON.stringify(value), deletionSponsor)).toThrow();
  expect(() => parsePendingAccountDeletion(JSON.stringify(pending), "usr_other")).toThrow();
  expect(() => parsePendingAccountDeletion("x".repeat(16_385), deletionSponsor)).toThrow();
  expect(() => accountDeletionRecoveryKey("../private")).toThrow();
});
