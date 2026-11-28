import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalReadinessReceipt,
  REQUIRED_READINESS_PROOFS,
  ReadinessReceiptSchema,
} from "../../packages/contracts/src/readiness.ts";
import { buildReadinessReceipt } from "../build-readiness-receipt.ts";

const script = fileURLToPath(new URL("../build-readiness-receipt.ts", import.meta.url));
const scope = {
  origin: "https://a-staging.asimposium.org",
  revision: "a".repeat(40),
  runId: "receipt-reducer-test",
};
const privateBody = "private-evidence-must-stay-in-the-input-file";
const now = Date.parse("2026-11-27T12:00:15.000Z");

function makeObservations(options: { readonly skip?: number; readonly at?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "asimposium-readiness-reducer-"));
  const at = options.at ?? now;
  const files = REQUIRED_READINESS_PROOFS.map((proof, index) => {
    const file = join(directory, `${proof.proof_id}.json`);
    const document = {
      record: "readiness_observation",
      mode: "mock_free",
      ...proof,
      result: "pass",
      origin: scope.origin,
      revision: scope.revision,
      environment: "staging",
      run_id: scope.runId,
      observed_at: new Date(at - (10 - index) * 1000).toISOString(),
      expires_at: new Date(at + (60 - index) * 1000).toISOString(),
      observation: { privateBody, index },
    };
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    if (index !== options.skip) writeFileSync(file, raw, { mode: 0o600 });
    return { file, document, raw };
  });
  return { directory, files };
}

test("receipt bytes are canonical and each digest covers the retained original observation", () => {
  const { directory, files } = makeObservations();
  const text = buildReadinessReceipt(directory, scope, now);
  const receipt = ReadinessReceiptSchema.parse(JSON.parse(text));
  expect(text).toBe(canonicalReadinessReceipt(receipt));
  expect(text).not.toContain(privateBody);
  const last = files.at(-1);
  if (!last) throw new Error("fixture must contain an observation");
  expect(receipt.observed_at).toBe(last.document.observed_at);
  expect(receipt.expires_at).toBe(last.document.expires_at);
  expect(receipt.proofs.map((proof) => proof.evidence_sha256)).toEqual(
    files.map(({ raw }) => createHash("sha256").update(raw).digest("hex")),
  );
});

test("missing, mixed, expired, or fixture observations cannot produce a receipt", () => {
  const missing = makeObservations({ skip: 7 });
  expect(() => buildReadinessReceipt(missing.directory, scope, now)).toThrow();
  for (const mutation of [
    { run_id: "different-run" },
    { origin: "https://a.asimposium.org" },
    { revision: "b".repeat(40) },
    { proof_id: "invented_proof" },
    { expires_at: "2026-11-27T12:00:14.000Z" },
    { mode: "fixture" },
    { evidence_sha256: "f".repeat(64) },
  ]) {
    const { directory, files } = makeObservations();
    const [first] = files;
    if (!first) throw new Error("fixture must contain an observation");
    writeFileSync(first.file, JSON.stringify({ ...first.document, ...mutation }));
    expect(() => buildReadinessReceipt(directory, scope, now)).toThrow();
  }
});

test("an observation must be a bounded regular file rather than a symbolic link", () => {
  const { directory, files } = makeObservations({ skip: 0 });
  const [first, second] = files;
  if (!first || !second) throw new Error("fixture must contain two observations");
  symlinkSync(second.file, first.file);
  expect(() => buildReadinessReceipt(directory, scope, now)).toThrow();
  const oversized = makeObservations();
  if (!oversized.files[0]) throw new Error("fixture must contain an observation");
  writeFileSync(oversized.files[0].file, "x".repeat(256 * 1024 + 1));
  expect(() => buildReadinessReceipt(oversized.directory, scope, now)).toThrow();
});

test("command output contains only the receipt and invalid observations emit no private bytes", () => {
  const { directory, files } = makeObservations({ at: Date.now() });
  const args = [script, directory, scope.origin, scope.revision, scope.runId];
  const pass = spawnSync(process.execPath, args, { encoding: "utf8" });
  expect(pass.status).toBe(0);
  expect(pass.stderr).toBe("");
  expect(pass.stdout).toBe(buildReadinessReceipt(directory, scope));
  const [first] = files;
  if (!first) throw new Error("fixture must contain an observation");
  writeFileSync(first.file, `not valid JSON ${privateBody}`);
  const fail = spawnSync(process.execPath, args, { encoding: "utf8" });
  expect(fail.status).toBe(1);
  expect(fail.stdout).toBe("");
  expect(fail.stderr).not.toContain(privateBody);
  expect(fail.stderr).not.toContain(directory);
});
