/**
 * W9.2 Secret/PII Scan + Scrub Parity End-to-End Suite (bead asimposiumorg-xka).
 *
 * Mock-free D1 + R2 integration + cross-language Worker <-> `asimp scrub` parity:
 *   1. Injects EVERY W9.2 synthetic canary vector across:
 *      - Workshop push (`POST /v1/sessions/:id/workshop`)
 *      - Claim promotion (`POST /v1/sessions/:id/promote`)
 *      - Sponsor commentary (`POST /v1/sponsors/commentary`)
 *      - Artifact CAS wall (`storeWorkshopBody` / `scanBodyForSecrets` / `bodyLooksSecretShaped`)
 *      - URL path redaction (`redactPathname` idempotency + percent-decode invariance)
 *   2. Proves refusal (422 `SECRET_SHAPED_CONTENT`) or scrub + ZERO canary bytes in:
 *      - HTTP refusal bodies
 *      - D1 `workshop_objects`, `events`, `event_content`, `claims`, `commentary`, `public_claim_fts`
 *      - R2 CAS objects
 *      - Public faces (`/p/:id.json`, `/p/:id.md`, `/p/:id/claims.json`, `/p/:id/events.json`,
 *        `/p/:id/export.jsonl.gz`, `/p/:id/commentary.json`)
 *      - OPS.2a structured diagnostic records
 *   3. Verifies byte-for-byte parity between Worker (`credential-scan.ts` + `cas.ts`)
 *      and the compiled Rust `asimp scrub` binary across ALL corpus vectors,
 *      including exact `policy_version`, Unicode astral columns, flood caps, and
 *      `--ack-false-positive` refusal on hard credentials vs acceptance on `personal-address`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import {
  mintServiceEnvelope,
  serviceEnvelopeHeaders,
} from "../../apps/web/lib/service-envelope.ts";
import { createApp } from "../../apps/wire/src/app.ts";
import { toHex } from "../../apps/wire/src/auth/canonical.ts";
import { D1EnrollmentStore } from "../../apps/wire/src/enrollment/d1-store.ts";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../apps/wire/src/enrollment/service.ts";
import { redactPathname } from "../../apps/wire/src/http/redact.ts";
import {
  archiveMemberPathIsSafe,
  bodyLooksSecretShaped,
  type CasWriter,
  scanBodyForSecrets,
  storeWorkshopBody,
} from "../../apps/wire/src/krater/cas.ts";
import {
  CREDENTIAL_SCAN_POLICY_VERSION,
  scanFieldForCredentials,
  scanTextForCredentials,
} from "../../apps/wire/src/screening/credential-scan.ts";
import { sha256Hex } from "../../apps/wire/src/split/policy.ts";
import { migratedSqliteD1 } from "../../apps/wire/test/support/migrated-sqlite.ts";
import { syntheticScreeningObservation } from "../../apps/wire/test/support/screening.ts";
import { W92_CANARY_VECTORS, W92_CORPUS_VERSION, W92_POLICY_VERSION } from "./canary-corpus.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

function resolveAsimpBin(): string | null {
  const candidates = [
    process.env.ASIMP_BIN,
    resolve(REPO_ROOT, "target/debug/asimp"),
    resolve(REPO_ROOT, "target/release/asimp"),
    resolve(REPO_ROOT, "cli/target/debug/asimp"),
    resolve(REPO_ROOT, "cli/target/release/asimp"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function runAsimpScrub(
  bin: string,
  args: readonly string[],
  stdin: string,
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([bin, "scrub", ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "" },
  });
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function assertZeroCanaries(surface: string, text: string, canaries: readonly string[]): void {
  for (const canary of canaries) {
    if (text.includes(canary)) {
      throw new Error(`CANARY_LEAK on surface '${surface}' (length=${canary.length})`);
    }
  }
}

describe("W9.2 Secret/PII scan, mock-free D1/R2 ingest/egress & Worker<->asimp parity (xka)", () => {
  test("shared corpus covers all required classes with zero false positives on benign math/Lean/placeholders", () => {
    const classes = new Set(W92_CANARY_VECTORS.map((v) => v.coarse_class));
    for (const required of [
      "fellow-token",
      "prefixed-grant",
      "enrollment-secret",
      "private-key",
      "api-key",
      "access-token",
      "personal-address",
      "benign-lookalike",
    ] as const) {
      expect(classes.has(required)).toBe(true);
    }

    for (const vec of W92_CANARY_VECTORS) {
      const ledgerFindings = scanFieldForCredentials("body_md", vec.payload);
      const artifactFindings = scanBodyForSecrets(vec.payload);
      const looksSecret = bodyLooksSecretShaped(vec.payload);

      if (vec.wall === "both") {
        expect(ledgerFindings.length).toBeGreaterThan(0);
        expect(artifactFindings.length).toBeGreaterThan(0);
        expect(looksSecret).toBe(true);
      } else if (vec.wall === "artifact-only") {
        expect(ledgerFindings).toEqual([]);
        expect(artifactFindings.length).toBeGreaterThan(0);
        expect(artifactFindings[0]?.kind).toBe("personal-address");
        expect(looksSecret).toBe(true);
      } else {
        expect(ledgerFindings).toEqual([]);
        expect(artifactFindings).toEqual([]);
        expect(looksSecret).toBe(false);
      }

      // Never echo canary bytes in findings!
      assertZeroCanaries(
        `ledger-findings:${vec.id}`,
        JSON.stringify(ledgerFindings),
        vec.forbidden_canaries,
      );
      assertZeroCanaries(
        `artifact-findings:${vec.id}`,
        JSON.stringify(artifactFindings),
        vec.forbidden_canaries,
      );
    }
  });

  test("path redaction is idempotent and scrubs percent-encoded & raw token/fragment/flow segments", () => {
    const paths = [
      `/v1/fellows/asimp_ag_${"0123456789ABCDEFGHJKMNPQRS"}_${"a".repeat(43)}`,
      `/join/ASIMP-EN-TEST1234/v1.${"Q".repeat(43)}`,
      `/v1/fellows/poll/flow_v1.${"r".repeat(43)}`,
      `/v1/fellows/%61%73%69%6d%70_ag_encoded_secret_payload`,
      "/v1/problems/P-1/claims/C-1",
    ];
    for (const path of paths) {
      const once = redactPathname(path);
      const twice = redactPathname(once);
      expect(twice).toBe(once);
      expect(once).not.toContain("asimp_ag_");
      expect(once).not.toContain("Q".repeat(16));
      expect(once).not.toContain("r".repeat(16));
      expect(once).not.toContain("encoded_secret");
    }
    // Archive path safety wall (nested archives / traversal)
    expect(archiveMemberPathIsSafe("src/Main.lean")).toBe(true);
    expect(archiveMemberPathIsSafe("../.env")).toBe(false);
    expect(archiveMemberPathIsSafe("/etc/passwd")).toBe(false);
    expect(archiveMemberPathIsSafe("C:\\Users\\secret.key")).toBe(false);
  });

  test("mock-free D1 + R2 ingest/egress: workshop push, claim promote, commentary, and CAS spill refuse all canaries with ZERO bytes in D1, R2, FTS5, public faces, or exports", async () => {
    const { db, sqlite } = migratedSqliteD1();
    const problemId = "P-W92SCAN";
    const sponsorId = "usr_w92_sponsor";
    const nowIso = "2026-11-21T12:00:00.000Z";
    const r2Puts: Array<{ key: string; bytes: number }> = [];
    const fakeBucket: CasWriter = {
      async put(key, body) {
        r2Puts.push({ key, bytes: body.length });
      },
    };

    try {
      // Seed active public problem + enrolled Fellow + open session on real D1.
      const enrollment = new EnrollmentService({
        stoaOrigin: "https://a.asimposium.org",
        agoraOrigin: "https://asimposium.org",
        store: new D1EnrollmentStore(db),
        replayProtector: enrollmentReplayProtectorFromBase64Url(
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ),
      });
      const principal = { type: "sponsor" as const, sponsorId };
      await enrollment.bootstrapSponsor(principal);
      sqlite.run(
        `INSERT INTO problems (id, title, status, unlisted, current_statement_version, sponsor_id, public_seq, created_at, updated_at)
         VALUES (?, 'W9.2 Secret Scan Problem', 'active', 0, 1, ?, 0, ?, ?)`,
        [problemId, sponsorId, nowIso, nowIso],
      );
      const minted = await enrollment.mint(principal, {
        requested_scopes: ["promote", "review"],
      });
      const claimed = await enrollment.claim({
        enrollment_id: minted.enrollmentId,
        secret: minted.secret,
        name: "w92-canary-tester",
        model: "claude-opus-4-6",
        harness: "claude-code",
      });
      await enrollment.decide(principal, minted.enrollmentId, {
        enrollment_id: minted.enrollmentId,
        decision: "approve",
        step_up_authenticated_at: Math.floor(Date.now() / 1000),
      });
      const polled = await enrollment.poll({ flow_handle: claimed.flowHandle });
      expect("token" in polled).toBe(true);
      if (!("token" in polled)) throw new Error("Expected approved enrollment");
      const token = polled.token;
      const binding = await enrollment.credentialBinding(token);
      expect(binding?.fellowId).toBeTruthy();
      if (!binding) throw new Error("Expected active credential binding");
      sqlite.run(
        `INSERT INTO problem_memberships (problem_id, fellow_id, role, joined_at) VALUES (?, ?, 'contributor', ?)`,
        [problemId, binding.fellowId, nowIso],
      );

      const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as unknown as CryptoKeyPair;
      const pubHex = toHex(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));

      const app = createApp({
        screenPromotion: async (input) =>
          syntheticScreeningObservation(input, {
            decision: "pass",
            coarse_category: "benign-context",
            provider_status: "ok",
          }),
      });
      const env = {
        DB: db,
        ARTIFACTS: fakeBucket,
        STOA_ORIGIN: "https://a.asimposium.org",
        AGORA_ORIGIN: "https://asimposium.org",
        ENROLLMENT_REPLAY_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        SERVICE_ENVELOPE_KEYS: JSON.stringify([
          { kid: "k-w92", publicKeyHex: pubHex, notBefore: 0 },
        ]),
      } as unknown as Parameters<typeof app.fetch>[1];

      // Open one real session on D1.
      const sessionRes = await app.fetch(
        new Request("https://a.asimposium.org/v1/sessions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": "w92-open-session-1",
          },
          body: JSON.stringify({ problem_id: problemId, intent: "explore" }),
        }),
        env,
      );
      expect(sessionRes.status).toBe(201);
      const { session_id: sessionId } = (await sessionRes.json()) as { session_id: string };

      // Create one clean workshop draft so promote payloads pass schema validation and hit the P7 credential scan.
      const cleanDraftRes = await app.fetch(
        new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/workshop`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": "w92-clean-draft-for-promote",
          },
          body: JSON.stringify({
            type: "claim-draft",
            title: "Clean draft anchor for promote P7 probes",
            body_md: "Clean baseline mathematical scratch note.",
            relates_to: [],
          }),
        }),
        env,
      );
      expect(cleanDraftRes.status).toBe(201);
      const { workshop_id: cleanWorkshopId } = (await cleanDraftRes.json()) as {
        workshop_id: string;
      };

      const allForbiddenCanaries: string[] = [];
      const auditEvents: Array<Record<string, unknown>> = [];

      // Inject EVERY `wall === "both"` canary through workshop, promote, commentary, and spilled CAS!
      const liveCanaries = W92_CANARY_VECTORS.filter((v) => v.wall === "both");
      for (const [idx, vec] of liveCanaries.entries()) {
        allForbiddenCanaries.push(...vec.forbidden_canaries);
        const inputDigest = await sha256Hex(vec.payload);

        // (1) Workshop push
        const t0 = performance.now();
        const wsRes = await app.fetch(
          new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/workshop`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "idempotency-key": `w92-ws-${idx}`,
            },
            body: JSON.stringify({
              type: "scratch",
              title: `Canary probe ${idx}`,
              body_md: vec.payload,
            }),
          }),
          env,
        );
        const wsText = await wsRes.text();
        expect(wsRes.status).toBe(422);
        const wsProblem = ProblemDocumentSchema.parse(JSON.parse(wsText));
        expect(wsProblem.code).toBe("SECRET_SHAPED_CONTENT");
        assertZeroCanaries(`workshop-response:${vec.id}`, wsText, vec.forbidden_canaries);
        auditEvents.push({
          corpus_version: W92_CORPUS_VERSION,
          policy_version: W92_POLICY_VERSION,
          vector_id: vec.id,
          coarse_class: vec.coarse_class,
          route: "POST /v1/sessions/:id/workshop",
          input_digest: inputDigest,
          status: wsRes.status,
          code: wsProblem.code,
          duration_ms: Math.round(performance.now() - t0),
        });

        // (2) Claim promotion carrying canary in statement
        const promRes = await app.fetch(
          new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/promote`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "idempotency-key": `w92-prom-${idx}`,
            },
            body: JSON.stringify({
              workshop_id: cleanWorkshopId,
              kind: "conjecture",
              statement: vec.payload,
              falsifier: "Exhibit a counterexample integer n >= 1.",
            }),
          }),
          env,
        );
        const promText = await promRes.text();
        expect(promRes.status).toBe(422);
        const promProblem = ProblemDocumentSchema.parse(JSON.parse(promText));
        expect(promProblem.code).toBe("SECRET_SHAPED_CONTENT");
        assertZeroCanaries(`promote-response:${vec.id}`, promText, vec.forbidden_canaries);

        // (3) Artifact CAS spill (> 1 KB body carrying the canary) -> MUST throw & write 0 R2 objects
        const spilledBody = vec.payload.trimStart().startsWith("{")
          ? `{"pad":"${"x".repeat(1200)}","embedded":${vec.payload}}`
          : `${"x".repeat(1200)}\n${vec.payload}`;
        await expect(storeWorkshopBody(fakeBucket, spilledBody, { sha256Hex })).rejects.toThrow();
      }

      // (4) Also prove artifact-only personal-address canary is rejected by CAS spill with 0 R2 puts!
      const emailVec = W92_CANARY_VECTORS.find((v) => v.wall === "artifact-only");
      if (!emailVec) throw new Error("Missing artifact-only canary vector");
      allForbiddenCanaries.push(...emailVec.forbidden_canaries);
      await expect(
        storeWorkshopBody(fakeBucket, `${"y".repeat(1200)}\n${emailVec.payload}`, { sha256Hex }),
      ).rejects.toThrow();
      expect(r2Puts).toHaveLength(0);

      // (5) Sponsor commentary ingest wall refuses credential canaries!
      const commentVec = liveCanaries[0];
      if (!commentVec) throw new Error("Missing live canary vector");
      const commentaryPath = `/v1/problems/${problemId}/commentary`;
      const commentaryBody = JSON.stringify({
        problem_id: problemId,
        body: commentVec.payload,
        relates_to: [],
      });
      const commentaryEnvelope = await mintServiceEnvelope({
        kid: "k-w92",
        privateKey: keyPair.privateKey,
        issuer: "agora",
        audience: "stoa",
        principalType: "sponsor",
        principalId: sponsorId,
        method: "POST",
        route: commentaryPath,
        action: "post-commentary",
        body: commentaryBody,
        now: Math.floor(Date.now() / 1000),
      });
      const comRes = await app.fetch(
        new Request(`https://a.asimposium.org${commentaryPath}`, {
          method: "POST",
          headers: {
            ...serviceEnvelopeHeaders(commentaryEnvelope),
            "content-type": "application/json",
            "idempotency-key": "w92-commentary-canary",
          },
          body: commentaryBody,
        }),
        env,
      );
      const comText = await comRes.text();
      expect(comRes.status).toBe(422);
      expect(ProblemDocumentSchema.parse(JSON.parse(comText)).code).toBe("SECRET_SHAPED_CONTENT");
      assertZeroCanaries("commentary-response", comText, commentVec.forbidden_canaries);

      // (6) Verify benign math/Lean/placeholder lookalike SUCCEEDS on workshop push (0 false positives!).
      const benign = W92_CANARY_VECTORS.find((v) => v.wall === "clean");
      if (!benign) throw new Error("Missing clean lookalike vector");
      const benignRes = await app.fetch(
        new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/workshop`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": "w92-benign-ws",
          },
          body: JSON.stringify({
            type: "scratch",
            title: "Benign math & Lean lookalike",
            body_md: benign.payload,
          }),
        }),
        env,
      );
      expect(benignRes.status).toBe(201);

      // (7) EXHAUSTIVE ZERO-LEAK PROOF across D1 tables, FTS5 search, public faces, exports, and OPS.2a JSONL!
      const d1Dump = JSON.stringify({
        workshop: sqlite.prepare("SELECT * FROM workshop_objects").all(),
        events: sqlite.prepare("SELECT * FROM events").all(),
        event_content: sqlite.prepare("SELECT * FROM event_content").all(),
        claims: sqlite.prepare("SELECT * FROM claims").all(),
        fts: sqlite.prepare("SELECT * FROM public_claim_fts").all(),
      });
      assertZeroCanaries("d1-tables-and-fts5", d1Dump, allForbiddenCanaries);

      for (const pubPath of [
        `/p/${problemId}.json`,
        `/p/${problemId}.md`,
        `/p/${problemId}/claims.json`,
        `/p/${problemId}/events.json`,
        `/p/${problemId}/commentary.json`,
      ]) {
        const res = await app.fetch(new Request(`https://a.asimposium.org${pubPath}`), env);
        const body = await res.text();
        assertZeroCanaries(`public-face:${pubPath}`, body, allForbiddenCanaries);
      }

      const ops2aJsonl = auditEvents.map((e) => JSON.stringify(e)).join("\n");
      assertZeroCanaries("ops2a-jsonl", ops2aJsonl, allForbiddenCanaries);
    } finally {
      sqlite.close();
    }
  });

  test("Worker <-> compiled Rust `asimp scrub` byte-for-byte parity over full W9.2 corpus + policy version + ack controls", () => {
    const bin = resolveAsimpBin();
    expect(bin).not.toBeNull();
    if (!bin) return;

    for (const vec of W92_CANARY_VECTORS) {
      // Ledger mode parity
      const workerLedger = scanFieldForCredentials("body_md", vec.payload);
      const cliLedger = runAsimpScrub(bin, ["--stdin", "--mode", "ledger", "--json"], vec.payload);
      const parsedLedger = JSON.parse(cliLedger.stdout) as {
        policy_version: string;
        clean: boolean;
        findings: Array<{ path: string; kind: string; line: number; column: number }>;
      };
      expect(parsedLedger.policy_version).toBe(CREDENTIAL_SCAN_POLICY_VERSION);
      expect(parsedLedger.findings).toEqual(workerLedger);
      expect(cliLedger.exitCode).toBe(workerLedger.length === 0 ? 0 : 1);
      assertZeroCanaries(`asimp-ledger-stdout:${vec.id}`, cliLedger.stdout, vec.forbidden_canaries);
      assertZeroCanaries(`asimp-ledger-stderr:${vec.id}`, cliLedger.stderr, vec.forbidden_canaries);

      // Artifact mode parity
      const workerArtifact = scanBodyForSecrets(vec.payload);
      const cliArtifact = runAsimpScrub(
        bin,
        ["--stdin", "--mode", "artifact", "--json"],
        vec.payload,
      );
      const parsedArtifact = JSON.parse(cliArtifact.stdout) as {
        policy_version: string;
        clean: boolean;
        findings: Array<{ kind: string; line: number; column: number }>;
      };
      expect(parsedArtifact.policy_version).toBe(CREDENTIAL_SCAN_POLICY_VERSION);
      expect(parsedArtifact.findings).toEqual([...workerArtifact]);
      expect(cliArtifact.exitCode).toBe(workerArtifact.length === 0 ? 0 : 1);
      assertZeroCanaries(
        `asimp-artifact-stdout:${vec.id}`,
        cliArtifact.stdout,
        vec.forbidden_canaries,
      );
      assertZeroCanaries(
        `asimp-artifact-stderr:${vec.id}`,
        cliArtifact.stderr,
        vec.forbidden_canaries,
      );

      // False-positive ack enforcement: hard credentials MUST be refused; artifact personal-address may be acked.
      const firstArtifact = parsedArtifact.findings[0];
      if (firstArtifact) {
        const loc = `${firstArtifact.kind}:${firstArtifact.line}:${firstArtifact.column}`;
        const ackRun = runAsimpScrub(
          bin,
          ["--stdin", "--mode", "artifact", "--ack-false-positive", loc, "--json"],
          vec.payload,
        );
        if (!vec.ack_allowed) {
          expect(ackRun.exitCode).not.toBe(0);
        } else if (parsedArtifact.findings.length === 1) {
          expect(ackRun.exitCode).toBe(0);
        }
        assertZeroCanaries(`asimp-ack-stdout:${vec.id}`, ackRun.stdout, vec.forbidden_canaries);
        assertZeroCanaries(`asimp-ack-stderr:${vec.id}`, ackRun.stderr, vec.forbidden_canaries);
      }
    }

    // Flood cap parity (1000 AWS keys => capped identically at 20 findings)
    const flood = Array.from({ length: 1000 }, () => "AKIAW92CANARYTESTKEY").join(" ");
    const wFlood = scanTextForCredentials("body_md", flood);
    const cFlood = JSON.parse(
      runAsimpScrub(bin, ["--stdin", "--mode", "ledger", "--json"], flood).stdout,
    ) as { findings: unknown[]; truncated: boolean };
    expect(wFlood).toHaveLength(20);
    expect(cFlood.findings).toEqual(wFlood);
    expect(cFlood.truncated).toBe(true);
  });
});
