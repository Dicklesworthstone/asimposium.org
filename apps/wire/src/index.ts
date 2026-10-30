import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { createApp } from "./app";
import type { Env } from "./env";
import { deliverHeraldRooms } from "./herald/outbox";
import { publicCursorCache } from "./herald/public-cursor-cache";
import { HeraldRoom } from "./herald/room";
import { type HeraldRuntimeEnv, heraldRoomFetch, scheduleHeraldDelivery } from "./herald/runtime";
import { publicWatchFetch } from "./http/public-watch-cors";
import { deliverDispositionChanges } from "./inbox/disposition-change";
import { deliverInboxEvents } from "./inbox/event-delivery";
import {
  artifactPublicationFetch,
  reconcileArtifactPublications,
} from "./krater/artifact-publication-runtime";
import { artifactFetch } from "./krater/artifact-runtime";
import { runScheduledBackup } from "./krater/backup-scheduler";
import { signPendingCheckpoints } from "./krater/checkpoint-signing.ts";
import { KraterOutboxDrainer, requestKraterOutbox } from "./krater/outbox-do";
import { expireSecurityRecords, publishDeletionJournal } from "./krater/retention.ts";
import { markDormantProblems } from "./problems/dormancy";
import { expireIdleSessions } from "./sessions/idle";
import { warnExpiringLeases } from "./sessions/lease-warnings";

/**
 * The Worker entrypoint: `a.asimposium.org`.
 *
 * The app is built once at module scope so route construction is not paid per
 * request, and the handler is a thin, typed adapter over it.
 */
const app = createApp();

export default {
  async fetch(request: Request, env: HeraldRuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    // Preserve the provider's 101/WebSocket capability outside ordinary CORS
    // response reconstruction. Internal room nudges never enter this gateway.
    try {
      const response = await heraldRoomFetch(request, env, () =>
        publicWatchFetch(request, () =>
          publicCursorCache.fetch(request, env, (readRequest) =>
            artifactPublicationFetch(readRequest, env, () =>
              artifactFetch(readRequest, env, () => app.fetch(readRequest, env, ctx)),
            ),
          ),
        ),
      );
      scheduleHeraldDelivery(request, response, env, ctx);
      return response;
    } finally {
      // A partial batch may commit before a later member fails. Invalidation
      // is cheap and conservative; only D1 can advance the public cursor.
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        await publicCursorCache.invalidate(env);
      }
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: HeraldRuntimeEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // Apply 0078 before enabling HERALD_ROOMS. Each consumer runs even if
    // another is down; all outcomes are observed before reporting failure.
    const checkpointTask = Promise.resolve().then(() =>
      signPendingCheckpoints(env.DB, env.CHECKPOINT_SIGNING_KEY),
    );
    const [
      sessions,
      outbox,
      inbox,
      artifacts,
      herald,
      checkpoints,
      journal,
      security,
      leases,
      dispositions,
      backups,
      dormancy,
    ] = await Promise.allSettled([
      Promise.resolve().then(() => expireIdleSessions(env.DB)),
      Promise.resolve().then(() => requestKraterOutbox(env, "/nudge")),
      Promise.resolve().then(() => deliverInboxEvents(env.DB)),
      Promise.resolve().then(() => reconcileArtifactPublications(env)),
      Promise.resolve().then(() => deliverHeraldRooms(env.DB, env.HERALD_ROOMS)),
      checkpointTask,
      // A point-in-time D1 restore rolls deletion_journal back; the signed R2
      // copy is what a restore replays so deleted data is not resurrected.
      Promise.resolve().then(() =>
        publishDeletionJournal(env.DB, env.ARTIFACTS, env.CHECKPOINT_SIGNING_KEY),
      ),
      // Retention teeth: expired nonces, device codes, stale lookup attempts
      // and dead proposals are minimized on schedule (never ledger history).
      Promise.resolve().then(() => expireSecurityRecords(env.DB)),
      // Private heads-up to a lease holder before the lease lapses.
      Promise.resolve().then(() => warnExpiringLeases(env.DB)),
      // Private notice when a claim's computed disposition moves.
      Promise.resolve().then(() => deliverDispositionChanges(env.DB)),
      // Sign first; a missing terminal signature retains a pinned pending
      // prefix. Each tick advances at most one bounded, privately stored archive.
      checkpointTask.then(() => runScheduledBackup(env)),
      // Only public scientific increments keep a problem active. The sweep
      // records each automatic transition in the same ledger as its work.
      Promise.resolve().then(() => markDormantProblems(env.DB)),
    ]);
    if (inbox.status === "fulfilled") {
      console.info(JSON.stringify({ stage: "inbox-event-delivery", ...inbox.value }));
    }
    if (artifacts.status === "fulfilled") {
      console.info(JSON.stringify({ stage: "artifact-publication-delivery", ...artifacts.value }));
    }
    if (checkpoints.status === "fulfilled") {
      console.info(JSON.stringify({ stage: "checkpoint-signing", ...checkpoints.value }));
    }
    if (journal.status === "fulfilled") {
      console.info(JSON.stringify({ stage: "deletion-journal-publication", ...journal.value }));
    }
    if (herald.status === "fulfilled" && herald.value.enabled) {
      console.info(JSON.stringify({ stage: "herald-room-delivery", ...herald.value }));
    }
    if (leases.status === "fulfilled") {
      console.info(JSON.stringify({ stage: "lease-expiry-warnings", ...leases.value }));
    }
    if (dormancy.status === "fulfilled") {
      console.info(JSON.stringify({ stage: "problem-dormancy-sweep", ...dormancy.value }));
    }
    if (backups.status === "fulfilled") {
      console.info(JSON.stringify({ stage: "nightly-ledger-backup", ...backups.value }));
    } else {
      const code =
        backups.reason instanceof Error && /^BACKUP_[A-Z_]+$/.test(backups.reason.message)
          ? backups.reason.message
          : "BACKUP_SCHEDULED_FAILED";
      console.error(JSON.stringify({ stage: "nightly-ledger-backup", status: "failed", code }));
    }
    if (sessions.status === "rejected") throw new Error("SESSION_IDLE_SWEEP_FAILED");
    if (leases.status === "rejected") throw new Error("LEASE_EXPIRY_WARNING_FAILED");
    if (dormancy.status === "rejected" || dormancy.value.failed > 0) {
      throw new Error("PROBLEM_DORMANCY_SWEEP_FAILED");
    }
    if (dispositions.status === "fulfilled") {
      console.info(JSON.stringify({ stage: "disposition-change-delivery", ...dispositions.value }));
    }
    if (dispositions.status === "rejected" || dispositions.value.failed > 0) {
      throw new Error("DISPOSITION_CHANGE_DELIVERY_FAILED");
    }
    if (outbox.status === "rejected" || !outbox.value.ok) {
      throw new Error("KRATER_OUTBOX_SCHEDULED_RECONCILE_FAILED");
    }
    if (inbox.status === "rejected" || inbox.value.failed > 0) {
      throw new Error("INBOX_EVENT_DELIVERY_FAILED");
    }
    if (checkpoints.status === "rejected") throw new Error("CHECKPOINT_SIGNING_FAILED");
    if (journal.status === "rejected") throw new Error("DELETION_JOURNAL_PUBLICATION_FAILED");
    if (security.status === "fulfilled") {
      console.info(JSON.stringify({ stage: "security-record-expiry", ...security.value }));
    } else {
      throw new Error("SECURITY_RECORD_EXPIRY_FAILED");
    }
    if (artifacts.status === "rejected" || artifacts.value.retry > 0 || artifacts.value.lost > 0) {
      throw new Error("ARTIFACT_PUBLICATION_DELIVERY_INCOMPLETE");
    }
    if (herald.status === "rejected" || herald.value.retry > 0) {
      throw new Error("HERALD_ROOM_DELIVERY_INCOMPLETE");
    }
    if (
      backups.status === "rejected" ||
      (backups.value.enabled && (backups.value.failed > 0 || backups.value.status === "incomplete"))
    ) {
      throw new Error("BACKUP_SCHEDULED_FAILED");
    }
  },
};

export type { Env };
export { createApp, HeraldRoom, KraterOutboxDrainer };
