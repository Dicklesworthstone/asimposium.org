/** OPS.2a write-outcome diagnostics for mounted Fellow writes (bead
 * asimposiumorg-rvi). One record per POST/DELETE: route template, status,
 * error code, scope id, the committed event id and seq when the response
 * names them, a digest of the Idempotency-Key and latency. Never request or
 * response bodies, the key itself, bearer tokens or workshop content. */

const EVENT_ID = /^E-[0-9A-Za-z]{1,64}$/;
const SCOPE_ID = /^[A-Z]{1,3}-[0-9A-Za-z-]{1,64}$/;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Larger JSON responses are not parsed for ids; the record says so. */
const MAX_PARSED_RESPONSE_BYTES = 65_536;

export interface FellowWriteLogInput {
  readonly route: string;
  readonly method: string;
  readonly status: number;
  readonly scopeId: string | undefined;
  readonly idempotencyKey: string | null;
  readonly response: Response;
  readonly startedAt: number;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function responseFields(response: Response): Promise<{
  readonly code: string | null;
  readonly eventId: string | null;
  readonly seq: number | null;
  readonly parsed: boolean;
}> {
  const none = { code: null, eventId: null, seq: null, parsed: false };
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) return none;
  const text = await response.clone().text();
  if (text.length > MAX_PARSED_RESPONSE_BYTES) return none;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return none;
  }
  if (body === null || typeof body !== "object") return { ...none, parsed: true };
  const record = body as Record<string, unknown>;
  const pick = <T>(value: unknown, ok: (v: unknown) => v is T): T | null =>
    ok(value) ? value : null;
  return {
    code: pick(record.code, (v): v is string => typeof v === "string" && CODE.test(v)),
    eventId: pick(record.event_id, (v): v is string => typeof v === "string" && EVENT_ID.test(v)),
    seq: pick(record.seq, (v): v is number => typeof v === "number" && Number.isSafeInteger(v)),
    parsed: true,
  };
}

/** Build the one diagnostic record. Exported for tests. */
export async function fellowWriteRecord(
  input: FellowWriteLogInput,
  now: number = Date.now(),
): Promise<Record<string, unknown>> {
  const fields = await responseFields(input.response);
  return {
    facility: "OPS.2a",
    stage: "fellow-write",
    route: input.route,
    method: input.method,
    status: input.status,
    outcome:
      input.status < 300 ? "committed-or-replayed" : input.status < 500 ? "refused" : "failed",
    code: fields.code,
    scope_id: input.scopeId !== undefined && SCOPE_ID.test(input.scopeId) ? input.scopeId : null,
    event_id: fields.eventId,
    seq: fields.seq,
    response_parsed: fields.parsed,
    idempotency_key_digest:
      input.idempotencyKey === null ? null : await sha256Hex(`idempotency:${input.idempotencyKey}`),
    latency_ms: Math.max(0, now - input.startedAt),
  };
}

export async function logFellowWrite(input: FellowWriteLogInput): Promise<void> {
  try {
    console.info(JSON.stringify(await fellowWriteRecord(input)));
  } catch {
    // Diagnostics never change a response.
  }
}
