import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SponsorAccountDeletePreviewResponseSchema,
  SponsorAccountDeleteResponseSchema,
  SponsorAccountExportResponseSchema,
  SponsorFellowTransferAcceptResponseSchema,
  SponsorFellowTransferInitiateResponseSchema,
  SponsorFellowTransferListResponseSchema,
  SponsorFellowTransferSummarySchema,
} from "@asimposium/contracts";
import type { Hono } from "hono";
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "../../../web/lib/service-envelope.ts";
import { toHex } from "../../src/auth/canonical";
import { authenticateServiceEnvelopeRequest } from "../../src/auth/http";
import { VerificationKeyring } from "../../src/auth/keyring";
import { MemoryNonceStore } from "../../src/auth/nonce";
import { loadFellowCard } from "../../src/discovery/fellow-service.ts";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import { createEnrollmentRouter } from "../../src/enrollment/router.ts";
import {
  EnrollmentService,
  type EnrollmentStore,
  enrollmentReplayProtectorFromBase64Url,
  InMemoryEnrollmentStore,
} from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");
const NOW = 1_786_000_000;
const TEST_STOA_ORIGIN = "https://a.asimposium.org";
const SPONSOR_A = "usr_01JXYZSPONSORA00000000";
const SPONSOR_B = "usr_01JXYZSPONSORB00000000";
const SPONSOR_FOREIGN = "usr_01JXYZSPONSORC00000000";

type LocalBinding = string | number | null;

function localD1(sqlite: Database) {
  const prepare = (query: string) => {
    const methods = (...values: LocalBinding[]) => ({
      async run() {
        if (/^\s*SELECT\b/i.test(query)) {
          const rows = sqlite.prepare<unknown, LocalBinding[]>(query).all(...values);
          return { results: rows, meta: { changes: 0 } };
        }
        const result = sqlite.prepare<unknown, LocalBinding[]>(query).run(...values);
        return { results: [], meta: { changes: result.changes } };
      },
      async first<T>(): Promise<T | null> {
        const row = sqlite.prepare<T, LocalBinding[]>(query).get(...values);
        return (row ?? null) as T | null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        const rows = sqlite.prepare<T, LocalBinding[]>(query).all(...values) as T[];
        return { results: rows };
      },
    });
    return {
      bind(...values: LocalBinding[]) {
        return methods(...values);
      },
      ...methods(),
    };
  };

  return {
    prepare,
    async batch(statements: readonly { run(): Promise<unknown> }[]) {
      sqlite.run("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.run("COMMIT");
        return results;
      } catch (error) {
        sqlite.run("ROLLBACK");
        throw error;
      }
    },
  } as unknown as Env["DB"];
}

function createMigratedDb(): { db: Env["DB"]; raw: Database } {
  const sqlite = new Database(":memory:", { strict: true });
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.run(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return { db: localD1(sqlite), raw: sqlite };
}

class MutableClock {
  value: number;
  constructor(initial = NOW * 1_000) {
    this.value = initial;
  }
  now(): number {
    return this.value;
  }
}

interface TestHarness {
  app: Hono;
  service: EnrollmentService;
  store: EnrollmentStore;
  clock: MutableClock;
  sign(
    body: string | Uint8Array,
    route: string,
    action: string,
    method?: string,
    principalId?: string,
  ): Promise<Headers>;
}

async function createTestHarness(customStore?: EnrollmentStore): Promise<TestHarness> {
  const clock = new MutableClock();
  const store = customStore ?? new InMemoryEnrollmentStore();
  const keypair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const keyring = new VerificationKeyring([
    {
      kid: "agora-sponsor-test",
      publicKeyHex: toHex(new Uint8Array(await crypto.subtle.exportKey("raw", keypair.publicKey))),
      notBefore: 0,
    },
  ]);
  const nonces = new MemoryNonceStore();
  const service = new EnrollmentService({
    stoaOrigin: TEST_STOA_ORIGIN,
    agoraOrigin: "https://asimposium.org",
    store,
    replayProtector: enrollmentReplayProtectorFromBase64Url(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ),
    clock,
  });

  let seq = 0;
  const sign = async (
    body: string | Uint8Array,
    route: string,
    action: string,
    method = "POST",
    principalId = SPONSOR_A,
  ): Promise<Headers> => {
    const envelope = await mintServiceEnvelope({
      privateKey: keypair.privateKey,
      kid: "agora-sponsor-test",
      now: Math.floor(clock.now() / 1_000),
      method,
      route,
      action,
      principalId,
      body,
    });
    const headers = new Headers(serviceEnvelopeHeaders(envelope));
    if (method === "POST") {
      seq += 1;
      headers.set("idempotency-key", `test-key-${seq}`);
    }
    return headers;
  };

  const app = createEnrollmentRouter({
    service,
    verifiedSponsor: async (request, route, action) => {
      const result = await authenticateServiceEnvelopeRequest(request, {
        keyring,
        nonces,
        now: Math.floor(clock.now() / 1_000),
        issuer: "agora",
        audience: "stoa",
        route,
        permittedActions: [action],
      });
      if (!result.ok) return result.response;
      return {
        principal: {
          type: "sponsor",
          sponsorId: result.verification.principal.id,
        } as const,
        rawBody: result.rawBody,
      };
    },
  });

  return { app, service, store, clock, sign };
}

describe("W3.8 Sponsor/Fellow Lifecycle: Transfer, Export, Deletion", () => {
  describe("EnrollmentService & InMemoryEnrollmentStore", () => {
    test("complete bilateral transfer flow with pause, credential revocation, and step-up enforcement", async () => {
      const { service, clock } = await createTestHarness();
      const sponsorAPrincipal = { type: "sponsor" as const, sponsorId: SPONSOR_A };
      const sponsorBPrincipal = { type: "sponsor" as const, sponsorId: SPONSOR_B };
      const foreignPrincipal = { type: "sponsor" as const, sponsorId: SPONSOR_FOREIGN };

      await service.bootstrapSponsor(sponsorAPrincipal);
      await service.bootstrapSponsor(sponsorBPrincipal);

      // Mint and approve a Fellow for sponsor A
      const mint = await service.mint(sponsorAPrincipal, {
        requested_scopes: ["review"],
      });
      const claim = await service.claim({
        enrollment_id: mint.enrollmentId,
        secret: mint.secret,
        name: "test-fellow-orchid",
        model: "openai/gpt-5",
        harness: "codex",
      });
      await service.decide(sponsorAPrincipal, mint.enrollmentId, {
        enrollment_id: mint.enrollmentId,
        decision: "approve",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });

      const poll = await service.poll({ flow_handle: claim.flowHandle });
      expect(poll.status).toBe("approved");
      const approved = poll as { status: "approved"; token: string };
      const initialBinding = await service.credentialBinding(approved.token);
      expect(initialBinding).toBeDefined();
      expect(initialBinding?.sponsorId).toBe(SPONSOR_A);
      const fellowId = initialBinding!.fellowId;
      const initialToken = approved.token;

      // Step-up verification failure
      expect(
        service.initiateSponsorFellowTransfer(sponsorAPrincipal, {
          fellow_id: fellowId,
          target_sponsor_id: SPONSOR_B,
          confirm: "initiate-fellow-transfer",
          step_up_authenticated_at: 0,
        }),
      ).rejects.toThrow("STEP_UP_REQUIRED");

      // Transfer to self forbidden
      expect(
        service.initiateSponsorFellowTransfer(sponsorAPrincipal, {
          fellow_id: fellowId,
          target_sponsor_id: SPONSOR_A,
          confirm: "initiate-fellow-transfer",
          step_up_authenticated_at: Math.floor(clock.now() / 1_000),
        }),
      ).rejects.toThrow("TRANSFER_SELF_FORBIDDEN");

      // Non-owner cannot initiate transfer
      expect(
        service.initiateSponsorFellowTransfer(sponsorBPrincipal, {
          fellow_id: fellowId,
          target_sponsor_id: SPONSOR_A,
          confirm: "initiate-fellow-transfer",
          step_up_authenticated_at: Math.floor(clock.now() / 1_000),
        }),
      ).rejects.toThrow("TRANSFER_FELLOW_NOT_OWNED");

      // Initiate valid transfer
      const initiateRes = await service.initiateSponsorFellowTransfer(sponsorAPrincipal, {
        fellow_id: fellowId,
        target_sponsor_id: SPONSOR_B,
        confirm: "initiate-fellow-transfer",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      const parsedInitiate = SponsorFellowTransferInitiateResponseSchema.parse(initiateRes);
      expect(parsedInitiate.transfer_id.startsWith("TRF-")).toBe(true);
      expect(parsedInitiate.status).toBe("pending");
      expect(parsedInitiate.manifest.fellow_id).toBe(fellowId);
      expect(parsedInitiate.manifest.private_workshop_access_moves).toBe(true);
      expect(parsedInitiate.manifest.credential_rotation_required).toBe(true);
      expect(parsedInitiate.manifest.public_attribution_immutable).toBe(true);

      const transferId = parsedInitiate.transfer_id;

      // Cannot initiate second transfer while one is pending
      expect(
        service.initiateSponsorFellowTransfer(sponsorAPrincipal, {
          fellow_id: fellowId,
          target_sponsor_id: SPONSOR_B,
          confirm: "initiate-fellow-transfer",
          step_up_authenticated_at: Math.floor(clock.now() / 1_000),
        }),
      ).rejects.toThrow("TRANSFER_PENDING_EXISTS");

      // List transfers
      const listA = await service.listSponsorFellowTransfers(sponsorAPrincipal);
      expect(listA.outgoing.length).toBe(1);
      expect(listA.outgoing[0]?.transfer_id).toBe(transferId);
      expect(listA.incoming.length).toBe(0);

      const listB = await service.listSponsorFellowTransfers(sponsorBPrincipal);
      expect(listB.incoming.length).toBe(1);
      expect(listB.incoming[0]?.transfer_id).toBe(transferId);
      expect(listB.outgoing.length).toBe(0);

      // Get transfer
      const getRes = await service.getSponsorFellowTransfer(sponsorBPrincipal, transferId);
      expect(getRes.transfer_id).toBe(transferId);
      expect(getRes.status).toBe("pending");

      // Foreign sponsor cannot get transfer
      expect(service.getSponsorFellowTransfer(foreignPrincipal, transferId)).rejects.toThrow(
        "TRANSFER_UNAUTHORIZED",
      );

      // Target sponsor cannot cancel
      expect(
        service.cancelSponsorFellowTransfer(sponsorBPrincipal, {
          transfer_id: transferId,
          confirm: "cancel-fellow-transfer",
          step_up_authenticated_at: Math.floor(clock.now() / 1_000),
        }),
      ).rejects.toThrow("TRANSFER_UNAUTHORIZED");

      // Source sponsor cannot accept or reject
      expect(
        service.acceptSponsorFellowTransfer(sponsorAPrincipal, {
          transfer_id: transferId,
          confirm: "accept-fellow-transfer",
          step_up_authenticated_at: Math.floor(clock.now() / 1_000),
        }),
      ).rejects.toThrow("TRANSFER_UNAUTHORIZED");
      expect(
        service.rejectSponsorFellowTransfer(sponsorAPrincipal, {
          transfer_id: transferId,
          confirm: "reject-fellow-transfer",
          step_up_authenticated_at: Math.floor(clock.now() / 1_000),
        }),
      ).rejects.toThrow("TRANSFER_UNAUTHORIZED");

      // Target sponsor accepts transfer
      const acceptRes = await service.acceptSponsorFellowTransfer(sponsorBPrincipal, {
        transfer_id: transferId,
        confirm: "accept-fellow-transfer",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      const parsedAccept = SponsorFellowTransferAcceptResponseSchema.parse(acceptRes);
      expect(parsedAccept.acknowledged).toBe(true);
      expect(parsedAccept.fellow_status).toBe("paused");
      expect(parsedAccept.rebind_required).toBe(true);
      expect(parsedAccept.revoked_credentials_count).toBeGreaterThanOrEqual(1);

      // Old credential is now revoked!
      const revokedBinding = await service.credentialBinding(initialToken);
      expect(revokedBinding).toBeUndefined();

      // Resolved transfer cannot be accepted again
      expect(
        service.acceptSponsorFellowTransfer(sponsorBPrincipal, {
          transfer_id: transferId,
          confirm: "accept-fellow-transfer",
          step_up_authenticated_at: Math.floor(clock.now() / 1_000),
        }),
      ).rejects.toThrow("TRANSFER_NOT_PENDING");

      // Fellow is now owned by Sponsor B
      const fellowsB = await service.fellowPage(sponsorBPrincipal);
      expect(fellowsB.fellows.some((f) => f.fellowId === fellowId)).toBe(true);
      const fellowsA = await service.fellowPage(sponsorAPrincipal);
      expect(fellowsA.fellows.some((f) => f.fellowId === fellowId)).toBe(false);
    });

    test("transfer cancellation and rejection lifecycle", async () => {
      const { service, clock } = await createTestHarness();
      const sponsorAPrincipal = { type: "sponsor" as const, sponsorId: SPONSOR_A };
      const sponsorBPrincipal = { type: "sponsor" as const, sponsorId: SPONSOR_B };

      await service.bootstrapSponsor(sponsorAPrincipal);
      await service.bootstrapSponsor(sponsorBPrincipal);

      // Create Fellow
      const mint1 = await service.mint(sponsorAPrincipal, {
        requested_scopes: ["review"],
      });
      const claim1 = await service.claim({
        enrollment_id: mint1.enrollmentId,
        secret: mint1.secret,
        name: "test-fellow-reject",
        model: "openai/gpt-5",
        harness: "codex",
      });
      await service.decide(sponsorAPrincipal, mint1.enrollmentId, {
        enrollment_id: mint1.enrollmentId,
        decision: "approve",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      const poll1 = await service.poll({ flow_handle: claim1.flowHandle });
      expect(poll1.status).toBe("approved");
      const approved1 = poll1 as { status: "approved"; token: string };
      const binding1 = await service.credentialBinding(approved1.token);
      expect(binding1).toBeDefined();
      const fellowId = binding1!.fellowId;

      // 1. Test Cancellation
      const init1 = await service.initiateSponsorFellowTransfer(sponsorAPrincipal, {
        fellow_id: fellowId,
        target_sponsor_id: SPONSOR_B,
        confirm: "initiate-fellow-transfer",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      const cancelRes = await service.cancelSponsorFellowTransfer(sponsorAPrincipal, {
        transfer_id: init1.transfer_id,
        confirm: "cancel-fellow-transfer",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      expect(cancelRes.status).toBe("cancelled");
      expect(
        service.acceptSponsorFellowTransfer(sponsorBPrincipal, {
          transfer_id: init1.transfer_id,
          confirm: "accept-fellow-transfer",
          step_up_authenticated_at: Math.floor(clock.now() / 1_000),
        }),
      ).rejects.toThrow("TRANSFER_NOT_PENDING");

      // 2. Test Rejection
      const init2 = await service.initiateSponsorFellowTransfer(sponsorAPrincipal, {
        fellow_id: fellowId,
        target_sponsor_id: SPONSOR_B,
        confirm: "initiate-fellow-transfer",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      const rejectRes = await service.rejectSponsorFellowTransfer(sponsorBPrincipal, {
        transfer_id: init2.transfer_id,
        confirm: "reject-fellow-transfer",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      expect(rejectRes.status).toBe("rejected");
      expect(
        service.cancelSponsorFellowTransfer(sponsorAPrincipal, {
          transfer_id: init2.transfer_id,
          confirm: "cancel-fellow-transfer",
          step_up_authenticated_at: Math.floor(clock.now() / 1_000),
        }),
      ).rejects.toThrow("TRANSFER_NOT_PENDING");

      // 3. Test 24-hour expiration
      const init3 = await service.initiateSponsorFellowTransfer(sponsorAPrincipal, {
        fellow_id: fellowId,
        target_sponsor_id: SPONSOR_B,
        confirm: "initiate-fellow-transfer",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      // Advance clock by 25 hours
      clock.value += 25 * 60 * 60 * 1000;
      expect(
        service.acceptSponsorFellowTransfer(sponsorBPrincipal, {
          transfer_id: init3.transfer_id,
          confirm: "accept-fellow-transfer",
          step_up_authenticated_at: Math.floor(clock.now() / 1_000),
        }),
      ).rejects.toThrow("TRANSFER_EXPIRED");
    });

    test("sponsor account export, delete preview, and irreversible deletion", async () => {
      const { service, clock } = await createTestHarness();
      const sponsorPrincipal = { type: "sponsor" as const, sponsorId: SPONSOR_A };
      await service.bootstrapSponsor(sponsorPrincipal);

      // Create a fellow and token
      const mint = await service.mint(sponsorPrincipal, {
        requested_scopes: ["review"],
      });
      const claim = await service.claim({
        enrollment_id: mint.enrollmentId,
        secret: mint.secret,
        name: "test-fellow-export",
        model: "openai/gpt-5",
        harness: "codex",
      });
      await service.decide(sponsorPrincipal, mint.enrollmentId, {
        enrollment_id: mint.enrollmentId,
        decision: "approve",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      const poll = await service.poll({ flow_handle: claim.flowHandle });
      const fellowToken = (poll as { token: string }).token;
      expect(await service.credentialBinding(fellowToken)).toBeDefined();

      // Export account
      const exportRes = await service.exportSponsorAccount(sponsorPrincipal);
      const parsedExport = SponsorAccountExportResponseSchema.parse(exportRes);
      expect(parsedExport.version).toBe("asimposium.sponsor-export.v1");
      expect(parsedExport.sponsor_id).toBe(SPONSOR_A);
      expect(parsedExport.fellows.length).toBe(1);
      expect(parsedExport.fellows[0]?.name).toBe("test-fellow-export");

      // Delete preview
      const previewRes = await service.previewDeleteSponsorAccount(sponsorPrincipal);
      const parsedPreview = SponsorAccountDeletePreviewResponseSchema.parse(previewRes);
      expect(parsedPreview.active_fellows_count).toBe(1);
      expect(parsedPreview.active_credentials_count).toBe(1);
      expect(parsedPreview.backup_residual_window_days).toBe(90);

      // Delete confirm without step-up fails
      expect(
        service.deleteSponsorAccount(sponsorPrincipal, {
          confirm: "delete-sponsor-account-and-revoke-all-fellows",
          step_up_authenticated_at: 0,
        }),
      ).rejects.toThrow("STEP_UP_REQUIRED");

      // Delete confirm with bad string fails
      expect(
        service.deleteSponsorAccount(sponsorPrincipal, {
          confirm: "bad-confirm-string",
          step_up_authenticated_at: Math.floor(clock.now() / 1_000),
        }),
      ).rejects.toThrow("SPONSOR_DELETE_BODY_INVALID");

      // Successful deletion
      const deleteRes = await service.deleteSponsorAccount(sponsorPrincipal, {
        confirm: "delete-sponsor-account-and-revoke-all-fellows",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      const parsedDelete = SponsorAccountDeleteResponseSchema.parse(deleteRes);
      expect(parsedDelete.acknowledged).toBe(true);
      expect(parsedDelete.revoked_fellows_count).toBe(1);
      expect(parsedDelete.revoked_credentials_count).toBe(1);
      expect(parsedDelete.retention_control_record.action).toBe("delete-account-private-data");
      expect(parsedDelete.deletion_receipt.backupRetentionWindowDays).toBe(90);

      // Credential is now revoked
      expect(await service.credentialBinding(fellowToken)).toBeUndefined();

      // Deleted sponsor cannot mint, bootstrap, or perform actions
      expect(
        service.mint(sponsorPrincipal, {
          requested_scopes: ["review"],
        }),
      ).rejects.toThrow("SPONSOR_ACCOUNT_DELETED");
    });
  });

  describe("D1EnrollmentStore Integration (Migration 0077 Triggers & Constraints)", () => {
    test("atomic transfer acceptance and account deletion triggers on SQLite", async () => {
      const { db, raw } = createMigratedDb();
      const store = new D1EnrollmentStore(db);
      const { service, clock } = await createTestHarness(store);

      const sponsorAPrincipal = { type: "sponsor" as const, sponsorId: SPONSOR_A };
      const sponsorBPrincipal = { type: "sponsor" as const, sponsorId: SPONSOR_B };

      await service.bootstrapSponsor(sponsorAPrincipal);
      await service.bootstrapSponsor(sponsorBPrincipal);

      // Mint and approve Fellow
      const mint = await service.mint(sponsorAPrincipal, {
        requested_scopes: ["review"],
      });
      const claim = await service.claim({
        enrollment_id: mint.enrollmentId,
        secret: mint.secret,
        name: "d1-test-fellow",
        model: "openai/gpt-5",
        harness: "codex",
      });
      await service.decide(sponsorAPrincipal, mint.enrollmentId, {
        enrollment_id: mint.enrollmentId,
        decision: "approve",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      const poll = await service.poll({ flow_handle: claim.flowHandle });
      expect(poll.status).toBe("approved");
      const approved = poll as { status: "approved"; token: string };
      const fellowToken = approved.token;
      const binding = await service.credentialBinding(fellowToken);
      expect(binding).toBeDefined();
      const fellowId = binding!.fellowId;

      // Initiate transfer
      const init = await service.initiateSponsorFellowTransfer(sponsorAPrincipal, {
        fellow_id: fellowId,
        target_sponsor_id: SPONSOR_B,
        confirm: "initiate-fellow-transfer",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });

      // Accept transfer on D1
      const accept = await service.acceptSponsorFellowTransfer(sponsorBPrincipal, {
        transfer_id: init.transfer_id,
        confirm: "accept-fellow-transfer",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      expect(accept.acknowledged).toBe(true);
      expect(accept.fellow_status).toBe("paused");
      expect(accept.revoked_credentials_count).toBeGreaterThanOrEqual(1);

      // Verify fellow token revoked in D1
      expect(await service.credentialBinding(fellowToken)).toBeUndefined();

      // Verify fellow owner updated in D1
      const fellowRow = raw
        .prepare("SELECT sponsor_id, status FROM enrollment_fellows WHERE fellow_id = ?")
        .get(fellowId) as { sponsor_id: string; status: string };
      expect(fellowRow.sponsor_id).toBe(SPONSOR_B);
      expect(fellowRow.status).toBe("paused");

      // Verify transfer row marked accepted
      const transferRow = raw
        .prepare("SELECT status, resolved_at FROM sponsor_fellow_transfers WHERE transfer_id = ?")
        .get(init.transfer_id) as { status: string; resolved_at: number };
      expect(transferRow.status).toBe("accepted");
      expect(transferRow.resolved_at).toBeGreaterThan(0);

      // Delete Sponsor B account on D1
      const deleteRes = await service.deleteSponsorAccount(sponsorBPrincipal, {
        confirm: "delete-sponsor-account-and-revoke-all-fellows",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      expect(deleteRes.acknowledged).toBe(true);

      // Verify sponsor B tombstoned
      const sponsorRow = raw
        .prepare("SELECT tombstoned_at FROM sponsors WHERE sponsor_id = ?")
        .get(SPONSOR_B) as { tombstoned_at: number | null };
      expect(sponsorRow.tombstoned_at).not.toBeNull();

      // Verify fellow revoked
      const revokedFellowRow = raw
        .prepare("SELECT status FROM enrollment_fellows WHERE fellow_id = ?")
        .get(fellowId) as { status: string };
      expect(revokedFellowRow.status).toBe("revoked");
    });
  });

  describe("HTTP Router Endpoints & Problem Documents", () => {
    test("POST /v1/sponsors/transfers, GET /v1/sponsors/transfers, and decisions via HTTP", async () => {
      const { app, service, clock, sign } = await createTestHarness();
      const sponsorAPrincipal = { type: "sponsor" as const, sponsorId: SPONSOR_A };
      const sponsorBPrincipal = { type: "sponsor" as const, sponsorId: SPONSOR_B };

      await service.bootstrapSponsor(sponsorAPrincipal);
      await service.bootstrapSponsor(sponsorBPrincipal);

      // Create Fellow
      const mint = await service.mint(sponsorAPrincipal, {
        requested_scopes: ["review"],
      });
      const claim = await service.claim({
        enrollment_id: mint.enrollmentId,
        secret: mint.secret,
        name: "http-transfer-fellow",
        model: "openai/gpt-5",
        harness: "codex",
      });
      await service.decide(sponsorAPrincipal, mint.enrollmentId, {
        enrollment_id: mint.enrollmentId,
        decision: "approve",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      const poll = await service.poll({ flow_handle: claim.flowHandle });
      expect(poll.status).toBe("approved");
      const approved = poll as { status: "approved"; token: string };
      const binding = await service.credentialBinding(approved.token);
      expect(binding).toBeDefined();
      const fellowId = binding!.fellowId;

      // 1. POST /v1/sponsors/transfers (Initiate)
      const initiateBody = JSON.stringify({
        fellow_id: fellowId,
        target_sponsor_id: SPONSOR_B,
        confirm: "initiate-fellow-transfer",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      const initHeaders = await sign(
        initiateBody,
        "/v1/sponsors/transfers",
        "sponsor.transfer.initiate",
        "POST",
        SPONSOR_A,
      );
      const initReq = new Request("https://a.asimposium.org/v1/sponsors/transfers", {
        method: "POST",
        headers: initHeaders,
        body: initiateBody,
      });
      const initRes = await app.fetch(initReq);
      expect(initRes.status).toBe(201);
      const initJson = await initRes.json();
      const parsedInit = SponsorFellowTransferInitiateResponseSchema.parse(initJson);
      const transferId = parsedInit.transfer_id;

      // 2. GET /v1/sponsors/transfers (List)
      const listHeaders = await sign(
        "",
        "/v1/sponsors/transfers",
        "sponsor.transfer.list",
        "GET",
        SPONSOR_A,
      );
      const listReq = new Request("https://a.asimposium.org/v1/sponsors/transfers", {
        method: "GET",
        headers: listHeaders,
      });
      const listRes = await app.fetch(listReq);
      expect(listRes.status).toBe(200);
      const listJson = await listRes.json();
      const parsedList = SponsorFellowTransferListResponseSchema.parse(listJson);
      expect(parsedList.outgoing.some((t) => t.transfer_id === transferId)).toBe(true);

      // 3. GET /v1/sponsors/transfers/:transferId (Get Detail)
      const getHeaders = await sign(
        "",
        `/v1/sponsors/transfers/${transferId}`,
        "sponsor.transfer.get",
        "GET",
        SPONSOR_B,
      );
      const getReq = new Request(`https://a.asimposium.org/v1/sponsors/transfers/${transferId}`, {
        method: "GET",
        headers: getHeaders,
      });
      const getRes = await app.fetch(getReq);
      expect(getRes.status).toBe(200);
      const getJson = await getRes.json();
      const parsedSummary = SponsorFellowTransferSummarySchema.parse(getJson);
      expect(parsedSummary.transfer_id).toBe(transferId);

      // 4. POST /v1/sponsors/transfers/:transferId/accept (Accept)
      const acceptBody = JSON.stringify({
        transfer_id: transferId,
        confirm: "accept-fellow-transfer",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      const acceptHeaders = await sign(
        acceptBody,
        `/v1/sponsors/transfers/${transferId}/accept`,
        "sponsor.transfer.accept",
        "POST",
        SPONSOR_B,
      );
      const acceptReq = new Request(
        `https://a.asimposium.org/v1/sponsors/transfers/${transferId}/accept`,
        {
          method: "POST",
          headers: acceptHeaders,
          body: acceptBody,
        },
      );
      const acceptRes = await app.fetch(acceptReq);
      expect(acceptRes.status).toBe(200);
      const acceptJson = await acceptRes.json();
      const parsedAccept = SponsorFellowTransferAcceptResponseSchema.parse(acceptJson);
      expect(parsedAccept.acknowledged).toBe(true);
      expect(parsedAccept.fellow_status).toBe("paused");
    });

    test("GET /v1/sponsors/account/export, /delete-preview, and POST /delete via HTTP", async () => {
      const { app, service, clock, sign } = await createTestHarness();
      const sponsorPrincipal = { type: "sponsor" as const, sponsorId: SPONSOR_A };
      await service.bootstrapSponsor(sponsorPrincipal);

      // 1. GET /v1/sponsors/account/export
      const exportHeaders = await sign(
        "",
        "/v1/sponsors/account/export",
        "sponsor.account.export",
        "GET",
        SPONSOR_A,
      );
      const exportRes = await app.fetch(
        new Request("https://a.asimposium.org/v1/sponsors/account/export", {
          method: "GET",
          headers: exportHeaders,
        }),
      );
      expect(exportRes.status).toBe(200);
      const exportJson = await exportRes.json();
      expect(SponsorAccountExportResponseSchema.safeParse(exportJson).success).toBe(true);

      // 2. GET /v1/sponsors/account/delete-preview
      const previewHeaders = await sign(
        "",
        "/v1/sponsors/account/delete-preview",
        "sponsor.account.delete-preview",
        "GET",
        SPONSOR_A,
      );
      const previewRes = await app.fetch(
        new Request("https://a.asimposium.org/v1/sponsors/account/delete-preview", {
          method: "GET",
          headers: previewHeaders,
        }),
      );
      expect(previewRes.status).toBe(200);
      const previewJson = await previewRes.json();
      expect(SponsorAccountDeletePreviewResponseSchema.safeParse(previewJson).success).toBe(true);

      // 3. POST /v1/sponsors/account/delete
      const deleteBody = JSON.stringify({
        confirm: "delete-sponsor-account-and-revoke-all-fellows",
        step_up_authenticated_at: Math.floor(clock.now() / 1_000),
      });
      const deleteHeaders = await sign(
        deleteBody,
        "/v1/sponsors/account/delete",
        "sponsor.account.delete",
        "POST",
        SPONSOR_A,
      );
      const deleteRes = await app.fetch(
        new Request("https://a.asimposium.org/v1/sponsors/account/delete", {
          method: "POST",
          headers: deleteHeaders,
          body: deleteBody,
        }),
      );
      expect(deleteRes.status).toBe(200);
      const deleteJson = await deleteRes.json();
      expect(SponsorAccountDeleteResponseSchema.safeParse(deleteJson).success).toBe(true);
    });
  });

  describe("Discovery loadFellowCard Integration", () => {
    test("populates transfer_effective_at and updates omitted notes when transfer exists", async () => {
      const { db, raw } = createMigratedDb();

      // Insert sponsor and fellow
      raw.run(
        "INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES ('spn_1', 1700000000000, 1700000000000)",
      );
      raw.run(
        "INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES ('spn_2', 1700000000000, 1700000000000)",
      );
      raw.run(
        "INSERT INTO enrollment_fellows (fellow_id, sponsor_id, name, model, harness, status, created_at, status_changed_at) VALUES ('fel_1', 'spn_2', 'test-card-fellow', 'model-1', 'harness-1', 'active', 1700000000000, 1700000000000)",
      );

      // Initial card: without transfer
      const initialCard = await loadFellowCard(db, "fel_1");
      expect(initialCard?.transfer_effective_at).toBeNull();
      expect(
        initialCard?.omitted.some((o) => o.includes("sponsor transfer history is unavailable")),
      ).toBe(true);

      // Record accepted transfer
      const transferTime = 1705000000000;
      raw.run(`
        INSERT INTO sponsor_fellow_transfers (
          transfer_id, fellow_id, source_sponsor_id, target_sponsor_id,
          status, directive_attestation, transfer_manifest_json, request_digest, created_at, expires_at, resolved_at
        ) VALUES (
          'TRF-01JXYZ4K6Q0000000000000000', 'fel_1', 'spn_1', 'spn_2',
          'accepted', 'no_directives', '{}', 'digest', 1704900000000, 1705100000000, ${transferTime}
        )
      `);

      // Card after transfer
      const updatedCard = await loadFellowCard(db, "fel_1");
      expect(updatedCard?.transfer_effective_at).toBe(new Date(transferTime).toISOString());
      expect(
        updatedCard?.omitted.some((o) => o.includes("sponsor transfer history is unavailable")),
      ).toBe(false);
    });
  });
});
