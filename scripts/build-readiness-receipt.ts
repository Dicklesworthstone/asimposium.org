#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalReadinessReceipt,
  MAX_READINESS_RECEIPT_BYTES,
  READINESS_SCHEMA_ID,
  REQUIRED_READINESS_PROOFS,
  ReadinessReceiptSchema,
  ReadinessRevisionSchema,
  readinessEnvironmentForOrigin,
  readinessReceiptProblem,
} from "../packages/contracts/src/readiness.ts";

const MAX_OBSERVATION_BYTES = 256 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function readObservation(directory: string, proofId: string) {
  const path = join(directory, `${proofId}.json`);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_OBSERVATION_BYTES) {
      throw new Error("invalid observation file");
    }
    const buffer = Buffer.alloc(metadata.size + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead !== metadata.size) throw new Error("observation changed while reading");
    const bytes = buffer.subarray(0, bytesRead);
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid observation document");
    }
    const { record, mode, observation, ...proof } = value as Record<string, unknown>;
    if (
      record !== "readiness_observation" ||
      mode !== "mock_free" ||
      observation === null ||
      typeof observation !== "object" ||
      Array.isArray(observation) ||
      Object.keys(observation).length === 0 ||
      Object.hasOwn(proof, "evidence_sha256")
    ) {
      throw new Error("invalid observation document");
    }
    return { ...proof, evidence_sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    closeSync(descriptor);
  }
}

function timestamp(proof: Record<string, unknown>, key: "observed_at" | "expires_at"): number {
  const value = proof[key];
  if (typeof value !== "string") throw new Error("invalid observation timestamp");
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("invalid observation timestamp");
  return time;
}

export function buildReadinessReceipt(
  directory: string,
  scope: { readonly origin: string; readonly revision: string; readonly runId: string },
  now = Date.now(),
): string {
  const environment = readinessEnvironmentForOrigin(scope.origin);
  if (!environment || !ReadinessRevisionSchema.safeParse(scope.revision).success) {
    throw new Error("invalid readiness scope");
  }
  const proofs = REQUIRED_READINESS_PROOFS.map(({ proof_id }) =>
    readObservation(directory, proof_id),
  );
  const parsed = ReadinessReceiptSchema.safeParse({
    schema: READINESS_SCHEMA_ID,
    record: "readiness_receipt",
    mode: "mock_free",
    origin: scope.origin,
    revision: scope.revision,
    environment,
    run_id: scope.runId,
    observed_at: new Date(
      Math.max(...proofs.map((proof) => timestamp(proof, "observed_at"))),
    ).toISOString(),
    expires_at: new Date(
      Math.min(...proofs.map((proof) => timestamp(proof, "expires_at"))),
    ).toISOString(),
    proofs,
  });
  if (!parsed.success || readinessReceiptProblem(parsed.data, { ...scope, now })) {
    throw new Error("readiness observations failed the receipt contract");
  }
  const receipt = canonicalReadinessReceipt(parsed.data);
  if (Buffer.byteLength(receipt) > MAX_READINESS_RECEIPT_BYTES)
    throw new Error("receipt too large");
  return receipt;
}

if (import.meta.main) {
  const [directory, origin, revision, runId, ...extra] = process.argv.slice(2);
  if (!directory || !origin || !revision || !runId || extra.length !== 0) {
    console.error(
      "Usage: bun scripts/build-readiness-receipt.ts <evidence-dir> <stoa-origin> <revision> <run-id>",
    );
    process.exitCode = 64;
  } else {
    try {
      process.stdout.write(buildReadinessReceipt(directory, { origin, revision, runId }));
    } catch {
      console.error(
        "Readiness receipt refused. Check that all eight retained observations match the run, deployment, and time bounds.",
      );
      process.exitCode = 1;
    }
  }
}
