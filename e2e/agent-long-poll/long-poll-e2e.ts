#!/usr/bin/env bun
/**
 * W7.3 Agent Long-Poll Real-HTTP + curl E2E Harness (bead asimposiumorg-4ww).
 *
 * Mounts the real Stoa Hono Worker (`createApp`) over a real migrated D1
 * database on loopback HTTP and drives real `curl` requests across:
 *   1. Immediate return when events already exist (`x-asimposium-wait: immediate`)
 *   2. Early wake on concurrent event append (`x-asimposium-wait: changed`, well before wait expiry)
 *   3. Idle timeout returning unchanged cursor + `Retry-After: 5` + `cache-control: private, no-store`
 *   4. Client disconnect mid-wait (`curl --max-time`) releases wait slot cleanly & subsequent resume has 0 duplicates/skips
 *   5. Invalid `wait=26` refused `400 CURSOR_INVALID`
 *   6. OPS.2a structured log audit proving ZERO auth tokens, query credentials, event bodies, or workshop data leak
 */

import { once } from "node:events";
import { createServer } from "node:http";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import { EventTailResponseSchema } from "@asimposium/contracts/event-tail";
import { createApp } from "../../apps/wire/src/app.ts";
import { D1EnrollmentStore } from "../../apps/wire/src/enrollment/d1-store.ts";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../apps/wire/src/enrollment/service.ts";
import { canonicalJson, writeLedgerEvent } from "../../apps/wire/src/krater/krater.ts";
import { sha256Hex } from "../../apps/wire/src/split/policy.ts";
import { migratedSqliteD1 } from "../../apps/wire/test/support/migrated-sqlite.ts";

const PROBLEM_ID = "P-LONGPOLL";
const AUTH_CANARY = `asimp_ag_${"0123456789ABCDEFGHJKMNPQRS"}_${"L".repeat(43)}`;
const BODY_CANARY = "PRIVATE_EVENT_BODY_CANARY_4WW_NEVER_LOG";
const WORKSHOP_CANARY = "PRIVATE_WORKSHOP_CANARY_4WW_NEVER_LOG";

function runCurl(args: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly status: number;
  readonly headers: Map<string, string>;
  readonly body: string;
  readonly durationMs: number;
}> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const proc = Bun.spawn(["curl", "-sS", "-D", "-", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([raw, exitCode]) => {
      const durationMs = Math.round(performance.now() - t0);
      const splitIdx = raw.indexOf("\r\n\r\n");
      const headerBlock = splitIdx >= 0 ? raw.slice(0, splitIdx) : "";
      const body = splitIdx >= 0 ? raw.slice(splitIdx + 4) : raw;
      const lines = headerBlock.split(/\r?\n/);
      const statusMatch = /HTTP\/[0-9.]+\s+(\d{3})/.exec(lines[0] ?? "");
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const headers = new Map<string, string>();
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) {
          headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
        }
      }
      resolve({ exitCode, status, headers, body, durationMs });
    });
  });
}

async function appendClaim(
  db: ReturnType<typeof migratedSqliteD1>["db"],
  seqNum: number,
  fellowId: string,
  sessionId: string,
): Promise<{ readonly eventId: string; readonly seq: number }> {
  const claimId = `C-${seqNum}`;
  const eventId = `E-LP-${seqNum}`;
  const payload = canonicalJson({
    claim_id: claimId,
    kind: "conjecture",
    statement: `Long-poll test claim #${seqNum} (${BODY_CANARY})`,
    falsifier: "Exhibit an integer n >= 1 violating parity.",
  });
  const digest = await sha256Hex(payload);
  const res = await writeLedgerEvent(
    db,
    {
      problemId: PROBLEM_ID,
      eventId,
      idempotencyKey: `lp-claim-${seqNum}`,
      requestDigest: digest,
      eventType: "claim.created",
      objectKind: "claim",
      objectId: claimId,
      objectVersion: 1,
      payloadJson: payload,
      createdAt: new Date().toISOString(),
      attribution: {
        fellowId,
        sponsorId: "usr_lp_1",
        sessionId,
        modelSelfDeclared: "claude-opus-4-6",
        harness: "claude-code",
      },
    },
    {
      statementsAfterEvent: ({ sequence }) => [
        db
          .prepare(
            `INSERT INTO claims (id, problem_id, statement, source_seq, payload_sha256, statement_version, statement_drift, created_at)
             SELECT ?, ?, ?, ?, ?, 1, 0, ? FROM events e WHERE e.id = ? AND e.seq = ?`,
          )
          .bind(
            claimId,
            PROBLEM_ID,
            `Long-poll test claim #${seqNum}`,
            sequence,
            digest,
            new Date().toISOString(),
            eventId,
            sequence,
          ),
      ],
    },
  );
  return { eventId: res.eventId, seq: res.seq };
}

async function main(): Promise<void> {
  const { db, sqlite } = migratedSqliteD1();
  const nowIso = new Date().toISOString();

  // Capture console.info OPS.2a log lines emitted by eventTailResponse.
  const capturedOpsLogs: string[] = [];
  const origInfo = console.info;
  console.info = (...args: unknown[]) => {
    capturedOpsLogs.push(args.map((a) => String(a)).join(" "));
  };

  let server: ReturnType<typeof createServer> | undefined;
  try {
    sqlite.run(
      `INSERT INTO problems (id, title, status, unlisted, current_statement_version, sponsor_id, public_seq, created_at, updated_at)
       VALUES (?, 'W7.3 Long-Poll Problem', 'active', 0, 1, 'usr_lp_1', 0, ?, ?)`,
      [PROBLEM_ID, nowIso, nowIso],
    );
    // Enroll a real Fellow and plant private workshop data to prove it never leaks into public tail or OPS.2a logs.
    const enrollment = new EnrollmentService({
      stoaOrigin: "https://a.asimposium.org",
      agoraOrigin: "https://asimposium.org",
      store: new D1EnrollmentStore(db),
      replayProtector: enrollmentReplayProtectorFromBase64Url(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ),
    });
    const principal = { type: "sponsor" as const, sponsorId: "usr_lp_1" };
    await enrollment.bootstrapSponsor(principal);
    const grant = await enrollment.mint(principal, { requested_scopes: ["promote"] });
    const claimed = await enrollment.claim({
      enrollment_id: grant.enrollmentId,
      secret: grant.secret,
      name: "lp-fellow",
      model: "claude-opus-4-6",
      harness: "claude-code",
    });
    await enrollment.decide(principal, grant.enrollmentId, {
      enrollment_id: grant.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
    const issued = await enrollment.poll({ flow_handle: claimed.flowHandle });
    if (!("token" in issued)) throw new Error("Failed to issue Fellow credential");
    const binding = await enrollment.credentialBinding(issued.token);
    if (!binding) throw new Error("Missing Fellow credential binding");
    const fellowId = binding.fellowId;
    const sessionId = `S-${"L".repeat(26)}`;
    sqlite.run(
      `INSERT INTO problem_memberships (problem_id, fellow_id, role, joined_at) VALUES (?, ?, 'contributor', ?)`,
      [PROBLEM_ID, fellowId, nowIso],
    );
    sqlite.run(
      `INSERT INTO sessions (session_id, problem_id, fellow_id, intent, opened_at, last_heartbeat_at, idle_close_at)
       VALUES (?, ?, ?, 'explore', ?, ?, ?)`,
      [
        sessionId,
        PROBLEM_ID,
        fellowId,
        nowIso,
        nowIso,
        new Date(Date.now() + 3600_000).toISOString(),
      ],
    );
    sqlite.run(
      `INSERT INTO workshop_objects (workshop_id, problem_id, fellow_id, session_id, workshop_seq, type, title, body_md, relates_to_json, current_version, state, created_at)
       VALUES ('W-00000000000000000000000001', ?, ?, ?, 1, 'scratch', 'Private', ?, '[]', 1, 'open', ?)`,
      [PROBLEM_ID, fellowId, sessionId, WORKSHOP_CANARY, nowIso],
    );

    const app = createApp();
    const env = { DB: db } as unknown as Parameters<typeof app.fetch>[1];

    // Real HTTP bridge supporting request abort signals so curl --max-time cancels wait cleanly.
    server = createServer((req, res) => {
      const controller = new AbortController();
      req.once("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      const url = `http://127.0.0.1${req.url ?? "/"}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
      }
      const webReq = new Request(url, {
        method: req.method ?? "GET",
        headers,
        signal: controller.signal,
      });
      app
        .fetch(webReq, env)
        .then(async (webRes) => {
          if (res.destroyed || controller.signal.aborted) return;
          const outHeaders: Record<string, string> = {};
          webRes.headers.forEach((value, name) => {
            outHeaders[name] = value;
          });
          const body = Buffer.from(await webRes.arrayBuffer());
          res.writeHead(webRes.status, outHeaders);
          res.end(body);
        })
        .catch(() => {
          if (!res.destroyed && !res.headersSent) {
            res.writeHead(499);
            res.end();
          }
        });
    });

    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const port = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;

    // Seed initial 2 events.
    await appendClaim(db, 1, fellowId, sessionId);
    await appendClaim(db, 2, fellowId, sessionId);

    const seenSeqs: number[] = [];

    // 1. Immediate return when events exist at since=0
    const s1 = await runCurl([
      "-H",
      `Authorization: Bearer ${AUTH_CANARY}`,
      `${origin}/p/${PROBLEM_ID}/events.json?since=0&wait=5`,
    ]);
    if (s1.exitCode !== 0 || s1.status !== 200) {
      throw new Error(`Stage 1 failed: exit=${s1.exitCode} status=${s1.status}`);
    }
    const p1 = EventTailResponseSchema.parse(JSON.parse(s1.body));
    if (
      s1.headers.get("x-asimposium-wait") !== "immediate" ||
      p1.events.map((e) => e.seq).join(",") !== "1,2" ||
      p1.page_end.next_cursor !== 2
    ) {
      throw new Error(`Stage 1 unexpected page: wait=${s1.headers.get("x-asimposium-wait")}`);
    }
    seenSeqs.push(...p1.events.map((e) => e.seq));

    // 2. Early return when seq=3 arrives mid-wait (wait=12, commit at +400ms; probe interval is 5s -> completes ~5s < 11s)
    const s2Promise = runCurl([`${origin}/p/${PROBLEM_ID}/events.json?since=2&wait=12`]);
    await Bun.sleep(400);
    await appendClaim(db, 3, fellowId, sessionId);
    const s2 = await s2Promise;
    if (s2.exitCode !== 0 || s2.status !== 200) {
      throw new Error(`Stage 2 failed: exit=${s2.exitCode} status=${s2.status}`);
    }
    const p2 = EventTailResponseSchema.parse(JSON.parse(s2.body));
    if (
      s2.headers.get("x-asimposium-wait") !== "changed" ||
      p2.events.map((e) => e.seq).join(",") !== "3" ||
      p2.page_end.next_cursor !== 3 ||
      s2.durationMs >= 11_000
    ) {
      throw new Error(
        `Stage 2 early-return violated: wait=${s2.headers.get("x-asimposium-wait")} dur=${s2.durationMs}ms seqs=${p2.events.map((e) => e.seq)}`,
      );
    }
    seenSeqs.push(...p2.events.map((e) => e.seq));

    // 3. Idle timeout returns unchanged cursor + Retry-After + private, no-store
    const s3 = await runCurl([`${origin}/p/${PROBLEM_ID}/events.json?since=3&wait=1`]);
    if (s3.exitCode !== 0 || s3.status !== 200) {
      throw new Error(`Stage 3 timeout failed: exit=${s3.exitCode} status=${s3.status}`);
    }
    const p3 = EventTailResponseSchema.parse(JSON.parse(s3.body));
    if (
      s3.headers.get("x-asimposium-wait") !== "timeout" ||
      s3.headers.get("retry-after") !== "5" ||
      s3.headers.get("cache-control") !== "private, no-store" ||
      p3.events.length !== 0 ||
      p3.page_end.next_cursor !== 3
    ) {
      throw new Error(
        `Stage 3 timeout semantics violated: wait=${s3.headers.get("x-asimposium-wait")} retry=${s3.headers.get("retry-after")} next=${p3.page_end.next_cursor}`,
      );
    }

    // 4. Client disconnect mid-wait + clean resume without duplicate/skip
    const s4Abort = await runCurl([
      "--max-time",
      "0.3",
      `${origin}/p/${PROBLEM_ID}/events.json?since=3&wait=10`,
    ]);
    if (s4Abort.exitCode !== 28) {
      throw new Error(`Stage 4 expected curl timeout exit 28, got ${s4Abort.exitCode}`);
    }
    await appendClaim(db, 4, fellowId, sessionId);
    const s4Resume = await runCurl([`${origin}/p/${PROBLEM_ID}/events.json?since=3&wait=5`]);
    const p4 = EventTailResponseSchema.parse(JSON.parse(s4Resume.body));
    if (p4.events.map((e) => e.seq).join(",") !== "4" || p4.page_end.next_cursor !== 4) {
      throw new Error(`Stage 4 resume failed: seqs=${p4.events.map((e) => e.seq)}`);
    }
    seenSeqs.push(...p4.events.map((e) => e.seq));

    // Verify exact monotonic 1,2,3,4 with zero duplicates and zero skips!
    if (seenSeqs.join(",") !== "1,2,3,4") {
      throw new Error(`Sequence integrity violated: ${seenSeqs.join(",")}`);
    }

    // 5. Invalid wait=26 refused 400 CURSOR_INVALID
    const s5 = await runCurl([`${origin}/p/${PROBLEM_ID}/events.json?since=0&wait=26`]);
    if (
      s5.status !== 400 ||
      ProblemDocumentSchema.parse(JSON.parse(s5.body)).code !== "CURSOR_INVALID"
    ) {
      throw new Error(`Stage 5 wait validation failed: status=${s5.status}`);
    }

    // 6. OPS.2a structured log audit: zero secrets, zero event bodies, zero workshop data!
    const allLogs = capturedOpsLogs.join("\n");
    for (const forbidden of [AUTH_CANARY, BODY_CANARY, WORKSHOP_CANARY]) {
      if (allLogs.includes(forbidden)) {
        throw new Error("OPS2A_LOG_LEAK: forbidden canary found in event-tail logs");
      }
    }
    if (
      !allLogs.includes('"wait":"immediate"') ||
      !allLogs.includes('"wait":"changed"') ||
      !allLogs.includes('"wait":"timeout"')
    ) {
      throw new Error("OPS2A_LOG_INCOMPLETE: expected immediate/changed/timeout wait outcomes");
    }

    console.info = origInfo;
    console.log(
      JSON.stringify({
        type: "ops2a.agent_long_poll_gate",
        status: "pass",
        code: "W73_AGENT_LONG_POLL_PASS",
        problem_id: PROBLEM_ID,
        sequences_verified: seenSeqs,
        stages: {
          immediate_ms: s1.durationMs,
          early_wake_ms: s2.durationMs,
          timeout_ms: s3.durationMs,
          disconnect_resume_ms: s4Resume.durationMs,
          invalid_wait_status: s5.status,
        },
        ops2a_log_lines: capturedOpsLogs.length,
        canaries_leaked: 0,
        local_only: true,
      }),
    );
  } finally {
    console.info = origInfo;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    sqlite.close();
  }
}

await main();
