#!/usr/bin/env bun
/**
 * Cross-language Krater export verification parity test (W11.2, asimposiumorg-l3b).
 *
 * Generates REAL `asimposium.problem-export.v5` and `asimposium.problem-export.v3`
 * gzipped archives using the live TypeScript Worker modules
 * (`apps/wire/src/krater/krater.ts` + `apps/wire/src/krater/export.ts`) and
 * feeds them straight into the compiled Rust binary (`asimp pull --verify-file`),
 * proving byte-for-byte digest parity across valid exports (with checkpoints and
 * publication notices) and tampered negative controls.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ProblemExportEvent,
  serializeProblemExport,
  serializePublicProblemExport,
  verifyProblemExportChain,
  verifyPublicProblemExportChain,
} from "../../apps/wire/src/krater/export.ts";
import {
  checkpointDigest,
  eventChainDigest,
  eventEnvelopeRowDigest,
  genesisChainDigest,
  KRATER_CHAIN_VERSION,
  type KraterCheckpoint,
  sha256Hex,
} from "../../apps/wire/src/krater/krater.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

function resolveAsimpBin(): string {
  const envBin = process.env.ASIMP_BIN;
  if (envBin && existsSync(envBin)) return envBin;
  for (const rel of [
    "target/debug/asimp",
    "target/release/asimp",
    "cli/target/debug/asimp",
    "cli/target/release/asimp",
  ]) {
    const candidate = resolve(REPO_ROOT, rel);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Compiled asimp binary not found; build with rch exec -- cargo build --manifest-path cli/Cargo.toml --locked -j 2");
}

const ASIMP_BIN = resolveAsimpBin();

function runAsimp(args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([ASIMP_BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", ASIMP_ORIGIN: "https://example.invalid" },
  });
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

async function buildRealWorkerArchive(problemId: string): Promise<{
  v5Ndjson: string;
  v3Ndjson: string;
  finalChainDigest: string;
  checkpointSeq: number;
}> {
  const genesis = await genesisChainDigest(problemId);
  let previous = genesis;
  const payloads = [
    JSON.stringify({ kind: "claim", statement: "Every prime p > 2 satisfies p mod 2 = 1." }),
    JSON.stringify({
      kind: "review",
      target_claim_id: "C-1",
      verdict: "corroborate",
      basis: "Parity check.",
    }),
  ];

  const events: ProblemExportEvent[] = [];
  for (let i = 0; i < payloads.length; i++) {
    const seq = i + 1;
    const payloadJson = payloads[i]!;
    const payloadSha256 = await sha256Hex(payloadJson);
    const createdAt = `2026-09-10T00:00:0${seq}.000Z`;
    const eventId = `EV-PARITY-${seq}`;
    const objectKind = seq === 1 ? "claim" : "review";
    const objectId = seq === 1 ? "C-1" : "RV-1";
    const type = seq === 1 ? "claim.created" : "review.submitted";
    const rowDigest = await eventEnvelopeRowDigest({
      eventId,
      problemId,
      seq,
      type,
      objectKind,
      objectId,
      objectVersion: 1,
      payloadSha256,
      createdAt,
      actorFellowId: `F-${seq}`,
      actorSponsorId: `usr_${seq}`,
      actorSessionId: `S-${seq}`,
      modelStringSelfDeclared: "claude-opus-4-6",
      harness: "claude-code",
      writerCredentialId: `cred_${seq}`,
    });
    const chainDigest = await eventChainDigest(problemId, seq, payloadSha256, rowDigest, previous);
    previous = chainDigest;
    events.push({
      eventId,
      problemId,
      seq,
      type,
      objectKind,
      objectId,
      objectVersion: 1,
      payloadSha256,
      payloadJson,
      rowDigest,
      chainDigest,
      chainVersion: KRATER_CHAIN_VERSION,
      createdAt,
      actorFellowId: `F-${seq}`,
      actorSponsorId: `usr_${seq}`,
      actorSessionId: `S-${seq}`,
      modelStringSelfDeclared: "claude-opus-4-6",
      harness: "claude-code",
      writerCredentialId: `cred_${seq}`,
    });
  }

  const checkpointSeq = 2;
  const cpDigest = await checkpointDigest(problemId, checkpointSeq, previous);
  const checkpoints: KraterCheckpoint[] = [
    {
      problemId,
      checkpointSeq,
      rootChainDigest: previous,
      checkpointDigest: cpDigest,
      checkpointVersion: 1,
      chainVersion: KRATER_CHAIN_VERSION,
      checkpointMode: "unsigned-v0",
    },
  ];

  const v3Ndjson = serializeProblemExport({
    problemId,
    problemTitle: "Parity Verification Problem",
    events,
    checkpoints,
    generatedAt: "2026-09-10T00:05:00.000Z",
  });

  const v5Ndjson = await serializePublicProblemExport({
    problemId,
    problemTitle: "Parity Verification Problem",
    events,
    checkpoints,
    generatedAt: "2026-09-10T00:05:00.000Z",
    publicationNotices: [
      {
        event_id: events[0]!.eventId,
        seq: events[0]!.seq,
        payload_sha256: events[0]!.payloadSha256,
        screening_notice: {
          category: "off-topic",
          action: "published-with-warning",
          notice: "off-scope",
        },
      },
    ],
  });

  return { v5Ndjson, v3Ndjson, finalChainDigest: previous, checkpointSeq };
}

const workDir = mkdtempSync(join(tmpdir(), "asimp-export-parity-"));
try {
  const { v5Ndjson, v3Ndjson, finalChainDigest, checkpointSeq } =
    await buildRealWorkerArchive("P-4DSP");

  // Confirm Worker TS verifiers accept both first.
  const tsV5 = await verifyPublicProblemExportChain(v5Ndjson);
  const tsV3 = await verifyProblemExportChain(v3Ndjson);
  if (!tsV5.intact || !tsV3.intact) {
    throw new Error("Worker TS failed to verify its own archive");
  }

  const v5GzPath = join(workDir, "p4dsp.v5.export.jsonl.gz");
  const v3Path = join(workDir, "p4dsp.v3.export.jsonl");
  writeFileSync(v5GzPath, Bun.gzipSync(new TextEncoder().encode(v5Ndjson)));
  writeFileSync(v3Path, v3Ndjson);

  // 1. Valid gzipped v5 public export with external pin
  const rV5 = runAsimp([
    "pull",
    "--verify-file",
    v5GzPath,
    "--pin-seq",
    String(checkpointSeq),
    "--pin-root",
    finalChainDigest,
    "--json",
  ]);
  if (rV5.exitCode !== 0) {
    throw new Error(`Rust failed to verify valid TS v5 gzip export: ${rV5.stdout} ${rV5.stderr}`);
  }
  const parsedV5 = JSON.parse(rV5.stdout);
  if (
    parsedV5.final_chain_digest !== tsV5.finalChainDigest ||
    parsedV5.publication_context_sha256 !== tsV5.publicationContextSha256 ||
    parsedV5.publication_notice_count !== tsV5.publicationNoticeCount ||
    parsedV5.event_count !== tsV5.eventCount
  ) {
    throw new Error(`Digest mismatch on v5 export:\nTS=${JSON.stringify(tsV5)}\nRS=${JSON.stringify(parsedV5)}`);
  }

  // 2. Valid v3 export
  const rV3 = runAsimp(["pull", "--verify-file", v3Path, "--json"]);
  if (rV3.exitCode !== 0) {
    throw new Error(`Rust failed to verify valid TS v3 export: ${rV3.stdout} ${rV3.stderr}`);
  }
  const parsedV3 = JSON.parse(rV3.stdout);
  if (parsedV3.final_chain_digest !== tsV3.finalChainDigest || parsedV3.event_count !== tsV3.eventCount) {
    throw new Error(`Digest mismatch on v3 export`);
  }

  // 3. Negative controls: BOTH TS and Rust must reject every tampered archive at the same seq.
  const tamperCases: ReadonlyArray<{ name: string; ndjson: string; isPublic: boolean }> = [
    {
      name: "payload-bitflip",
      ndjson: v5Ndjson.replace("Parity check.", "Parity check!"),
      isPublic: true,
    },
    {
      name: "envelope-actor-tamper",
      ndjson: v5Ndjson.replace('"actor_fellow_id":"F-1"', '"actor_fellow_id":"F-9"'),
      isPublic: true,
    },
    {
      name: "publication-notice-tamper",
      ndjson: v5Ndjson.replace('"notice":"off-scope"', '"notice":"degraded"'),
      isPublic: true,
    },
    {
      name: "truncated-trailer",
      ndjson: `${v3Ndjson.trimEnd().split("\n").slice(0, -1).join("\n")}\n`,
      isPublic: false,
    },
    {
      name: "crlf-framing",
      ndjson: v3Ndjson.replaceAll("\n", "\r\n"),
      isPublic: false,
    },
  ];

  for (const tc of tamperCases) {
    const tsResult = tc.isPublic
      ? await verifyPublicProblemExportChain(tc.ndjson)
      : await verifyProblemExportChain(tc.ndjson);
    if (tsResult.intact) {
      throw new Error(`TS unexpectedly accepted tampered case ${tc.name}`);
    }
    const p = join(workDir, `${tc.name}.jsonl`);
    writeFileSync(p, tc.ndjson);
    const rs = runAsimp(["pull", "--verify-file", p, "--json"]);
    if (rs.exitCode !== 1) {
      throw new Error(`Rust failed to reject tampered case ${tc.name}: exit=${rs.exitCode} out=${rs.stdout}`);
    }
    const rsParsed = JSON.parse(rs.stdout);
    if (rsParsed.ok !== false || rsParsed.broken_at_seq !== tsResult.brokenAtSeq) {
      throw new Error(
        `broken_at_seq mismatch on ${tc.name}: TS=${tsResult.brokenAtSeq}, RS=${rsParsed.broken_at_seq}`,
      );
    }
  }

  // 4. Wrong external pin rejected by both TS and Rust at seq 2.
  const wrongPinTs = await verifyPublicProblemExportChain(v5Ndjson, {
    problemId: "P-4DSP",
    checkpointSeq: 2,
    rootChainDigest: "0".repeat(64),
  });
  const wrongPinRs = runAsimp([
    "pull",
    "--verify-file",
    v5GzPath,
    "--pin-seq",
    "2",
    "--pin-root",
    "0".repeat(64),
    "--json",
  ]);
  if (wrongPinTs.intact || wrongPinRs.exitCode !== 1) {
    throw new Error("Wrong external pin was not rejected by both TS and Rust");
  }
  const wrongPinRsParsed = JSON.parse(wrongPinRs.stdout);
  if (wrongPinRsParsed.broken_at_seq !== wrongPinTs.brokenAtSeq) {
    throw new Error("Wrong pin broken_at_seq mismatch");
  }

  console.log(
    JSON.stringify({
      ok: true,
      asimp_bin: ASIMP_BIN,
      v5_chain_digest: finalChainDigest,
      v5_context_sha256: tsV5.publicationContextSha256,
      valid_archives_verified: 2,
      tamper_controls_verified: tamperCases.length + 1,
      total_diffs: 0,
    }),
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
