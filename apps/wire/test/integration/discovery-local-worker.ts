/** Local test entrypoint only. Never referenced by a deployment configuration.
 * D1/R2 and all HTTP routes are real; the classifier returns fixture decisions.
 * Sponsor fixture methods exercise the production store, not Google/envelope auth.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  Request as WorkerRequest,
  Response as WorkerResponse,
} from "@cloudflare/workers-types";
import { createApp } from "../../src/app.ts";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { genesisChainDigest } from "../../src/krater/krater.ts";

export { KraterOutboxDrainer } from "../../src/krater/outbox-do.ts";

let screenCalls = 0;
let revokeDuringNextScreen = false;
let screenMode: "pass" | "reject" | "quarantine" | "unavailable" = "pass";
let lastScreen: { kind: string; problemId: string; fellowId: string; digest: string } | undefined;
const app = createApp({
  screenPromotion: async (input, env) => {
    screenCalls += 1;
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
    if (screenMode !== "pass")
      return { decision: screenMode, coarse_category: "injection", provider_status: "ok" };
    return {
      decision: input.statement.includes("LOCAL_POLICY_CANARY") ? "reject" : "pass",
      coarse_category: input.statement.includes("LOCAL_POLICY_CANARY")
        ? "injection"
        : "benign-context",
      provider_status: "ok",
    };
  },
});

export default class DiscoveryLocalWorker extends WorkerEntrypoint<Env> {
  override async fetch(request: WorkerRequest): Promise<WorkerResponse> {
    // The harness compiles in Workerd; Hono's shared test declarations resolve Bun globals.
    const response = await app.fetch(request as unknown as Request, this.env, this.ctx);
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

  async mint(sponsorId: string) {
    const principal = { type: "sponsor", sponsorId } as const;
    const service = this.service();
    await service.bootstrapSponsor(principal);
    return service.mint(principal, { requested_scopes: ["promote", "review"] });
  }

  async approve(sponsorId: string, enrollmentId: string) {
    await this.service().decide({ type: "sponsor", sponsorId }, enrollmentId, {
      enrollment_id: enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
  }

  async seedProblem(id: string) {
    const at = new Date().toISOString();
    const genesis = await genesisChainDigest(id);
    await this.env.DB.batch([
      this.env.DB.prepare(
        "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_digest, chain_version) VALUES (?, 0, ?, ?, ?, 2)",
      ).bind(id, at, at, genesis),
      this.env.DB.prepare(
        "INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version) VALUES (?, 'complete', 0, ?, 2)",
      ).bind(id, at),
    ]);
  }

  screeningCalls(): number {
    return screenCalls;
  }

  setScreenMode(mode: "pass" | "reject" | "quarantine" | "unavailable"): void {
    screenMode = mode;
  }

  lastScreening() {
    return lastScreen;
  }

  revokeOnNextScreen(): void {
    revokeDuringNextScreen = true;
  }
}
