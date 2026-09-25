/** Local test entrypoint only. Never referenced by a deployment configuration.
 * D1/R2 and all HTTP routes are real; the classifier returns fixture decisions.
 * Sponsor fixture methods exercise the production store, not Google/envelope auth.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { RequestedScope } from "@asimposium/contracts";
import type {
  Request as WorkerRequest,
  Response as WorkerResponse,
} from "@cloudflare/workers-types";
import { createApp } from "../../src/app.ts";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import {
  type EnrollmentPrincipal,
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { publicWatchFetch } from "../../src/http/public-watch-cors.ts";
import { deliverInboxEvents } from "../../src/inbox/event-delivery.ts";
import {
  deliverArtifactPublication,
  publicationScreenContext,
} from "../../src/krater/artifact-publication-outbox.ts";
import { artifactPublicationFetch } from "../../src/krater/artifact-publication-runtime.ts";
import { artifactFetch } from "../../src/krater/artifact-runtime.ts";
import {
  checkpointVerifyKeys,
  signPendingCheckpoints,
} from "../../src/krater/checkpoint-signing.ts";
import { genesisChainDigest, redactEventContent } from "../../src/krater/krater.ts";
import {
  applyDeletionJournal,
  expireSecurityRecords,
  fetchLatestDeletionJournal,
  findResurrectedTargets,
  parseAndVerifyDeletionJournal,
  publishDeletionJournal,
  readDeletionJournalRecords,
} from "../../src/krater/retention.ts";
import { loadFiredDeadEndTriggers } from "../../src/ledger/dead-ends.ts";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger.ts";
import {
  WORKERS_AI_MODEL_VERSION,
  WORKERS_AI_POLICY_VERSION,
} from "../../src/screening/workers-ai.ts";
import { readDeadEndPack, readReviewQueuePack } from "../../src/sessions/ledger-pack.ts";
import { checkAndReserveQuota, parseSponsorLimit } from "../../src/sessions/quota.ts";
import { createSessionRouter } from "../../src/sessions/router.ts";
import { syntheticScreeningObservation } from "../support/screening.ts";

export { KraterOutboxDrainer } from "../../src/krater/outbox-do.ts";

let screenCalls = 0;
let screeningDelayMs = 0;
let revokeDuringNextScreen = false;
let redactDuringNextScreen: string | null = null;
type ScreenMode =
  | "pass"
  | "reject"
  | "quarantine"
  | "unavailable"
  | "wrong-digest"
  | "wrong-context";
let screenMode: ScreenMode = "pass";
let lastScreen:
  | { kind: string; problemId: string; fellowId: string; digest: string; statement: string }
  | undefined;
const app = createApp({
  screenPromotion: async (input, env) => {
    screenCalls += 1;
    if (redactDuringNextScreen !== null) {
      const eventId = redactDuringNextScreen;
      redactDuringNextScreen = null;
      await redactEventContent(env.DB, eventId, "privacy", new Date().toISOString());
    }
    // Keep the timer in this request's Workerd I/O context.
    if (screeningDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, screeningDelayMs));
    }
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify({ statement: input.statement, falsifier: input.falsifier }),
      ),
    );
    lastScreen = {
      kind: input.kind,
      problemId: input.problemId,
      fellowId: input.fellowId,
      statement: input.statement,
      digest: [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join(""),
    };
    if (revokeDuringNextScreen) {
      revokeDuringNextScreen = false;
      // Deterministically land a concurrent authority change after HTTP auth
      // and before the production writer's transaction. This is fixture setup,
      // not proof of the sponsor-facing credential-revocation route.
      const credential = await env.DB.prepare(
        "SELECT credential_id, sponsor_id, issued_at, last_used_at FROM fellow_tokens WHERE fellow_id = ? AND revoked_at IS NULL",
      )
        .bind(input.fellowId)
        .first<{
          credential_id: string;
          sponsor_id: string;
          issued_at: number;
          last_used_at: number | null;
        }>();
      if (!credential) throw new Error("Synthetic revoke prerequisite missing");
      await new D1EnrollmentStore(env.DB).revokeCredential({
        sponsorId: credential.sponsor_id,
        fellowId: input.fellowId,
        credentialId: credential.credential_id,
        eventId: `LEV-${crypto.randomUUID().replaceAll("-", "").toUpperCase().slice(0, 26)}`,
        requestId: lastScreen.digest,
        effectiveAt: Math.max(Date.now(), credential.issued_at, credential.last_used_at ?? 0),
      });
    }
    if (screenMode === "unavailable") throw new Error("synthetic provider unavailability");
    if (screenMode === "reject" || screenMode === "quarantine")
      return syntheticScreeningObservation(input, {
        decision: screenMode,
        coarse_category: "injection",
        provider_status: "ok",
      });
    const observation = await syntheticScreeningObservation(input, {
      decision: input.statement.includes("LOCAL_POLICY_CANARY") ? "reject" : "pass",
      coarse_category: input.statement.includes("LOCAL_POLICY_CANARY")
        ? "injection"
        : "benign-context",
      provider_status: "ok",
    });
    if (screenMode === "wrong-context")
      return { ...observation, evaluated_context_digest: `sha256:${"0".repeat(64)}` };
    return screenMode === "wrong-digest"
      ? { ...observation, evaluated_body_digest: `sha256:${"0".repeat(64)}` }
      : observation;
  },
});

export default class DiscoveryLocalWorker extends WorkerEntrypoint<Env> {
  // Deterministic interleaving after the actual route's reads, before its D1 batch.
  async heartbeatAfterPrecheck(
    token: string,
    sessionId: string,
    key: string,
    mutation: "close" | "revoke" | "pause" | "release",
  ) {
    const service = this.service();
    const binding = await service.credentialBinding(token);
    if (!binding) throw new Error("Heartbeat fixture credential unavailable");
    const protector = enrollmentReplayProtectorFromBase64Url(this.env.ENROLLMENT_REPLAY_KEY);
    const requestId = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))),
    ]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    let changed = false;
    const router = createSessionRouter({
      service,
      replayProtector: {
        open: (sealed, context) => protector.open(sealed, context),
        seal: async (plaintext, context) => {
          if (!changed) {
            changed = true;
            if (mutation === "close") {
              await this.env.DB.prepare("UPDATE sessions SET closed_at = ? WHERE session_id = ?")
                .bind(new Date().toISOString(), sessionId)
                .run();
            } else if (mutation === "revoke") {
              await new D1EnrollmentStore(this.env.DB).revokeCredential({
                sponsorId: binding.sponsorId,
                fellowId: binding.fellowId,
                credentialId: binding.credentialId,
                eventId: `LEV-${crypto.randomUUID().replaceAll("-", "").toUpperCase().slice(0, 26)}`,
                requestId,
                effectiveAt: Date.now(),
              });
            } else if (mutation === "pause") {
              await new D1EnrollmentStore(this.env.DB).transitionFellow({
                sponsorId: binding.sponsorId,
                fellowId: binding.fellowId,
                toStatus: "paused",
                eventId: `LEV-${crypto.randomUUID().replaceAll("-", "").toUpperCase().slice(0, 26)}`,
                requestId,
                effectiveAt: Date.now(),
              });
            } else {
              await this.env.DB.prepare(
                "UPDATE leases SET status = 'released' WHERE session_id = ?",
              )
                .bind(sessionId)
                .run();
            }
          }
          return protector.seal(plaintext, context);
        },
      },
    });
    router.onError((error, c) =>
      c.json(
        {
          code: "HEARTBEAT_FIXTURE_FAILURE",
          error_name: error.name,
          contract_failure: error.message.includes("WRITE_REFUSED"),
          database_failure: error.message.includes("D1_ERROR"),
        },
        500,
      ),
    );
    const response = await router.fetch(
      new Request(`${this.env.STOA_ORIGIN}/v1/sessions/${sessionId}/heartbeat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": key,
          "content-type": "application/json",
          "User-Agent": "OpenAI File Downloader, XaiImageApiFetch/1.0",
        },
        body: "{}",
      }),
      this.env,
    );
    return { status: response.status, changed, body: await response.json() };
  }
  async retryTriggersAt(problemId: string, cursor: number) {
    return JSON.stringify(await loadFiredDeadEndTriggers(this.env.DB, problemId, 3, cursor));
  }

  async deadEndPackAt(problemId: string, cursor: number) {
    return JSON.stringify(await readDeadEndPack(this.env.DB, problemId, cursor, "graveyard"));
  }

  async reviewQueueAt(problemId: string, cursor: number, fellowId: string, sponsorId: string) {
    return JSON.stringify(
      await readReviewQueuePack(this.env.DB, problemId, cursor, { fellowId, sponsorId }),
    );
  }

  override async fetch(request: WorkerRequest): Promise<WorkerResponse> {
    const response = await publicWatchFetch(request as unknown as Request, () =>
      artifactPublicationFetch(request as unknown as Request, this.env, () =>
        artifactFetch(request as unknown as Request, this.env, () =>
          app.fetch(request as unknown as Request, this.env, this.ctx),
        ),
      ),
    );
    return response as unknown as WorkerResponse;
  }

  service(): EnrollmentService {
    return new EnrollmentService({
      stoaOrigin: this.env.STOA_ORIGIN as string,
      agoraOrigin: this.env.AGORA_ORIGIN as string,
      store: new D1EnrollmentStore(this.env.DB),
      replayProtector: enrollmentReplayProtectorFromBase64Url(this.env.ENROLLMENT_REPLAY_KEY),
    });
  }

  async mint(
    sponsorId: string,
    requestedScopes: readonly RequestedScope[] = ["promote", "review", "propose-problems"],
  ) {
    const principal = { type: "sponsor", sponsorId } as const;
    const service = this.service();
    await service.bootstrapSponsor(principal);
    return service.mint(principal, { requested_scopes: [...requestedScopes] });
  }

  async approve(sponsorId: string, enrollmentId: string) {
    await this.service().decide({ type: "sponsor", sponsorId }, enrollmentId, {
      enrollment_id: enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
  }

  async seedProblem(id: string, sponsorId = "usr_claims_sponsor_1") {
    const at = new Date().toISOString();
    const genesis = await genesisChainDigest(id);
    await this.env.DB.batch([
      this.env.DB.prepare(
        "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_digest, chain_version, sponsor_id) VALUES (?, 0, ?, ?, ?, 2, ?)",
      ).bind(id, at, at, genesis, sponsorId),
      this.env.DB.prepare(
        "INSERT INTO problem_statement_versions (problem_id, version, statement, norm_hash, falsifier, motivation, created_at) VALUES (?, 1, 'Initial problem statement for ' || ?, 'sha256:init_' || ?, 'Initial falsifier', 'Initial motivation', ?)",
      ).bind(id, id, id, at),
      this.env.DB.prepare(
        "INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version) VALUES (?, 'complete', 0, ?, 2)",
      ).bind(id, at),
    ]);
  }

  screeningCalls(): number {
    return screenCalls;
  }

  // HTTP journeys cover signed ingress. This seam isolates an authenticated
  // writer holding an obsolete read, against real D1 without a timer race.
  async governanceFromSnapshot(
    snapshot: Parameters<typeof applyPublicProblemGovernance>[1],
    sponsorId: string,
    action: Parameters<typeof applyPublicProblemGovernance>[3],
    key: string,
  ) {
    const response = await applyPublicProblemGovernance(
      this.env.DB,
      snapshot,
      sponsorId,
      action,
      new Request(`${this.env.STOA_ORIGIN}/v1/sponsors/problems/${snapshot.id}/lifecycle`, {
        method: "POST",
        headers: {
          "Idempotency-Key": key,
          "User-Agent": "OpenAI File Downloader, XaiImageApiFetch/1.0",
        },
      }),
    );
    return { status: response.status, body: await response.json() };
  }

  redactPublicContent(eventId: string) {
    return redactEventContent(this.env.DB, eventId, "privacy", new Date().toISOString());
  }

  redactOnNextScreen(eventId: string): void {
    redactDuringNextScreen = eventId;
  }

  // Fault-inject a changed current sponsor binding to test historical pins.
  // There is no mounted transfer workflow yet; this does not certify one or
  // change immutable grants/tokens. Existing credentials may consequently fail.
  async changeCurrentSponsor(fellowId: string, sponsorId: string): Promise<void> {
    await this.env.DB.prepare("UPDATE enrollment_fellows SET sponsor_id = ? WHERE fellow_id = ?")
      .bind(sponsorId, fellowId)
      .run();
  }

  async transferFellow(
    fellowId: string,
    sourceSponsorId: string,
    targetSponsorId: string,
  ): Promise<{ transferId: string }> {
    const service = this.service();
    const now = Date.now();
    const sourcePrincipal: EnrollmentPrincipal = {
      type: "sponsor",
      sponsorId: sourceSponsorId,
    };
    const targetPrincipal: EnrollmentPrincipal = {
      type: "sponsor",
      sponsorId: targetSponsorId,
    };
    await this.env.DB.prepare(
      "INSERT OR IGNORE INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)",
    )
      .bind(targetSponsorId, now, now)
      .run();

    const nowSeconds = Math.floor(now / 1000);
    const initiated = await service.initiateSponsorFellowTransfer(
      sourcePrincipal,
      {
        fellow_id: fellowId,
        target_sponsor_id: targetSponsorId,
        confirm: "initiate-fellow-transfer",
        step_up_authenticated_at: nowSeconds,
      },
      { idempotencyKey: `key-init-${now}-${fellowId}` },
    );
    await service.acceptSponsorFellowTransfer(
      targetPrincipal,
      {
        transfer_id: initiated.transfer_id,
        confirm: "accept-fellow-transfer",
        step_up_authenticated_at: nowSeconds,
      },
      { idempotencyKey: `key-accept-${now}-${fellowId}` },
    );
    return { transferId: initiated.transfer_id };
  }

  pauseScreening(delayMs = 2000): void {
    screeningDelayMs = delayMs;
  }

  resumeScreening(): void {
    screeningDelayMs = 0;
  }

  // Synthetic prior attempts through the real accounting function and D1,
  // used to reach the last slot without fabricating classifier invocations.
  reserveQuota(params: Parameters<typeof checkAndReserveQuota>[1]) {
    return checkAndReserveQuota(this.env.DB, {
      ...params,
      sponsorLimit: parseSponsorLimit(this.env.SPONSOR_PROMOTION_RATE_LIMIT),
    });
  }

  setScreenMode(mode: ScreenMode): void {
    screenMode = mode;
  }

  lastScreening() {
    return lastScreen;
  }

  /** One cron tick of the production security-record expiry (index.ts scheduled). */
  expireSecurityTick() {
    return expireSecurityRecords(this.env.DB);
  }

  /** One cron tick of the production deletion-journal publisher (index.ts scheduled). */
  publishDeletionJournalTick() {
    return publishDeletionJournal(this.env.DB, this.env.ARTIFACTS, this.env.CHECKPOINT_SIGNING_KEY);
  }

  async deletionJournalRowCount(): Promise<number> {
    return (await readDeletionJournalRecords(this.env.DB)).length;
  }

  fetchDeletionJournal(): Promise<string | null> {
    return fetchLatestDeletionJournal(this.env.ARTIFACTS);
  }

  /** Rows a point-in-time snapshot would hold; restored with restoreRows. */
  async snapshotRows(table: string, column: string, value: string) {
    if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) throw new Error("bad identifier");
    return (
      (await this.env.DB.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).bind(value).all())
        .results ?? []
    );
  }

  /** Simulates a point-in-time restore of these rows (a provider restore
   * writes rows directly, not through Worker routes). */
  async restoreRows(table: string, rows: Record<string, unknown>[]): Promise<number> {
    if (!/^[a-z_]+$/.test(table)) throw new Error("bad identifier");
    for (const row of rows) {
      const columns = Object.keys(row);
      await this.env.DB.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
        .bind(...columns.map((c) => row[c]))
        .run();
    }
    return rows.length;
  }

  /** Test-only raw write, used to put back rows a provider restore would
   * hold (e.g. an un-tombstoned sponsor). Returns rows changed. */
  async execRaw(query: string, values: unknown[] = []): Promise<number> {
    const result = await this.env.DB.prepare(query)
      .bind(...values)
      .run();
    return result.meta.changes ?? 0;
  }

  async resurrectedTargets(ndjson: string): Promise<string[]> {
    const verified = await parseAndVerifyDeletionJournal(
      ndjson,
      checkpointVerifyKeys(this.env.CHECKPOINT_VERIFY_KEYS),
    );
    if (!verified.valid) throw new Error(verified.reason);
    return findResurrectedTargets(this.env.DB, verified.records);
  }

  /** Runs the restore replay against this throwaway local D1 (named as the
   * scratch target it is). Returns the refusal message instead of throwing. */
  async replayDeletionJournal(ndjson: string | null) {
    try {
      return {
        ok: true as const,
        ...(await applyDeletionJournal({
          db: this.env.DB,
          targetIdentifier: "scratch-local-workerd-d1",
          deletionJournalNdjson: ndjson,
          verifyKeys: checkpointVerifyKeys(this.env.CHECKPOINT_VERIFY_KEYS),
        })),
      };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** One cron tick of the production checkpoint signer (index.ts scheduled). */
  signCheckpointsTick() {
    return signPendingCheckpoints(this.env.DB, this.env.CHECKPOINT_SIGNING_KEY);
  }

  /** One cron tick of the production inbox delivery consumer (index.ts scheduled). */
  deliverInboxTick() {
    return deliverInboxEvents(this.env.DB);
  }

  revokeOnNextScreen(): void {
    revokeDuringNextScreen = true;
  }

  async stageArtifact(uploadId: string, bytes: ArrayBuffer | Uint8Array): Promise<void> {
    await this.env.ARTIFACTS.put(`incoming/artifacts/${uploadId}`, bytes);
  }

  async hasStagedArtifact(uploadId: string): Promise<boolean> {
    return (await this.env.ARTIFACTS.head(`incoming/artifacts/${uploadId}`)) !== null;
  }

  async readPrivateCas(sha256: string): Promise<Uint8Array | null> {
    const obj = await this.env.ARTIFACTS.get(`cas/sha256/${sha256}`);
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }

  async readPublicCas(sha256: string): Promise<Uint8Array | null> {
    const obj = await this.env.PUBLIC_ARTIFACTS.get(`sha256/${sha256}`);
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }

  async deliverPublication(
    publicationId: string,
    decision: "pass" | "reject" = "pass",
  ): Promise<"published" | "held" | "retry" | "lost" | "idle"> {
    const artifactOrigin =
      typeof this.env.STOA_ORIGIN === "string" && this.env.STOA_ORIGIN.includes("staging")
        ? "https://artifacts-staging.asimposium.org"
        : "https://artifacts.asimposium.org";
    return deliverArtifactPublication(
      {
        db: this.env.DB,
        privateBucket: this.env.ARTIFACTS,
        publicBucket: this.env.PUBLIC_ARTIFACTS,
        artifactOrigin,
        screen: async (job) => ({
          decision,
          provider_status: "ok",
          evaluated_body_digest: `sha256:${job.screening_sha256}`,
          evaluated_context_digest: `sha256:${await publicationScreenContext(job)}`,
          model_version: WORKERS_AI_MODEL_VERSION,
          policy_version: WORKERS_AI_POLICY_VERSION,
          configuration_digest: `sha256:${"0".repeat(64)}`,
          coarse_category: decision === "pass" ? "benign-context" : "injection",
        }),
      },
      publicationId,
    );
  }

  async getEvidenceDigest(evidenceId: string): Promise<string | null> {
    const row = await this.env.DB.prepare(
      "SELECT payload_sha256 FROM events WHERE object_id = ? AND type = 'evidence.created'",
    )
      .bind(evidenceId)
      .first<{ payload_sha256: string }>();
    return row ? `sha256:${row.payload_sha256}` : null;
  }
}
