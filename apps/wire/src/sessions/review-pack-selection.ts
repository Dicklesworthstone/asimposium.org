import type { PackResponse } from "@asimposium/contracts";

/** The canonical queue and targeted pack handlers remain the only readers.
 * In particular, this adapter never reads workshop tables or picks a target
 * from authored prose, an invitation body, a URL embedded in a claim, or an
 * untrusted item pretending to be a server action. */
export interface ReviewPackSelectionDependencies {
  read(request: Request): Promise<Response>;
  parsePack(value: unknown): PackResponse;
  parseTarget(value: unknown): { target: string };
}

export class ReviewPackSelectionError extends Error {
  readonly kind: "target-required" | "unavailable";

  constructor(kind: "target-required" | "unavailable") {
    super("An isolated review pack could not be selected.");
    this.name = "ReviewPackSelectionError";
    this.kind = kind;
  }
}

const MAX_QUEUE_BYTES = 65_536;

async function queueJson(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    await response.body?.cancel();
    throw new ReviewPackSelectionError("unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ReviewPackSelectionError("unavailable");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  let finished = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_QUEUE_BYTES) throw new ReviewPackSelectionError("unavailable");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Complete the no-target review entry point using a bounded, authenticated
 * queue read followed by the EXISTING exact-version review handler. The queue
 * bytes are consumed internally and never returned as review context.
 *
 * The selected version does not float to a later head. The final handler
 * rechecks access and applies the caller's original budget and conditional
 * headers. It captures its own current cursor: this is navigation between
 * two reads, not a claim that those reads shared a database transaction.
 */
export async function selectIsolatedReviewPack(
  request: Request,
  sessionId: string,
  dependencies: ReviewPackSelectionDependencies,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.searchParams.get("profile") !== "review" ||
    url.searchParams.has("target")
  ) return undefined;

  const queueUrl = new URL(url);
  queueUrl.searchParams.set("profile", "review-queue");
  // Keep max_tokens (including an invalid value) for the existing validator.
  // A selected target is in next_actions, which is mandatory envelope data,
  // so discovery does not need to inflate a small caller budget to 8K.
  const headers = new Headers(request.headers);
  for (const name of ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "range", "if-range"])
    headers.delete(name);

  try {
    const queueResponse = await dependencies.read(new Request(queueUrl, {
      method: "GET", headers, signal: request.signal, redirect: "manual",
    }));
    if (queueResponse.status >= 400) return queueResponse;
    if (queueResponse.status !== 200) {
      await queueResponse.body?.cancel();
      throw new ReviewPackSelectionError("unavailable");
    }
    const queue = dependencies.parsePack(await queueJson(queueResponse));
    if (
      queue.session !== sessionId || queue.profile !== "review-queue" ||
      queue.viewer?.audience !== "session"
    ) throw new ReviewPackSelectionError("unavailable");

    let target: string | undefined;
    for (const action of queue.next_actions) {
      if (action.method !== "GET") continue;
      const candidate = new URL(action.url, url);
      if (
        candidate.origin !== url.origin || candidate.pathname !== url.pathname ||
        candidate.username !== "" || candidate.password !== "" || candidate.hash !== "" ||
        candidate.searchParams.get("profile") !== "review"
      ) continue;
      if (candidate.searchParams.getAll("profile").length !== 1 ||
          candidate.searchParams.getAll("target").length !== 1)
        throw new ReviewPackSelectionError("unavailable");
      const parsed = dependencies.parseTarget({
        profile: "review", target: candidate.searchParams.get("target"),
      });
      if (target !== undefined && target !== parsed.target)
        throw new ReviewPackSelectionError("unavailable");
      target = parsed.target;
    }
    if (target === undefined) throw new ReviewPackSelectionError("target-required");

    // Copy only the schema-checked version pin, never a server-supplied URL or
    // its budget/other query parameters. Bearers stay on the original origin.
    const selected = new URL(url);
    selected.searchParams.set("target", target);
    const response = await dependencies.read(new Request(selected, request));
    const finalHeaders = new Headers(response.headers);
    finalHeaders.set("cache-control", "private, no-store");
    finalHeaders.set("content-location", `${selected.pathname}${selected.search}`);
    return new Response(response.body, {
      status: response.status, statusText: response.statusText, headers: finalHeaders,
    });
  } catch (error) {
    if (error instanceof ReviewPackSelectionError) throw error;
    // Do not leak queue contents, credentials, SQL, or parser/provider errors.
    throw new ReviewPackSelectionError("unavailable");
  }
}
