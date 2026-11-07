import {
  canonicalReadinessReceipt,
  MAX_READINESS_RECEIPT_BYTES,
  READINESS_SCHEMA_ID,
  ReadinessDigestSchema,
  ReadinessReceiptSchema,
  ReadinessRevisionSchema,
  type ReadinessStatus,
  readinessEnvironmentForOrigin,
  readinessReceiptProblem,
  unavailableReadiness,
} from "@asimposium/contracts";
import type { Env } from "./env";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** An immutable private key, never a request-supplied URL or public artifact path. */
export function readinessReceiptKey(digest: string): string {
  return `readiness/sha256/${ReadinessDigestSchema.parse(digest)}.json`;
}

/**
 * Consume completed evidence only. There is no fallback receipt, fixture,
 * write, or inference from healthy bindings in this producer.
 */
export async function loadReadiness(
  env: Env,
  now: () => number = Date.now,
): Promise<ReadinessStatus> {
  const origin = env.STOA_ORIGIN;
  if (origin === undefined || readinessEnvironmentForOrigin(origin) === undefined) {
    return unavailableReadiness("origin_unavailable");
  }
  const revision = ReadinessRevisionSchema.safeParse(env.ASIMPOSIUM_SOURCE_REVISION);
  if (!revision.success) return unavailableReadiness("revision_unavailable");
  const configuredDigest = env.ASIMPOSIUM_READINESS_RECEIPT_SHA256;
  if (configuredDigest === undefined) return unavailableReadiness("receipt_unconfigured");
  const digest = ReadinessDigestSchema.safeParse(configuredDigest);
  if (!digest.success) return unavailableReadiness("receipt_configuration_invalid");

  try {
    const object = await env.ARTIFACTS.get(readinessReceiptKey(digest.data));
    if (object === null) return unavailableReadiness("receipt_unavailable");
    if (object.size > MAX_READINESS_RECEIPT_BYTES) {
      await object.body.cancel();
      return unavailableReadiness("receipt_oversize");
    }
    const reader = object.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_READINESS_RECEIPT_BYTES) {
          await reader.cancel();
          return unavailableReadiness("receipt_oversize");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const receivedDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const receivedHex = Array.from(receivedDigest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (receivedHex !== digest.data) {
      return unavailableReadiness("receipt_digest_mismatch");
    }
    let body: string;
    let parsed: ReturnType<typeof ReadinessReceiptSchema.safeParse>;
    try {
      body = decoder.decode(bytes);
      parsed = ReadinessReceiptSchema.safeParse(JSON.parse(body));
    } catch {
      return unavailableReadiness("invalid_evidence");
    }
    if (!parsed.success) return unavailableReadiness("invalid_evidence");
    // Canonical bytes also reject duplicate JSON keys and hidden unused data.
    if (body !== canonicalReadinessReceipt(parsed.data)) {
      return unavailableReadiness("invalid_evidence");
    }
    const problem = readinessReceiptProblem(parsed.data, {
      origin,
      revision: revision.data,
      now: now(),
    });
    if (problem !== undefined) return unavailableReadiness(problem);
    return {
      schema: READINESS_SCHEMA_ID,
      status: "ready",
      receipt_sha256: digest.data,
      receipt: parsed.data,
    };
  } catch {
    // Storage/provider diagnostics may contain private configuration. Never echo them.
    return unavailableReadiness("receipt_unavailable");
  }
}
