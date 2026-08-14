const origin = process.env.S2_ORIGIN;
const phase = process.env.S2_PHASE ?? "exercise";

const REVISION = process.env.S2_GIT_HEAD;
const DIRTY_STATE = process.env.S2_GIT_DIRTY;
const SOURCE_DIGEST = process.env.S2_SOURCE_DIGEST;
const SEED = "s2-local-chain-v1";
const SCOPE = "local-workerd-d1-do";
const BINDINGS = { d1: "DB", durable_object: "KRATER_OUTBOX", r2: null };
const CREATED_AT = "2026-08-14T00:00:00.000Z";
const PRIMARY_PROBLEM = "P-s2";
const SECONDARY_PROBLEM = "P-s2-b";
const LARGE_PROBLEM = "P-s2-large";
const OUTBOX_PROBLEM = "P-s2-outbox";

interface WriteResult {
  event_id: string;
  seq: number;
  idempotent: boolean;
  pre_cursor: number;
  post_cursor: number;
  payload_sha256: string;
  row_digest: string;
  build_digest: string;
  chain_digest: string;
  checkpoint_digest: string;
  transaction_ms: number;
  d1_rows_read: number;
  d1_rows_written: number;
  d1_sql_ms: number | null;
  lock_wait_ms: null;
  retry_count: number;
  outbox_handoff: "armed" | "deferred" | "unavailable";
}

interface StateResult {
  cursor: number;
  counts: Record<string, number>;
  chain_digest: string;
  checkpoint_digest: string | null;
  checkpoint_mode: "unsigned-v0";
}

interface RequestResult {
  status: number;
  body: Record<string, unknown>;
  elapsedMs: number;
  contentType: string;
  requestId: string;
}

interface OutboxStatus {
  active: number;
  pending: number;
  alarm_at: number | null;
  owner_acquisitions: number;
  max_active: number;
  recovered_ownerships: number;
  delivery_attempts: number;
  delivered: number;
  quarantined: number;
  failures: number;
  last_backoff_ms: number | null;
  last_quarantine_code: string | null;
  last_phase: string;
}

let requestCount = 0;

const emit = (record: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

const fail = (code: string): never => {
  throw new Error(code);
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("S2_RESPONSE_INVALID");
  }
  return value as Record<string, unknown>;
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) fail("S2_RESPONSE_INVALID");
  return value as number;
}

function nullableNumberAt(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return value === null || value === undefined ? null : numberAt(record, key);
}

function stringAt(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") fail("S2_RESPONSE_INVALID");
  return value as string;
}

function nullableStringAt(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return value === null || value === undefined ? null : stringAt(record, key);
}

function booleanAt(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") fail("S2_RESPONSE_INVALID");
  return value as boolean;
}

function requestId(): string {
  requestCount += 1;
  return `REQ-s2-${String(requestCount).padStart(4, "0")}`;
}

function requestEventId(body: Record<string, unknown> | undefined): string | null {
  return body !== undefined && typeof body.event_id === "string" ? body.event_id : null;
}

function requestDiagnostics(
  requestIdValue: string,
  scenario: string,
  pathname: string,
  eventId: string | null,
  response: RequestResult | null,
  assertionDiff: string | null,
): void {
  const body = response?.body;
  emit({
    tool: "bun",
    tool_version: Bun.version,
    package: "apps/wire",
    suite: "s2-krater-local-d1",
    revision: REVISION,
    dirty_state: DIRTY_STATE,
    source_digest: SOURCE_DIGEST,
    bindings: BINDINGS,
    scenario,
    seed: SEED,
    scope: SCOPE,
    request_id: requestIdValue,
    event_id: eventId,
    route: pathname.split("?")[0],
    pre_cursor: body === undefined ? null : nullableNumberAt(body, "pre_cursor"),
    post_cursor: body === undefined ? null : nullableNumberAt(body, "post_cursor"),
    payload_sha256: body === undefined ? null : nullableStringAt(body, "payload_sha256"),
    row_digest: body === undefined ? null : nullableStringAt(body, "row_digest"),
    build_digest: body === undefined ? null : nullableStringAt(body, "build_digest"),
    chain_digest: body === undefined ? null : nullableStringAt(body, "chain_digest"),
    checkpoint_digest: body === undefined ? null : nullableStringAt(body, "checkpoint_digest"),
    transaction_ms: body === undefined ? null : nullableNumberAt(body, "transaction_ms"),
    sql_ms: body === undefined ? null : nullableNumberAt(body, "d1_sql_ms"),
    lock_wait_ms: body === undefined ? null : nullableNumberAt(body, "lock_wait_ms"),
    retry_count: body === undefined ? null : nullableNumberAt(body, "retry_count"),
    checkpoint_mode: body === undefined ? null : nullableStringAt(body, "checkpoint_mode"),
    assertion_diff: assertionDiff,
    status: response?.status ?? "transport-aborted",
    duration_ms: response?.elapsedMs ?? null,
  });
}

async function request(
  method: string,
  pathname: string,
  scenario: string,
  body?: Record<string, unknown>,
  timeoutMs = 5_000,
): Promise<RequestResult> {
  if (origin === undefined) fail("S2_ORIGIN_MISSING");
  const currentRequestId = requestId();
  const eventId = requestEventId(body);
  const started = performance.now();
  try {
    const fetchResponse = await fetch(`${origin}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsedMs = Math.round((performance.now() - started) * 1_000) / 1_000;
    const result: RequestResult = {
      status: fetchResponse.status,
      body: asRecord(await fetchResponse.json()),
      elapsedMs,
      contentType: fetchResponse.headers.get("content-type") ?? "",
      requestId: currentRequestId,
    };
    requestDiagnostics(currentRequestId, scenario, pathname, eventId, result, null);
    return result;
  } catch (_error) {
    requestDiagnostics(currentRequestId, scenario, pathname, eventId, null, "transport-aborted");
    throw new Error("S2_TRANSPORT_ABORTED");
  }
}

function writeBody(
  index: number,
  problemId = PRIMARY_PROBLEM,
  statement = `Synthetic S2 claim ${index}.`,
): Record<string, unknown> {
  const scope =
    problemId === PRIMARY_PROBLEM ? "s2" : problemId.replace(/^P-/, "").replaceAll("-", "");
  const suffix = `${scope}-${String(index).padStart(3, "0")}`;
  return {
    problem_id: problemId,
    claim_id: `C-${suffix}`,
    event_id: `E-${suffix}`,
    idempotency_key: `IK-${suffix}`,
    statement,
    created_at: CREATED_AT,
  };
}

function writeResult(body: Record<string, unknown>): WriteResult {
  return {
    event_id: stringAt(body, "event_id"),
    seq: numberAt(body, "seq"),
    idempotent: booleanAt(body, "idempotent"),
    pre_cursor: numberAt(body, "pre_cursor"),
    post_cursor: numberAt(body, "post_cursor"),
    payload_sha256: stringAt(body, "payload_sha256"),
    row_digest: stringAt(body, "row_digest"),
    build_digest: stringAt(body, "build_digest"),
    chain_digest: stringAt(body, "chain_digest"),
    checkpoint_digest: stringAt(body, "checkpoint_digest"),
    transaction_ms: numberAt(body, "transaction_ms"),
    d1_rows_read: numberAt(body, "d1_rows_read"),
    d1_rows_written: numberAt(body, "d1_rows_written"),
    d1_sql_ms: body.d1_sql_ms === null ? null : numberAt(body, "d1_sql_ms"),
    lock_wait_ms: body.lock_wait_ms === null ? null : fail("S2_RESPONSE_INVALID"),
    retry_count: numberAt(body, "retry_count"),
    outbox_handoff: (() => {
      const handoff = stringAt(body, "outbox_handoff");
      if (handoff !== "armed" && handoff !== "deferred" && handoff !== "unavailable") {
        fail("S2_RESPONSE_INVALID");
      }
      return handoff as WriteResult["outbox_handoff"];
    })(),
  };
}

function stateResult(body: Record<string, unknown>): StateResult {
  const counts = asRecord(body.counts);
  const typedCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value !== "number" || !Number.isFinite(value)) fail("S2_RESPONSE_INVALID");
    typedCounts[key] = value as number;
  }
  return {
    cursor: numberAt(body, "cursor"),
    counts: typedCounts,
    chain_digest: stringAt(body, "chain_digest"),
    checkpoint_digest: body.checkpoint_digest === null ? null : stringAt(body, "checkpoint_digest"),
    checkpoint_mode: (() => {
      const mode = stringAt(body, "checkpoint_mode");
      if (mode !== "unsigned-v0") fail("S2_CHECKPOINT_MODE_INVALID");
      return mode;
    })(),
  };
}

function assertEqual(actual: unknown, expected: unknown, code: string): void {
  if (actual !== expected) fail(code);
}

function percentile95(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0;
}

function canonicalState(state: StateResult): string {
  return JSON.stringify({
    chain_digest: state.chain_digest,
    checkpoint_digest: state.checkpoint_digest,
    checkpoint_mode: state.checkpoint_mode,
    counts: state.counts,
    cursor: state.cursor,
  });
}

async function seed(problemId: string, scenario: string): Promise<void> {
  const seeded = await request("POST", "/__s2/seed", scenario, {
    problem_id: problemId,
    created_at: CREATED_AT,
  });
  assertEqual(seeded.status, 201, "S2_SEED_FAILED");
}

async function state(problemId: string, scenario: string): Promise<StateResult> {
  const response = await request("GET", `/__s2/state?problem_id=${problemId}`, scenario);
  assertEqual(response.status, 200, "S2_STATE_READ_FAILED");
  return stateResult(response.body);
}

async function write(
  body: Record<string, unknown>,
  scenario: string,
  timeoutMs?: number,
  deferOutboxNudge = true,
): Promise<WriteResult> {
  const requestBody = deferOutboxNudge ? { ...body, s2_defer_outbox_nudge: true } : body;
  const result = await request("POST", "/__s2/write", scenario, requestBody, timeoutMs);
  assertEqual(result.status, 200, "S2_WRITE_FAILED");
  return writeResult(result.body);
}

function outboxStatusResult(body: Record<string, unknown>): OutboxStatus {
  return {
    active: numberAt(body, "active"),
    pending: numberAt(body, "pending"),
    alarm_at: nullableNumberAt(body, "alarm_at"),
    owner_acquisitions: numberAt(body, "owner_acquisitions"),
    max_active: numberAt(body, "max_active"),
    recovered_ownerships: numberAt(body, "recovered_ownerships"),
    delivery_attempts: numberAt(body, "delivery_attempts"),
    delivered: numberAt(body, "delivered"),
    quarantined: numberAt(body, "quarantined"),
    failures: numberAt(body, "failures"),
    last_backoff_ms: nullableNumberAt(body, "last_backoff_ms"),
    last_quarantine_code: nullableStringAt(body, "last_quarantine_code"),
    last_phase: stringAt(body, "last_phase"),
  };
}

async function outboxStatus(scenario: string): Promise<OutboxStatus> {
  const result = await request("GET", "/__s2/outbox/status", scenario);
  assertEqual(result.status, 200, "S2_OUTBOX_STATUS_FAILED");
  return outboxStatusResult(result.body);
}

async function waitForOutbox(
  scenario: string,
  predicate: (status: OutboxStatus) => boolean,
): Promise<OutboxStatus> {
  const deadline = performance.now() + 8_000;
  while (performance.now() < deadline) {
    const current = await outboxStatus(scenario);
    if (predicate(current)) return current;
    await Bun.sleep(50);
  }
  const observed = await outboxStatus(`${scenario}-deadline-observation`);
  emit({
    tool: "bun",
    tool_version: Bun.version,
    package: "apps/wire",
    suite: "s2-krater-local-d1",
    revision: REVISION,
    dirty_state: DIRTY_STATE,
    source_digest: SOURCE_DIGEST,
    bindings: BINDINGS,
    scenario: `${scenario}-deadline-observation`,
    seed: SEED,
    scope: SCOPE,
    request_id: null,
    event_id: null,
    pre_cursor: null,
    post_cursor: null,
    payload_sha256: null,
    row_digest: null,
    build_digest: null,
    checkpoint_digest: null,
    transaction_ms: null,
    sql_ms: null,
    lock_wait_ms: null,
    retry_count: observed.delivery_attempts,
    assertion_diff: `pending=${observed.pending};delivered=${observed.delivered};quarantined=${observed.quarantined};phase=${observed.last_phase}`,
    status: "fail",
    duration_ms: 8_000,
  });
  return fail("S2_OUTBOX_DEADLINE_EXCEEDED");
}

async function expectTransportAbort(
  body: Record<string, unknown>,
  scenario: string,
): Promise<void> {
  try {
    await request("POST", "/__s2/write", scenario, body, 20);
  } catch (error) {
    if (error instanceof Error && error.message === "S2_TRANSPORT_ABORTED") return;
    throw error;
  }
  fail("S2_TRANSPORT_ABORT_EXPECTED");
}

async function assertReplay(
  problemId: string,
  expectedEvents: number,
  scenario: string,
): Promise<void> {
  const replay = await request("POST", "/__s2/replay", scenario, { problem_id: problemId });
  assertEqual(replay.status, 200, "S2_PROJECTION_REPLAY_FAILED");
  assertEqual(booleanAt(replay.body, "matches"), true, "S2_PROJECTION_REPLAY_MISMATCH");
  assertEqual(numberAt(replay.body, "event_count"), expectedEvents, "S2_REPLAY_PAGE_COUNT_INVALID");
}

async function exerciseOutboxDrainer(): Promise<void> {
  await seed(OUTBOX_PROBLEM, "outbox-seed");
  const before = await outboxStatus("outbox-before-auto-handoff");
  const auto = await write(
    writeBody(1, OUTBOX_PROBLEM, "Outbox automatic handoff claim."),
    "outbox-automatic-handoff",
    undefined,
    false,
  );
  assertEqual(auto.outbox_handoff, "armed", "S2_OUTBOX_HANDOFF_NOT_ARMED");
  const afterAuto = await waitForOutbox(
    "outbox-auto-alarm-delivery",
    (status) => status.delivered >= before.delivered + 1 && status.pending === 0,
  );
  assertEqual(afterAuto.max_active, 1, "S2_OUTBOX_AUTO_SINGLE_OWNER_INVALID");
  const autoState = await state(OUTBOX_PROBLEM, "outbox-auto-visible-state");
  for (const table of ["claims", "claim_projections", "events", "outbox"] as const) {
    assertEqual(autoState.counts[table], 1, "S2_OUTBOX_AUTO_DUPLICATED_VISIBLE_ROW");
  }

  const concurrent = await write(
    writeBody(2, OUTBOX_PROBLEM, "Outbox concurrent alarm claim."),
    "outbox-concurrent-write",
  );
  assertEqual(concurrent.outbox_handoff, "deferred", "S2_OUTBOX_DEFERRED_WRITE_INVALID");
  const nudges = await Promise.all(
    Array.from({ length: 12 }, () =>
      request("POST", "/__s2/outbox/nudge", "outbox-concurrent-alarm", { fault_mode: "none" }),
    ),
  );
  for (const nudge of nudges) assertEqual(nudge.status, 202, "S2_OUTBOX_NUDGE_FAILED");
  const afterConcurrent = await waitForOutbox(
    "outbox-concurrent-alarm-delivery",
    (status) => status.delivered >= afterAuto.delivered + 1 && status.pending === 0,
  );
  assertEqual(afterConcurrent.max_active, 1, "S2_OUTBOX_CONCURRENT_OWNERSHIP_VIOLATION");
  assertEqual(afterConcurrent.active, 0, "S2_OUTBOX_ACTIVE_OWNER_LEAKED");

  const transient = await write(
    writeBody(3, OUTBOX_PROBLEM, "Outbox retry claim."),
    "outbox-retry-write",
  );
  const failOnce = await request("POST", "/__s2/outbox/drain", "outbox-rearm-backoff", {
    fault_mode: "fail-once",
  });
  assertEqual(failOnce.status, 200, "S2_OUTBOX_FAIL_ONCE_ROUTE_FAILED");
  const retryScheduled = numberAt(failOnce.body, "retry_scheduled_ms");
  assertEqual(retryScheduled >= 25 && retryScheduled <= 2_000, true, "S2_OUTBOX_BACKOFF_UNBOUNDED");
  const afterRetry = await waitForOutbox(
    "outbox-rearm-delivery",
    (status) => status.delivered >= afterConcurrent.delivered + 1 && status.pending === 0,
  );
  assertEqual(
    afterRetry.delivery_attempts >= before.delivery_attempts + 2,
    true,
    "S2_OUTBOX_NOT_AT_LEAST_ONCE",
  );
  assertEqual(transient.seq, 3, "S2_OUTBOX_RETRY_SEQUENCE_INVALID");

  const held = await write(
    writeBody(4, OUTBOX_PROBLEM, "Outbox kill-boundary claim."),
    "outbox-hold-before-ack-write",
  );
  const malformed = await write(
    writeBody(5, OUTBOX_PROBLEM, "Outbox malformed fixture claim."),
    "outbox-malformed-write",
  );
  const planted = await request(
    "POST",
    "/__s2/outbox/plant-malformed",
    "outbox-malformed-payload-negative",
    { event_id: malformed.event_id },
  );
  assertEqual(planted.status, 201, "S2_OUTBOX_MALFORMED_FIXTURE_FAILED");
  const hold = await request("POST", "/__s2/outbox/drain", "outbox-hold-before-ack", {
    fault_mode: "hold-before-ack",
  });
  assertEqual(hold.status, 200, "S2_OUTBOX_HOLD_ROUTE_FAILED");
  assertEqual(booleanAt(hold.body, "held_before_ack"), true, "S2_OUTBOX_HOLD_NOT_REACHED");
  const heldStatus = await outboxStatus("outbox-kill-boundary-status");
  assertEqual(heldStatus.last_phase, "held-before-ack", "S2_OUTBOX_KILL_BOUNDARY_NOT_DURABLE");
  assertEqual(heldStatus.alarm_at === null, false, "S2_OUTBOX_KILL_REARM_MISSING");
  assertEqual(held.seq, 4, "S2_OUTBOX_HOLD_SEQUENCE_INVALID");
}

async function exercise(): Promise<void> {
  const writes: WriteResult[] = [];
  await seed(PRIMARY_PROBLEM, "seed-primary");

  const first = await write(writeBody(1), "first-write");
  assertEqual(first.seq, 1, "S2_FIRST_SEQUENCE_INVALID");
  assertEqual(first.idempotent, false, "S2_FIRST_WRITE_MARKED_IDEMPOTENT");
  assertEqual(first.pre_cursor, 0, "S2_FIRST_PRE_CURSOR_INVALID");
  assertEqual(first.post_cursor, 1, "S2_FIRST_POST_CURSOR_INVALID");
  writes.push(first);

  const sameKey = await Promise.all(
    Array.from({ length: 12 }, () => write(writeBody(1), "same-key-concurrency")),
  );
  for (const entry of sameKey) {
    assertEqual(entry.seq, 1, "S2_SAME_KEY_SEQUENCE_INVALID");
    assertEqual(entry.idempotent, true, "S2_SAME_KEY_REPLAY_NOT_IDEMPOTENT");
  }

  const concurrent = await Promise.all(
    Array.from({ length: 12 }, (_, offset) =>
      write(writeBody(offset + 2), "chain-head-contention"),
    ),
  );
  const sequences = concurrent.map((entry) => entry.seq).sort((left, right) => left - right);
  assertEqual(sequences.join(","), "2,3,4,5,6,7,8,9,10,11,12,13", "S2_SEQUENCE_INVALID");
  writes.push(...concurrent);

  await seed(SECONDARY_PROBLEM, "seed-secondary");
  const secondary = await write(
    writeBody(1, SECONDARY_PROBLEM, "Secondary problem claim."),
    "per-problem-sequence",
  );
  assertEqual(secondary.seq, 1, "S2_SECONDARY_SEQUENCE_INVALID");
  writes.push(secondary);

  const primaryState = await state(PRIMARY_PROBLEM, "cursor-and-row-counts");
  assertEqual(primaryState.cursor, 13, "S2_PRIMARY_CURSOR_INVALID");
  for (const table of [
    "claims",
    "claim_projections",
    "events",
    "idempotency",
    "outbox",
    "integrity_checkpoints",
  ]) {
    assertEqual(primaryState.counts[table], 13, "S2_PRIMARY_ROW_COUNT_INVALID");
  }
  if (primaryState.checkpoint_digest === null) fail("S2_CHECKPOINT_MISSING");
  assertEqual(primaryState.checkpoint_mode, "unsigned-v0", "S2_CHECKPOINT_MODE_INVALID");
  const secondaryState = await state(SECONDARY_PROBLEM, "per-problem-cursor");
  assertEqual(secondaryState.cursor, 1, "S2_SECONDARY_CURSOR_INVALID");

  const events = await request(
    "GET",
    `/__s2/events?problem_id=${PRIMARY_PROBLEM}&since=0&limit=200`,
    "cursor-read",
  );
  assertEqual(events.status, 200, "S2_CURSOR_READ_FAILED");
  const eventRows = events.body.events;
  if (!Array.isArray(eventRows) || eventRows.length !== 13) fail("S2_EVENT_PAGE_INVALID");

  const fts = await request("GET", "/__s2/search?q=Synthetic&limit=20", "fts-read");
  assertEqual(fts.status, 200, "S2_FTS_QUERY_FAILED");
  const ftsMatches = fts.body.matches;
  if (!Array.isArray(ftsMatches) || ftsMatches.length !== 13) fail("S2_FTS_RESULT_INVALID");

  const malformedFts = await request(
    "GET",
    "/__s2/search?q=%22&limit=10",
    "malformed-fts-negative",
  );
  assertEqual(malformedFts.status, 400, "S2_MALFORMED_FTS_STATUS_INVALID");
  assertEqual(
    malformedFts.contentType.startsWith("application/problem+json"),
    true,
    "S2_MALFORMED_FTS_MEDIA_INVALID",
  );
  assertEqual(malformedFts.body.code, "KRATER_READ_INVALID", "S2_MALFORMED_FTS_CODE_INVALID");
  for (const field of ["type", "title", "detail", "rule", "fix_hint", "schema"] as const) {
    stringAt(malformedFts.body, field);
  }
  asRecord(malformedFts.body.example);

  const rebuiltFts = await request("POST", "/__s2/rebuild-fts", "fts-rebuild", {
    problem_id: PRIMARY_PROBLEM,
  });
  assertEqual(rebuiltFts.status, 200, "S2_FTS_REBUILD_FAILED");
  const rebuiltSearch = await request(
    "GET",
    "/__s2/search?q=Synthetic&limit=20",
    "fts-rebuild-read",
  );
  const rebuiltMatches = rebuiltSearch.body.matches;
  if (!Array.isArray(rebuiltMatches) || rebuiltMatches.length !== 13) {
    fail("S2_FTS_REBUILD_RESULT_INVALID");
  }

  await assertReplay(PRIMARY_PROBLEM, 13, "replay-primary");
  await assertReplay(SECONDARY_PROBLEM, 1, "replay-secondary");

  for (const operation of ["update", "delete"] as const) {
    const tamper = await request(
      "POST",
      "/__s2/tamper-envelope",
      `envelope-${operation}-negative`,
      {
        event_id: "E-s2-001",
        operation,
      },
    );
    assertEqual(tamper.status, 409, "S2_ENVELOPE_TAMPER_STATUS_INVALID");
    assertEqual(tamper.body.code, "EVENT_ENVELOPE_IMMUTABLE", "S2_ENVELOPE_TAMPER_CODE_INVALID");
  }

  const redaction = await request("POST", "/__s2/redact-content", "lawful-content-redaction", {
    event_id: "E-s2-001",
    reason: "privacy",
    redacted_at: CREATED_AT,
  });
  assertEqual(redaction.status, 200, "S2_CONTENT_REDACTION_FAILED");
  await assertReplay(PRIMARY_PROBLEM, 13, "replay-after-redaction");

  const preFaultState = await state(PRIMARY_PROBLEM, "transaction-fault-pre-state");
  const fault = await request("POST", "/__s2/write", "transaction-fault-negative", {
    ...writeBody(14, PRIMARY_PROBLEM, "Synthetic conflicting claim."),
    claim_id: "C-s2-001",
  });
  assertEqual(fault.status, 409, "S2_PLANTED_TRANSACTION_FAULT_NOT_REJECTED");
  assertEqual(fault.body.code, "KRATER_WRITE_FAILED", "S2_PLANTED_TRANSACTION_FAULT_CODE_INVALID");
  const postFaultState = await state(PRIMARY_PROBLEM, "transaction-fault-post-state");
  assertEqual(
    canonicalState(postFaultState),
    canonicalState(preFaultState),
    "S2_FAULT_PARTIAL_COMMIT",
  );

  const beforeDisconnect = {
    ...writeBody(14),
    s2_abort_before_commit: true,
    s2_pre_commit_delay_ms: 125,
  };
  await expectTransportAbort(beforeDisconnect, "disconnect-before-commit");
  await Bun.sleep(160);
  const stateAfterBeforeDisconnect = await state(PRIMARY_PROBLEM, "disconnect-before-commit-state");
  assertEqual(stateAfterBeforeDisconnect.cursor, 13, "S2_DISCONNECT_BEFORE_COMMIT_ADVANCED_CURSOR");
  const retriedBeforeDisconnect = await write(writeBody(14), "disconnect-before-commit-retry");
  assertEqual(
    retriedBeforeDisconnect.idempotent,
    false,
    "S2_DISCONNECT_BEFORE_COMMIT_RETRY_INVALID",
  );
  writes.push(retriedBeforeDisconnect);

  const afterDisconnect = { ...writeBody(15), s2_post_commit_delay_ms: 125 };
  await expectTransportAbort(afterDisconnect, "disconnect-after-commit");
  await Bun.sleep(160);
  const retriedAfterDisconnect = await write(writeBody(15), "disconnect-after-commit-retry");
  assertEqual(retriedAfterDisconnect.idempotent, true, "S2_DISCONNECT_AFTER_COMMIT_RETRY_INVALID");

  const contention = await Promise.all(
    Array.from({ length: 16 }, (_, offset) => write(writeBody(offset + 16), "lock-contention")),
  );
  const contentionSeq = contention.map((entry) => entry.seq).sort((left, right) => left - right);
  assertEqual(
    contentionSeq.join(","),
    "16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31",
    "S2_LOCK_CONTENTION_SEQUENCE_INVALID",
  );
  writes.push(...contention);

  const durableOutboxState = await state(PRIMARY_PROBLEM, "outbox-before-worker-restart");
  assertEqual(durableOutboxState.cursor, 31, "S2_OUTBOX_CURSOR_INVALID");
  assertEqual(durableOutboxState.counts.outbox, 31, "S2_OUTBOX_PENDING_INVALID");
  assertEqual(durableOutboxState.counts.integrity_checkpoints, 31, "S2_CHECKPOINT_COUNT_INVALID");

  const readStorm = await Promise.all(
    Array.from({ length: 64 }, () =>
      request("GET", `/__s2/cursor?problem_id=${PRIMARY_PROBLEM}`, "local-read-storm"),
    ),
  );
  for (const read of readStorm) {
    assertEqual(read.status, 200, "S2_READ_STORM_STATUS_INVALID");
    assertEqual(numberAt(read.body, "cursor"), 31, "S2_READ_STORM_CURSOR_INVALID");
  }

  await seed(LARGE_PROBLEM, "seed-large-replay-corpus");
  for (let index = 1; index <= 201; index += 1) {
    const large = await write(
      writeBody(index, LARGE_PROBLEM, `Large replay corpus claim ${index}.`),
      "large-paginated-replay-corpus",
    );
    writes.push(large);
  }
  await assertReplay(LARGE_PROBLEM, 201, "large-paginated-full-replay");
  await exerciseOutboxDrainer();

  emit({
    tool: "bun",
    tool_version: Bun.version,
    package: "apps/wire",
    suite: "s2-krater-local-d1",
    revision: REVISION,
    bindings: BINDINGS,
    scenario: "canonical-write-cursor-fts-replay-fault-contention",
    seed: SEED,
    scope: SCOPE,
    request_id: null,
    event_id: null,
    pre_cursor: 0,
    post_cursor: 201,
    payload_sha256: null,
    row_digest: null,
    build_digest: null,
    checkpoint_digest: null,
    transaction_ms: percentile95(writes.map((entry) => entry.transaction_ms)),
    sql_ms: null,
    lock_wait_ms: null,
    retry_count: writes.reduce((total, entry) => total + entry.retry_count, 0),
    assertion_diff: null,
    requests: requestCount,
    d1_rows_read: writes.reduce((total, entry) => total + entry.d1_rows_read, 0),
    d1_rows_written: writes.reduce((total, entry) => total + entry.d1_rows_written, 0),
    status: "pass",
    reproduce: "scripts/e2e-s2-krater.sh",
  });
}

async function restartVerify(): Promise<void> {
  const primary = await state(PRIMARY_PROBLEM, "outbox-worker-restart-state");
  assertEqual(primary.cursor, 31, "S2_RESTART_CURSOR_INVALID");
  assertEqual(primary.counts.outbox, 31, "S2_RESTART_OUTBOX_INVALID");
  assertEqual(primary.counts.integrity_checkpoints, 31, "S2_RESTART_CHECKPOINT_INVALID");
  await assertReplay(PRIMARY_PROBLEM, 31, "outbox-worker-restart-replay");
  await assertReplay(LARGE_PROBLEM, 201, "large-replay-after-worker-restart");
  const recoveredOutbox = await waitForOutbox(
    "outbox-kill-restart-recovery",
    (status) =>
      status.quarantined === 1 &&
      status.pending === 1 &&
      status.last_phase === "quarantined" &&
      status.last_quarantine_code === "OUTBOX_PAYLOAD_INVALID",
  );
  assertEqual(recoveredOutbox.max_active, 1, "S2_OUTBOX_RESTART_OWNERSHIP_VIOLATION");
  assertEqual(recoveredOutbox.active, 0, "S2_OUTBOX_RESTART_ACTIVE_OWNER_LEAKED");
  assertEqual(recoveredOutbox.delivery_attempts >= 2, true, "S2_OUTBOX_RESTART_NOT_AT_LEAST_ONCE");
  assertEqual(
    recoveredOutbox.last_quarantine_code,
    "OUTBOX_PAYLOAD_INVALID",
    "S2_OUTBOX_QUARANTINE_DIAGNOSTIC_INVALID",
  );
  const outboxProblem = await state(OUTBOX_PROBLEM, "outbox-restart-visible-state");
  for (const table of ["claims", "claim_projections", "events", "outbox"] as const) {
    assertEqual(outboxProblem.counts[table], 5, "S2_OUTBOX_RESTART_DUPLICATED_VISIBLE_ROW");
  }
  await assertReplay(OUTBOX_PROBLEM, 5, "outbox-restart-visible-replay");
  emit({
    tool: "bun",
    tool_version: Bun.version,
    package: "apps/wire",
    suite: "s2-krater-local-d1",
    revision: REVISION,
    bindings: BINDINGS,
    scenario: "outbox-crash-restart-at-least-once-without-visible-duplicates",
    seed: SEED,
    scope: SCOPE,
    request_id: null,
    event_id: null,
    pre_cursor: 4,
    post_cursor: 4,
    payload_sha256: null,
    row_digest: null,
    build_digest: null,
    checkpoint_digest: primary.checkpoint_digest,
    transaction_ms: null,
    sql_ms: null,
    lock_wait_ms: null,
    retry_count: recoveredOutbox.delivery_attempts,
    assertion_diff: null,
    requests: requestCount,
    status: "pass",
    reproduce: "scripts/e2e-s2-krater.sh",
  });
}

async function main(): Promise<void> {
  if (origin === undefined) fail("S2_ORIGIN_MISSING");
  if (REVISION === undefined || !/^[0-9a-f]{40}$/.test(REVISION)) fail("S2_GIT_HEAD_INVALID");
  if (DIRTY_STATE !== "clean" && DIRTY_STATE !== "dirty") fail("S2_GIT_DIRTY_INVALID");
  if (SOURCE_DIGEST === undefined || !/^[0-9a-f]{64}$/.test(SOURCE_DIGEST)) {
    fail("S2_SOURCE_DIGEST_INVALID");
  }
  if (phase === "exercise") return exercise();
  if (phase === "restart-verify") return restartVerify();
  fail("S2_PHASE_INVALID");
}

main().catch((error: unknown) => {
  emit({
    tool: "bun",
    tool_version: Bun.version,
    package: "apps/wire",
    suite: "s2-krater-local-d1",
    revision: REVISION,
    bindings: BINDINGS,
    scenario: phase,
    seed: SEED,
    scope: SCOPE,
    request_id: null,
    event_id: null,
    pre_cursor: null,
    post_cursor: null,
    payload_sha256: null,
    row_digest: null,
    build_digest: null,
    checkpoint_digest: null,
    transaction_ms: null,
    sql_ms: null,
    lock_wait_ms: null,
    retry_count: null,
    assertion_diff: error instanceof Error ? error.message : "S2_UNEXPECTED_FAILURE",
    status: "fail",
    reproduce: "scripts/e2e-s2-krater.sh",
  });
  process.exitCode = 1;
});
