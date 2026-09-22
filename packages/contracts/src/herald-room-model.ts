/** W7.1: rooms announce committed cursors; the event tail remains authoritative. */
export const HERALD_ROOM_SCHEMA_ID = "https://a.asimposium.org/schemas/herald-room.v1.json";
export const HERALD_ROOM_PROTOCOL = "asimposium.room.v1";
export const HERALD_ROOM_LIMITS = Object.freeze({
  connections: 32,
  perFellow: 2,
  perSponsor: 8,
  frameBytes: 2048,
  inputBytes: 128,
  acknowledgementMs: 60_000,
  acknowledgementIntervalMs: 250,
  heartbeatSeconds: 20,
  silenceMs: 90_000,
  revalidateMs: 60_000,
  lifetimeMs: 15 * 60_000,
  retrySeconds: 5,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROBLEM = /^(?!.*--)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURSOR = /^(?:0|[1-9][0-9]{0,15})$/;
export function roomId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
export function roomProblem(value: unknown): value is string {
  return typeof value === "string" && PROBLEM.test(value);
}
export function roomCursor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function parseRoomSince(params: URLSearchParams): number | undefined {
  if ([...params.keys()].some((key) => key !== "since" || params.getAll(key).length !== 1))
    return undefined;
  const raw = params.get("since") ?? "0";
  const value = Number(raw);
  return CURSOR.test(raw) && roomCursor(value) ? value : undefined;
}

/** A single exact decimal ACK, not arbitrary JSON or a client-authored cursor hint. */
export function parseRoomAck(message: string | ArrayBuffer): number | undefined {
  if (typeof message !== "string" || new TextEncoder().encode(message).byteLength > HERALD_ROOM_LIMITS.inputBytes)
    return undefined;
  const match = /^\s*\{\s*"ack"\s*:\s*(0|[1-9][0-9]{0,15})\s*\}\s*$/.exec(message);
  if (!match) return undefined;
  const value = Number(match[1]);
  return roomCursor(value) ? value : undefined;
}

export function roomName(problemId: string): string {
  if (!roomProblem(problemId)) throw new Error("HERALD_ROOM_ID_INVALID");
  return `public-problem-v1:${problemId}`;
}
export function roomTailPath(problemId: string, since: number, through?: number): string {
  if (!roomProblem(problemId) || !roomCursor(since) ||
    (through !== undefined && (!roomCursor(through) || through < since)))
    throw new Error("HERALD_ROOM_CURSOR_INVALID");
  const query = new URLSearchParams({ since: String(since), limit: "200" });
  if (through !== undefined) query.set("through", String(through));
  else query.set("wait", "25");
  return `/p/${encodeURIComponent(problemId)}/events.ndjson?${query}`;
}

export function roomNotice(problemId: string, since: number, through: number) {
  const notice = {
    control: "resync" as const,
    schema: HERALD_ROOM_SCHEMA_ID,
    problem_id: problemId,
    since,
    through,
    events: roomTailPath(problemId, since, through),
    poll: roomTailPath(problemId, since),
    heartbeat: { request: "ping", response: "pong", seconds: HERALD_ROOM_LIMITS.heartbeatSeconds },
    acknowledgement: { ack: through },
    invalidate_cached_objects: true,
    instruction: "Read complete event-tail pages before acknowledging through. A room notice never advances a saved cursor. Invalidate cached object faces and revalidate them over HTTP. Deduplicate event IDs; fall back to polling on disconnect.",
  };
  const text = JSON.stringify(notice);
  if (new TextEncoder().encode(text).byteLength > HERALD_ROOM_LIMITS.frameBytes)
    throw new Error("HERALD_ROOM_FRAME_TOO_LARGE");
  return text;
}
