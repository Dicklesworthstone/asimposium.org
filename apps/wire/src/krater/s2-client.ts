const origin = process.env.S2_ORIGIN;

interface WriteResult {
  event_id: string;
  seq: number;
  idempotent: boolean;
  payload_sha256: string;
  transaction_ms: number;
  d1_rows_read: number;
  d1_rows_written: number;
  d1_sql_ms: number | null;
  lock_wait_ms: null;
}

interface StateResult {
  cursor: number;
  counts: Record<string, number>;
}

const emit = (record: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

const fail = (code: string): never => {
  throw new Error(code);
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("S2_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) fail("S2_RESPONSE_INVALID");
  return value as number;
}

function booleanAt(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") fail("S2_RESPONSE_INVALID");
  return value as boolean;
}

async function request(
  method: string,
  pathname: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; elapsedMs: number }> {
  if (origin === undefined) fail("S2_ORIGIN_MISSING");
  const started = performance.now();
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const elapsedMs = Math.round((performance.now() - started) * 1_000) / 1_000;
  const parsed = asRecord(await response.json());
  emit({
    tool: "bun",
    package: "apps/wire",
    suite: "s2-krater-local-d1",
    scenario: "local-worker-request",
    route: pathname.split("?")[0],
    status: response.status,
    duration_ms: elapsedMs,
  });
  return { status: response.status, body: parsed, elapsedMs };
}

function writeBody(
  index: number,
  statement = `Synthetic S2 claim ${index}.`,
): Record<string, unknown> {
  const suffix = String(index).padStart(3, "0");
  return {
    problem_id: "P-s2",
    claim_id: `C-s2-${suffix}`,
    event_id: `E-s2-${suffix}`,
    idempotency_key: `IK-s2-${suffix}`,
    statement,
    created_at: "2026-08-14T00:00:00.000Z",
  };
}

function writeResult(body: Record<string, unknown>): WriteResult {
  return {
    event_id: typeof body.event_id === "string" ? body.event_id : fail("S2_RESPONSE_INVALID"),
    seq: numberAt(body, "seq"),
    idempotent: booleanAt(body, "idempotent"),
    payload_sha256:
      typeof body.payload_sha256 === "string" ? body.payload_sha256 : fail("S2_RESPONSE_INVALID"),
    transaction_ms: numberAt(body, "transaction_ms"),
    d1_rows_read: numberAt(body, "d1_rows_read"),
    d1_rows_written: numberAt(body, "d1_rows_written"),
    d1_sql_ms: body.d1_sql_ms === null ? null : numberAt(body, "d1_sql_ms"),
    lock_wait_ms: body.lock_wait_ms === null ? null : fail("S2_RESPONSE_INVALID"),
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
  };
}

function assertEqual(actual: unknown, expected: unknown, code: string): void {
  if (actual !== expected) fail(code);
}

function percentile95(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0;
}

async function main(): Promise<void> {
  if (origin === undefined) fail("S2_ORIGIN_MISSING");
  const seed = await request("POST", "/__s2/seed", {
    problem_id: "P-s2",
    created_at: "2026-08-14T00:00:00.000Z",
  });
  assertEqual(seed.status, 201, "S2_SEED_FAILED");

  const first = await request("POST", "/__s2/write", writeBody(1));
  assertEqual(first.status, 200, "S2_FIRST_WRITE_FAILED");
  const firstResult = writeResult(first.body);
  assertEqual(firstResult.seq, 1, "S2_FIRST_SEQUENCE_INVALID");
  assertEqual(firstResult.idempotent, false, "S2_FIRST_WRITE_MARKED_IDEMPOTENT");

  const replayed = await request("POST", "/__s2/write", writeBody(1));
  assertEqual(replayed.status, 200, "S2_IDEMPOTENT_REPLAY_FAILED");
  const replayedResult = writeResult(replayed.body);
  assertEqual(replayedResult.seq, 1, "S2_IDEMPOTENT_REPLAY_ADVANCED_CURSOR");
  assertEqual(replayedResult.idempotent, true, "S2_IDEMPOTENT_REPLAY_NOT_RECOGNIZED");

  const concurrent = await Promise.all(
    Array.from({ length: 8 }, (_, offset) => request("POST", "/__s2/write", writeBody(offset + 2))),
  );
  const concurrentResults = concurrent.map((entry) => {
    assertEqual(entry.status, 200, "S2_CONCURRENT_WRITE_FAILED");
    return writeResult(entry.body);
  });
  const sequences = concurrentResults.map((entry) => entry.seq).sort((left, right) => left - right);
  assertEqual(sequences.join(","), "2,3,4,5,6,7,8,9", "S2_CONCURRENT_SEQUENCE_INVALID");

  const stateBeforeFault = stateResult((await request("GET", "/__s2/state?problem_id=P-s2")).body);
  assertEqual(stateBeforeFault.cursor, 9, "S2_CURSOR_AFTER_CONCURRENCY_INVALID");
  for (const table of ["claims", "claim_projections", "events", "idempotency", "outbox"]) {
    assertEqual(stateBeforeFault.counts[table], 9, "S2_PRE_FAULT_ROW_COUNT_INVALID");
  }

  const events = await request("GET", "/__s2/events?problem_id=P-s2&since=0&limit=200");
  assertEqual(events.status, 200, "S2_CURSOR_READ_FAILED");
  const eventRows = events.body.events;
  if (!Array.isArray(eventRows) || eventRows.length !== 9) fail("S2_EVENT_PAGE_INVALID");

  const fts = await request("GET", "/__s2/search?q=Synthetic&limit=20");
  assertEqual(fts.status, 200, "S2_FTS_QUERY_FAILED");
  const ftsMatches = fts.body.matches;
  if (!Array.isArray(ftsMatches) || ftsMatches.length !== 9) fail("S2_FTS_RESULT_INVALID");

  const rebuiltFts = await request("POST", "/__s2/rebuild-fts", { problem_id: "P-s2" });
  assertEqual(rebuiltFts.status, 200, "S2_FTS_REBUILD_FAILED");
  const rebuiltFtsSearch = await request("GET", "/__s2/search?q=Synthetic&limit=20");
  const rebuiltMatches = rebuiltFtsSearch.body.matches;
  if (!Array.isArray(rebuiltMatches) || rebuiltMatches.length !== 9)
    fail("S2_FTS_REBUILD_RESULT_INVALID");

  const replay = await request("POST", "/__s2/replay", { problem_id: "P-s2" });
  assertEqual(replay.status, 200, "S2_PROJECTION_REPLAY_FAILED");
  assertEqual(booleanAt(replay.body, "matches"), true, "S2_PROJECTION_REPLAY_MISMATCH");

  const fault = await request("POST", "/__s2/write", {
    ...writeBody(10, "Synthetic S2 conflicting claim."),
    claim_id: "C-s2-001",
    event_id: "E-s2-fault",
    idempotency_key: "IK-s2-fault",
  });
  assertEqual(fault.status, 409, "S2_PLANTED_TRANSACTION_FAULT_NOT_REJECTED");
  assertEqual(fault.body.code, "KRATER_WRITE_FAILED", "S2_PLANTED_TRANSACTION_FAULT_CODE_INVALID");

  const stateAfterFault = stateResult((await request("GET", "/__s2/state?problem_id=P-s2")).body);
  assertEqual(
    canonicalState(stateAfterFault),
    canonicalState(stateBeforeFault),
    "S2_FAULT_PARTIAL_COMMIT",
  );

  const writeMetrics = [firstResult, ...concurrentResults];
  emit({
    tool: "bun",
    tool_version: Bun.version,
    package: "apps/wire",
    suite: "s2-krater-local-d1",
    scenario: "canonical-write-cursor-fts-replay-fault",
    seed: "s2-local-v0",
    scope: "local-workerd-d1",
    requests: 14,
    p95_transaction_ms: percentile95(writeMetrics.map((entry) => entry.transaction_ms)),
    d1_rows_read: writeMetrics.reduce((total, entry) => total + entry.d1_rows_read, 0),
    d1_rows_written: writeMetrics.reduce((total, entry) => total + entry.d1_rows_written, 0),
    lock_wait_ms: null,
    status: "pass",
    reproduce: "scripts/e2e-s2-krater.sh",
  });
}

function canonicalState(state: StateResult): string {
  return JSON.stringify({ cursor: state.cursor, counts: state.counts });
}

main().catch((error: unknown) => {
  emit({
    tool: "bun",
    tool_version: Bun.version,
    package: "apps/wire",
    suite: "s2-krater-local-d1",
    scenario: "canonical-write-cursor-fts-replay-fault",
    status: "fail",
    code: error instanceof Error ? error.message : "S2_UNEXPECTED_FAILURE",
    reproduce: "scripts/e2e-s2-krater.sh",
  });
  process.exitCode = 1;
});
