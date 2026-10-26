import {
  SPONSOR_DATA_EXPORT_MAX_RESPONSE_BYTES,
  SPONSOR_DATA_EXPORT_SECTIONS,
  SponsorDataExportResponseSchema,
  type SponsorDataExportRequest,
  type SponsorDataExportResponse,
} from "@asimposium/contracts/account-export";

export const MAX_BROWSER_ACCOUNT_EXPORT_BYTES = 64 * 1024 * 1024;
export const MAX_BROWSER_ACCOUNT_EXPORT_PAGES = 2_000;

export interface AccountExportProgress {
  readonly pages: number;
  readonly records: number;
  readonly bytes: number;
  readonly section: SponsorDataExportResponse["section"];
}

export class AccountExportDownloadError extends Error {
  constructor(readonly code: "changed" | "unavailable" | "unauthenticated" | "too-large" | "invalid") {
    super(code);
    this.name = "AccountExportDownloadError";
  }
}

/** Bound the body before JSON parsing; Content-Length alone is not a byte limit. */
async function readExportPage(response: Response, signal: AbortSignal): Promise<SponsorDataExportResponse> {
  signal.throwIfAborted();
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new AccountExportDownloadError(response.status === 409 ? "changed"
      : response.status === 401 ? "unauthenticated" : "unavailable");
  }
  if (response.body === null) throw new AccountExportDownloadError("invalid");
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > SPONSOR_DATA_EXPORT_MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new AccountExportDownloadError("invalid");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed = SponsorDataExportResponseSchema.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (!parsed.success) throw new AccountExportDownloadError("invalid");
    return parsed.data;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AccountExportDownloadError) throw error;
    throw new AccountExportDownloadError("invalid");
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/**
 * Keep canonical pages in this tab until every section has finished. A changed
 * account, lost entitlement, or incomplete stream never becomes a download.
 */
export async function collectAccountExportDownload(options: {
  readonly principalId: string;
  readonly signal: AbortSignal;
  readonly fetchPage: (request: SponsorDataExportRequest, signal: AbortSignal) => Promise<Response>;
  readonly onProgress?: (progress: AccountExportProgress) => void;
}): Promise<AccountExportProgress & { readonly blob: Blob; readonly filename: string }> {
  const lines: string[] = [];
  const encoder = new TextEncoder();
  let command: SponsorDataExportRequest = {};
  let first: SponsorDataExportResponse | undefined;
  let progress: AccountExportProgress = { pages: 0, records: 0, bytes: 0, section: "account" };
  while (progress.pages < MAX_BROWSER_ACCOUNT_EXPORT_PAGES) {
    options.signal.throwIfAborted();
    let response: Response;
    try { response = await options.fetchPage(command, options.signal); }
    catch {
      options.signal.throwIfAborted();
      throw new AccountExportDownloadError("unavailable");
    }
    const page = await readExportPage(response, options.signal);
    const cursor = command.cursor;
    const expectedSection = cursor?.section ?? "account";
    const expectedSnapshot = first?.snapshot;
    if (page.sponsor_id !== options.principalId || page.section !== expectedSection || (
      expectedSnapshot !== undefined && (
        page.snapshot.revision !== expectedSnapshot.revision ||
        page.snapshot.exported_at !== expectedSnapshot.exported_at
      )
    )) throw new AccountExportDownloadError("changed");
    if (first === undefined) {
      if (page.records.length !== 1 || page.records[0]?.kind !== "account" ||
          page.records[0].data.sponsor_id !== options.principalId) {
        throw new AccountExportDownloadError("invalid");
      }
      first = page;
    }
    const sectionIndex = SPONSOR_DATA_EXPORT_SECTIONS.indexOf(page.section);
    const next = page.next_cursor;
    if (next === null) {
      if (sectionIndex !== SPONSOR_DATA_EXPORT_SECTIONS.length - 1) {
        throw new AccountExportDownloadError("invalid");
      }
    } else {
      const nextIndex = SPONSOR_DATA_EXPORT_SECTIONS.indexOf(next.section);
      if (nextIndex === sectionIndex) {
        if (page.records.length === 0 || next.after <= (cursor?.after ?? 0)) {
          throw new AccountExportDownloadError("invalid");
        }
      } else if (nextIndex !== sectionIndex + 1 || next.after !== 0) {
        throw new AccountExportDownloadError("invalid");
      }
    }
    const line = `${JSON.stringify(page)}\n`;
    const bytes = progress.bytes + encoder.encode(line).byteLength;
    if (bytes > MAX_BROWSER_ACCOUNT_EXPORT_BYTES) throw new AccountExportDownloadError("too-large");
    lines.push(line);
    progress = { pages: progress.pages + 1, records: progress.records + page.records.length, bytes, section: page.section };
    options.onProgress?.(progress);
    if (next === null) {
      options.signal.throwIfAborted();
      return {
        ...progress,
        blob: new Blob(lines, { type: "application/x-ndjson;charset=utf-8" }),
        filename: `asimposium-account-export-${page.snapshot.exported_at.slice(0, 10)}.jsonl`,
      };
    }
    command = { cursor: next };
  }
  throw new AccountExportDownloadError("too-large");
}
