import { DISCRIMINATION_MAX_TARGETS, DISCRIMINATION_SCHEMA_ID } from "@asimposium/contracts/discrimination-model";

export interface DiscriminationReceiptContext {
  readonly problemId: string;
  readonly hypotheses: readonly string[];
}
const HYPOTHESIS = /^H-[0-9A-HJKMNP-TV-Z]{1,78}(?![\s\S])/;
const EVIDENCE = /^E-[0-9A-HJKMNP-TV-Z]{1,78}(?![\s\S])/;
const RECEIPT_MAX_BYTES = 16 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Links describe a complete receipt returned by the ordinary writer, not
 * independent verification of the experiment or fresh permission to read it.
 * Match every expected target before exposing any link; never guess an ID. */
export function discriminationReceiptLinks(
  value: unknown,
  context: DiscriminationReceiptContext,
): string[] {
  if (
    !record(value) || value.ok !== true || value.problem_id !== context.problemId ||
    typeof context.problemId !== "string" || !context.problemId ||
    /[\s/\\?#\u0000-\u001f\u007f]/u.test(context.problemId) ||
    context.hypotheses.length < 2 || context.hypotheses.length > DISCRIMINATION_MAX_TARGETS ||
    context.hypotheses.some((id) => !HYPOTHESIS.test(id)) ||
    new Set(context.hypotheses).size !== context.hypotheses.length ||
    !Array.isArray(value.results) || value.results.length !== context.hypotheses.length
  ) return [];
  const expected = new Set(context.hypotheses.map((id) => `tmp:discriminate-${id}`));
  const byTarget = new Map<string, string>();
  const ids = new Set<string>();
  const sequences = new Set<number>();
  for (const row of value.results) {
    if (
      !record(row) || row.action !== "evidence" ||
      typeof row.tempId !== "string" || !expected.has(row.tempId) || byTarget.has(row.tempId) ||
      typeof row.id !== "string" || !EVIDENCE.test(row.id) || ids.has(row.id) ||
      typeof row.seq !== "number" || !Number.isSafeInteger(row.seq) || row.seq < 1 || sequences.has(row.seq) ||
      (row.version !== undefined && row.version !== 1)
    ) return [];
    byTarget.set(row.tempId, row.id);
    ids.add(row.id);
    sequences.add(row.seq);
  }
  return context.hypotheses.map((id) =>
    `</p/${encodeURIComponent(context.problemId)}/evidence/${byTarget.get(`tmp:discriminate-${id}`)}.json>; rel="item"; type="application/json"; title="Evidence for ${id}"`,
  );
}

/** Optional response navigation never changes the writer's receipt, status or
 * failure semantics. Clone and bound the small receipt; leave the original
 * untouched on malformed, oversized or interrupted reads. No network I/O. */
export async function withDiscriminationReadLinks(
  response: Response,
  context: DiscriminationReceiptContext,
): Promise<Response> {
  if (
    (response.status !== 200 && response.status !== 201) ||
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
  ) return response;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return response;
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RECEIPT_MAX_BYTES) {
        // Do not await cancellation of a tee branch: its peer is the original
        // response, whose body still belongs to the caller.
        void reader.cancel().catch(() => undefined);
        return response;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const links = discriminationReceiptLinks(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), context,
    );
    if (links.length === 0) return response;
    const headers = new Headers(response.headers);
    headers.append("link", `<${DISCRIMINATION_SCHEMA_ID}>; rel="describedby"; type="application/schema+json"`);
    for (const link of links) headers.append("link", link);
    return new Response(response.body, {
      status: response.status, statusText: response.statusText, headers,
    });
  } catch {
    return response;
  } finally {
    reader?.releaseLock();
  }
}
