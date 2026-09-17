import { deflateMemberEnd } from "./artifact-deflate.ts";
import {
  archiveMemberPathIsSafe,
  bodyLooksSecretShaped,
  MAX_ARCHIVE_EXPANSION_RATIO,
  MAX_ARTIFACT_BYTES,
  MAX_LAKE_ARCHIVE_BYTES,
} from "./cas.ts";

/** Byte verification is not proof checking. No uploaded program is executed. */
export type ArtifactEncoding = "text" | "lake-archive";
export type ArtifactInspectionCode =
  | "ARTIFACT_TOO_LARGE"
  | "ARTIFACT_TYPE_FORBIDDEN"
  | "ARTIFACT_SECRET_SHAPED"
  | "ARTIFACT_ARCHIVE_INVALID"
  | "ARTIFACT_DIGEST_MISMATCH";

export class ArtifactInspectionError extends Error {
  constructor(readonly code: ArtifactInspectionCode) {
    // Never put uploaded bytes, member names, or a discovered secret in errors.
    super(code);
    this.name = "ArtifactInspectionError";
  }
}

export interface InspectedArtifact {
  readonly sha256: string;
  readonly size: number;
  readonly contentType: "text/plain; charset=utf-8" | "application/gzip";
  readonly disposition: "attachment";
  readonly members: number;
  readonly expandedBytes: number;
}

export const MAX_ARTIFACT_EXPANDED_BYTES = 64 * 1024 * 1024;
export const MAX_ARTIFACT_ARCHIVE_MEMBERS = 4096;
const BLOCK = 512;
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEX = /^[a-f0-9]{64}$/;

export async function artifactSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function text(bytes: Uint8Array): void {
  let body: string;
  try { body = decoder.decode(bytes); } catch {
    throw new ArtifactInspectionError("ARTIFACT_TYPE_FORBIDDEN");
  }
  // Source and logs are inert UTF-8, not an alternative binary transport.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body) ||
    /^\s*(?:<!doctype\s+html\b|<html\b|<svg\b|<\?xml\b)/i.test(body)) {
    throw new ArtifactInspectionError("ARTIFACT_TYPE_FORBIDDEN");
  }
  if (bodyLooksSecretShaped(body)) throw new ArtifactInspectionError("ARTIFACT_SECRET_SHAPED");
}

const badArchive = (): never => { throw new ArtifactInspectionError("ARTIFACT_ARCHIVE_INVALID"); };
const zero = (bytes: Uint8Array): boolean => bytes.every(byte => byte === 0);

function field(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  if (end >= 0 && !zero(bytes.subarray(end))) return badArchive();
  try { return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end)); } catch { return badArchive(); }
}

function octal(bytes: Uint8Array): number {
  // Refuse GNU base-256, signs, fractional values and hidden trailing bytes.
  const value = String.fromCharCode(...bytes);
  if (!/^[ 0-7]*[\x00 ]*$/.test(value)) return badArchive();
  const digits = value.replace(/[\x00 ]+$/, "").trim();
  const parsed = digits === "" ? 0 : Number.parseInt(digits, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return badArchive();
  return parsed;
}

function path(name: string, directory: boolean): string {
  const normalized = directory && name.endsWith("/") ? name.slice(0, -1) : name;
  // Avoid alternate Windows separators, drive/ADS paths, terminal control
  // bytes and equivalent spellings that could overwrite another member.
  if (normalized.length > 255 || /[\\:\u0000-\u001f\u007f]/.test(normalized) ||
    !archiveMemberPathIsSafe(normalized) || normalized.split("/").some(part =>
      part === "" || part === "." || part.endsWith(".") || part.endsWith(" ") ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return badArchive();
  return normalized.normalize("NFC").toLowerCase();
}

/** Bounded streaming reader: keep one decompressor chunk plus one source
 * member, not a second 64 MiB copy of the entire expanded archive. */
class ExpandedReader {
  private chunk = new Uint8Array(0);
  private position = 0;
  received = 0;
  consumed = 0;
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly cap: number) {}

  async take(size: number): Promise<Uint8Array | undefined> {
    const result = new Uint8Array(size);
    let written = 0;
    while (written < size) {
      if (this.position === this.chunk.length) {
        const next = await this.reader.read();
        if (next.done) {
          if (written !== 0) return badArchive();
          return undefined;
        }
        this.received += next.value.byteLength;
        if (this.received > this.cap) return badArchive();
        this.chunk = next.value;
        this.position = 0;
      }
      const amount = Math.min(size - written, this.chunk.length - this.position);
      result.set(this.chunk.subarray(this.position, this.position + amount), written);
      this.position += amount;
      written += amount;
      this.consumed += amount;
    }
    return result;
  }
}

/** Conservative portable USTAR source trees only. PAX/GNU extensions, links,
 * sparse files, devices, embedded binaries and executable extraction tricks
 * are refused, not handed to a system tar command. */
async function inspectTar(input: ExpandedReader): Promise<number> {
  let members = 0;
  const names = new Map<string, boolean>();
  const requiredDirectories = new Set<string>();
  for (;;) {
    const header = await input.take(BLOCK);
    if (header === undefined) return badArchive();
    if (zero(header)) {
      const second = await input.take(BLOCK);
      if (second === undefined || !zero(second)) return badArchive();
      for (;;) {
        const padding = await input.take(BLOCK);
        if (padding === undefined) return members;
        if (!zero(padding)) return badArchive();
      }
    }
    if (++members > MAX_ARTIFACT_ARCHIVE_MEMBERS) return badArchive();
    const checksum = octal(header.subarray(148, 156));
    const actual = header.reduce((sum, byte, index) =>
      sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== actual || field(header.subarray(257, 263)) !== "ustar" ||
      String.fromCharCode(...header.subarray(263, 265)) !== "00") return badArchive();
    const kind = header[156];
    const directory = kind === 53;
    if (kind !== 0 && kind !== 48 && !directory) return badArchive();
    if (field(header.subarray(157, 257)) !== "") return badArchive();
    const prefix = field(header.subarray(345, 500));
    const name = field(header.subarray(0, 100));
    // Metadata is uploaded material too. It must not carry a token or address.
    for (const value of [prefix, name, field(header.subarray(265, 297)),
      field(header.subarray(297, 329))]) text(new TextEncoder().encode(value));
    if (!zero(header.subarray(500))) return badArchive();
    const key = path(prefix === "" ? name : `${prefix}/${name}`, directory);
    if (names.has(key) || (!directory && requiredDirectories.has(key))) return badArchive();
    const pieces = key.split("/");
    for (let i = 1; i < pieces.length; i++) {
      const ancestor = pieces.slice(0, i).join("/");
      if (names.get(ancestor) === false) return badArchive();
      requiredDirectories.add(ancestor);
    }
    names.set(key, directory);
    const size = octal(header.subarray(124, 136));
    if ((directory && size !== 0) || size > MAX_ARTIFACT_BYTES) return badArchive();
    const body = await input.take(size);
    if (body === undefined) return badArchive();
    if (!directory) text(body);
    const padding = await input.take((BLOCK - size % BLOCK) % BLOCK);
    if (padding === undefined || !zero(padding)) return badArchive();
  }
}

function gzipMetadata(bytes: Uint8Array): number {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) return badArchive();
  const flags = bytes[3] ?? 0;
  // Unknown binary FEXTRA fields are not a source tree. Name/comment fields
  // are bounded and screened; the decompressor validates the header CRC.
  if ((flags & 0xe4) !== 0) return badArchive();
  let offset = 10;
  for (const bit of [8, 16]) {
    if ((flags & bit) === 0) continue;
    const end = bytes.indexOf(0, offset);
    if (end < 0 || end - offset > 1024) return badArchive();
    text(bytes.subarray(offset, end));
    offset = end + 1;
  }
  offset += (flags & 2) !== 0 ? 2 : 0;
  if (offset + 8 > bytes.length) return badArchive();
  return offset;
}

async function inspectGzip(bytes: Uint8Array): Promise<{ members: number; expandedBytes: number }> {
  const start = gzipMetadata(bytes);
  const cap = Math.min(MAX_ARTIFACT_EXPANDED_BYTES, bytes.length * MAX_ARCHIVE_EXPANSION_RATIO);
  // The first DEFLATE stream must end immediately before the sole gzip
  // trailer. Later members (including empty ones carrying metadata) are not
  // accepted even when the host DecompressionStream silently concatenates.
  let expanded: number;
  try {
    const frame = deflateMemberEnd(bytes, start, bytes.length - 8, cap);
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - 4, true);
    if (frame.end !== bytes.length - 8 || frame.expanded !== size) return badArchive();
    expanded = frame.expanded;
  } catch { return badArchive(); }
  const source = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes); controller.close();
  } });
  const reader = source.pipeThrough(new DecompressionStream("gzip")).getReader();
  const input = new ExpandedReader(reader, cap);
  try {
    const members = await inspectTar(input);
    if (input.consumed !== expanded) return badArchive();
    return { members, expandedBytes: input.consumed };
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof ArtifactInspectionError) throw error;
    return badArchive();
  } finally { reader.releaseLock(); }
}

/** Size, digest, MIME and archive decisions come from the exact observed bytes.
 * Client filenames and declared Content-Type never establish admission. */
export async function inspectArtifact(
  bytes: Uint8Array,
  encoding: ArtifactEncoding,
  expectedSha256: string,
): Promise<InspectedArtifact> {
  const cap = encoding === "lake-archive" ? MAX_LAKE_ARCHIVE_BYTES : MAX_ARTIFACT_BYTES;
  if (bytes.byteLength === 0 || bytes.byteLength > cap) throw new ArtifactInspectionError("ARTIFACT_TOO_LARGE");
  // A caller retaining the input view cannot race hashing against inspection.
  bytes = bytes.slice();
  const sha256 = await artifactSha256(bytes);
  if (!HEX.test(expectedSha256) || sha256 !== expectedSha256)
    throw new ArtifactInspectionError("ARTIFACT_DIGEST_MISMATCH");
  if (encoding === "text") {
    text(bytes);
    return { sha256, size: bytes.length, contentType: "text/plain; charset=utf-8",
      disposition: "attachment", members: 1, expandedBytes: bytes.length };
  }
  if (encoding !== "lake-archive") return badArchive();
  const { members, expandedBytes } = await inspectGzip(bytes);
  if (members === 0) return badArchive();
  return { sha256, size: bytes.length, contentType: "application/gzip",
    disposition: "attachment", members, expandedBytes };
}
