/** Local test entrypoint only. Never referenced by a deployment configuration.
 * D1/R2 and all HTTP routes are real; the classifier returns fixture decisions.
 * Sponsor fixture methods exercise the production store, not Google/envelope auth.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { canonicalJson, type RequestedScope } from "@asimposium/contracts";
import type {
  D1Database,
  D1PreparedStatement,
  R2Bucket,
  ScheduledController,
  Request as WorkerRequest,
  Response as WorkerResponse,
} from "@cloudflare/workers-types";
import { createApp } from "../../src/app.ts";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import {
  type EnrollmentPrincipal,
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
  retentionCredentialRevoker,
} from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { publicWatchFetch } from "../../src/http/public-watch-cors.ts";
import { deliverDispositionChanges } from "../../src/inbox/disposition-change";
import { deliverInboxEvents } from "../../src/inbox/event-delivery.ts";
import production from "../../src/index";
import {
  deliverArtifactPublication,
  publicationScreenContext,
} from "../../src/krater/artifact-publication-outbox.ts";
import { artifactPublicationFetch } from "../../src/krater/artifact-publication-runtime.ts";
import { artifactFetch } from "../../src/krater/artifact-runtime.ts";
import { backupProblem, backupProblemsPage } from "../../src/krater/backup.ts";
import { BACKUP_RUN_KEY, runScheduledBackup } from "../../src/krater/backup-scheduler.ts";
import {
  checkpointVerifyKeys,
  signPendingCheckpoints,
} from "../../src/krater/checkpoint-signing.ts";
import { claimContentDigest } from "../../src/krater/claim-version.ts";
import {
  genesisChainDigest,
  redactEventContent,
  sha256Hex,
  writeClaim,
  writeLedgerEvent,
} from "../../src/krater/krater.ts";
import {
  applyDeletionJournal,
  deletionSafeRestore,
  expireSecurityRecords,
  fetchLatestDeletionJournal,
  findResurrectedTargets,
  parseAndVerifyDeletionJournal,
  publishDeletionJournal,
  readDeletionJournalRecords,
} from "../../src/krater/retention.ts";
import { loadFiredDeadEndTriggers } from "../../src/ledger/dead-ends.ts";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger.ts";
import { POLICY_CATEGORIES } from "../../src/screening/types.ts";
import {
  WORKERS_AI_MODEL_VERSION,
  WORKERS_AI_POLICY_VERSION,
  type WorkersAiBinding,
} from "../../src/screening/workers-ai.ts";
import { expireIdleSessions } from "../../src/sessions/idle";
import { warnExpiringLeases } from "../../src/sessions/lease-warnings";
import { readDeadEndPack, readReviewQueuePack } from "../../src/sessions/ledger-pack.ts";
import { checkAndReserveQuota, parseSponsorLimit } from "../../src/sessions/quota.ts";
import { createSessionRouter } from "../../src/sessions/router.ts";
import { normHash } from "../../src/split/policy.ts";
import { syntheticScreeningObservation } from "../support/screening.ts";

export { HeraldRoom } from "../../src/herald/room.ts";
export { KraterOutboxDrainer } from "../../src/krater/outbox-do.ts";

import { deliverHeraldRooms } from "../../src/herald/outbox.ts";
import {
  type HeraldRuntimeEnv,
  heraldRoomFetch,
  scheduleHeraldDelivery,
} from "../../src/herald/runtime.ts";
import { screenPromotionWithWorkersAI } from "../../src/screening/workers-ai.ts";

let artifactClock: number | null = null;
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
  | "wrong-context"
  | "malformed-provider";
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
    // The production Workers AI adapter and parser, given a model binding
    // whose output is not the expected JSON verdict. Only the binding is
    // synthetic; the parsing and fail-closed mapping are production code.
    if (screenMode === "malformed-provider")
      return screenPromotionWithWorkersAI(
        { run: async () => ({ response: 'verdict: PASS (probably) {"decision": ' }) },
        input,
      );
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

// Commentary uses the actual Workers AI adapter, rather than screenPromotion.
// Supply an explicit local classifier binding so this lane cannot accidentally
// pass by relying on an absent AI binding. Model answers are fixtures; parsing,
// fail-closed decisions, sponsor routes and D1 transactions are production code.
const commentaryFixtureAI: WorkersAiBinding = {
  async run(_model, input) {
    screenCalls += 1;
    const mode = screenMode;
    const delay = screeningDelayMs;
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    if (mode === "unavailable") throw new Error("Synthetic commentary classifier outage");
    if (mode === "malformed-provider" || mode === "wrong-digest" || mode === "wrong-context")
      return { response: "Invalid synthetic classifier response" };
    const submission = input.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n");
    const decision =
      mode === "reject" || mode === "quarantine"
        ? mode
        : submission.includes("LOCAL_POLICY_CANARY")
          ? "reject"
          : "pass";
    return {
      response: JSON.stringify({
        decision,
        coarse_category: decision === "pass" ? "benign-context" : "injection",
        bands: Object.fromEntries(POLICY_CATEGORIES.map((category) => [category, null])),
      }),
    };
  },
};

/**
 * A competing write armed by a lane (ism6): it runs against the real D1 just
 * before the next request's first batch, i.e. after the route's reads and
 * before its write commits, which is the race window a check-then-act route
 * must survive. One-shot.
 */
let raceBeforeNextBatch: {
  readonly sql: string;
  readonly bindings: unknown[];
  /** Fire only on a batch containing a statement whose SQL includes this. */
  readonly matchSql?: string;
} | null = null;

/**
 * A real event the competing write commits instead of the stand-in, so the
 * problem stays replayable and the projection-parity sweep still compares its
 * rows (x78n). The payload must be what replay expects of that event type.
 */
interface CompetingEvent {
  readonly eventType: string;
  readonly objectKind: string;
  readonly objectId: string;
  readonly payload: Record<string, unknown>;
}

/**
 * 4uvb: a genuine competing ledger write (a real, chained event; by default of
 * a test-only type that replay cannot judge) committed just before the next
 * batch that inserts an event, so the route's own write finds the head moved.
 */
let competingLedgerWriteBeforeNextBatch: {
  readonly problemId: string;
  /** Optional state change committed with the competing event (rg73). */
  readonly sql?: string;
  readonly bindings?: unknown[];
  readonly event?: CompetingEvent;
} | null = null;

async function competingLedgerWrite(
  db: D1Database,
  problemId: string,
  change?: { readonly sql: string; readonly bindings: unknown[] },
  event?: CompetingEvent,
): Promise<void> {
  const id = crypto.randomUUID();
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id))),
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  await writeLedgerEvent(
    db,
    {
      problemId,
      eventId: `E-LANE-COMPETE-${id}`,
      idempotencyKey: `lane-compete-${id}`,
      requestDigest: digest,
      eventType: event?.eventType ?? "lane.competing-write",
      objectKind: event?.objectKind ?? "lane",
      objectId: event?.objectId ?? `LANE-${id}`,
      objectVersion: 1,
      payloadJson: JSON.stringify(event?.payload ?? { competing: true }),
      createdAt: new Date().toISOString(),
      attribution: {
        fellowId: "F-LANE-COMPETITOR",
        sponsorId: "usr_lane_competitor",
        sessionId: "S-LANE-COMPETITOR",
        modelSelfDeclared: "lane",
        harness: "lane",
      },
    },
    {
      statementsAfterEvent: ({ eventId }) =>
        change === undefined
          ? []
          : [
              db
                .prepare(`${change.sql} AND EXISTS (SELECT 1 FROM events WHERE id = ?)`)
                .bind(...change.bindings, eventId),
            ],
    },
  );
}

/** The statements (first 60 chars) of the batch the last race fired on. */
let lastRaceBatchSql: string[] = [];

function racingDb(db: D1Database): D1Database {
  // The SQL text of each statement this request prepares, so an armed race
  // can wait for one particular batch (e.g. the ledger write's).
  const sqlOf = new WeakMap<object, string>();
  const nativeOf = new WeakMap<object, D1PreparedStatement>();
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          sqlOf.set(statement, query);
          const wrapped = new Proxy(statement, {
            get(inner, key) {
              if (key === "bind") {
                return (...values: unknown[]) => {
                  const bound = inner.bind(...values);
                  sqlOf.set(bound, query);
                  return bound;
                };
              }
              const value = Reflect.get(inner, key);
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
          nativeOf.set(wrapped, statement);
          return wrapped;
        };
      }
      if (property === "batch") {
        return async (statements: Parameters<D1Database["batch"]>[0]) => {
          const native = statements.map((statement) => nativeOf.get(statement) ?? statement);
          const competing = competingLedgerWriteBeforeNextBatch;
          if (
            competing !== null &&
            native.some((statement) => sqlOf.get(statement)?.includes("INSERT INTO events"))
          ) {
            competingLedgerWriteBeforeNextBatch = null;
            await competingLedgerWrite(
              target,
              competing.problemId,
              competing.sql === undefined
                ? undefined
                : { sql: competing.sql, bindings: competing.bindings ?? [] },
              competing.event,
            );
          }
          const race = raceBeforeNextBatch;
          const matches =
            race !== null &&
            (race.matchSql === undefined ||
              native.some((statement) => sqlOf.get(statement)?.includes(race.matchSql ?? "")));
          if (race !== null && matches) {
            raceBeforeNextBatch = null;
            lastRaceBatchSql = native.map((statement) =>
              (sqlOf.get(statement) ?? "?").slice(0, 60),
            );
            await target
              .prepare(race.sql)
              .bind(...race.bindings)
              .run();
          }
          return target.batch(native);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default class DiscoveryLocalWorker extends WorkerEntrypoint<Env> {
  /** The production cron handler (index.ts scheduled), so a lane drives it as
   * workerd does and its runtime logs are captured like any request's. */
  override async scheduled(controller: ScheduledController): Promise<void> {
    await production.scheduled(controller, this.env as never, this.ctx);
  }

  /** Arm one competing write for the next request's first batch (ism6). */
  armRaceBeforeNextBatch(sql: string, bindings: unknown[], matchSql?: string): void {
    raceBeforeNextBatch = { sql, bindings, ...(matchSql === undefined ? {} : { matchSql }) };
  }

  raceStillArmed(): boolean {
    return raceBeforeNextBatch !== null;
  }

  lastRaceBatch(): string[] {
    return lastRaceBatchSql;
  }

  disarmRace(): void {
    raceBeforeNextBatch = null;
    competingLedgerWriteBeforeNextBatch = null;
  }

  /** A genuine chained event of a type no replayer knows (79n). */
  async appendUnknownEvent(problemId: string): Promise<void> {
    await competingLedgerWrite(this.env.DB, problemId);
  }

  /** Arm one genuine competing ledger write on this problem (4uvb). */
  armCompetingLedgerWrite(
    problemId: string,
    sql?: string,
    bindings?: unknown[],
    event?: CompetingEvent,
  ): void {
    competingLedgerWriteBeforeNextBatch = {
      problemId,
      ...(sql === undefined ? {} : { sql, bindings: bindings ?? [] }),
      ...(event === undefined ? {} : { event }),
    };
  }

  competingWriteStillArmed(): boolean {
    return competingLedgerWriteBeforeNextBatch !== null;
  }

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
          "User-Agent":
            "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)",
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
    // Same layering as src/index.ts: Herald rooms outside CORS rebuilding, and
    // committed writes nudge rooms through the production delivery hook.
    const raw = request as unknown as Request;
    const response = await heraldRoomFetch(raw, this.env, () =>
      publicWatchFetch(raw, () =>
        artifactPublicationFetch(raw, this.env, () =>
          artifactFetch(
            raw,
            this.env,
            () =>
              app.fetch(
                raw,
                {
                  ...this.env,
                  AI: commentaryFixtureAI as unknown as Env["AI"],
                  DB:
                    raceBeforeNextBatch === null && competingLedgerWriteBeforeNextBatch === null
                      ? this.env.DB
                      : racingDb(this.env.DB),
                },
                this.ctx,
              ),
            () => artifactClock ?? Date.now(),
          ),
        ),
      ),
    );
    scheduleHeraldDelivery(raw, response, this.env, this.ctx);
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
          "User-Agent":
            "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)",
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

  /** One cron tick of the production Herald room delivery (index.ts scheduled). */
  async deliverHeraldTick() {
    return deliverHeraldRooms(this.env.DB, (this.env as HeraldRuntimeEnv).HERALD_ROOMS);
  }

  /** One cron tick of the production idle-session sweep at `now`, limited to one Fellow. */
  expireIdleTick(now: number, fellowId: string) {
    return expireIdleSessions(this.env.DB, { now, fellowId });
  }

  /** One cron tick of the production disposition-change delivery. */
  deliverDispositionTick() {
    return deliverDispositionChanges(this.env.DB);
  }

  /** Historical fixture for the 72-hour rule. It uses real production Krater
   * transactions and immutable timestamps; no event is edited or deleted and
   * the production HTTP surface gains no backdating/clock-control capability.
   * The lane verifies the subsequent independent review through real routes. */
  async seedAgedRefutation(input: {
    problemId: string;
    authorToken: string;
    authorSessionId: string;
    evidenceToken: string;
    evidenceSessionId: string;
    ageHours: number;
    statement: string;
  }) {
    if (!Number.isFinite(input.ageHours) || input.ageHours < 0 || input.ageHours > 168)
      throw new Error("Historical refutation fixture age is invalid");
    const author = await this.service().credentialBinding(input.authorToken);
    const witness = await this.service().credentialBinding(input.evidenceToken);
    if (!author || !witness) throw new Error("Historical fixture identities unavailable");
    const db = this.env.DB;
    const serial = crypto.randomUUID().replaceAll("-", "");
    const evidenceTime = new Date(Date.now() - input.ageHours * 3_600_000).toISOString();
    const claimTime = new Date(Date.parse(evidenceTime) - 60_000).toISOString();
    const claimVersion = { kind: "conjecture", falsifier: "A multiple of six that is composite." };
    const contentDigest = await claimContentDigest(
      { ...claimVersion, statement: input.statement },
      sha256Hex,
    );
    const claim = await writeClaim(
      db,
      {
        problemId: input.problemId,
        claimId: "C-1",
        eventId: `E-AGED-CLAIM-${serial}`,
        idempotencyKey: `aged-claim-${serial}`,
        statement: input.statement,
        normHash: await normHash(input.statement),
        claimVersion,
        dependencyPins: [],
        createdAt: claimTime,
        attribution: {
          fellowId: author.fellowId,
          sponsorId: author.sponsorId,
          sessionId: input.authorSessionId,
          modelSelfDeclared: author.model,
          harness: author.harness,
        },
      },
      {},
      {
        claimIdForSequence: (sequence) => `C-${sequence}`,
        statementsAfterIdempotencySettlement: ({ claimId, eventId, sequence }) => [
          db
            .prepare(`
            INSERT INTO claim_versions
              (claim_id, problem_id, version, kind, statement, falsifier,
               content_digest, editor_fellow_id, created_at)
            SELECT ?, ?, 1, ?, ?, ?, ?, ?, ?
            FROM events WHERE id = ? AND seq = ?
          `)
            .bind(
              claimId,
              input.problemId,
              claimVersion.kind,
              input.statement,
              claimVersion.falsifier,
              contentDigest,
              author.fellowId,
              claimTime,
              eventId,
              sequence,
            ),
        ],
      },
    );
    const evidenceId = `E-${serial}`;
    const payload = {
      bears_on_id: claim.claimId,
      bears_on_kind: "claim",
      bears_on_version: 1,
      body_md: "Six is a multiple of six and has proper divisors two and three.",
      coercion_flags: [],
      computation_domain_or_floor: "The positive integer six, enumerating all proper divisors.",
      computed_class: "computation",
      direction: "refutes",
      falsification_check: null,
      formal_artifact: null,
      kind: "computation",
      mode: "confirmatory",
      reproduction: null,
      selected_hypothesis_id: null,
      source: {
        kind: "locator",
        locator: "https://example.invalid/refutation/six",
        excerpt: "6 = 2 * 3, so six is composite.",
      },
    };
    const payloadJson = canonicalJson(payload);
    const published = await writeLedgerEvent(
      db,
      {
        problemId: input.problemId,
        eventId: `E-AGED-EVIDENCE-${serial}`,
        idempotencyKey: `aged-evidence-${serial}`,
        requestDigest: await sha256Hex(payloadJson),
        eventType: "evidence.created",
        objectKind: "evidence",
        objectId: evidenceId,
        objectVersion: 1,
        payloadJson,
        createdAt: evidenceTime,
        attribution: {
          fellowId: witness.fellowId,
          sponsorId: witness.sponsorId,
          sessionId: input.evidenceSessionId,
          modelSelfDeclared: witness.model,
          harness: witness.harness,
        },
      },
      {
        statementsAfterEvent: ({ eventId, sequence }) => [
          db
            .prepare(`
            INSERT INTO evidence
              (evidence_id, problem_id, bears_on_kind, bears_on_id, bears_on_version,
               direction, kind, source_kind, locator, excerpt, computation_domain_or_floor,
               mode, computed_class, coercion_flags_json, author_fellow_id, body_md,
               created_at, source_event_id, source_seq)
            SELECT ?, ?, 'claim', ?, 1, 'refutes', 'computation', 'locator', ?, ?, ?,
              'confirmatory', 'computation', '[]', ?, ?, ?, id, seq
            FROM events WHERE id = ? AND seq = ?
          `)
            .bind(
              evidenceId,
              input.problemId,
              claim.claimId,
              payload.source.locator,
              payload.source.excerpt,
              payload.computation_domain_or_floor,
              witness.fellowId,
              payload.body_md,
              evidenceTime,
              eventId,
              sequence,
            ),
        ],
      },
    );
    return {
      claim_id: claim.claimId,
      content_digest: contentDigest,
      evidence: { evidence_id: evidenceId, digest: `sha256:${published.payloadSha256}` },
      evidence_created_at: evidenceTime,
    };
  }

  /** One cron tick of the production lease-expiry warning sweep at `now`. */
  warnLeasesTick(now: number) {
    return warnExpiringLeases(this.env.DB, { now });
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

  /** Export/restore journeys only (runLocalWorkerJourney with scratch): the
   * production backup writer into a BACKUPS bucket, and deletion-safe restore
   * into the separately migrated SCRATCH_DB. */
  #scratchBindings() {
    const env = this.env as unknown as { SCRATCH_DB?: D1Database; BACKUPS?: R2Bucket };
    if (!env.SCRATCH_DB || !env.BACKUPS) throw new Error("scratch bindings are not configured");
    return { scratchDb: env.SCRATCH_DB, backups: env.BACKUPS };
  }

  async backupToR2(problemId: string, title: string, datePrefix: string) {
    const result = await backupProblem(
      this.env.DB,
      this.#scratchBindings().backups,
      problemId,
      title,
      datePrefix,
      { checkpointVerifyKeys: this.env.CHECKPOINT_VERIFY_KEYS },
    );
    return result === null ? null : { ...result };
  }

  async backupPageToR2(datePrefix: string, after: string | null, limit: number) {
    const run = await backupProblemsPage(this.env.DB, this.#scratchBindings().backups, datePrefix, {
      after,
      limit,
      checkpointVerifyKeys: this.env.CHECKPOINT_VERIFY_KEYS,
    });
    return JSON.parse(JSON.stringify(run));
  }

  /** Exercise the production bounded scheduler and its real R2 conditional
   * writes. A supplied clock makes lease expiry and daily rollover observable. */
  async backupSchedulerTick(now: number) {
    return runScheduledBackup(this.env, now);
  }

  /** Deterministic scheduling barrier only: both production runners read the
   * same real R2 etag before either acquires it. No storage operation is mocked. */
  async raceBackupSchedulerTicks(now: number) {
    let readers = 0;
    let release = () => {};
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const bucket = this.env.ARTIFACTS;
    const competingBucket = {
      get: async (key: string) => {
        const object = await bucket.get(key);
        if (key === BACKUP_RUN_KEY) {
          readers += 1;
          if (readers === 2) release();
          await ready;
        }
        return object;
      },
      put: bucket.put.bind(bucket),
    } as R2Bucket;
    const env = { ...this.env, ARTIFACTS: competingBucket };
    return Promise.all([runScheduledBackup(env, now), runScheduledBackup(env, now)]);
  }

  async readBackup(key: string): Promise<string | null> {
    const object = await this.#scratchBindings().backups.get(key);
    return object === null ? null : object.text();
  }

  async restoreIntoScratch(input: {
    key: string;
    targetIdentifier: string;
    journal: string | null;
    tamper?: { readonly from: string; readonly to: string };
  }) {
    const snapshot = await this.readBackup(input.key);
    if (snapshot === null) return { ok: false as const, message: "BACKUP_OBJECT_MISSING" };
    try {
      const result = await deletionSafeRestore({
        db: this.#scratchBindings().scratchDb,
        targetIdentifier: input.targetIdentifier,
        snapshotNdjson: input.tamper
          ? snapshot.replace(input.tamper.from, input.tamper.to)
          : snapshot,
        deletionJournalNdjson: input.journal,
        verifyKeys: checkpointVerifyKeys(this.env.CHECKPOINT_VERIFY_KEYS),
        revokeCredential: retentionCredentialRevoker(new D1EnrollmentStore(this.env.DB)),
      });
      return {
        ok: true as const,
        restored: result.restored,
        eventCount: result.eventCount,
        appliedControlsCount: result.appliedControlsCount,
        projections: result.projections,
      };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** A public GET served from the primary and from the scratch database
   * (the same routes and renderers, only the DB binding differs). */
  async compareFaces(path: string) {
    if (!path.startsWith("/p/") && !path.startsWith("/v1/problems/")) {
      throw new Error("compareFaces reads public problem faces only");
    }
    const read = async (db: D1Database) => {
      const response = await app.fetch(
        new Request(`${this.env.STOA_ORIGIN}${path}`, {
          headers: {
            "User-Agent":
              "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)",
          },
        }),
        { ...this.env, DB: db },
        this.ctx,
      );
      return {
        status: response.status,
        etag: response.headers.get("etag"),
        body: await response.text(),
      };
    };
    return {
      primary: await read(this.env.DB),
      scratch: await read(this.#scratchBindings().scratchDb),
    };
  }

  /** Read-only comparison of the primary and scratch databases. */
  async compareRows(query: string, bindings: unknown[]) {
    if (!/^SELECT\s/i.test(query)) throw new Error("compareRows is read-only");
    const read = async (db: D1Database) =>
      ((
        await db
          .prepare(query)
          .bind(...bindings)
          .all()
      ).results ?? []) as unknown[];
    return {
      primary: await read(this.env.DB),
      scratch: await read(this.#scratchBindings().scratchDb),
    };
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
          revokeCredential: retentionCredentialRevoker(new D1EnrollmentStore(this.env.DB)),
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

  setArtifactClock(now: number | null): void {
    if (now !== null && (!Number.isSafeInteger(now) || now < 1))
      throw new Error("Invalid artifact fixture clock");
    artifactClock = now;
  }

  async artifactReservationSummary(
    fellowId: string,
  ): Promise<{ manifests: number; bytes: number; renewals: number } | null> {
    return this.env.DB.prepare(`SELECT COUNT(*) AS manifests, COALESCE(SUM(size_bytes), 0) AS bytes,
      (SELECT COUNT(*) FROM artifact_put_renewals WHERE fellow_id = ?) AS renewals
      FROM artifact_uploads WHERE fellow_id = ?`)
      .bind(fellowId, fellowId)
      .first<{ manifests: number; bytes: number; renewals: number }>();
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

  async setArtifactSourceVisibility(
    problemId: string,
    targetRef: string,
    visibility: "hidden" | "visible",
  ): Promise<void> {
    await this.env.DB.prepare(`INSERT INTO content_controls
      (control_id,problem_id,target_kind,target_ref,visibility,source,reason_category,actor,reason,version,created_at)
      SELECT ?,?,?,?,?, 'operator','publication-source','local-artifact-operator',
        'Exercise current artifact source visibility',COALESCE(MAX(version),0)+1,?
      FROM content_controls WHERE problem_id=? AND target_ref=?`).bind(
        `CC-${crypto.randomUUID()}`, problemId, targetRef === "problem" ? "problem" : "ledger-object",
        targetRef, visibility, new Date().toISOString(), problemId, targetRef,
      ).run();
  }

  async deliverPublication(
    publicationId: string,
    decision: "pass" | "reject" = "pass",
    hideTargetDuringScreen?: string,
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
        screen: async (job) => {
          if (hideTargetDuringScreen !== undefined)
            await this.setArtifactSourceVisibility(job.problem_id, hideTargetDuringScreen, "hidden");
          return {
            decision,
            provider_status: "ok",
            evaluated_body_digest: `sha256:${job.screening_sha256}`,
            evaluated_context_digest: `sha256:${await publicationScreenContext(job)}`,
            model_version: WORKERS_AI_MODEL_VERSION,
            policy_version: WORKERS_AI_POLICY_VERSION,
            configuration_digest: `sha256:${"0".repeat(64)}`,
            coarse_category: decision === "pass" ? "benign-context" : "injection",
          };
        },
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
