import {
  KraterOutboxDrainer,
  type KraterOutboxEnv,
  kraterOutboxStub,
  OUTBOX_ALARM_BASE_MS,
  OUTBOX_ALARM_MAX_MS,
  OUTBOX_SCAN_AFTER_ID_KEY,
  OUTBOX_SCAN_WRAP_THROUGH_ID_KEY,
  outboxJsonResponse,
} from "./outbox-do";

/**
 * Local S-2 harness fault-injection subclass of `KraterOutboxDrainer`
 * (bead asimposiumorg-rc-strip-s2-faults-prod-do-i9bd).
 *
 * Wired ONLY into `apps/wire/src/krater/worker.ts` (the local S-2 spike Worker)
 * and unit tests. Never imported by `apps/wire/src/index.ts`, so zero fault
 * parameters or `/__s2/*` routes enter the deployable production Worker bundle.
 */
export type OutboxFaultMode = "none" | "fail-once" | "hold-before-ack";

interface OutboxCommand {
  faultMode: OutboxFaultMode;
}

interface StaleWrapFixtureCommand {
  scanAfterId: number;
  scanWrapThroughId: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseFaultMode(value: unknown): OutboxFaultMode {
  if (value === undefined || value === "none") return "none";
  if (value === "fail-once" || value === "hold-before-ack") return value;
  throw new Error("KRATER_OUTBOX_COMMAND_INVALID");
}

async function requestFaultCommand(request: Request): Promise<OutboxCommand> {
  if (request.method !== "POST") return { faultMode: "none" };
  const body = asRecord(await request.json());
  if (body === null) throw new Error("KRATER_OUTBOX_COMMAND_INVALID");
  return { faultMode: parseFaultMode(body.fault_mode) };
}

function parseStaleWrapFixtureCommand(value: unknown): StaleWrapFixtureCommand {
  const body = asRecord(value);
  const scanAfterId = body?.scan_after_id;
  const scanWrapThroughId = body?.scan_wrap_through_id;
  if (
    !isNonNegativeInteger(scanAfterId) ||
    !isNonNegativeInteger(scanWrapThroughId) ||
    scanWrapThroughId === 0 ||
    scanAfterId >= scanWrapThroughId
  ) {
    throw new Error("KRATER_OUTBOX_STALE_WRAP_FIXTURE_INVALID");
  }
  return { scanAfterId, scanWrapThroughId };
}

export async function requestTestableKraterOutbox(
  env: KraterOutboxEnv,
  pathname: "/nudge" | "/drain-now" | "/status",
  command: OutboxCommand = { faultMode: "none" },
): Promise<Response> {
  return kraterOutboxStub(env).fetch(
    new Request(`https://krater-outbox.internal${pathname}`, {
      method: pathname === "/status" ? "GET" : "POST",
      headers: pathname === "/status" ? undefined : { "content-type": "application/json" },
      body: pathname === "/status" ? undefined : JSON.stringify({ fault_mode: command.faultMode }),
    }),
  );
}

/** Local S-2 harness seam: production routing never exposes this request. */
export async function plantKraterOutboxStaleWrapForHarness(
  env: KraterOutboxEnv,
  scanAfterId: number,
  scanWrapThroughId: number,
): Promise<Response> {
  return kraterOutboxStub(env).fetch(
    new Request("https://krater-outbox.internal/__s2/plant-stale-wrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scan_after_id: scanAfterId,
        scan_wrap_through_id: scanWrapThroughId,
      }),
    }),
  );
}

export class TestableKraterOutboxDrainer extends KraterOutboxDrainer {
  private activeFaultMode: OutboxFaultMode = "none";

  override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    try {
      if (pathname === "/status" && request.method === "GET") {
        return outboxJsonResponse(await this.status());
      }
      if (pathname === "/nudge") {
        const command = await requestFaultCommand(request);
        await this.state.storage.put("fault_mode", command.faultMode);
        await this.setAlarm(OUTBOX_ALARM_BASE_MS);
        return outboxJsonResponse({ accepted: true, fault_mode: command.faultMode }, 202);
      }
      if (pathname === "/drain-now") {
        const command = await requestFaultCommand(request);
        return outboxJsonResponse(await this.drainWithFault("fetch", command.faultMode));
      }
      if (pathname === "/__s2/plant-stale-wrap" && request.method === "POST") {
        const fixture = parseStaleWrapFixtureCommand(await request.json());
        await this.state.storage.put({
          [OUTBOX_SCAN_AFTER_ID_KEY]: fixture.scanAfterId,
          [OUTBOX_SCAN_WRAP_THROUGH_ID_KEY]: fixture.scanWrapThroughId,
          // If the first recovery alarm wins the race with the harness's
          // observation, hold the restored row before ACK and keep it armed.
          fault_mode: "hold-before-ack",
        });
        await this.state.storage.deleteAlarm();
        return outboxJsonResponse({ planted: true }, 201);
      }
      return outboxJsonResponse({ code: "KRATER_OUTBOX_ROUTE_NOT_FOUND" }, 404);
    } catch (error) {
      return outboxJsonResponse(
        { code: error instanceof Error ? error.message : "KRATER_OUTBOX_FAILED" },
        400,
      );
    }
  }

  override async alarm(): Promise<void> {
    const faultMode = (await this.state.storage.get<OutboxFaultMode>("fault_mode")) ?? "none";
    await this.drainWithFault("alarm", faultMode);
  }

  private async drainWithFault(
    source: "alarm" | "fetch",
    faultMode: OutboxFaultMode,
  ): Promise<Record<string, unknown>> {
    this.activeFaultMode = faultMode;
    try {
      return await this.drain(source);
    } finally {
      this.activeFaultMode = "none";
    }
  }

  protected override isValidPhase(phase: string): boolean {
    return phase === "held-before-ack" || super.isValidPhase(phase);
  }

  protected override async beforeAcknowledgeRow(
    source: "alarm" | "fetch",
    delivered: number,
    quarantined: number,
    scanAfterId: number,
  ): Promise<Record<string, unknown> | undefined> {
    const faultMode = this.activeFaultMode;
    this.activeFaultMode = "none";
    if (faultMode === "hold-before-ack") {
      await this.state.storage.put(OUTBOX_SCAN_AFTER_ID_KEY, scanAfterId);
      await this.state.storage.put("fault_mode", "none");
      await this.updateCounters((current) => ({ ...current, last_phase: "held-before-ack" }));
      await this.setAlarm(OUTBOX_ALARM_MAX_MS);
      return { source, delivered, quarantined, held_before_ack: true };
    }
    if (faultMode === "fail-once") {
      await this.state.storage.put(OUTBOX_SCAN_AFTER_ID_KEY, scanAfterId);
      await this.state.storage.put("fault_mode", "none");
      const backoff = await this.retryAfterFailure();
      return { source, delivered, quarantined, retry_scheduled_ms: backoff };
    }
    return undefined;
  }

  protected override formatCompletedDrain(
    source: "alarm" | "fetch",
    delivered: number,
    quarantined: number,
  ): Record<string, unknown> {
    return { source, delivered, quarantined, held_before_ack: false };
  }
}
