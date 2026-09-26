/** OPS.2a structured diagnostics for hello, triage and next (bead
 * asimposiumorg-bbx). IDs, digests, move identities, cursor, degraded state,
 * status and latency only. Response bodies, pack bodies, tokens, cookies,
 * directives and workshop content never enter the line: the response is
 * represented by its digest. */

export type MegaCommandEndpoint = "hello" | "triage" | "next";

export interface MegaCommandMove {
  readonly move: string;
  readonly refs: readonly string[];
  readonly contract?: Record<string, unknown>;
}

export interface MegaCommandLogInput {
  readonly endpoint: MegaCommandEndpoint;
  readonly startedAt: number;
  readonly status: number;
  readonly code?: string;
  readonly fellowId?: string;
  readonly problemId?: string;
  readonly permissions?: unknown;
  readonly projection?: unknown;
  readonly moves?: readonly (MegaCommandMove | null | undefined)[];
  readonly degraded?: boolean;
  readonly degradedReason?: string;
}

async function digest(value: unknown): Promise<string | null> {
  if (value === undefined) return null;
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function capturedCursor(move: MegaCommandMove | null | undefined): number | null {
  const preparation = move?.contract?.preparation;
  if (preparation === null || typeof preparation !== "object") return null;
  const cursor = (preparation as Record<string, unknown>).captured_cursor;
  return typeof cursor === "number" && Number.isSafeInteger(cursor) ? cursor : null;
}

/** Build the one diagnostic record. Exported for tests. */
export async function megaCommandLogRecord(
  input: MegaCommandLogInput,
  now: number = Date.now(),
): Promise<Record<string, unknown>> {
  const moves = (input.moves ?? []).filter(
    (move): move is MegaCommandMove => move !== null && move !== undefined,
  );
  return {
    facility: "OPS.2a",
    stage: "mega-command",
    endpoint: input.endpoint,
    status: input.status,
    code: input.code ?? null,
    fellow_id: input.fellowId ?? null,
    problem_id: input.problemId ?? null,
    permission_set_digest: await digest(input.permissions),
    projection_digest: await digest(input.projection),
    selected_move_ids: moves.map((move) => `${move.move}:${move.refs.join(",")}`),
    cursor: capturedCursor(moves[0]),
    degraded: input.degraded ?? false,
    degraded_reason: input.degradedReason ?? null,
    latency_ms: Math.max(0, now - input.startedAt),
  };
}

export async function logMegaCommand(input: MegaCommandLogInput): Promise<void> {
  try {
    console.info(JSON.stringify(await megaCommandLogRecord(input)));
  } catch {
    // Diagnostics never change a response.
  }
}
